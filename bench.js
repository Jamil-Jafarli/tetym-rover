// The control state: what the user asked for, and the one function that
// decides what actually goes to the pins.
//
// Two things go out per wheel: a throttle percentage (analog, via the DAC) and
// a direction (digital, via a relay). Percent is what the UI speaks; volts are
// what the wire carries, and the conversion lives here so exactly one place
// knows the ceiling.
//
// Transport-agnostic — it drives whatever transports.js hands it, wifi or USB.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esp from './esp.js';
import { loadShared } from './shared.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_FILE = path.join(HERE, 'presets.json');

// The two pure modules the pages already share, run here as well rather than
// reimplemented. /obstacle draws the same obstacleStep the throttle is now
// gated by, and /dashboard draws the same route the server integrates — one
// behaviour with one set of tests behind it, not a browser copy and a server
// copy that agree until they don't. See shared.js for why they are loaded like
// this rather than imported.
const { OBSTACLE_DEFAULTS, obstacleState, obstacleStep } =
  loadShared('sonar.js', ['OBSTACLE_DEFAULTS', 'obstacleState', 'obstacleStep']);
const { ROUTE_DEFAULTS, routeState, routeStep, routeMark, routeReset, routeBearing } =
  loadShared('route.js', ['ROUTE_DEFAULTS', 'routeState', 'routeStep', 'routeMark',
                          'routeReset', 'routeBearing']);
// The competition field and where the robot is on it. Same reasoning again:
// the QR codes localise the robot whether or not a browser is open, so the
// graph, the plan and the next turn are the server's, and /dashboard draws
// what the robot is actually navigating by rather than a second copy of it.
const { FIELD, fieldState, fieldSee, fieldMission, fieldClearMission, fieldStatus } =
  loadShared('field.js', ['FIELD', 'fieldState', 'fieldSee', 'fieldMission',
                          'fieldClearMission', 'fieldStatus']);

/**
 * What each key combination means.
 *
 *   p: [GPIO25 %, GPIO26 %]        how hard each wheel is driven
 *   r: [GPIO25 rev, GPIO26 rev]    true = that wheel's direction relay pulls in
 *
 * Reversing ONE wheel while the other drives forward makes the robot pivot on
 * the spot; reversing BOTH makes it back up. That is why A and D drive both
 * wheels at the same percentage — the turn comes from the direction, not from
 * a speed difference.
 *
 * W+A and W+D deliberately keep both wheels forward and turn by speed instead.
 * A direction change needs the robot to stop first, so those are the ones you
 * use while actually moving.
 */
export const DEFAULT_PRESETS = {
  w:  { p: [55, 55], r: [false, false] },   // forward
  a:  { p: [35, 35], r: [true,  false] },   // pivot — GPIO25 backwards
  d:  { p: [35, 35], r: [false, true ] },   // pivot the other way
  wa: { p: [60, 30], r: [false, false] },   // rolling turn, no direction change
  wd: { p: [30, 60], r: [false, false] },
  s:  { p: [35, 35], r: [true,  true ] },   // straight back
};

// Master throttle limit, as a percentage of the presets. Everything that goes
// out is scaled by this, so you can walk the whole robot up from a crawl
// without retyping the table.
export const DEFAULT_LEVEL = 100;

/**
 * The two fixed speeds, as [GPIO25, GPIO26] DAC codes.
 *
 * A gear is not a percentage of anything: it is the number the pin is handed.
 * `dac = round(V / 3.3 * 255)`, so 124 is 1.60 V — a crawl just clear of the
 * dead band — and 241 is 3.12 V, near the top. Stored in the unit they were
 * measured in; percent and volts are derived from them and never the reverse,
 * because a round trip through percent is where a code stops being the code.
 *
 * The slow gear carries two different numbers and the fast one does not: two
 * motors off the same reel differ by a few percent, and a few percent matters
 * near the dead band and disappears at full throttle. That difference is the
 * reason a gear is a pair rather than a single number.
 */
export const DEFAULT_GEARS = {
  normal: [124, 126],
  fast:   [241, 241],
};

export const GEAR_NAMES = Object.keys(DEFAULT_GEARS);

// Longest match wins, so "wa" beats "w" when both keys are down.
const COMBO_ORDER = ['wa', 'wd', 'w', 'a', 'd', 's'];

// What the pages call the two gears and the four directions. The keys stay
// English because they are protocol — they are in presets.json, in the WebSocket
// messages and in the tests — and only the words a person reads are translated.
const GEAR_NAMES_TR = { normal: 'normal', fast: 'hızlı' };
const DIR_SETTLING = { 'İLERİ': 'ileri', 'GERİ': 'geri',
                       'DÖNÜŞ A': 'dönüş A', 'DÖNÜŞ D': 'dönüş D' };

// If the page goes quiet for this long we treat it as "no keys held". The
// browser sends at 20 Hz while driving, so this only fires if a tab wedges.
// The follow page is held to the same rule: a camera that stops delivering
// frames is exactly the case where a robot must not keep its last throttle.
const KEYS_STALE_MS = 400;

// The board owns the direction interlock: it refuses to move a relay until its
// outputs have sat at idle long enough. We request immediately and hold the
// throttle at zero until the board reports the relays actually moved, so there
// is one settle period rather than two stacked up. This timeout is only the
// fallback for a transport that reports no direction at all (the USB board).
const REV_FALLBACK_MS = 1600;

// How hard the lift runs, as a percentage of the L298N's PWM. Not 100 by
// default: an actuator that slams into its end stop at full duty is the noise
// you hear just before the gearbox gives up. It is a setting because the right
// number depends on the load, and it lives in follow.json with everything else
// that was found by trying it.
export const DEFAULT_LIFT_PCT = 75;

/** @returns {[number, number, [boolean, boolean], string|null]} */
export function resolveKeys(keys, presets) {
  const held = new Set((keys || []).map((k) => String(k).toLowerCase()));
  if (!held.size) return [0, 0, [false, false], null];
  for (const combo of COMBO_ORDER) {
    if ([...combo].every((c) => held.has(c))) {
      const row = presets[combo] || DEFAULT_PRESETS[combo];
      return [row.p[0], row.p[1], [!!row.r[0], !!row.r[1]], combo];
    }
  }
  return [0, 0, [false, false], null];
}

export class Bench {
  /**
   * @param {object} opts
   * @param {import('./transports.js').WsTransport} opts.transport
   * @param {number} opts.vMax  what 100% means, in volts
   */
  constructor({ transport, vMax = esp.V_MAX, field = FIELD } = {}) {
    this.tx = transport;
    this.vMax = esp.clamp(vMax);

    this.running = false;
    this.p25 = 0;          // percent
    this.p26 = 0;
    this.clients = 0;
    this._closed = false;

    // Drive page state.
    const saved = loadSaved();
    this.presets = saved.presets;
    this.level = saved.level;
    this.keyMode = false;
    this.keys = [];
    this.combo = null;
    this.lastKeysAt = 0;

    // The two fixed speeds. The codes are a setting and persist; which one is
    // engaged is not, and starts at none — a robot that comes up already in a
    // gear is a robot that moves the moment somebody presses START for an
    // unrelated reason.
    this.gears = saved.gears;
    this.gear = null;              // 'normal' | 'fast' | null
    this.lastGearAt = 0;

    // ── the lift ──
    // One actuator on an L298N, up or down. Held, not latched: the page sends
    // its direction at 20 Hz for as long as the button is down, and this goes
    // back to 0 the moment it stops — the same dead-man as a gear, for a motor
    // that is even less forgiving about being left running. See LIFT_PCT for
    // why the number here is a percentage and the wire carries 0-255.
    this.lift = 0;                 // -1 down, 0 stop, +1 up
    this.liftPct = DEFAULT_LIFT_PCT;
    this.lastLiftAt = 0;

    // Follow page state: the browser's vision loop steering the robot.
    this.autoMode = false;
    this.lastAutoAt = 0;
    this.autoReason = '';

    // Direction: we ask, the board decides when it is safe to actually move.
    this.dirWant = [false, false];   // [GPIO25 rev, GPIO26 rev]
    this.dirAt = 0;                  // when the request changed
    this._dirLast = [false, false];  // fallback for transports with no readback

    // ── the forward HC-SR04, as a brake ──
    // It used to be one page's behaviour: /obstacle ran the state machine in
    // the browser and sent zeros. That protects exactly one page. The robot has
    // five ways to be driven — keys, a gear, a typed percentage, the pilot, the
    // obstacle page itself — and a wall in front of it is a fact about the
    // robot, not about which tab is open. So it lives here, where every one of
    // those paths already funnels through resolve().
    this.obsCfg = { ...OBSTACLE_DEFAULTS };
    this.obsGuard = true;            // on unless follow.json says otherwise
    this.obsState = obstacleState(Date.now());
    this.obs = { blocked: false, phase: 'go', cm: null, reason: 'başlıyor', waitLeft: 0 };
    this.obsStops = 0;

    // ── where it has been ──
    // Integrated here rather than in the page so the route survives a reload,
    // is the same for two browsers watching, and exists at all when nobody is
    // watching. See public/route.js for what it is and is not.
    this.routeCfg = { ...ROUTE_DEFAULTS };
    this.route = routeState(Date.now());
    this.calib = null;               // {pct, metres, seconds, dead} — from /setup
    this.swap = false;

    // ── where it is on the field ──
    // The dead reckoning above says how far it has gone; this says where that
    // is, because the QR codes are bolted to known places and the wheels are
    // not. See public/field.js. `fieldMap` is which field: the competition's
    // or the practice one (--field).
    this.fieldMap = field;
    this.field = fieldState();

    // ── the factory automation system ──
    // Why the PLC mission says the wheels must not turn — waiting for "start",
    // waiting at the door, emergency stop — or null. See plc_run.js.
    this.plcHold = null;
  }

  /** Dead reckoning as field.js wants it, for the PLC's coordinates. */
  routePose() {
    return { x: this.route.x, y: this.route.y, bearing: routeBearing(this.route) };
  }

  /**
   * The PLC mission's brake. Wheels only while waiting — the lift is not in the
   * way of a door — and the lift too on an emergency stop (`all`).
   */
  hold(reason, all = false) {
    this.plcHold = reason || null;
    this.plcHoldAll = !!(this.plcHold && all);
    if (this.plcHoldAll) this.lift = 0;
  }

  /**
   * Take the persisted tuning: obstacle thresholds, wheelbase, distance
   * calibration.
   *
   * One setter for the whole file rather than one per number, because these
   * arrive together — the server hands over follow.json as it loads it and
   * again whenever a page edits it, and a half-applied config is a robot that
   * brakes at the old threshold.
   */
  setCfg(followCfg) {
    const cfg = followCfg || {};
    for (const k of Object.keys(OBSTACLE_DEFAULTS)) {
      const v = cfg.obstacle && cfg.obstacle[k];
      if (Number.isFinite(Number(v))) this.obsCfg[k] = Number(v);
    }
    // The one non-numeric one: a way to switch the brake off for bench work,
    // off by default, and reported in the status so it can never be off
    // without the pages saying so.
    this.obsGuard = !(cfg.obstacle && cfg.obstacle.guard === false);
    if (Number.isFinite(Number(cfg.route && cfg.route.track))) {
      this.routeCfg.track = Number(cfg.route.track);
    }
    this.calib = cfg.calib || null;
    this.swap = !!(cfg.pilot && cfg.pilot.swap);
    if (Number.isFinite(Number(cfg.lift && cfg.lift.pct))) {
      this.liftPct = Math.max(0, Math.min(100, Number(cfg.lift.pct)));
    }
    return this;
  }

  async open() {
    await this.tx.open();
    // Always streaming, even at 0% — that is what feeds the board's own
    // watchdog and holds it at a known idle.
    this._timer = setInterval(() => this.tick(), esp.SEND_PERIOD_MS);
  }

  async close() {
    this._closed = true;
    this.idle();
    this.tick();                                  // push idle one last time
    await new Promise((r) => setTimeout(r, 60));
    if (this._timer) clearInterval(this._timer);
    await this.tx.close();
  }

  // ── commands ──────────────────────────────────────────────────────
  setValues(a, b) {
    const pct = (x) => Math.max(0, Math.min(100, Number(x) || 0));
    this.keyMode = false;              // typing a value takes over from the keys
    this.autoMode = false;
    this.gear = null;                  // ...and out of gear
    this.keys = [];
    this.combo = null;
    this.requestDirection([false, false]);   // the manual page is forward-only
    if (a !== undefined && a !== null) this.p25 = pct(a);
    if (b !== undefined && b !== null) this.p26 = pct(b);
  }

  /** Drive page: which of W/A/S/D are held right now. */
  setKeys(keys) {
    this.keyMode = true;
    this.autoMode = false;             // a hand on the keyboard wins
    this.gear = null;                  // ...over a gear too
    this.keys = (keys || []).map((k) => String(k).toLowerCase())
      .filter((k) => 'wasd'.includes(k));
    const [a, b, dir, combo] = resolveKeys(this.keys, this.presets);
    this.combo = combo;
    this.p25 = a;
    this.p26 = b;
    this.lastKeysAt = Date.now();
    this.requestDirection(dir);
  }

  /**
   * Follow page: the two percentages its vision loop just worked out.
   *
   * Deliberately the same shape as setKeys — a pair of percentages, forward
   * only, stamped with the time it arrived. The dead-man below then covers a
   * frozen camera, a backgrounded tab and a closed laptop lid identically,
   * without the follow path needing a safety story of its own.
   */
  setAuto(a, b, reason) {
    const pct = (x) => Math.max(0, Math.min(100, Number(x) || 0));
    this.autoMode = true;
    this.keyMode = false;
    this.gear = null;
    this.keys = [];
    this.combo = null;
    this.autoReason = typeof reason === 'string' ? reason.slice(0, 40) : '';
    this.p25 = pct(a);
    this.p26 = pct(b);
    this.lastAutoAt = Date.now();
    this.requestDirection([false, false]);   // steering is by speed only
  }

  /** Replace the key table and persist it. Accepts partial rows. */
  setPresets(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_PRESETS) || !v) continue;
      const cur = this.presets[k];
      const row = { p: [...cur.p], r: [...cur.r] };
      if (Array.isArray(v.p) && v.p.length >= 2) row.p = [pct100(v.p[0]), pct100(v.p[1])];
      if (Array.isArray(v.r) && v.r.length >= 2) row.r = [v.r[0] === true, v.r[1] === true];
      // Bare arrays are the old percent-only format.
      if (Array.isArray(v) && v.length >= 2) row.p = [pct100(v[0]), pct100(v[1])];
      this.presets[k] = row;
    }
    saveState(this.presets, this.level, this.gears);
    // Apply straight away if a key is currently held.
    if (this.keyMode) this.setKeys(this.keys);
    return this.presets;
  }

  /** Master throttle limit, 0-100 %. Scales everything on its way out. */
  setLevel(level) {
    this.level = pct100(level);
    saveState(this.presets, this.level, this.gears);
    return this.level;
  }

  // ── the two fixed speeds ──────────────────────────────────────────
  /**
   * DAC code -> the percentage that produces it.
   *
   * Everything downstream of here speaks percent, so this is where a code
   * becomes one. The conversion goes through volts against the chip's 3.3 V
   * reference, then against `--v-max`: a ceiling below the code's own voltage
   * clamps here, and `gear_clamped` says so, rather than the robot quietly
   * running slower than the number written on the button.
   */
  dacPct(dac) {
    return esp.voltsToPct(esp.dacToVolts(dac), this.vMax);
  }

  /**
   * Engage one of the two speeds — or release with `null`.
   *
   * Exclusive by construction: there is one `gear`, so selecting the second
   * releases the first. It takes over from the keys and from the pilot exactly
   * as typing a percentage does, and each of those takes it back — one thing
   * decides the throttle at a time, and which one is in the status.
   *
   * The page re-sends it at 20 Hz while it is engaged, so a gear is held to
   * the same 400 ms dead-man as the keys. A gear has no keyup to wait for: it
   * would otherwise be the one throttle on the robot that outlives the tab
   * that asked for it.
   */
  setGear(name) {
    const g = name === null || name === undefined || name === '' ? null : String(name);
    if (g !== null && !(g in DEFAULT_GEARS)) return this.gear;   // unknown: ignored
    this.keyMode = false;
    this.autoMode = false;
    this.keys = [];
    this.combo = null;
    this.gear = g;
    this.lastGearAt = Date.now();
    this.requestDirection([false, false]);   // a gear is forward only
    this.p25 = g === null ? 0 : this.dacPct(this.gears[g][0]);
    this.p26 = g === null ? 0 : this.dacPct(this.gears[g][1]);
    return this.gear;
  }

  /** Edit the two speeds, as DAC codes. Persisted next to the key table. */
  setGears(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_GEARS) || !Array.isArray(v) || v.length < 2) continue;
      this.gears[k] = [dac255(v[0]), dac255(v[1])];
    }
    saveState(this.presets, this.level, this.gears);
    if (this.gear) this.setGear(this.gear);   // whatever is engaged follows the edit
    return this.gears;
  }

  /** True when the engaged gear asks for more volts than --v-max can give. */
  get gearClamped() {
    if (!this.gear) return false;
    const ceiling = esp.dacFor(this.vMax);
    return this.gears[this.gear].some((d) => d > ceiling);
  }

  /**
   * Put a raw 0-255 on a spare pin.
   *
   * Not part of the drive path and not watchdogged: a bench value you set by
   * hand should stay where you put it while you go and measure it. The board
   * clears them on stop, on idle, and when the last browser leaves.
   */
  setPin(gpio, value) {
    const v = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
    if (typeof this.tx.pin === 'function') this.tx.pin(gpio, v);
    return v;
  }

  start() { this.running = true; }
  /**
   * STOP: the wheels stop, and so does the lift.
   *
   * A stop button that leaves an actuator extending is not a stop button. This
   * is belt and braces — the dead-man in `liftOut` would catch it a fifth of a
   * second later anyway — but STOP is the control people reach for when
   * something is going wrong, and it has to mean all of it.
   */
  stop() { this.running = false; this.lift = 0; }

  /**
   * True while the robot is actually backing up: both direction relays pulled
   * in, and something on the pins. A pivot moves one relay, not both, and a
   * robot that is stopped is not reversing however the relays are set.
   * This is what sounds the buzzer; see buzzer.js.
   */
  get reversing() {
    const [a, b, enabled] = this.resolve();
    if (!enabled) return false;
    const dir = this.dir;
    return dir[0] === true && dir[1] === true && (a > 0 || b > 0);
  }

  /** Everything that is being held, released. The lift is one of those. */
  idle() {
    this.running = false;
    this.p25 = this.p26 = 0;
    this.keyMode = false;
    this.autoMode = false;
    this.gear = null;
    this.keys = [];
    this.combo = null;
    this.lift = 0;
    this.requestDirection([false, false]);
  }

  clientJoined() { this.clients++; }
  clientLeft() {
    this.clients = Math.max(0, this.clients - 1);
    if (this.clients === 0) this.running = false;   // nobody watching, nobody driving
  }

  // ── direction ─────────────────────────────────────────────────────
  /** Ask for a direction pair. Never applied immediately — the board gates it. */
  requestDirection(want) {
    const w = [want[0] === true, want[1] === true];
    if (w[0] === this.dirWant[0] && w[1] === this.dirWant[1]) return;
    this._dirLast = this.dir;
    this.dirWant = w;
    this.dirAt = Date.now();
  }

  /**
   * Where the relays actually are, straight from the board. Falls back to a
   * timer only when the transport cannot tell us (USB firmware has no relays).
   */
  get dir() {
    const board = this.tx.readback();
    if (board && Array.isArray(board.rev) && this.tx.fresh) {
      return [board.rev[0] === true, board.rev[1] === true];
    }
    return Date.now() - this.dirAt >= REV_FALLBACK_MS ? this.dirWant : this._dirLast;
  }

  /** True while the wheels are held at zero waiting for the relays to move. */
  get dirSettling() {
    const d = this.dir;
    return d[0] !== this.dirWant[0] || d[1] !== this.dirWant[1];
  }

  /** Human label for whatever the direction pair means. */
  /**
   * The settling label, written out per direction.
   *
   * Not `dirName().toLowerCase()`: JavaScript's lowercase is not Turkish-aware,
   * so 'İLERİ' comes back as "i̇leri̇" — a dotted i with a second combining dot
   * on top. One table beats a word that renders wrong on every direction change.
   */
  static get settlingNames() { return DIR_SETTLING; }

  static dirName(d) {
    if (!d[0] && !d[1]) return 'İLERİ';
    if (d[0] && d[1]) return 'GERİ';
    return d[0] ? 'DÖNÜŞ A' : 'DÖNÜŞ D';
  }

  // ── the one place that decides what goes out ──────────────────────
  /**
   * Scale a raw percent by the master level.
   *
   * The follow page is exempt. There the percentage IS the answer: the pilot
   * already has its own ceiling, worked out per frame from the bend ahead, and
   * multiplying that by a second number means the slider you tuned and the
   * volts on the pin are two different things. One limit per path — `max` on
   * /follow, the master level on /drive.
   *
   * A gear is exempt for the same reason, and more bluntly: it is written as a
   * DAC code, and a code multiplied by a master level is a different code. The
   * page says so next to the level, because this is the one place on /drive
   * where that slider does not bite.
   */
  scaled(p) {
    return (this.autoMode || this.gear) ? p : (p * this.level) / 100;
  }

  /** @returns {[number, number, boolean, string]} pct25, pct26, enable, reason */
  resolve() {
    if (this._closed) return [0, 0, false, 'kapanıyor'];
    if (this.clients === 0) return [0, 0, false, 'tarayıcı bağlı değil'];
    if (!this.running) return [0, 0, false, 'durduruldu'];
    if (!this.tx.fresh) return [0, 0, false, 'esp32 erişilemiyor'];
    // The PLC mission holds the robot: before "start", at the door, e-stop.
    // Every way of driving stops — keys, gears and the follow page alike —
    // with enable up, because this is a wait and not a shutdown.
    if (this.plcHold) return [0, 0, true, this.plcHold];
    // Armed but the drive page stopped reporting: coast, stay enabled. Holding
    // enable through a released key is deliberate — toggling it on every
    // keystroke would hammer the relay.
    if (this.keyMode && Date.now() - this.lastKeysAt > KEYS_STALE_MS) {
      return [0, 0, true, 'tuş basılı değil'];
    }
    // Same rule for the follow page: no fresh frame, no throttle. Enable stays
    // up so a dropped frame does not cost a relay cycle, but nothing moves.
    if (this.autoMode && Date.now() - this.lastAutoAt > KEYS_STALE_MS) {
      return [0, 0, true, 'kare gelmiyor'];
    }
    // And for a gear. It is a held throttle with no keyup behind it, so the
    // only thing standing between a wedged tab and a robot at 3.12 V is the
    // page still saying, twenty times a second, that it means it.
    if (this.gear && Date.now() - this.lastGearAt > KEYS_STALE_MS) {
      return [0, 0, true, 'hız bildirimi yok'];
    }
    // A direction change is pending: hold everything at zero so the wheels
    // stop and the board's interlock can release. Crossing phase wires under
    // load destroys the controller's output stage.
    if (this.dirSettling) {
      return [0, 0, true, `${DIR_SETTLING[Bench.dirName(this.dirWant)]}…`];
    }
    // Something in front of us, closer than the threshold. Enable stays up —
    // this is a brake, not a shutdown, and dropping the relay would cost a
    // cycle every time somebody walked past.
    //
    // Only forward motion is held. Reversing away from a wall and pivoting on
    // the spot are the two things you actually want to be able to do while the
    // forward sensor is screaming, and neither of them drives into it.
    if (this.obsBlocking) {
      return [0, 0, true, this.obs.reason];
    }
    if (this.level === 0 && !this.autoMode && !this.gear) {
      return [0, 0, true, 'seviye 0 %'];
    }
    const moving = Bench.dirName(this.dirWant);
    const label = moving === 'İLERİ'
      ? (this.autoMode ? `takip: ${this.autoReason || 'gidiyor'}`
        : this.gear ? `hız ${GEAR_NAMES_TR[this.gear] || this.gear}`
        : this.combo ? `tuş ${this.combo}` : 'sürüyor')
      : moving;
    return [this.scaled(this.p25), this.scaled(this.p26), true, label];
  }

  /**
   * True when the forward sensor is holding the throttle down right now.
   *
   * Split out of resolve() because resolve() is called several times per tick —
   * once to drive, once per status frame — and it has to give the same answer
   * every time. Everything that advances a clock happens in tick(), below.
   */
  get obsBlocking() {
    if (!this.obsGuard || !this.obs.blocked) return false;
    return !this.dirWant[0] && !this.dirWant[1];      // forward only
  }

  /**
   * Advance the two things that keep their own history: the obstacle state
   * machine and the dead-reckoned route. Once per tick, 20 Hz.
   *
   * The sensor is read whether or not the robot is running, because /dashboard
   * and /obstacle both show the distance while it is parked, and a state
   * machine that only runs while armed would arm into whatever it last saw.
   */
  _sense(now) {
    const board = this.tx.readback();
    const cm = board && this.tx.fresh && board.son ? board.son.fwd_cm : null;
    const was = this.obs.phase;
    this.obs = obstacleStep(this.obsState, cm, this.obsCfg, now);
    if (this.obs.phase === 'stop' && was !== 'stop') {
      this.obsStops++;
      // Where it stopped is worth a pin on the map: unlike the path itself, it
      // is a place something really was.
      routeMark(this.route, 'stop', `${this.obs.cm ?? '?'} sm`, now, this.routeCfg);
    }
  }

  tick() {
    const now = Date.now();
    this._sense(now);
    const [a, b, en] = this.resolve();
    // The route is integrated from what is actually going to the pins, not
    // from what anybody asked for — the same rule /tune uses for distance,
    // and the reason a blocked robot does not accumulate metres.
    routeStep(this.route,
      { p25: a, p26: b, rev: this.dir, calib: this.calib, swap: this.swap },
      this.routeCfg, now);
    // Request the direction straight away. Holding the throttle at zero (in
    // resolve) is what lets the board's interlock release.
    this.tx.send(esp.pctToVolts(a, this.vMax), esp.pctToVolts(b, this.vMax), en,
                 this.dirWant, this.liftOut);
  }

  /**
   * Raise, lower, or stop the lift.
   *
   * Held rather than latched. The page repeats this at 20 Hz while a button is
   * down and `liftOut` falls back to 0 as soon as it stops arriving, so a
   * closed tab, a wedged renderer or a dropped wifi link all stop the actuator
   * within 400 ms. There is no "lift up and forget" command on purpose: this
   * moves a load, and every other held output on this robot works the same way.
   *
   * @param {number|string} dir  +1 / 'up', -1 / 'down', 0 / anything else stops
   */
  setLift(dir) {
    const d = dir === 'up' ? 1 : dir === 'down' ? -1 : Math.sign(Number(dir) || 0);
    this.lift = d === 1 || d === -1 ? d : 0;
    this.lastLiftAt = Date.now();
    return this.lift;
  }

  /**
   * What actually goes on the wire: -255..255, or 0 if the page went quiet.
   *
   * A getter rather than stored state, for the same reason `obsBlocking` is:
   * it is read once to drive and once per status frame, and both have to get
   * the same answer.
   */
  get liftOut() {
    if (!this.lift || this.plcHoldAll) return 0;
    if (Date.now() - this.lastLiftAt > KEYS_STALE_MS) return 0;
    const pct = Math.max(0, Math.min(100, Number(this.liftPct) || 0));
    return Math.round(this.lift * (pct / 100) * 255);
  }

  /** Pin something to where the robot was when it happened — see route.js. */
  mark(kind, text, now = Date.now()) {
    return routeMark(this.route, kind, text, now, this.routeCfg);
  }

  /**
   * A QR code was read: pin it to the path, and fix the position with it.
   *
   * Both, because they answer different questions. The mark is "a code was
   * read here on the line we have drawn", which is worth seeing even when the
   * code belongs to somebody else's field. The localisation is "and therefore
   * the robot is *there*, on this leg, pointing this way" — and that only
   * happens for a code this field knows.
   *
   * The route pose is handed over at the same instant so field.js can anchor
   * one frame to the other; sampling it a tick later would bake in whatever
   * the robot did in between.
   */
  seeQr(text, now = Date.now()) {
    const mark = routeMark(this.route, 'qr', text, now, this.routeCfg);
    const fix = fieldSee(this.field, text, now, this.fieldMap,
      { x: this.route.x, y: this.route.y, bearing: routeBearing(this.route) });
    return { mark, fix };
  }

  /** The stops to call at, in order — e.g. ['A2', 'B3']. */
  setMission(targets, from = null) {
    if (!Array.isArray(targets) || targets.length === 0) {
      fieldClearMission(this.field);
      return { nodes: [], stops: [], ok: true, reason: null };
    }
    return fieldMission(this.field, targets, this.fieldMap, from);
  }

  /** Start the map again from here. The run log is what keeps a run forever. */
  resetRoute(now = Date.now()) {
    routeReset(this.route, now);
    // The anchor tied the field to route coordinates that no longer exist, so
    // it goes too. Better to say "I do not know where I am until the next QR"
    // than to keep an offset into a frame that was just reset to zero.
    const stops = this.field.stops;
    this.field = fieldState();
    if (stops && stops.length) fieldMission(this.field, stops, this.fieldMap, 'START');
    return this.route;
  }

  snapshot() {
    const [outA, outB, en, reason] = this.resolve();
    const board = this.tx.readback() || {};
    return {
      running: this.running,
      reason,
      enable: en,                              // what we are commanding
      clients: this.clients,
      transport: this.tx.label,
      keys: this.keys,
      combo: this.combo,
      follow: this.autoMode,
      presets: this.presets,
      level: this.level,
      gear: this.gear,                         // which fixed speed is engaged
      gears: this.gears,                       // ...and the codes behind both
      gear_clamped: this.gearClamped,
      dir_want: this.dirWant,
      dir: this.dir,
      dir_settling: this.dirSettling,
      dir_name: Bench.dirName(this.dirWant),
      reversing: this.reversing,
      set: [r1(this.p25), r1(this.p26)],       // percent the user typed
      out: [r1(outA), r1(outB)],               // percent actually streaming
      out_v: [r2(esp.pctToVolts(outA, this.vMax)),
              r2(esp.pctToVolts(outB, this.vMax))],
      // The codes those volts become, worked out the way the firmware does it.
      // Percent is a convenience; this is the number the pin is handed, and a
      // gear is set in it, so the page can show that what was asked for is
      // what went out.
      out_dac: [esp.dacFor(esp.pctToVolts(outA, this.vMax)),
                esp.dacFor(esp.pctToVolts(outB, this.vMax))],
      idle_v: esp.V_IDLE,
      vmax: r2(this.vMax),
      vref: esp.V_REF,
      esp: {
        ...board,
        // What the board says it did, expressed the same way the UI shows it.
        pL: board.vL == null ? null : r1(esp.voltsToPct(board.vL, this.vMax)),
        pR: board.vR == null ? null : r1(esp.voltsToPct(board.vR, this.vMax)),
      },
      esp_fresh: this.tx.fresh,
      serial_error: this.tx.error,
      // The lift: which way it is being asked to go, what that is on the wire,
      // and what the board says it is actually doing. Three numbers rather than
      // one because they disagree in exactly the cases worth seeing — a
      // direction change passing through zero, and the run limit cutting in.
      lift: {
        dir: this.lift,                       // -1 / 0 / +1, what is being held
        out: this.liftOut,                    // -255..255, what goes on the wire
        pct: this.liftPct,
        at: board.lift ?? null,               // what the bridge is doing
        cut: board.lift_cut === true,         // run limit fired; let go to re-arm
        pin: board.lift_pin || null,
      },
      // The forward sensor's verdict, decided here rather than per page, so
      // every page shows the same phase as the one the throttle obeys.
      obstacle: {
        ...this.obs,
        guard: this.obsGuard,
        blocking: this.obsBlocking,
        stops: this.obsStops,
        cfg: { ...this.obsCfg },
      },
      // Small on purpose: position, heading, distance and the marks, at 10 Hz.
      // The path itself is thousands of points and is fetched once over HTTP —
      // see GET /api/route — with the page appending as it watches.
      route: {
        x: r2(this.route.x), y: r2(this.route.y),
        bearing: routeBearing(this.route),
        dist: r2(this.route.dist),
        v: r2(this.route.v),
        moving: this.route.moving,
        points: this.route.path.length,
        seq: this.route.seq,
        marks: this.route.marks.slice(-12),
        track: this.routeCfg.track,
        calibrated: !!(this.calib && Number(this.calib.pct) > 0
                       && Number(this.calib.metres) > 0 && Number(this.calib.seconds) > 0),
        since: this.route.since,
      },
      // Where that is on the competition field, which QR said so, and what to
      // do at the junction ahead. The graph itself is static and is fetched
      // once — see GET /api/field — so this carries only what changes.
      field: fieldStatus(this.field,
        { x: this.route.x, y: this.route.y, bearing: routeBearing(this.route) },
        this.fieldMap),
    };
  }
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const pct100 = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const dac255 = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));

function normaliseRow(raw, fallback) {
  // Accept both the current {p,r} shape and the older bare [%, %] array.
  if (Array.isArray(raw) && raw.length >= 2) {
    return { p: [pct100(raw[0]), pct100(raw[1])], r: [...fallback.r] };
  }
  if (raw && Array.isArray(raw.p) && raw.p.length >= 2) {
    return {
      p: [pct100(raw.p[0]), pct100(raw.p[1])],
      r: Array.isArray(raw.r) && raw.r.length >= 2
        ? [raw.r[0] === true, raw.r[1] === true]
        : [...fallback.r],
    };
  }
  return { p: [...fallback.p], r: [...fallback.r] };
}

function normaliseGears(raw) {
  const gears = {};
  for (const k of Object.keys(DEFAULT_GEARS)) gears[k] = [...DEFAULT_GEARS[k]];
  for (const k of Object.keys(DEFAULT_GEARS)) {
    const v = raw && raw[k];
    if (Array.isArray(v) && v.length >= 2) gears[k] = [dac255(v[0]), dac255(v[1])];
  }
  return gears;
}

function loadSaved() {
  const presets = {};
  for (const k of Object.keys(DEFAULT_PRESETS)) {
    presets[k] = { p: [...DEFAULT_PRESETS[k].p], r: [...DEFAULT_PRESETS[k].r] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
    for (const k of Object.keys(DEFAULT_PRESETS)) {
      if (k in raw) presets[k] = normaliseRow(raw[k], DEFAULT_PRESETS[k]);
    }
    const level = typeof raw._level === 'number' ? pct100(raw._level) : DEFAULT_LEVEL;
    return { presets, level, gears: normaliseGears(raw._gears) };
  } catch {
    // Missing or corrupt: fall back rather than refusing to start.
    return { presets, level: DEFAULT_LEVEL, gears: normaliseGears(null) };
  }
}

function saveState(presets, level, gears) {
  try {
    fs.writeFileSync(PRESETS_FILE,
      JSON.stringify({ ...presets, _level: level, _gears: gears }, null, 2));
  } catch (err) {
    console.warn('could not save presets:', err.message);
  }
}
