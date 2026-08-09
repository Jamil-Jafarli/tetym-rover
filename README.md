# ESP32 DAC Bench — Node.js

A web interface for driving the ESP32's two DACs. You type a **percentage**
for each channel, press **START**, and they stream to the board over wifi until
you press **STOP**.

```
GPIO25 (DAC1) → controller throttle signal wire     analog
GPIO26 (DAC2) → controller throttle signal wire     analog
GPIO23        → driver enable / brake release       digital: 0 at rest, 1 on START
GPIO19        → GPIO25 wheel's direction relay       digital: 1 forward, 0 back
GPIO18        → GPIO26 wheel's direction relay       digital: 1 forward, 0 back
GPIO13        → scan servo signal (continuous rotation)   50 Hz PWM
GPIO27 / 33   → scan HC-SR04       TRIG / ECHO
GPIO14 / 32   → forward HC-SR04    TRIG / ECHO
GND           → controller GND        (required, common ground)
```

**0 %** is idle — 1.00 V, which the controller reads as zero throttle.
**100 %** is whatever ceiling you started the server with (`--v-max`).
So `--v-max 1.8` means 100 % = 1.8 V, and every percentage in between is
linear. Raise the ceiling as you gain confidence; the UI never changes.

**GPIO23** is a plain digital output. It sits at **0** and goes to **1** the
moment you press START — and back to 0 on STOP, on a closed tab, on a link
timeout, and on boot. Wire it to whatever your driver needs held high to run.

```
browser ⇄ Node (this) ⇄ wifi WebSocket ⇄ ESP32 ⇄ GPIO25 / GPIO26
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

Five pages, one WebSocket, one port:

| | |
|---|---|
| **/** | hub — live status and links to everything |
| **/drive** | hold **W / A / S / D** to drive |
| **/vision** | camera; finds the road and shows the steering error |
| **/follow** | the same detector, driving the motors, recording the run |
| **/tune** | read a run back: charts, manoeuvres, and what to change |
| **/obstacle** | the forward HC-SR04: drive, stop, wait, carry on |
| **/sonar** | the spinning HC-SR04, as a map of the room |
| **/manual** | type the two percentages by hand |

There is nothing to configure in the browser.

No board yet? `npm run fake` runs a simulated ESP32 and the full UI.

| Flag | Default | What it does |
|---|---|---|
| `--esp <host>` | — | board over wifi: IP, hostname, or full `ws://` URL (port 81) |
| `--serial <path>` | — | board over USB instead (`COM5`, `/dev/ttyUSB0`) |
| `--fake` | off | simulated board, nothing is driven |
| `--http <n>` | `8090` | web port |
| `--host <addr>` | `0.0.0.0` | bind address — every interface by default |
| `--https` | off | serve over TLS, so the camera works from other devices |
| `--cert <file>` | — | use your own certificate instead (implies `--https`) |
| `--key <file>` | — | ...and its private key |
| `--v-max <v>` | `3.3` | what 100 % means, in volts |
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

**But the camera will not work over plain http.** Browsers only hand
`getUserMedia` to `localhost` or to HTTPS, so `/vision` and `/follow` open fine
from a phone and then sit there with a black rectangle. That is not a networking
problem and no amount of opening ports fixes it.

```bash
node server.js --esp 192.168.4.1 --https
```

The first run makes a self-signed certificate in `node/certs/` — named for every
address the machine has, so the browser does not also complain about the
hostname — and reuses it afterwards. The browser will warn once that it is not
trusted, which is correct: it is not. Accept it and the camera works. `--cert`
and `--key` take your own certificate if you have a real one.

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

### Master level

Above the readout is a **master level**: a percentage with a slider, a number
box, quick 25/50/75/100 chips and a progress bar. Everything on its way out is
multiplied by it, on both pages.

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

Point a camera at the track and it finds the road live, in the browser — no
model, no training, no GPU. It **sends nothing to the motors**; this page is
for looking and tuning. `/follow` is the same detector with the wheels
attached, so everything below applies there too.

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

Camera access needs `localhost` or HTTPS, so opening this page from another
machine over plain `http://` gets no camera — the page says so and offers a
file picker instead, which works everywhere and is the easy way to test a
recording of the track.

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

- **`stopCm` and `clearCm` are different numbers** (25 and 35 by default).
  Everything between them changes nothing, so a robot parked at 30 cm cannot
  buzz between stopped and going.
- **Three readings in a row**, not one. A single 12 cm in the middle of a
  corridor is noise; three is a wall.

The thresholds are saved to `follow.json` and **`/follow` obeys the same ones** —
tune here, drive there. While the robot is stopped for an obstacle the
lost-the-road timer is held off, or it would give up and drop ENABLE while
waiting for someone to walk past.

### `/sonar` — the 360° map

The other sensor rides a **continuous-rotation** servo. That means nothing
measures the angle: it is inferred from time, and the whole map is only as good
as one number — how long a full turn takes.

**Calibrate it once.** Mark the sensor, spin it, time ten turns, divide. Get it
wrong and the map does not fail, it *slides*: walls come out as spirals. Until
that number exists the page will not draw anything, because a map with an
invented angle is worse than no map.

The board stamps each echo with the milliseconds of rotation behind it, so the
angle survives a late browser frame — the map is built from the board's clock,
not from when the tab happened to wake up. Stopping the servo banks the elapsed
time instead of zeroing it, so pausing does not silently rotate everything.

Readings are binned by angle, and each bin keeps the **nearest** hit rather than
the mean: a mean across a doorway averages the frame with the room beyond and
invents a wall halfway between, while the nearest is at least something that was
really there. Bins with no answer are drawn as absent, not as zero.

Bins are 6° and the sensor's beam is about **15°**, so neighbouring bins are not
independent. Good for looking at; not good for calling two bins two objects.

`{"cmd":"scan","spin":60}` is its own message rather than a field on `set`,
because scanning is not movement: a board mapping a room must not look to the
300 ms drive watchdog like one that is being driven, and a page that only wants
to scan should not have to pretend to be a driver.

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

// follow page
{"cmd": "follow",     "p25": 30, "p26": 24, "reason": "döngə"}  // ~20 Hz
{"cmd": "follow_cfg", "cfg": {"pilot": {…}, "vision": {…}, "calib": {…}}}
{"cmd": "log_start",  "meta": {"note": "…", "pilot": {…}}}
{"cmd": "log",        "rows": [ … ]}            // batched at ~2 Hz
{"cmd": "log_stop"}
```

The runs are also readable over plain HTTP, which is how `/tune` offers you the
lap you just drove instead of a file dialog: `GET /logs` lists them and
`GET /logs/<name>` returns one. Read-only, and the name is matched against
`follow-<word>.json` rather than joined into a path — this server has no
authentication and sits on a shared wifi.

`follow` is held to the same dead-man as `keys`: 400 ms of silence and the
throttle is zero, `reason` becomes `kadr gəlmir`, and ENABLE stays up so a
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
  "set":   [60, 25],          // percent you typed, before the level
  "out":   [60, 25],          // percent actually streaming, after the level
  "out_v": [1.96, 1.4],       // ... in volts
  "esp": {                    // read back from the board
    "vL": 1.96, "vR": 1.4,    // what the pins are at
    "pL": 60,   "pR": 25,     // the same, as percent
    "en": true, "en_pin": 23, // the digital enable pin
    "rev": [false,false], "rev_pin": [19,18],         // direction relays
    "rev_wait": false, "dir": "forward",
    "pkt": 482, "bad": 0, "rssi": -52, "uptime": 91234
  },
  "esp_fresh": true, "vmax": 3.3, "idle_v": 1.0, "serial_error": null
}
```

`reason` says why the output is what it is: `running`, `key w`,
`follow: döngə`, `BACK`, `PIVOT A`, `back…` (settling), `no keys held`,
`kadr gəlmir`, `level 0 %`, `stopped`, `no browser connected`,
`esp32 unreachable`. The drive page also
gets back `keys`, `combo` (the row that matched) and the full `presets` table.

**This server ⇄ ESP32** — `ws://<esp-ip>:81/`, the board's own protocol. The
board speaks **volts**, not percent: it does not know your ceiling, and volts
are what the motor controller physically reads. The percent conversion lives in
`bench.js`, in one place.

```jsonc
{"cmd": "set",  "v25": 1.80, "v26": 1.50, "en": true, "r25": false, "r26": false}
{"cmd": "scan", "spin": 60}      // the sonar servo, -100..100; 0 stops it
{"cmd": "stop"}
{"cmd": "ping"}
```

The status carries the sonar back:

```jsonc
"son": {
  "fwd_cm": 42.1,        // null when no echo came back — never 0
  "scan_cm": 130.5,
  "scan_t": 3169,        // ms of rotation behind that echo, not wall-clock time
  "spin": 60,
  "pin": {"servo":13,"trig_s":27,"echo_s":33,"trig_f":14,"echo_f":32}
}
```

`en` is the digital pin. **Leaving it out means 0** — a client that never
mentions it can never leave the driver enabled. `r25` / `r26` behave the same
way for the two direction relays.

### Direction

The controllers have no reverse input, so direction is changed by crossing two
motor phases and the matching two hall lines with relays — one set per wheel,
driven by `GPIO19` and `GPIO18`.

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
then moves. The drive page shows `FORWARD` / `STOPPING…` / `PIVOT` / `BACK` so
the pause is never a mystery. Relays de-energise to *forward*, so a dead ESP32,
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
`/drive` that is the held-key set, for `/follow` it is the frame the pilot just
acted on. Both coast to 0 % without waiting to be told, which is what covers a
wedged tab, a lost focus, and a camera that stops delivering frames.

Every value is clamped to `[0, 100] %` here and to `[V_MIN, V_MAX]` again on
the board. Nothing can command below idle: 1.0 V is what the controller reads
as zero throttle, and 0 V is never output.

First powered run: **wheels off the ground.** Confirm START raises the voltage
and takes GPIO23 to 1, and that STOP drops both DACs to 1.00 V and GPIO23 to 0,
before you put it on the floor.

## Test

```bash
npm test             # all five suites
npm run test:bench   # server + firmware + follow path
npm run test:pilot   # the control law, on its own
npm run test:analyse # what /tune concludes from a log
npm run test:sonar   # the obstacle state machine and the map
npm run test:vision  # vision page only (needs playwright)
```

**196 checks** for the control path, no hardware. It runs `esp32ws_sim.js` — a behavioural mirror of
`ws_dac.ino`, including the watchdog, the idle-when-no-clients rule and the direction
interlock — as a
real WebSocket server, then drives the real `server.js` against it over a real
browser WebSocket and verifies what landed on the simulated pins — including a
full drive-page session: every key and combination, live preset edits, and the
400 ms dead-man.

**54 checks** for the sonar. `obstacleStep` and the map are pure functions, so
the sensor can be made to misbehave in exactly the ways a real HC-SR04 does: a
single stray reading that must not stop the robot, three in a row that must,
a target parked between the two thresholds, someone stepping half out of the way
during the wait, and — the one that matters — the echo dying while stopped in
front of something soft, which must not read as "the way is clear". Plus the
angle arithmetic, including wrapping past 360°, and that an uncalibrated spin
produces no map at all.

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
| `bench.js` | START/STOP state, percent → volts, the one function that decides pin values |
| `transports.js` | `WsTransport` (wifi) and `SerialTransport` (USB) |
| `esp.js` | USB wire format — port of `rpi/esp.py` |
| `esp32ws_sim.js` | mirror of `ws_dac.ino`; powers `--fake` |
| `esp32sim.js` | mirror of `throttle_dac_2ch.ino` (USB path) |
| `public/home.html` | hub page |
| `public/manual.html` | manual page, self-contained |
| `public/road.js` | the road detector, shared by `/vision` and `/follow` |
| `public/pilot.js` | the control law: error → two wheel percentages. Pure |
| `public/analyse.js` | reads a run log and says what to change. Pure |
| `public/sonar.js` | the obstacle state machine and the 360° map. Pure |
| `public/vision.html` | camera + road detection (qara/ağ yol), look and tune |
| `public/follow.html` | the same detector, driving, with the run recorder |
| `public/tune.html` | reads a run back: charts, manoeuvres, suggestions |
| `public/obstacle.html` | forward sonar: drive, stop, wait, carry on |
| `public/sonar.html` | the spinning sonar, as a polar map |
| `public/drive.html` | keyboard drive page, self-contained |
| `follow_log.js` | writes `logs/follow-*.json` and its summary |
| `presets.json` | key table + master level, written when you edit them (git-ignored) |
| `follow.json` | follow sliders + distance calibration (git-ignored) |
| `logs/` | one JSON file per run (git-ignored) |
| `test/test_bench.mjs` | server + firmware + follow + sonar suite, 196 checks |
| `test/test_pilot.mjs` | the control law, 60 checks, no browser |
| `test/test_analyse.mjs` | the log analysis, 54 checks, no browser |
| `test/test_sonar.mjs` | the sonar logic, 54 checks, no browser |
| `test/test_vision.mjs` | vision suite, 28 checks — real browser, synthetic tracks |

## USB instead of wifi

The USB path from earlier still works — flash
`esp32/throttle_dac_2ch/throttle_dac_2ch.ino` and run
`node server.js --serial COM5`. Same UI, same percent commands; the binary
frame format is documented in `esp.js`. Use it when wifi latency or dropouts
matter more than the convenience of no cable.

One gap: **the USB firmware has no enable pin.** `throttle_dac_2ch.ino` drives
the two DACs only, so `en` is accepted and ignored on that path. If you need
GPIO23, use the wifi board.
