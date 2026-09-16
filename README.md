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
| `--cam-size <WxH>` | `1920x1080` | capture size — 1080p because the 50 mm QR code needs it; the pages cut the old 4:3 view back out |
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

### The competition line — blue │ orange │ blue

**This is the track the rules describe, and the only one that will be on the
floor at the event.** `2026_SRU_EK_TEKNİK_SARTNAME` draws it as three **equal**
stripes — blue, orange, blue — and the drawing's own vector fills give the
colours exactly: `rgb(52,101,164)` and `rgb(255,128,0)`, which as hue angles
are **214°** and **30°**. The total width is *not dimensioned anywhere in the
document*; scaling Şekil 6 off its 2700 mm gives ~100 mm and Şekil 5 off its
1000 mm box gives ~140 mm, so the drawings disagree and it has to be measured
on the day. Nothing here depends on the absolute width — only on the three
stripes being equal, which both drawings agree on.

**The line is found by its BLUE stripes, and its centre is the gap between
them.** That is the opposite of the obvious way round, and it is the whole
design:

> The rules print a **50 mm QR code on the line** at the end of every stub — and
> 50 mm covers most of a stripe that is itself about 50 mm wide. Hunt for the
> orange middle and the line disappears at exactly the place the robot most
> needs it: the end it is driving to, where the QR it came to read is. The blue
> stripes are not interrupted by anything. So the detector looks for the
> **pair**, takes the middle, and treats the orange in between as
> *confirmation* rather than as the test.

**A real QR is worse than a white square one stripe wide**, and the rover found
out on the floor: the code's paper, with its white quiet zone, is wider than
the orange and eats into both blues, and next to a sheet of white the camera's
exposure drops and the blue beside it goes pale enough to lose its colour. With
the code under the wheels the bottom band found nothing and the whole line
vanished; with it further up, the chain broke there and read as the *end* of the
line. So a band that looks like a QR code — bright paper *and* black print
within a stripe's width (`qrLike()` in `road.js`), and only such a band — gets
two allowances: the gap between the blues may be up to 4× their width
(`QR_GAP_HI`) as long as the pair is as wide as the line below it, and if it
still finds nothing it is stepped over, up to three bands (`QR_SKIP`), and the
chain carries on above it. Neither invents a line: a code on bare floor has no
blue beside it, and a stub that ends at its code still ends there. There are
tests for a code 1.3× and 1.6× the stripe wide, with washed-out blue, under the
wheels and off-centre.

A candidate is accepted when the gap between two blue stripes is about as wide
as they are (equal thirds — the ratio may sit between 0.45 and 2.2, generous
because the camera looks along the line at an angle) and the two blue stripes
are within 2.5× of each other. A blue chair, an orange crate, two blue boxes at
the wrong spacing and the station's own yellow tape each have *one half* of the
signature and are each rejected — there are tests for all four.

Hue, not RGB, because hue is the part of a colour that survives the room: a
dimmer bulb, a shadow and a camera's auto-exposure move brightness and
saturation a long way and leave hue very nearly alone. `Renk gücü` is the guard
that makes that safe — near grey the hue angle is the ratio of two small noisy
numbers and will report any hue at all, so a pixel must have real colour in it
before its hue is read.

### Where the paint stops

**On this track the line is not continuous.** It exists only inside the station
areas — 3.4 m at the start, 2.7 m at each pickup and drop-off — with a QR code
at its end and nothing at all painted in between. Şekil 1 and Şekil 3 draw
those connecting stretches dashed: that is the route, not paint.

So a chain that dies part way up a frame whose colours are otherwise perfect is
not a failure — it is the robot **arriving**. `/vision` and `/follow` draw it as
**ÇİZGİ SONU** across the picture and report how far down the frame it sits (0
at the top of the ROI, 1 at the wheels), and the run log records it as `end`.
It takes two consecutive frames to be believed, because one band dropping out
of the chain is also what a dropped frame and a shadow across the far end look
like.

Reported only when the chain both starts and stops inside the frame. A chain
that runs off the top has not ended, it has left the picture — and a robot that
stopped for that would stop in the middle of the line.

### Track type — decided automatically

| Button | The track | What it looks for |
|---|---|---|
| **Avto** (default) | works it out per frame | see below |
| **Yarışma çizgisi** | the competition line | **orange between two blue stripes of matching width** — see above |
| **Qara yol** | black road, white edge lines | the **dark corridor with a real bright edge on either side** |
| **Ağ yol** | white road on a dark floor | the **bright strip with a real dark edge on either side** |

**Avto asks for the competition line first, and takes it outright when it is
there.** That is not favouritism — it is that the question has a definite
answer. Two blue stripes with orange between them at the right proportions is
not something a workshop floor produces by accident, so there is nothing to
weigh it against: either the line is in shot or it is not. Only when it is not
do the two monochrome readings below have to argue about which of two guesses
is less wrong. A mode that has locked onto `line` and then driven off the paint
falls back to whichever monochrome reading the frame supports, because the
stretches between stations have no line in them at all.

Neither reading hunts for a colour, because a colour is not what tells a line
apart from a wall, a shadow or an unlit corner of the room. What tells them
apart is the **edge**: see *A line, not a dark patch* below. A corridor with a
real edge on **both** sides beats one with an edge on only a single side, so
the two sides have to agree before a corridor is accepted at all.

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

### A line, not a dark patch

The detector used to decide what was road by brightness alone: one threshold
for the whole frame, from Otsu, and everything on the road side of it was road.
That fails in the one place it most needs not to. **Otsu always returns a
split** — hand it a dim, featureless corner of a room and it will dutifully
carve the sensor noise in two, at which point half the room is "road" and the
robot drives into it, confidently, with eight bands of chain to prove it. No
amount of `Kontrast` fixes that, because there is nothing in the picture for
contrast to strengthen.

So the question the scan asks is no longer *how dark is this pixel* but *is
this thing bounded like a line*:

- **Each band thresholds itself.** A band builds a brightness profile — one
  average per column, down its own height — and splits it at the midpoint of
  its own darkest and brightest column. A frame-wide threshold has to be right
  for the lit half of the picture and the shadowed half at once; a per-band one
  only has to be right for that band. A line running through a shadow keeps
  being found, because it is still darker than the floor immediately beside it.
- **A border has to be a step.** A run is only a candidate if the profile jumps
  at least **`Kenar keskinliği`** levels across a handful of columns at its
  edge, in the direction the mode expects — brighter outside a dark road,
  brighter inside a white one. A dark *region* has no such step at its border;
  a dark *line* does. This is the whole difference, and it is measured, not
  assumed.
- **A run with no real border at all is dropped**, however wide and however
  convincing. Touching the frame edge is not evidence: a road leaving the view
  around a corner has one real border and one frame edge, which is why one is
  enough — but a run whose only "borders" are the two sides of the frame *is*
  the frame, i.e. the failure this gate exists for.
- **A band with less contrast than `Kenar keskinliği` reports nothing.** There
  is no line in it, whatever a threshold would be willing to invent. The page
  prints the number the band in front of the wheels actually measured, next to
  the bar it has to clear, so "there is no line here" and "the line is there
  but the bar is too high" stop looking the same from the outside.

Two older details still do heavy lifting:

- **Colour still gates the brightness range.** A bright yellow board in frame
  otherwise sets the band's range and drags its split with it. Columns that
  fail the saturation test are left out of the range, so coloured objects
  cannot move the threshold — the same reason the frame histogram is gated.
- **A run wider than 88 % of the band's own strip is rejected.** A real road
  never fills the whole strip a band is allowed to look at, so if it does, the
  threshold has failed. Measuring against the band's own span rather than the
  frame matters: the trapezoid gate narrows the upper bands, and a run filling
  one of those is just as much a failure, at only ~80 % of the frame's width.

Otsu is still computed per frame, but only for the **Avto** decision above —
"how much of the view is white" is a question about the whole picture, and that
is the one thing a frame-wide threshold is right for.

### The 90° corner

A bend is the road moving sideways band by band. A right angle is not that: the
road **ends**, and another one leaves from its side. Nothing in the chain above
can express it — the chain climbs, and there is nothing above the corner to
climb into — so at a corner the detector's honest report was "the road stopped",
a couple of frames before the robot got there.

In the picture a corner is an **L**, and that is what is now looked for. In
each band, a run that

- **contains the road below it** — same connected thing, not a separate blob;
- **sticks out to one side** by more than the road's own width (`Köşe kolu`
  × the width of the run below, plus the minimum width)

is the corner's **arm**, and the side it lies on is the way the road goes. The
asymmetry is the whole test: a road that widens *evenly* — perspective, a start
pad, a threshold that slipped a level — grows on both sides at once and is
never an L, however wide it gets. Two consecutive frames have to agree before
it is reported at all.

Three details make it work at the moment it matters, i.e. when the corner is
directly under the robot rather than politely in the distance:

- **The nearest corner wins.** Bands are scanned bottom-up and the first L
  found is the one reported — the one about to arrive under the wheels. A
  second one further up the picture is next lap's problem.
- **A run that fills the band is kept as evidence.** It is still refused as
  something to *follow* (see the 88 % rule above), but an arm arriving at the
  wheels genuinely does fill the bottom band, and throwing it away at birth is
  what made the corner vanish exactly when it was needed.
- **The lock is held while the arm is under the wheels.** The temporal lock
  normally follows the bottom band's road; at a corner that road *is* the arm,
  so the lock slides onto the arm's middle — and an arm measured from its own
  middle is not lopsided about anything. So while the arm is at the wheels the
  mark is held where it was, and held without ageing, because the road has not
  been lost: it is right there, turning.

The page draws the corner as a dashed line at the band it was found in, with an
arrow pointing the way the road goes, and prints it next to the band count
(`SAĞA · 78 %` — right, 78 % of the way down the frame). What the robot does
about it is `/follow`'s business, below.

### Sliders

| | Default | |
|---|---|---|
| ROI | 45 % | how much of the top of the frame to throw away |
| Eşik düzəlişi | 0 | nudge each band's split up or down |
| Kontrast | 0 | S-curve around mid-grey. It stretches the edge steps too, so a faint-but-real edge can be lifted over the bar with it — at the price of stretching the noise by the same factor |
| **Kenar keskinliği** | 18 | how many brightness levels a border must jump to count as a line's edge. **The one to raise when scenery is being followed as though it were the road, and to lower when a real but faint line is being missed.** 0 turns the requirement off and hands the frame back to bare thresholding |
| Rəng toleransı | 60 | how colourless a pixel must be to count as white |
| Minimum en | 6 % | narrower than this is a glint, not a road |
| Zolaq sayı | 8 | horizontal bands |
| **Yan kəsim** | 18 % | the trapezoid gate — raise it if roadside clutter still gets in |
| **Davamlılıq** | 14 % | max lateral jump between bands — lower it on a straight track, raise it on tight curves |
| **Köşe kolu** | 0.80 | how far past one side of the road a band's run must reach before it counts as a 90° corner's arm, in multiples of the road's own width. Lower it if corners are being missed, raise it if a wide start pad or a join in the tape is being called a corner |
| **Renk gücü** | 45 | *competition line only.* How much colour a pixel must have before its hue is read at all. Raise it if the floor is being read as blue; lower it in poor light, where the tape itself goes grey |
| **Renk toleransı** | 32° | *competition line only.* How far off the nominal 214° blue and 30° orange a hue may sit. A warm bulb pulls both toward red, a cool one toward yellow |
| **Sütun doluluğu** | 50 % | *competition line only.* How much of a column has to be one colour for the column to count as that stripe. Counting down the column is the noise filter — one fleck of dirt moves a column by a row out of forty |

**Maska** shows what the scan classified — drawn by `road.js` from the same
per-band splits the scan used, not by the page from a rule of its own, because
a mask that disagrees with the detector sends you off tuning the wrong slider.
Green is always "what the detector currently thinks the road is"; the dimmed
areas are the ones no band looked at, above the ROI or outside the trapezoid
gate. On the **competition line** green is the orange middle — the part the
robot steers by — and the blue stripes are painted blue, because *which* of the
two went missing is the whole diagnostic: one gone is a camera aimed off the
line, both gone is a colour bar set too high for the light.

On the real track: run it once with **Maska** on and check the road comes out
solid green with its edges where you expect them. If the green bleeds out over
the whole strip, raise `Kenar keskinliği`; if the road is not green at all,
read the measured edge difference under the sliders — below the bar means the
light is genuinely too flat there, above it means the geometry (`Minimum en`,
`Yan kəsim`) is what is rejecting it.

This page opens with a live picture from any device on the network, over plain
`http://`, with nothing granted — because the camera is the Pi's and arrives as
an ordinary image stream. Only the **Bu brauzer** button still needs
`localhost` or HTTPS, and it says so when it cannot have them.

## 6. The follow page — `/follow`

The same detector as `/vision`, wired to the wheels. Point the camera at the
track, press **SÜRMƏYƏ BAŞLA**, and it drives; **DAYAN**, the space bar, or
anything that takes focus off the page stops it.

The page takes `running: false` in a status as "the server stopped the run"
only after the server has said `running: true` since the button was pressed
(and gives up with *sunucu START-ı təsdiqləmədi* if that takes over 2 s).
Statuses go out every 100 ms and the vision loop keeps the page busy enough
that they are handled up to ~300 ms late, so one sent before START arrived
used to disarm a fresh run at once — and its STOP cancelled the taught leg a
cargo run had just asked for. Every cargo run, A1 or A2, died that way.

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

`steer` itself is then ramped, at `steerRate` units of -1..1 per second (4 by
default) — the same idea as `accel`/`brake` below, applied to the mix instead
of the overall speed. Without it, a derivative kick on the very first frame
after arming, or the jump from a full pivot back to a partial one on leaving
`recover`, moved `steer` a full swing in a single frame — and because that
swing crosses zero on one wheel, and demand crossing zero is exactly where
`lift()` snaps the pin from 0 % to `stall`-and-up (see below), one frame was
enough to feel like a jolt rather than a turn. The logs are what found it: a
run with no lost frames at all still had one wheel jump from 0 % to 31.6 % in
117 ms, on the very first control step.

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

### The 90° corner

`hard` above and the PD before it both assume the road is *somewhere off to a
side* and can be converged on. At a right angle there is nothing to converge
on: the road ends, the next one leaves sideways, and a frame or two later the
chain is gone. So a corner is not steered — it is **executed**.

The detector reports the L and which way it points (above). The pilot then:

1. **Waits.** A corner in the top half of the picture is a corner in the middle
   of a straight. It commits only when the L has come at least `cornerAt`
   (0.80) of the way down the frame — *or* when the road disappears while a
   corner was seen in the last `cornerMs` (0.7 s), which is the case that
   matters most: a right angle takes the chain with it just before the robot
   arrives.
2. **Creeps.** `creepCm` (**15 cm**) of driving straight on at `crawl`. The
   camera is bolted to the **front** of the rover, so the bottom of the picture
   is the ground a camera-to-axle offset *ahead* of the wheels: when a corner
   reaches the bottom of the frame, the axle is still that far short of it.
   Pivot there and the robot turns in front of the corner and ends up beside
   the new road rather than on it.

   That offset is a **distance** — the same 15 cm whether the robot is crawling
   or not — so it is measured as one, integrated from the demand through the
   same calibration `/follow` uses for the lap distance. Measure your own
   camera-to-axle gap with a tape and put it in the box. Too short and it cuts
   the corner, too long and it drives past.

   `creepMs` (250 ms) is only the fallback for a robot that has never been
   calibrated — or one whose `crawl` sits inside the motor's dead band, where
   the wheel is not turning and no distance is accumulating either. A duration
   is the wrong unit for this and turns earlier the slower the robot happens to
   be going; fill in the three calibration boxes and the centimetres take over.
   The page says which of the two is in force, and what it works out to in
   seconds.
3. **Pivots.** Inner wheel to zero, outer at `crawl`, toward the arm. The same
   thing `hard` does, but deliberately and toward something known rather than
   as a last resort.
4. **Hands back.** The turn ends when the road is in front of the robot again:
   a chain of at least two bands, `|sapma|` within `turnOut` (0.3) **and no L
   still pointing the way it is turning**. That last condition is not optional
   — at the moment of committing, the road *into* the corner is perfectly
   visible and dead ahead, so a plain "can I see a road" test would end the
   turn on the frame it started. An L pointing the *other* way does not hold it
   up: that is the junction it has just left, seen from the new heading. If
   nothing comes back within `turnMs` (2.5 s) the turn is given up and the
   ordinary lost-road handling below takes over, because a robot spinning on
   the spot is not looking for the road, it is just spinning.

One guard keeps a corner from becoming a pirouette: **while a turn is running,
and for `cornerMs` after it ends, sightings are not recorded at all.** During
the pivot and for a moment afterwards the camera is sweeping across the
junction the robot is already turning at, and the same L comes back — often
pointing the other way, at the road it has just left. Acting on that means
finishing a right turn and immediately committing to a left one, back the way
it came. In that window the robot follows the road normally; it just does not
take anything L-shaped as news.

**While a turn is running the lost-road timers do not.** Losing the chain is
not the corner failing, it is what a corner *is*. That is also why the run log
records `turn` per frame and `/tune` counts corners separately: a lap that took
six right angles cleanly used to read as six lost-road events and an argument
for driving slower.

### When it loses the road

A dropped frame or two — a shadow, a join in the tape — is not by itself a
fault. (A 90° corner no longer lands here at all: it is seen coming and turned
deliberately, above. What is left below is the *unexplained* loss.)

1. **0 – 600 ms** — keep the last steer, cut to ~55 % of the speed at the
   instant the road was lost — one cut, held for the window, not
   re-applied every frame. It used to read "55 % of the current speed" fresh
   on every frame, which sounds the same but compounds: at `brake` (400 %/s)
   the wheel reaches that 55 % almost immediately, so the *next* frame's 55 %
   is of an already-smaller number, and three or four frames of that hit zero
   well inside the 600 ms window instead of over it. On real footage the
   detector drops a frame here and there constantly, so that was not a rare
   edge case — it was the wheel silently going to 0 % and slamming back to
   `stall`-and-up on nearly every frame the road so much as flickered, which
   is most of what "moving in impulses" turned out to be.
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
              "v25": 1.6, "lost": false, "dist": 0.0,
              "corner": 0, "turn": 0, "creep": null, "end": null }, … ]  // 10 Hz
}
```

The rows carry the **inputs** to every decision as well as its outputs, so a
run can be replayed through `pilot.js` offline with different numbers to see
what would have changed — retuning against a real lap instead of a memory of
one.

`corner` is the 90° turn the detector could **see** at that instant (+1 right,
−1 left, 0 none); `turn` is the one the pilot was **driving**. Two fields and
not one, because "it saw the corner and did nothing" and "it turned at a corner
that was not there" are different faults and look identical from a single
number. `creep` is how many centimetres into the pre-turn creep it was, or
`null` once pivoting. `end` is how far down the frame the **paint ran out**, or
`null` — on the competition track, a station arriving. Logs recorded before either existed simply have neither, and read back
exactly as they always did.

Alongside the rows, the file records what the lap was **made of** — a list of
straights, left-handers, right-handers, 90° corners and dropouts, each with its
duration, mean speed, sharpest steer and distance. "Eight straights, six
right-handers, two of them where it lost the road" is the sentence you actually
want after a lap, and no amount of squinting at 10 Hz rows gives it to you.

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
| 90° corners entered, and how many ended with the road back in front | the corner handling itself | `creepCm` — cutting the corner or driving past it |

Each finding names its measurement, its interpretation and its one number, so
the next lap can prove it wrong. The suggestions can be written straight to
`follow.json` with one button — but change one or two at a time, or the next run
tells you nothing about which change did what.

Corners are counted **apart from** lost-road events, and deliberately so: a
90° turn takes the chain with it every single time, and before the pilot knew
what a corner was, a lap that took six of them cleanly read as six dropouts and
an argument for driving slower. A corner that ended *without* the road coming
back is the one that is worth a warning.

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
codes **q1–q9** standing on the legs they belong to. The origin is the field's
bottom-left corner, in metres. (On the rover the field is public/field.js's
junction map — J1–J4 and KAPI rather than D1–D4 and GATE — and the practice
field, `--field deneme`, is not carried over: there is one field.)

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

### Scenarios — G-code for each leg of the lap (`/plc`)

The **Senaryolar** card on /plc holds the team's own G-code for each leg:

| group | scenarios |
|---|---|
| Alımdan kapıya | A1 → kapı, A2 → kapı, A3 → kapı |
| Kapı | kapıdan geçiş (B tarafına) |
| Yük bırakma | kapıdan B1 / B2 / B3 · yük bırak |
| Dönüş | B1 / B2 / B3 → kapı, kapıdan geri geçiş, kapı → başlangıç |

One Marlin command per line, `;` and `( … )` for comments. Saved in
`follow.json` under `scenarios`, started with **Kaydet ve çalıştır**, stopped
with **DUR**. They run only when started by hand — the PLC mission does not
start them.

How it runs (`scenario_run.js`), and why:

- **a command at a time**, and an `M400` after every move, so the next line
  waits for the robot to finish rather than for Marlin to *plan* the move.
  The progress on the card is the line the robot is on, and DUR stops after
  the move in progress instead of after sixteen already queued.
- **`G91` at the end and after DUR**, so the next W press is relative again
  even if the scenario switched to `G90`.
- **a typo stops it before it starts**: every line is checked first and the
  bad one is shown with its number; nothing half-runs. `M112` and the EEPROM
  commands (`M500`–`M502`) are refused.
- **one source of moves**: W A S D, START on /follow, STOP anywhere, the /gcode
  page's halt, the PLC e-stop and closing the last browser all stop a running
  scenario; /gcode's hold-to-drive answers 423 while one runs.
- **the PLC's bekle pauses it** after the command in progress, and devam
  carries on from the next line; the PLC e-stop ends it.
- **not two at once**: a /plc scenario and a taught route (/gcode's
  *Ssenarilər*, routes.js) refuse to start while the other is driving.

**Satır hesaplayıcı** writes the lines: type the wheel circumference and the
distance between the wheels once (saved as `scenario_geom`), then *İleri /
Geri* by mm, *Sola / Sağa dön* by degrees, *Fork yukarı / aşağı* by mm, *Bekle*
by seconds. It uses the board's own mm per revolution and /gcode's direction
swaps, so `İleri 500` on a 200 mm wheel with 40 mm/tur is
`G1 X-100.00 Y100.00 F3000`.

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

`--no-gpio` makes it dry — what was asked for is kept and shown, no pin is
touched — which is how the test suites run on the robot's own Pi.

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
slider on the same card. W is the camera's forward, the way the pilot drives:
the keys go through the same end-swap as the pilot's demand (rover.js). While a
taught route is replaying, neither the keys nor the fork reach the board, and a
PLC hold cancels the replay.

Note the rover has two lifts in code: this Z-driver fork (/follow's Q / E) and
the GPIO actuator (/gcode's Q / E and the cargo run, actuator.js). Use the one
that is actually wired.

If Z refuses to move down before the fork has been homed, it is Marlin's soft
endstop: turn it off on /gcode (M211 S0).

### The factory automation system — PLC (`/plc`)

The ek şartname's second half is a protocol: the robot talks to the
competition's **PLC simulator** over **UDP** on the field's closed wifi, and the
PLC hands out the task and opens the door. `plc_link.js` is the socket,
`public/plc.js` the packets and the mission (pure, tested with no network),
`plc_run.js` wires them into the server — the route is planned by nav.js, and
the position in PAKET_TX is nav.js's QR fix plus odometer — and `/plc` shows all
of it.

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
through the door both ways — and shown on /plc and /dashboard. The lap
ends when BASLA has been read on the way home and the robot is stopped (or
**Başlangıca vardı**); the PLC then has to say bekle, or name another task,
before the same one is taken again.

"Held" is enforced where the wheels are driven, not on a page: on the ESP32
bench every drive path (keys, gears, /follow) resolves to zero with enable up,
and on the Ender rover the stream of G-code chunks stops and `/api/marlin/run`
answers **423** while held.

**Bekle / devam mid-task.** While a task is being driven (durum 3, 4 or 6), a
PAKET_RX with **kontrol 1** holds the robot where it is, and **kontrol 2** lets
it go again. The durum byte stays what it was. This covers a taught scenario
too (routes.js): it is *paused*, not cancelled. What has not been written to
the board yet is taken back off the serial queue, the replay rewinds by exactly
that many chunks, and on devam it carries on from that chunk, so nothing is
skipped or driven twice. The chunk or two already in Marlin's planner still run
out, so the rover stops within about one chunk. A scenario started while the
PLC says bekle starts paused. /gcode's scenario card and /follow both show
`FASİLƏ` / `fasilə`. An emergency stop still ends the scenario outright.

Two things the specification leaves open are decided in `public/plc.js` and
written down there: a station byte of 0 in PAKET_TX means "no task yet", and
until the first QR the robot reports the start area's coordinates (/plc marks
them as an assumption).

What this does **not** do is steer. The mission knows the route, the turn at the
next junction and when to wait, and it stops the wheels when it must; following
the line and taking the turn is still the pilot's job on /follow.

```
node server.js --plc                                    the competition: Ender board, real PLC
node server.js --plc --plc-bind 192.168.100.10          ...and refuse to send from any other address
node server.js --plc 192.168.123.49 --plc-local 1515    a PLC on your own wifi; the robot answers on :1515, for nc
node server.js --no-connect --plc-sim                   the whole mission on a desk, simulator inside
node plc_sim.js --task 2,3 --gate-wait 3000             a stand-in PLC on its own (npm run plc-sim)
npm run test:plc                                        packets, a full lap, UDP, the rover server
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

It used to read a small grey stream (320x240) that ffmpeg made alongside the
video, and on the field it never read a thing: the rules' 50 mm code, seen by
a camera that leans forward down the line, is ~30x22 px even at 640x480 and
squashed top-to-bottom — **0 reads in 1571 frames** on 2026-09-15. So now:

```
webcam 1920x1080 MJPEG ──ffmpeg -c:v copy──→ viewers (the pages crop it back to 4:3)
        │  5 JPEGs a second
        ▼
jpeg_gray.py (PIL, luma only, ~31 ms) ──2 MB grey──→ QR worker thread (qr_worker.js)
        locate the code-like patch → cut it tight → magnify ×~2 → straighten → jsQR
```

- **1080p, copied, not decoded.** The video itself is never decoded on the Pi;
  ffmpeg's CPU went from ~30 % to ~5 % of a core. A 1080p frame from this
  webcam is 60–85 kB — no bigger than its 640x480 frames were.
- **Only the frames the reader asks for are decoded**, by `jpeg_gray.py`. Not
  by ffmpeg: ffmpeg reading JPEGs from a pipe holds its output until the pipe
  closes (all three test frames came out together, at EOF), and Node has no
  JPEG decoder.
- **Locate first.** jsQR on the whole 1080p frame is ~1–1.4 s and unreliable
  (read one of the two field frames); the same code cut tight and magnified ×2
  reads 10/10 in ~50 ms. `locateQr()` finds the patch dense with hard
  black/white edges — the code scored 812–1179, the best bare floor 388 — in
  ~40 ms. Below its threshold no decode is spent at all, except every 4th look,
  which tries the best patch anyway so a wrong threshold slows reading rather
  than stopping it.
- **Straighten.** See below; on the field `əy 30°` is the warp that reads. The
  warp that read last is tried first next time, one decode a look instead of
  two (~110 ms a look instead of ~196).
- **On a worker thread**, so a look never delays the 20 Hz control stream. A
  frame that arrives while a look is running is skipped, not queued.

Measured live, rover standing in front of ALIM1: **150 of 157 looks read it**.
`/api/qr` also says which warp read (`warp`) and where the best code-like patch
was (`cand`), which /vision and /follow draw dashed when it did *not* read —
"the code is in shot but unreadable" is a different problem from "not in shot".

**The pages crop.** Everything that finds the line was tuned on 640x480, and a
16:9 frame drawn into the 480x360 canvas would squash it sideways. This
webcam's 640x480 mode turned out to be its 1080p frame's centre 1440x1080,
20 px left of centre (best fit: zoom 1.00, shift −9 px at 640 wide), so the
pages draw exactly that part (`camCrop()` in `public/cam.js`) — the same
picture as before, the line detector unchanged.

The part that is easy to get wrong is not decoding, it is **counting**. A sign
held in front of the robot is in view for several seconds, which is thirty
decodes of one string, and reporting "30 codes read" when a person showed you
one is simply wrong. So a reading is new only when the text changes, or when the
same text comes back after the code has been out of sight for four seconds —
which is you driving past the same sign twice.

#### A code seen at a slant: `qrwarp.js`

The camera leans forward, so a code on the floor reaches the picture squashed
top-to-bottom and narrower at its far edge. jsQR corrects perspective only
*after* it has found the three finder patterns, and at a slant it often does
not find them. `qrwarp.js` resamples the part of the picture where the code
sits into a view from straight above, magnified, before jsQR looks:

| warp | what it is |
|---|---|
| `əy N°` (tilt) | the picture the same camera would take rotated N° further down — K·R·K⁻¹, exact for anything; needs the lens's field of view (`--hfov`, 70° guessed) |
| `uzat×N` (stretch) | rows pulled apart ×N; never read where a tilt did not, off unless `--stretch` |
| `künclər` (corners) | any four points (the code's corners, TL TR BR BL) pulled onto a square |

`lookQr()` is what the reader runs; the same file is also a tool for stills,
to see which warps read and what jsQR was given:

```
node qrwarp.js frame.jpg --all --out /tmp/w      every warp, and the pictures jsQR was given
node qrwarp.js --grab                            the server's current frame
node qrwarp.js --device /dev/video0 --size 1920x1080    the webcam, when the server is not holding it
node qrwarp.js frame.jpg --corners 266,284,297,284,298,305,265,305
```

In `test/test_qrwarp.mjs`'s synthetic scene sweep (code on the floor, tilt
40–65°, 42–133 px in shot) jsQR alone read **none**, a tilt warp read 15 of 16.
On the field at 640x480 the 45° warp makes the code come out square — ~45° is
the mount's slant at hfov 70 — but it does not read: no warp adds pixels. At
1080p it does; the real frame is kept as `test/fixtures/qr_field_1080.jpg`
(jsQR on the whole frame: nothing; one look: ALIM1).

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
decode.

Those numbers were measured at 3 QR looks a second. The default is now **5**,
because the code is read while the rover drives past it (see *The cargo run*).
`--qr-fps <n>` sets it.

The 1080p reader (2026-09-15, 5 looks a second, a code in view, one viewer —
**with the Pi under-volted and throttled to 600 MHz**, `vcgencmd get_throttled`
= 0x50005, so a healthy Pi should need well under half of this):

| | |
|---|---|
| ffmpeg | ~5 % of one core — 1080p, copied |
| jpeg_gray.py | ~35 % — five 1080p JPEGs a second |
| QR worker thread | ~55 % — locate + one warp + jsQR, ~110 ms a look |
| server main thread | ~29 % |

With no code in view the worker only locates (~40 ms a look). The worker is
its own thread, so none of this delays the control stream; if the Pi is short
of CPU, `--qr-fps 3` takes two fifths of it back.

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
  "cam": {"on": true, "live": true, "device": "/dev/video0", "w": 1920, "h": 1080,
          "fps": 25, "frames": 9184, "viewers": 2, "err": null, "qr_err": null},
  "qr":  {"available": true, "text": "ALIM1", "at": 1786288938999,
          "age_s": 12.4, "seen_age_s": 0.2, "loc": [[0.428, 0.595], … ],
          "warp": "əy 30°", "cand": {"box": [0.425, 0.593, 0.033, 0.059], "v": 947, "age_s": 0.2},
          "count": 3, "decodes": 41, "ms": 110, "history": [ … ]},
  "rpi": {"cpu": 31.2, "cores": [40, 28, 25, 31], "temp_c": 52.6, "mhz": 1800,
          "mem": {"total": 1934311424, "used": 787…, "pct": 40.7},
          "load": [0.42, 0.51, 0.44], "uptime_s": 2760,
          "proc": {"cpu": 22.1, "rss": 91…, "up_s": 310, "pid": 4046},
          "throttled": {"under_voltage": false, "ever_under_voltage": true, "ok": true}}
}
```

`reason` says why the output is what it is, in the interface's language —
Turkish: `sürüyor`, `tuş w`, `hız normal`, `hız hızlı`, `takip: viraj`,
`köşe — yaklaşıyor`, `köşe — sağa dönüyor` / `köşe — sola dönüyor`, `GERİ`,
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
       browser  ── hold W ──>  G1 X-5 Y5 F6000       (repeated; the next one is
                                                       queued before this one
                                                       finishes — see below)
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
ways is a spin. That is why the key map is written as X/Z pairs:

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

Marlin knows none of this. It plans in XYZ space and times every move by
`sqrt(dX² + dZ²)`, so for a straight move it is working with the ground
distance **times √2**. Two consequences worth keeping in mind:

* `F6000` is 100 mm/s to Marlin and **70.7 mm/s on the ground**.
* A 5 mm chunk on each wheel moves the rover 5 mm, not 7.07 mm. The page quotes
  the ground figure; the `chunk_seconds` the API returns is Marlin's, because
  that is what sets the pacing.

`5` is the chunk size and `6000` the speed in mm/min; both are boxes on the page,
and changing either while a key is held takes effect straight away.

The table lives in **one** place, `DIRECTIONS` in [`marlin.js`](marlin.js), and
the page, the HTTP API and the tests all read it from there. If a motor turns
the wrong way physically, tick **invert left** (X) or **invert right** (Y) on the page rather
than editing the table.

**Neither wheel starts inverted.** When the right wheel was on the Z socket it
ran backwards and the server flipped it by default; that was Z's firmware
direction, which stock Creality sets opposite to X's. Y shares X's, so on the Y
socket the table above goes out as written: forward is `G1 X-5 Y5 F6000`. If
the right wheel still turns the wrong way on your board, tick **invert right**
(`invert` in `MarlinLink`, [`marlin.js`](marlin.js)); it lasts until the
server restarts.

### The right wheel is on Y

The right wheel's motor is plugged into the board's **Y** driver socket; the Z
socket is empty. Everything here — `DIRECTIONS`, the page, the API, the tests —
calls it Y, so the G-code on the page is the G-code on the wire, and `M92`,
`M203`, `M906` and friends are set on X and Y.

It used to be on Z, and Z is the wrong socket for a wheel: stock Creality
firmware configures it for the bed's lead screw, and those defaults break
driving outright. Y is configured exactly like X, which is why the wheel moved:

| setting | stock X | stock Y | stock Z | what Z did to the rover |
|---------|---------|---------|---------|-------------------------|
| `M92` steps/mm | 80 | 80 | 400 | the right wheel turned 5× as far as the left — it spun instead of driving straight |
| `M203` max feed | 500 mm/s | 500 mm/s | 5 mm/s | Marlin slowed the whole move to Z's limit, so both wheels crawled whatever `F` said |
| `M201` max accel | 500 | 500 | 100 | the same, on every ramp |
| `M205` jerk | 10 | 10 | 0.3 | chunk junctions blended far worse (classic-jerk firmware only) |

So on a stock board there is nothing to set. If Y has been edited away from X
(an EEPROM carrying old values, a custom firmware), press **Match Y to X** in
the settings card on `/gcode` — it copies every per-axis X value (`M92`,
`M201`, `M203`, `M205`, and `M350`/`M906` where the firmware has them) to Y,
then reads them back — or send `M92 Y80`, `M203 Y500`, `M201 Y500`, `M205 Y10`
yourself. Either way it is saved to EEPROM automatically (see
[Settings that stick](#settings-that-stick)). The server checks on connect
(`checkWheelAxes()` in [`marlin.js`](marlin.js)) and logs `Y does not match X`
with the exact commands if any of them is far off. It does not send them
itself: a pair of `M92` values a few percent apart is what a calibrated rover
looks like, and the check leaves that alone.

Stock Creality firmware is built with `LIMITED_JERK_EDITING`, which caps jerk
at twice the default — 20 mm/s on X and Y — whatever you send. The `M205` row
says so when a value does not stick.

---

## What "held down" actually means

Marlin acknowledges a `G1` when it is **buffered**, not when it has finished
moving. Stream them as fast as they are accepted and the planner fills with
several seconds of queued motion: you let go of the key and the gantry keeps
going. The one hold mode on the page exists to avoid that without going back
to a full stop between every chunk.

### Stream chunks — the only mode

One short move, repeated for as long as the key is down. The next chunk is
queued **before this one finishes**, not once it has:

**The clock.** Each chunk is timed the way Marlin runs it *inside a blended
stream*: at its cruise speed — the feed, capped per axis by `M203` and by what
the planner lets a move run at with one behind it (v² ≤ 2·a·d) — not by a
trapezoid that ramps up and down inside every chunk (`Jogger.holdSeconds()`).
The next chunk goes out **`HOLD_MARGIN_S` (0.15 s) before the chunk ahead of it
starts** — a lead of one whole chunk plus a margin — on a schedule anchored to
that prediction (`Pacer` in `marlin.js`), never to "now".

Why "before it starts": Marlin re-plans the moves in its buffer whenever one is
added, but **never the move it is already running**. A chunk that was alone in
the buffer when it started has "brake to zero at the end" baked into it,
whatever arrives afterwards. Two earlier designs got that wrong:

| | the next chunk was sent | result |
|---|---|---|
| 1 | once the last had fully finished (`M400`) | the planner drained every chunk — **slices** |
| 2 | 75 % through the current one (`CHUNK_OVERLAP`) | **still slices**: by then the current chunk had started alone and braked at its end anyway — and every replay of a taught route, paced the same way, sliced too |
| 3 | 0.15 s before the one ahead starts (`HOLD_MARGIN_S`) | one is always planned behind the one running — the junction is blended and the rover rolls |

Design 2 was a deliberate trade — the lead is also the stopping distance — and
the wrong one: a held key that moves in slices is not a held key. The steering
stream had found the same rule first (`STREAM_LEAD`, in the `/follow` section).

A key pressed from standstill starts with **two half chunks** sent back to
back, so the first one does not start alone either, and a quick tap still moves
one chunk, as it always did.

The chunk size (`step`) now decides only the stopping distance, not the
smoothness. The page quotes it under the live G-code line:

```
One chunk every 1.13 s — the next is always on the board before this one
starts, so it never brakes between chunks; letting go stops within 170.6 mm of travel.
```

**80 mm per axis at `F6000` stops within 170.6 mm** — up to two chunks on the
board plus 0.15 s of travel (design 2 quoted 100 mm, and braked every chunk).
Halve the step to 40 mm and it halves, at no cost in smoothness now.

**A big chunk is still a trap** — 120 mm per axis is a 170 mm diagonal, 1.7 s a
chunk, with two of them on the board. The page turns the hint amber past 1.5 s.

`M400` is still probed for on connect and still shown on the page (see
**barrierNote**), but only as a readout of what the **M400** button in the
console will do if pressed — the held-key stream does not use it, on any
firmware.

### Speed

`/gcode` opens at **`F16000` for W/S** and **`F2000` for A/D**, with a **turn
scale of 0.1** — a spin is a tenth of the W/S chunk (`TURN_SCALE` in
[`marlin.js`](marlin.js) matches it, for callers that send no `turnScale`).
`F6000` (100 mm/s, `DEFAULT_FEED`) is still what the API and the autonomous
side use when no feed is given. Raising it shortens each chunk, so the gap
between commands shrinks with it — the pacing is the move.

Travel acceleration is not a page default: it is `M204 T`, kept on the board
in EEPROM, and set to **200 mm/s²**. That is gentle enough to cap an 80 mm
chunk below `F16000` — the planner lets a chunk run at most `√(2·a·d)`, which
for the 113 mm Marlin plans is ~213 mm/s (≈ `F12800`) — and the page's
stopping hint already accounts for it.

There is a ceiling to that. A short chunk never reaches the speed you asked
for, because it spends the whole move accelerating and decelerating: past
roughly `F12000` a 5 mm chunk is limited by `M204 T`, not by `F`, and asking
for more changes nothing. Raise the chunk size along with the speed, and watch
the stopping distance the page quotes.

Watch `queue N` at the top of the page while you hold a key. It should still
sit at 0 or 1 — the overlap between chunks happens on the board, inside
Marlin's planner, not in this host-side queue.

### If the motion still looks jerky

Start it with `--trace` and hold a key for a few seconds. Every line out is
printed with a timestamp, and the gaps between the `G1`s are the answer:

```
node server.js --trace
```

```
[   2.546] --> G1 X-40.00 Y40.00 F6000   <- from standstill: two halves,
[   2.549] --> G1 X-40.00 Y40.00 F6000      back to back
[   3.062] --> G1 X-80.00 Y80.00 F6000   <- 0.15 s before the second half starts
[   3.628] --> G1 X-80.00 Y80.00 F6000
[   4.759] --> G1 X-80.00 Y80.00 F6000   <- then one per 1.13 s: the cruise time
```

If the steady gaps are longer than the cruise time the page quotes — the
trapezoid, 1.23 s here, was the old clock — or the halves are not back to back,
the planner is being starved and the motion will be sliced. `test/fake_marlin.py`
models blending and logs `rest` every time a move sets off from a standstill;
`test_serial.mjs` fails if a held key does that more than once.

### One long move

A single `G1 X-2000 Y2000`, cancelled with `M410` when the key comes up. It is
smoother and stops instantly — **but only** if the firmware reports
`Cap:EMERGENCY_PARSER:1`, which is what lets `M410` be read straight off the
serial port instead of queueing behind the very move it is meant to abort. The
page checks for that on connect and puts a warning up if it is missing.

### Stopping

There is **one** stop, and letting go of a key is it: stop feeding chunks, drop
anything queued but not yet sent, let whatever is already on the board finish.
**Space** and the **STOP** button do exactly the same thing — they just drop
every key at once and skip the 25 ms that coalesces near-simultaneous presses
into a diagonal.

The stopping distance is up to two chunks plus `HOLD_MARGIN_S` of travel — the
one running and the one planned behind it, which is what keeps a held key from
braking between chunks — and the page quotes the exact number. A smaller
`step` shortens it without costing smoothness.

**There is no quickstop.** `M410` is not in this codebase, and a check in
`test_marlin.mjs` fails if it comes back. It aborts a move mid-flight and
leaves Marlin's idea of the position wrong until the next `M114`; on firmware
without the emergency parser it is not even prompt, because it waits its turn
behind the very move it is cancelling. Firing one on every key release — which
is what this did at first — is a good way to end up power-cycling the board.
Saving a fraction of a chunk of stopping distance was never worth that.

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
* **EEPROM** — `M500` save, `M501` load, `M502` factory reset. Changes save
  themselves (below); a reset or a load does not, until you press save or
  change something.
* **Serial console** — every line in and out, plus a box to type G-code into.
  A setting typed here is read back and saved like one from the table.
* **Links** to `/vision`, `/follow`, `/map` and `/tune` under the header.

Clicking a slider or a checkbox no longer takes the keyboard: only a text or
number box does, and Enter (or Escape) in one hands W A S D back.

### Settings that stick

"Sometimes a setting does not save" had four separate causes, each fixed where
it lived:

1. **Letting go of a key threw it away.** `halt` emptied the whole send queue,
   and a settings write or an `M500` queued behind the held key's chunks went
   with it. It now drops only moves (`dropMotion()` in `marlin.js`).
2. **One bad value blocked the row.** Apply sent every field in the row, so an
   untouched X outside the server's guard (`M203 X150000`) got the new Y
   refused along with it. Apply now sends only the fields you edited.
3. **The page painted the old value back.** The write was considered done on
   the HTTP reply, before the board had read it back. The server now updates
   its cache as the line goes out, the page holds a row as pending until the
   board confirms it, and a value the firmware refused is shown on its row
   (`rejected` in `/api/marlin/status`) instead of scrolling past in the log.
4. **Nothing was saved unless you remembered to.** Connecting reboots the
   board, which reloads EEPROM. The server now sends `M500` by itself
   `AUTOSAVE_MS` (2 s) after the last settings write, once nothing has moved
   for as long, and the line under the settings header says whether the
   board's settings are saved.

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
node server.js --no-qr              camera on, QR reader off
node server.js --no-actuator        the lift is dry: state kept, GPIO10/GPIO22 untouched
node server.js --act-max-s 30       cut a single lift run after 30 s (default 20; 0 = never)
node server.js --no-lidar           the lidar motor is dry: nothing spawned, GPIO18/23/24 untouched
node server.js --lidar-v 1.6        the lidar motor's starting voltage (the card changes it live)
node server.js --lidar-drop 1.4     the L298N's own loss; duty = volts / (supply − drop)
node server.js --lidar-supply 5     what the L298N is fed
node server.js --radar-port 8443    where the lidar's data arrives (the default)
node server.js --radar-offset 90    the lidar is mounted turned: add this to every angle
node server.js --radar-ccw          the lidar counts anticlockwise
node server.js --radar-unit cm      distances that do not say their unit are cm
node server.js --no-radar           do not open the radar port at all
node server.js --routes /tmp/r.json keep the taught routes somewhere else
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
50 ms; a chunk is 150 ms of travel. Each chunk uses the newest demand, which is
what you want from a control loop — but it does mean **steering updates at
roughly 4–5 Hz**, so at 50 mm/s the rover commits to a heading for about
10 mm at a time. That is the ceiling on how fast it can follow a line, and it
is set by the chunk model, not by the camera.

#### Which wheel is which

The camera is bolted to the end `DIRECTIONS` calls the *back*, so autonomous
driving runs the chassis backwards on purpose — and the pilot steers in the
camera's frame, where "the left wheel" means the wheel on the left **of the
picture**. Driving the rover that way round is a 180° turn of the chassis, and
a 180° turn is two things, not one: every wheel travels the other way **and the
wheels swap sides**.

Only the first half used to be applied. The rover drove the right way and
steered exactly backwards: the correction meant for the outer wheel reached the
inner one, so it turned away from the line it was chasing and every correction
made the error it was correcting bigger. `setAuto()` now does both halves —
`startWheels(-dRight, -dLeft)` — and `test_marlin.mjs` pins it, in the only
terms that cannot drift: ask for more on the pilot's left wheel and it must be
the **Y** motor that travels further.

Manual driving is not affected by any of this. `/gcode` swaps the ends itself
for W/S (`manualVec()`), and A/D are left alone, because which way a thing
spins does not depend on which end you call the front.

#### Why it stopped moving in hops

A chunk is short and the next one arrives without a pause, so the pacing that
suits a held key is wrong here — twice over:

* **The lead was under a chunk.** The held key's pacing of the time
  (`CHUNK_OVERLAP`) queued the next chunk a quarter of a chunk before the
  current one ended. On a 150 ms steering chunk that is 37 ms, and the board is
  *already braking* by then. (It turned out to be wrong for the held key too,
  for the reason that follows — see *Stream chunks* above.) Worse, it cannot change its mind: **Marlin re-plans the moves in its
  buffer whenever one is added, but never the move it is already running.** A
  chunk that was last in the buffer when it started has "stop at the end" baked
  into it. So the next chunk has to be queued before the current one *starts* —
  more than one whole chunk ahead of when it will itself run. That is
  `STREAM_LEAD`, and it is 1.5 for exactly that reason.
* **The clock was the wrong clock.** `chunkSeconds()` is a trapezoid: ramp up,
  cruise, ramp down. That is right for a move that starts and ends at a
  standstill and wrong for one in a blended stream, where the ramps happen once
  at the start of the run and everything after is cruise — 71 ms rather than
  238 ms for a 7 mm chunk at F6000. Pacing a blended stream by the trapezoid
  sends at less than half the rate the board drains, the planner runs dry
  between chunks, and the hopping comes back by way of the pacing instead of
  the queue depth. `cruiseSeconds()` is the estimate the stream uses.

Leading by more than a chunk is only safe while the board keeps up with that
estimate, and a real corner it has to slow for means it will not. Marlin's `ok`
per command is the honest signal: when its planner fills, the acks stop and the
host's own queue grows. Past `STREAM_MAX_AHEAD` the stream **skips a chunk**
rather than queue it — a steering command is a sample of something still
changing, and a backlog of them is a rover driving on what the camera saw a
second ago.

The price of all this is stopping distance: about two chunks rather than one and
a quarter, which at 150 ms chunks is a couple of centimetres. The held key was
later found to need the same rule and now follows it too, with its own margin
and clock (`HOLD_MARGIN_S`, a `Pacer` — see *Stream chunks*); the stream's
`STREAM_LEAD` schedule is unchanged by that.

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
POST halt      stop feeding, drop queued moves (not settings), re-read the position
POST jog       {"axis":"X","distance":10,"feedrate":1000}
POST gcode     {"cmd":"M114"}                    raw, one line or many
POST setting   {"code":"M906","params":{"X":580}}
POST match     copy every per-axis X setting to Y, then read it back
POST home | zero | steppers | endstops | invert | refresh | eeprom | estop
POST connect | disconnect
```

Three small ones beside it, for the lift, the QR reader and the taught routes:

```
GET  /api/qr                                  the last code read: text, key, age_s, seen_age_s, loc
GET  /api/actuator                            running, dir, run_s, cut, dry, err
POST /api/actuator {"action":"toggle"}        Q — start / stop
                   {"action":"flip"}          E — the other direction
                   {"action":"start","dir":"up"} | stop | up | down
GET  /api/lidar-motor                         running, volts, duty, max_v, pins, dry, err
POST /api/lidar-motor {"action":"toggle"}     START / STOP
GET  /api/radar                               scan (mm per degree), near, fmt, from, pts_s, scan_hz, raw
POST /api/radar    {"offset":90,"ccw":false}  turn / mirror the picture; {"unit":"cm"} for bare numbers
                   {"action":"volts","v":1.6} the voltage; applied at once if running
                   {"action":"start"} | {"action":"stop"}
GET  /api/cargo                               the taught routes, the recording, the replay
POST /api/cargo    {"action":"record","slot":2,"leg":"to"}   then drive with WASD
                   {"action":"save"} | {"action":"cancel"}
                   {"action":"clear","slot":2,"leg":"out"}
                   {"action":"qr","slot":2,"text":"ALIM2"}
                   {"action":"run","slot":2}              /follow picks it up
```

A route that needs a board and does not have one answers **409**, so a client
can tell "not plugged in" apart from "you asked for something impossible"
(**400**). Nothing queues silently.

---

## The competition field — `/map`

Following a line is not the task. The task is *go to A2*, and A2 is one of
three identical stations up three identical branches off three identical
junctions. Nothing a camera can see tells them apart. So there is a map.

`public/field.js` is the 2026 SRU field written down — every wall, every metre
of paint, every marked zone — and `/map` draws it, lets you pick a station, and
shows the rover moving on it.

```
     A1        A2        A3                    B3
     │         │         │                     │
  ───┼─────────┼─────────┼────╫────────────────┼──────── B2
     J1        J2        J3   ║ kapı           J4
     │                        ║                │
   START                                       B1
```

### Where the numbers came from

The şartname's **Şekil 1** dimensions the building — 18 × 10 m, halls ending at
7.5 m and starting again at 9 m, the wall openings 4.5 m down from the north
wall and 2.5 m up from the south — and is drawn to scale for everything else.
So the branch positions were measured off the drawing at the scale its own
dimensions fix, 37.28 px/m, and then checked against the two figures that *are*
dimensioned:

| | Şekil 5 / 6 says | the drawing measures |
|---|---|---|
| start branch, total | 3.8 m | 3.69 m |
| start area | 1900 × 1000 mm | 1904 × 1021 mm |
| junction → start area | 1500 mm | 1436 mm |
| station zone | 615 × 715 mm | 617 × 724 mm |
| station stub (QR → end of paint) | 2700 mm | 2740 mm |

They agree to within a couple of centimetres everywhere they overlap, which is
why the measured numbers are trusted for the things nothing prints. Each value
in `FIELD` says which it is; a printed dimension always wins.

Two things the şartname does **not** print, and this repo has had to choose:

* **The line's width.** Şekil 6 draws it about 100 mm at its own scale, and
  that is what `FIELD_LINE_W` says. It is used to draw the track and nothing
  else — no decision about where the rover goes depends on it.
* **Where KAPI1 and KAPI2 stand.** Şekil 1 labels them but does not dimension
  them, so their positions are scaled off the drawing like the branches. The
  gate is reached by odometry anyway (see below), so this costs nothing yet.

### The frame

Metres. `+x` east, `+y` north, origin at the inside of the left hall's
south-west corner, so the field is `0 ≤ x ≤ 18`, `0 ≤ y ≤ 10` and nothing is
ever negative. Headings are compass bearings: **0 = north, 90 = east, clockwise
positive** — chosen because that is what a turn reads as. Turn right 90°, add
90.

### Seeing a junction

`road.js` now reports a fourth thing beside `near`, `far`, `corner` and `end`:

```js
junction: { side: 'left' | 'right' | 'both', dist, span, left, right }
```

A branch leaves the line square, so from a camera looking along the line it is
not a line *beside* this one — it is one band of the picture painted right
**across**. That is the whole measurement: how wide the unbroken run of line
colour through the lock is, against how wide the line itself is there
(`JUNC_WIDE`, 1.9×). Which side it reaches out on, by more than
`JUNC_ARM` × the line's width, is the branch.

Two things stop that being a false-positive machine:

* **The arm has to be a line.** Every station is outlined in yellow tape, and
  yellow is close enough to orange in hue that a strip of it across the line
  has exactly a branch's shape. So the paint in the arm is read as a
  cross-section — blue │ orange │ blue, stacked up the frame instead of across
  it, because that is what looking along a line square to yours does to it.
  Tape is one colour and fails. The walk bridges a pixel or two of nothing,
  since the seam between two stripes is a blend of them and a blend of blue and
  orange is neither.
* **Two frames have to agree on the side**, the same way a corner needs two.

This is measured *before* the chain does its work, because the chain cannot
survive a crossing: a band painted across is one enormous blue run, nothing
inside it sits at the right proportions, and the continuity rule throws out
what is left. That is why a junction used to read as `end`.

The chain still breaks there, and that is fine. Driving *through* a junction,
the bands below the crossing are unaffected, so `near` — the band in front of
the wheels — is still the line and the pilot still steers by it. Only in the
instant the crossing reaches the wheels does the chain go entirely, and the
pilot's existing `hold` (600 ms of carrying on with the last steer) covers it.
Nothing new was needed for the junctions the rover does not turn at.

### Counting them

`public/mission.js` is where the map and the camera are put together, and
neither half works without the other:

```
the camera says   a junction is HERE, NOW, with a branch on the left
the map says      the next junction is 1.79 m along, and it is J2
together          this is J2 — and now the odometer is right again
```

That last clause is the point. Every junction the two agree on is a place with
a known position, so the drift is thrown away three or four times a lap instead
of accumulating for the whole of it. Between junctions the rover is dead
reckoning; at them it is not guessing at all. In the tests, a 6 % wheel-length
error that puts an open-loop pose 6.8 m out at A2 puts the anchored one 2.3 m
out — and all of that remaining error is on the last leg, which has nothing to
anchor against until QR reading exists.

Dead reckoning is better here than it was on the ESP32, incidentally: the
wheels are steppers taking G-code, so what was asked for is what turned. The
distance is a count, not a calibration. Only the heading is an integral, and
the heading is what an anchor fixes.

A sighting is only believed when **all three** hold:

| | |
|---|---|
| it has come far enough down the frame | `commitAt`, 0.72 |
| the odometer is within `gateM` of where the map says | 1.0 m — a third of the shortest gap between two junctions |
| the side the camera sees matches the side the map has | a turn into a wall is the failure this prevents |

If the window closes with nothing in it, the run **stops** and says which
junction it lost. It does not carry on: carrying on means J3 gets taken for J2,
the rover turns there, arrives at A3, and reports that it reached A2. That is
the one failure that looks like success, so it is the one worth refusing.

### Turning

The mission does not steer. `pilot.js` already knows how to take a square turn
— creep up, pivot, pick the road up on the far side — so the mission hands it a
`corner` at the moment the map says to turn, and the pilot cannot tell that
from one it saw for itself. Deciding *when* needs the map; doing it needs the
wheels.

The pose is anchored **twice** at a turn: once on the sighting, with the
bearing the rover is arriving on, and again when the pilot reports the
manoeuvre finished, with the bearing it is leaving on. The second one matters —
the pilot creeps a camera-to-axle offset past the junction and then turns by
however much the wheels slipped, so the pose coming out of a turn is the worst
it ever is, and it is the only moment on the whole run when the exact heading
is known without looking at anything.

### The gate

`KAPI` is a node with no branch. Nothing about the picture changes at the
factory door, so it is reached on the odometer alone and then waited at — a
`wait` move at the end of the queue.

Waiting is a real stop, not a pause: `/follow` disarms, and the mission stops
watching for the next junction entirely. That second part matters — a
stationary rover still has a picture, and anything that crosses it while it
waits would otherwise be counted, putting the rest of the run one junction
ahead of itself.

The PLC simulator's UDP protocol (`192.168.100.100:1515`, `PAKET_TX` /
`PAKET_RX`) is in the şartname and **is not implemented yet**. Until it is, the
**DEVAM ET** button on `/follow` is the whole of it, and it is only offered
while the run is actually held at the door — a person deciding a door has
opened is a fair stand-in for a door nobody can ask.

### QR codes

Read now — on `/vision`, and by the cargo run (see *Carrying a load* below) —
but **not yet used by the map run**. All nine are on the map with their
positions and their text (`BASLA`, `ALIM1..3`, `KAPI1..2`, `BIRAK1..3`),
because the placement is what fixes several of the branch lengths, and because
a reader needs somewhere to look a code up when it arrives. Nothing has to be
restructured for it: a QR read is a better anchor than a junction sighting and
goes through the same `missionSee()`.

Until then, on the map run the count is what identifies a junction, and
`q2`/`q3`/`q4` are what would confirm it.

The server, separately, *does* localise the rover by them — for `/dashboard`,
whether or not `/follow` is open. See *The dashboard* below.

### Two pages, one run

`/follow` owns the mission, because it is the page with the camera. `/map` owns
the choosing, because a person picking a station should not have to stand over
a camera feed to do it. The server is the relay in between: it holds the last
target somebody picked and the last status the driver reported, and puts both
in the status message that already goes out ten times a second. Pick on either
page and both end up on the same target.

Neither page has its own copy of a coordinate or its own drawing code —
`fieldDraw()` lives in `field.js` with the data, for the same reason `road.js`
is one file. A picture drawn from a second copy of the numbers is worse than no
picture, because it looks right while the rover drives somewhere else.

## The dashboard — `/dashboard`

Everything at once, on one screen — what you leave open on a laptop while the
rover runs. Ported from the ESP32 rover's `/dashboard` and rebuilt on this
machine's parts: G-code wheels instead of DAC pins, the şartname's field
instead of a schematic, the lidar motor and the GPIO lift instead of a sonar
and an L298N lift.

| Panel | What it is |
|---|---|
| the strip along the top | speed (what went down the wire in the last second), each wheel's demand, the odometer, where on the field, and whether it is following, on a key, or replaying a scenario |
| **kamera** | the Pi's webcam, live |
| **konum ve sıradaki dönüş** | which leg it is on, which node is next and what to do there — left, right, straight, turn round, or stop — plus the state of `/follow`'s own map run |
| **yarışma alanı** | `fieldDraw()`'s field with the nine codes on it, the planned route, the trail since the last code, and the rover |
| **aktuator** | `public/actuator.js`'s card, the same one `/gcode` has — Q / E included |
| **QR** | the last code read, how long ago, and which field code each recent read was |
| **anakart** | link, port, queue, steppers, and what is driving (polls `/api/marlin/status`) |
| **lidar motoru** | running, volts, duty, pins — read only; START/STOP stays on `/gcode` |
| **radar** | what the lidar sends to :8443, round the rover: nearest obstacle, points/s, sweeps/s, the raw bytes when the format is not recognised |
| **Raspberry Pi** | CPU (total and per core), temperature, memory, load, clock, this server's own CPU and RSS, disk, uptime, and the firmware's undervoltage flag (`rpi.js`) |

### How the map knows where the rover is

Two things, joined at every QR code.

**The odometer** (`nav.js`). Every line that actually reaches the board is
heard through `link.onWrite()` — the same tap `routes.js` records scenarios
from — and each `G1` is integrated with `fieldStep()`, the exact-arc integrator
`mission.js` uses. So it counts whatever is driving: a held key on `/gcode`,
`/follow`'s steering stream, a scenario being replayed, a line typed into the
console. Only what was *written* counts: a chunk a halt dropped from the queue
never turned a wheel.

The wire speaks motor axes and the odometer speaks the camera's wheels:
`startWheels(left, right)` writes `X = −left, Y = right` for the chassis, and
`/follow` hands it `(−camRight, −camLeft)` because the camera is on the end
`DIRECTIONS` calls the back — so, after `link.sign()`, **camera-left = −Y and
camera-right = +X**. That makes `/follow`'s forward forward, its "steer right"
a right turn, and `/gcode`'s W forward too. Moves are relative (`G91`, sent on
connect); a `G90` from the console switches the odometer off until a `G91`.

The wheels are steppers, so the distance is a count, not a calibration. The
heading is the one real error — it is an integral — and it is what a code
throws away.

**The QR codes** (`public/qrnav.js`). Each of the nine stands at a known place
on a known edge of the graph — `FIELD_EDGES`' `qr` and `s`, the same numbers
`fieldDraw()` puts them at. A read is accepted as the şartname's printed text
(`BASLA`, `ALIM1..3`, `KAPI1..2`, `BIRAK1..3`, folded like `qrKey()` so
`Alım-2` is ALIM2) or as the field id (`q5`, `qr/5`, a bare `5`). Anything else
is a stray and **moves nothing**: a pallet label read as q9 would put the rover
at the far end of the arena with total confidence.

A code names an edge, not a direction, so which way along it is decided in
order: the same code again from the same spot keeps its direction; otherwise
continuity — the last code left it heading for a node, and this edge touches
that node, so it drove through; otherwise the plan; otherwise the edge as
written, marked `yön tahminidir`. Continuity is what gets a turnaround right:
`START → A2 → B3` reads ALIM2 going up *and* coming back, and only the
direction tells the two apart.

At each read the **anchor** is stored — the field pose and the odometer pose at
the same instant. From then on the rover is the anchor plus the odometer's
movement since, rotated by the difference of the two bearings. That cancels the
drift and the odometer's arbitrary starting heading in one go, at every code.
With no code read yet **the rover is not drawn at all**: an unlocalised rover
is somewhere, and drawing it on the start line is the failure this exists to
prevent. `pose.dead` is how far it has come since the last code — past a
couple of metres, believe the next QR over the map.

**Which way to turn.** Pick an A and a B and the server plans
(`field_mission`, joined hops of `fieldPlan()`), and each node gets the
difference between the bearing in and the bearing out, with a 25° dead band.
The panel shows the one for the node ahead, and the map rings that node. This
plan steers nothing — `/follow`'s map run (`mission`) is still what drives, by
counting junctions; the dashboard shows both side by side.

Rehearsal: tick *test: QR'a dokunarak okut* and tap a code on the map to report
it as read (`field_qr`). **Yolu sıfırla** starts the trail again and forgets the
fix, keeping the plan.

The trail is fetched once (`GET /api/route`) and appended from the status
stream; `GET /api/field` serves the graph and the codes' positions to anything
that is not a browser.


---

## A run is a list of moves

Following a line is not enough to do the task. Getting out of the start area,
turning round to put the fork on the load, backing into it — none of those has
a line to follow, and two of them happen with the line deliberately out of
shot. So a run is a **queue of moves**, and following a line is one kind:

| move | what it is | ends when |
|---|---|---|
| `go` | drive forward, blind, a measured distance | the odometer says so |
| `back` | the same, in reverse | the odometer says so |
| `spin` | turn on the spot, blind, through a measured angle | the odometer says so |
| `seek` | sweep until the line is found, then **centre on it** | the line is in the middle of the frame |
| `follow` | the line, counting junctions | the last junction is behind and the leg is driven |
| `wait` | hold | somebody says carry on |

`/map` prints the queue for whatever station you pick, so you can read what the
rover is about to do before pressing anything. Sending it to A2 from the start
area builds:

```
1. körlemesine 0.60 m ilerle          go     — out of the start area
2. çizgiyi ara ve ortala              seek
3. çizgiyi takip et                   follow — J1 sağa, J2 sola, then 4.26 m
4. 180° dön — çatal arkada            spin
5. çizgiyi ara ve ortala              seek
6. 0.25 m geri gir — çatal yükün altına   back
```

**The rule the field imposes is that every blind move is followed by a seek.**
A blind move ends wherever the wheels put it; `seek` is what turns "about
there" back into "on the line", and the line is the only thing out there that
can say which.

### Why the 180° cannot be ended by looking

The fork is on the back, so picking up a load means turning round. That turn
has to be counted out, not watched — because **a line looks exactly the same
from both ends.** The detector is as happy at 180° as it was at 0°, and there
is no frame anywhere in the manoeuvre that says which one you are at. So
`spin` integrates the wheels and stops on the arithmetic, and the `seek`
after it cleans up whatever the arithmetic got wrong.

The follow before it therefore stops **short** of the station, by
`forkM + dockBackM`: park the axle there, turn round, and the fork ends up in
the zone. Coming out of the turn the rover is already pointing back down the
branch, which is the way out — so the trip to the door needs nothing new.

## The 27 %

100 mm of commanded travel is **125–130 mm** on the floor. The board is set up
for an Ender-3's X axis — 80 steps/mm of a belt — and this is a rover on
wheels, so the number was never going to be right.

That is two problems, not one:

| | | |
|---|---|---|
| the 27 % | systematic | removable — `scale`, 1.275 |
| the ± 2 % | the spread between 125 and 130: floor, slip, tyre wear | not removable by any constant |

The scale is applied in `mission.js`, at the one boundary where commanded
millimetres become ground millimetres — **not** in `rover.js`, and not to the
pose afterwards. It has to reach the *heading*: a pivot is two wheels running
opposite ways, so a chassis asked to turn 90° with an uncorrected scale turns
115°, and a 180° at a station comes out at 229°. Scale the wheels and the
distance and the heading come right together; scale the pose and only one does.

The ± 2 % is not corrected, it is **budgeted**: the window a junction has to
appear in grows by `scaleTol` of everything driven since the last anchor.

> **The cleaner fix**, when you want it: `M92 X62.7 Y62.7` (80 ÷ 1.275) at the
> board, so a commanded millimetre *is* a millimetre, then set `scale` to 1.
> That changes every feedrate and every distance `/gcode` quotes, which is why
> it is a decision rather than a patch — but it is the right one, and the
> project is set up so it costs one number either way.

### What the 27 % actually costs, and what it does not

Ran in `test/test_mission.mjs` against a simulated floor that does 125, 127.5
and 130 mm per commanded 100 — with the mission believing 127.5 in all three:

| floor | where the fork lands, against the zone |
|---|---|
| 125 mm | −1 cm |
| 127.5 mm | +7 cm |
| 130 mm | +18 cm |

The zone is 615 mm long, so all three are inside it. With `scale` set to 1 —
the correction removed, everything else identical — the fork misses by
**129 cm**. That is the test that says the number is load-bearing rather than
decorative.

And the honest limit, from the same suite: on a floor 14 % off what is believed
(well outside 125–130), the sweep still recovers the *heading* to within 3°,
and the fork still misses by 70 cm. **A sweep recovers heading. Nothing here
recovers distance.** Distance only ever comes back from a landmark, and on the
last leg to a station there is not one — which is exactly the hole the
station's QR code is shaped to fill.

### One more bias worth knowing about

`leadM`. The camera sits ahead of the axle, and `commitAt` is part way up the
frame on top of that, so "junction, now" is a statement about a place the rover
has **not reached yet**. Anchoring without allowing for it credits the rover
with that distance on every junction, always in the same direction — and a bias
that never changes sign is the one kind dead reckoning cannot average away. It
comes out at the far end as a station approach that stops short.

It is the same quantity as the pilot's `creepCm`, and it is measured the same
way: drive up to a junction until the page reports one, stop, measure axle to
paint.

## Scenarios

Every branch the run can take, and what happens. The ones marked ✅ have a test
in `test/test_mission.mjs`.

**Leaving the start area**

| | what happens |
|---|---|
| ✅ normal | `go` 0.60 m blind, `seek` finds and centres the line, follow starts |
| ✅ the blind move lands crooked | the sweep starts at ± 35°, widens to ± 70°, centres on what it finds |
| ✅ no line anywhere | the sweep gives up at 400° total and stops as `lost`, saying so |
| the rover is placed already on the line | set `openM` to 0 and the run starts at `follow` |

**Between junctions**

| | what happens |
|---|---|
| line lost for a moment (shadow, dropped frame) | the pilot's `hold` — 600 ms of carrying on with the last steer |
| line lost for good | the pilot gives up and drops the drive; the mission says where it thinks it was |
| ✅ junction seen inside the window | anchored, acted on, odometer reset |
| ✅ junction seen outside the window | ignored — a strip of light is not J1 |
| ✅ junction seen with the arm on the wrong side | ignored — that is not J2 seen badly, it is something else |
| ✅ window closes with nothing in it | **stop**, and name the junction that was missed |

That last one is the important one. Carrying on means J3 gets taken for J2, the
rover turns there, arrives at A3, and reports that it reached A2 — the failure
that looks like success.

**At a junction it turns at**

| | what happens |
|---|---|
| ✅ normal | the mission hands the pilot a corner; the pilot creeps, pivots, picks the line up on the far side |
| ✅ the pivot overshoots | the pilot ends the turn on the line, not on an angle |
| the line is not there afterwards | the pilot's lost handling; the run stops rather than driving on blind |

The pose is anchored **twice** at a turn: on the sighting, with the bearing the
rover is arriving on and `leadM` taken off the odometer; and again when the
pilot says the manoeuvre finished, with the bearing it is leaving on and no
lead, because the creep has brought the axle up to the junction by then.

**Arriving at a station**

| | what happens |
|---|---|
| ✅ normal | follow stops `forkM + dockBackM` short, `spin` 180°, `seek` centres, `back` 0.25 m |
| the paint runs out early | `end` at the wheels arrives before the odometer does — the paint is a physical landmark and it wins |
| ✅ the spin overshoots | `seek` sweeps, finds the line, and centres on it before the reverse |
| ✅ the spin overshoots a long way | still recovers the heading; the *distance* error stays |
| ✅ no line after the spin | `lost` — the fork does not go into a pallet nobody can see |

**At the door**

| | what happens |
|---|---|
| ✅ arrives | `/follow` disarms and holds in `gate` |
| ✅ something crosses the picture while it waits | ignored — the mission stops watching for junctions entirely while held |
| ✅ told to carry on | **DEVAM ET** resumes the queue |

**Known gaps**, stated rather than hidden:

* **The back-in is blind.** `seek` centres the line first, so it starts
  straight; but 0.25 m of reverse with, say, 10° left over is about 4 cm of the
  fork arriving sideways. A line-guided reverse is the next thing to add, and
  it needs the fork geometry measured first. On the cargo run it matters more
  than it did: a 1.20 m rover has to back off before its 180° at the load
  (*The rover's 1.20 m*, below), so the back-in is that much longer — about
  1.4 m in the worst case — and the camera, facing away, sees paint only
  behind the rover as it goes. That paint is what a guided reverse would steer
  by.
* **`forkM`, `leadM`, `axleM` and `qrSeeM` are placeholders.** They are the
  numbers in `mission.js` that come from the chassis rather than from the
  şartname or from a measurement already taken (`roverLenM` 1.20 was
  measured). `/map` prints them with **ÖLÇÜLECEK** beside them so they cannot
  be forgotten.
* **The PLC is not spoken to.** The gate is opened by a person pressing a
  button.


---

## Carrying a load — `/gcode` teaches, `/follow` drives

The map run above answers "go to A2". The cargo run answers the actual job:
**fetch the load from slot 2 and take it to the door** — and it does the
part with no paint on it from memory rather than from the map.

```
 /gcode                          /follow
 ──────                          ───────
 Ssenarilər: A2, step by step    A2 · yuva 2 → SÜRMƏYƏ BAŞLA
      │                               │
      ▼                               ▼
 routes.json  ─────────────────▶  path   A2's scenario, to slot 2's line   (server drives)
 (the G-code that                 seek   find the line, centre on it
  reached the board)              qr     ALIM2? — anything else is a stop
                                  trace  follow the paint to its end, at the load
                                  back   away from the load, until a turn clears it
                                  spin   180°
                                  seek   square to the line again (soft — see below)
                                  back   the fork under the load
                                  lift   actuator up, liftS seconds
                                  trace  back along the line to where it began
                                  path   the taught way from there to the door
```

A2 with no scenario of its own goes through the nearest slot that has one —
see *One scenario, three slots* below.

### The lift — GPIO10 and GPIO22

One linear actuator on two Pi pins, set with `pinctrl` — the same commands
that were tried by hand:

| pin | `dh` | `dl` |
|---|---|---|
| GPIO10 — enable | **dayan** (stop) | **başla** (run) |
| GPIO22 — direction | **yuxarı** (up) | **aşağı** (down) |

The enable line is **active low**, and the code is arranged around that: the
server's first act on startup is to drive GPIO10 high, *before* it touches the
direction, and its last act on shutdown is the same. A floating or forgotten
pin must never be the running one.

On `/gcode`, next to W A S D: **Q** starts and stops, **E** turns it round,
**Space** stops it along with everything else, and the ▲/▼ buttons set the
direction outright. The keys are read by physical position, so they are the
same two keys on an Azerbaijani, Turkish or US layout.

Latched, not held — a stroke takes seconds, and holding a key for all of it is
how auto-repeat becomes forty toggles. What makes latching safe:

- **Never reverse under load.** E while running stops, waits 250 ms, then
  starts the other way.
- **Never run past the end.** One continuous run is cut after 20 s
  (`--act-max-s`; 0 turns it off). An actuator against its end stop is a
  stalled motor, and a cheap one has no limit switch to save it. The card says
  so when it happens.
- **The last page closing stops it.** Nothing left open could show it running.
- **Every write goes through one queue**, so Q-E-Q pressed fast lands in the
  order it was pressed — a stop cannot overtake the start it was meant to end.

### The lidar — a DC motor on an L298N, GPIO18 / 23 / 24

A plain DC motor spun slowly where a lidar would sit, on its own L298N fed
5 V. One card on `/gcode`, **Lidar**: a START/STOP button and the voltage.

| L298N | Pi | physical pin | |
|---|---|---|---|
| ENA | GPIO18 | 12 | PWM — **take the ENA jumper off** or it is stuck at full |
| IN1 | GPIO23 | 16 | high while running |
| IN2 | GPIO24 | 18 | always low |
| GND | GND | 14 | **common ground** with the Pi, or the inputs float |
| +12V (VS) | 5 V supply | | the motor's supply |
| +5V | the same 5 V | | **take the 5V-EN jumper off** — the board's regulator needs ~7 V in to make 5 V, and fed 5 V it gives the logic ~3.5 V, under the L298's 4.5 V minimum |
| OUT1 / OUT2 | motor | | swap them if it turns the wrong way |

The motor wants **1.6 V** out of that 5 V, so ENA is pulsed. The L298N is a
bipolar bridge and loses ~1.4 V across its two transistors at this current,
so the duty is worked out against what is left:

    duty = volts / (supply − drop)        1.6 / (5 − 1.4) ≈ 44 %

The drop is typical, not measured. Put a multimeter across OUT1/OUT2 while it
runs; if it does not read 1.6 V, change the voltage on the card (it applies at
once) or start the server with `--lidar-drop` / `--lidar-v`.

`pinctrl` sets a level and exits; it cannot hold a duty cycle. So the PWM is
held by `lidar_pwm.py`, a small `lgpio` process (it ships with Raspberry Pi
OS — no dtoverlay, no reboot), started on the first START and fed one line per
command. Every way it can end — STOP, the server shutting down, the server
*dying* (its stdin closes), SIGTERM — leaves the three pins low, and the server
drives ENA low again with `pinctrl` as a backstop. Before the first START
nothing is claimed at all, and the Pi's own pull-downs hold GPIO18/23/24 low.

Unlike the lift, **it keeps spinning when the page closes and on Space**: it
is meant to turn through a whole run while the wheels stop and start around it,
and a slow motor with nothing to push against has no end stop to stall on.

`--no-lidar` keeps the state and the card but spawns nothing (the card says
*quru rejim*). The test suites run with it.

`--no-actuator` keeps all of it but touches no pin (the card says *quru
rejim*). The test suites run with it, because they run on the Pi.

### The radar — what the lidar sends to port 8443

The lidar is read by something else — an ESP32, a laptop, the lidar's own
wifi bridge — and pushed to the Pi on **port 8443**. Nothing fixed what that
sender speaks, so the port takes all of it, and `/dashboard` draws the result
on the **Radar** card: the rover in the middle with its nose up, one wedge
per degree out to whatever it hit, red under 0.3 m, amber under 0.8 m.

| How it arrives | | What is inside | |
|---|---|---|---|
| UDP | one datagram at a time | LD06 / LD19 | the 47-byte packet, `54 2C …`, CRC-checked |
| TCP | a raw stream | JSON | `{angle, distance}`, `[[a, d], …]`, `{points: […]}`, a 360-long array, ROS `{angle_min, angle_increment, ranges}` |
| HTTP POST | the body, any path | text | `angle,distance[,quality]`, one per line (`A:90 D:1000;…` too) |
| WebSocket | each message | | |
| TLS | any of the three above in it — `https://`, `wss://` | | |

**The iPhone.** The sender on this rover is an ARKit app on an iPhone that
turns on the lidar motor, over WebSocket. Its packets start `SCN1` and were
read off the wire, not a spec: a 48-byte header (version, type, column
count, frame number, three angles in radians, a time in ms, a tracking
figure — 1, or 0.3 while ARKit is struggling) and then 256 × u16:
distances in millimetres, 0 where it has no reading, across a 60° sector,
right to left. The third angle is the phone's turn on the motor, so each
slice is put where the phone was pointing and one turn fills all 360°;
*Bu yön = ön* on the card makes the phone's present direction the rover's
nose. Every return also goes into the **room map** (`/api/radar/map`, its
own card): 5 cm cells round the phone, counted and kept until *Temizle*, a
new ARKit session, or a change of offset, direction or FOV. That is what
builds up the room. There is no position in the packet, so the map assumes
the phone turns in one place. It also sends
`{"type":"ping"}` now and then, which is ignored.

TLS is answered with a self-signed certificate made by `openssl` on first
start (`certs/radar-*.pem`, not in git), so the sender has to skip verifying
it (`setInsecure()` on an ESP32).

Angles are **degrees clockwise from the nose**, as on the field map; a lidar
mounted turned is fixed with *Açı kaydırma* on the card and one that counts
the other way with *ters yön* (or `--radar-offset` / `--radar-ccw`). A
distance is millimetres unless its key says otherwise (`dist_m`, `dist_cm`,
ROS is metres) or the numbers do — all small with a decimal point is metres.
Radians are recognised the same way. `--radar-unit` settles bare numbers.

A return older than 3 s is dropped from the radar (not from the room map), so something that
moved away does not stay on the radar. When bytes arrive in a format none of
the above recognises, the card says so and opens **Gelen ham veri**: the last
few arrivals in hex, for writing the decoder they need.

No sender to hand:

    node test/fake_lidar.mjs                                 UDP, JSON, 127.0.0.1:8443
    node test/fake_lidar.mjs --via tcp --fmt ld06
    node test/fake_lidar.mjs --via ws --fmt text --host 192.168.123.27

Like every other port here it has **no authentication**: anything on the
wifi can draw on the radar. A port somebody else already holds is a line on
the card and at startup, not a server that will not start.

### QR codes on `/vision` and `/follow`

`qr.js` was already written; it is now fed. Five 1080p frames a second
(`--qr-fps`) go to its worker thread (see *Reading QR codes*), whether or not a
page is open or the rover is moving, and both `/vision` and `/follow` show the
answer: the text, how long ago it was read, how long ago it was last *seen*,
the history, and — on the Pi camera only — a purple outline where the code is
in the picture (dashed: something code-like is there but did not read). On a browser camera or a file the outline is not drawn: a
box on a picture the reader never looked at would be a claim about a code
nobody decoded.

Codes are compared by a folded **key** — case, spaces, dashes and the dotted
İ removed — so a sign printed `Alım 2` is `ALIM2`. Nothing else is folded:
ALIM3 is still not ALIM2, which is the mistake the check exists to catch.
`--no-qr` turns the reader off.

### Teaching a route — scenarios

Two legs per slot, both taught on `/gcode` by driving them:

| | from | to |
|---|---|---|
| **1** | the start area | where the slot's line begins — close enough for the camera to see it |
| **2** | that same spot, **turned round, load behind it** (where step 9 leaves the rover) | the door |

Leg 1 is the slot's **scenario** — the *Ssenarilər* card, one per pickup point
**A1 / A2 / A3** (yuva 1 / 2 / 3, QR `ALIM1..3`; not "A, B, C", because B1..B3
are the drop-off points). A scenario is the rule *"to see A2's line, come
here"*, taught **one step at a time**:

```
 A2   1. W 480      sürülüb   ▶ ↻ ↑ ↓ ✕
      2. D 120      sürülüb
      3. W 900      yazılıb
```

- **+ Addım öyrət** records one step — drive a piece of the way, **Bitir və
  saxla**. Then the next: a turn, another straight, until the camera sees the
  line.
- **+ Yazılı addım** adds one typed instead: a key and a distance, `W 400 mm`.
  The distance is wheel travel, the same unit the list prints — for A and D
  that is each wheel's millimetres turning on the spot, *not degrees* (that
  would need the track width and the 27 % scale). It is cut into equal chunks
  no longer than a held key's, so it replays and stops like one.
- **▶** drives that one step alone (the rover must be where it begins), **↻**
  teaches it again, **↑ ↓** reorder, **✕** deletes — none of them touches the
  other steps. One long recording had none of this: a wrong turn near the end
  meant driving the whole way again from the start area.
- **▶ Ssenarini sına** drives the whole scenario from `/gcode` — just the
  wheels, no camera, no QR. Any key, **Space** or **■ Dayandır** stops it
  (`/api/marlin/run`, `jog` and `halt` all cancel a replay first), and it is
  refused while `/follow` has the rover armed.

To the cargo run a scenario is still one leg: the steps are joined and then
**aggregated** (`aggregate()` in `routes.js`) — consecutive moves in the same
direction at the same speed become one move. `W 400` in step 1 and `W 300` in
step 2 are driven as one unbroken `W 700`, and so are four taps on W; the card
shows what will actually be driven (*sürüləcək: W 700 → D 120 — 3 hərəkət
2-yə birləşdi*). A turn or a change of speed is not joined, and does not stop
the rover either: Marlin slows for a turn by as much as the turn needs. A
`routes.json` from before scenarios (`to: {segs}`) reads as a scenario of one
step. Leg 2 is still a single recording (**Öyrət**).

Press **Öyrət** (or **+ Addım öyrət**), drive with W A S D as usual, press **Bitir və saxla**. What is
recorded is not the keys but the **G-code that reached the board**
(`MarlinLink.onWrite()`): a chunk a halt dropped before it was written never
moved a wheel, and a recording taken any earlier would replay it anyway. One
held key is one move; letting go and pressing again is a second one — and the
aggregator joins them again when they point the same way at the same speed,
so taps on W replay as one smooth W. Absolute moves typed into
the console cannot be replayed from elsewhere and are skipped (and counted).
The lines are kept in the motor frame, so ticking *invert left* afterwards
does not reverse a taught route.

Replaying is paced **like a held key**, by the same `Pacer` (`marlin.js`):
every chunk is on the board before the one ahead of it starts, across move
boundaries too, anchored to the predicted timeline, never to "now". So a move
is one continuous run, and the junction between two moves is Marlin's to take —
it slows for a turn as much as the turn needs, and no more. The replay used to
wait for every move to run out and then settle for 300 ms, and paced chunks 75 %
through the one before; the autonomous run was as sliced as the manual driving
it was recorded from. An aggregated move is still sent as chunks rather than
one long `G1`: that would be as smooth and would put metres in Marlin's planner
with no quickstop to take them back; chunk by chunk, **DAYAN** stops a replay
within the same distance as releasing a key. A replay only runs while
`/follow` is armed, and anything that disarms it — DAYAN, Space, a lost
socket, a closed tab — cancels it.

The routes and each slot's QR text live in `routes.json` (git-ignored; the
tests use `--routes` to point elsewhere). The QR text defaults to the
şartname's `ALIMn` and can be changed per slot on the card, for a mock-up.

### The cargo run

`missionCargo()` in `mission.js` — the same queue of moves as the map run,
with six more kinds:

| move | what it is | ends when |
|---|---|---|
| `path` | a taught leg, driven by the server; the pilot is held at zero | the server says done under this run's id |
| `qr` | the code read **on the move**: if it has not been seen yet, creep along the line at `qrCreepPct` with the pilot steering | the slot's code has been seen at any point of the run (next — at once, usually), another code is seen here (**stop**), or `qrCreepM` / `qrWaitS` pass (**stop**) |
| `align` | put the axle on the QR row, blind: creep until the code leaves the bottom of the picture, then drive to `rowM` from it | there (or **stop** if a code driven past on the taught leg does not come back in `alignFindM` of reversing) |
| `hop` | along the QR row, blind, at `hopPct` | the slot's code has passed under the camera; **stop** past the map's distance + `hopOverM`, or on a code from beyond the slot |
| `trace` | follow the line | the paint runs out (`endVotes` frames of `end` past `commitAt`) |
| `lift` | the actuator, standing still | `liftS` seconds |

**A wrong QR is a stop, not a warning.** Three slots are three identical stubs
of line, and a taught route that drifted half a metre puts the rover on the
neighbour's — nothing about the paint says so. The code does, and carrying on
past it is the failure that looks like success.

**The QR is read while the rover moves, and line following starts once it
has been.** The reader never stops, so the slot's code seen at any moment since
the run began — along the taught leg, during the sweep — counts, and the `qr`
step passes straight to the trace. Only if it has not been seen does the rover
creep along the line looking for it; it never stands still waiting. A code from
*another* slot glimpsed along the taught leg is not a stop (the leg may pass
other slots); at the line, it is. A code last seen before the run began does not
count — it was in front of the rover somewhere else.

**The way back** ends at whichever comes first: the paint running out, or the
distance the QR creep and the outward trace drove, plus the back-in. Either one
is "where it began", which is where leg 2 was taught from.

**The clocks only run while armed.** The QR wait and the lift count real
seconds, but only seconds the rover was armed for — a page left disarmed in
front of a wall does not time out a run nobody is running, and re-arming in
the middle of a lift finishes the lift.

**If leg 2 has not been taught**, the run ends at the start of the line with
the load on — useful for teaching leg 2 from exactly where the rover will be.

### The rover's 1.20 m — no turn near a load

The rover is 1.20 m long, fork included. A turn on the spot sweeps a circle
round the middle of the driven axle, and `missionReach()` is its radius — to
the furthest corner, with the pallet's 700 mm as the width. Where along the
1.20 m the axle sits has **not been measured**, so until `axleM` is set the
reach is the worst case, the whole length swinging round: **1.25 m**. With
the axle 0.15 m from the camera end it would be 1.11 m; in the middle, 0.69 m.

Şekil 6 dimensions the rest: the load's zone starts **1.5 m** up the line from
its QR code. Two consequences:

* **The 90° turns onto and off the QR row** happen with the axle on the row,
  1.5 m short of the load. `missionTurnRoom()` = 1.5 − reach − `clearM` 0.10
  is how far up the line a turn is still safe — **0.15 m** in the worst case.
  So `align` puts the axle *on* the row (`rowM` 0), never beyond that room,
  and a rover whose reach does not fit at all is refused before it arms.
* **The 180° at the load** used to happen where the trace stopped — the paint
  disappearing under the pallet, `leadM` (0.20 m) in front of the axle. With
  1.20 m of rover that swings the far end straight through the load. Now the
  rover first backs off `missionBackOff()` = reach + `clearM` − `leadM`
  (**1.15 m** worst case), turns there, and backs in by that much more — the
  fork still ends up `dockBackM` past where the trace stopped, as before.

The seek after that 180° is **soft**: backed off that far, facing away from
the load, the camera sees the first centimetres of paint at best — the rover
is standing on the rest. If the line is in shot it centres on it; if not it
does not go hunting across bare floor, it keeps the heading it had (exact a
moment ago on the line, the 180° counted to ± 2 %) and backs in.

### One scenario, three slots — the QR row

The three pickup lines are parallel and start on one row (Şekil 1: q2, q3 and
q4 level; 1.79 m apart, scaled off the drawing), each with its QR code at its
start (Şekil 6). So **one taught scenario is enough**. A slot with none of its
own is reached through the nearest slot that has one (`RouteBook.via()` in
`routes.js`; its own always wins):

```
 A1 taught, A3 asked for
 ───────────────────────
 path    A1's scenario                      the only thing taught
 seek    centre on A1's line
 qr      ALIM1 — the row starts where the map says
 align   axle onto the row                  creep until ALIM1 leaves the picture, then to rowM
 seek    square to the line, tighter        rowNear 0.03 ≈ 1° — the row is blind
 spin    90° right                          on the row: clears A1's load
 hop     east along the row, blind          ALIM2 goes by (means nothing), then ALIM3
 spin    90° left                           on the row: clears A3's load
 seek    centre on A3's line
 qr      ALIM3 — already read on the row, passes at once
 …trace, back off, 180°, back in, lift, trace back — as above
```

Where the axle is relative to a code comes from the one place that is known
exactly: where the code **leaves** the picture, `qrSeeM` in front of the
axle — measured on the odometer at the moment the reader last saw it, not
when it last said so. A code glimpsed only along the taught leg (whose wheels
the page does not count) is found again by backing up.

The row is blind, so it runs on whatever heading the tight seek leaves: about
1° — 7 cm sideways by A3 in `test_mission`'s yard. At the old `seekNear` 0.12
(3.6°) the camera went past ALIM3 22 cm to one side; that is what `rowNear`
is for.

The `/gcode` card's button says which way it will go (*A3 YÜKÜNƏ GET → A1
ssenarisi + QR sırası*), and `/follow` shows *yuva 3 · A1-dən*.

Knobs in `MISSION_DEFAULTS`: `qrCreepM` 0.6, `qrCreepPct` 8, `qrWaitS` 8,
`qrFreshS` 1.5, `endVotes` 3,
`traceMinM` 0.10, `traceMaxM` 4.0, and **`liftS` 5 — MEASURE IT**: the time the
lift takes to raise the fork clear, plus a little. For the 1.20 m and the row:
`roverLenM` 1.20, `roverWideM` 0.70, **`axleM` null — MEASURE IT**, `clearM`
0.10, `loadGapM` 1.50, `rowM` 0, `rowNear` 0.03, **`qrSeeM` 0.15 — MEASURE
IT** (err small: too big walks the rover towards the load), `qrNowS` 0.4,
`hopPct` 8, `hopOverM` 0.5, `alignFindM` 1.0.

| | what happens |
|---|---|
| ✅ normal | all eleven moves, both taught legs asked for in order, the lift runs `liftS`, the rover ends back where it found the line |
| ✅ the 180° at the load | backs off first — no part of the rover inside the load (checked point by point in a 2-D yard) |
| ✅ the mission told the rover is 0.4 m | it turns where a 0.4 m rover could, and the yard reports the hit — the check can fail |
| ✅ A1 taught, A2 / A3 asked for (and A3 → A1, A2 → A3) | only the neighbour's scenario is driven; both 90° turns on the row; the right line traced; no load touched |
| ✅ `axleM` not measured | worst-case reach, A1 → A3 still done without touching a load |
| ✅ the slot's QR unreadable | **stop** at the map's distance + `hopOverM` — it never turns onto a line |
| ✅ …and the next slot's code comes into shot | **stop** at once: the slot was passed |
| ✅ a rover too long to turn on the row | refused before it arms; a slot with its own scenario still goes |
| ✅ the scenario drove past the neighbour's code | backs up until it is in shot, then onto the row as usual |
| ✅ no scenario anywhere | refused before it arms |
| ✅ found the line at its very start | the way back ends on the paint running out instead |
| ✅ QR printed `Alım-2` | it is ALIM2 |
| ✅ ALIM3 at slot 2 | **stop** — the trace, the turn and the lift never happen |
| ✅ no code at all | **stop** after creeping `qrCreepM` along the line, and says whether the reader itself is down |
| ✅ read along the taught leg | the `qr` step passes at once; line following starts |
| ✅ only in shot after creeping 0.2 m | read on the move; the way back still returns to where the line was found |
| ✅ ALIM3 glimpsed on the way, ALIM2 at the line | carries on |
| ✅ code seen before the run began | does not count |
| ✅ disarmed while waiting | the wait does not run out |
| ✅ DAYAN in the middle of a taught leg | **stop** — it does not start the leg again from the top, from the wrong place |
| ✅ a leg that cannot start (no board) | **stop**, with the server's reason |
| ✅ no scenario taught for any slot | refused before it arms |
| ✅ the paint never ends | **stop** at `traceMaxM`, lift untouched |

## Bringing it up on the floor

In this order, because each rung is meaningless until the one below it holds.
Nothing above rung 1 is worth running against uncalibrated wheels.

### 0. On the bench

```bash
npm test          # 700+ checks, no hardware
```

Then `/vision` with **no motors at all**: press *Video dosyasıyla dene* and feed
it a photo of the real line under the real lighting. The detector can be
completely settled before the rover moves once.

### 1. The four numbers

Everything downstream is a function of these. The board is already in relative
mode (`G91`, sent on connect), so `/gcode`'s command box takes distances
directly — its placeholder, `G1 X-100 Y100 F1000`, is 100 mm of "forward".

**Scale and balance — `M92`.** Mark the axle. Send:

```
G1 X-1000 Y1000 F600        1000 mm of commanded forward
```

Measure two things: how far it actually went, and how far sideways it ended up.

* *Distance* is the 27 %. The honest fix is at the board, not in software:
  `M92 X… Y…` scaled by `1000 ÷ measured`, from the settings table on `/gcode`.
  Get that right and `scale` in `mission.js` goes to **1.0** and stays there.
* *Sideways drift* is the two wheels not matching, and it is the more damaging
  of the two — it is a heading error, so it bends the whole map rather than
  shifting it. `M92` is per axis, so nudge X and Y apart until 1000 mm comes
  out straight. Which way round is found in one trial.

Run it three times. The **spread** between the three is `scaleTol` — that part
is not removable and the windows are sized from it.

**Track width — `FIELD_TRACK_M`.** Measure tyre centre to tyre centre. Then
check it: a full turn is `π × track` per wheel, both the same sign, so at
0.30 m —

```
G1 X942 Y942 F600           should be exactly 360°
```

Overshoot by 5 % and the real track is 5 % larger. This one sets how far a
commanded pivot actually turns, so the 180° at a station rides on it.

**`leadM`.** On a taped T: open `/vision`, creep up, and watch the **Kavşak**
readout. Stop when it reaches 72 % — the same `commitAt` the mission uses — and
measure from the axle to the crossing paint.

**`forkM`.** Ruler: axle centre to where a pallet sits on the fork.

**`axleM`.** Ruler: the camera end of the rover to the axle centre. Until it
is set, every turn near a load is planned as if the whole 1.20 m swung round
one end — safe, but it backs off 1.15 m before the 180° instead of about 1 m.

**`qrSeeM`.** Lay a QR on the floor, open `/vision`, drive slowly over it and
stop the moment the reader stops seeing it; measure axle to code. If unsure,
take the smaller number — too big walks the rover towards the load.

### 2. The detector, still no motors

`/vision`, *Yarışma çizgisi* mode, under competition lighting:

| what | what you should see |
|---|---|
| on the line | 6–8 şerit, Sapma near 0, *renkli %* well clear of 5 |
| on a straight | **Kavşak: yok** — this is the one that matters most |
| over a taped T | Kavşak SOL or SAĞ, and the drawn arrow on the correct side |
| over the yellow station tape | Kavşak: yok |
| over a QR patch | the chain does not break |

A false junction is a miscount, and a miscount sends the rover to the wrong
station without noticing. Spend the time here.

### 3. A short mock-up

Three or four metres of tri-stripe tape and one T is enough to exercise
everything except the distances. Run `/follow` with **no target set** — the
pilot follows, the mission stays idle — and read the run back on `/tune`.

To run a *mission* on a mock-up, edit `FIELD` in `public/field.js` to your
tape's real distances. It is one table and it is the only place a coordinate
lives, so a mock field is a dozen numbers and nothing else changes. (The
şartname's own practice area — Şekil 3, 10 × 7 m — is a reasonable second map
if you have the room for it.)

### 4. The station, in pieces

The dock is the riskiest part because two of its three moves are blind. Take it
apart: send the rover to a station and watch `/map`'s move list tick through
`180° dön` → `çizgiyi ara ve ortala` → `geri gir`. Stop after the spin and check
by eye that it is square to the line before letting the reverse happen.

### 5. A whole run

START → A2 → KAPI on the practice field, with `/map` open on a phone. Every run
is logged to `logs/`; `/tune` reads them back. **Log every run** — "it went
wrong somewhere" is not a thing you can fix, and the log is the difference.

### While driving

* **Space bar** stops, from any of the pages that drive.
* Losing the browser window halts the motors on `blur`.
* The run disarms itself on `done`, on `lost`, and at the gate.


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
| `camera.js` | the Pi's webcam: one ffmpeg, 1080p MJPEG copied out to viewers; a few JPEGs a second to `jpeg_gray.py` for QR |
| `jpeg_gray.py` | JPEG in, full-resolution grey out, on a pipe (PIL) — the QR reader's decoder |
| `qr.js` | counting QR readings honestly; `QrLooker` feeds the worker thread |
| `qr_worker.js` | one QR look per frame, off the main thread |
| `qrwarp.js` | locate the code, cut it tight, magnify, straighten (tilt / corners warps), jsQR — and a CLI for stills |
| `rpi.js` | what the Pi is doing to itself: CPU, temperature, RAM, throttling |
| `public/home.html` | hub page |
| `public/manual.html` | manual page, self-contained |
| `public/drive.html` | keyboard drive page, self-contained |
| `public/pins.html` | every spare GPIO, 0-255 by hand |
| `public/setup.html` | the numbered checklist: measure, type, saved everywhere |
| `public/obstacle.html` | forward sonar: drive, stop, wait, carry on |
| `public/dashboard.html` | everything at once: speed, volts, ESP32 + Pi, camera, obstacle, QR, the field map and the next turn |
| `public/route.js` | dead reckoning: two wheel percentages → a path. Pure |
| `public/scenario.js` | scenarios: the 12 legs, checking the text, what goes to the board, the helper's lines. Pure |
| `scenario_run.js` | running a scenario on the Ender board, a command at a time, and stopping it |
| `gpio.js` | the Pi's output pins: sysfs, pinctrl, or an honest "this machine has none" |
| `buzzer.js` | the reversing buzzer: the beep pattern and which pins it drives |
| `public/pins_pi.html` | /pins: the buzzer's settings and the pin notes |
| `public/plc.js` | the PLC protocol (PAKET_TX / PAKET_RX) and the mission's durum 1–8. Pure |
| `public/plc.html` | /plc: the link, the packets byte by byte, the mission, the field map, the simulator |
| `plc_link.js` | the UDP socket to the PLC, on a fixed one-second clock |
| `plc_sim.js` | a stand-in PLC: the same protocol from the other side, in the server or on its own |
| `plc_run.js` | the mission wired into the server: holds the wheels, hears the QR reads, reports nav.js's pose |
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
| `actuator.js` | the lift: GPIO10 enable (active low) and GPIO22 direction through `pinctrl`, one ordered queue, the run cut |
| `lidar.js` | the lidar motor: volts → ENA duty against the L298N's drop, START/STOP, `/api/lidar-motor` (the status frame's `lidar_motor`) |
| `lidar_pwm.py` | the `lgpio` process that holds the lidar's PWM on GPIO18 and drops all three pins on any exit |
| `radar.js` | port 8443: UDP, TCP, HTTP POST, WebSocket, TLS; LD06 packets, JSON or text lines → one distance per degree, `/api/radar` |
| `routes.js` | teaching the way to each load: recorded off the wire, kept in `routes.json`, replayed like a held key |
| `public/gcode.html` | drive by hand, the lift (Q/E), and the teaching card |
| `public/actuator.js` | the lift's card and its Q / E keys |
| `public/lidarmotor.js` | the lidar motor's card on /gcode: START/STOP and the voltage |
| `public/radar.js` | the dashboard's *Radar* card: the scan drawn round the rover, range, offset, direction |
| `public/teach.js` | the *Ssenarilər* card: per pickup point A1–A3, a scenario taught step by step (driven or typed, each testable alone), leg 2, send a cargo run to /follow |
| `public/qrview.js` | /vision's QR card and the outline over the video |
| `nav.js` | where the rover is: an odometer fed off the wire (`link.onWrite`), and the QR localisation on top of it |
| `rpi.js` | what the Pi is doing to itself: CPU, temperature, RAM, throttling |
| `public/qrnav.js` | QR code → leg and direction, the anchor between odometer and field, the plan's next turn. Pure |
| `public/dashboard.html` | everything at once: camera, where it is and the next turn, the field map, the radar, the lift, QR, the board, the lidar, the Pi |
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
| `shared.js` | loads the pages' pure modules into Node — see the note at its top |
| `follow_log.js` | writes `logs/follow-*.json` and its summary |
| `public/road.js` | the road detector, shared by `/vision` and `/follow` — the competition line (blue│orange│blue), the two monochrome tape modes, the chain, the track type, where the paint stops, the 90° corner, and the junctions |
| `public/pilot.js` | the control law: error → two wheel percentages, and the corner manoeuvre. Pure |
| `public/field.js` | the competition field: the şartname's dimensions, the track graph, the planner, the dead reckoning, and the drawing both map pages use. Pure |
| `public/mission.js` | the run: a queue of moves, the 27 % scale correction, and which junction is which — the camera and the map, put together. Pure |
| `public/map.html` | the field: pick a station, watch the run |
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
npm run test:camera  # JPEG framing, QR counting, and the Pi's own numbers
npm run test:lidar   # SCN1 against webscan's golden bytes, the grid, the relay on both machines

# the printer
npm run test:marlin  # the direction table, the jogger's pacing, the HTTP surface
npm run test:serial  # the whole stack against a fake Marlin on a real pty

# both
npm run test:globals # no two scripts on a page declare the same name — 1 s
npm run test:pilot   # the control law, on its own
npm run test:field   # the map: the şartname's dimensions, the planner, the reckoning
npm run test:qrnav   # QR localisation, and the odometer heard off the wire
npm run test:mission # whole runs: does the fork end up on the load — and the cargo run
npm run test:cargo   # the lift's pin order, the QR key, recording and replaying routes
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
| `test/test_pilot.mjs` | the control law, the 90° corner manoeuvre and the speed loop, 104 checks, no browser |
| `test/test_wheels.mjs` | the shared trim, 55 checks — incl. /manual vs /follow agreement |
| `test/test_analyse.mjs` | the log analysis, incl. corners counted apart from dropouts, 63 checks, no browser |
| `test/test_sonar.mjs` | the sonar logic, 29 checks, no browser |
| `test/test_route.mjs` | dead reckoning, 43 checks, no browser |
| `test/test_field.mjs` | the map: the şartname's own dimensions recomputed out of the coordinates, the graph, the planner, and that an anchor throws drift away rather than averaging it in — 66 checks, no browser |
| `test/test_qrnav.mjs` | the nine codes on their edges, the printed texts and the strays, direction by continuity and by plan, the doubled-back leg, the anchor cancelling a pre-rotated odometer, and `nav.js` turning the exact G1 lines `/follow` and `/gcode` write into forward and a right turn — no browser |
| `test/test_mission.mjs` | whole runs on a simulated floor that moves 125–130 mm per commanded 100, against a mission that believes 127.5 — then the same runs with the camera lying in each of the ways a camera lies, the 180° at the station, and the hold at the gate. 48 checks, no browser |
| `test/test_cargo.mjs` | the lift's pin writes and their order (Q-E-Q on a slow `pinctrl`), the run cut; the QR key; a route recorded off the wire, kept on disk and replayed on the held-key schedule; DAYAN mid-replay; the real server's `/api/qr`, `/api/actuator`, `/api/cargo` with `--no-actuator` |
| `test/test_lidar_motor.mjs` | the lidar motor: volts → duty (1.6 V → 44.4 %), the clamp, the lines that would reach `lidar_pwm.py`, and the real server's `/api/lidar-motor` with `--no-lidar` |
| `test/test_scenario.mjs` | the text, the M400s and G91, the helper's lines, the runner stopping, pausing on the PLC's bekle and refusing, and the server saving and reporting |
| `test/test_buzzer.mjs` | the beep pattern, which pins go high, what counts as reversing, and the server (dry, `--no-gpio`) refusing a pin nobody wrote down — 37 checks |
| `test/test_plc.mjs` | PAKET_TX / PAKET_RX byte for byte, a full lap through the real field with the door both ways, the link against the simulator over UDP, and the rover server holding their wheels — 99 checks |
| `test/test_lidar.mjs` | the SCN1 encoder byte-for-byte against the vector webscan's Swift test pins, the grid and motion gate, the simulator's map against its true walls, the relay end to end on both machines, ARKit's tracking flags, and the mDNS announcement appearing and withdrawing — 94 checks |
| `test/test_radar.mjs` | the radar: LD06 packets (CRC, split across writes, junk before), every JSON shape and the text lines, units and radians guessed, offset / ccw / expiry / nearest / sweep rate, then the real server's radar port over UDP, TCP, HTTP, ws, TLS and wss — 61 checks, no browser |
| `test/fake_lidar.mjs` | not a test: a room swept 10×/s, sent to :8443 over any transport in any format, for watching the radar card move |
| `test/test_camera.mjs` | JPEG framing, a real QR decode, the Pi stats — 45 checks |
| `test/test_vision.mjs` | vision suite, 109 checks — real browser; the competition line built to the rules' own colours and equal thirds, with the QR patch, the paint running out, branches on each side, yellow station tape that is not one, the page's own junction readout, blue/orange room clutter and four lighting shifts, plus the older synthetic tracks and 90° corners |
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
