/**
 * The pilot — turns a steering error into two wheel percentages.
 *
 * Deliberately a pure function of (state, observation, config). No canvas, no
 * DOM, no clock of its own: the caller passes `now`. That is what makes it
 * testable without a browser (test/test_pilot.mjs) and what makes a recorded
 * log replayable — the same rows fed back in produce the same outputs, so
 * retuning can be done against a real run instead of against the robot.
 *
 * Steering is by speed difference only. Both wheels always drive forward and
 * the inner one is slowed; the direction relays are never touched, so there is
 * no interlock pause mid-corner. At full steer the inner wheel reaches zero,
 * which is the tightest turn available without reversing anything.
 *
 * Two things here exist because of what the logs showed:
 *
 * `stall` — this motor does not turn at all below about 1.5 V, which on a
 * 3.3 V ceiling is 22 %. Every percentage below that is not "slow", it is
 * "stopped". Driving at base 25 therefore meant the outer wheel sat 3 points
 * above the threshold and the inner wheel — 25 × (1 − steer) — dropped under it
 * the moment the steer passed 0.13. In one 59-second run, 91 % of all wheel
 * commands were in that dead band: asked to move, not moving. So the demand is
 * mapped onto the range that actually does something, and 0 still means 0.
 *
 * `hard` — past a certain error the robot is not on the road any more and
 * driving forward only makes it worse. Then it crawls and turns on the spot
 * toward the road instead.
 */

const PILOT_DEFAULTS = {
  // These are demands, 0-100, on the usable range — see `stall`. They are NOT
  // pin percentages any more, which is why they are smaller than they look.
  base:   18,    // on a straight — the speed everything else is cut from
  min:    5,     // floor while actually following
  max:    50,    // ceiling, whatever the maths says
  kP:     0.85,  // steer per unit of error (error is -1..+1 across the frame)
  kD:     0.12,  // seconds of look-ahead — damping, in units of time
  curve:  0.75,  // how hard a bend cuts the speed (1 = full stop at full bend)
  short:  0.35,  // how hard a short/uncertain chain cuts it
  accel:  90,    // % per second going up   — gentle
  brake:  400,   // % per second coming down — braking is never the risky way
  hold:   600,   // ms to keep going on the last steer after losing the road
  holdCut: 55,   // % of the current speed while running blind
  give:   1500,  // ms after `hold` before giving up and dropping ENABLE
  // The pin percentage at which the wheel starts to turn at all. Everything
  // below it is electrically "stopped", so the demand is mapped onto
  // [stall, 100] and only an exact zero stays at zero.
  stall:  22,
  // Per wheel, because two motors are never the same motor. `null` means "use
  // `stall` above"; a number overrides it for that pin. `gain` is the last
  // trim: if one wheel is still faster at the same volts, take it down.
  //
  // These exist because the shared number cannot be right for both. Two
  // controllers off the same reel differ by a few percent, and near the
  // threshold a few percent is the difference between turning and not.
  stall25: null, stall26: null,
  gain25:  1,    gain26:  1,
  hard:   0.6,   // |error| past which it stops driving forward and turns in place
  crawl:  10,    // demand while doing that
  swap:   false, // true if GPIO26 is the left wheel rather than GPIO25
};

// Leaving recovery costs more than entering it, so a robot sitting right on the
// threshold does not flicker between crawling and driving.
const RECOVER_EXIT = 0.15;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A fresh pilot state. Call this on ARM, not once per page. */
function pilotState(now = 0) {
  return { t: now, speed: 0, err: 0, steer: 0, lostAt: 0, armedAt: now,
           recover: false };
}

/**
 * One control step.
 *
 * @param st   pilot state, mutated in place (see pilotState)
 * @param obs  {near, far, bands, want} from roadError(); `near === null` if lost
 * @param cfg  PILOT_DEFAULTS, or a copy with the sliders applied
 * @param now  milliseconds, monotonic
 * @returns {{p25,p26,speed,steer,reason,lost,stop}}
 */
function pilotStep(st, obs, cfg, now) {
  const c = { ...PILOT_DEFAULTS, ...cfg };
  // A frame that took longer than 250 ms means the tab was throttled or the
  // camera stalled. Treating that gap as real would let the ramp jump; clamp
  // it and let the next frame carry on.
  const dt = clamp((now - st.t) / 1000, 0.001, 0.25);
  st.t = now;

  const seen = obs && obs.near !== null && obs.near !== undefined && obs.bands >= 2;
  let target, reason, stop = false;

  if (seen) {
    st.lostAt = 0;
    const near = clamp(obs.near, -1, 1);
    const far = clamp(obs.far == null ? near : obs.far, -1, 1);
    const off = Math.max(Math.abs(near), Math.abs(far));

    // Far enough off that driving forward makes it worse. The logs are full of
    // this: errors of 0.9 — the road at the very edge of the frame — reached
    // while still trying to drive through the corner, and then lost. Turning
    // toward it at a crawl is the only thing that helps, and it is the only
    // thing a speed-difference robot can do without reversing a wheel.
    if (off >= c.hard) st.recover = true;
    else if (off < c.hard - RECOVER_EXIT) st.recover = false;

    if (st.recover) {
      st.steer = near >= 0 ? 1 : -1;      // inner wheel to zero: pivot, slowly
      st.err = near;
      target = clamp(c.crawl, 0, c.max);
      reason = near >= 0 ? 'yol çok sağda — dönüyor' : 'yol çok solda — dönüyor';
    } else {
      // PD, with the D term expressed as a look-ahead time rather than a raw
      // gain: `kP * (e + kD * de/dt)` is "where the error will be kD seconds
      // from now", which is a number you can reason about while tuning.
      const rate = (near - st.err) / dt;
      st.steer = clamp(c.kP * (near + c.kD * rate), -1, 1);
      st.err = near;

      // Speed limit. Two independent cuts, both multiplicative:
      //   bend  — the road ahead is off to one side, so slow down BEFORE the
      //           corner; `far` is what makes that possible.
      //   short — the chain died early, so we cannot see far enough to justify
      //           the speed we are asking for.
      const bend = clamp(off, 0, 1);
      const seenFrac = clamp(obs.bands / Math.max(1, obs.want || 8), 0, 1);
      const limit = c.base * (1 - c.curve * bend) * (1 - c.short * (1 - seenFrac));
      target = clamp(limit, Math.min(c.min, c.max), c.max);
      reason = bend > 0.35 ? 'viraj' : 'düz yol';
    }
  } else {
    if (!st.lostAt) st.lostAt = now;
    const lost = now - st.lostAt;
    if (lost <= c.hold) {
      // Chosen behaviour: hold the last steer and keep going slowly. A sharp
      // corner drops the chain for a few frames and this is what carries the
      // robot through it.
      target = st.speed * (c.holdCut / 100);
      reason = 'yol görünmüyor — son yönle';
    } else {
      target = 0;
      st.steer = 0;
      st.recover = false;
      reason = lost > c.hold + c.give ? 'yol yok — durdu' : 'yol yok — duruyor';
      // Past the grace period, ask the caller to drop ENABLE as well. Coasting
      // at 0 % with the driver live is not a resting state to leave a robot in.
      stop = lost > c.hold + c.give;
    }
  }

  // Ramp. Up is limited hard because a step on the throttle is what makes a
  // robot lurch off the line; down is barely limited, because slowing early is
  // never the thing that goes wrong.
  const rate = target > st.speed ? c.accel : c.brake;
  const step = rate * dt;
  st.speed = target > st.speed
    ? Math.min(target, st.speed + step)
    : Math.max(target, st.speed - step);
  if (st.speed < 0.01) st.speed = 0;

  // Mix: the outer wheel gets the speed, the inner one gets what is left after
  // the steer. Positive error means the road is to the right, so the right
  // wheel is the one that slows.
  const inner = st.speed * (1 - Math.abs(st.steer));
  const left = st.steer > 0 ? st.speed : inner;
  const right = st.steer > 0 ? inner : st.speed;

  // Per wheel: its own dead band, then its own gain. Applied after `swap`, so
  // the trim belongs to the PIN — which is what you measured — rather than to
  // whichever side of the robot it happens to drive.
  //
  // Number(null) is 0 and Number.isFinite(0) is true, so "no override" has to
  // be checked for explicitly: falling through to a stall of zero is the one
  // value that would undo the whole dead-band compensation.
  const num = (v, d) => (v === null || v === undefined || !Number.isFinite(Number(v))
    ? d : Number(v));
  const wheel = (demand, stall, gain) =>
    Math.round(clamp(lift(clamp(demand * gain, 0, 100), stall), 0, 100) * 10) / 10;
  return {
    p25: wheel(c.swap ? right : left, num(c.stall25, c.stall), num(c.gain25, 1)),
    p26: wheel(c.swap ? left : right, num(c.stall26, c.stall), num(c.gain26, 1)),
    speed: Math.round(st.speed * 10) / 10,   // the demand, before the dead band
    steer: Math.round(st.steer * 1000) / 1000,
    reason,
    lost: !seen,
    recover: st.recover,
    stop,
  };
}

/**
 * Demand → the percentage that actually reaches the pin.
 *
 * Below `stall` the wheel does not turn, so the useful range is [stall, 100]
 * and a demand of 0-100 is stretched across it. Zero is the exception and stays
 * zero: "stop this wheel" has to remain reachable, and it is what makes the
 * tightest turn possible.
 *
 * The discontinuity at zero is real, not an artefact — a motor that will not
 * move below 1.5 V has exactly that step in it.
 */
function lift(demand, stall) {
  const s = clamp(Number(stall) || 0, 0, 99);
  if (demand <= 0) return 0;
  return s + (demand * (100 - s)) / 100;
}

/**
 * Distance, from a percentage.
 *
 * There is no encoder on this robot: the ESP32 reports the voltage it put on
 * the pin and nothing about what the wheel did with it. So speed is modelled
 * as proportional to throttle above a dead band, with one constant measured
 * once by hand — drive at a known percentage over a known distance and time.
 *
 * It is a straight line through a real point, not a claim about the motor. It
 * is good enough to say "this lap was 11 m and that one 11.4 m", which is what
 * the logs are for; it is not good enough to navigate by.
 */
function metresPerSecond(pct, calib) {
  const c = calib || {};
  const at = Number(c.pct) || 0;
  const m = Number(c.metres) || 0;
  const s = Number(c.seconds) || 0;
  if (at <= 0 || m <= 0 || s <= 0) return null;      // not calibrated yet
  const dead = clamp(Number(c.dead) || 0, 0, 99);    // % below which it does not turn
  const span = Math.max(1e-6, at - dead);
  const k = (m / s) / span;                          // m/s per % above the dead band
  return Math.max(0, (clamp(pct, 0, 100) - dead)) * k;
}

/**
 * The speed loop — the only thing that makes a wheel hold its speed.
 *
 * Everything else in this file is open loop: it decides a voltage and hopes.
 * That hope is broken by a dozen things at once — the two DAC channels differ,
 * the 3.3 V rail sags under load, the ground wire drops a tenth of a volt, the
 * battery empties, one motor is simply not the other, and the floor changes.
 * Calibration reduces each of those; none of them go away.
 *
 * Measuring the wheel removes all of them together, because the loop stops
 * caring what voltage it takes. It pushes until the wheel turns at the rate it
 * was asked for, whatever that costs in volts today.
 *
 * Feedback is pulses per second from the motor's hall sensor. The controller is
 * a PI on top of the open-loop guess: the guess gets it roughly right
 * immediately, the integral removes what is left. Proportional alone would
 * leave a permanent error; integral alone would be slow and overshoot.
 */
const SPEED_DEFAULTS = {
  closed:  false,  // off until hzFull has been measured — see /pins
  hzFull:  0,      // pulses per second this wheel gives at demand 100
  kP:      0.15,   // pin % per Hz of error
  kI:      0.6,    // pin % per Hz per second
  maxTrim: 35,     // how far the loop may pull away from the open-loop guess
  deadMs:  500,    // no pulses for this long while driving = feedback is gone
};

/** Fresh state for one wheel's speed loop. */
function speedState(now = 0) {
  return { t: now, i: 0, movingSince: 0, seenAt: now, ok: true };
}

/**
 * One step of the speed loop, for ONE wheel.
 *
 * @param st      per-wheel state from speedState()
 * @param demand  0-100, what the pilot asked for
 * @param ff      the open-loop pin %, from lift() — the starting guess
 * @param hz      measured pulses per second, or null if there is no sensor
 * @param cfg     SPEED_DEFAULTS with the measured numbers filled in
 * @returns {{pin, target, trim, closed, ok, reason}}
 */
function speedStep(st, demand, ff, hz, cfg, now) {
  const c = { ...SPEED_DEFAULTS, ...cfg };
  const dt = clamp((now - st.t) / 1000, 0.001, 0.25);
  st.t = now;

  // Stopped means stopped. Winding the integral against a wheel that is meant
  // to be still is how a robot lurches when you let go of it.
  if (demand <= 0) {
    st.i = 0;
    st.movingSince = 0;
    st.ok = true;
    return { pin: 0, target: 0, trim: 0, closed: false, ok: true, reason: 'durdu' };
  }

  if (!c.closed || !(c.hzFull > 0)) {
    st.i = 0;
    return { pin: ff, target: 0, trim: 0, closed: false, ok: true,
             reason: c.closed ? 'kalibrasyon yok' : 'açık çevrim' };
  }

  const target = (demand / 100) * c.hzFull;
  const meas = (hz === null || hz === undefined || !Number.isFinite(Number(hz)))
    ? null : Number(hz);

  // No sensor, or a sensor that has gone quiet while we are asking for
  // movement. Either way the loop is blind, and a blind integrator is a robot
  // that ramps to full throttle against a jammed wheel. Fall back to the guess
  // and say so.
  if (!st.movingSince) st.movingSince = now;
  if (meas !== null && meas > 0) st.seenAt = now;
  const blind = meas === null
    || (meas <= 0 && now - st.seenAt > c.deadMs && now - st.movingSince > c.deadMs);
  if (blind) {
    st.i = 0;
    st.ok = false;
    return { pin: ff, target, trim: 0, closed: false, ok: false,
             reason: 'darbe gelmiyor — açık çevrime geçti' };
  }
  st.ok = true;

  const err = target - meas;
  // Integrate first, then clamp the total: clamping the sum rather than the
  // integral alone is what stops the integral quietly growing while the output
  // is already pinned.
  st.i += err * c.kI * dt;
  st.i = clamp(st.i, -c.maxTrim, c.maxTrim);
  let trim = clamp(err * c.kP + st.i, -c.maxTrim, c.maxTrim);

  let pin = ff + trim;
  if (pin > 100 || pin < 0) {
    pin = clamp(pin, 0, 100);
    // Anti-windup: hand back exactly the integral the clamped output implies,
    // so the loop leaves saturation the moment the error changes sign.
    st.i = clamp(pin - ff - err * c.kP, -c.maxTrim, c.maxTrim);
    trim = pin - ff;
  }

  return {
    pin: Math.round(pin * 10) / 10,
    target: Math.round(target * 10) / 10,
    trim: Math.round(trim * 10) / 10,
    closed: true,
    ok: true,
    reason: `hedef ${Math.round(target)} Hz · ölçülen ${Math.round(meas)} Hz`,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PILOT_DEFAULTS, pilotState, pilotStep, metresPerSecond,
                     SPEED_DEFAULTS, speedState, speedStep, lift };
}
