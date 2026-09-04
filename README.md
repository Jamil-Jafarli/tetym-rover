# Line-follower rover — Raspberry Pi

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
node server.js --port /dev/ttyUSB0  say which port
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

## Files

```
server.js          HTTP + the socket /follow drives over
marlin.js          the serial link — ok flow control, the log, the settings
                   table, the jogger that streams chunks, and DIRECTIONS, the
                   one wheel-sign map
marlin_http.js     the JSON API: validation, clamps, and what each route sends
rover.js           percent-per-wheel -> millimetres-per-chunk, the only place
                   that knows both languages
follow_log.js      run recording, for /tune

public/gcode.html  drive by hand
public/vision.html camera and detector tuning        \
public/follow.html the detector, driving             |  restored from git
public/tune.html   read a run back                   |  76bf596
public/road.js     the line detector, shared         |
public/pilot.js    steering and speed control        |
public/analyse.js  what to change after a run        |
public/wheels.js   the per-wheel trim, shared        |
public/sonar.js    obstacle distance (no hardware)   /

ender/             two Python bring-up scripts and what they are for
test/              see below
```

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

## Test

```
npm test
```

* `test_marlin.mjs` — the direction table asserted against the literal G-code,
  the jogger's pacing, what `run` accepts and rejects, and the whole HTTP
  surface against a real server with no printer attached.
* `test_serial.mjs` — the whole stack against a Marlin board on a real serial
  device: `fake_marlin.py` opens a pty and answers like a stock Creality one,
  acknowledging a move when it is *buffered* and withholding the `ok` once its
  planner is full. Every assertion in it is a bug that happened on hardware —
  a held key that produced one move and then nothing, an `M410` on every
  release, and an `ok` that authorised the wrong write. It runs the whole
  streaming check **twice**, against a board that honours `M400` and one whose
  `M400` is a lie (`M400_BLOCKS=0`), because everything passes on the first and
  none of it held on the second. Needs `python3`; it skips itself if that is
  missing.
* `test_pages.mjs` — the page in a real browser with a **fake** board behind
  it: hold a key, and assert on the request that left the browser. It also
  checks the page's stopping-distance estimate against the server's pacing,
  since those are two copies of one formula. Needs `npm i -D playwright`; it
  skips itself if that is missing.
* `test_globals.mjs` — no two scripts on one page may declare the same
  top-level name. It reads as paranoia until it happens: shared modules load
  as plain `<script>` tags into one scope, and a duplicate top-level `const` is
  a `SyntaxError` that silently kills the rest of the page. There is one page
  and one inline script today, so it currently proves nothing — it is kept for
  the moment a second script is added.

---

## History

This was two projects. The ESP32 DAC bench that used to live here drove a robot
through analog throttle signals; `ender-x` was a separate Python tool for the
printer mainboard. The printer half was ported into this server —
`ender-x/server.py` became `marlin.js` + `marlin_http.js`, and its
`index.html` became `public/gcode.html` — and the ESP32 half was then removed,
because the Pi now talks to the mainboard directly over USB.

The ESP32 code is in the git history if it is ever wanted back; the last commit
that has it is the one before this README changed.
