/**
 * Route checks — dead reckoning, and the things it must refuse to invent.
 *
 * `routeStep` is pure, so a whole drive can be simulated in a loop with a
 * known answer at the end: drive straight for two seconds at a known speed and
 * the robot has to be exactly that far away, in the direction it was pointing.
 * That is the useful property of a model — it can be checked against
 * arithmetic rather than against a floor.
 *
 * The other half of this file is about what it does NOT do: no calibration
 * means no map, a ten-second gap does not become ten seconds of driving, and a
 * path that would be 72 000 points a minute is decimated to something a page
 * can draw.
 *
 *   node test/test_route.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (file, names) => new Function(
  `${readFileSync(join(here, '..', 'public', file), 'utf8')}
   return { ${names.join(', ')} };`)();

const { ROUTE_DEFAULTS, routeState, routeStep, routeSpeed, routeMark,
        routeReset, routeBounds, routeBearing } =
  load('route.js', ['ROUTE_DEFAULTS', 'routeState', 'routeStep', 'routeSpeed',
                    'routeMark', 'routeReset', 'routeBounds', 'routeBearing']);
// The pilot's own version of the same model, to prove the two have not drifted.
const { metresPerSecond } = load('pilot.js', ['metresPerSecond']);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const near = (a, b, eps, m) =>
  ok(Math.abs(a - b) <= eps, `${m}  (${(+a).toFixed(3)} ≈ ${(+b).toFixed(3)})`);

// Drive at 50 % for 4 s over 2 m, so 50 % is 0.5 m/s and, with no dead band,
// the model is a straight line through the origin: pct/100 m/s.
const CALIB = { pct: 50, metres: 2, seconds: 4, dead: 0 };
const CFG = { track: 0.30 };
const HZ = 20, DT = 1000 / HZ;

/**
 * Drive a pair of percentages for `seconds`, from `t0`.
 *
 * Stepped at 20 Hz because that is the rate the server integrates at, which
 * means every angle below is quantised to one 50 ms step — a pivot at 3.3 rad/s
 * turns 9.5° in a single step. The tolerances are that step, not slop.
 */
function drive(st, p25, p26, seconds, rev = [false, false], t0 = 0, cfg = CFG) {
  let t = t0;
  routeStep(st, { p25, p26, rev, calib: CALIB, swap: false }, cfg, t);  // set the clock
  for (let i = 0; i < Math.round(seconds * HZ); i++) {
    t += DT;
    routeStep(st, { p25, p26, rev, calib: CALIB, swap: false }, cfg, t);
  }
  return t;
}

console.log('\nThe speed model is the same one the pilot drives with');
{
  for (const pct of [0, 10, 22, 50, 77, 100]) {
    for (const calib of [CALIB, { pct: 40, metres: 3, seconds: 5, dead: 22 }]) {
      const a = routeSpeed(pct, calib), b = metresPerSecond(pct, calib);
      near(a, b, 1e-9, `${pct} % with dead ${calib.dead ?? 0}: route == pilot`);
    }
  }
  ok(routeSpeed(50, { pct: 0, metres: 2, seconds: 4 }) === null,
     'an uncalibrated constant gives null, not a guess');
}

console.log('\nDriving straight covers the distance the model says it does');
{
  const st = routeState(0);
  drive(st, 50, 50, 2);                     // 0.5 m/s for 2 s
  near(st.y, 1.0, 0.02, 'a metre north after two seconds at half a metre a second');
  near(st.x, 0, 1e-9, 'and nothing sideways');
  near(st.dist, 1.0, 0.02, 'path length agrees');
  near(routeBearing(st), 0, 1e-6, 'heading unchanged');
  ok(st.moving === true, 'it reports that it is moving');
}

console.log('\nA speed difference turns, and the turn is the wheelbase');
{
  // Left 0.5 m/s, right stopped: omega = 0.5/0.3 rad/s. A quarter turn (π/2)
  // therefore takes π/2 / (5/3) s ≈ 0.942 s.
  const st = routeState(0);
  const quarter = (Math.PI / 2) / (0.5 / 0.30);
  drive(st, 50, 0, quarter);
  near(routeBearing(st), 90, 4, 'left wheel only turns it to the right (clockwise)');

  const st2 = routeState(0);
  drive(st2, 0, 50, quarter);
  near(routeBearing(st2), 270, 4, 'right wheel only turns it the other way');

  // A pivot: one wheel forward, one reversed. Twice the rate, same wheelbase.
  const st3 = routeState(0);
  drive(st3, 50, 50, quarter / 2, [false, true]);
  // Twice the rate means twice the angle per step, so twice the quantisation.
  near(routeBearing(st3), 90, 5, 'reversing one wheel pivots at twice the rate');
  near(Math.hypot(st3.x, st3.y), 0, 0.02, '...on the spot, going nowhere');
}

console.log('\nA square comes back to where it started');
{
  // Four straights and four right-angle turns. If the heading integration is
  // wrong, this is the check that catches it — the error does not cancel.
  const st = routeState(0);
  const quarter = (Math.PI / 2) / (0.5 / 0.30);
  let t = 0;
  for (let i = 0; i < 4; i++) {
    t = drive(st, 50, 50, 2, [false, false], t);
    t = drive(st, 50, 0, quarter, [false, false], t);
  }
  near(Math.hypot(st.x, st.y), 0, 0.12, 'a 1 m square closes on its own start');
  near(st.dist, 4 * 1.0 + 4 * (quarter * 0.25), 0.15, 'distance is the whole lap');
}

console.log('\nSwapping the wheels swaps the turn, and nothing else');
{
  const mk = (swap) => {
    const st = routeState(0);
    let t = 0;
    routeStep(st, { p25: 50, p26: 0, calib: CALIB, swap }, CFG, t);
    for (let i = 0; i < 20; i++) { t += DT; routeStep(st, { p25: 50, p26: 0, calib: CALIB, swap }, CFG, t); }
    return st;
  };
  const a = mk(false), b = mk(true);
  near(routeBearing(a) + routeBearing(b), 360, 1,
       'swap mirrors the heading rather than changing the speed');
  near(a.dist, b.dist, 1e-9, 'the distance travelled is identical');
}

console.log('\nWhat it refuses to invent');
{
  const st = routeState(0);
  const out = routeStep(st, { p25: 50, p26: 50, calib: null }, CFG, 100);
  routeStep(st, { p25: 50, p26: 50, calib: null }, CFG, 150);
  ok(out.calibrated === false || st.dist === 0,
     'with no distance calibration nothing accumulates');
  near(st.dist, 0, 1e-9, '...not even a little');

  // The first call only sets the clock. Integrating against "now minus zero"
  // is how a fresh page reports the robot 1.7 billion metres from home.
  const st2 = routeState(0);
  const first = routeStep(st2, { p25: 100, p26: 100, calib: CALIB }, CFG, 1.7e12);
  ok(first.moved === false && st2.dist === 0, 'the first step only starts the clock');

  // A tab that was asleep, or a server that was paused.
  const st3 = routeState(0);
  routeStep(st3, { p25: 100, p26: 100, calib: CALIB }, CFG, 0);
  routeStep(st3, { p25: 100, p26: 100, calib: CALIB }, CFG, 10000);
  near(st3.dist, 0, 1e-9, 'a ten-second gap does not become ten seconds of driving');

  const st4 = routeState(0);
  routeStep(st4, { p25: 100, p26: 100, calib: CALIB }, CFG, 500);
  routeStep(st4, { p25: 100, p26: 100, calib: CALIB }, CFG, 500);
  near(st4.dist, 0, 1e-9, 'a repeated timestamp is not distance either');
}

console.log('\nThe path is decimated, and the marks are not');
{
  const st = routeState(0);
  drive(st, 50, 50, 10);                    // 5 m at 20 Hz = 200 raw steps
  // 200 raw steps of 2.5 cm, kept at 5 cm: about half of them survive. "About"
  // because the accumulated position lands either side of the threshold, which
  // is the right amount of precision for a decimator to have.
  ok(st.path.length < 120 && st.path.length > 60,
     `5 m of straight line is ~half of 200 points (${st.path.length})`);
  const spacing = st.path.slice(1).map((p, i) => Math.hypot(p.x - st.path[i].x,
                                                            p.y - st.path[i].y));
  ok(spacing.every((d) => d >= ROUTE_DEFAULTS.stepM * 0.9),
     'every kept point is at least a step from the one before it');
  ok(st.seq === st.path.length - 1, 'seq counts the points that were kept');

  const st2 = routeState(0);
  drive(st2, 50, 50, 400, [false, false], 0, { ...CFG });
  ok(st2.path.length <= ROUTE_DEFAULTS.maxPoints,
     `a long run is capped rather than growing forever (${st2.path.length})`);
}

console.log('\nMarks are pinned where the robot was');
{
  const st = routeState(0);
  const t = drive(st, 50, 50, 2);
  const m = routeMark(st, 'qr', 'BAKU-01', t, CFG);
  near(m.y, 1.0, 0.02, 'a QR read is marked a metre along, where it was read');
  ok(m.kind === 'qr' && m.text === 'BAKU-01', 'it carries what was read');
  routeMark(st, 'stop', '18 sm', t, CFG);
  ok(st.marks.length === 2, 'an obstacle stop is a mark too');

  const long = 'x'.repeat(400);
  ok(routeMark(st, 'qr', long, t, CFG).text.length === 120,
     'a QR code the size of a novel is truncated before it reaches the status');
}

console.log('\nBounds, and the map that does not zoom to a millimetre');
{
  const st = routeState(0);
  const b = routeBounds(st, 2);
  ok(b.span >= 2, `a robot that has not moved still gets a 2 m view (${b.span})`);
  drive(st, 50, 50, 20);                    // 10 m north
  const b2 = routeBounds(st, 2);
  ok(b2.span > 10, `the view grows with the route (${b2.span.toFixed(1)} m)`);
  near(b2.cy, 5, 0.3, 'and is centred on it');
}

console.log('\nReset starts again from here');
{
  const st = routeState(0);
  drive(st, 50, 50, 4);
  routeMark(st, 'qr', 'a', 1000, CFG);
  routeReset(st, 5000);
  ok(st.dist === 0 && st.x === 0 && st.y === 0 && st.marks.length === 0
     && st.path.length === 1 && st.t === null,
     'everything goes, including the clock — the next step re-establishes it');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
