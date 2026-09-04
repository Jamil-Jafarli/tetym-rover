/**
 * Marlin G-code link — the Ender-3 Pro half of this bench.
 *
 * Merged in from the standalone `ender-x` Python tool. Same behaviour, same
 * API surface, but it now runs inside this server so there is one process,
 * one port and one page hub for the whole rig: the ESP32 drives the DAC
 * throttle, the Creality board drives the two NEMA17s.
 *
 *   ESP32   -> bench.js / transports.js   analog throttle, 20 Hz stream
 *   Marlin  -> this file                  G-code over serial, ok flow control
 *
 * X and Y are the left and right wheels of a differential drive, mounted
 * mirror-image, so a *direction* is a pair of wheel signs rather than one axis.
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
 * This is the stopping distance, and that is the only thing it should be
 * chosen for. Marlin acks a move when it is buffered, so the machine is
 * always up to one chunk ahead of the host: whatever is in the planner when
 * you let go of the key still gets executed. At F1000 a 5 mm chunk is a 7 mm
 * diagonal that takes about half a second.
 *
 * Big chunks are the trap. 100 mm on both axes is a 141 mm diagonal — eight
 * and a half seconds at F1000 — so the "stream" is one move every seven
 * seconds, the key does nothing visible while it is held, and letting go
 * leaves the gantry running until it hits the frame, because the only stop
 * there is waits for the move in progress to finish.
 */
export const DEFAULT_STEP_MM = 5;

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
 *   M205 jerk (X/Y) or junction deviation (J)
 *   M350 microsteps        M906 TMC current mA   M907 digipot current
 *   M569 stealthChop (1) / spreadCycle (0)
 */
export const SETTABLE = {
  M92:  { letters: 'XY',  min: 1,   max: 1000,  int: false },
  M201: { letters: 'XY',  min: 1,   max: 20000, int: true  },
  M203: { letters: 'XY',  min: 1,   max: 1000,  int: false },
  M204: { letters: 'PRT', min: 1,   max: 20000, int: false },
  M205: { letters: 'XYJ', min: 0,   max: 100,   int: false },
  M350: { letters: 'XY',  min: 1,   max: 256,   int: true  },
  M906: { letters: 'XY',  min: 100, max: 1200,  int: true  },
  M907: { letters: 'XY',  min: 0,   max: 2000,  int: true  },
  M569: { letters: 'XY',  min: 0,   max: 1,     int: true  },
};

/** Codes we read back from the board to populate the UI. */
export const QUERY_CODES = ['M92', 'M201', 'M203', 'M204', 'M205',
                            'M350', 'M906', 'M907'];

// ...of those, the ones that report their own value when sent with no
// parameters. The rest only ever appear in an M503 dump.
const SELF_REPORTING = new Set(['M92', 'M350', 'M906', 'M907']);

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
    // encodes which way each key drives the machine, so this stays off unless
    // a motor physically turns the wrong way.
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

    this._log = [];
    this._seq = 0;
    this._buf = '';

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
      this.send('M17 X Y');  // energise both motors and hold them
      this.send('G91');      // relative — stays in force for the session
      this.send('M114');     // position
      this.readSettings();
      this.steppersOn = true;
      await this.probeBarrier();
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
   * The streaming design leans on one promise: that Marlin holds M400's `ok`
   * until the planner has drained, so the host learns when a move has actually
   * finished rather than when it was merely accepted. A board that answers
   * M400 immediately — because the firmware lacks it, or answers "Unknown
   * command", or was built without the blocking behaviour — turns that into a
   * free-running loop that fills the planner as fast as the serial line will
   * carry it. That is indistinguishable, from the outside, from having no
   * pacing at all.
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
      this.log('Falling back to pacing each chunk by its own run time, with a '
             + 'margin. Motion will be slightly gappier, but moves will not '
             + 'pile up in the planner.', 'sys');
    }
    return took;
  }

  /** Drop anything still queued so the pump stops promptly. */
  drain() { this._q.length = 0; }

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
    const port = this.port;
    this.port = null;
    try { port.close(() => {}); } catch { /* already gone */ }
    this.log('Link closed. Re-plug the board, then press Connect.', 'sys');
  }

  async disconnect() {
    this._stop = true;
    this.drain();
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
        this.settings[code] = { ...(this.settings[code] || {}), ...params };
        this.unsupported.delete(code);
      }
    }
    if (this.settings.M92 && this.settings.M92.X !== undefined) {
      this.stepsPerMm = this.settings.M92.X;
    }

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
    this._q.push(line);
    this._work.set();
  }

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
 * The catch is that Marlin acks a G1 when it is *buffered*, not when it
 * finishes, so streaming them as fast as they are accepted fills the planner
 * and the machine coasts for seconds after release.
 *
 * So the next chunk waits for the later of two things:
 *
 *   · **M400**, whose `ok` Marlin withholds until the planner has drained —
 *     exact, but only worth anything on a board where M400 actually blocks,
 *     which MarlinLink.probeBarrier() measures rather than assumes; and
 *   · **the clock**, because a move cannot possibly have finished sooner than
 *     it takes to run.
 *
 * Either alone has a failure mode — the first trusts the firmware, the second
 * trusts an estimate — but waiting for the later of the two can only make the
 * stream gappier, never denser. So the board is never holding more than the
 * one move it is executing, however long the key is held and whatever the
 * firmware does, and letting go stops the machine within that one chunk. It
 * costs a brief stop between chunks, which is the price of the key meaning
 * what it says.
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
    this._wake = new Flag(false);
    this._loop();
  }

  get active() { return this._axis !== null; }

  /** The line a set of per-driver distances would produce, without sending it. */
  lineFor(axis, feed = this._feed) {
    const parts = ['X', 'Y']
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
   */
  startWheels(left, right, feed) {
    this._axis = { X: -left, Y: right };
    this._feed = feed;
    this._wake.set();
  }

  stop() { this._axis = null; this._wake.set(); }

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
    for (;;) {
      this._wake.clear();
      const axis = this._axis, feed = this._feed;
      if (!axis || !this.link.connected) { await this._wake.wait(200); continue; }

      const line = this.lineFor(axis, feed);
      if (!line) { await this._wake.wait(200); continue; }

      // The distance Marlin will plan and time the move by, which for two
      // unequal wheel distances is neither of them.
      const seconds = this.chunkSeconds(Math.hypot(axis.X || 0, axis.Y || 0), feed);
      const startedAt = Date.now();

      try {
        this.link.send(line);
        this.link.send('M400');     // acked only once the move has finished
      } catch {
        this.stop();
        continue;
      }

      // Two independent brakes, and the later one wins.
      //
      //   1. M400's ack — exact, and self-correcting, but only on a board
      //      where M400 genuinely blocks. probeBarrier() has measured that.
      //   2. The clock — the move cannot finish sooner than it takes to run,
      //      whatever the board says. This is the one that holds when the
      //      first is a lie, and without it a board that answers M400
      //      instantly gets moves as fast as the serial line will carry them.
      //
      // Waiting for the later of the two can only ever make the stream
      // gappier, never denser, so nothing accumulates under any firmware.
      await this.link.whenDrained(seconds * 3000 + 2000);

      const margin = this.link.m400Blocks ? 1 : 1.15;
      const floor = seconds * 1000 * margin;
      const elapsed = Date.now() - startedAt;
      if (elapsed < floor) await sleep(floor - elapsed);
    }
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
