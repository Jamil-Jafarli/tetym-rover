/**
 * The two HC-SR04s: the one looking forward, and the one going sround.
 *
 * Pure, like pilot.js — no DOM, no clock of its own. /obstacle and /sonar draw
 * it, /follow gates its throttle with it, test/test_sonar.mjs runs it in node.
 *
 * An HC-SR04 is a cheap sensor and it lies in specific, known ways, so most of
 * this file is about not believing it too quickly:
 *
 *   - No echo comes back at all when the target is soft, angled away, or
 *     further than ~4 m. That reads as "nothing there", which is the same
 *     number as "wide open" and the opposite of what a missed wall means.
 *   - Single readings drop out. One frame saying 12 cm in the middle of a
 *     corridor is noise; three in a row is a wall.
 *   - The beam is ~15° wide, so a reading is "something within 15° of here",
 *     not "something at this angle".
 */

const sclamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sround = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

// Outside this the sensor is not measuring, it is guessing. Below the floor an
// HC-SR04 cannot resolve at all; above the ceiling the echo is usually lost
// before it returns.
const MIN_CM = 2;
const MAX_CM = 400;

const OBSTACLE_DEFAULTS = {
  stopCm:   25,   // closer than this and the robot stops
  clearCm:  35,   // and it may not move again until this far — hysteresis
  confirm:  3,    // readings in a row before believing either of those
  waitMs:   1200, // once clear, how long to wait before rolling again
  creep:    12,   // demand while driving on the test page
};

/** A reading is usable, or it is not. Say which rather than substituting zero. */
function valid(cm) {
  const v = Number(cm);
  return Number.isFinite(v) && v >= MIN_CM && v <= MAX_CM ? v : null;
}

/** Fresh state for the obstacle watcher. `phase` is what the UI reads. */
function obstacleState(now = 0) {
  return { phase: 'go', since: now, near: 0, far: 0, last: null, clearedAt: 0 };
}

/**
 * One step of "stop for the thing in front, then carry on".
 *
 * Four phases, and the only unusual one is `wait`:
 *
 *   go      — nothing in the way
 *   stop    — something is, and we are not moving
 *   wait    — it has gone, but we hold still a moment longer
 *   go      — …and resume
 *
 * The wait is what the request asked for and it is also the right behaviour:
 * a person stepping across is clear for an instant while their trailing leg is
 * still in the path, and a robot that launches the moment the beam opens will
 * hit it. Waiting costs a second and removes the whole class of problem.
 *
 * @returns {{blocked, phase, cm, reason, waitLeft}}
 */
function obstacleStep(st, cm, cfg, now) {
  const c = { ...OBSTACLE_DEFAULTS, ...cfg };
  const v = valid(cm);
  st.last = v;

  // No echo is not "clear". It is "no information", and the safe reading of no
  // information is to keep doing whatever we were already doing — which for a
  // stopped robot means staying stopped.
  if (v === null) {
    return {
      blocked: st.phase !== 'go', phase: st.phase, cm: null,
      reason: st.phase === 'go' ? 'əks-səda yoxdur — yol açıq sayılır'
                                : 'əks-səda yoxdur — yerində qalır',
      waitLeft: st.phase === 'wait' ? Math.max(0, c.waitMs - (now - st.clearedAt)) : 0,
    };
  }

  // Count agreement, not instants. `stopCm` and `clearCm` are different numbers
  // so a robot parked at exactly the threshold cannot buzz between the two.
  if (v < c.stopCm) { st.near++; st.far = 0; } else if (v >= c.clearCm) { st.far++; st.near = 0; }
  else { st.near = 0; st.far = 0; }             // between the two: change nothing

  if (st.near >= c.confirm && st.phase !== 'stop') {
    st.phase = 'stop';
    st.since = now;
  } else if (st.far >= c.confirm && st.phase === 'stop') {
    st.phase = 'wait';
    st.clearedAt = now;
  }

  if (st.phase === 'wait') {
    // Anything coming back inside the window restarts the whole stop, not just
    // the timer: the path was not actually clear.
    if (st.near > 0) { st.phase = 'stop'; st.since = now; }
    else if (now - st.clearedAt >= c.waitMs) { st.phase = 'go'; st.since = now; }
  }

  const waitLeft = st.phase === 'wait'
    ? Math.max(0, c.waitMs - (now - st.clearedAt)) : 0;

  return {
    blocked: st.phase !== 'go',
    phase: st.phase,
    cm: sround(v),
    waitLeft: Math.round(waitLeft),
    reason: st.phase === 'stop' ? `maneə ${sround(v)} sm — dayanıb`
      : st.phase === 'wait' ? `yol açıldı — ${(waitLeft / 1000).toFixed(1)} s gözləyir`
      : `açıq · ${sround(v)} sm`,
  };
}

/**
 * Where the spinning sensor was pointing when a reading came back.
 *
 * The servo runs continuously, so nothing measures the angle — it is inferred
 * from time, and the whole map is therefore only as good as one number: how
 * long a full turn takes. Measure it once (mark the sensor, time ten turns,
 * divide) and everything else follows.
 *
 * The reading is stamped by the board with the milliseconds since the spin
 * started, so a browser frame arriving late does not smear the map.
 */
function scanAngle(sinceMs, periodMs, offsetDeg = 0) {
  const p = Number(periodMs);
  if (!(p > 0)) return null;                    // not calibrated: no angle, no map
  const turns = (Number(sinceMs) || 0) / p;
  return ((turns * 360 + offsetDeg) % 360 + 360) % 360;
}

/**
 * Fold a stream of (angle, distance) readings into one map.
 *
 * Bins are `binDeg` wide — 6° by default, which is narrower than the sensor's
 * own ~15° beam, so neighbouring bins are not independent. That is fine for
 * looking at; it is not fine for calling two bins two objects.
 *
 * Each bin keeps the NEAREST reading it saw, not the mean. A mean across a
 * doorway averages the door frame with the room beyond it and invents a wall
 * halfway between; the nearest is at least a thing that was really there.
 */
function scanMap(samples, binDeg = 6) {
  const step = sclamp(Number(binDeg) || 6, 1, 45);
  const n = Math.ceil(360 / step);
  const bins = new Array(n).fill(null);
  let hits = 0;

  for (const s of samples || []) {
    const cm = valid(s && s.cm);
    const a = s && s.ang;
    if (cm === null || !Number.isFinite(a)) continue;
    const i = Math.floor((((a % 360) + 360) % 360) / step) % n;
    hits++;
    if (bins[i] === null || cm < bins[i].cm) {
      bins[i] = { ang: i * step + step / 2, cm: sround(cm), at: s.at ?? null };
    }
  }

  const seen = bins.filter(Boolean);
  const nearest = seen.reduce((a, b) => (a === null || b.cm < a.cm ? b : a), null);
  return {
    bins,
    points: seen,
    hits,
    covered: sround(seen.length / n, 3),   // how much of the circle has any answer
    nearest,
  };
}

/**
 * How long one revolution took, from the readings themselves.
 *
 * Not implemented as a guess: if you do not know the period you do not get a
 * map. This exists only to turn "I timed ten turns and it took 24 seconds" into
 * the number the rest of the code wants.
 */
function spinPeriod(seconds, turns) {
  const s = Number(seconds), t = Number(turns);
  if (!(s > 0) || !(t > 0)) return null;
  return Math.round((s * 1000) / t);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OBSTACLE_DEFAULTS, MIN_CM, MAX_CM, valid,
                     obstacleState, obstacleStep, scanAngle, scanMap, spinPeriod };
}
