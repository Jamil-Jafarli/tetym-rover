/**
 * Where the robot has been — dead reckoning, and the map it draws.
 *
 * Pure, like pilot.js and sonar.js: no DOM, no clock of its own, so the server
 * integrates it at 20 Hz, /dashboard draws it, and test/test_route.mjs runs it
 * in node with no hardware.
 *
 * ── What this is, and what it is not ────────────────────────────────
 *
 * There is no encoder and no IMU on this robot. Nothing measures how far a
 * wheel turned or which way the robot is pointing. So this is not a
 * measurement of the route: it is the route the robot *would* have taken if
 * both motors did exactly what the model in pilot.js says they do.
 *
 * Everything that model gets wrong, this accumulates:
 *
 *   - a wheel slipping on a corner writes distance the robot did not travel
 *   - the heading is an integral, so a 2 % error in one wheel is not a 2 %
 *     error in position — it is a bend that never straightens out
 *   - and it is open loop, so nothing ever corrects it back
 *
 * That is why the map is drawn with the QR readings and obstacle stops marked
 * on it. Those are the only points on the whole path that correspond to
 * something that really happened at a place, and lining them up with where you
 * know the sign was is how you find out whether the shape is worth believing.
 *
 * A lap that comes back to its start and closes the loop on screen means the
 * calibration is good. One that spirals means it is not, and the number to fix
 * is `track`.
 */

const rclamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rround = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

const ROUTE_DEFAULTS = {
  // Distance between the two driven wheels, in metres. This is the number the
  // whole shape of the map hangs on: it converts a speed *difference* into a
  // rate of turn, so getting it wrong does not shift the map, it bends it.
  // Measure it — centre of one tyre to centre of the other.
  track: 0.30,
  // A new point is kept when the robot has moved this far or turned this much
  // since the last one. At 20 Hz an undecimated path is 72 000 points a minute,
  // and a straight line does not need 1 200 of them.
  stepM: 0.05,
  stepDeg: 8,
  // How much path to keep. Past this the oldest points go: this is a live map
  // of a run, and the run log is what keeps a run forever.
  maxPoints: 1500,
  maxMarks: 60,
};

/** Fresh state. `t` is null until the first step, so the first dt is not a leap. */
function routeState(now = 0) {
  return {
    x: 0, y: 0, h: 0,          // metres east, metres north, heading (rad, 0 = north, clockwise +)
    dist: 0,                   // path length travelled, metres
    v: 0, omega: 0,            // last speeds, for the readout
    t: null,                   // when the last step was
    since: now,                // when this route started
    moving: false,
    path: [{ x: 0, y: 0, at: now }],
    marks: [],                 // QR reads and obstacle stops, at the place they happened
    seq: 0,                    // bumped on every kept point, so a page can tell it fell behind
    lastKeep: { x: 0, y: 0, h: 0 },
  };
}

/**
 * Metres per second for one wheel, from the percentage on its pin.
 *
 * The same straight-line model as `metresPerSecond` in pilot.js, deliberately
 * written out again rather than imported: this file is loaded on pages that do
 * not load the pilot, and a map that silently stops moving because of script
 * order is worse than eight duplicated lines. test/test_route.mjs asserts the
 * two agree across the range, so they cannot drift apart quietly.
 */
function routeSpeed(pct, calib) {
  const c = calib || {};
  const at = Number(c.pct) || 0;
  const m = Number(c.metres) || 0;
  const s = Number(c.seconds) || 0;
  if (at <= 0 || m <= 0 || s <= 0) return null;      // not calibrated: no map
  const dead = rclamp(Number(c.dead) || 0, 0, 99);
  const span = Math.max(1e-6, at - dead);
  const k = (m / s) / span;
  return Math.max(0, rclamp(Number(pct) || 0, 0, 100) - dead) * k;
}

/**
 * One step of dead reckoning.
 *
 * @param st    state from routeState()
 * @param obs   { p25, p26, rev, calib, swap }
 *              p25/p26  the percentages actually on the pins — the ones the
 *                       status calls `out`, not the ones anybody asked for
 *              rev      [rev25, rev26] direction relays; a reversed wheel
 *                       drives backwards, which is how a pivot comes out as a
 *                       turn on the spot rather than as a stop
 *              calib    {pct, metres, seconds, dead} — see /setup
 *              swap     GPIO26 is the left wheel (the same flag as the trim)
 * @param cfg   ROUTE_DEFAULTS overrides
 * @param now   ms
 * @returns {{moved: boolean, v: number, omega: number, calibrated: boolean}}
 */
function routeStep(st, obs, cfg, now) {
  const c = { ...ROUTE_DEFAULTS, ...cfg };
  const o = obs || {};

  // No time yet: this call establishes the clock and moves nothing. Integrating
  // against a dt of "however long since epoch" is the classic first-frame jump.
  if (st.t === null) { st.t = now; return { moved: false, v: 0, omega: 0, calibrated: true }; }
  const dt = (now - st.t) / 1000;
  st.t = now;
  // A step of zero is a repeat; a step of ten seconds is a tab that was asleep,
  // and pretending the robot drove in a straight line through it invents metres.
  if (!(dt > 0) || dt > 1) return { moved: false, v: st.v, omega: st.omega, calibrated: true };

  const s25 = routeSpeed(o.p25, o.calib);
  const s26 = routeSpeed(o.p26, o.calib);
  if (s25 === null || s26 === null) {
    // Uncalibrated. Same rule as the sonar map: no invented number, no map.
    st.v = 0; st.omega = 0; st.moving = false;
    return { moved: false, v: 0, omega: 0, calibrated: false };
  }

  const rev = Array.isArray(o.rev) ? o.rev : [false, false];
  const v25 = rev[0] === true ? -s25 : s25;
  const v26 = rev[1] === true ? -s26 : s26;
  const [vL, vR] = o.swap ? [v26, v25] : [v25, v26];

  const v = (vL + vR) / 2;
  // Left wheel faster turns the robot to its right, and heading is clockwise
  // positive, so this sign is the one that makes a pivot draw the right way.
  const omega = (vL - vR) / Math.max(0.01, Number(c.track) || ROUTE_DEFAULTS.track);

  // Integrate the heading over the half step both before and after the turn —
  // a plain forward Euler on a pivot draws a polygon instead of an arc, and
  // this costs one addition.
  const hMid = st.h + (omega * dt) / 2;
  st.h = wrapRad(st.h + omega * dt);
  st.x += v * Math.sin(hMid) * dt;
  st.y += v * Math.cos(hMid) * dt;
  st.dist += Math.abs(v) * dt;
  st.v = v;
  st.omega = omega;
  st.moving = Math.abs(v) > 1e-4 || Math.abs(omega) > 1e-3;

  const dx = st.x - st.lastKeep.x, dy = st.y - st.lastKeep.y;
  const turned = Math.abs(angleDiff(st.h, st.lastKeep.h)) * 180 / Math.PI;
  if (Math.hypot(dx, dy) >= c.stepM || turned >= c.stepDeg) {
    st.path.push({ x: rround(st.x), y: rround(st.y), at: now });
    st.lastKeep = { x: st.x, y: st.y, h: st.h };
    st.seq++;
    while (st.path.length > c.maxPoints) st.path.shift();
  }

  return { moved: st.moving, v, omega, calibrated: true };
}

/**
 * Pin something to the place it happened.
 *
 * A QR code read, an obstacle stop. These are the only points on the map that
 * are anchored to the real world at all, which is why they are worth drawing
 * on top of a path that is otherwise a model's opinion.
 */
function routeMark(st, kind, text, now, cfg) {
  const c = { ...ROUTE_DEFAULTS, ...cfg };
  const mark = {
    kind, text: text == null ? null : String(text).slice(0, 120),
    x: rround(st.x), y: rround(st.y), h: rround(st.h, 2), at: now,
  };
  st.marks.push(mark);
  while (st.marks.length > c.maxMarks) st.marks.shift();
  return mark;
}

/** Back to the origin, keeping nothing. The map is of one run at a time. */
function routeReset(st, now = 0) {
  const fresh = routeState(now);
  for (const k of Object.keys(fresh)) st[k] = fresh[k];
  return st;
}

/**
 * The box the path and its marks fit in, padded, never smaller than `minM`.
 *
 * A map that autoscales to a robot that has not moved is a map zoomed to a
 * millimetre, so there is a floor: at the start you are looking at a 2 m room
 * with a dot in it, which is the truth.
 */
function routeBounds(st, minM = 2, padFrac = 0.12) {
  const pts = [...(st.path || []), { x: st.x, y: st.y }, ...(st.marks || [])];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = 0; }

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // One span for both axes: a square map keeps a right angle a right angle.
  const span = Math.max(maxX - minX, maxY - minY, minM) * (1 + padFrac * 2);
  return { cx, cy, span, minX, maxX, minY, maxY };
}

/** Heading as a compass-style bearing in degrees, 0 = where the run started. */
function routeBearing(st) {
  return rround(((st.h * 180 / Math.PI) % 360 + 360) % 360, 1);
}

function wrapRad(a) {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

function angleDiff(a, b) { return wrapRad(a - b); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROUTE_DEFAULTS, routeState, routeStep, routeSpeed, routeMark,
                     routeReset, routeBounds, routeBearing };
}
