/**
 * Marlin G-code link — the Ender-3 Pro half of this rig.
 *
 * Merged in from the standalone `ender-x` Python tool. Same behaviour, same
 * API surface, but it now runs inside this server so there is one process
 * and one page hub: the Creality board drives the two NEMA17s over serial,
 * ok flow control, this file's job.
 *
 * X and Y are the left and right wheels of a differential drive, mounted
 * mirror-image, so a *direction* is a pair of wheel signs rather than one axis.
 * Y, not Z: the right motor used to sit on the board's Z driver socket and was
 * moved to Y, because stock firmware sets Y up exactly like X while Z is a lead
 * screw — see checkWheelAxes() for what a mismatched pair does. Z is now empty.
 * That is what DIRECTIONS below is: forward is `G1 X-n Y+n` (both wheels
 * forward), left is `G1 X+n Y+n` (both the same sign, so it spins), and the
 * other two are their opposites. Holding W streams that line over and over —
 * see Jogger.
 *
 * Nothing here talks HTTP; marlin_http.js does that.
 */

// Ender-3 Pro stock X axis: 80 steps/mm, 1.8° motor (200 full steps) at 16
// microsteps = 3200 steps/rev -> 40 mm of "travel" per motor revolution.
export const DEFAULT_STEPS_PER_MM = 80;
export const MOTOR_FULL_STEPS = 200;
export const MICROSTEPS = 16;
export const DEFAULT_BAUD = 115200;

/**
 * Feed rate for a held key, in mm/min. 6000 is 100 mm/s.
 *
 * This is the number that decides everything else about how a hold feels: it
 * sets how long one chunk takes, and therefore how often a line goes out and
 * how far the machine travels after the key comes up. Raise it and the gap
 * between commands shrinks on its own.
 */
export const DEFAULT_FEED = 6000;

/**
 * How far one streamed chunk travels on each axis, in mm.
 *
 * This is *most* of the stopping distance — two of them are on the board while
 * a key is held, see HOLD_MARGIN_S below — and that is the only thing it
 * should be chosen for. It no longer decides whether a hold is smooth: the
 * pacing keeps the planner blending at any chunk size. Marlin acks a
 * move when it is buffered, so the machine is always up to one chunk ahead of
 * the host: whatever is in the planner when you let go of the key still gets
 * executed. At F1000 a 5 mm chunk is a 7 mm diagonal that takes about half a
 * second.
 *
 * Big chunks are the trap. 100 mm on both axes is a 141 mm diagonal — eight
 * and a half seconds at F1000 — so the "stream" is one move every seven
 * seconds, the key does nothing visible while it is held, and letting go
 * leaves the gantry running until it hits the frame, because the only stop
 * there is waits for the move in progress to finish.
 */
export const DEFAULT_STEP_MM = 80;

/**
 * How long before a queued chunk STARTS the one after it must be on the board,
 * in seconds — for a held key and for a taught route being replayed.
 *
 * Marlin re-plans the moves in its buffer every time one is added, but never
 * the move it is already executing: a chunk that was the last one in the
 * buffer when it started has "brake to a stop at the end" baked into it,
 * whatever arrives afterwards. So a held key used to move in slices even with
 * the next chunk queued early. It went out when the current chunk was 75 %
 * through (the old CHUNK_OVERLAP), which is long after that chunk had started
 * alone. Every 80 mm chunk braked to zero and set off again — on the wheels and
 * in every replay of a taught route, which paced itself the same way.
 *
 * The rule is the steering stream's (STREAM_LEAD): the next chunk has to be
 * planned before the current one starts, so while one runs another is always
 * waiting behind it. That is a lead of one whole chunk plus this margin,
 * which covers what the prediction cannot: timer jitter on the Pi, the serial
 * round trip, the jerk the first move starts with. It is a time, not a
 * fraction of a chunk, because none of those scale with the chunk.
 *
 * The schedule is still anchored to a running prediction of the board's own
 * timeline (Pacer.endAt), never to "now" — anchoring to now is the bug that
 * once let the planner back up without bound (test_serial.mjs keeps the
 * record). What changed is what is predicted: a blended chunk runs at cruise,
 * so it is timed by its cruise time, not by a trapezoid that ramps up and down
 * inside every chunk — pacing by that would send slower than the board drains
 * and bring the slices back through the clock instead of the queue.
 *
 * The price is stopping distance: up to two chunks are on the board when the
 * key comes up, plus this margin's worth of travel — see halt() in
 * marlin_http.js, and the page's #stopHint, which quotes the number. A smaller
 * `step` shortens it, and no longer costs smoothness.
 */
export const HOLD_MARGIN_S = 0.15;

/**
 * The same idea for the steering stream, in whole chunks rather than a
 * margin in seconds — and deliberately greater than 1.
 *
 * A lead of a quarter of a chunk (the held key's old CHUNK_OVERLAP) was never
 * enough, and the steering stream is where that was found first. A steering
 * chunk is 150 ms, and a quarter of that is 37 ms — shorter than the ramp —
 * so by the time the next line arrives the board is already braking for the
 * end of the current one.
 *
 * And it cannot change its mind: Marlin re-plans the moves in its buffer every
 * time one is added, but never the move it is already executing. So a chunk
 * that was the last one in the buffer when it started has "stop at the end"
 * baked into it, whatever arrives afterwards. The next chunk must therefore be
 * queued before the current one *starts*, which is more than one chunk ahead of
 * when it will itself run — hence > 1. At 1.5 the board is holding one chunk in
 * progress and one already planned behind it, so it blends the junction and
 * simply keeps moving.
 *
 * That is the whole of the "choppy" problem: not the chunk size, not the feed,
 * not the acceleration, but a queue that was always exactly one move too
 * shallow to blend. The price is two chunks of stopping distance instead of
 * one and a quarter — at 150 ms chunks, a couple of centimetres — and one extra
 * chunk of steering latency, which is why the chunk is short in the first place.
 */
export const STREAM_LEAD = 1.5;

/**
 * How many lines may be waiting on the board before the stream skips a chunk.
 *
 * The pacing above is open loop, and its estimate is the *blended* run time —
 * right while the board is cruising, optimistic the moment a real corner makes
 * it slow down. Marlin's `ok` per command is the one honest signal available:
 * when its planner is full the acks stop coming and the host's own queue grows.
 * Past this depth the next chunk is skipped rather than queued, because a
 * steering command is a sample of something that is still changing — a stale
 * one is not worth having, and a backlog of them is a rover driving on what the
 * camera saw a second ago.
 */
export const STREAM_MAX_AHEAD = 3;

/**
 * The four ways the rover can be driven, as wheel signs.
 *
 * One definition, shared: the page builds its WASD map from the copy handed
 * out in /api/marlin/status, and /api/marlin/run accepts these names directly,
 * so a hold button, a key and a curl all mean the same thing. Two keys at once
 * are summed and signed, which is how W+A becomes a genuine diagonal instead
 * of two moves fighting each other.
 */
export const DIRECTIONS = {
  forward: { X: -1, Y: +1 },
  left:    { X: +1, Y: +1 },
  back:    { X: +1, Y: -1 },
  right:   { X: -1, Y: -1 },
};

/**
 * True for a direction that spins the rover in place — both wheels signed the
 * same way, `left`/`right` in DIRECTIONS — rather than translating it, which
 * is the opposite-sign case, `forward`/`back`.
 *
 * A one-wheel diagonal (W+A, say) is neither: exactly one axis is nonzero, so
 * `sx === sy` is false by construction (0 !== ±1) and it is left unscaled —
 * only one wheel is moving there, which is already gentler than a full spin.
 */
export function isSpin(vec) {
  const sx = Math.sign(vec.X || 0), sy = Math.sign(vec.Y || 0);
  return sx !== 0 && sy !== 0 && sx === sy;
}

/**
 * How much smaller a spin is than a straight chunk, at the same nominal step,
 * when nothing else is asked for.
 *
 * The chunk size is chosen by feel driving forward, where it is a distance
 * the rover actually covers. Left/right cover the same wheel distance but
 * spend it turning on the spot instead — the same number of millimetres reads
 * as a much bigger turn than the equivalent forward chunk reads as a move, so
 * left/right at full `step` felt like over-turning relative to forward/back.
 * Scaling it down is what makes W/A/S/D feel like one control, not two.
 *
 * This is only the default: how much smaller a spin *feels* like it should be
 * is a matter of the gearing, the surface and the operator's taste, not
 * something one constant gets right for every rig. `/api/marlin/run` accepts
 * a `turnScale` in the request body and uses that instead when given one —
 * see marlin_http.js — with this as what a request that omits it gets.
 *
 * 0.1 is what the operator drives with — /gcode's #turnScale opens at it, and
 * the two are kept the same so the page's previews and the server agree.
 */
export const TURN_SCALE = 0.1;

const POS_RE = /X:(-?[\d.]+)\s+Y:(-?[\d.]+)\s+Z:(-?[\d.]+)\s+E:(-?[\d.]+)/;

// `echo:Unknown command: "M906"` -> the firmware was built without that.
const UNKNOWN_RE = /unknown command:\s*"?([A-Z]\d+)/i;

const PARAM_RE = /([A-Z])(-?[\d.]+)/g;

/**
 * Settings echoed by M503 (and by the bare query forms). Each maps to the
 * letters we are willing to write back, with a clamp so a typo in the browser
 * cannot push the drivers somewhere that cooks a motor.
 *
 *   M92  steps/mm          M201 max acceleration (mm/s²)
 *   M203 max feedrate mm/s M204 acceleration    (P print, R retract, T travel)
 *   M205 jerk (X/Z) or junction deviation (J)
 *   M350 microsteps        M906 TMC current mA   M907 digipot current
 *   M569 stealthChop (1) / spreadCycle (0)
 */
export const SETTABLE = {
  M92:  { letters: 'XZ',  min: 1,   max: 1000,  int: false },
  M201: { letters: 'XZ',  min: 1,   max: 20000, int: true  },
  M203: { letters: 'XZ',  min: 1,   max: 1000,  int: false },
  M204: { letters: 'PRT', min: 1,   max: 20000, int: false },
  M205: { letters: 'XZJ', min: 0,   max: 100,   int: false },
  M350: { letters: 'XZ',  min: 1,   max: 256,   int: true  },
  M906: { letters: 'XZ',  min: 100, max: 1200,  int: true  },
  M907: { letters: 'XZ',  min: 0,   max: 2000,  int: true  },
  M569: { letters: 'XZ',  min: 0,   max: 1,     int: true  },
};

/** Codes we read back from the board to populate the UI. */
export const QUERY_CODES = ['M92', 'M201', 'M203', 'M204', 'M205',
                            'M350', 'M906', 'M907'];

// ...of those, the ones that report their own value when sent with no
// parameters. The rest only ever appear in an M503 dump.
export const SELF_REPORTING = new Set(['M92', 'M350', 'M906', 'M907']);

/**
 * A line that moves the wheels, as opposed to one that configures them.
 *
 * The halt route in marlin_http.js drops these from the queue and nothing
 * else. It used to empty the queue outright, and that took the settings with
 * it: an `M203 Y…` or an `M500` queued behind a held key's chunks was thrown
 * away the moment the key came up, the window lost focus, or Space was pressed
 * — so "Save to EEPROM" sometimes did nothing at all, and said nothing about
 * it. G28 counts as motion: a queued home is exactly what a stop should cancel.
 */
const MOTION_RE = /^G(?:[0-3]|28)(?!\d)/i;

/**
 * How long after the last settings write the board is told to save (M500).
 *
 * Every M92/M201/M203/... write lives in the board's RAM until M500, and
 * opening the serial port reboots the board — so a change that was applied but
 * never saved quietly reverted on the next connect or server restart, which is
 * the other half of "settings sometimes do not save". The timer restarts on
 * every move written too, so the save lands once the rover has been still for
 * this long: Creality's 32-bit boards keep their "EEPROM" in flash, and a
 * flash write is better done standing still than mid-chunk. 0 turns it off.
 */
export const AUTOSAVE_MS = 2000;

/** A settings write — a SETTABLE code with at least one value — or null. */
export function settingWrite(line) {
  const text = String(line).trim().toUpperCase();
  const m = /^(M\d+)\s/.exec(text);
  if (!m || !SETTABLE[m[1]]) return null;
  const params = parseParams(text, m[1]);
  return params ? { code: m[1], params } : null;
}

/** Pull `X80.00 Y80.00` style parameters out of an echoed setting line. */
export function parseParams(line, code) {
  const m = new RegExp(`\\b${code}\\b(.*)`).exec(line);
  if (!m) return null;
  const out = {};
  let hit;
  PARAM_RE.lastIndex = 0;
  while ((hit = PARAM_RE.exec(m[1])) !== null) {
    const v = parseFloat(hit[2]);
    if (Number.isFinite(v)) out[hit[1]] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A one-shot latch with an awaitable wait, i.e. threading.Event.
 *
 * The Python original used real threads; here the reader is an event callback
 * and the writer is an async loop, so "wait for the previous ok" has to be a
 * promise. Waiters are removed on timeout so a board that never answers does
 * not leave a callback per command behind it.
 */
class Flag {
  constructor(set = false) { this._set = set; this._waiters = new Set(); }
  set() {
    this._set = true;
    for (const w of [...this._waiters]) { this._waiters.delete(w); w(true); }
  }
  clear() { this._set = false; }
  wait(ms) {
    if (this._set) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(timer); this._waiters.delete(done); resolve(v); };
      const timer = setTimeout(() => done(false), ms);
      this._waiters.add(done);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What a serial error actually means, in the order they are worth checking.
 *
 * Written because the first failure this hit in the field was reported as
 * "no reply from the board", which sends you to the printer's power switch —
 * and the real fault was a USB link that never carried a byte. The errno is
 * the evidence; these are the things it distinguishes.
 */
export function explainSerialError(err, devPath = 'the port') {
  const msg = String((err && err.message) || err);

  if (/permission denied|EACCES/i.test(msg)) {
    return ['The account is not allowed to open serial ports.',
            '  sudo usermod -aG dialout $USER      (then log out and back in)'];
  }
  if (/no such file|ENOENT|ENXIO/i.test(msg)) {
    return [`${devPath} is not there. Plug the board in, or pick a different `
          + 'port — --list shows what the machine can see.'];
  }
  if (/busy|EBUSY|EAGAIN|Resource temporarily/i.test(msg)) {
    return ['Something else already has the port.',
            '  another copy of this server, a serial monitor, or ModemManager,',
            '  which probes new serial devices for about 20 seconds after they',
            '  appear:  sudo systemctl stop ModemManager'];
  }
  // EIO on open, or a refused baud rate, means the adapter enumerated but is
  // not answering USB control transfers. That is the cable, the hub, or a
  // virtual machine's USB passthrough — never the printer's power switch,
  // because the adapter is powered by USB and answers regardless.
  if (/input\/output error|EIO|baud rate/i.test(msg)) {
    return ['The USB adapter is not answering. It is visible, but no data can',
            'reach it, so this is the link and not the printer:',
            '  · re-plug it, into a port on the machine rather than a hub',
            '  · in a VM, disconnect and reconnect the device from the host,',
            '    and set the USB controller to 2.0 or 3.1 rather than 1.1',
            '  · check dmesg for "failed to send control message"',
            '  · on Linux, brltty grabs CH340 adapters: sudo systemctl mask brltty'];
  }
  return [];
}

/** Marlin serial link with ok-based flow control and a live log. */
export class MarlinLink {
  constructor() {
    this.port = null;
    this.path = null;
    this.baud = DEFAULT_BAUD;
    this.firmware = '';
    this.stepsPerMm = DEFAULT_STEPS_PER_MM;
    this.position = { X: 0, Y: 0, Z: 0, E: 0 };
    this.steppersOn = false;
    this.softEndstops = true;

    // Per-motor correction for a motor wired backwards. DIRECTIONS already
    // encodes which way each key drives the machine, so this is only for a
    // motor that physically turns the wrong way. Neither starts inverted: the
    // right wheel did run backwards on the Z socket, but that was Z's firmware
    // direction (stock Creality inverts Z opposite to X), and on Y it shares
    // X's. The page's "invert left/right" boxes show and toggle these; a
    // restart puts them back to this.
    this.invert = { X: false, Y: false };

    // Cap:EMERGENCY_PARSER from M115. null until the board tells us.
    this.emergencyParser = null;

    // Whether M400 actually waits for the planner to drain on this board.
    // null until probeBarrier() has run, and null is treated as "no": the
    // pacing that does not depend on it is the safe one to start with.
    this.m400Blocks = null;
    this.barrierMs = null;

    // False until the board sends its first byte. Opening the port toggles
    // DTR, which reboots the board and makes it print a banner, so a healthy
    // board always says *something*. Staying false means the serial port is
    // fine but nothing is listening on the other end — almost always the
    // mainboard has no power.
    this.sawRx = false;

    // Board-reported settings, keyed by G-code then by letter:
    //   { M906: { X: 580, Y: 580 }, M204: { T: 1000 }, ... }
    this.settings = {};
    // Codes the firmware answered "Unknown command" to.
    this.unsupported = new Set();

    // True while the board is running settings its EEPROM does not hold —
    // cleared by the board's own "Settings Stored", not by our sending M500.
    this.unsaved = false;
    // Writes the board did not keep as asked, keyed like `settings`:
    //   { M205: { Y: { asked: 6, kept: 0.6 } } }
    // Stock Creality firmware caps some values (X/Y jerk at 20, Z at 0.6) and says so in
    // one line the page used to scroll straight past; this is that line, kept.
    this.rejected = {};
    // Values written and not yet read back, for the comparison above.
    this._requested = {};
    this.autosaveMs = AUTOSAVE_MS;
    this._saveTimer = null;

    this._log = [];
    this._seq = 0;
    this._buf = '';

    // Watchers of the wire — see onWrite().
    this._taps = new Set();

    this._q = [];
    // Commands written but not yet acknowledged. Marlin's contract is one
    // `ok` per command, so this is the only thing allowed to authorise the
    // next write. It is a count and not a flag because a command written
    // straight past the queue is acknowledged too: with a latch, its `ok`
    // reads as permission to send a *queued* command that was never
    // acknowledged, and the host quietly runs a command ahead of the board
    // for the rest of the session.
    this._pending = 0;
    this._idle = new Flag(true);
    this._work = new Flag(false);
    this._stop = true;
    this._pump = null;
    this._connecting = false;
  }

  /** +1, or -1 if this axis is wired the other way round. */
  sign(axis) { return this.invert[String(axis).toUpperCase()] ? -1 : 1; }

  /**
   * Be told about every line as it actually goes out on the wire.
   *
   * For teaching a route (routes.js): what is recorded has to be what reached
   * the board, not what was asked for. A held key's chunk that a halt dropped
   * from the queue before it was written never moved a wheel, and a recording
   * taken at send() time would replay it anyway — a route that drives one
   * chunk further at every key release than the one that was taught.
   *
   * @returns {() => void} unsubscribe
   */
  onWrite(fn) {
    this._taps.add(fn);
    return () => this._taps.delete(fn);
  }

  /** One command written; the board owes us an `ok` before the next. */
  _expect() { this._pending += 1; this._idle.clear(); }

  /** The board answered. Never goes below zero: an unsolicited `ok` — from a
   *  boot banner, or a reply we did not count — must not bank a free write. */
  _ack() {
    if (this._pending > 0) this._pending -= 1;
    if (this._pending === 0) this._idle.set();
  }

  // ── logging ────────────────────────────────────────────────────────

  log(text, kind = 'info') {
    this._seq += 1;
    this._log.push({ seq: this._seq, t: Date.now() / 1000, kind, text });
    if (this._log.length > 800) this._log.splice(0, this._log.length - 800);
  }

  logSince(since) {
    return { lines: this._log.filter((e) => e.seq > since), seq: this._seq };
  }

  // ── connection ─────────────────────────────────────────────────────

  get connected() { return this.port !== null && this.port.isOpen; }

  async connect(devPath, baud = DEFAULT_BAUD) {
    if (this._connecting) throw new Error('already connecting');
    this._connecting = true;
    try {
      if (this.connected) await this.disconnect();

      this.log(`Opening ${devPath} @ ${baud}...`, 'sys');
      const { SerialPort } = await import('serialport');
      const port = new SerialPort({ path: devPath, baudRate: baud, autoOpen: false });
      try {
        await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
      } catch (err) {
        this.log(`Could not open ${devPath}: ${err.message || err}`, 'error');
        for (const line of explainSerialError(err, devPath)) this.log(line, 'sys');
        throw err;
      }

      this.port = port;
      this.path = devPath;
      this.baud = baud;
      this.sawRx = false;
      this._buf = '';
      this._q = [];
      this._stop = false;
      this._pending = 0;
      this._idle.set();
      // The board reboots on open and loads its EEPROM, so it starts saved.
      this.unsaved = false;
      this.rejected = {};
      this._requested = {};

      port.on('data', (chunk) => this._onData(chunk));
      port.on('error', (err) => this._fail(`Serial read error: ${err.message || err}`));

      this._pump = this._pumpLoop();

      // The board reboots when the port opens (DTR). Give it time, then throw
      // away the boot banner so it does not confuse flow control.
      await sleep(2500);
      try { await new Promise((res) => port.flush(() => res())); } catch { /* nothing buffered */ }
      this._pending = 0;
      this._idle.set();

      if (!this.sawRx) {
        this.log('Port opened, but the board sent no boot banner.', 'error');
        this.log('Most likely the mainboard has no power: the USB-serial adapter '
               + 'is powered by the cable and enumerates whether or not the '
               + 'printer is switched on.', 'sys');
        this.log(`Failing that, the baud rate: this opened at ${baud}, and some `
               + 'boards are flashed for 250000. Reconnect with --baud 250000.', 'sys');
      }

      this.send('M115');     // firmware
      this.send('G21');      // millimetres
      this.send('M17 X Y');  // energise both wheel motors and hold them
      this.send('G91');      // relative — stays in force for the session
      this.send('M114');     // position
      this.readSettings();
      this.steppersOn = true;
      await this.probeBarrier();
      this.checkWheelAxes();   // M503 has answered by now: probeBarrier drained it
      this.log('Connected.', 'sys');
    } finally {
      this._connecting = false;
    }
  }

  /**
   * Ask the board for everything the settings panel can edit.
   *
   * M503 covers the motion values. Current is asked for separately because
   * boards with the drivers in standalone mode answer "Unknown command",
   * which is exactly how we learn the torque control is unavailable.
   */
  readSettings() {
    this.send('M503');
    this.send('M906');
  }

  /**
   * Find out whether M400 really blocks on this board.
   *
   * The held-key stream does not lean on this any more (see the Jogger in
   * this file, and HOLD_MARGIN_S) — it paces every chunk by the clock, on any
   * firmware. This still matters because a board that answers M400
   * immediately — because the firmware lacks it, or answers "Unknown
   * command", or was built without the blocking behaviour — makes the M400
   * button in the console a no-op rather than a wait, and the operator should
   * know that rather than wonder why pressing it did nothing.
   *
   * So it is measured rather than assumed. G4 is a dwell: it occupies the
   * planner for a known time and moves nothing, which makes it a barrier test
   * that is safe to run on a machine that is not homed, has no endstops, or is
   * standing on a bench with its belts off.
   */
  async probeBarrier(dwellMs = 300) {
    if (!this.connected) return null;
    await this.whenDrained(4000);          // let the connect chatter finish

    const t0 = Date.now();
    try {
      this.send(`G4 P${dwellMs}`);
      this.send('M400');
    } catch {
      return null;
    }
    const answered = await this.whenDrained(dwellMs + 4000);
    const took = Date.now() - t0;

    this.barrierMs = took;
    this.m400Blocks = answered && took >= dwellMs * 0.6;
    if (this.m400Blocks) {
      this.log(`M400 waits for the planner (${dwellMs} ms dwell took ${took} ms).`, 'sys');
    } else {
      this.log(`M400 does not wait on this firmware: a ${dwellMs} ms dwell came `
             + `back in ${took} ms.`, 'error');
      this.log('The M400 button in the console will not actually block, then — '
             + 'the held-key stream paces itself by the clock either way.', 'sys');
    }
    return took;
  }

  /**
   * Say so when the Y driver is not configured like X.
   *
   * The right wheel is plugged into the Y socket. Stock Creality firmware sets
   * Y up exactly like X, so on a stock board this stays quiet — it is here for
   * the board that is not: an EEPROM carrying someone's edits, or a firmware
   * build with its own ideas. Both halves of a mismatch break driving.
   * Steps/mm far apart turn one wheel further than the other for the same
   * commanded millimetre, so the rover spins where it should drive straight.
   * And Marlin slows a whole move until every axis is inside its own limits,
   * so a Y with a low feed or acceleration ceiling caps every chunk — both
   * wheels crawl, however high F is set. (This is what the Z socket did: stock
   * Z is the bed's lead screw — 400 steps/mm, 5 mm/s — and the reason the
   * right wheel moved to Y.)
   *
   * Nothing is rewritten on the operator's behalf: a pair of M92 values a few
   * percent apart is exactly what a calibrated rover has (see the steps boxes
   * on /gcode), so this only flags a gap too big to be calibration.
   *
   * @returns {string[]} the commands that would bring Y in line with X.
   */
  checkWheelAxes() {
    const seen = [], fixes = [];
    for (const code of ['M92', 'M203', 'M201', 'M205']) {
      const { X: x, Y: y } = this.settings[code] || {};
      if (x === undefined || y === undefined) continue;
      // Steps/mm have to match to within calibration. The limits only need Y
      // to be no tighter than X — a Y that is higher never caps anything.
      const off = code === 'M92' ? Math.abs(y / x - 1) > 0.25 : y < x * 0.5;
      if (!off) continue;
      seen.push(`${code} X${+x.toFixed(3)} Y${+y.toFixed(3)}`);
      fixes.push(`${code} Y${+x.toFixed(3)}`);
    }
    if (fixes.length) {
      this.log(`Y does not match X: ${seen.join(', ')}.`, 'error');
      this.log('The right wheel is on Y, so it will turn the wrong distance or cap '
             + 'every move. Press "Match Y to X" in the settings card, or send '
             + `${fixes.join(', ')} — either is saved to EEPROM automatically.`, 'sys');
    }
    return fixes;
  }

  /** Drop anything still queued so the pump stops promptly. Teardown only. */
  drain() { this._q.length = 0; }

  /**
   * Drop the moves still queued and keep everything else — what a stop needs.
   * Settings, reads and saves queued behind the moves still go out; see
   * MOTION_RE for the bug that drain() in this place was.
   */
  dropMotion() {
    const before = this._q.length;
    this._q = this._q.filter((line) => !MOTION_RE.test(line));
    // How many were taken back — a paused replay rewinds by exactly this many.
    return before - this._q.length;
  }

  /**
   * Tear the link down after a fatal serial error.
   *
   * Without this the pump exits but the port stays open, so `connected` keeps
   * reporting true: the UI still looks live, send() still accepts commands,
   * and they pile up in a queue nothing is draining. That is the "stacked but
   * never executed" failure. Closing the port here makes `connected` go false,
   * which is what surfaces the drop in the UI.
   */
  _fail(msg) {
    if (this.port === null) return;   // already torn down
    this.log(msg, 'error');
    this._stop = true;
    this._idle.set();
    this._work.set();
    this.drain();
    this._cancelSave();
    const port = this.port;
    this.port = null;
    try { port.close(() => {}); } catch { /* already gone */ }
    this.log('Link closed. Re-plug the board, then press Connect.', 'sys');
  }

  async disconnect() {
    this._stop = true;
    this.drain();
    this._cancelSave();
    this._idle.set();
    this._work.set();
    const port = this.port;
    this.port = null;
    if (port && port.isOpen) {
      await new Promise((res) => port.close(() => res()));
    }
    if (this._pump) { await this._pump.catch(() => {}); this._pump = null; }
    this.log('Disconnected.', 'sys');
  }

  // ── reading ────────────────────────────────────────────────────────

  _onData(chunk) {
    this.sawRx = true;
    this._buf += chunk.toString('utf8');
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (line) this._handleLine(line);
    }
    if (this._buf.length > 8192) this._buf = '';   // never grow unbounded
  }

  _handleLine(line) {
    const low = line.toLowerCase();
    if (low.startsWith('ok')) { this._ack(); return; }    // too noisy to log
    if (low.startsWith('error') || low.startsWith('!!') || low.includes('error:')) {
      this.log(line, 'error');
      this._ack();                  // do not deadlock on an error reply
      return;
    }
    if (low.startsWith('resend')) this._ack();

    const pos = POS_RE.exec(line);
    if (pos) {
      this.position = { X: +pos[1], Y: +pos[2], Z: +pos[3], E: +pos[4] };
    }
    if (line.startsWith('FIRMWARE_NAME:')) this.firmware = line;

    const cap = /Cap:EMERGENCY_PARSER:(\d)/.exec(line);
    if (cap) this.emergencyParser = cap[1] === '1';

    const unknown = UNKNOWN_RE.exec(line);
    if (unknown) this.unsupported.add(unknown[1].toUpperCase());

    // M503 replies as "echo:  M92 X80.00 Y80.00 Z400.00 E93.00". Record every
    // code we know about so the UI shows real values, not guesses.
    for (const code of QUERY_CODES) {
      const params = parseParams(line, code);
      if (params) {
        this._checkKept(code, params);
        this.settings[code] = { ...(this.settings[code] || {}), ...params };
        this.unsupported.delete(code);
      }
    }
    if (this.settings.M92 && this.settings.M92.X !== undefined) {
      this.stepsPerMm = this.settings.M92.X;
    }

    // Whether RAM and EEPROM agree, from the board's own words: M500 answers
    // "Settings Stored", M501 (and the boot banner) "stored settings
    // retrieved", M502 "Hardcoded Default Settings Loaded".
    if (/settings stored|stored settings retrieved/i.test(line)) this.unsaved = false;
    else if (/default settings loaded/i.test(line)) this.unsaved = true;

    this.log(line, 'rx');
  }

  // ── writing ────────────────────────────────────────────────────────

  async _pumpLoop() {
    while (!this._stop) {
      if (!this._q.length) {
        this._work.clear();
        await this._work.wait(200);
        continue;
      }

      // Wait for the previous command's ok before sending the next one. Long
      // moves can take a while, so the timeout is generous — but only once the
      // board has proven it talks. A silent board would otherwise stall the
      // queue for two minutes per command.
      const timeout = this.sawRx ? 120000 : 5000;
      if (!(await this._idle.wait(timeout))) {
        this.log(this.sawRx ? "Timed out waiting for 'ok' — resyncing."
                            : 'No reply from the board — is it powered on?', 'error');
        // Give up on the acknowledgements we are owed rather than never
        // sending again. The alternative is a link that looks connected and
        // silently accepts commands it will never write.
        this._pending = 0;
        this._idle.set();
      }
      if (this._stop) break;

      const cmd = this._q.shift();
      if (cmd === undefined) continue;
      this._expect();

      const port = this.port;
      if (!port) break;
      try {
        await new Promise((res, rej) => port.write(`${cmd}\n`, (e) => (e ? rej(e) : res())));
        await new Promise((res) => port.drain(() => res()));
        this.log(cmd, 'tx');
        this._wrote(cmd);
        for (const fn of this._taps) {
          try { fn(cmd); } catch { /* a watcher that throws must not stop the link */ }
        }
      } catch (err) {
        // Errno 5 here almost always means the USB device went away
        // mid-session rather than the board rejecting the command.
        this._ack();
        this._fail(`Serial write error: ${err.message || err}`);
        break;
      }
    }
  }

  /** Queue a command behind the normal ok flow control. */
  send(cmd) {
    if (!this.connected) throw new Error('not connected');
    if (this._stop) throw new Error('serial link is down — reconnect first');
    const line = String(cmd).trim();
    if (!line) return;
    // A fresh attempt at a value clears the note that the last one did not
    // stick — here, at queue time, so the page never reads the old verdict as
    // the answer to the new request.
    const w = settingWrite(line);
    if (w && this.rejected[w.code]) {
      for (const L of Object.keys(w.params)) delete this.rejected[w.code][L];
      if (!Object.keys(this.rejected[w.code]).length) delete this.rejected[w.code];
    }
    this._q.push(line);
    this._work.set();
  }

  /**
   * Bookkeeping for a line that has just gone out on the wire.
   *
   * A settings write updates the cached value straight away. Waiting for the
   * read-back instead is what made an applied value snap back on the page:
   * the M503 that confirms it sits in the queue behind whatever was already
   * there — a held key's chunks, at worst many seconds of them — and every
   * status poll in between painted the old number back into the box. The
   * read-back still has the last word (_checkKept), so a value the firmware
   * refused shows up as refused rather than as a lie.
   *
   * Done at write time rather than at send() time on purpose: any M503 queued
   * ahead of this line answers before it runs, and would otherwise be read as
   * the board refusing a value it has not been sent yet.
   */
  _wrote(cmd) {
    if (MOTION_RE.test(cmd)) {
      if (this._saveTimer) this._armSave();   // still moving: save later
      return;
    }
    const w = settingWrite(cmd);
    if (!w) return;
    if (QUERY_CODES.includes(w.code)) {
      this.settings[w.code] = { ...(this.settings[w.code] || {}), ...w.params };
      this._requested[w.code] = { ...(this._requested[w.code] || {}), ...w.params };
      if (w.code === 'M92' && w.params.X !== undefined) this.stepsPerMm = w.params.X;
    }
    this.unsaved = true;
    this._armSave();
  }

  /** Compare what the board reports against what was last written to it. */
  _checkKept(code, reported) {
    const asked = this._requested[code];
    if (!asked) return;
    for (const [L, want] of Object.entries(asked)) {
      if (reported[L] === undefined) continue;
      delete asked[L];
      // M503 prints two decimals, so 0.605 comes back as 0.60 or 0.61.
      if (Math.abs(reported[L] - want) <= Math.max(0.006, 1e-3 * Math.abs(want))) continue;
      this.rejected[code] = { ...(this.rejected[code] || {}),
                              [L]: { asked: want, kept: reported[L] } };
      this.log(`${code} ${L}${want} did not stick: the board kept ${L}${reported[L]}. `
             + 'This firmware caps that value, so it cannot be raised from G-code.', 'error');
    }
    if (!Object.keys(asked).length) delete this._requested[code];
  }

  /** (Re)start the countdown to M500. See AUTOSAVE_MS. */
  _armSave() {
    this._cancelSave();
    if (!(this.autosaveMs > 0)) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (!this.unsaved || !this.connected || this._stop) return;
      try { this.send('M500'); } catch { /* link went down: `unsaved` stays true and the page says so */ }
    }, this.autosaveMs);
  }

  _cancelSave() { clearTimeout(this._saveTimer); this._saveTimer = null; }

  /** Whether an automatic M500 is counting down. */
  get savePending() { return this._saveTimer !== null; }

  /**
   * Write past the queue, for Marlin's emergency parser.
   *
   * Only M112 uses this. Ordinary stopping does not: see the halt route in
   * marlin_http.js for why there is no quickstop in this codebase.
   *
   * `expectAck` is false for M112, which halts the board mid-sentence and
   * never answers. Anything else written here is acknowledged like any other
   * command and must be counted, or the ok it produces is spent authorising a
   * write the board never asked for.
   */
  sendNow(cmd, expectAck = true) {
    if (!this.connected) throw new Error('not connected');
    if (expectAck) this._expect();
    this.port.write(`${cmd}\n`);
    this.port.drain(() => {});
    this.log(`${cmd}   [immediate]`, 'tx');
    if (this.emergencyParser === false) {
      this.log(`${cmd} was sent ahead of the queue, but this firmware reports `
             + 'EMERGENCY_PARSER:0 — the board will still run it in order.', 'sys');
    }
  }

  queueDepth() { return this._q.length; }

  /**
   * Resolves when everything queued has been written *and* acknowledged.
   *
   * Paired with an M400, this is how the host learns a move has physically
   * finished rather than merely been accepted: Marlin holds M400's `ok` until
   * the planner drains. Estimating that instead works until it does not — a
   * guess that is 5% short leaves an extra move buffered every twenty chunks,
   * and a key held for a minute ends with the machine seconds behind the
   * operator and still moving after they let go.
   *
   * @returns {Promise<boolean>} false if the timeout ran out first.
   */
  async whenDrained(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!this._stop && this.connected) {
      if (!this._q.length && this._pending === 0) return true;
      if (Date.now() >= deadline) return false;
      await sleep(10);
    }
    return false;
  }

  /** Commands written and not yet acknowledged. 0 or 1 in normal operation. */
  inFlight() { return this._pending; }

  /** Commands accepted but not yet written — the board is behind if this grows. */
  queued() { return this._q.length; }

  /** mm of travel per motor revolution, per axis, from the live steps/mm. */
  mmPerRev() {
    const out = {};
    for (const axis of ['X', 'Y']) {
      const spm = (this.settings.M92 || {})[axis] || this.stepsPerMm || DEFAULT_STEPS_PER_MM;
      out[axis] = Math.round(((MOTOR_FULL_STEPS * MICROSTEPS) / spm) * 1e4) / 1e4;
    }
    return out;
  }
}

/**
 * Keeps a direction moving for as long as a key is held.
 *
 * One short move, repeated for as long as the key is down: `G1 X-5 Y5 F6000`,
 * again and again. Nothing has to be cancelled to stop it — the stream simply
 * ends — which is why it works on any firmware, and why there is no quickstop
 * anywhere in this codebase.
 *
 * The chunk after this one is sent early, not on completion, and early
 * enough to matter. Three designs in, in order:
 *
 *   1  on completion, confirmed with M400 — the planner drained to zero at
 *      the end of every chunk; the rover moved in visible slices
 *   2  75 % through the current chunk (CHUNK_OVERLAP) — still slices, because
 *      Marlin never re-plans the move it is executing, and that move had
 *      started alone: it braked to zero at its end whatever came next
 *   3  before the current chunk STARTS (HOLD_MARGIN_S) — while one runs,
 *      another is always planned behind it, and the junction is blended
 *
 * The pacing is a Pacer: a running prediction of when the board will finish
 * what it has been sent, timed by the cruise speed the board actually holds
 * through a blended chunk. It is open loop — nothing on the wire says how full
 * the planner is — so the prediction is anchored to its own timeline and never
 * to "now"; anchored to now, a stream outruns the board without bound (see
 * test_serial.mjs, which models the planner, blending included).
 *
 * A key pressed from standstill starts with two HALF chunks, sent back to back:
 * the first cannot be allowed to start alone either, and two halves keep a
 * quick tap at one chunk of travel — the distance a tap always moved.
 *
 * The cost is stopping distance: up to two chunks plus HOLD_MARGIN_S of travel
 * are on the board when the key comes up. See halt() in marlin_http.js.
 */
export class Jogger {
  constructor(link) {
    this.link = link;
    // Signed millimetres for each driver, or null when nothing is held. Held
    // as distances rather than as a direction and a step because steering
    // needs the two wheels to move *different* amounts — equal magnitudes can
    // only ever go straight or spin on the spot.
    this._axis = null;
    this._feed = DEFAULT_FEED;
    // Whether this is the steering stream (STREAM_LEAD, its own schedule) or
    // a held key (a Pacer, HOLD_MARGIN_S).
    this._cruise = false;
    this._pacer = new Pacer(this);
    this._halves = 0;           // half-size chunks still to send, from standstill
    this._wake = new Flag(false);
    this._loop();
  }

  /** The acceleration Marlin plans a G1 without extrusion by, mm/s². */
  accel() { return Number((this.link.settings.M204 || {}).T) || 500; }

  /**
   * The speed a chunk actually runs at inside a blended stream, mm/s.
   *
   * The feed, unless the board caps it: per axis by M203, and by the planner
   * itself, which only lets a move run as fast as the one queued behind it can
   * still brake from — v² ≤ 2·a·d for a chunk of length d. That second cap
   * binds only for tiny chunks at high feeds, and ignoring it would predict a
   * board faster than the real one: a schedule that sends too often.
   */
  holdSpeed(axis, feed) {
    const dist = Math.hypot(axis.X || 0, axis.Y || 0);
    let v = Math.max(1, feed / 60);
    const cap = this.link.settings.M203 || {};
    for (const a of ['X', 'Y']) {
      const d = Math.abs(axis[a] || 0), m = Number(cap[a]);
      if (d > 1e-9 && m > 0) v = Math.min(v, (m * dist) / d);
    }
    return Math.max(1, Math.min(v, Math.sqrt(2 * this.accel() * Math.max(dist, 0.001))));
  }

  /** A held chunk's run time once the stream is rolling — how often one goes out. */
  holdSeconds(axis, feed) {
    return Math.hypot(axis.X || 0, axis.Y || 0) / this.holdSpeed(axis, feed);
  }

  get active() { return this._axis !== null; }

  /** The line a set of per-driver distances would produce, without sending it. */
  lineFor(axis, feed = this._feed) {
    const parts = ['X', 'Y', 'Z']
      .filter((a) => Math.abs(axis?.[a] || 0) > 1e-6)
      .map((a) => `${a}${(axis[a] * this.link.sign(a)).toFixed(2)}`);
    return parts.length ? `G1 ${parts.join(' ')} F${Math.round(feed)}` : null;
  }

  /** The line this direction would produce at this chunk size. */
  gcode(vec = null, feed = this._feed, step = DEFAULT_STEP_MM) {
    if (vec === null) return this.lineFor(this._axis, feed);
    return this.lineFor(
      { X: Math.sign(vec.X || 0) * step, Y: Math.sign(vec.Y || 0) * step }, feed);
  }

  /** A held key: one direction, both wheels the same distance. */
  start(vec, feed, step) {
    this._axis = { X: Math.sign(vec.X || 0) * step, Y: Math.sign(vec.Y || 0) * step };
    this._feed = feed;
    this._cruise = false;
    this._wake.set();
  }

  /**
   * Steering: the two wheels, each given its own distance.
   *
   * `left` and `right` are millimetres of wheel travel for one chunk. The
   * motors are mounted mirror-image, so the left one is driven negative — the
   * same convention DIRECTIONS encodes, expressed as distances rather than
   * signs. Their mean is how far the rover advances; their difference, over
   * the track width, is how much it turns.
   *
   * Paced differently from a held key: chunks are short, they arrive without a
   * pause between them, and the point is for the machine never to stop. See
   * STREAM_LEAD.
   */
  startWheels(left, right, feed, lift = 0) {
    // Z is the fork, on the board's Z driver. It rides in the same G1 as the
    // wheels, so lifting while driving is one move and not two streams
    // fighting over one planner.
    this._axis = lift ? { X: -left, Y: right, Z: lift } : { X: -left, Y: right };
    this._feed = feed;
    this._cruise = true;
    this._wake.set();
  }

  stop() { this._axis = null; this._wake.set(); }

  /**
   * Move time for a chunk that neither starts nor ends at a standstill.
   *
   * The trapezoid below is the right estimate for a move the machine ramps up
   * to and back down from. It is the wrong one for a stream that is blending:
   * there the ramps happen once, at the start of the run, and every chunk after
   * that is pure cruise. Pacing a blended stream by the trapezoid would send
   * roughly half as often as the board drains, the planner would run dry
   * between chunks, and the stop-start this is all meant to remove comes back
   * — by way of the pacing rather than the queue depth.
   */
  cruiseSeconds(dist, feed) {
    return dist / Math.max(1, feed / 60);
  }

  /** Trapezoidal move time, so pacing does not outrun the machine. */
  chunkSeconds(dist, feed) {
    const v = Math.max(1, feed / 60);
    const accel = Number((this.link.settings.M204 || {}).T) || 500;
    if ((v * v) / accel >= dist) {          // too short to reach full speed
      return 2 * Math.sqrt(Math.max(dist, 0.001) / accel);
    }
    return 2 * (v / accel) + (dist - (v * v) / accel) / v;
  }

  async _loop() {
    // The steering stream's schedule: `dueAt` is a running prediction of when
    // the last-sent chunk finishes — the board's own timeline, not this host's
    // clock — and `lastMs` is that chunk's own predicted duration. A held key
    // keeps the same kind of prediction in this._pacer.
    let dueAt = null, lastMs = 0;

    for (;;) {
      this._wake.clear();
      const axis = this._axis, feed = this._feed;
      if (!axis || !this.link.connected) {
        dueAt = null;
        // The key came up: the last chunk on the board brakes to a stop.
        this._pacer.release();
        this._halves = 0;
        await this._wake.wait(200);
        continue;
      }

      if (!this._cruise) {
        dueAt = null;
        await this._holdOnce(axis, feed);
        continue;
      }

      const line = this.lineFor(axis, feed);
      if (!line) { dueAt = null; await this._wake.wait(200); continue; }

      // The distance Marlin will plan and time the move by, which for two
      // unequal wheel distances is neither of them. Z too: a fork chunk rides
      // in the same G1, and a fork-only chunk would otherwise time as zero.
      const dist = Math.hypot(axis.X || 0, axis.Y || 0, axis.Z || 0);
      const ms = this.cruiseSeconds(dist, feed) * 1000;

      if (dueAt !== null) {
        // `dueAt` is when the chunk already in flight is predicted to finish;
        // send this one STREAM_LEAD chunk times before that — more than a
        // whole one, which is what puts the next move in the planner before
        // the current one starts. Wake early instead if start()/stop()/
        // startWheels() changes things, and re-check rather than send stale.
        const wait = (dueAt - lastMs * STREAM_LEAD) - Date.now();
        if (wait > 0 && await this._wake.wait(wait)) continue;
      }

      // Leading by more than a chunk only works while the board keeps up with
      // the estimate. When it does not — a corner the planner had to slow for,
      // a busy link — its acks stop and the host's own queue grows; then the
      // useful thing is to skip this chunk and steer with the next camera
      // frame, not to post a line that will act on stale information. The
      // schedule still advances, so the stream stays in step either way.
      const behind = this._cruise
        && this.link.queued() + this.link.inFlight() > STREAM_MAX_AHEAD;
      if (behind) {
        dueAt = Math.max(dueAt ?? Date.now(), Date.now()) + ms;
        lastMs = ms;
        continue;
      }

      try {
        this.link.send(line);
      } catch {
        this.stop();
        dueAt = null;
        continue;
      }

      // Extend from the PREDICTED timeline, not from when this chunk actually
      // went out — it went out early, on purpose. Anchoring here to `dueAt`
      // rather than to `Date.now()` is what keeps every steady-state gap
      // between sends at exactly one chunk's run time: recomputing "early by
      // the lead" fresh relative to *now* every cycle instead sends faster
      // than the board can ever drain, and the queue grows without bound.
      // `Math.max(..., Date.now())` only matters if a chunk is ever sent late
      // — a slow tick, a big jump in step or feed — so the schedule cannot
      // fall permanently behind.
      dueAt = Math.max(dueAt ?? Date.now(), Date.now()) + ms;
      lastMs = ms;
    }
  }

  /** One held-key chunk: wait for its turn on the Pacer, then send it. */
  async _holdOnce(axis, feed) {
    const p = this._pacer;
    // From standstill: two half chunks, back to back — see the class docstring.
    if (p.idle() && this._halves === 0) this._halves = 2;
    const wait = p.waitMs();
    // Woken early by start()/stop(): go round again and re-check, never send stale.
    if (wait > 0 && await this._wake.wait(wait)) return;
    const k = this._halves > 0 ? 0.5 : 1;
    const chunk = { X: (axis.X || 0) * k, Y: (axis.Y || 0) * k };
    const line = this.lineFor(chunk, feed);
    if (!line) { await this._wake.wait(200); return; }
    try {
      this.link.send(line);
    } catch {
      this.stop();
      return;
    }
    p.sent(chunk, feed);
    if (this._halves > 0) this._halves -= 1;
  }
}

/**
 * When the board will be done with what it has been sent — the open-loop
 * clock that paces a held key (Jogger) and a taught route (routes.js's
 * Replayer), so the planner always has the next chunk before it starts the
 * current one. See HOLD_MARGIN_S.
 *
 *   waitMs()   how long until the next chunk may go out (≤ 0: now)
 *   sent()     a chunk went out now; extend the prediction by it
 *   release()  nothing more is coming; the last chunk brakes to a stop
 *
 * Timed like the planner plans it: a chunk behind another in the same
 * direction runs at its cruise speed; one from standstill adds the time its
 * ramp up costs over cruising (v / 2a); a turn — a wheel reversing, which
 * Marlin's jerk limit takes down to near zero — adds the braking into it and
 * the ramp out of it.
 */
export class Pacer {
  constructor(jog, marginS = HOLD_MARGIN_S) {
    this.jog = jog;
    this.marginMs = marginS * 1000;
    this.reset();
  }

  reset() {
    this.endAt = null;          // predicted end of everything sent, ms epoch
    this.lastMs = 0;            // the last chunk's own predicted run time
    this.dir = null;            // its unit direction
    this.v = 0;                 // its cruise speed, mm/s
    this.braking = false;       // release() has already added the last ramp
  }

  idle(now = Date.now()) { return this.endAt === null || now >= this.endAt; }

  /** The next chunk is due HOLD_MARGIN_S before the last one sent STARTS. */
  waitMs(now = Date.now()) {
    return this.idle(now) ? 0 : this.endAt - this.lastMs - this.marginMs - now;
  }

  sent(axis, feed, now = Date.now()) {
    const dist = Math.hypot(axis.X || 0, axis.Y || 0);
    const dir = { X: (axis.X || 0) / dist, Y: (axis.Y || 0) / dist };
    const a = this.jog.accel();
    const v = this.jog.holdSpeed(axis, feed);
    const idle = this.idle(now);
    const turned = !idle && !!this.dir && this.dir.X * dir.X + this.dir.Y * dir.Y < 0.999;
    let start = idle ? now : this.endAt;
    // The chunk before a turn brakes into it — unless release() already said so.
    if (turned && !this.braking) start += (this.v / (2 * a)) * 1000;
    let ms = (dist / v) * 1000;
    if (idle || turned || this.braking) ms += (v / (2 * a)) * 1000;
    this.endAt = start + ms;
    this.lastMs = ms;
    this.dir = dir;
    this.v = v;
    this.braking = false;
    return ms;
  }

  release(now = Date.now()) {
    if (this.braking || this.idle(now)) return;
    this.endAt += (this.v / (2 * this.jog.accel())) * 1000;
    this.braking = true;
  }
}

// The usual USB-UART bridges. A Creality board has a CH340, which Linux
// reports as QinHeng / wch; the others are here because the same cable trick
// is used by every clone board anyone is likely to plug in.
const USB_UART_RE =
  /wch|qinheng|1a86|ch34|cp210|10c4|silicon\s*lab|ftdi|0403|prolific|arduino/i;

/**
 * How likely a serial device is to be the printer. Lower is better.
 *
 *   0  it says it is a USB-UART bridge
 *   1  it is a USB serial device (/dev/ttyUSB0, /dev/ttyACM0)
 *   2  it is the board's own UART (a Pi's /dev/serial0, /dev/ttyAMA0)
 *   3  anything else
 *
 * Three exists because of /dev/ttyS0..31: on a PC those are 8250 placeholders
 * that are not wired to anything, and on a Raspberry Pi /dev/ttyS0 is the mini
 * UART on the GPIO header. Either way it sorts before /dev/ttyUSB0
 * alphabetically, so picking "the first port" without ranking picks the wrong
 * one — and then fails with an I/O error about the baud rate.
 */
function portScore(p) {
  if (USB_UART_RE.test(`${p.manufacturer || ''} ${p.friendlyName || ''}`)) return 0;
  if (/tty(USB|ACM)\d/.test(p.path)) return 1;
  if (/tty(AMA)\d|serial\d/.test(p.path)) return 2;
  return 3;
}

/**
 * Every serial device, best candidate first — this is what fills the dropdown.
 *
 * The no-hoper tier is dropped as soon as there is anything better, because a
 * list of 32 /dev/ttyS* entries is not a choice, it is noise. When they are
 * all there is, they are all shown: someone with a genuine RS-232 board should
 * still be able to pick it.
 */
export async function listPorts() {
  const { SerialPort } = await import('serialport');
  const ports = await SerialPort.list();
  const ranked = ports
    .filter((p) => p.path)
    .map((p) => ({ path: p.path, score: portScore(p) }))
    .sort((a, b) => a.score - b.score
                 || a.path.localeCompare(b.path, 'en', { numeric: true }));
  const real = ranked.filter((p) => p.score < 3);
  return (real.length ? real : ranked).map((p) => p.path);
}

/**
 * The port to open without being asked, or null.
 *
 * Deliberately not just `listPorts()[0]`: opening a port toggles DTR, and
 * doing that to a device nobody identified is how you reset something that
 * was not the printer. If nothing looks like a board, say so and let the
 * operator choose.
 */
export async function bestPort() {
  const { SerialPort } = await import('serialport');
  const ports = await SerialPort.list();
  const best = ports.filter((p) => p.path && portScore(p) < 3)
    .sort((a, b) => portScore(a) - portScore(b)
                 || a.path.localeCompare(b.path, 'en', { numeric: true }))[0];
  return best ? best.path : null;
}
