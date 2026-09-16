# Rover — one robot, two boards

The same robot, the same road-following code, two entirely different things at
the far end of the wire:

| | board | how a wheel is commanded | run it with |
|---|---|---|---|
| **the bench** | ESP32 | two DAC pins, 0–100 % of `--v-max`, streamed at 20 Hz | `--esp <ip>`, `--serial <path>`, or `--fake` |
| **the printer** | Creality mainboard | Marlin G-code down USB, `G1 X… Y…` for as long as a key is down | `--marlin`, or nothing at all |

```
node server.js --esp 192.168.1.42     the ESP32 over wifi
node server.js --fake --esp sim       the ESP32, simulated, no hardware
node server.js                        the printer, found on USB
node server.js --marlin --no-connect  the printer's pages, port left alone
```

Naming any of the ESP32's flags picks the ESP32; `--marlin`, `--port`, or no
flags at all picks the printer. The ESP32 path never had a default — it used to
refuse to start until you said where the board was — so an argument-less
`node server.js` is the printer, found and opened on USB.

**`/vision`, `/follow` and `/tune` are the same pages on both.** The detector,
the control law, the wheel trim, the run log and everything `/tune` concludes
from it are about a robot following a line; none of them know or care whether a
wheel percentage ends up as a voltage or as millimetres of G-code. That is the
whole reason the two halves live in one server: **Part I** below is the ESP32
machine end to end, **Part II** is the printer, and the road pages are written
once and documented in Part I.

**The interface is in Turkish** — every page, the shared wheel-trim strip, the
`/tune` findings, and the `reason` strings the server puts in the status frame.
Identifiers are not: keys (`w`, `wa`), gear names (`normal`, `fast`), pin names,
JSON fields and WebSocket commands stay English because they are protocol, and
so are this file, the code comments and the server's own console output.

---

# Part I — the ESP32 DAC bench

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
| **/dashboard** | everything at once: speed, volts, ESP32 + Pi health, camera, obstacle, QR, LiDAR map |
| **/panel** | the big-screen panel: everything on /dashboard plus driving, fixed at 1920 × 1080 — see below |
| **/lidar** | the LiDAR map full screen — also on the printer machine |
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

No board yet? `npm run fake` runs a simulated ESP32, a simulated LiDAR and the
full UI.

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

Naming `--esp`, `--serial` or `--fake` is what selects this machine. The
printer's flags — `--marlin`, `--port`, `--baud`, `--no-connect`, `--trace` —
are in [Part II](#part-ii--the-creality-mainboard), and with no flags at all it
is the printer that comes up.

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
| **LiDAR haritası** | the LiDAR map, below: an occupancy grid streamed by a webscan scanner, with the live scan and the scanner's path |
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

### The big screen — `/panel`

`/dashboard` scrolls and reflows, which is right for a phone and wrong for the
monitor beside the track. `/panel` is the same robot laid out once at exactly
**1920 × 1080**, no scrolling, nothing moving when a number gets longer:

| | |
|---|---|
| header | state, reason, links to every other page, the clock, and a big **STOP** |
| strip | speed, both wheels (%, V, DAC), distance ahead, distance travelled, direction and ENABLE, where it is on the field, LiDAR rate, the Pi |
| left | camera · obstacle gauge with the **brake switch** · last QR and its history |
| centre | the LiDAR map with its tools and room picker · position on the field, the next turn, the plan, mission pickers, test QR, route reset |
| right | **driving** — ARM, STOP · IDLE, the W A S D pad, NORMAL / SÜRAT, the master level, what the board reports per wheel, the wheel trim · the lift · ESP32 and Pi |

On any other size the whole screen is scaled to fit, keeping its proportions.

It drives with the same commands and the same 400 ms dead-man as `/drive`:
the held keys or the engaged gear go out at 20 Hz while armed, a lost focus
releases every key, and **space** is STOP. Switching the brake off asks first,
and while it is off the obstacle card and the strip say so in colour. Turning
it off sends the stored obstacle thresholds back with the flag, because the
config merge is shallow and `{guard}` alone would reset them.

What is deliberately not on it is anything you tune rather than use — the key
table, the gear codes, the pilot and detector sliders, the spare pins, run
analysis. Those are one click away in the header. `/follow` is not embedded
either: the line follower runs its detector in its own tab, and two copies of
the thing steering the robot is one too many.

### The map — LiDAR, from webscan

The map on the dashboard is **webscan's radar**: a 2D occupancy grid of what is
physically around the scanner — walls where beams ended, free space where they
passed, and unknown wherever nothing has looked. `/lidar` is the same map full
screen, with the room picker and every number.

```
iPhone (webscan ARKit app, LiDAR)  ──SCN1, ~560 B/scan──▶  this server, /ws  ──▶  /dashboard, /lidar
   or webscan's browser scanner                             (the relay)
```

The relay that used to be webscan's own Express server lives inside this one
now (`lidar_relay.js`), on the same port, speaking the same protocol to the
byte: `/ws?room=<name>&role=sender|viewer`, binary SCN1 frames, JSON control
messages. So **nothing in webscan changes.** The iPhone app itself is in this
repo too, under [`mobile/`](mobile/README.md): React Native + Swift/ARKit, with
its own setup script (macOS and Xcode needed to build it).

**The phone finds the rover by itself.** Like webscan's own relay, this server
announces `_webscan._tcp` over mDNS (`lidar_discovery.js`) with the same TXT
keys the app reads — `tls` and `path` — so the app lists it as
**`tetym-rover on <hostname>`**: open the app, set the room, press Start. That
matters more on the rover than it did in webscan, because the Pi is usually on
the ESP32's access point *and* a router, and mDNS answers from every interface
while a typed address only works from one network. On shutdown it sends
goodbye packets, so a phone does not keep dialling a server that is gone.

Where multicast is blocked (some guest and corporate wifi), type the address in
the app's *Enter an address manually* instead — the startup output prints one
per interface:

| | |
|---|---|
| relay URL | `ws://<pi>:8090` (`wss://` with `--https`) |
| room | `default`, or whatever `--lidar-room` says |

`--no-advertise` turns the announcement off. The app's "viewer" link,
`/viewer.html?room=…`, opens `/lidar` here.

What the pages say about the scanner comes from the scans themselves:

| shown | meaning |
|---|---|
| `canlı` | scans arriving |
| `sabit · telefon hareketsiz` | the ARKit app sends nothing while the phone is still — one heartbeat every 700 ms — so a slow steady stream is a phone standing still, not a failing link |
| `ARKit takibi kayboldu` | the scans carry `trackingLost`: ARKit is guessing where the phone is (too fast, too dark, a blank wall). The sensor turns red and the map may smear until it recovers |
| `durdu — son veri N sn önce` | nothing for 2.5 s |

`metrik` / `yaklaşık` is read from each scan's calibrated flag, not from what
the sender last announced.

The rest is the webscan viewer ported into plain scripts, so it needs no build:
`public/lidar.js` is the wire format, the log-odds grid and the motion gate
(pure — the server and the tests run the same bytes); `public/lidarmap.js` is
the socket and the canvas renderer. The page rebuilds the same grid the phone
built, from the same scans behind the same gate.

- **A late viewer gets the whole session.** The relay keeps the last 2 000
  scans per room — about a megabyte — and replays them, so reloading the
  dashboard gives the map back rather than an empty room.
- **Haritayı temizle** clears it on the server (`lidar_reset`) as well as on
  the page, or the next reload would replay it. The phone keeps its own copy.
- **Live means frames arriving**, not a sender that says it is scanning. The
  card says `durdu` and how long ago when they stop, and names the other room
  if a scanner is streaming somewhere this page is not looking.

What it is not: **the competition field.** The map is in the scanner's own
frame — its origin is wherever the phone started its session — and it is not
rotated onto the field, because nothing measures how the phone is mounted on
the robot. A map shifted by a guessed offset would be a confident lie. Where
the robot is on the field still comes from the QR codes, below, and is shown
in the navigation card.

How good it is depends on the scanner, and the card says which:

| scanner | depth | scale | walking |
|---|---|---|---|
| webscan ARKit app (iPhone Pro) | LiDAR, ±1–2 cm | metric | no drift |
| webscan browser scanner | neural network | calibrated by hand, approximate (`yaklaşık`) | drifts metres |

The browser scanner can be served from here too: build webscan (`pnpm build`)
and start with `--webscan ../webscan/apps/web/dist --https`; then
`/sender.html?room=default` on the phone streams straight to this server. It
needs HTTPS because it is the phone's own camera.

No phone at all: `--lidar-sim` (and `npm run fake`) streams a simulated LiDAR
round a made-up 10 × 6 m room, labelled `SIMULATED lidar` everywhere it
appears — it is not the robot, and the map says so.

| Flag | Default | |
|---|---|---|
| `--lidar-room <name>` | `default` | the room the pages show |
| `--lidar-sim` | off | simulated scanner in that room |
| `--webscan <dir>` | — | also serve a built webscan web app |
| `--no-advertise` | off | do not announce the relay over mDNS |

### Where it is — the competition field

The field is no longer drawn on the dashboard — the LiDAR map took its place —
but everything below still runs: the localiser, the planner and the turn at
the next node, shown in the **konum ve sıradaki dönüş** card, which also holds
the mission pickers, the test QR selector and **Yolu sıfırla**.

The field is the arena as the **EK TEKNİK ŞARTNAME** measures it (Şekil 1,
18 × 10 m): the three pick-up points **A1–A3** along the top, the drop column at
**D4** with **B3** above it, **B1** below it and **B2** at the end of the
corridor, the junctions **D1–D4** and the start area joined by the corridors
between them, the factory-automation door across the middle, and the nine QR
codes **q1–q9** standing on the legs they belong to. The practice field
(Şekil 3, 10 × 7 m: start, A1, the door, B1) is the other one —
`--field deneme`. The origin is each field's bottom-left corner, in metres.

Where the drawing prints a dimension it is used as printed (the corridor 5.5 m
below the top wall, the station QRs 4 m below it, BASLA 3.8 m from the wall
behind the start area, the walls at 7.5 m and 9 m). The branch positions, the
door and q5 / q6 / q8 have no dimension and are scaled off the drawing — measure
them on the day and correct `public/field.js`.

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

The codes on the floor say what Tablo 2 prints — **BASLA, ALIM1–3, KAPI1–2,
BIRAK1–3** — and a read is matched against that as the whole text, upper-cased,
with Turkish letters folded (`BAŞLA`, `kapı1`). For rehearsal the ids work too:
`q5`, `Q5`, `qr5`, `qr/5` at the end of a URL, or a string that is nothing
but a number. A field has other codes
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

### The reversing buzzer, and the Pi's own pins — `/pins`

A forklift that backs up silently is the one hazard here that is not a software
fault: everything else it does is in front of it. So when both wheels are asked
to go backwards, two of the Pi's pins go high and the buzzer sounds — decided in
the server, from the same demand the motors get, so it sounds with no browser
open. A pivot is not reversing (one wheel goes back, the robot does not), and a
robot that is stopped or held by the PLC is not reversing either.

`/pins` is where it is set up and where the wiring is written down:

| | |
|---|---|
| **Geri vites buzzeri** | the pins (two by default), beep and gap in ms, steady instead of beeping, "modül LOW'da ötüyor" for the cheap boards that sound on LOW, and **Sesi dene** |
| **Pin notlarım** | GPIO number, a name, a note, and whether it is an output. Saved in `follow.json`, shown on the hub page, served at `GET /api/pins` |

Off until someone turns it on: no pin is driven before the wiring is described.
Only pins written down as outputs can be driven by hand — a number typed into a
page could be the serial console or the I²C bus. Driving them needs permission
for the pins: `/sys/class/gpio` (the `gpio` group) or `pinctrl`; where there is
neither — a laptop — the page says so instead of pretending, and the settings
still save for the robot.

On the ESP32 bench the same page is at `/pi-pins`; `/pins` there is still the
ESP32's own GPIOs.

### One page to start from — `/`

Typing the robot's address lands on the hub: the link status, what the wheels
are doing, the buzzer, the pin notes, and a tile to every page **this** machine
serves — the tiles are built from `GET /api/pages`, so a page that is not
served is not offered. On the Ender rover the hold-WASD G-code page moved from
`/` to `/gcode`; everything else kept its address.

### Keys on /follow — following, hand driving and the fork

| key | what it does |
|---|---|
| **F** | start following / stop following (a toggle) |
| **Space**, **Esc** | stop — always, from anywhere on the page; never starts anything |
| **W A S D** | drive by hand while held. W / S forward and back, A / D alone pivot, with W or S an arc. Pressing one while the pilot is driving stops the pilot — **F** starts it again |
| **Q** / **E** | the fork down / up while held. Works while following, too |

The same keys are on screen for touch. Held keys and the fork are repeated at
20 Hz and let go by the server 400 ms after the repeats stop, so a lost focus or
a frozen tab is a stop. On the Ender rover the fork is the board's **Z** driver,
riding in the same G1 line as the wheels (`G1 X… Y… Z… F…`) at 240 mm/min by
default — under the Ender 3 Pro's 5 mm/s Z limit, so lifting while driving does
not slow the wheels. Its speed and direction are set on /follow and saved in
`follow.json` as `lift.feed` / `lift.invert`. The hand-drive speed is the
slider on the same card. On the ESP32 bench the keys are the existing `keys`
and `lift` commands, at /drive's speeds and level.

If Z refuses to move down before the fork has been homed, it is Marlin's soft
endstop: turn it off on /gcode (M211 S0).

### The factory automation system — PLC (`/plc`)

The ek şartname's second half is a protocol: the robot talks to the
competition's **PLC simulator** over **UDP** on the field's closed wifi, and the
PLC hands out the task and opens the door. `plc_link.js` is the socket,
`public/plc.js` the packets and the mission (pure, tested with no network),
`plc_run.js` wires them into either server, and `/plc` shows all of it.

| | |
|---|---|
| PLC | `192.168.100.100`, UDP port `1515` |
| robot (the Pi) | `192.168.100.10`, set by hand, gateway `192.168.100.1` |
| team laptop | `192.168.100.20`, gateway `192.168.100.1` |
| wifi | MAC-filtered: hand in the Pi's wifi MAC (`cat /sys/class/net/wlan0/address`) |

Once a second the robot sends **PAKET_TX** (7 bytes) and the PLC answers each
one with **PAKET_RX** (3 bytes). The PLC times the packets and declares the link
broken after a second of silence, so the send clock is fixed to the time the
link started rather than chained off the previous send.

```
PAKET_TX  durum · alım · bırakma · X lsb · X msb · Y lsb · Y msb
          e.g. 04 02 03 94 02 c2 01 = yüklü, A2 → B3, x 6.60 m, y 4.50 m
PAKET_RX  alım · bırakma · kontrol (1 bekle, 2 başla / devam)
```

X and Y are `integer(metres × 100)` as little-endian int16. (The table calls
the control byte "Byte3"; the packet is three bytes, so it is byte 2.)

**The mission.** The durum byte is the mission's phase:

| durum | when |
|---|---|
| 1 hazır | no task |
| 2 görev alındı | a task arrived; the robot is **held** until the PLC answers that packet with kontrol 2 |
| 3 yüksüz | driving to Ax |
| 4 yüklü | leaving Ax (ALIMx read on the way out, or **Yük alındı** on /plc) |
| 5 fabrika komutu | **KAPI1** read heading for the door (or **KAPI2** on the way back): **held** until the PLC answers a durum-5 packet with kontrol 2 |
| 6 dönüş | leaving Bx (BIRAKx on the way out, or **Yük bırakıldı**) |
| 7 hata | the motor board cannot be reached |
| 8 acil stop | /plc's button or Space |

The route is planned the moment a task arrives — `START → Ax → Bx → START`
through the door both ways — and shown on /plc, /panel and /dashboard. The lap
ends when BASLA has been read on the way home and the robot is stopped (or
**Başlangıca vardı**); the PLC then has to say bekle, or name another task,
before the same one is taken again.

"Held" is enforced where the wheels are driven, not on a page: on the ESP32
bench every drive path (keys, gears, /follow) resolves to zero with enable up,
and on the Ender rover the stream of G-code chunks stops and `/api/marlin/run`
answers **423** while held. A kontrol 1 that arrives while the robot is driving
anywhere else is not a stop order — the PLC answers every packet, and most of
those answers are about a door the robot is nowhere near.

Two things the specification leaves open are decided in `public/plc.js` and
written down there: a station byte of 0 in PAKET_TX means "no task yet", and
until the first QR the robot reports the start area's coordinates (/plc marks
them as an assumption).

What this does **not** do is steer. The mission knows the route, the turn at the
next junction and when to wait, and it stops the wheels when it must; following
the line and taking the turn is still the pilot's job on /follow.

```
node server.js --marlin --plc                           the competition: Ender board, real PLC
node server.js --marlin --plc --plc-bind 192.168.100.10 ...and refuse to send from any other address
node server.js --fake --plc-sim                         the whole mission on a desk, simulator inside
node server.js --marlin --plc-sim --field deneme        the practice field
node plc_sim.js --task 2,3 --gate-wait 3000             a stand-in PLC on its own (npm run plc-sim)
npm run test:plc                                        packets, a full lap, UDP, both servers
```

Setting the Pi's address, with NetworkManager (Raspberry Pi OS Bookworm):

```
sudo nmcli con mod "<the field wifi>" ipv4.method manual \
  ipv4.addresses 192.168.100.10/24 ipv4.gateway 192.168.100.1
sudo nmcli con up "<the field wifi>"
```

The simulator (`plc_sim.js`, `--plc-sim`) checks that every packet is 7 bytes
with a valid durum, records a timeout after a second of silence, and in its
automatic mode plays the factory: task and start at the start line, the door
shut for three seconds and then open, the next task after a finished lap. Its
manual mode answers with whatever is set on /plc. It is a rehearsal tool —
what the organisers' PLC does at the door, and when, is theirs.

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
{"cmd": "field_qr",      "text": "KAPI1"}       // a code read by hand — rehearsal only
{"cmd": "plc", "event": "picked"}                // picked · dropped · home · estop · release · reset
{"cmd": "plc", "sim": {"auto": false, "control": 2}}  // the built-in simulator, by hand
{"cmd": "lidar_reset",   "room": "default"}     // forget the LiDAR map, relay and pages
```

`/ws` on the same port is not this socket: it is the LiDAR relay, webscan's
protocol unchanged — see [the LiDAR map](#the-map--lidar-from-webscan).

Five things are readable over plain HTTP, all read-only:

| | |
|---|---|
| `GET /logs`, `GET /logs/<name>` | the runs, which is how `/tune` offers the lap you just drove instead of a file dialog. The name is matched against `follow-<word>.json` rather than joined into a path — this server has no authentication and sits on a shared wifi |
| `GET /camera/stream.mjpg` | the webcam, as `multipart/x-mixed-replace`. Point an `<img>` at it. A viewer that is not keeping up has frames **dropped** rather than queued: a live view a minute behind is worse than one that skipped a second |
| `GET /camera/frame.jpg` | the latest single frame, for anything that does not want a stream |
| `GET /api/route` | the whole path and its marks, once — see the map, above |
| `GET /api/field` | the field in use: nodes, edges, walls and where each QR stands and what it says. Static for a whole competition, so it is fetched once rather than repeated ten times a second |
| `GET /api/plc` | the mission, the PLC link (last PAKET_TX / PAKET_RX, counts, errors) and the simulator if there is one. The status frame carries the same as `plc` |
| `GET /api/wheels` | the wheel trim, for the two pages with no socket |
| `GET /api/lidar` | every LiDAR relay room: senders, viewers, frames, fps, how stale. The status frame carries the default room as `lidar` |

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
    "map": "yarisma", "qr": "q5", "text": "KAPI1",
    "from": "D3", "to": "GATE", "sure": true, "known": true,
    "pose": {"known": true, "x": 6.72, "y": 4.5, "bearing": 90, "dead": 0.12},
    "turn": {"node": "GATE", "dir": "straight", "deg": 0, "label": "düz devam et",
             "then": "D4", "dist": 2.7},
    "plan": ["START","D1","D2","A2","D2","D3","GATE","D4","B3","D4","GATE","D3","D2","D1","START"],
    "stops": ["A2","B3","START"], "step": 6, "on_plan": true,
    "reads": 4, "strays": 1, "unknown": null, "seen": [ … ]
  },

  // the factory automation PLC — see /plc
  "plc": {
    "mission": {"phase": "gate", "code": 5, "label": "Fabrika otomasyon sistemi komutu bekleniyor",
                "hold": "kapı: PLC devam komutu bekleniyor", "task": {"a": 2, "b": 3}, …},
    "link": {"enabled": true, "host": "192.168.100.100", "port": 1515, "connected": true,
             "tx": {"code": 5, "hex": "05 02 03 a0 02 c2 01", …},
             "rx": {"a": 2, "b": 3, "control": 1, "replyTo": 5, …}, …},
    "sim": null
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

## USB instead of wifi

The USB path from earlier still works — flash
`esp32/throttle_dac_2ch/throttle_dac_2ch.ino` and run
`node server.js --serial COM5`. Same UI, same percent commands; the binary
frame format is documented in `esp.js`. Use it when wifi latency or dropouts
matter more than the convenience of no cable.

One gap: **the USB firmware has no enable pin.** `throttle_dac_2ch.ino` drives
the two DACs only, so `en` is accepted and ignored on that path. If you need
GPIO23, use the wifi board.

---

# Part II — the Creality mainboard

A differential-drive rover on a Creality mainboard: the X and Y stepper drivers
are the left and right wheels. Drive it from a browser — hold **W A S D** and
Marlin G-code goes out for as long as the key is down.

```
Raspberry Pi ──USB──> Creality mainboard (CH340, /dev/ttyUSB0 @ 115200)
     │                          │
     └── this server            └── X = left wheel, Y = right wheel
            │
       browser  ── hold W ──>  G1 X-5 Y5 F6000       (over and over)
                               M400                  (…once it has actually run)
```

```
node server.js
```

That is the whole setup on a Pi with the printer plugged in: it finds the
port, opens it, and prints a URL. Open the URL, hold a key, the gantry moves.

Its pages are `/` (hold WASD), plus `/vision`, `/follow` and `/tune` — the same
three the ESP32 serves, documented in Part I — and `/lidar` and `/plc`. The QR
reader, the field and the PLC mission run here too (see Part I), without dead
reckoning: between two codes the position is the last code's. The DAC pages (`/manual`,
`/drive`, `/pins`, `/setup`, `/obstacle`, `/dashboard`) are about two analog
pins and a competition field, so they are not served in this mode.
---

## The four directions

The rover is a **differential drive**: the board's X and Y stepper drivers are
the left and right wheel motors, mounted mirror-image. So a direction is not an
axis — it is a pair of wheel signs. Both wheels the same way is travel, opposite
ways is a spin. That is why the key map is written as X/Y pairs:

| key | direction | G-code                 |
|-----|-----------|------------------------|
| `W` | forward   | `G1 X-5 Y5 F6000`      |
| `A` | left      | `G1 X5 Y5 F6000`       |
| `S` | back      | `G1 X5 Y-5 F6000`      |
| `D` | right     | `G1 X-5 Y-5 F6000`     |

Two keys at once are **summed, then signed**, so `W`+`A` is `G1 Y5 F6000` —
one wheel only, which pivots the rover about the other — rather than two moves
fighting each other. Opposites cancel: `W`+`S` is not a direction, and pressing
both stops the rover.

### Two distances, and they are not the same

The wheels travel `d_left = -X` and `d_right = +Y`. What the rover does with
that is

```
ground travel = (d_left + d_right) / 2        how far it actually goes
turn          =  d_right - d_left             the difference, over the track
                                              width, is the heading change
```

Marlin knows none of this. It plans in the XY plane and times every move by
`sqrt(dX² + dY²)`, so for a straight move it is working with the ground
distance **times √2**. Two consequences worth keeping in mind:

* `F6000` is 100 mm/s to Marlin and **70.7 mm/s on the ground**.
* A 5 mm chunk on each wheel moves the rover 5 mm, not 7.07 mm. The page quotes
  the ground figure; the `chunk_seconds` the API returns is Marlin's, because
  that is what sets the pacing.

`5` is the chunk size and `6000` the speed in mm/min; both are boxes on the page,
and changing either while a key is held takes effect straight away.

The table lives in **one** place, `DIRECTIONS` in [`marlin.js`](marlin.js), and
the page, the HTTP API and the tests all read it from there. If a motor turns
the wrong way physically, tick **invert X** or **invert Y** on the page rather
than editing the table.

---

## What "held down" actually means

Marlin acknowledges a `G1` when it is **buffered**, not when it has finished
moving. Stream them as fast as they are accepted and the planner fills with
several seconds of queued motion: you let go of the key and the gantry keeps
going. Both hold modes on the page exist to avoid that, in different ways.

### Stream chunks — the default

One short move, repeated for as long as the key is down. The next chunk waits
for **the later of two independent brakes**, and it needs both:

**`M400`.** Marlin acknowledges a `G1` when it is *buffered*, not when it has
run, so the ack tells you nothing about the machine. `M400` is the one that
does: Marlin withholds its `ok` until the planner has drained. Each chunk is
followed by one.

**The clock.** A move cannot have finished sooner than it takes to run, so the
next chunk also waits out its predecessor's computed run time — from the
acceleration (`M204 T`) as well as the speed, not the speed alone.

Either alone has a failure mode. The clock trusts an estimate, and an estimate
5 % short leaves an extra move in the planner every twenty chunks — hold the
key for a minute and the machine is seconds behind you and still moving after
you let go. `M400` trusts the firmware, and **not every board honours it**: one
that lacks `M400` answers `Unknown command` and an `ok` in the same
millisecond, which from the host's side is indistinguishable from a move that
finished instantly. The stream then free-runs and fills the planner as fast as
the serial line will carry it.

So it does not assume. On connect it **measures**, with `G4 P300` — a dwell
that occupies the planner for a known time and moves nothing, making it safe on
an unhomed machine with its belts off:

```
· M400 waits for the planner (300 ms dwell took 306 ms).
```

or, on a board that does not:

```
!! M400 does not wait on this firmware: a 300 ms dwell came back in 11 ms.
 · Falling back to pacing each chunk by its own run time, with a margin.
```

The page says which one you have. Waiting for the later of the two brakes can
only make the stream gappier, never denser, so the board never holds more than
the one move it is executing under either firmware.

It costs a brief stop between chunks. That is the price of the machine
stopping when you tell it to.

**So the chunk size is a stopping distance**, and the page says so under the
live G-code line:

```
One chunk every 0.24 s — each finishes before the next is sent,
so releasing the key stops within 7.1 mm.
```

5 mm per axis at `F6000` is a 7 mm diagonal, about a quarter of a second.
**100 mm per axis is a 141 mm diagonal that takes eight and a half seconds at
`F1000`** — not a stream at all: one move goes out, the key does nothing
visible for seven seconds, and letting go leaves the gantry running until it
hits the frame. The page turns the hint amber past 1.5 s.

### Speed

`F6000` (100 mm/s) by default. Raising it shortens each chunk, so the gap
between commands shrinks with it — the pacing is the move.

There is a ceiling to that. A short chunk never reaches the speed you asked
for, because it spends the whole move accelerating and decelerating: past
roughly `F12000` a 5 mm chunk is limited by `M204 T`, not by `F`, and asking
for more changes nothing. Raise the chunk size along with the speed, and watch
the stopping distance the page quotes.

Watch `queue N` at the top of the page while you hold a key. It should sit at
0 or 1.

### If it still runs on after you let go

Start it with `--trace` and hold a key for a few seconds. Every line in and out
is printed with a timestamp, and the gaps between the `G1`s are the answer:

```
node server.js --trace
```

```
[   2.546] --> G4 P300
[   2.547] --> M400
[   2.547] <-- echo:Unknown command: "M400"
[   2.557]  !! M400 does not wait on this firmware: a 300 ms dwell came back in 11 ms.
[   6.933] --> G1 X-5.00 Y5.00 F6000
[   7.201] --> G1 X-5.00 Y5.00 F6000      <- 268 ms apart, one move at a time
```

If those gaps are milliseconds rather than the chunk time the page quotes,
something is sending faster than the pacing allows — that is the bug, and the
trace is what identifies it.

### One long move

A single `G1 X-2000 Y2000`, cancelled with `M410` when the key comes up. It is
smoother and stops instantly — **but only** if the firmware reports
`Cap:EMERGENCY_PARSER:1`, which is what lets `M410` be read straight off the
serial port instead of queueing behind the very move it is meant to abort. The
page checks for that on connect and puts a warning up if it is missing.

### Stopping

There is **one** stop, and letting go of a key is it: stop feeding chunks, drop
anything queued but not yet sent, let the one move already on the board finish.
**Space** and the **STOP** button do exactly the same thing — they just drop
every key at once and skip the 25 ms that coalesces near-simultaneous presses
into a diagonal.

The stopping distance is one chunk, and the page quotes it.

**There is no quickstop.** `M410` is not in this codebase, and a check in
`test_marlin.mjs` fails if it comes back. It aborts a move mid-flight and
leaves Marlin's idea of the position wrong until the next `M114`; on firmware
without the emergency parser it is not even prompt, because it waits its turn
behind the very move it is cancelling. Firing one on every key release — which
is what this did at first — is a good way to end up power-cycling the board.
Saving one chunk of stopping distance was never worth that.

That decision removed a feature with it. A "hold for one very long move" mode
only works if something can cancel the move, so it is gone: `mode` and `span`
are ignored, and every hold is a stream.

`M112` is still on the page, and it is not a stop button. It halts the board
outright, loses the position, and needs a reset or a reconnect. It is there for
the moment when the machine is doing something that must stop before it
finishes the current move.

---

## Everything else on the page

* **Position** — X and Y in mm and in motor revolutions. `G92` to re-zero,
  `G28` to home. Homing warns first: without a working endstop the motor grinds
  against the frame until Marlin gives up.
* **Jog buttons** — ±0.1 / 1 / 10 / 50 mm single moves. Arrow keys do the same
  thing at the current chunk size.
* **Driver & motion settings** — read from the board with `M503`, not guessed:
  feed rate (`M203`), acceleration (`M201`, `M204`), jerk (`M205`), steps/mm
  (`M92`), microsteps (`M350`) and motor current (`M906`). Each is clamped
  before it is sent — 5000 mA is refused in the server, not on the motor. A
  setting the firmware answers *"Unknown command"* to is greyed out with an
  explanation: the drivers are in standalone mode and that value is set by a
  trimpot, not by G-code.
* **EEPROM** — `M500` save, `M501` load, `M502` factory reset. A reset is not
  saved until you press save.
* **Serial console** — every line in and out, plus a box to type G-code into.

---

## Running it

```
node server.js                      find the printer, open it, serve the page
node server.js --marlin             the same thing, said out loud
node server.js --port /dev/ttyUSB0  say which port (implies --marlin)
node server.js --baud 250000        boards flashed for 250000
node server.js --no-connect         serve the page, leave the port alone
node server.js --http 8090          web port (this is the default)
node server.js --host 127.0.0.1     this machine only
node server.js --list               list serial ports and exit
```

It binds **every interface** by default, so a phone on the same wifi can drive
the machine. There is **no authentication**, and it says so on startup.

### If the port will not open

`Permission denied` on `/dev/ttyUSB0` means the account is not in the serial
group:

```
sudo usermod -aG dialout $USER      # then log out and back in
```

If it opened **the wrong port**, `--port` settles it. Autodetect prefers a
device that identifies itself as a USB-UART bridge (the Creality board's CH340
reports as QinHeng), then any `/dev/ttyUSB*` or `/dev/ttyACM*`, and it will not
open anything less likely than that on its own — `/dev/ttyS0` sorts first
alphabetically but is the GPIO mini-UART on a Pi and an 8250 placeholder on a
PC, so "the first serial port" is the wrong answer on both. `--list` shows what
it can see.

`Port opened, but the board sent no boot banner` in the log means the opposite
problem: the cable is fine and the CH340 enumerated, but nothing answered. The
CH340 is powered from USB and appears whether or not the **mainboard** has
power. Switch the printer on.

### `No reply from the board`

The port opened and then nothing came back. In order of likelihood:

1. **The mainboard is not powered.** The USB-serial adapter is powered by the
   cable, so it appears in `--list` whether or not the printer is switched on.
   This is the common one, and it is why the message says so.
2. **The baud rate.** Stock Marlin on a Creality board is 115200, but plenty of
   builds are flashed for 250000. `--baud 250000`.
3. **No bytes are crossing the USB link at all.** Check for this before
   assuming either of the above:

   ```
   sudo dmesg | grep -E 'ch341|control message'
   ```

   `failed to send control message: -110` means the adapter enumerated but is
   not answering USB control transfers. The port may still *open* — the CH340
   driver tolerates a failed baud-rate setup — and then sit silent forever,
   which looks exactly like an unpowered printer but is not. Causes, in order:

   * a hub, or a charge-only cable. Use a data cable, into the machine.
   * **a virtual machine.** If this is a VMware/VirtualBox guest, USB
     passthrough is the first suspect: disconnect and reconnect the device from
     the host, and set the VM's USB controller to 2.0 or 3.1 — `lsusb -t` will
     show `12M` if it is being handed through a virtual USB 1.1 controller.
     Re-binding the driver inside the guest is not enough; the break is at the
     hypervisor boundary.
   * on Linux, `brltty` claims CH340 adapters as braille displays:
     `sudo systemctl mask brltty`.

`ModemManager` is a milder version of the same problem: it opens new serial
devices and talks AT at them for about 20 seconds after they appear, which can
swallow the boot banner. To keep it off the printer:

```
# /etc/udev/rules.d/99-marlin.rules
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ENV{ID_MM_DEVICE_IGNORE}="1"
```

### Starting it with the Pi

```ini
# /etc/systemd/system/gantry.service
[Unit]
Description=Rover control
After=network.target

[Service]
ExecStart=/usr/bin/node /home/pi/gantry/server.js
WorkingDirectory=/home/pi/gantry
User=pi
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl enable --now gantry
```

---

## Safety

* **`M112`** is on the page. It halts the board outright; it has to be reset or
  reconnected afterwards. That is the point of it, and it is the only thing
  here that stops the machine before the move in progress finishes.
* Ctrl-C stops the stream and waits for the outstanding move before closing the
  port, so the server never exits leaving the gantry running.
* Soft endstops start **on**. Turning them off is how you move an unhomed
  machine, and also how you drive it into its own frame.
* Motor current above ~900 mA gets a warning on the page. A NEMA17 run there
  without airflow gets hot enough to skip, and eventually to demagnetise. Stock
  Ender-3 X/Y is around 580 mA.
* Losing the browser window with a key held does **not** leave the motors
  running: the page halts on `blur`.

---

## Following a line

The camera half is back from git, unchanged: the same detector, the same
tuning, the same run logs. What changed underneath is the actuator.

| page | what it is |
|------|------------|
| `/vision` | camera → line detection, with every threshold exposed. Sends nothing to the motors. This is where you tune the detector against your actual road and lighting. |
| `/follow` | the same detector, driving. Records the run to `logs/`. |
| `/tune` | reads a run back and says which number to change. |

`/vision` has no socket at all — it is the detector plus `/api/wheels` over
HTTP — which is why it survived the ESP32 going away completely unchanged.

### The translation

`/follow` was written against a board that took two analog throttle levels, so
what it sends is a 20 Hz stream of per-wheel demand in percent. Stepper drivers
take G-code, which is a position language, not a throttle one. `rover.js` is the
translation and is deliberately the only place that knows both:

```
/follow ──{cmd:"follow", p25, p26}──> setAuto() ──> Jogger.startWheels()
 20 Hz        percent per wheel        mm per chunk      G1 X… Y…
```

The two rates are not the same and are not meant to be. Demand arrives every
50 ms; a chunk takes 250–300 ms to run and the next is not sent until it has
finished. Each chunk uses the newest demand, which is what you want from a
control loop — but it does mean **steering updates at roughly 3–4 Hz**, so at
50 mm/s the rover commits to a heading for about 15 mm at a time. That is the
ceiling on how fast it can follow a line, and it is set by the chunk model, not
by the camera.

### What did not survive the move

* **Volts.** There is no analog level any more, so `/follow`'s voltage readouts
  are vestigial and fall back to placeholder numbers.
* **The dead band.** `stall` in the wheel trim compensates for a brushed motor
  sitting still and humming below its stall voltage. A stepper has no such
  threshold — it turns at whatever rate it is told — so that calibration is a
  no-op here and can be left at its defaults.
* **The sonar.** `sonar.js` is restored because `/follow` loads it, but nothing
  is wired to an HC-SR04 now, so it reports no distance and the obstacle stop
  never triggers.

---

### The API

Everything under `/api/marlin/`. `GET status` and `GET log?since=N`; the rest
are `POST` with a JSON body.

```
POST run       {"dir":"forward"}                 named direction
               {"axes":{"X":-1,"Y":1}}           explicit vector (what WASD sends)
               {"axis":"X","direction":-1}       one axis (what a hold button sends)
               ...plus mode ("stream" | "continuous"), feedrate, step, span
POST halt      stop feeding, drop the queue, M410, re-read the position
POST jog       {"axis":"X","distance":10,"feedrate":1000}
POST gcode     {"cmd":"M114"}                    raw, one line or many
POST setting   {"code":"M906","params":{"X":580}}
POST home | zero | steppers | endstops | invert | refresh | eeprom | estop
POST connect | disconnect
```

A route that needs a board and does not have one answers **409**, so a client
can tell "not plugged in" apart from "you asked for something impossible"
(**400**). Nothing queues silently.

---

# Files

Everything in the first table is the ESP32's, everything in the second is the
printer's, and the third is what both machines run.

### The ESP32's

| File | What it is |
|---|---|
| `bench.js` | START/STOP state, percent → volts, the 30 cm brake, the route, where it is on the field — the one function that decides pin values |
| `transports.js` | `WsTransport` (wifi) and `SerialTransport` (USB) |
| `esp.js` | USB wire format — port of `rpi/esp.py` |
| `esp32ws_sim.js` | mirror of `ws_dac.ino`; powers `--fake` |
| `esp32sim.js` | mirror of `throttle_dac_2ch.ino` (USB path) |
| `camera.js` | the Pi's webcam: one ffmpeg, MJPEG out to viewers, a grey tap for QR |
| `qr.js` | reading QR codes off that tap, and counting them honestly |
| `rpi.js` | what the Pi is doing to itself: CPU, temperature, RAM, throttling |
| `public/home.html` | hub page |
| `public/manual.html` | manual page, self-contained |
| `public/drive.html` | keyboard drive page, self-contained |
| `public/pins.html` | every spare GPIO, 0-255 by hand |
| `public/setup.html` | the numbered checklist: measure, type, saved everywhere |
| `public/obstacle.html` | forward sonar: drive, stop, wait, carry on |
| `public/dashboard.html` | everything at once: speed, volts, ESP32 + Pi, camera, obstacle, QR, the field map and the next turn |
| `public/route.js` | dead reckoning: two wheel percentages → a path. Pure |
| `gpio.js` | the Pi's output pins: sysfs, pinctrl, or an honest "this machine has none" |
| `buzzer.js` | the reversing buzzer: the beep pattern and which pins it drives |
| `public/pins_pi.html` | /pins: the buzzer's settings and the pin notes |
| `public/field.js` | the competition and practice fields (ek şartname): the graph, the QR texts, localisation, the plan and the turns. Pure |
| `public/plc.js` | the PLC protocol (PAKET_TX / PAKET_RX) and the mission's durum 1–8. Pure |
| `public/plc.html` | /plc: the link, the packets byte by byte, the mission, the field map, the simulator |
| `plc_link.js` | the UDP socket to the PLC, on a fixed one-second clock |
| `plc_sim.js` | a stand-in PLC: the same protocol from the other side, in the server or on its own |
| `plc_run.js` | the mission wired into a server: holds the wheels, hears the QR reads |
| `public/lift.js` | the lift's two buttons and their dead-man, shared by /drive and /dashboard |
| `public/cam.js` | where a page gets its pictures from: the Pi, this browser, or a file |
| `esp32/ws_dac/` | the wifi firmware |
| `esp32/throttle_dac_2ch/` | the USB firmware |

### The printer's

| File | What it is |
|---|---|
| `marlin.js` | the serial link — `ok` flow control, the log, the settings table, the jogger that streams chunks, and `DIRECTIONS`, the one wheel-sign map |
| `marlin_http.js` | the JSON API: validation, clamps, and what each route sends |
| `rover.js` | percent-per-wheel → millimetres-per-chunk, the only place that knows both languages |
| `public/gcode.html` | drive by hand |
| `ender/` | two Python bring-up scripts and what they are for |

### Both

| File | What it is |
|---|---|
| `server.js` | HTTP + the browser WebSocket + the CLI, for both machines. `--marlin` splits at one `if`, near the top of `main()` |
| `lidar_relay.js` | the LiDAR relay on `/ws` — webscan's rooms, history replay and backpressure — and the upgrade routing that shares the port |
| `lidar_sim.js` | a simulated LiDAR in a made-up room; powers `--lidar-sim` |
| `lidar_discovery.js` | the mDNS announcement (`_webscan._tcp`) the phone app finds the rover by |
| `public/lidar.js` | SCN1 wire format, log-odds occupancy grid, motion gate. Pure |
| `public/lidarmap.js` | the relay viewer and the radar renderer, shared by /dashboard and /lidar |
| `public/lidar.html` | the LiDAR map full screen; `/viewer.html` too |
| `mobile/` | the iPhone LiDAR scanner app (React Native + Swift/ARKit), moved from webscan; `mobile/setup.sh` builds it on a Mac |
| `public/panel.html` | the 1920 × 1080 panel: every system and the drive controls on one screen |
| `shared.js` | loads the pages' pure modules into Node — see the note at its top |
| `follow_log.js` | writes `logs/follow-*.json` and its summary |
| `public/road.js` | the road detector, shared by `/vision` and `/follow` |
| `public/pilot.js` | the control law: error → two wheel percentages. Pure |
| `public/analyse.js` | reads a run log and says what to change. Pure |
| `public/sonar.js` | the obstacle state machine. Pure |
| `public/wheels.js` | the shared wheel trim + the ⓘ text, used by every page |
| `public/vision.html` | camera + road detection (qara/ağ yol), look and tune |
| `public/follow.html` | the same detector, driving, with the run recorder |
| `public/tune.html` | reads a run back: charts, manoeuvres, suggestions |
| `presets.json` | key table + master level + the two fixed speeds, written when you edit them (git-ignored) |
| `follow.json` | follow sliders + distance calibration (git-ignored) |
| `logs/` | one JSON file per run (git-ignored) |

---

# Test

```bash
npm test             # everything, both machines

# the ESP32
npm run test:bench   # server + firmware + follow path
npm run test:route   # dead reckoning — the map's arithmetic
npm run test:field   # the field graph, QR localisation, and the turns it hands out
npm run test:camera  # JPEG framing, QR counting, and the Pi's own numbers
npm run test:lidar   # SCN1 against webscan's golden bytes, the grid, the relay on both machines

# the printer
npm run test:marlin  # the direction table, the jogger's pacing, the HTTP surface
npm run test:serial  # the whole stack against a fake Marlin on a real pty

# both
npm run test:globals # no two scripts on a page declare the same name — 1 s
npm run test:pilot   # the control law, on its own
npm run test:wheels  # the shared wheel trim, and that every page agrees on it
npm run test:analyse # what /tune concludes from a log
npm run test:sonar   # the obstacle state machine and the map
npm run test:vision  # vision page only (needs playwright)
npm run test:pages   # every page opens without throwing, on both (needs playwright)
```

`test:serial` needs `python3` and the two browser suites need playwright; each
skips itself with a note if what it needs is missing, so `npm test` is still
worth running without them.

| Suite | What it covers |
|---|---|
| `test/test_globals.mjs` | no duplicate top-level names on any page, 24 checks |
| `test/test_bench.mjs` | server + firmware + gears + follow + sonar + the 30 cm brake, 294 checks |
| `test/test_marlin.mjs` | the direction table asserted against the literal G-code, the jogger's pacing, what `run` accepts and rejects, and the whole HTTP surface against a real server with no printer attached |
| `test/test_serial.mjs` | the whole stack against a Marlin board on a real serial device — see below |
| `test/test_pilot.mjs` | the control law and the speed loop, 85 checks, no browser |
| `test/test_wheels.mjs` | the shared trim, 55 checks — incl. /manual vs /follow agreement |
| `test/test_analyse.mjs` | the log analysis, 54 checks, no browser |
| `test/test_sonar.mjs` | the sonar logic, 29 checks, no browser |
| `test/test_route.mjs` | dead reckoning, 43 checks, no browser |
| `test/test_field.mjs` | the field graph against the ek şartname, the QR texts, localisation and the turns, 131 checks, no browser |
| `test/test_buzzer.mjs` | the beep pattern, which pins go high, what counts as reversing, and the server refusing a pin nobody wrote down — 37 checks |
| `test/test_plc.mjs` | PAKET_TX / PAKET_RX byte for byte, a full lap through the real field with the door both ways, the link against the simulator over UDP, and both servers holding their wheels — 99 checks |
| `test/test_camera.mjs` | JPEG framing, a real QR decode, the Pi stats — 45 checks |
| `test/test_lidar.mjs` | the SCN1 encoder byte-for-byte against the vector webscan's Swift test pins, the grid and motion gate, the simulator's map against its true walls, the relay end to end on both machines, ARKit's tracking flags, and the mDNS announcement appearing and withdrawing — 94 checks |
| `test/test_vision.mjs` | vision suite, 28 checks — real browser, synthetic tracks |
| `test/test_pages.mjs` | every page of both machines opens clean, and the printer's keyboard drive asserted on the requests that left the browser — real browser, two servers |

`test_serial.mjs` is worth its own paragraph: `fake_marlin.py` opens a pty and
answers like a stock Creality board, acknowledging a move when it is *buffered*
and withholding the `ok` once its planner is full. Every assertion in it is a
bug that happened on hardware — a held key that produced one move and then
nothing, an `M410` on every release, and an `ok` that authorised the wrong
write. It runs the whole streaming check **twice**, against a board that
honours `M400` and one whose `M400` is a lie (`M400_BLOCKS=0`), because
everything passes on the first and none of it held on the second.

---

# History

This was two projects. The ESP32 DAC bench drives the robot through analog
throttle signals; `ender-x` was a separate Python tool for a Creality printer
mainboard. The printer half was ported into this server — `ender-x/server.py`
became `marlin.js` + `marlin_http.js`, and its `index.html` became
`public/gcode.html`.

For one commit the printer half *replaced* the ESP32 half, on the reasoning
that the Pi could talk to the mainboard directly over USB and the DACs were no
longer needed. They are both here now, behind one flag, because the road-
following work — the detector, the control law, `/tune`, the run logs — was
never about either board, and keeping one copy of it running on both is worth
more than picking a winner early.
