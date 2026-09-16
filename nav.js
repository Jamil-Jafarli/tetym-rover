/**
 * Where the rover is, kept by the server: an odometer fed off the wire, and
 * the QR localisation on top of it — see public/qrnav.js.
 *
 * Server-side, not in a page, for the same reasons the QR reader is: the
 * rover drives past a code whether or not anybody has /dashboard open, two
 * browsers watching should get one answer rather than two, and a reload must
 * not forget where the rover is.
 *
 * ── The odometer ────────────────────────────────────────────────────
 *
 * Every G1 that actually reaches the board is heard through link.onWrite() —
 * the tap routes.js records taught routes from — and integrated. That catches
 * every way this rover can be driven: a held key on /gcode, /follow's steering
 * stream, a taught route being replayed, a line typed into the console. And
 * only what was written: a chunk that a halt dropped from the queue never
 * moved a wheel, and is never counted.
 *
 * The wheels are steppers, so a written millimetre is a turned millimetre
 * unless something slipped — the distance is a count, not a calibration. The
 * heading is the one real error (it is an integral), and the heading is what
 * each QR read throws away.
 *
 * Moves are relative (G91 is sent on connect and stays in force). A G90 from
 * the console switches to absolute, where a line is a position rather than a
 * distance; those are not counted until a G91 comes back.
 */

import { loadShared } from './shared.js';
import { parseMove } from './routes.js';

const NAV = loadShared(['field.js', 'qrnav.js'], [
  'FIELD', 'FIELD_TRACK_M', 'navQrs', 'navOdoState', 'navOdoStep', 'navOdoMark',
  'navOdoPose', 'navState', 'navSee', 'navMission', 'navClearMission', 'navStatus',
]);
export const { FIELD, navQrs } = NAV;

/** How long a window the speed readout averages over, ms. */
const SPEED_WINDOW_MS = 1000;

const r2 = (v) => Math.round(v * 100) / 100;

export class Nav {
  /**
   * @param {object} opts
   * @param {import('./marlin.js').MarlinLink} [opts.link]  heard through
   *        onWrite(); omitted in tests, which call wrote() themselves
   */
  constructor({ link = null } = {}) {
    this.link = link;
    this.track = NAV.FIELD_TRACK_M;
    this.odo = NAV.navOdoState(Date.now());
    this.st = NAV.navState();
    this.absolute = false;       // a G90 is in force: lines are positions
    this._recent = [];           // [at, metres] for the speed readout
    this._off = link ? link.onWrite((cmd) => this.wrote(cmd)) : null;
  }

  /** follow.json: the wheel track, if one has been measured. */
  setCfg(cfg) {
    const t = Number(cfg && cfg.route && cfg.route.track);
    this.track = t > 0 ? t : NAV.FIELD_TRACK_M;
  }

  /** +1, or -1 if the board's axis is wired the other way round. */
  _sign(axis) { return this.link && this.link.sign ? this.link.sign(axis) : 1; }

  /**
   * One line, as it went out on the wire.
   *
   * The wire speaks motor axes; the odometer speaks the camera's wheels.
   * Jogger.startWheels(left, right) puts {X: -left, Y: right} on the wire for
   * the CHASSIS wheels, and rover.setAuto() hands it (-camRight, -camLeft)
   * because the camera is on the end DIRECTIONS calls the back. Undone:
   *
   *     camera left  = -Y      camera right = +X        (after link.sign)
   *
   * which makes /follow's "forward" forward and its "steer right" a right
   * turn — the same frame mission.js integrates in, so the two odometers
   * agree. /gcode's W is that same forward (manualVec() swaps W and S).
   */
  wrote(cmd, now = Date.now()) {
    const s = String(cmd || '').trim().toUpperCase();
    if (/^G90(?!\d)/.test(s)) { this.absolute = true; return false; }
    if (/^G91(?!\d)/.test(s)) { this.absolute = false; return false; }
    if (this.absolute) return false;
    const m = parseMove(s);
    if (!m || (m.x === undefined && m.y === undefined)) return false;
    const ax = (m.x || 0) * this._sign('X');
    const ay = (m.y || 0) * this._sign('Y');
    const left = -ay, right = ax;
    NAV.navOdoStep(this.odo, left, right, now, this.track);
    this._recent.push([now, Math.abs(this.odo.ds)]);
    return true;
  }

  /** Metres per second over the last second of written moves. */
  speed(now = Date.now()) {
    while (this._recent.length && now - this._recent[0][0] > SPEED_WINDOW_MS) this._recent.shift();
    return this._recent.reduce((a, [, m]) => a + m, 0) / (SPEED_WINDOW_MS / 1000);
  }

  /**
   * A QR code was read: pin it to the trail, and fix the position with it —
   * both, because the pin is worth seeing even for a code that is not one of
   * the field's, and the fix only happens for one that is. The odometer pose
   * goes in at the same instant so the two frames are anchored to each other.
   */
  seeQr(text, now = Date.now()) {
    const mark = NAV.navOdoMark(this.odo, 'qr', text, now);
    const fix = NAV.navSee(this.st, text, now, NAV.FIELD, NAV.navOdoPose(this.odo));
    return { mark, fix };
  }

  /** The stops to call at, in order — e.g. ['A2', 'B3']; [] clears. */
  setMission(targets, from = null) {
    if (!Array.isArray(targets) || targets.length === 0) {
      NAV.navClearMission(this.st);
      return { nodes: [], stops: [], ok: true, reason: null };
    }
    return NAV.navMission(this.st, targets, NAV.FIELD, from);
  }

  /**
   * Start the trail again from here. The anchor tied the field to odometer
   * coordinates that no longer exist, so it goes too — "I do not know where I
   * am until the next QR" beats an offset into a frame just reset to zero.
   * The mission is kept, re-planned from the start area.
   */
  reset(now = Date.now()) {
    const stops = this.st.stops;
    this.odo = NAV.navOdoState(now);
    this.st = NAV.navState();
    this._recent = [];
    if (stops && stops.length) NAV.navMission(this.st, stops, NAV.FIELD, 'START');
  }

  /** The whole trail, once — GET /api/route. */
  routeJson() {
    const o = this.odo;
    return { path: o.path, marks: o.marks, seq: o.seq, since: o.since,
             x: r2(o.x), y: r2(o.y), dist: r2(o.dist) };
  }

  /**
   * What goes in the 10 Hz status frame. Small on purpose: the path itself is
   * thousands of points and is fetched once over HTTP, with the page
   * appending from `route.x/y` as it watches.
   */
  status(now = Date.now()) {
    const o = this.odo;
    return {
      route: {
        x: r2(o.x), y: r2(o.y), bearing: Math.round(o.h * 10) / 10,
        dist: r2(o.dist), v: r2(this.speed(now)),
        seq: o.seq, points: o.path.length, marks: o.marks.slice(-12),
        track: this.track, since: o.since,
        // The server's clock, so a page stamps its points on the same clock
        // the anchor was stamped on.
        t: now,
        absolute: this.absolute,
      },
      field: NAV.navStatus(this.st, NAV.navOdoPose(o), NAV.FIELD),
    };
  }

  close() { if (this._off) this._off(); this._off = null; }
}
