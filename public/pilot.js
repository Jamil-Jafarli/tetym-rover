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
 * `hard` exists because of what the logs showed: past a certain error the
 * robot is not on the road any more and driving forward only makes it worse.
 * Then it crawls and turns on the spot toward the road instead.
 *
 * A 90° corner is the one thing none of that can do. Steering assumes the road
 * is somewhere off to a side and can be converged on; at a right angle the road
 * simply ends and a new one leaves sideways, so there is nothing to converge
 * on and the chain vanishes a moment later. So the corner is a manoeuvre rather
 * than an error: the detector says "there is an L ahead, it points right", the
 * pilot creeps up to it, pivots, and hands back to the PD when the road is in
 * front of the robot again. The creep is measured in centimetres rather than
 * milliseconds because the thing it is compensating for — the camera sitting
 * ahead of the axle — is a distance. See the corner block in pilotStep().
 */

const PILOT_DEFAULTS = {
  // These are demands, 0-100 — the percentage that reaches each wheel.
  base:   18,    // on a straight — the speed everything else is cut from
  min:    5,     // floor while actually following
  max:    50,    // ceiling, whatever the maths says
  kP:     0.85,  // steer per unit of error (error is -1..+1 across the frame)
  kD:     0.12,  // seconds of look-ahead — damping, in units of time
  // Steer used to be assigned outright — the PD result, or ±1 on entering
  // `recover` — so it could jump from mid-speed straight to 0 %, or from 0 %
  // to 30-40 % the instant recover let go, in a single frame. `steerRate`
  // caps how fast the STEER itself may move, in units of -1..+1 per second —
  // the same idea as `accel`/`brake` for speed, applied to the other half of
  // the mix.
  steerRate: 4,
  curve:  0.75,  // how hard a bend cuts the speed (1 = full stop at full bend)
  short:  0.35,  // how hard a short/uncertain chain cuts it
  accel:  90,    // % per second going up   — gentle
  brake:  400,   // % per second coming down — braking is never the risky way
  hold:   600,   // ms to keep going on the last steer after losing the road
  holdCut: 55,   // % of the current speed while running blind
  give:   1500,  // ms after `hold` before giving up and dropping ENABLE
  hard:   0.6,   // |error| past which it stops driving forward and turns in place
  crawl:  10,    // demand while doing that
  // ── the 90° corner ──
  // Everything above steers by how wrong the robot is. None of it can take a
  // right angle: the road does not move to one side there, it ends, and the
  // one that carries on leaves sideways. So a corner is not steered, it is
  // *executed* — creep up to it, pivot, pick the road up again.
  cornerAt: 0.8,   // how far down the frame the corner must be before committing
  cornerMs: 700,   // how long a sighting stays worth acting on after the road goes
  // How far the robot drives straight on after committing, before it pivots.
  // The camera is bolted to the FRONT: the bottom of the picture is the ground
  // roughly a camera-to-axle offset ahead of the wheels, so when a corner sits
  // at the bottom of the frame the axle is still that far short of it. Pivot
  // there and the robot turns in front of the corner and ends up beside the
  // new road instead of on it.
  //
  // That offset is a distance — the same 15 cm whatever the speed — so it is
  // measured as one, integrated from the demand through the same calibration
  // `/follow` uses for the lap distance. `creepMs` is only the fallback for a
  // robot that has never been calibrated, where a duration is the only unit
  // available; it is the wrong unit, and it is why this used to turn early.
  creepCm:  15,    // cm of driving straight on after committing
  creepMs:  250,   // …or ms, when there is no distance calibration to use
  turnMin:  300,   // ms of pivot before it may be called finished
  turnMs:   2500,  // ms of pivot before giving up and going back to following
  turnOut:  0.3,   // |error| at which the road counts as picked up again
};

// Leaving recovery costs more than entering it, so a robot sitting right on the
// threshold does not flicker between crawling and driving.
const RECOVER_EXIT = 0.15;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A fresh pilot state. Call this on ARM, not once per page. */
function pilotState(now = 0) {
  return { t: now, speed: 0, err: 0, steer: 0, lostAt: 0, lostSpeed: 0,
           armedAt: now, recover: false, corner: null, turn: null, turnedAt: -1e9 };
}

/**
 * One control step.
 *
 * @param st   pilot state, mutated in place (see pilotState)
 * @param obs  {near, far, bands, corner, want} from roadError(); `near === null`
 *             if lost, `corner` null unless a 90° turn is in the picture
 * @param cfg  PILOT_DEFAULTS, or a copy with the sliders applied. `cfg.calib`
 *             is the distance calibration (see metresPerSecond) — only the
 *             corner's creep uses it, and only to measure itself in cm
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
  const near0 = seen ? clamp(obs.near, -1, 1) : null;
  let target, reason, stop = false;

  // ── the 90° corner ──────────────────────────────────────────────────
  // Three things happen here, in order: remember the corner, decide whether
  // to commit to it, and decide whether a turn already under way is over.
  // Driving it is further down, ahead of the ordinary follow/lost branches,
  // because while a turn is running it IS the control law.

  // Remember. The detector reports the L for as long as it can see it, which
  // stops the instant the robot is on top of it — the arm then fills the
  // bottom of the picture and there is nothing left to be lopsided against.
  // So the sighting has to outlive the seeing, and `cornerMs` is how long.
  //
  // Not while a turn is running, and not for `cornerMs` after one ends. Both
  // are the same fact: during the pivot, and for a moment afterwards, the
  // camera is sweeping across the junction the robot is already turning at,
  // and the same L comes back — often pointing the other way, at the road just
  // left. Believing it would mean finishing a right turn and immediately
  // committing to a left one, back the way it came. In that window the robot
  // follows the road normally; it just does not take anything L-shaped as news.
  const deaf = !!st.turn || now - st.turnedAt <= c.cornerMs;
  if (obs && obs.corner && obs.corner.dir && !deaf) {
    st.corner = { dir: obs.corner.dir,
                  dist: obs.corner.dist == null ? 1 : obs.corner.dist,
                  at: now };
  }
  const sighting = st.corner && now - st.corner.at <= c.cornerMs ? st.corner : null;

  // Commit. Either the corner has come far enough down the picture to be
  // under the robot's nose, or the road has just gone and a corner is why —
  // that second case is the important one, because a right angle takes the
  // chain with it a frame or two before it reaches the wheels.
  if (!st.turn && sighting && (sighting.dist >= c.cornerAt || !seen)) {
    st.turn = { dir: sighting.dir, at: now, pivotAt: 0, cm: 0 };
    st.recover = false;               // the corner outranks "far off the road"
  }

  // Finish. The road being visible again is not enough on its own: at the
  // moment of committing, the road INTO the corner is still perfectly visible
  // and dead ahead, and a plain "can I see a road" test would end the turn on
  // the frame it started. So the exit also asks that the picture no longer
  // holds an L pointing the way the robot is turning — pivot until the arm has
  // stopped being an arm and become the road ahead — and refuses to fire
  // inside the first `turnMin`. An L pointing the OTHER way is not a reason to
  // keep going: that is the junction just left, seen from the new heading.
  if (st.turn) {
    // Creep → pivot. Distance where there is a calibration to measure it with,
    // time where there is not: `metresPerSecond` returns null when the three
    // calibration numbers have not been filled in, and 0 when the demand is
    // inside the motor's dead band — a wheel that is not turning. Neither can
    // be integrated into a distance, and a creep that never ends is worse than
    // one that ends early, so both fall back to the clock.
    if (!st.turn.pivotAt) {
      const mps = metresPerSecond(st.speed, c.calib);
      const rolling = mps > 0;
      if (rolling) st.turn.cm += mps * 100 * dt;
      if (rolling ? st.turn.cm >= c.creepCm : now - st.turn.at >= c.creepMs) {
        st.turn.pivotAt = now;
      }
    }
    const pivot = st.turn.pivotAt ? now - st.turn.pivotAt : 0;
    const onCorner = !!(obs && obs.corner && obs.corner.dir === st.turn.dir);
    const back = pivot >= c.turnMin && seen && !onCorner
              && st.turn.dir * near0 <= c.turnOut;
    // Nothing came back. Hand it to the ordinary lost handling rather than
    // pivoting for ever: a robot spinning on the spot is not looking for the
    // road, it is just spinning.
    const over = pivot > c.turnMs;
    if (back || over) { st.turn = null; st.corner = null; st.turnedAt = now; }
  }

  if (st.turn) {
    const dir = st.turn.dir;
    // Phase one, `creep`: drive straight on until the axle has reached where
    // the camera was looking — see `creepCm` above. Phase two is the pivot.
    const pivoting = !!st.turn.pivotAt;
    // A turn is not the road being lost, and the give-up timer must not run
    // while one is in progress — losing the chain is the expected, normal,
    // designed-for middle of a right angle.
    st.lostAt = 0;
    st.recover = false;
    if (seen) st.err = near0;
    target = clamp(c.crawl, 0, c.max);
    const steerStep = c.steerRate * dt;
    st.steer = clamp(pivoting ? dir : 0, st.steer - steerStep, st.steer + steerStep);
    reason = !pivoting ? 'köşe — yaklaşıyor'
           : dir > 0 ? 'köşe — sağa dönüyor' : 'köşe — sola dönüyor';
  } else if (seen) {
    st.lostAt = 0;
    const near = near0;
    const far = clamp(obs.far == null ? near : obs.far, -1, 1);
    const off = Math.max(Math.abs(near), Math.abs(far));

    // Far enough off that driving forward makes it worse. The logs are full of
    // this: errors of 0.9 — the road at the very edge of the frame — reached
    // while still trying to drive through the corner, and then lost. Turning
    // toward it at a crawl is the only thing that helps, and it is the only
    // thing a speed-difference robot can do without reversing a wheel.
    if (off >= c.hard) st.recover = true;
    else if (off < c.hard - RECOVER_EXIT) st.recover = false;

    let wantSteer;
    if (st.recover) {
      wantSteer = near >= 0 ? 1 : -1;     // inner wheel to zero: pivot, slowly
      st.err = near;
      target = clamp(c.crawl, 0, c.max);
      reason = near >= 0 ? 'yol çok sağda — dönüyor' : 'yol çok solda — dönüyor';
    } else {
      // PD, with the D term expressed as a look-ahead time rather than a raw
      // gain: `kP * (e + kD * de/dt)` is "where the error will be kD seconds
      // from now", which is a number you can reason about while tuning.
      const rate = (near - st.err) / dt;
      wantSteer = clamp(c.kP * (near + c.kD * rate), -1, 1);
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

    // Steer is ramped the same way speed is: a full jump — PD result to ±1 on
    // entering recover, or ±1 back down to a partial steer on leaving it — is
    // exactly what snaps a wheel from one speed to another in a single frame.
    const steerStep = c.steerRate * dt;
    st.steer = clamp(wantSteer, st.steer - steerStep, st.steer + steerStep);
  } else {
    // `lostSpeed` is captured ONCE, the instant the road disappears — not
    // recomputed every frame. It used to be `st.speed * holdCut/100` read
    // fresh each frame, which is a target that shrinks as speed chases it:
    // at brake (400 %/s) the wheel reaches ~55 % of the last frame's speed
    // almost immediately, so the next frame's 55 % is of an already-smaller
    // number — three or four frames compound that to zero well inside the
    // 600 ms hold window instead of over it. Then the road reappears and
    // speed ramps back up from zero — the "impulse" the logs show at every
    // lost/regained edge, and, since a detector drops a frame here and there
    // on real footage, the dominant reason the drive never looks smooth.
    if (!st.lostAt) { st.lostAt = now; st.lostSpeed = st.speed; }
    const lost = now - st.lostAt;
    if (lost <= c.hold) {
      // Chosen behaviour: hold the last steer and keep going slowly. A dropped
      // frame or two — a shadow, a join in the tape — is what this carries the
      // robot through. A 90° corner also drops the chain, but that one is not
      // left to the hold any more: it is seen coming and turned deliberately,
      // above.
      target = st.lostSpeed * (c.holdCut / 100);
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

  return {
    p25: Math.round(clamp(left, 0, 100) * 10) / 10,
    p26: Math.round(clamp(right, 0, 100) * 10) / 10,
    speed: Math.round(st.speed * 10) / 10,   // the demand
    steer: Math.round(st.steer * 1000) / 1000,
    reason,
    lost: !seen,
    recover: st.recover,
    // Signed, so a log or a readout can show which way without a second field:
    // `turn` is the corner being driven, `corner` the one merely seen.
    turn: st.turn ? st.turn.dir : 0,
    corner: sighting ? sighting.dir : 0,
    // How far into the creep it is, in cm, or null once pivoting — so the page
    // can show the approach running rather than a robot that has stopped
    // steering for no visible reason.
    creep: st.turn && !st.turn.pivotAt ? Math.round(st.turn.cm * 10) / 10 : null,
    stop,
  };
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
 * @param ff      the open-loop pin %, i.e. `demand` itself — the starting guess
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
                     SPEED_DEFAULTS, speedState, speedStep };
}
