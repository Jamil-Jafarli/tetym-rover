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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_FILE = path.join(HERE, 'presets.json');

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
  constructor({ transport, vMax = esp.V_MAX } = {}) {
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

    // Follow page state: the browser's vision loop steering the robot.
    this.autoMode = false;
    this.lastAutoAt = 0;
    this.autoReason = '';
    this.scanSpin = 0;

    // Direction: we ask, the board decides when it is safe to actually move.
    this.dirWant = [false, false];   // [GPIO25 rev, GPIO26 rev]
    this.dirAt = 0;                  // when the request changed
    this._dirLast = [false, false];  // fallback for transports with no readback
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
   * Spin the sonar servo, or stop it.
   *
   * Passed straight through: the scan has nothing to do with the drive state,
   * so it works whether or not the robot is armed — which is the point, because
   * mapping a room is something you do while standing still.
   */
  setScan(spin) {
    this.scanSpin = Math.max(-100, Math.min(100, Math.round(Number(spin) || 0)));
    if (typeof this.tx.scan === 'function') this.tx.scan(this.scanSpin);
    return this.scanSpin;
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
  stop() { this.running = false; }

  idle() {
    this.running = false;
    this.p25 = this.p26 = 0;
    this.keyMode = false;
    this.autoMode = false;
    this.gear = null;
    this.keys = [];
    this.combo = null;
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
  static dirName(d) {
    if (!d[0] && !d[1]) return 'FORWARD';
    if (d[0] && d[1]) return 'BACK';
    return d[0] ? 'PIVOT A' : 'PIVOT D';
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
    if (this._closed) return [0, 0, false, 'shutting down'];
    if (this.clients === 0) return [0, 0, false, 'no browser connected'];
    if (!this.running) return [0, 0, false, 'stopped'];
    if (!this.tx.fresh) return [0, 0, false, 'esp32 unreachable'];
    // Armed but the drive page stopped reporting: coast, stay enabled. Holding
    // enable through a released key is deliberate — toggling it on every
    // keystroke would hammer the relay.
    if (this.keyMode && Date.now() - this.lastKeysAt > KEYS_STALE_MS) {
      return [0, 0, true, 'no keys held'];
    }
    // Same rule for the follow page: no fresh frame, no throttle. Enable stays
    // up so a dropped frame does not cost a relay cycle, but nothing moves.
    if (this.autoMode && Date.now() - this.lastAutoAt > KEYS_STALE_MS) {
      return [0, 0, true, 'kadr gəlmir'];
    }
    // And for a gear. It is a held throttle with no keyup behind it, so the
    // only thing standing between a wedged tab and a robot at 3.12 V is the
    // page still saying, twenty times a second, that it means it.
    if (this.gear && Date.now() - this.lastGearAt > KEYS_STALE_MS) {
      return [0, 0, true, 'no gear report'];
    }
    // A direction change is pending: hold everything at zero so the wheels
    // stop and the board's interlock can release. Crossing phase wires under
    // load destroys the controller's output stage.
    if (this.dirSettling) {
      return [0, 0, true, `${Bench.dirName(this.dirWant).toLowerCase()}…`];
    }
    if (this.level === 0 && !this.autoMode && !this.gear) {
      return [0, 0, true, 'level 0 %'];
    }
    const moving = Bench.dirName(this.dirWant);
    const label = moving === 'FORWARD'
      ? (this.autoMode ? `follow: ${this.autoReason || 'gedir'}`
        : this.gear ? `gear ${this.gear}`
        : this.combo ? `key ${this.combo}` : 'running')
      : moving;
    return [this.scaled(this.p25), this.scaled(this.p26), true, label];
  }

  tick() {
    const [a, b, en] = this.resolve();
    // Request the direction straight away. Holding the throttle at zero (in
    // resolve) is what lets the board's interlock release.
    this.tx.send(esp.pctToVolts(a, this.vMax), esp.pctToVolts(b, this.vMax), en,
                 this.dirWant);
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
      scan_spin: this.scanSpin,
      presets: this.presets,
      level: this.level,
      gear: this.gear,                         // which fixed speed is engaged
      gears: this.gears,                       // ...and the codes behind both
      gear_clamped: this.gearClamped,
      dir_want: this.dirWant,
      dir: this.dir,
      dir_settling: this.dirSettling,
      dir_name: Bench.dirName(this.dirWant),
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
