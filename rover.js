/**
 * The rover, as the road-following pages understand it.
 *
 * /follow was written against an ESP32 that took two analog throttle levels,
 * so what it sends is a 20 Hz stream of per-wheel demand in percent. The rover
 * now runs on stepper drivers taking Marlin G-code, which is a position
 * language, not a throttle one. This is the translation between them, and it
 * is deliberately the only place that knows both.
 *
 *     /follow  ──{cmd:"follow", p25, p26}──>  setAuto()  ──>  Jogger.startWheels()
 *      20 Hz          percent per wheel         mm per chunk        G1 X… Y…
 *
 * The two rates are not the same and are not meant to be. A chunk takes a
 * couple of hundred milliseconds to run and the next one is not sent until it
 * has finished (see Jogger), so demand arrives four or five times faster than
 * it can be acted on. Each chunk simply uses the newest demand — which is what
 * you want from a control loop, and why setAuto only ever stores a number.
 *
 * What does NOT carry over from the ESP32:
 *
 *   · Volts. There is no analog level any more; /follow's voltage readouts are
 *     vestigial and the page falls back to placeholder numbers for them.
 *   · The dead band. A brushed motor below its stall voltage sits still and
 *     hums, which is what `stall` in the wheel trim compensates for. A stepper
 *     has no such threshold — it moves at whatever rate it is told — so that
 *     calibration is a no-op here and can be left at its defaults.
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

export class Rover {
  /**
   * @param {object} opts
   * @param {import('./marlin.js').MarlinLink} opts.link
   * @param {import('./marlin.js').Jogger} opts.jog
   * @param {number} [opts.maxFeed]  mm/min a wheel runs at 100 % demand
   */
  constructor({ link, jog, maxFeed = DEFAULT_FEED }) {
    this.link = link;
    this.jog = jog;
    this.maxFeed = maxFeed;
    this.chunkMs = CHUNK_MS;

    this.running = false;         // armed: the pages' START / STOP
    this.reason = 'stopped';
    this.demand = [0, 0];         // [left %, right %] as last asked for
    this.clients = 0;
    this.lastAt = 0;
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
    this.jog.stop();
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

    if (!this.running || !this.link.connected) return;

    // Below the dead band both wheels are stopped, and a stopped rover is the
    // absence of a stream rather than a stream of zeroes.
    if (Math.abs(left) < DEADBAND_PCT && Math.abs(right) < DEADBAND_PCT) {
      this.jog.stop();
      return;
    }

    const { dLeft, dRight, feed } = this.chunkFor(left, right);
    this.jog.startWheels(dLeft, dRight, feed);
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
      reason: this.reason,
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
      jogging: this.jog.active,
      // What the rover is physically doing with the current demand, in units
      // that mean something on wheels rather than on a DAC pin.
      motion: this.motionFor(...this.demand),
    };
  }
}
