/**
 * The forward HC-SR04, the one bolted to the front of the chassis.
 *
 * Pure, like pilot.js — no DOM, no clock of its own. /obstacle draws it,
 * /follow gates its throttle with it, test/test_sonar.mjs runs it in node.
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

const sround = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

// Outside this the sensor is not measuring, it is guessing. Below the floor an
// HC-SR04 cannot resolve at all; above the ceiling the echo is usually lost
// before it returns.
const MIN_CM = 2;
const MAX_CM = 400;

const OBSTACLE_DEFAULTS = {
  stopCm:   30,   // closer than this and the robot stops
  clearCm:  40,   // and it may not move again until this far — hysteresis
  confirm:  3,    // readings in a row before believing either of those
  waitMs:   1200, // once clear, how long to wait before rolling again
  creep:    12,   // demand while driving on the test page
};

// 30 cm is the stopping distance the robot is built around, and it is not an
// arbitrary round number: at the speeds this thing drives, 30 cm in front of
// the sensor is roughly where the *robot* is by the time three readings have
// agreed and the next 20 Hz packet has gone out. Under about 20 cm the sensor's
// own beam starts seeing the robot's own bumper; much over 40 and it stops for
// doorways.
//
// `clearCm` is deliberately 10 cm further out, and the gap is the whole reason
// a robot parked at exactly the threshold does not buzz between stopped and
// going. Both are editable on /obstacle and both are obeyed by the server, so
// changing them changes the robot rather than one page.

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
      reason: st.phase === 'go' ? 'yankı yok — yol açık sayılıyor'
                                : 'yankı yok — yerinde kalıyor',
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
    reason: st.phase === 'stop' ? `engel ${sround(v)} sm — durdu`
      : st.phase === 'wait' ? `yol açıldı — ${(waitLeft / 1000).toFixed(1)} s bekliyor`
      : `açık · ${sround(v)} sm`,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OBSTACLE_DEFAULTS, MIN_CM, MAX_CM, valid,
                     obstacleState, obstacleStep };
}
