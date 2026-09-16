#!/usr/bin/env python3
"""A Marlin board on a pty, faithful about the two things that matter: `ok`,
and whether the planner blends one move into the next.

Test fixture for test_serial.mjs. Prints the slave device path on stdout, then
logs every line in and out to stderr with a timestamp — which is the record the
test makes its assertions against.

Real Marlin acknowledges a G1 when it is *buffered*, not when it has finished
moving, and it stops acknowledging once the planner is full. That back-pressure
is the entire flow-control contract, so it is modelled here: BLOCK_BUFFER_SIZE
moves may be outstanding, and the ok for a move that does not fit is withheld
until a slot frees.

Blending is modelled too, because the first version of this fixture timed every
move as its own trapezoid — start at rest, stop at rest — and so could never
see the bug a real rover showed at once: a held key moving in slices. Marlin
re-plans the moves waiting in its buffer every time one is added, but never the
move it is already executing. So:

  · a move that has NOT started when the next one arrives, in the same
    direction, is re-planned to flow into it: no braking at its end
  · a move that HAD started, alone, keeps the stop at its end it was planned
    with — and the next one sets off from rest. That is logged as "rest", and
    a held key that logs more than one is a key that moves in slices
  · the first move into an empty planner waits FIRST_MOVE_DELAY before it
    starts, as Marlin 2's BLOCK_DELAY_FOR_1ST_MOVE does, so that a second
    move sent straight after it can still join it

A move's speed is its feed, capped per axis by M203 and by what the planner
lets it run at with one move behind it: v² ≤ 2·a·d. That is the same model
Jogger.holdSpeed() in marlin.js predicts with — deliberately, but not
circularly: it is the physics of a planner that can see one move ahead.

Everything received and everything sent is timestamped to stderr, which is the
point of the exercise.
"""
import math
import os
import pty
import re
import sys
import termios
import threading
import time
import tty

BLOCK_BUFFER_SIZE = 16          # Marlin's planner depth
# Firmware that answers M400 without waiting for the planner. Not a straw man:
# a board that lacks M400 answers "Unknown command" and an ok just as fast, and
# the host cannot tell the difference from the outside.
M400_BLOCKS = os.environ.get("M400_BLOCKS", "1") == "1"
RX_BUFFER = 128                 # bytes; Marlin's serial ring
EMERGENCY_PARSER = os.environ.get("EMERGENCY_PARSER", "0") == "1"
ACCEL = 500.0                   # mm/s^2, matches the M204 T we report
MAX_FEED = 500.0                # mm/s per axis, matches the M203 we report
FIRST_MOVE_DELAY = 0.1          # s, Marlin 2's BLOCK_DELAY_FOR_1ST_MOVE

master, slave = pty.openpty()
# A pty echoes by default and a serial port does not. Left on, everything this
# board says comes straight back as a command, it answers "ok", and that echoes
# too — an infinite loop that has nothing to do with the thing under test.
tty.setraw(master)
tty.setraw(slave)
for fd in (master, slave):
    attrs = termios.tcgetattr(fd)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
print(os.ttyname(slave), flush=True)

T0 = time.time()
lock = threading.Lock()
# Each entry: {start, end, v, dir, rest_out} — times in time.time() seconds.
planner = []
rx_bytes = 0                    # what Marlin's serial ring is holding
overflowed = False


def log(direction, text):
    print(f"[{time.time() - T0:7.3f}] {direction} {text}", file=sys.stderr, flush=True)


def out(text):
    log("<--", text)
    os.write(master, (text + "\n").encode())


def move_seconds(dist, feed_mm_min):
    """A lone move, from rest to rest."""
    v = max(1.0, feed_mm_min / 60.0)
    if v * v / ACCEL >= dist:
        return 2.0 * math.sqrt(max(dist, 0.001) / ACCEL)
    return 2.0 * (v / ACCEL) + (dist - v * v / ACCEL) / v


def speed_for(x, y, feed_mm_min):
    dist = math.hypot(x, y)
    v = max(1.0, feed_mm_min / 60.0)
    for d in (abs(x), abs(y)):
        if d > 1e-9:
            v = min(v, MAX_FEED * dist / d)
    return max(1.0, min(v, math.sqrt(2.0 * ACCEL * max(dist, 0.001))))


def drain_planner():
    now = time.time()
    while planner and planner[0]["end"] <= now:
        planner.pop(0)


def append_move(x, y, feed):
    """Plan one move behind whatever is queued. Call with the lock held."""
    now = time.time()
    dist = math.hypot(x, y)
    direction = (x / dist, y / dist) if dist > 0 else None
    v = speed_for(x, y, feed) if dist > 0 else 1.0
    ramp = v / (2.0 * ACCEL)
    prev = planner[-1] if planner else None
    same = (prev is not None and prev["dir"] is not None and direction is not None
            and prev["dir"][0] * direction[0] + prev["dir"][1] * direction[1] > 0.999)
    if prev is not None and prev["rest_out"] and same and prev["start"] > now:
        # Not started yet: re-planned to flow straight into this one.
        prev["end"] -= prev["v"] / (2.0 * ACCEL)
        prev["rest_out"] = False
    if prev is None:
        start, rest_in = now + FIRST_MOVE_DELAY, True
    else:
        start, rest_in = prev["end"], prev["rest_out"] or not same
    if dist <= 0:
        secs = 0.0
    elif v * v / ACCEL >= dist and rest_in:
        secs = move_seconds(dist, v * 60.0)
    else:
        secs = dist / v + (ramp if rest_in else 0.0) + ramp     # it ends at rest, for now
    planner.append({"start": start, "end": start + secs, "v": v,
                    "dir": direction, "rest_out": True})
    if rest_in:
        log("   ", "rest — this move sets off from a standstill")
    log("   ", f"planner={len(planner)} (+{secs:.3f}s)")


def handle(line):
    global overflowed
    code = line.split()[0].upper() if line.split() else ""

    if code == "M115":
        out("FIRMWARE_NAME:Marlin 1.1.6 SOURCE_CODE_URL:... PROTOCOL_VERSION:1.0 "
            "MACHINE_TYPE:Ender-3 EXTRUDER_COUNT:1")
        out(f"Cap:EMERGENCY_PARSER:{1 if EMERGENCY_PARSER else 0}")
        out("ok")
        return

    if code == "M503":
        for echo in ("echo:  M92 X80.00 Y80.00 Z400.00 E93.00",
                     "echo:  M203 X500.00 Y500.00 Z5.00 E25.00",
                     "echo:  M201 X500 Y500 Z100 E5000",
                     "echo:  M204 P500.00 R1000.00 T500.00",
                     "echo:  M205 X8.00 Y8.00 Z0.40 E5.00"):
            out(echo)
        out("ok")
        return

    if code in ("M906", "M350"):
        out(f'echo:Unknown command: "{code}"')       # standalone drivers
        out("ok")
        return

    if code == "G4":
        pm = re.search(r"P(-?[\d.]+)", line)
        sm = re.search(r"S(-?[\d.]+)", line)
        secs = (float(pm.group(1)) / 1000.0) if pm else (float(sm.group(1)) if sm else 0.0)
        with lock:
            drain_planner()
            start = max(time.time(), planner[-1]["end"] if planner else 0)
            planner.append({"start": start, "end": start + secs, "v": 0.0,
                            "dir": None, "rest_out": True})
        out("ok")
        return

    if code == "M114":
        drain_planner()
        out("X:0.00 Y:0.00 Z:0.00 E:0.00 Count X:0 Y:0 Z:0")
        out("ok")
        return

    if code == "M410":
        with lock:
            planner.clear()
        out("ok")
        return

    if code == "M400":
        if not M400_BLOCKS:
            out('echo:Unknown command: "M400"')
            out("ok")
            return
        # Marlin holds this ok until every buffered move has run. It is the
        # only honest way for a host to learn that the machine has actually
        # stopped, and the whole streaming design depends on it, so the
        # fixture has to be slow here rather than obliging.
        while True:
            with lock:
                drain_planner()
                if not planner:
                    break
            time.sleep(0.005)
        out("ok")
        return

    if code in ("G0", "G1"):
        axes = dict(re.findall(r"([XY])(-?[\d.]+)", line))
        x, y = float(axes.get("X", 0)), float(axes.get("Y", 0))
        fm = re.search(r"F(-?[\d.]+)", line)
        feed = float(fm.group(1)) if fm else 1000.0

        # Withhold the ok until the planner has room. This is the back-pressure
        # a client that streams moves is supposed to feel.
        while True:
            with lock:
                drain_planner()
                if len(planner) < BLOCK_BUFFER_SIZE:
                    append_move(x, y, feed)
                    break
            time.sleep(0.01)
        out("ok")
        return

    out("ok")


def reader():
    global rx_bytes, overflowed
    buf = b""
    while True:
        try:
            chunk = os.read(master, 1024)
        except OSError:
            return
        if not chunk:
            return
        # Marlin's rx ring is 128 bytes. A client that ignores `ok` and keeps
        # writing overruns it, and the bytes that do not fit are simply lost.
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            log("-->", line)
            handle(line)


out("start")
out("echo:Marlin 1.1.6")
threading.Thread(target=reader, daemon=True).start()
while True:
    time.sleep(1)
