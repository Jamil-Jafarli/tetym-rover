# ESP32 DAC Bench — Node.js

A web interface for driving the ESP32's two DACs. You type a **percentage**
for each channel, press **START**, and they stream to the board over wifi until
you press **STOP**.

The robot carries a **Raspberry Pi**, and the Pi is where this server runs:

```
powerbank → Raspberry Pi → ESP32 → ESC → motor
                 └── USB webcam
```

The Pi used to be optional and the camera used to be a phone. Both of those
are gone. The webcam plugs into the Pi, the Pi holds the 20 Hz stream to the
ESP32 over wifi, and the browser — on a laptop, on a phone, anywhere on the
network — only *watches*. That removes the whole HTTPS-and-camera-permission
problem the camera pages used to have, and it means the robot can see, read a
QR code and stop for an obstacle with no browser open at all.

```
GPIO25 (DAC1) → controller throttle signal wire     analog
GPIO26 (DAC2) → controller throttle signal wire     analog
GPIO23        → driver enable / brake release       digital: 0 at rest, 1 on START
GPIO19        → GPIO25 wheel's direction relay       digital: 1 forward, 0 back
GPIO5         → GPIO26 wheel's direction relay       digital: 1 forward, 0 back
GPIO14 / 32   → forward HC-SR04    TRIG / ECHO
GND           → controller GND        (required, common ground)
```

The Pi's side is two plugs: the webcam in a USB port, and power. It reaches the
ESP32 over the board's own wifi network exactly as a laptop used to.

**0 %** is idle — 1.00 V, which the controller reads as zero throttle.
**100 %** is whatever ceiling you started the server with (`--v-max`).
So `--v-max 1.8` means 100 % = 1.8 V, and every percentage in between is
linear. Raise the ceiling as you gain confidence; the UI never changes.

**GPIO23** is a plain digital output. It sits at **0** and goes to **1** the
moment you press START — and back to 0 on STOP, on a closed tab, on a link
timeout, and on boot. Wire it to whatever your driver needs held high to run.

```
browser ⇄ Node on the Pi (this) ⇄ wifi WebSocket ⇄ ESP32 ⇄ GPIO25 / GPIO26
             ├── USB webcam ──→ MJPEG to the browser, QR to itself
             └── forward HC-SR04 (via the ESP32) ──→ the 30 cm brake
```

**The interface is in Turkish** — every page, the shared wheel-trim strip, the
`/tune` findings, and the `reason` strings the server puts in the status frame.
Identifiers are not: keys (`w`, `wa`), gear names (`normal`, `fast`), pin names,
JSON fields and WebSocket commands stay English because they are protocol, and
so are this file, the code comments and the server's own console output.

## 1. Flash the board

`esp32/ws_dac/ws_dac.ino`, plus two libraries from the Arduino Library Manager:

- **WebSockets** by Markus Sattler
- **ArduinoJson** by Benoit Blanchon (v7)

### Wifi — the default is the board's own network

Out of the box there is nothing to configure. The board makes its own access
point and is immediately reachable:

| | |
|---|---|
| ssid | **ESP32-DAC** |
| password | **dac12345** |
| address | **ws://192.168.4.1:81/** |

Join that network from your laptop, then `node server.js --esp 192.168.4.1`.
This is the default because it always works — no router, no DHCP, no IP to
hunt for, same address every time, on a bench or at a competition.

To put it on your own wifi instead, fill these in at the top of the sketch:

```cpp
const char* WIFI_SSID = "Tetym";     // leave empty for access-point mode
const char* WIFI_PASS = "TETYM2024!";
```

It then joins that network and prints its address, and **falls back to the
access point above** if the network is unreachable — so you can never lock
yourself out.

Open the serial monitor at 115200 after upload:

```
ESP32 WebSocket DAC — GPIO25 / GPIO26, enable GPIO23, idle 1.00 V (dac 77)
no wifi configured — access point "ESP32-DAC" (pass dac12345) up at 192.168.4.1
mdns: esp32-dac.local
websocket: ws://192.168.4.1:81/
```

Joining your own network instead prints `wifi ok   ip: 192.168.1.42   rssi: -52 dBm`.

## 2. Run the interface

```bash
cd node
npm install
node server.js --esp 192.168.4.1         # board's own access point (default)
node server.js --esp 192.168.1.42        # or your network, or esp32-dac.local
```

One WebSocket, one port:

| | |
|---|---|
| **/** | hub — live status and links to everything |
| **/dashboard** | everything at once: speed, volts, ESP32 + Pi health, camera, obstacle, QR, map |
| **/setup** | what to measure, in order, and where the number goes |
| **/drive** | hold **W / A / S / D** to drive |
| **/vision** | camera; finds the road and shows the steering error |
| **/follow** | the same detector, driving the motors, recording the run |
| **/tune** | read a run back: charts, manoeuvres, and what to change |
| **/obstacle** | the forward HC-SR04: drive, stop, wait, carry on |
| **/pins** | every spare GPIO, 0-255 by hand, with a notes column |
| **/manual** | type the two percentages by hand |

Every setting that can be got wrong has an **ⓘ** beside it — what it is, how it
is measured, and when it is the right thing to reach for. Hover it, or tap it on
a phone. The text lives in one table in `public/wheels.js`, so the explanation
next to a slider cannot drift away from what the slider does.

Start at **/setup**. It is a numbered list of the six things that have to be
measured on a physical robot, each with the field to type the answer into and a
one-wheel test button to take the measurement with. What you put there is
stored on the server and shown on *every* page, so a threshold measured once is
not measured again.

Two of those pages deliberately do **not** apply the trim — `/manual` and
`/pins` send whatever percentage you type straight to the pin, because that is
where the threshold is measured, and measuring through the correction you are
trying to find gives you a number that is not the number. Each page says which
it is in the strip at the top: **XAM ÇIXIŞ** (raw) or **TƏKƏR AYARI** (applied).

No board yet? `npm run fake` runs a simulated ESP32 and the full UI.

| Flag | Default | What it does |
|---|---|---|
| `--esp <host>` | — | board over wifi: IP, hostname, or full `ws://` URL (port 81) |
| `--serial <path>` | — | board over USB instead (`COM5`, `/dev/ttyUSB0`) |
| `--fake` | off | simulated board, nothing is driven |
| `--http <n>` | `8090` | web port |
| `--host <addr>` | `0.0.0.0` | bind address — every interface by default |
| `--https` | off | serve over TLS. No longer needed for the camera — see below |
| `--cert <file>` | — | use your own certificate instead (implies `--https`) |
| `--key <file>` | — | ...and its private key |
| `--v-max <v>` | `3.3` | what 100 % means, in volts |
| `--camera <dev>` | `/dev/video0` | the webcam on this machine |
| `--cam-size <WxH>` | `640x480` | capture size |
| `--cam-fps <n>` | `15` | capture rate — the camera picks the nearest it supports |
| `--no-camera` | off | do not open a camera at all |
| `--no-qr` | off | camera on, QR reader off |
| `--list` | — | list serial ports and exit |

Start with `--v-max 1.8` on a real motor until you know where each one begins
turning.

### Getting at it from a phone

It already listens on **every interface** — `--host` defaults to `0.0.0.0` — and
on startup it prints the addresses you can actually type in:

```
reachable from this network at:
  http://192.168.1.24:8090/            (en0)
  http://10.5.0.2:8090/                (utun3)
```

No authentication, on purpose: this is a bench tool on your own wifi. Do not put
it on one you do not control.

**The camera works over plain http now, from anything.** It used not to: the
camera was the browser's, browsers only hand `getUserMedia` to `localhost` or
HTTPS, and so `/vision` opened fine on a phone and then sat there with a black
rectangle. There was a whole section here about self-signed certificates whose
only job was to get around that.

The camera is on the Pi. The Pi serves it as MJPEG at
`/camera/stream.mjpg`, which is an ordinary HTTP response that an `<img>` tag
can point at — no permission prompt, no certificate, no phone. `--https` is
still there if you want TLS for its own sake; nothing needs it.

## 3. The manual page — `/`

1. Enter a percentage for each channel — type it, or drag the slider.
   Under each field you see what that works out to in volts.
2. **START** — the values stream at 20 Hz and GPIO23 goes to 1. Editing while
   running takes effect on the next packet.
3. **STOP · IDLE** — both DACs back to 1.00 V, GPIO23 back to 0.

`ESP32 actual` is read back from the board itself, so it shows what the
firmware really put on the pins, not what you asked for — including the live
state of the enable pin.

Setting a channel to 0 % is **not** the same as STOP: 0 % is zero throttle with
the driver still enabled, STOP also drops GPIO23. Use STOP when you want the
robot inert.

## 4. The drive page — `/drive`

**ARM**, then hold **W** forward, **A** left, **D** right, **S** reverse.
Release everything and it coasts to 0 % while staying enabled, ready for the
next key. Touch works too, so a phone on the same wifi is a usable remote.

Every key maps to an explicit pair of percentages, and the table is editable
live — including mid-drive:

| Key | GPIO25 % | GPIO25 geri | GPIO26 % | GPIO26 geri | |
|---|---|---|---|---|---|
| `w` | 55 | — | 55 | — | forward |
| `a` | 35 | **✓** | 35 | — | pivot on the spot |
| `d` | 35 | — | 35 | **✓** | pivot the other way |
| `wa` | 60 | — | 30 | — | rolling turn, no relay |
| `wd` | 30 | — | 60 | — | rolling turn |
| `s` | 35 | **✓** | 35 | **✓** | straight back |

There are two things per wheel: a **percentage** (analog, the DAC) and a
**direction** (digital, a relay). Reversing one wheel while the other drives
forward pivots the robot on the spot; reversing both backs it up. That is why
`a` and `d` drive both wheels at the same percentage — the turn comes from
direction, not from a speed difference.

`wa` and `wd` deliberately leave both wheels forward and turn by speed instead.
**A direction change needs the robot to stop first**, so those are the ones to
use while actually moving.

Which physical wheel each DAC drives depends on your wiring, so the columns are
labelled by pin, not by side. If a pivot spins the wrong way, move the tick to
the other wheel; if a rolling turn leans the wrong way, swap that row's two
numbers.

Holding W and A together uses the **`wa` row**, not W and A mixed together —
so a gentle forward-left is a value you tune directly rather than a side effect
of two other numbers. Longest match wins.

Edits are saved server-side to `presets.json`, so they survive a reload and a
restart. **Reset defaults** puts the table back. Delete the file to start over.

### The two fixed speeds

Above the level is a two-button strip: **NORMAL** and **SÜRƏT**. They are not
percentages of anything — each one is a pair of **DAC codes**, the number the
pin is physically handed:

| | GPIO25 | GPIO26 | |
|---|---|---|---|
| **NORMAL** | 124 | 126 | 1.60 / 1.63 V — a crawl, just clear of the dead band |
| **SÜRƏT** | 241 | 241 | 3.12 / 3.12 V — near the top |

`dac = V / 3.3 × 255`, and 3.3 V is the chip's own reference, so a code means
the same voltage whatever `--v-max` is. The four numbers are editable under
the buttons, saved to `presets.json`, and each shows its volts.

**Exclusive**: there is one gear, so tapping the second releases the first, and
tapping the lit one releases it outright. The status carries `gear`, which is
either one name or `null` — it cannot say both.

The slow gear carries two different numbers and the fast one does not, and that
is the whole reason a gear is a pair rather than a single number: two motors
off the same reel differ by a few percent, a few percent matters near the dead
band, and it disappears at full throttle.

Three things a gear deliberately ignores, all for the same reason — a code
multiplied by something else is a different code:

- **the master level below it**, including at 0 %. The level card says so
  while a gear is engaged rather than leaving you to find out.
- **the wheel trim** (`stall`, `gain`). This is a raw page; the codes already
  carry whatever difference the two motors have.
- **the key table.** Pressing W / A / S / D releases the gear — a hand on the
  keyboard always wins, exactly as it does over `/follow`.

Arming is still separate: selecting a gear lights the button and moves nothing
until **ARM**. And because a gear has no keyup behind it, the page re-sends it
at 20 Hz — the same 400 ms dead-man as the keys, so a wedged tab coasts to 0 %
instead of leaving the robot at 3.12 V.

If a code is above what `--v-max` can deliver — `--v-max 1.8` cannot produce
241 — the page says which gear and what will actually go out. It does not
silently run slower than the number on its own button.

The `dac` figure in the readout is the board's own code for what it put on the
pins, so "241 means 241" is something you can see rather than infer.

### Master level

Above the readout is a **master level**: a percentage with a slider, a number
box, quick 25/50/75/100 chips and a progress bar. Everything on its way out is
multiplied by it, on both pages — except a gear, above.

```
what goes to the pin  =  preset %  ×  level %  ×  --v-max
```

(That is the drive page. `/follow` does not use the level at all — see below.)

So the table holds the *shape* of the robot's behaviour — how hard each turn
is relative to going straight — and the level is the one knob you turn to walk
the whole thing up from a crawl. Set the table once at 100 %, then drive at
25 % until you trust it. At 0 % nothing moves, but the driver stays enabled.

The level is saved to `presets.json` too, and the volts shown next to every
field already have it applied.

The dead-man here is the key report itself: the page sends the held-key set at
20 Hz, and if it goes quiet for 400 ms the server coasts to 0 % without waiting
for a keyup. That covers a wedged tab, a lost focus, an alt-tab mid-corner —
anything that could swallow the `keyup` event. Losing focus also releases every
key explicitly.

## 5. The vision page — `/vision`

Point the robot at the track and it finds the road live, in the browser — no
model, no training, no GPU. It **sends nothing to the motors**; this page is
for looking and tuning. `/follow` is the same detector with the wheels
attached, so everything below applies there too.

### Where the picture comes from

The **robot's own webcam**, plugged into the Pi, streamed as MJPEG and drawn
into a canvas. That is the default and on a real robot it is the only one you
want: it is the camera bolted to the front, at the height and angle everything
below was tuned for, and it is the same picture the QR reader is looking at.

Two other sources are kept, as buttons on the page:

| | |
|---|---|
| **RPi veb-kamera** | the robot's camera, over the server. The default |
| **Bu brauzer** | this laptop's own webcam — quick to wave a track at, at a desk. Still needs localhost or HTTPS, because that one really is `getUserMedia` |
| **file** | an image or a recording of the track. Works everywhere, and is how you tune against a lap you already drove |

All three are the same to the detector — `drawImage` does not care — so what is
being tuned does not change with the source.

### Track type — decided automatically

| Button | The track | What it looks for |
|---|---|---|
| **Avto** (default) | works it out per frame | see below |
| **Qara yol** | black road, white edge lines | the **dark corridor between two white lines** |
| **Ağ yol** | white road on a dark floor | the widest white run |

The dark-road reading does not hunt for dark pixels — dark is everywhere,
including every shadow. It finds the white edge lines first, and the road is
the gap between them. A gap with white on **both** sides beats a gap with
white on only one, so the two lines have to agree before a corridor is
accepted at all.

**Avto** picks between the two, every frame — while you are pointing the camera
around. During a run it is frozen on whatever it had settled on; that is
`/follow`'s doing and is described there. The camera sits low and points at
the ground just ahead, which means the bottom-centre of the frame *is* the
road — so the road's colour can be measured rather than guessed. Three
independent signals each score in `[-1, +1]`:

| Signal | Reads |
|---|---|
| **altdakı sahə** | is the patch under the robot (blue box) bright or dark? |
| **mərkəz − yan** | is the centre brighter than what borders it, or darker? That is literally the difference between the two track types. |
| **hansı rejim yol tapır** | both readings are run in full and compared — the one that produces a longer chain of properly-bounded corridors wins |

They are summed, and the mode changes only past **±1.20**. The cut sits above
1.0 deliberately: no single signal, however certain, can carry the decision
alone — two have to lean the same way.

The case this is built for: the robot parked **on top of a white edge line**.
The patch underneath it is then white, so the first signal shouts "white road"
at full strength and the second half-agrees — but the third still finds a
proper black corridor and votes against, the total lands at 0.43, and the mode
does not move. Changing its mind afterwards also costs ~10 consecutive frames
of agreement, so a hand or a shoe passing through cannot flip it.

The live scores are printed under the buttons, and the boxes the first two
signals read from are drawn on the video — blue for the probe, orange for the
flanks. A wrong decision is therefore visibly a wrong decision, and the manual
buttons override it instantly.

### Why it stops seeing the furniture

Earlier the page picked out white furniture and a patch of light on the floor,
because each band searched for its own bright run independently and nothing
said those runs had to be the same object. Now they do:

- **The road is one connected thing that starts under the robot.** Band 0 (the
  bottom of the frame, right in front of the wheels) locks on first; every band
  above it only accepts a run that continues the one below — within a lateral
  jump limit, and no more than ~1.6× wider. A white sofa on the right never
  touches the bottom band and never lines up with the run below it, so it is
  dropped by geometry, not by hoping a brightness threshold excludes it. When
  no band continues the chain, the chain simply ends there.
- **A trapezoid side gate.** The camera looks forward, so the further up the
  frame you go, the narrower the strip of floor the robot can actually reach.
  `Yan kəsim` cuts the outer edges progressively with height.
- **A short temporal lock.** The road cannot teleport between frames, so the
  next frame prefers a corridor near the last accepted one, and forgets it
  after ~15 frames without a fix.

Three older details still do heavy lifting:

- **The histogram only sees colourless pixels.** A bright yellow board in frame
  otherwise drags Otsu's split down to floor level and the whole image reads as
  road. Gating the histogram by saturation makes coloured objects invisible to
  the threshold, not just to the mask.
- **Otsu returns the middle of its winning plateau.** On an evenly lit track
  there is a real gap between floor and road brightness, and every threshold
  inside that gap scores identically — taking the first winner parks it on the
  gap's lower edge, one shadow away from the floor reading as road.
- **A run wider than 88 % of the frame is rejected.** A real road never fills
  the whole view, so if it does, the threshold has failed. Better to report
  nothing than a confident lie.

### Sliders

| | Default | |
|---|---|---|
| ROI | 45 % | how much of the top of the frame to throw away |
| Eşik düzəlişi | 0 | nudge the automatic threshold up or down |
| Rəng toleransı | 60 | how colourless a pixel must be to count as white |
| Minimum en | 6 % | narrower than this is a glint, not a road |
| Zolaq sayı | 8 | horizontal bands |
| **Yan kəsim** | 18 % | the trapezoid gate — raise it if roadside clutter still gets in |
| **Davamlılıq** | 14 % | max lateral jump between bands — lower it on a straight track, raise it on tight curves |

**Maska** shows the raw mask, which is the fastest way to see whether the
threshold or the geometry is what is failing. Green is always "what the
detector currently thinks the road is", in either mode.

On the real track: run it once with **Maska** on and check the two edge lines
come out solid white and the road solid black. If they do, everything above
works; if they don't, fix `Eşik düzəlişi` and `Rəng toleransı` first and leave
the rest alone.

This page opens with a live picture from any device on the network, over plain
`http://`, with nothing granted — because the camera is the Pi's and arrives as
an ordinary image stream. Only the **Bu brauzer** button still needs
`localhost` or HTTPS, and it says so when it cannot have them.

## 6. The follow page — `/follow`

The same detector as `/vision`, wired to the wheels. Point the camera at the
track, press **SÜRMƏYƏ BAŞLA**, and it drives; **DAYAN**, the space bar, or
anything that takes focus off the page stops it.

Both pages load `public/road.js`, so there is one detector rather than two:
tuning on `/vision` is tuning what `/follow` drives with. The control law is
`public/pilot.js`, a pure function with no DOM and no clock of its own — which
is why it can be tested without a browser and replayed against a recorded run.

### The track type is decided once

A track does not change type halfway round. So `auto` re-decides freely while
you are pointing the camera about, and the moment you press **SÜRMƏYƏ BAŞLA**
whatever it had settled on is **frozen for the rest of the run**.

That is not a convenience. Half a lap in, the only things left that can still
argue for the other reading are a shadow, a bright doorway or somebody's shoe —
and switching costs the temporal lock, the band chain and usually the lap. The
three signals keep being measured and keep appearing in the log; they simply
stop being acted on. **DAYAN** releases the lock again.

Locking before anything has been decided would just freeze the default, so if
`auto` had not committed yet, the first frame after arming still gets its one
instant decision.

### The dead band — the thing the logs were really about

This motor does not turn below **1.5 V**. On a 3.3 V ceiling that is **22 %**,
and every percentage below it is not "slow", it is "stopped".

The first thirty-two runs were flown at `base` 25, which is 1.575 V — three
points above the threshold. The inner wheel gets `25 × (1 − steer)`, so it fell
under 22 % the moment the steer passed 0.13, which is an error of about 0.15.
In the one 59-second run, **91 % of all wheel commands** (990 of 1082) were in
that band: asked to move, not moving. The robot was not badly tuned so much as
electrically switched off for most of every corner — which is also why that run
lost the road thirteen times and why `worst_err` sits at 0.9 across the set.

So the pilot's numbers are now **demands**, mapped onto the range that does
something:

```
pin % = 0                                   when demand = 0
      = stall + demand × (100 − stall)/100  otherwise
```

Zero stays zero on purpose — stopping the inner wheel outright is what makes the
tightest turn — and the step at zero is real, not an artefact: a motor that will
not move below 1.5 V has exactly that discontinuity.

**One threshold is not enough.** Two motors off the same reel differ by a few
percent, and a few percent near the threshold is the difference between turning
and not turning. So there is a per-pin override — `stall25`, `stall26` — and a
per-pin `gain` after it, and they live in `public/wheels.js` rather than inside
the follow page, because the trim is a property of the robot rather than of a
page. Every page reads the same four numbers from the server and prints them in
a strip at the top; `/setup` is where you change them.

The order matters and `/setup` enforces it: thresholds first, gain last. A gain
measured against a wrong threshold is not a measurement, it is a number that
happens to work at one speed.

The consequence to keep in mind: **a demand of 20 is no longer 20 % on the
pin.** It is 38 %, or 1.86 V. Every slider prints its own voltage next to it, so
what the wire gets is never a matter of inference. Measure your own threshold on
`/manual` — creep the percentage up until the wheel first turns — and put it in
the **Dönmə həddi** slider.

### Steering

By speed difference only. Both wheels always go forward and the inner one is
slowed; **the direction relays are never touched**, so there is no one-second
interlock pause in the middle of a corner. At full steer the inner wheel
reaches zero, which is the tightest turn available without reversing anything.

The error is `-1` (road hard left) to `+1` (road hard right), measured twice
per frame: `near` from the band right in front of the wheels, `far` from the
mean of the upper half of the chain. Steering uses `near`; the speed limit uses
both.

```
steer = kP × ( near + kD × d(near)/dt )
```

`kD` is a **look-ahead time in seconds**, not a bare gain — "where the error
will be `kD` seconds from now" is a number you can reason about while tuning.
Wobbling on a straight means `kP` is too high; taking the corner late means
`kD` is too low.

### The speed limit

```
speed = base × (1 − curve × bend) × (1 − short × missing bands)
        clamped to [min, max], then ramped
```

- **bend** is the larger of `|near|` and `|far|`. Because `far` is in there,
  the robot slows down **before** the corner rather than in it.
- **missing bands** is how much of the chain died early. Not seeing far ahead
  is itself a reason to go slower.
- **the ramp** limits acceleration to `accel` % per second going up and 400 %
  per second coming down. A step on the throttle is what makes a robot lurch
  off the line; braking early is never the thing that goes wrong.

**There is no master level on this page.** The percentage the slider shows is
the percentage that reaches the pin: `100 %` is `--v-max` — 3.3 V by default —
and `0 %` is idle at 1.00 V. One limit per path: `max` here, the master level
on `/drive`. Multiplying a speed the pilot already worked out by a second
number means the figure you tuned and the volts on the wire are two different
things, and it is the volts the controller reads.

Every percentage on the page is printed next to what it is worth in volts, so
"max speed" is never an abstraction. Walk it up with **Düz yolda sürət**: start
at 15 and raise it. (Read the dead band section below first — these are demands
on the usable range, not pin percentages.)

### When the road gets far away

Past `hard` (0.6 by default — the road nearly at the edge of the frame) driving
forward stops helping. The logs are full of exactly this: the error climbing to
0.9 while the robot kept driving through the corner, and then losing the road
altogether.

So past that threshold it stops trying to drive through and instead **turns
toward the road on the spot**: inner wheel to zero, outer wheel at `crawl`
(10 % ≈ 1.7 V), which is the tightest, slowest thing a speed-difference robot
can do without reversing a wheel. It goes back to normal driving once the error
falls to `hard − 0.15`, so a robot sitting on the threshold does not flicker.

### When it loses the road

A sharp corner drops the chain for a few frames, so losing sight of the road is
not by itself a fault:

1. **0 – 600 ms** — keep the last steer, cut to ~55 % of the current speed.
   This is what carries it through a corner it briefly cannot see.
2. **600 ms – 2.1 s** — speed to zero, still enabled, still looking. If the
   road comes back it simply carries on.
3. **after 2.1 s** — give up: **ENABLE** drops and the page disarms.

Behind all of that is the server's dead-man, which owes nothing to the page
being correct: **no frame for 400 ms and the throttle is zero**, whatever the
browser last said. A frozen camera, a throttled background tab and a closed
laptop lid are the same event as far as the robot is concerned.

### The run log

**SÜRMƏYƏ BAŞLA is also the record button.** Every run gets its own
`node/logs/follow-<timestamp>.json`, with no second thing to remember to press:
the lap worth having is the one that went wrong, and that is never the lap you
thought to record. It stops when the run stops — including when the browser
simply disappears, because a closed laptop is the end of a run too.

Server-side rather than downloaded from the browser, for the same reason.

```jsonc
{
  "started": "…", "note": "3rd lap, new kP",
  "pilot":  { "base": 34, "kP": 0.85, … },   // what it was flown with
  "vision": { "roi": 0.45, "bands": 8, … },
  "calib":  { "pct": 50, "metres": 3, "seconds": 4 },
  "summary": {
    "duration_s": 41.2, "distance_m": 11.4, "avg_speed_pct": 27.6,
    "worst_err": 0.62, "lost_events": 3, "lost_time_s": 1.9
  },
  "rows": [ { "t": 0, "err": 0.02, "far": 0.10, "bands": 8, "mode": "dark",
              "speed": 30, "steer": 0.02, "p25": 30, "p26": 29.4,
              "v25": 1.6, "lost": false, "dist": 0.0 }, … ]   // 10 Hz
}
```

The rows carry the **inputs** to every decision as well as its outputs, so a
run can be replayed through `pilot.js` offline with different numbers to see
what would have changed — retuning against a real lap instead of a memory of
one.

Alongside the rows, the file records what the lap was **made of** — a list of
straights, left-handers, right-handers and dropouts, each with its duration,
mean speed, sharpest steer and distance. "Eight straights, six right-handers,
two of them where it lost the road" is the sentence you actually want after a
lap, and no amount of squinting at 10 Hz rows gives it to you.

### Distance, honestly

There is no encoder: the ESP32 reports the voltage it put on the pin and
nothing about what the wheel did with it. So distance is **modelled**, from one
constant you measure by hand — drive at a known percentage, over a known
distance, and time it. Fill the three boxes at the bottom of the page.

That is a straight line through one real point, not a claim about the motor.
Good enough to say "this lap was 11 m and that one 11.4 m"; not good enough to
navigate by. It is reported next to the raw duration and the average percentage
rather than instead of them, so it can always be sanity-checked.

The sliders and the calibration are saved server-side to `follow.json`, like
`presets.json` — numbers you found by driving the robot should not depend on
which browser you drove it from.

## 7. Reading a run back — `/tune`

Drop a run's JSON onto the page — or just pick it from the list, since the
server already has them — and it says what to change.

### What it does not do

It does not replay the run through `pilot.js` with different numbers. That looks
like evidence and is not: a bigger `kP` would have changed where the robot went,
so every error after the first correction would have been a different error.
Open-loop replay of a closed loop is a lie with a chart attached.

### What it does instead

Measures things that have **one** honest interpretation each, and maps each to
**one** number:

| Measurement | Reading | Change |
|---|---|---|
| centre-line crossings per second, on straights only | the controller is fighting itself | `kP` down |
| large mean error with *no* crossings | it is not correcting hard enough | `kP` up |
| fraction of frames with the steer pinned at ±1 | the corner is tighter than the speed allows | `curve` up |
| how often the road was lost, and for how long | going into bends too fast | `base` down |
| mean error at bend *entry*, when `far` had already warned | reacting late | `kD` up |
| worst error small, nothing lost, steer never pinned | there is speed on the table | `base` up |
| wheel commands between 0 and `stall` | the inner wheel was stopped, not slowed | dead band, not tuning |
| *both* wheels under `stall` | it was never driving at all | `base` up |
| time spent turning on the spot | still entering bends too fast | `base` down |

Each finding names its measurement, its interpretation and its one number, so
the next lap can prove it wrong. The suggestions can be written straight to
`follow.json` with one button — but change one or two at a time, or the next run
tells you nothing about which change did what.

Also on the page: the error and speed traces with the dropouts shaded, and the
manoeuvre table from the log.

### The one thing it can calibrate outright

Distance. Type in the **real** length of the lap — the one you measured with a
tape — and the constant falls straight out of the recorded speed profile:
integrating the percentage that reached the pins gives percent-seconds, and the
real length divided by that is metres per percent-second, which is exactly what
`{pct, metres, seconds}` encodes. The dead band goes in as `dead`, so the model
does not credit distance to voltages that never turned a wheel. One button
writes it to `follow.json`.

Note it integrates what reached the **pin**, not the demand behind it — those
are different numbers now, and it is the pin the wheel responds to.

That is a genuine measurement, not an estimate of an estimate — which is why it
is the only thing here that calls itself a calibration.

## 8. The two ultrasonic sensors

Two HC-SR04s, doing unrelated jobs. Both are declared at the top of
`esp32/ws_dac/ws_dac.ino` and both report their own pins in the status, so the
pages follow whatever you wire rather than assuming.

**Wire the echo lines through a divider.** An HC-SR04 runs at 5 V and its ECHO
pin swings to 5 V, which will damage a 3.3 V GPIO. 1 kΩ in series and 2 kΩ to
ground gives 3.3 V. TRIG is an input on the sensor and is happy at 3.3 V.

### How the board reads them

By interrupt, not `pulseIn()`. `pulseIn` blocks for up to 25 ms waiting for a
wall that may not be there, and the same loop is also running a 20 Hz control
stream and a websocket — a sensor must not be able to stall the thing that
drives the motors. Each echo pin is timed on CHANGE and the loop just collects
what arrived.

One ping per sensor every 50 ms, alternating. Faster and the previous burst is
still rattling around the room when the next goes out, which reads as a phantom
object at whatever distance the old echo came from.

**Silence is a real answer, and the one that matters.** An object too soft, too
angled or too far away returns no echo at all — which is the same reading as an
empty room and the opposite of what it means. So a sensor that said nothing
since its last ping is cleared to `null` rather than left showing its previous
distance, and every consumer of that number treats `null` as "no information",
never as "clear".

### The 30 cm stop — where it actually lives

**Closer than 30 cm in front and the robot stops.** Not "the obstacle page
stops"; the robot stops.

That distinction is the whole design. This used to be a behaviour of one page:
`/obstacle` ran the state machine in the browser and sent zeros when it saw
something. That protects exactly one page, and there are five ways to drive this
robot — the keys on `/drive`, a gear, a typed percentage on `/manual`, the pilot
on `/follow`, and the obstacle page itself. A wall in front of the robot is a
fact about the robot, not about which tab is open.

So the state machine runs in `bench.js`, at 20 Hz, in `resolve()` — the one
function every drive path already funnels through. `/obstacle` now *displays*
the server's verdict rather than computing its own, and it deliberately keeps
asking to creep forward while blocked: if the brake only worked because the page
was polite, it would not be a brake.

Three things the brake deliberately does **not** do:

- **It does not drop ENABLE.** It is a brake, not a shutdown. Dropping the relay
  every time somebody walks past would cost a relay cycle each time.
- **It does not hold you against a wall.** Only *forward* motion is stopped.
  Reversing away and pivoting on the spot are exactly what you want to be able
  to do with a wall in front of you, and neither drives into it.
- **It does not switch itself off quietly.** There is an escape hatch for bench
  work — the two buttons on `/follow`, which write `obstacle.guard` — and while
  it is off every page says so, because a safety control that reads "on" while
  it is off is worse than not having one.

| | |
|---|---|
| **30 cm** | closer than this and the robot stops |
| **40 cm** | and it may not move again until this far — hysteresis |
| **3 readings** | in a row, before believing either |

30 cm is not an arbitrary round number: at the speed this robot drives, 30 cm
ahead of the sensor is roughly where the *robot* is by the time three readings
have agreed and the next 20 Hz packet has gone out. Below about 20 cm the
sensor's beam starts seeing the robot's own bumper; much beyond 40 cm it stops
for doorways.

### `/obstacle` — stop, wait, carry on

The forward sensor, on its own page, driving straight ahead and nothing else:
no camera, no steering. One behaviour, so a failure is never ambiguous.

Four phases:

1. **go** — nothing in the way.
2. **stop** — something is. Full stop, not a slow-down: choosing how hard to hit
   a wall is not a decision worth making.
3. **wait** — it has gone, but hold still a moment longer.
4. **go** — and resume.

The wait is the point. A person stepping across is clear for an instant while
their trailing leg is still in the path, and a robot that launches the moment
the beam opens will hit it. If anything comes back inside the window the whole
stop restarts, not just the timer.

Two more details that stop it twitching:

- **`stopCm` and `clearCm` are different numbers** (30 and 40 by default).
  Everything between them changes nothing, so a robot parked at 35 cm cannot
  buzz between stopped and going.
- **Three readings in a row**, not one. A single 12 cm in the middle of a
  corridor is noise; three is a wall.

The thresholds are saved to `follow.json` and the **server** obeys them, so
tuning them here changes every page at once. While the robot is stopped for an
obstacle `/follow` holds off its lost-the-road timer, or it would give up and
drop ENABLE while waiting for someone to walk past.

## 8b. The lift — one actuator on an L298N

A DC linear actuator that raises and lowers the load, on half an L298N. Two
buttons, **KALDIR** and **İNDİR**, on `/drive` and on `/dashboard`.

| wire | pin | |
|---|---|---|
| IN1 | GPIO16 | 1/0 extends, 0/1 retracts, 0/0 coasts |
| IN2 | GPIO17 | |
| ENA | GPIO4 | PWM speed — **take the ENA jumper off** or it is stuck at full |

The L298N's logic is 5 V and its inputs read 3.3 V happily, so the three wires
go straight to the ESP32. **All three grounds must be common** — driver, ESP32
and motor supply — or the inputs float and the bridge does as it pleases. Those
three pins are no longer offered by `/pins`: a page that could put a raw value
on ENA while the lift was running would be a second driver for the same motor.

The actuator is not a third throttle channel because it is not the same kind of
thing. The wheel controllers are analog and take a voltage from a DAC; this is
an H-bridge and wants two digital direction lines and a PWM.

### Held, not latched

There is no "up" that stays up. While a button is down the page repeats the
command at 20 Hz, and when it stops — released, pointer dragged off the button,
window blurred, tab hidden, laptop closed — **three** things stop the motor:

1. the page sends one explicit stop as the button comes up
2. the server drops `lift` to 0 after 400 ms with no repeat
3. the board's own 300 ms watchdog idles everything, the lift included

Any one is enough; all three exist because a wheel left running coasts, while
an actuator left running drives into its own end stop and stays there pushing.
`STOP` and `IDLE` release it too — a stop button that leaves an actuator
extending is not a stop button.

### Two interlocks in the firmware

- **Never reverse under load.** A direction change passes through zero and
  waits 250 ms before going the other way. Reversing a bridge while the motor
  is still turning throws the winding's stored energy back through it. Same
  rule, and the same reason, as the wheel relays.
- **Never run past the end.** A single continuous run is capped at 8 s. An
  actuator against its end stop is a stalled motor drawing locked-rotor
  current, and a cheap one has no limit switch to save it. When the cap fires
  the bridge is cut and the status says `cut: true`; it re-arms when the button
  is released. The pages show that rather than hiding it — it means the
  actuator has been pushing at something for eight seconds, which is either the
  end of its travel or a jam.

Speed is `lift.pct` in `follow.json`, default **75 %**. Not 100: an actuator
that slams into its stop at full duty is the noise you hear shortly before the
gearbox gives up.

The USB firmware (`throttle_dac_2ch.ino`) has no L298N support — `lift` is
accepted and ignored on that path. Use the wifi board.

## 9. The spare pins — `/pins`

Every GPIO the robot does not already use, with a slider from 0 to 255, a place
to write what you wired to it, and a CSV button so the notes leave with you.

**Only GPIO25 and GPIO26 are analog.** They are the chip's two real DACs and
they are already the drive path, so they are not on this page — `/manual` is
where you set those. Everything on `/pins` is **PWM**: a 5 kHz square wave whose
duty cycle is the number you typed. A multimeter reads the average and it looks
like a voltage; an oscilloscope shows what it really is; a motor controller
expecting a clean analog input is not fooled. The page says so at the top rather
than letting the slider imply otherwise.

Offered: `4, 5, 16, 17, 21, 22` and — with a warning — `2, 15`, which are
strapping pins that only care what they see *at boot*.

Refused, by the firmware rather than by the page: `0` and `12` (strapping, and
12 can select the wrong flash voltage), `1` and `3` (the serial console), `6-11`
(the flash chip — writing to these bricks the board until it is reflashed), and
`34-39` (input only, no output driver at all). Asking for one of those is
counted as a bad packet, not quietly ignored.

The list comes from the board, not from the page, so changing `TEST_PINS` in the
sketch changes the page with nothing to keep in step.

Values are **not** watchdogged — a bench number you set by hand should still be
there when you come back with a multimeter. They are cleared on STOP, on idle,
and when the last browser disconnects.

If you put an I²C device on `21`/`22` (see `docs/`), take them out of
`TEST_PINS`: the page would otherwise let you drive the bus.

## 10. The dashboard — `/dashboard`

Everything at once, on one screen, read-only apart from two buttons. It is what
you leave open on a laptop while somebody else drives.

| Panel | What it is |
|---|---|
| the strip along the top | speed, both wheel percentages with their volts and DAC codes, distance to the obstacle, distance travelled, direction and ENABLE |
| **camera** | the Pi's webcam, live |
| **maneə** | the forward HC-SR04 as a gauge, with the two thresholds drawn on it and the phase the server is in. The card turns red when the sensor is actually holding the throttle down — not merely when something is in view |
| **yarışma alanı** | the field map, below: the schematic, the plan, and the robot on it |
| **kaldırma** | the lift's two buttons, what the bridge is doing, and which pins it is on — see §8b |
| **konum ve sıradaki dönüş** | which leg it is on, which junction is next and what it does there — left, right, straight, turn round, or stop |
| **QR** | the last code read, how long ago, and the ones before it |
| **ESP32** | link, signal, uptime, packets, bad packets, pin volts, DAC codes, relays |
| **Raspberry Pi** | CPU (total and per core), temperature, memory, load average, clock, this server's own CPU and RSS, disk, uptime, and the firmware's throttle flags |

Speed is shown in **m/s** once the distance calibration exists and as a
percentage until then, rather than quietly showing one and labelling it the
other.

The Pi panel earns its place on a robot running off a powerbank. The number to
watch is not CPU, it is **`gərginlik aşağıdır`** — the firmware's undervoltage
flag. A powerbank that cannot hold 5 V under the motors throttles the Pi, and
the symptom is "the camera went choppy", which nobody attributes to the battery.

### The map — the competition field

The map is the arena, drawn the way the rule book draws it (`Şəkil 1`): the
three pick-up points **A1–A3** along the top, the three drop points **B1–B3**
down the right, the junctions **D1–D6** and the start area joined by the
corridors between them, the factory-automation gate across the middle, and the
nine QR codes **q1–q9** standing on the legs they belong to.

The field lives in `public/field.js` as a graph — the coordinates, the edges and
which code stands where — and everything reads that one table: the localiser,
the planner and the drawing. Measure the real arena and it is the only thing to
edit. `GET /api/field` serves the same graph to anything that is not a browser.

**Where the robot is.** Pick a target, and the robot's position comes from the
codes, not from the wheels:

- reading `q5` does not mean "a code was read 12 m into the run", it means the
  robot is **on the D3 → gate leg, 3.9 m east of D1**. That is a measurement,
  and it replaces the accumulated error outright.
- a code names an *edge*, not a direction, so which way along it is worked out
  from the plan, or from continuity with the last code — the robot drove
  through the junction it was heading for and came out the other side. When
  neither applies the position is still right and the heading is a guess, and
  the panel says `yön tahminidir` rather than pretending.
- between codes it is dead reckoning again, rotated onto the field at the last
  code. `pose.dead` is how far it has come since — past a couple of metres,
  believe the next QR rather than the map.
- with no code read yet, **the robot is not drawn at all**. An unlocalised robot
  is somewhere, and drawing it on the start line because nothing better is
  available is exactly the failure this is meant to prevent.

Only codes that carry a **q** are waypoints: `q5`, `Q5`, `qr5`, `qr/5` at the
end of a URL, or a string that is nothing but a number. A field has other codes
on it, and reading `kargo-9` as `q9` would put the robot at the far end of the
arena with total confidence — a wrong fix is much worse than no fix, so those
are counted as strays and the position is left alone.

**Where it turns.** `field_mission` takes the stops in order — `["A2", "B3"]` —
and breadth-first search fills in the junctions between them, through the gate,
including the way back off the branch. At each node the instruction is the
difference between the bearing coming in and the bearing going out, with a 25°
dead band so a tape-measured field does not produce `sağa 4°`. The panel shows
the one for the junction ahead; the map rings that junction so "turn left at D2"
has a D2 you can see.

The plan doubling back matters: `START → A2 → B3` drives D2 → A2 and then
A2 → D2, and both legs carry `q3`. Only the direction of travel tells them
apart, and reading it wrong sends the robot back up the branch it just came
down — so the same code seen again from the same spot keeps its direction, and
the same code seen again after a couple of metres of driving means the robot
went round the node.

The blue trail on top is still dead reckoning, in `public/route.js`: the two
wheel percentages that reached the pins, through the same speed model `/tune`
calibrates, into a differential-drive integration. **It is a model, not a
measurement.** There is no encoder and no IMU on this robot. A wheel slipping in
a corner writes distance that never happened, and because the heading is an
integral, a 2 % error in one wheel is not a 2 % error in position: it is a bend
that never straightens out. That is the whole reason the codes are the position
and the trail is only what happened between two of them.

Two numbers decide that trail, and both are measured rather than guessed:

- **the distance calibration** (`/setup`, or `/tune` from a real lap). Without
  it no trail is drawn and nothing moves between codes — a path drawn from an
  unknown speed is a drawing, not a map, so the robot simply stays on the last
  QR until the next one is read, and the page says so.
- **`track`**, the distance between the two driven wheels, centre of tyre to
  centre of tyre. It converts a speed *difference* into a rate of turn, so
  getting it wrong does not shift the map, it bends it: a lap that should close
  comes out as a spiral. It lives in `follow.json` under `route.track`.

The path is fetched once over HTTP (`GET /api/route`) and appended to from the
status stream, because sending 1 500 points ten times a second to say the last
one moved 5 cm is how a dashboard becomes the reason the robot stutters.

### Reading QR codes

Server-side, from the same camera, with `jsqr`. The obvious place to decode a QR
is the page already drawing the video — but then the robot only reads a code
while somebody happens to be looking at it, and "the last sign we drove past" is
a fact about the trip, not about a browser tab.

ffmpeg produces a second, small, grey, slow stream on its own pipe for this, so
the QR reader gets exactly the pixels it wants without anything decoding JPEGs
in Node and without the video path being touched. One ffmpeg, one device open,
two outputs.

The part that is easy to get wrong is not decoding, it is **counting**. A sign
held in front of the robot is in view for several seconds, which is thirty
decodes of one string, and reporting "30 codes read" when a person showed you
one is simply wrong. So a reading is new only when the text changes, or when the
same text comes back after the code has been out of sight for four seconds —
which is you driving past the same sign twice.

### What it costs the Pi

Measured on a Pi 4, 640x480, one viewer:

| | |
|---|---|
| ffmpeg | ~16 % of one core — it is copying the camera's own JPEGs, not encoding |
| this server, QR off | ~19 % of one core |
| this server, QR on at 3 fps | ~32 % of one core |

So about a third of one core out of four, most of it the QR decode. `--no-qr`
buys the difference back, and `--no-camera` buys all of it. Nothing here shares
a deadline with the 20 Hz control stream closely enough to threaten it: the
board's watchdog is 300 ms and the longest single block above is a ~40 ms QR
decode, three times a second.

## Why go through Node instead of the browser talking to the ESP32 directly?

The board's 300 ms watchdog needs a steady 20 Hz stream, and a browser tab that
is backgrounded, throttled by the OS, or mid-reload will not deliver one — the
output would stutter to idle and back. Node holds that stream, clamps every
value before it goes out, and drops to idle the moment the browser disappears.

You *can* point a browser straight at `ws://<esp-ip>:81/` — the protocol below
is the board's own. Just keep something sending at ~20 Hz.

## Protocols

**Browser ⇄ this server** — `ws://<host>:8090/`, same origin as the page:

```jsonc
{"cmd": "set",   "p25": 60, "p26": 25}   // percent, 0-100
{"cmd": "start", "p25": 60, "p26": 25}   // values optional; raises GPIO23
{"cmd": "stop"}                           // idle + GPIO23 low, keeps the values
{"cmd": "idle"}                           // idle + GPIO23 low, clears them

// drive page
{"cmd": "keys",    "keys": ["w", "a"]}          // held keys; send at ~20 Hz
{"cmd": "presets", "presets": {"a": {"p": [35,35], "r": [true,false]}}}  // partial
{"cmd": "level",   "level": 40}                 // master limit, 0-100 %
{"cmd": "gear",    "gear": "fast"}              // "normal" | "fast" | null; ~20 Hz
{"cmd": "gears",   "gears": {"normal": [124,126]}}   // the codes; partial

// follow page
{"cmd": "follow",     "p25": 30, "p26": 24, "reason": "döngə"}  // ~20 Hz
{"cmd": "follow_cfg", "cfg": {"pilot": {…}, "vision": {…}, "calib": {…}}}
{"cmd": "log_start",  "meta": {"note": "…", "pilot": {…}}}
{"cmd": "log",        "rows": [ … ]}            // batched at ~2 Hz
{"cmd": "log_stop"}

// the lift — /drive and /dashboard
// Held, not latched: repeat at ~20 Hz while the button is down. Stop sending
// and the actuator stops, by three separate watchdogs. See "The lift", below.
{"cmd": "lift",       "dir": 1}                 // +1 up, -1 down, 0 stop
                                                // "up" / "down" work too

// dashboard
{"cmd": "route_reset"}                          // the map starts again from here
{"cmd": "field_mission", "targets": ["A2", "B3"]}  // the stops to call at, in order
{"cmd": "field_qr",      "text": "q5"}          // a code read by hand — rehearsal only
```

Five things are readable over plain HTTP, all read-only:

| | |
|---|---|
| `GET /logs`, `GET /logs/<name>` | the runs, which is how `/tune` offers the lap you just drove instead of a file dialog. The name is matched against `follow-<word>.json` rather than joined into a path — this server has no authentication and sits on a shared wifi |
| `GET /camera/stream.mjpg` | the webcam, as `multipart/x-mixed-replace`. Point an `<img>` at it. A viewer that is not keeping up has frames **dropped** rather than queued: a live view a minute behind is worse than one that skipped a second |
| `GET /camera/frame.jpg` | the latest single frame, for anything that does not want a stream |
| `GET /api/route` | the whole path and its marks, once — see the map, above |
| `GET /api/field` | the competition field: nodes, edges and where each QR stands. Static for a whole competition, so it is fetched once rather than repeated ten times a second |
| `GET /api/wheels` | the wheel trim, for the two pages with no socket |

`follow` and `gear` are held to the same dead-man as `keys`: 400 ms of silence
and the throttle is zero, `reason` becomes `kadr gəlmir`, and ENABLE stays up so a
dropped frame does not cost a relay cycle. Sending `keys` or `set` takes the
robot off the pilot immediately — a hand on the keyboard always wins.

Status comes back at 10 Hz, plus one immediately after each command carrying
`"ack": "<cmd>"` so you can tell it apart from the background push:

```jsonc
{
  "type": "status", "ack": "start",
  "running": true, "reason": "running", "enable": true,
  "transport": "ws://192.168.1.42:81/",
  "level": 100,               // master limit
  "gear":  null,              // "normal" | "fast" | null — one or none, never both
  "gears": {"normal": [124,126], "fast": [241,241]},   // the codes behind them
  "gear_clamped": false,      // true when the engaged gear is above --v-max
  "set":   [60, 25],          // percent you typed, before the level
  "out":   [60, 25],          // percent actually streaming, after the level
  "out_v": [1.96, 1.4],       // ... in volts
  "out_dac": [151, 108],      // ... and as DAC codes, the way the firmware rounds
  "esp": {                    // read back from the board
    "vL": 1.96, "vR": 1.4,    // what the pins are at
    "pL": 60,   "pR": 25,     // the same, as percent
    "dacL": 151, "dacR": 108,  // ...and as the board's own DAC codes
    "en": true, "en_pin": 23, // the digital enable pin
    "rev": [false,false], "rev_pin": [19,5],          // direction relays
    "rev_wait": false, "dir": "forward",
    "pkt": 482, "bad": 0, "rssi": -52, "uptime": 91234
  },
  "esp_fresh": true, "vmax": 3.3, "idle_v": 1.0, "serial_error": null,

  // the forward sensor's verdict — decided once, server-side, and the same
  // answer the throttle above is obeying
  "obstacle": {
    "phase": "stop",          // "go" | "stop" | "wait"
    "cm": 18.4,               // null when no echo came back — never 0
    "blocked": true,          // the sensor says stop
    "blocking": true,         // ...and it is being acted on (forward, guard on)
    "guard": true,            // false = switched off for bench work, and visibly so
    "stops": 3,
    "reason": "maneə 18.4 sm — dayanıb",
    "cfg": {"stopCm": 30, "clearCm": 40, "confirm": 3, "waitMs": 1200}
  },

  // where it has been. `marks` is the last few QR reads and obstacle stops;
  // the path itself is GET /api/route
  "route": {
    "x": 1.2, "y": 4.8, "bearing": 92.5, "dist": 11.4, "v": 0.31,
    "moving": true, "points": 214, "seq": 213, "track": 0.3,
    "calibrated": true, "marks": [ … ]
  },

  // the lift. `dir` is what is being held, `out` is what goes on the wire, and
  // `at` is what the board says the bridge is doing — they disagree exactly
  // when it matters: during the pass through zero, and when the run limit fires
  "lift": {"dir": 1, "out": 191, "pct": 75, "at": 191, "cut": false,
           "pin": [16, 17, 4]},

  // where that is on the competition field, and what to do at the node ahead.
  // `pose.known` is false until a code has been read: an unlocalised robot is
  // somewhere, not at the origin
  "field": {
    "qr": "q5", "from": "D3", "to": "GATE", "sure": true, "known": true,
    "pose": {"known": true, "x": 4.02, "y": 0, "bearing": 90, "dead": 0.12},
    "turn": {"node": "GATE", "dir": "straight", "deg": 0, "label": "düz get",
             "then": "D4", "dist": 1.6},
    "plan": ["START","D1","D2","A2","D2","D3","GATE","D4","D6","B3"],
    "stops": ["A2","B3"], "step": 6, "on_plan": true,
    "reads": 4, "strays": 1, "unknown": null, "seen": [ … ]
  },

  // the Pi's own three
  "cam": {"on": true, "live": true, "device": "/dev/video0", "w": 640, "h": 480,
          "fps": 25, "frames": 9184, "viewers": 2, "err": null},
  "qr":  {"available": true, "text": "ROBOT-A1", "at": 1786288938999,
          "age_s": 12.4, "count": 3, "decodes": 41, "ms": 38, "history": [ … ]},
  "rpi": {"cpu": 31.2, "cores": [40, 28, 25, 31], "temp_c": 52.6, "mhz": 1800,
          "mem": {"total": 1934311424, "used": 787…, "pct": 40.7},
          "load": [0.42, 0.51, 0.44], "uptime_s": 2760,
          "proc": {"cpu": 22.1, "rss": 91…, "up_s": 310, "pid": 4046},
          "throttled": {"under_voltage": false, "ever_under_voltage": true, "ok": true}}
}
```

`reason` says why the output is what it is, in the interface's language —
Turkish: `sürüyor`, `tuş w`, `hız normal`, `hız hızlı`, `takip: viraj`, `GERİ`,
`DÖNÜŞ A`, `geri…` (settling), `tuş basılı değil`, `hız bildirimi yok`,
`kare gelmiyor`, `seviye 0 %`, `engel 18 sm — durdu` (the 30 cm brake),
`durduruldu`, `tarayıcı bağlı değil`, `esp32 erişilemiyor`. The keys behind
them — `w`, `normal`, `fast` — stay English, because they are protocol: they
are in `presets.json`, in the WebSocket messages and in the tests. Only the
words a person reads are translated. The drive page also gets back `keys`,
`combo` (the row that matched) and the full `presets` table.

**This server ⇄ ESP32** — `ws://<esp-ip>:81/`, the board's own protocol. The
board speaks **volts**, not percent: it does not know your ceiling, and volts
are what the motor controller physically reads. The percent conversion lives in
`bench.js`, in one place.

```jsonc
{"cmd": "set",  "v25": 1.80, "v26": 1.50, "en": true, "r25": false, "r26": false,
                "lift": 191}             // the L298N: -255..255, sign is direction
{"cmd": "pin",  "gpio": 4, "val": 128}   // a spare pin, 0-255. Unknown pins refused
{"cmd": "stop"}
{"cmd": "ping"}
```

The status carries the sonar back:

```jsonc
"son": {
  "fwd_cm": 42.1,        // null when no echo came back — never 0
  "pin": {"trig_f":14,"echo_f":32}
}
```

`en` is the digital pin. **Leaving it out means 0** — a client that never
mentions it can never leave the driver enabled. `r25` / `r26` behave the same
way for the two direction relays, and so does `lift`: a packet that does not
mention the actuator stops it.

### Direction

The controllers have no reverse input, so direction is changed by crossing two
motor phases and the matching two hall lines with relays — one set per wheel,
driven by `GPIO19` and `GPIO5`.

`GPIO5` used to be `GPIO18`, which sat with two of its four relays latched at
boot while `GPIO19` drove an identical bank cleanly. Both pins measured a clean
3.3 V, so the pin was never the likely cause — see the note below on what a
3.3 V high does to an input stage referenced to 5 V.

`GPIO5` is a **strapping pin**. Its weak pull-up at reset is the right way to
fail for an active-LOW input — the coil stays off through the boot window with
no external resistor — but it is sampled at reset and glitches briefly as the
ROM starts, so nothing may hold it LOW while the board comes up. `GPIO27` and
`GPIO33` are free if that turns out to bite.

The relay inputs are **active-LOW**: the pin sits **HIGH** for forward and is
pulled **LOW** to reverse that wheel (`REVERSE_ACTIVE_LOW` at the top of the
sketch). That is how most opto-isolated relay modules want to be driven, and it
keeps the safe direction on the de-energised side of the coil — a cut wire, a
flat 12 V rail or a crashed ESP32 all leave the robot facing forward.

The one gap is the moment between reset and `setup()`, when the pin is still an
input: it is the relay board's own pull-up that holds it off. The sketch drives
those three pins before it even opens the serial port, so the window is
microseconds rather than the 200 ms it used to be — but if your board has no
pull-up on its inputs, add one (10 k to 3V3).

**A 3.3 V high may not release a 5 V relay board at all.** Those inputs let go
only when IN sits near their own VCC. Run the board on 5 V and drive it from an
ESP32 and roughly 1.7 V is left across the opto LED and its resistor — enough to
hold some channels in, with per-channel tolerance deciding which. The symptom is
relays latched on one bank and not the other from identical drive, and moving to
a different GPIO does not help because every GPIO is 3.3 V. The fix is to pull
the board's **JD-VCC jumper**, feed `VCC` from **3V3** and `JD-VCC` from **5 V**:
the opto then sees 3.3 V on both sides, so off is genuinely off, while the coils
keep their 5 V. Failing that, a 74HCT125 between the ESP32 and the inputs takes
3.3 V logic in and gives a real 5 V out. Avoid a transistor per channel — it
inverts the sense, which would flip the fail-safe direction.

`esp32/ws_dac/ws_dac.ino` owns the interlock: **it will not move either pin
until both DACs have sat at idle for `REV_SETTLE_MS`.** Crossing phases under
load destroys the controller's output stage, and a wheel being dragged along by
the robot is still turning — so the rule covers both wheels and lives on the
board, rather than depending on wifi, the browser or this server behaving.

A packet that asks for a flip cannot raise the throttle in the same breath
either: direction is read before the two voltages, and while a flip is pending
the targets are forced to idle. So the stopping starts with the packet that
asked for the turn, not with the next one.

Pressing A, D or S therefore stops the robot, waits about a second, and only
then moves. The drive page shows `İLERİ` / `DURDURULUYOR…` / `DÖNÜŞ` / `GERİ`
so the pause is never a mystery. Relays de-energise to *forward*, so a dead ESP32,
a cut wire or a flat 12 V rail all leave the robot facing the safe way.

The full build — parts, wiring, commissioning order — is in
`docs/relay-reverse.pdf`.

The board answers at 10 Hz with `{"type":"status","v25":…,"v26":…,"en":…,
"en_pin":23,"clients":…,"pkt":…,"bad":…,"stale":…,"rssi":…,"uptime":…}`.

Minimal client, straight to the board:

```js
const ws = new WebSocket('ws://192.168.1.42:81/');
ws.onopen = () => setInterval(
  () => ws.send(JSON.stringify({cmd: 'set', v25: 1.8, v26: 1.5, en: true})), 50);
ws.onmessage = e => console.log(JSON.parse(e.data));
```

## Safety

Four independent things have to be true for a pin to be above idle:

1. A browser is connected to this server.
2. You pressed START.
3. This server is reaching the board (`esp_fresh`).
4. The board received a packet in the last 300 ms.

Break any one and both DACs drop to 1.00 V **and GPIO23 drops to 0**. Close the
tab, pull the wifi, kill this process, or unplug the board — every one of those
ends inert.

The drive and follow pages add a fifth: **a report in the last 400 ms**. For
`/drive` that is the held-key set, or the engaged gear — a gear has no keyup
behind it, so the page has to keep saying it means it — and for `/follow` it is
the frame the pilot just acted on. All of them coast to 0 % without waiting to
be told, which is what covers a wedged tab, a lost focus, and a camera that
stops delivering frames.

Every value is clamped to `[0, 100] %` here and to `[V_MIN, V_MAX]` again on
the board. Nothing can command below idle: 1.0 V is what the controller reads
as zero throttle, and 0 V is never output.

First powered run: **wheels off the ground.** Confirm START raises the voltage
and takes GPIO23 to 1, and that STOP drops both DACs to 1.00 V and GPIO23 to 0,
before you put it on the floor.

## Test

```bash
npm test             # everything
npm run test:globals # no two scripts on a page declare the same name — 1 s
npm run test:bench   # server + firmware + follow path
npm run test:pilot   # the control law, on its own
npm run test:wheels  # the shared wheel trim, and that every page agrees on it
npm run test:analyse # what /tune concludes from a log
npm run test:sonar   # the obstacle state machine and the map
npm run test:route   # dead reckoning — the map's arithmetic
npm run test:field   # the field graph, QR localisation, and the turns it hands out
npm run test:camera  # JPEG framing, QR counting, and the Pi's own numbers
npm run test:vision  # vision page only (needs playwright)
npm run test:pages   # every page opens without throwing (needs playwright)
```

The two browser suites skip themselves with a note if playwright is not
installed, so `npm test` is still worth running without it.

### Why `test_globals.mjs` exists

The shared modules are loaded as plain `<script>` tags, so they all land in one
global scope, and a second top-level `const` with the same name is a
SyntaxError — not a warning, not a shadow. The offending script and everything
after it simply does not run.

`pilot.js`, `sonar.js` and `analyse.js` each defined `const clamp`. That meant
`/follow` — the page that drives the robot — **threw on load and had done ever
since `sonar.js` was added**. The page rendered. The sliders were there. Nothing
happened when you pressed ARM. Neither the unit tests nor a careful reading
could see it, because each module is correct on its own and only the
combination is broken.

So there is now a check that reads every page, works out which scripts it
loads, and fails if any name is declared twice. It takes a second and needs no
browser. It also verifies its own detector against known-good and known-bad
input first, because a check that cannot fail is not a check.

**294 checks** for the control path, no hardware. It runs `esp32ws_sim.js` — a behavioural mirror of
`ws_dac.ino`, including the watchdog, the idle-when-no-clients rule and the direction
interlock — as a
real WebSocket server, then drives the real `server.js` against it over a real
browser WebSocket and verifies what landed on the simulated pins — including a
full drive-page session: every key and combination, live preset edits, and the
400 ms dead-man.

**43 checks** for the route. `routeStep` is pure, so a whole drive is simulated
in a loop against arithmetic: drive at a known speed for two seconds and the
robot has to be exactly that far away, a 1 m square has to close on its own
start, and reversing one wheel has to pivot at twice the rate of stopping it.
The other half is what it refuses to invent — no distance calibration means no
map at all rather than a guess, the first step only starts the clock (an
integration against "now minus zero" is how a fresh page reports the robot 1.7
billion metres from home), and a ten-second gap does not become ten seconds of
driving.

**45 checks** for the camera, the QR reader and the Pi stats. The camera half is
the part that would be worst to debug on a robot: cutting ffmpeg's byte stream
back into whole JPEGs, with frames split across chunks, three frames in one
chunk, junk before the first marker, and a stream that has lost sync and must be
dropped rather than held forever. The QR half is a **real decode** — an actual
"ROBOT-A1" code, embedded as its module matrix and painted into a grey buffer
the shape ffmpeg produces — followed by the part that is easy to get wrong:
twenty frames of the same sign is one reading, and the same code after a real
gap is two.

**29 checks** for the sonar. `obstacleStep` is a pure function, so the sensor
can be made to misbehave in exactly the ways a real HC-SR04 does: a single stray
reading that must not stop the robot, three in a row that must, a target parked
between the two thresholds, someone stepping half out of the way during the
wait, and — the one that matters — the echo dying while stopped in front of
something soft, which must not read as "the way is clear".

**22 of the 294** are the 30 cm brake, end to end, and they are the ones to read
if you change anything near it. They do not test the state machine — that is the
29 above. They test that it **cannot be got past**: the robot is driven with a
typed percentage, which is the path that never had an obstacle check in it, a
wall appears at 15 cm, and the pins have to go to idle without the browser being
told anything and without the browser co-operating. Then the things that would
make it useless: that ENABLE stays up, that a single close reading does not stop
it, that reversing away from the wall still works, that turning back to forward
re-arms it, that switching it off is possible and visible in the status, and
that an echo which simply stops coming back while stopped does not read as the
way being clear.

**28 checks** for the vision page. It lifts the `<script>` straight out of
`public/vision.html` into a real browser and runs it against painted tracks —
so it tests the page itself, not a copy of it. Covered: auto-detection of both
track types (each starting from the *opposite* conclusion, so a pass can only
mean it actively changed its mind), white furniture / a pool of floor light / a
yellow board present, the robot straddling an edge line, hysteresis on a real
track change, a featureless frame not causing thrash, the manual buttons
overriding auto, and the run lock — sixty frames of the *other* kind of track
not budging it, while the signals underneath keep scoring the truth. Needs `npm i -D playwright`; it skips itself if absent.

**60 checks** for the pilot. `pilotStep` is a pure function, so a whole run is
simulated in a loop: that it steers the right way, that `swap` only exchanges
the two pins, that a bend slows it down and a bend *ahead* slows it down
earlier, that the ramp survives a five-second stall without a lurch, and the
full lost-the-road sequence from held-steer through stop to dropping ENABLE.
Then the dead band: that zero stays zero, that the smallest positive demand
still clears the threshold, that full steer can still stop the inner wheel — and
that with the compensation switched off the old behaviour comes back, which is
the check that says the logs were read correctly. Then the recovery: full steer
toward the road, inner wheel stopped, crawl speed, and no flickering on the
threshold.

**54 checks** for the log analysis. Each synthetic run has exactly one thing
wrong with it, and the check is that exactly one number gets suggested — an
analyser that says "try lowering everything" is a horoscope. Also: that a
nonsense file is refused rather than crashed on, that a five-row log produces no
opinions at all, that manoeuvres split into straights and left- and
right-handers with one-frame twitches folded away, that a run spent in the dead
band is diagnosed as such rather than as bad tuning, and that the distance
constant comes out the same whether the lap was driven fast or slow.

## Files

| File | What it is |
|---|---|
| `server.js` | HTTP (both pages) + browser WebSocket, CLI |
| `bench.js` | START/STOP state, percent → volts, the 30 cm brake, the route, where it is on the field — the one function that decides pin values |
| `camera.js` | the Pi's webcam: one ffmpeg, MJPEG out to viewers, a grey tap for QR |
| `qr.js` | reading QR codes off that tap, and counting them honestly |
| `rpi.js` | what the Pi is doing to itself: CPU, temperature, RAM, throttling |
| `shared.js` | loads the pages' pure modules into Node — see the note at its top |
| `transports.js` | `WsTransport` (wifi) and `SerialTransport` (USB) |
| `esp.js` | USB wire format — port of `rpi/esp.py` |
| `esp32ws_sim.js` | mirror of `ws_dac.ino`; powers `--fake` |
| `esp32sim.js` | mirror of `throttle_dac_2ch.ino` (USB path) |
| `public/home.html` | hub page |
| `public/manual.html` | manual page, self-contained |
| `public/road.js` | the road detector, shared by `/vision` and `/follow` |
| `public/pilot.js` | the control law: error → two wheel percentages. Pure |
| `public/analyse.js` | reads a run log and says what to change. Pure |
| `public/sonar.js` | the obstacle state machine. Pure |
| `public/route.js` | dead reckoning: two wheel percentages → a path. Pure |
| `public/field.js` | the competition field: the graph, QR localisation, the plan and the turns. Pure |
| `public/lift.js` | the lift's two buttons and their dead-man, shared by /drive and /dashboard |
| `public/cam.js` | where a page gets its pictures from: the Pi, this browser, or a file |
| `public/dashboard.html` | everything at once: speed, volts, ESP32 + Pi, camera, obstacle, QR, the field map and the next turn |
| `public/vision.html` | camera + road detection (qara/ağ yol), look and tune |
| `public/follow.html` | the same detector, driving, with the run recorder |
| `public/tune.html` | reads a run back: charts, manoeuvres, suggestions |
| `public/obstacle.html` | forward sonar: drive, stop, wait, carry on |
| `public/pins.html` | every spare GPIO, 0-255 by hand |
| `public/drive.html` | keyboard drive page, self-contained |
| `follow_log.js` | writes `logs/follow-*.json` and its summary |
| `presets.json` | key table + master level + the two fixed speeds, written when you edit them (git-ignored) |
| `follow.json` | follow sliders + distance calibration (git-ignored) |
| `logs/` | one JSON file per run (git-ignored) |
| `public/wheels.js` | the shared wheel trim + the ⓘ text, used by every page |
| `public/setup.html` | the numbered checklist: measure, type, saved everywhere |
| `test/test_globals.mjs` | no duplicate top-level names on any page, 24 checks |
| `test/test_bench.mjs` | server + firmware + gears + follow + sonar + the 30 cm brake, 294 checks |
| `test/test_pilot.mjs` | the control law and the speed loop, 85 checks, no browser |
| `test/test_wheels.mjs` | the shared trim, 55 checks — incl. /manual vs /follow agreement |
| `test/test_analyse.mjs` | the log analysis, 54 checks, no browser |
| `test/test_sonar.mjs` | the sonar logic, 29 checks, no browser |
| `test/test_route.mjs` | dead reckoning, 43 checks, no browser |
| `test/test_field.mjs` | the field graph, QR localisation and the turns, 105 checks, no browser |
| `test/test_camera.mjs` | JPEG framing, a real QR decode, the Pi stats — 45 checks |
| `test/test_vision.mjs` | vision suite, 28 checks — real browser, synthetic tracks |
| `test/test_pages.mjs` | every page opens clean, 36 checks — real browser |

## USB instead of wifi

The USB path from earlier still works — flash
`esp32/throttle_dac_2ch/throttle_dac_2ch.ino` and run
`node server.js --serial COM5`. Same UI, same percent commands; the binary
frame format is documented in `esp.js`. Use it when wifi latency or dropouts
matter more than the convenience of no cable.

One gap: **the USB firmware has no enable pin.** `throttle_dac_2ch.ino` drives
the two DACs only, so `en` is accepted and ignored on that path. If you need
GPIO23, use the wifi board.
