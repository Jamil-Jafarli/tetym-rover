// Software mirror of esp32/ws_dac/ws_dac.ino.
//
// Runs the same state machine — clamp, slew, 300 ms watchdog, idle-when-no-
// clients, the ENABLE pin, 10 Hz status — as a real WebSocket server. Powers
// `--fake --esp`
// (drive the whole UI with no board plugged in) and the test suite.
//
// If you change the firmware's behaviour, change this too.

import { WebSocketServer } from 'ws';

export const V_IDLE = 1.0;
export const V_MIN = 1.0;
export const V_REF = 3.3;
export const LINK_TIMEOUT_MS = 300;
export const STATUS_PERIOD_MS = 100;
export const V_SLEW_PER_S = 6.0;
export const PIN_ENABLE = 23;
export const PIN_REV_25 = 19;
export const PIN_REV_26 = 18;
export const REV_SETTLE_MS = 1000;
export const V_STOPPED_EPS = 0.03;

// The two HC-SR04s and the servo that spins one of them. Same defaults as the
// sketch; both report their pins so the pages never have to guess.
export const PIN_SERVO = 13;
export const PIN_TRIG_SCAN = 27, PIN_ECHO_SCAN = 33;
export const PIN_TRIG_FWD = 14, PIN_ECHO_FWD = 32;
// An HC-SR04 pings at about 20 Hz comfortably; faster and the previous echo is
// still bouncing around the room when the next one goes out.
export const PING_PERIOD_MS = 50;

// The spare pins, for /pins. Everything the robot does not already use, minus
// the ones that do something permanent: 0 and 12 are strapping pins, 1/3 are
// the console, 6-11 are the flash chip and 34-39 have no output driver.
// Only 25 and 26 are real DACs; these are all PWM, and the page says so.
export const TEST_PINS = [4, 5, 16, 17, 21, 22, 2, 15];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const dacFor = (v, vMax = 3.3) =>
  Math.max(0, Math.min(255, Math.round(clamp(v, V_MIN, vMax) / V_REF * 255)));

export class Esp32WsSim {
  constructor({ port = 8181, host = '127.0.0.1', vMax = 3.3 } = {}) {
    this.vMax = vMax;
    this.target25 = V_IDLE; this.target26 = V_IDLE;
    this.current25 = V_IDLE; this.current26 = V_IDLE;
    this.wantEnable = false;
    this.enableOut = false;      // the digital pin: LOW at rest
    this.wantRev = [false, false];
    this.revOut = [false, false];   // where the relays actually are
    this.idleSinceMs = 0;
    this.revBlocked = false;
    this.atIdle = true;
    this.clients = 0;
    this.lastPacketMs = 0;
    this.lastSlewMs = Date.now();
    this.good = 0;
    this.bad = 0;
    this.t0 = Date.now();

    // ── the sonar half ──
    // `world` is what the tests (or --fake) put around the robot: a function of
    // the scan angle returning centimetres, or null for "no echo came back".
    // Nothing here models physics; it models the SHAPE of the data, which is
    // what the pages and the state machine have to cope with.
    this.spin = 0;                   // -100..100, servo command; 0 = stopped
    this.spinAt = 0;                 // when the current spin started
    this.spinMs = 0;                 // ms of spinning so far
    this.revs = 0;
    this.periodMs = 2400;            // how long a full turn takes at spin 100
    this.world = null;               // (angleDeg) => cm | null
    this.fwdCm = null;               // what the forward sensor sees
    this.scanCm = null;
    this.scanSince = 0;              // ms since the spin started, at that reading
    this.lastPingMs = 0;

    // Whatever has been put on a spare pin by hand, 0-255.
    this.testPins = Object.fromEntries(TEST_PINS.map((p) => [p, 0]));

    this.host = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    this.port = port;
    this.wss = new WebSocketServer({ port, host });
    this.wss.on('connection', (ws) => this._onConnect(ws));
    /** Resolves once the socket is actually accepting connections. */
    this.ready = new Promise((res, rej) => {
      this.wss.once('listening', res);
      this.wss.once('error', rej);
    });

    this._tick = setInterval(() => { this._update(); this._updateReverse(); }, 10);
    this._status = setInterval(() => this._broadcast(), STATUS_PERIOD_MS);
  }

  get url() {
    return `ws://${this.host}:${this.port}/`;
  }

  _onConnect(ws) {
    this.clients++;
    // A fresh client has not commanded anything yet: stay at idle until it
    // does. Not touching lastPacketMs here is deliberate.
    ws.send(this._statusJson());
    ws.on('message', (raw) => this._onMessage(ws, raw.toString()));
    ws.on('close', () => {
      this.clients = Math.max(0, this.clients - 1);
      // Nobody watching: the drive pins go to idle and the bench pins go to
      // zero. A value left on a pin by a browser that has gone away is a thing
      // nobody is responsible for any more.
      if (this.clients === 0) { this._forceIdle(); this._clearTestPins(); }
    });
    ws.on('error', () => ws.close());
  }

  _onMessage(ws, text) {
    let doc;
    try { doc = JSON.parse(text); } catch { this.bad++; return; }
    const cmd = doc.cmd ?? 'set';

    if (cmd === 'stop' || cmd === 'idle') {
      this._forceIdle();
      this._clearTestPins();
      this.lastPacketMs = Date.now();
      this.atIdle = false;             // a deliberate idle still counts as alive
      this.good++;
      ws.send(this._statusJson());
      return;
    }
    if (cmd === 'ping') { ws.send(this._statusJson()); return; }
    // One pin, one raw value. Refusing an unknown pin rather than writing to it
    // is the whole safety story: half the GPIOs on this chip do something
    // permanent if you drive them.
    if (cmd === 'pin') {
      const gpio = Number(doc.gpio);
      const val = Math.max(0, Math.min(255, Math.round(Number(doc.val) || 0)));
      if (TEST_PINS.includes(gpio)) { this.testPins[gpio] = val; this.good++; }
      else this.bad++;
      ws.send(this._statusJson());
      return;
    }
    // The scan servo is its own command: it has nothing to do with the drive
    // watchdog, and a board that is scanning must not look like one that is
    // being told to move.
    if (cmd === 'scan') {
      this._setSpin(typeof doc.spin === 'number' ? doc.spin : 0);
      this.good++;
      ws.send(this._statusJson());
      return;
    }
    if (cmd !== 'set') { this.bad++; return; }

    let a = this.target25, b = this.target26, got = false;
    if (typeof doc.v25 === 'number') { a = doc.v25; got = true; }
    if (typeof doc.v26 === 'number') { b = doc.v26; got = true; }

    if (!got || !Number.isFinite(a) || !Number.isFinite(b)) { this.bad++; return; }

    // Absent means forward, per wheel. Read before the targets, because a
    // packet that asks for a flip must not be able to raise the throttle in
    // the same breath — the wheel has to stop first, and "stop" starts here.
    this.wantRev = [doc.r25 === true, doc.r26 === true];
    const pending = this.revPending;
    this.target25 = pending ? V_IDLE : clamp(a, V_MIN, this.vMax);
    this.target26 = pending ? V_IDLE : clamp(b, V_MIN, this.vMax);
    // Absent "en" means false: a client that never mentions it must not be
    // able to leave the driver enabled.
    this.wantEnable = doc.en === true;
    this.lastPacketMs = Date.now();
    this.atIdle = false;
    this.good++;
  }

  _forceIdle() {
    this.target25 = this.current25 = V_IDLE;
    this.target26 = this.current26 = V_IDLE;
    this.wantEnable = false;
    this.enableOut = false;
    // Relays are deliberately not reset here — see the firmware comment.
    this.wantRev = [false, false];
  }

  get outputsAtIdle() {
    return this.current25 <= V_IDLE + V_STOPPED_EPS
        && this.current26 <= V_IDLE + V_STOPPED_EPS;
  }

  get revPending() {
    return this.wantRev[0] !== this.revOut[0] || this.wantRev[1] !== this.revOut[1];
  }

  /**
   * Start or stop the scan servo.
   *
   * Continuous rotation, so there is no position to command — only a speed, and
   * the angle is whatever the elapsed time says it is. Stopping freezes the
   * accumulated time rather than zeroing it, so a pause does not silently
   * rotate the whole map.
   */
  _setSpin(v) {
    const want = clamp(Math.round(Number(v) || 0), -100, 100);
    if (want === this.spin) return;
    if (this.spin !== 0) this.spinMs += Date.now() - this.spinAt;   // bank it
    this.spin = want;
    this.spinAt = Date.now();
  }

  /** Everything back to 0 — on stop, on idle, and when the last client goes. */
  _clearTestPins() {
    for (const p of TEST_PINS) this.testPins[p] = 0;
  }

  /** Milliseconds of actual rotation since the scan began. */
  get spinElapsed() {
    return this.spinMs + (this.spin !== 0 ? Date.now() - this.spinAt : 0);
  }

  /** Where the spinning sensor is pointing, in degrees. */
  get scanAngle() {
    const per = this.periodMs * (100 / Math.max(1, Math.abs(this.spin)));
    if (!(per > 0)) return 0;
    return ((this.spinElapsed / per) * 360 * Math.sign(this.spin || 1)) % 360;
  }

  /** Fire both sensors, at the rate a real HC-SR04 can manage. */
  _ping() {
    const now = Date.now();
    if (now - this.lastPingMs < PING_PERIOD_MS) return;
    this.lastPingMs = now;
    const ask = (a) => {
      if (typeof this.world !== 'function') return null;
      const v = this.world(((a % 360) + 360) % 360);
      return Number.isFinite(v) ? v : null;     // null is a real answer: no echo
    };
    this.fwdCm = this.fwdOverride !== undefined ? this.fwdOverride : ask(0);
    if (this.spin !== 0) {
      this.scanCm = ask(this.scanAngle);
      this.scanSince = Math.round(this.spinElapsed);
    }
  }

  /** The interlock — mirror of updateReverse() in the firmware. */
  _updateReverse() {
    if (!this.revPending) { this.revBlocked = false; return; }
    if (!this.outputsAtIdle) {
      this.revBlocked = true;
      this.idleSinceMs = 0;
      return;
    }
    const now = Date.now();
    if (this.idleSinceMs === 0) this.idleSinceMs = now;
    if (now - this.idleSinceMs < REV_SETTLE_MS) { this.revBlocked = true; return; }
    this.revOut = [...this.wantRev];
    this.revBlocked = false;
  }

  _update() {
    const now = Date.now();
    this._ping();
    const maxStep = (V_SLEW_PER_S * (now - this.lastSlewMs)) / 1000;
    this.lastSlewMs = now;

    const live = this.clients > 0 && now - this.lastPacketMs <= LINK_TIMEOUT_MS;
    if (!live) {
      if (!this.atIdle) { this._forceIdle(); this.atIdle = true; }
      return;
    }
    // ENABLE follows the command directly — no ramp, it is a digital pin.
    this.enableOut = this.wantEnable;
    // Hold at idle while a direction change is pending.
    if (this.revPending) {
      this.target25 = V_IDLE;
      this.target26 = V_IDLE;
    }
    if (maxStep <= 0) return;
    const slew = (cur, tgt) => {
      const d = tgt - cur;
      if (d > maxStep) return cur + maxStep;
      if (d < -maxStep) return cur - maxStep;
      return tgt;
    };
    this.current25 = slew(this.current25, this.target25);
    this.current26 = slew(this.current26, this.target26);
  }


  status() {
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      type: 'status',
      v25: r2(this.current25), v26: r2(this.current26),
      dac25: dacFor(this.current25, this.vMax), dac26: dacFor(this.current26, this.vMax),
      en: this.enableOut, en_pin: PIN_ENABLE,
      rev: [...this.revOut], rev_pin: [PIN_REV_25, PIN_REV_26],
      pins: { ...this.testPins },
      son: {
        fwd_cm: this.fwdCm == null ? null : r2(this.fwdCm),
        scan_cm: this.scanCm == null ? null : r2(this.scanCm),
        scan_t: this.scanSince,          // ms of rotation when that echo landed
        spin: this.spin,
        pin: { servo: PIN_SERVO,
               trig_s: PIN_TRIG_SCAN, echo_s: PIN_ECHO_SCAN,
               trig_f: PIN_TRIG_FWD, echo_f: PIN_ECHO_FWD },
      },
      rev_wait: this.revBlocked,
      dir: !this.revOut[0] && !this.revOut[1] ? 'forward'
         : this.revOut[0] && this.revOut[1] ? 'BACK'
         : (this.revOut[0] ? 'PIVOT (25 rev)' : 'PIVOT (26 rev)'),
      set25: r2(this.target25), set26: r2(this.target26),
      idle: V_IDLE, vmin: V_MIN, vmax: this.vMax,
      clients: this.clients, pkt: this.good, bad: this.bad,
      stale: this.atIdle, uptime: Date.now() - this.t0, rssi: -50, ap: false,
      sim: true,
    };
  }

  _statusJson() { return JSON.stringify(this.status()); }

  _broadcast() {
    if (!this.clients) return;
    const msg = this._statusJson();
    for (const c of this.wss.clients) {
      if (c.readyState === c.OPEN) c.send(msg);
    }
  }

  async close() {
    clearInterval(this._tick);
    clearInterval(this._status);
    for (const c of this.wss.clients) c.terminate();
    await new Promise((res) => this.wss.close(res));
  }
}
