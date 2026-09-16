/**
 * The rover, as the road-following pages understand it.
 *
 * /follow was originally written against an ESP32 that took two analog
 * throttle levels, so what it sends is a 20 Hz stream of per-wheel demand in
 * percent — p25/p26, after the two GPIO pins that used to receive them. The
 * rover now runs on stepper drivers taking Marlin G-code, which is a position
 * language, not a throttle one. This is the translation between them, and it
 * is deliberately the only place that knows both.
 *
 *     /follow  ──{cmd:"follow", p25, p26}──>  setAuto()  ──>  Jogger.startWheels()
 *      20 Hz          percent per wheel         mm per chunk        G1 X… Y…
 *
 * The two rates are not the same and are not meant to be. A chunk takes a
 * couple of hundred milliseconds to run, and the Jogger queues the next one
 * before this one finishes rather than waiting it out (see STREAM_LEAD in
 * marlin.js), so demand still arrives several times faster than a chunk can
 * be acted on. Each chunk simply uses the newest demand — which is what you
 * want from a control loop, and why setAuto only ever stores a number.
 *
 * Volts do not carry over: there is no analog level any more, so /follow's
 * voltage readouts are vestigial and the page falls back to placeholder
 * numbers for them.
 */

import { DEFAULT_FEED } from './marlin.js';

/** Percent of full speed below which a wheel is treated as stopped. */
const DEADBAND_PCT = 0.5;

/**
 * How long one streamed chunk should take, in milliseconds.
 *
 * This is the steering resolution: the rover cannot change course inside a
 * chunk, so a long one means late corrections and a short one means the
 * planner spends its time accelerating and decelerating. 150 ms at a typical
 * speed is a few millimetres of travel, which is finer than the line detector
 * can resolve anyway.
 */
const CHUNK_MS = 150;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Held keys and a held fork stop by themselves this long after the page last
 * said so — the same 400 ms the ESP32 bench gives its keys and its lift. The
 * page repeats both at 20 Hz while they are down, so a frozen tab, a dropped
 * wifi or a laptop lid is a stop within half a second, not a fork driving into
 * its end of travel.
 */
export const HELD_STALE_MS = 400;

/** Fork speed on Z, mm/min. Under the Ender 3 Pro's 5 mm/s Z limit, so a fork
 *  moving while driving does not make Marlin slow the whole move down. */
export const LIFT_FEED = 240;

/** A turn with W held keeps the inner wheel at this share of the outer one. */
const ARC_INNER = 0.4;
/** A / D alone pivots on the spot, each wheel at this share of the key speed. */
const PIVOT = 0.6;

/**
 * W / A / S / D → the two wheel demands in percent, [left, right].
 *
 * W and S drive, A and D steer: with W or S held a turn is an arc (the inner
 * wheel slower), and on their own A and D spin on the spot. Opposite keys
 * cancel, so W+S is standing still rather than whichever arrived last.
 */
export function keysDemand(keys, pct) {
  const k = new Set((keys || []).map((x) => String(x).toLowerCase()));
  const v = clamp(Number(pct) || 0, 0, 100);
  const fwd = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0);
  const turn = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);   // + is right
  if (!fwd && !turn) return [0, 0];
  if (!fwd) return [turn * v * PIVOT, -turn * v * PIVOT];
  const outer = fwd * v, inner = fwd * v * ARC_INNER;
  return turn > 0 ? [outer, inner] : turn < 0 ? [inner, outer] : [outer, outer];
}

export class Rover {
  /**
   * @param {object} opts
   * @param {import('./marlin.js').MarlinLink} opts.link
   * @param {import('./marlin.js').Jogger} opts.jog
   * @param {number} [opts.maxFeed]  mm/min a wheel runs at 100 % demand
   */
  constructor({ link, jog, maxFeed = DEFAULT_FEED, replayer = null }) {
    this.link = link;
    this.jog = jog;
    // Drives a taught route (routes.js). While it does, it owns the wheels
    // outright: /follow keeps streaming demand at 20 Hz — zeroes, during a
    // route — and none of it may reach the jogger underneath a replay.
    this.replayer = replayer;
    this.maxFeed = maxFeed;
    this.chunkMs = CHUNK_MS;

    this.running = false;         // armed: the pages' START / STOP
    this.reason = 'stopped';
    this.demand = [0, 0];         // [left %, right %] as last asked for
    this.clients = 0;
    this.lastAt = 0;
    // Why the PLC mission says the wheels must not turn, or null. See plc_run.js.
    this.holdReason = null;

    // Keys held on /follow: a hand on the keyboard, as opposed to the pilot.
    this.keys = [];
    this.lastKeysAt = 0;
    // The fork, on Z: -1 down, 0 still, +1 up, held like the keys.
    this.lift = 0;
    this.lastLiftAt = 0;
    this.liftFeed = LIFT_FEED;
    this.liftInvert = false;

    // The dead-man's clock. unref'd, so a test that builds a Rover still exits.
    this._timer = setInterval(() => this._expire(), 100);
    this._timer.unref?.();
  }

  /** The saved tuning: fork speed and direction (follow.json → lift). */
  setCfg(cfg = {}) {
    const lift = cfg.lift || {};
    if (Number.isFinite(Number(lift.feed)) && Number(lift.feed) > 0) {
      this.liftFeed = clamp(Number(lift.feed), 10, 600);
    }
    if (typeof lift.invert === 'boolean') this.liftInvert = lift.invert;
  }

  /**
   * W / A / S / D from /follow, repeated at 20 Hz while any is down.
   * @param {string[]} keys   the letters held right now
   * @param {number} pct      the page's hand-drive speed, percent
   * @param {boolean} swap    /follow's "Tekerleri değiştir": the same swap the
   *                          pilot applies, so D turns the way the pilot does
   */
  setKeys(keys, pct, swap = false) {
    this.keys = (keys || []).map((k) => String(k).toLowerCase())
      .filter((k) => 'wasd'.includes(k) && k.length === 1);
    this.lastKeysAt = Date.now();
    const [left, right] = keysDemand(this.keys, pct);
    this.demand = swap ? [right, left] : [left, right];
    this.reason = this.keys.length ? `elle: ${this.keys.join('+').toUpperCase()}` : 'tuş basılı değil';
    this._push();
  }

  /** Q / E: the fork down (-1), up (+1) or still (0), repeated while held. */
  setLift(dir) {
    const d = this.holdAll ? 0 : Math.sign(Number(dir) || 0);
    this.lift = d;
    this.lastLiftAt = Date.now();
    this._push();
  }

  /** Anything held that the page has stopped repeating is let go. */
  _expire(now = Date.now()) {
    let changed = false;
    if (this.keys.length && now - this.lastKeysAt > HELD_STALE_MS) {
      this.keys = []; this.demand = [0, 0]; this.reason = 'tuş bildirimi yok';
      changed = true;
    }
    if (this.lift && now - this.lastLiftAt > HELD_STALE_MS) {
      this.lift = 0;
      changed = true;
    }
    if (changed) this._push();
  }

  /**
   * One chunk from everything that is asked for: the two wheels, if the rover
   * is armed and not held, and the fork, whenever it is held. Nothing asked
   * for is a stopped stream, not a stream of zeroes.
   */
  _push() {
    // A taught route being replayed owns the jogger outright (see replay()).
    if (!this.link.connected || (this.replayer && this.replayer.active)) return;
    const [left, right] = this.demand;
    const wheels = this.running && !this.holdReason
      && (Math.abs(left) >= DEADBAND_PCT || Math.abs(right) >= DEADBAND_PCT);
    if (!wheels && !this.lift) { this.jog.stop(); return; }

    const { dLeft, dRight } = wheels ? this.chunkFor(left, right) : { dLeft: 0, dRight: 0 };
    const minutes = this.chunkMs / 60000;
    const vLeft = wheels ? (left / 100) * this.maxFeed : 0;
    const vRight = wheels ? (right / 100) * this.maxFeed : 0;
    const vLift = this.lift * this.liftFeed * (this.liftInvert ? -1 : 1);
    // Marlin times the move by the length of the whole XYZ vector, so the feed
    // that keeps the chunk at chunkMs is the speeds combined the same way.
    const feed = Math.max(1, Math.hypot(vLeft, vRight, vLift));
    // The camera is bolted to the end of the chassis that DIRECTIONS calls the
    // BACK (see manualVec() in public/gcode.html, which flips W/S for the same
    // reason). The pilot steers in the camera's frame — its "left wheel" is the
    // wheel on the left of the picture — so driving the rover that way round is
    // a 180° turn of the chassis.
    //
    // A 180° turn is two things, not one: every wheel travels the other way AND
    // the wheels swap sides. Only the first half used to be applied here, which
    // drove the right way but steered exactly backwards — the correction meant
    // for the outer wheel reached the inner one, so the rover turned away from
    // the road it was trying to reach, and every correction made the error it
    // was correcting bigger.
    //
    // /follow's W A S D come through here too, so W is the camera's forward,
    // the way the pilot drives. jog.start() (/gcode's held keys) is unaffected:
    // /gcode swaps the ends itself for W/S, and a spin reads the same from
    // either end.
    this.jog.startWheels(-dRight, -dLeft, feed, vLift * minutes);
  }

  close() { clearInterval(this._timer); }

  /**
   * The PLC mission's brake: waiting for "start", at the door, e-stop.
   * The current chunk is cancelled and no new one goes out until released.
   */
  hold(reason, all = false) {
    this.holdReason = reason || null;
    // Waiting at a door holds the wheels; an emergency stop holds the fork too.
    this.holdAll = !!(this.holdReason && all);
    if (this.holdAll) this.lift = 0;
    if (this.holdReason) this.jog.stop();
    // A taught route drives the board by itself (routes.js), so stopping the
    // jogger is not enough. An emergency stop ends it; any other hold — the
    // PLC's bekle, the door — pauses it where it is, and releasing the hold
    // carries it on from that point rather than from the top.
    if (this.replayer) {
      if (this.holdAll) this.replayer.cancel(this.holdReason);
      else this.replayer.hold(this.holdReason);
    }
  }

  clientJoined() { this.clients += 1; }

  clientLeft() {
    this.clients -= 1;
    // A closed tab is a released dead-man. Nothing should keep driving because
    // a browser went away.
    if (this.clients <= 0) { this.clients = 0; this.stop('browser gone'); }
  }

  start() {
    this.running = true;
    this.reason = 'armed';
  }

  stop(reason = 'stopped') {
    this.running = false;
    this.reason = reason;
    this.demand = [0, 0];
    this.keys = [];
    // STOP means all of it, the fork included. A fork still held on the page
    // comes back on its next 20 Hz repeat, which is what a held key should do.
    this.lift = 0;
    this.jog.stop();
    // DAYAN, a closed tab, a lost socket: a route being replayed stops with
    // everything else. It is the one kind of driving that would otherwise
    // carry on by itself.
    if (this.replayer) this.replayer.cancel(reason);
  }

  /**
   * Drive a taught route (routes.js) under /follow's cargo run.
   *
   * Only while armed. The page arms, and DAYAN disarms — so a replay that
   * could start without the rover being armed would be driving with no stop
   * button attached to it.
   */
  replay(id, segs, route = null) {
    if (!this.replayer) return null;
    if (!this.running) return this.replayer.fail(id, 'rover dayanıb — əvvəlcə SÜRMƏYƏ BAŞLA', route);
    if (!segs) return this.replayer.fail(id, `${route || 'yol'} öyrədilməyib`, route);
    this.jog.stop();
    this.reason = `yaddaşdan: ${route || id}`;
    return this.replayer.run(id, segs, route);
  }

  /**
   * One frame's worth of steering, as the two wheel demands in percent.
   *
   * Called at whatever rate the vision loop runs. It stores the demand and
   * hands the jogger the chunk it implies; the jogger decides when that chunk
   * actually goes out.
   */
  setAuto(p25, p26, reason = null) {
    const left = clamp(Number(p25) || 0, -100, 100);
    const right = clamp(Number(p26) || 0, -100, 100);
    this.demand = [left, right];
    this.lastAt = Date.now();
    if (reason) this.reason = reason;

    this.keys = [];                   // the pilot has the wheels now
    if (!this.running && !this.lift) return;
    // Below the dead band both wheels are stopped, and a stopped rover is the
    // absence of a stream rather than a stream of zeroes — see _push().
    this._push();
  }

  /**
   * Wheel demand in percent -> millimetres for one chunk, plus the feed rate.
   *
   * Marlin times a move by the length of the XY vector, not by either wheel,
   * so for a chunk of duration T the feed that makes it take T is
   * hypot(vLeft, vRight) — the wheel speeds combined the same way Marlin
   * combines the distances. Getting this wrong does not steer wrong, it just
   * makes the chunk take a different time than intended, which shows up as the
   * rover being slower than the speed the page is displaying.
   */
  chunkFor(leftPct, rightPct) {
    const minutes = this.chunkMs / 60000;
    const vLeft = (leftPct / 100) * this.maxFeed;      // mm/min
    const vRight = (rightPct / 100) * this.maxFeed;
    return {
      dLeft: vLeft * minutes,
      dRight: vRight * minutes,
      feed: Math.max(1, Math.hypot(vLeft, vRight)),
    };
  }

  /**
   * True while the robot is actually backing up — both wheels asked to go
   * backwards, and asked by something that is allowed to drive. Pivoting on
   * the spot is not reversing: one wheel goes back, the robot does not.
   * This is what sounds the buzzer; see buzzer.js.
   */
  get reversing() {
    if (!this.running || this.holdReason) return false;
    const [left, right] = this.demand;
    return left <= -DEADBAND_PCT && right <= -DEADBAND_PCT;
  }

  /** Ground speed and turn implied by a demand, for the UI and for tests. */
  motionFor(leftPct, rightPct) {
    const { dLeft, dRight } = this.chunkFor(leftPct, rightPct);
    return {
      ground: (dLeft + dRight) / 2,     // mm the rover advances per chunk
      turn: dRight - dLeft,             // mm of difference between the wheels
      mmPerSec: ((dLeft + dRight) / 2) / (this.chunkMs / 1000),
    };
  }

  snapshot() {
    const fresh = this.link.connected && this.link.sawRx;
    return {
      running: this.running,
      reason: this.holdReason || this.reason,
      hold: this.holdReason,
      clients: this.clients,
      // The pages were written for a board reached over wifi, and ask whether
      // it has been heard from recently. The serial link answers the same
      // question, so the field keeps its name rather than the pages changing.
      esp_fresh: fresh,
      serial_error: this.link.connected
        ? null
        : 'the rover mainboard is not connected — open /gcode and press Connect',
      set: this.demand.map((v) => Math.round(v * 10) / 10),
      out: this.running ? this.demand.map((v) => Math.round(v * 10) / 10) : [0, 0],
      max_feed: this.maxFeed,
      chunk_ms: this.chunkMs,
      reversing: this.reversing,
      keys: this.keys,
      lift: { dir: this.lift, feed: this.liftFeed, invert: this.liftInvert },
      jogging: this.jog.active,
      replay: this.replayer ? this.replayer.status() : null,
      // What the rover is physically doing with the current demand, in units
      // that mean something on wheels rather than on a DAC pin.
      motion: this.motionFor(...this.demand),
    };
  }
}
