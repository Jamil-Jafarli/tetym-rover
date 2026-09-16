/**
 * Mission checks — does the rover end up where it was sent?
 *
 * These are whole runs, not single steps, because no part of mission.js works
 * alone: a rover is put in the start area, sent to a station, and driven
 * millimetre by millimetre with junctions appearing in the camera where the
 * field really has them. The assertion is where it stops.
 *
 * ── The simulator lies on purpose ────────────────────────────────────
 *
 * The rover moves further than it is told to: 100 mm commanded is 125–130 mm
 * on the floor. mission.js believes 1.275 of that. `truth` below is what the
 * floor actually does, and the two are deliberately not the same in most of
 * these runs — because a test where the model is exactly right proves only
 * that the arithmetic is self-consistent, and self-consistent arithmetic is
 * what drives the rover into the wall.
 *
 * The simulator holds its own truth — how far along the route it really is and
 * which way it is really pointing — so the two can disagree and the test can
 * see that they did. It also models the one fact that makes the 180° hard: a
 * line looks the same from both ends, so the line is visible at 0° AND at
 * 180°, and no test made of looking can tell a half turn from no turn at all.
 *
 *   node test/test_mission.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PUB = join(here, '..', 'public');
// Both in one scope, the way a page loads them: mission.js calls into field.js
// by plain global name, and a test that stubbed that out would not be testing
// the thing the browser runs.
const src = readFileSync(join(PUB, 'field.js'), 'utf8')
          + '\n' + readFileSync(join(PUB, 'mission.js'), 'utf8');
const {
  FIELD, FIELD_TRACK_M, MISSION_DEFAULTS, fieldNode, fieldPlan, fieldLegs,
  fieldState, fieldStep, missionState, missionSet, missionStep, missionResume,
  missionCargo, missionOut, missionReach, missionTurnRoom, missionBackOff,
} = new Function(`${src}
  return { FIELD, FIELD_TRACK_M, MISSION_DEFAULTS, fieldNode, fieldPlan, fieldLegs,
           fieldState, fieldStep, missionState, missionSet, missionStep, missionResume,
           missionCargo, missionOut, missionReach, missionTurnRoom, missionBackOff };`)();
// The server folds a QR's text before the page ever sees it; the simulated
// reader below does the same, with the same function.
import { qrKey } from '../qr.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (${JSON.stringify(a)})`);
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
/** −180..+180. */
const wrap = (d) => { let x = d % 360; if (x > 180) x -= 360; if (x < -180) x += 360; return x; };

// ── the simulated floor ──────────────────────────────────────────────

// Commanded millimetres per 1 % of wheel demand, per frame. Only its ratio to
// the field's distances matters; this makes a 12 % blind step about 1.8 mm a
// frame, fine enough that nothing overshoots by rounding.
const MM_PER_PCT = 0.15;
// What the pilot drives at while following, in commanded mm per wheel. The
// pilot is not what is under test here, so following is modelled as "goes
// forward at a steady rate", which is what it does on a straight.
const FOLLOW_MM = 25;
// How far off a junction the camera picks it up, and how far off the line's
// own direction the rover may point and still see it at all.
const SEE_M = 0.7;
const SEE_DEG = 30;

/**
 * Which sides a junction has arms on, from the rover's point of view.
 *
 * Worked out from the field rather than written down, so the simulated camera
 * agrees with the map by construction and cannot be quietly tuned to make a
 * test pass: every edge at the node that is not the one arrived on is an arm,
 * and which side it is on is its bearing against the rover's.
 */
function armsAt(id, legs) {
  const leg = legs.find((l) => l.to === id);
  const node = fieldNode(id);
  const sides = { left: false, right: false };
  for (const e of FIELD.edges) {
    if (e.a !== id && e.b !== id) continue;
    const other = e.a === id ? e.b : e.a;
    if (other === leg.from) continue;             // where we came from
    const n = fieldNode(other);
    const b = ((Math.atan2(n.x - node.x, n.y - node.y) * 180 / Math.PI) + 360) % 360;
    const d = wrap(b - leg.bearing);
    if (d > 45) sides.right = true;
    else if (d < -45) sides.left = true;
  }
  return sides;
}

/** The junctions on a route, in ground metres from where it starts. */
function marksOf(from, target, heading) {
  const legs = fieldLegs(fieldPlan(from, target), heading);
  const marks = [];
  let total = 0;
  for (const l of legs) { total += l.len; marks.push({ id: l.to, at: total }); }
  return { legs, marks, total };
}

/**
 * Drive a whole run.
 *
 * @param o.truth ground metres per commanded metre that the FLOOR does —
 *                mission.js believes MISSION_DEFAULTS.scale whatever this is
 * @param o.lie   a function given each junction sighting, free to drop, move
 *                or mirror it
 * @param o.blind the line is never visible at all
 */
function drive(target, o = {}) {
  const from = o.from || 'START';
  const heading = o.heading || 0;
  const truth = o.truth == null ? MISSION_DEFAULTS.scale : o.truth;
  const st = missionSet(missionState(), target, from, heading, o.cfg);
  const { legs, marks, total } = marksOf(from, target, heading);

  // The truth: how far along the route, and how far off its direction.
  let along = 0, herr = 0;
  let turning = 0, spin = 1, crept = 0, res = null;
  const trace = [];

  for (let i = 0; i < 40000; i++) {
    // Can the camera see the line? A line looks the same from both ends, so
    // pointing back down it counts — which is exactly why a 180° cannot be
    // ended by looking at one.
    const off = Math.min(Math.abs(wrap(herr)), Math.abs(wrap(herr - 180)));
    const sees = !o.blind && off < SEE_DEG;

    // A junction, if one is close ahead and the rover is facing up the route.
    let j = null;
    if (sees && Math.abs(wrap(herr)) < SEE_DEG) {
      for (const m of marks) {
        const node = fieldNode(m.id);
        if (!node || node.kind !== 'junction') continue;
        const away = m.at - along;
        if (away < -0.15 || away > SEE_M) continue;
        j = { dist: Math.max(0, Math.min(1, 1 - away / SEE_M)), ...armsAt(m.id, legs) };
        break;
      }
    }
    if (o.lie) j = o.lie(j, along);

    // What the wheels are asked for this frame, in COMMANDED millimetres.
    let mmL = 0, mmR = 0;
    if (res && res.drive) {
      mmL = res.drive.p25 * MM_PER_PCT;
      mmR = res.drive.p26 * MM_PER_PCT;
    } else if (res && res.phase === 'turn') {
      // The pilot's junction manoeuvre: creep, THEN pivot. The creep is not a
      // detail — it is what brings the axle up to where the camera was looking
      // when it called the junction, and it is why the anchor after a turn has
      // no lead taken off it. A simulator that pivoted on the spot would leave
      // the rover `leadM` short of every junction it turned at, and the error
      // would come out at the far end as an approach that stops short.
      if (crept < MISSION_DEFAULTS.leadM) {
        mmL = FOLLOW_MM / 2; mmR = FOLLOW_MM / 2;
        crept += (mmL * truth) / 1000;
      } else {
        mmL = 20 * spin; mmR = -20 * spin;
      }
    } else if (res && res.phase === 'run') {
      mmL = FOLLOW_MM; mmR = FOLLOW_MM;
      // Following a line means staying on it, so a heading error left over
      // from a blind step is worked off rather than carried.
      herr = wrap(herr) * 0.9;
    }

    // What the floor does with that.
    const gL = mmL * truth / 1000, gR = mmR * truth / 1000;
    const ds = (gL + gR) / 2;
    // `herr` is measured against the leg being driven, not against the room,
    // so a junction pivot does not change it: the rover turns 90° and the
    // route turns 90° with it. Only a turn the route does NOT make — a blind
    // spin, a wheel slipping — is an error.
    if (!(res && res.phase === 'turn')) {
      herr += (gL - gR) / FIELD_TRACK_M * 180 / Math.PI;
    }
    // Pointing at an angle to the line, only the component along it counts.
    along += ds * Math.cos(herr * Math.PI / 180);

    // Where the line sits in the frame. Rotated to the right, the rover sees
    // the line swing to the LEFT, so the sign is the other way round from the
    // heading error — and getting that backwards is a rover that turns away
    // from the line it is trying to centre.
    const signed = Math.abs(wrap(herr)) < Math.abs(wrap(herr - 180))
      ? wrap(herr) : wrap(herr - 180);
    const nearErr = sees ? Math.max(-1, Math.min(1, -signed / SEE_DEG)) : null;

    res = missionStep(st, {
      junction: j, end: null, bands: sees ? 4 : 0, near: nearErr,
      dLeftMm: mmL, dRightMm: mmR, turning: turning > 0,
    }, o.cfg);
    trace.push({ along: +along.toFixed(3), phase: res.phase, move: res.move, why: res.why });

    if (turning > 0) turning--;
    if (res.corner) { turning = 70; spin = res.corner.dir; crept = 0; }
    if (res.phase === 'done' || res.phase === 'lost') break;
    if (res.phase === 'gate' && !o.holdGate) missionResume(st);
  }
  return { res, along, herr, total, trace, st };
}

/** Where the fork ends up, in ground metres along the route. */
const forkAt = (r) => r.along + MISSION_DEFAULTS.forkM;

console.log('\nÜç alım nöqtəsi — fərq yalnız dönüşdədir');
for (const target of ['A1', 'A2', 'A3']) {
  const r = drive(target);
  ok(r.res.phase === 'done' && r.res.target === target,
     `${target} → ${r.res.phase} (${r.res.why})`);
  // The follow stops short by fork + back-in, the spin turns the rover round,
  // the reverse puts the fork on the load. What has to land on the zone is the
  // FORK, not the rover.
  ok(near(forkAt(r), r.total, 0.12),
     `${target}: çəngəl ${forkAt(r).toFixed(2)} m — bölgə ${r.total.toFixed(2)} m`);
  ok(Math.abs(wrap(r.herr - 180)) < 25,
     `${target}: 180° dönüb qovşağa baxır (${wrap(r.herr).toFixed(0)}°)`);
}

console.log('\nHərəkət sırası — hər kor addımdan sonra xətt axtarılır');
{
  const r = drive('A2');
  const kinds = r.st.q.map((m) => m.kind);
  ok(kinds.join(' ') === 'go seek follow spin seek back',
     `A2 üçün sıra: ${kinds.join(' ')}`);
  // Every blind step is followed by a seek. That is the rule the field
  // imposes, and it is worth asserting rather than trusting.
  for (let i = 0; i < kinds.length - 1; i++) {
    if (kinds[i] === 'go' || kinds[i] === 'spin') {
      ok(kinds[i + 1] === 'seek', `${kinds[i]} → ${kinds[i + 1]}`);
    }
  }
  const seen = new Set(r.trace.map((t) => t.phase));
  ok(seen.has('blind') && seen.has('seek') && seen.has('run'),
     `hamısı işlədi: ${[...seen].join(' ')}`);
}

console.log('\n125 və 130 mm arasında — hər ikisi çatır');
for (const truth of [1.25, 1.275, 1.30]) {
  const r = drive('A2', { truth });
  ok(r.res.phase === 'done',
     `100 mm → ${(truth * 100).toFixed(0)} mm  →  ${r.res.phase} (${r.res.why})`);
  ok(near(forkAt(r), r.total, 0.2),
     `  çəngəl ${((forkAt(r) - r.total) * 100).toFixed(0)} sm sapma ilə bölgədə`);
}

console.log('\nMiqyas düzəlişi bəzək deyil');
{
  // The same floor, with mission.js told a millimetre is a millimetre. Every
  // blind step then overshoots by 27 %, the half turn becomes 229°, and the
  // run cannot end where it should. This is what says the scale is
  // load-bearing rather than decorative.
  const bad = drive('A2', { truth: 1.275, cfg: { scale: 1 } });
  ok(bad.res.phase !== 'done' || !near(forkAt(bad), bad.total, 0.3),
     `düzəlişsiz: ${bad.res.phase}, çəngəl `
   + `${((forkAt(bad) - bad.total) * 100).toFixed(0)} sm sapdı`);
  const good = drive('A2', { truth: 1.275 });
  ok(good.res.phase === 'done', 'düzəlişlə: çatdı');
}

console.log('\n180° görməklə bitə bilməz — arifmetika ilə bitir');
{
  // The rover ends the half turn pointing back down the line it came up, and
  // the line is exactly as visible there as it was before it started. Nothing
  // in the picture separates them, which is the whole reason `spin` counts
  // degrees instead of watching.
  const r = drive('A2');
  const spun = r.trace.filter((t) => t.move === 'spin');
  ok(spun.length > 50, `dönüş sayıldı (${spun.length} kadr)`);
  ok(Math.abs(wrap(r.herr - 180)) < 25, 'və 180°-də dayandı, 0°-də yox');
}

console.log('\nDönüş şaşsa da xətti tapır — amma məsafəni tapmır');
{
  // A floor 14 % faster than believed, well outside the 125–130 mm this was
  // measured over. The half turn comes out about 25° long and the sweep finds
  // the line again, so the run completes rather than stalling.
  //
  // The fork still misses. That is the honest limit of the whole design and it
  // is worth an assertion rather than a comment: **a sweep recovers the
  // HEADING, and nothing here recovers the DISTANCE.** Distance only ever
  // comes back from a landmark, and on the last leg of a run there is not one
  // — which is exactly the hole the station's QR code is shaped to fill.
  const r = drive('A2', { truth: 1.45 });
  ok(r.res.phase === 'done', `çox sürüşən döşəmədə də bitdi (${r.res.why})`);
  ok(r.trace.some((t) => t.move === 'seek' && t.phase === 'seek'), 'xətt axtarıldı');
  ok(Math.abs(wrap(r.herr - 180)) < 12, `istiqamət ortalandı (${wrap(r.herr).toFixed(0)}°)`);
  ok(!near(forkAt(r), r.total, 0.3),
     `məsafə düzəlmədi — çəngəl ${((forkAt(r) - r.total) * 100).toFixed(0)} sm sapdı`);
}

console.log('\nXətt ümumiyyətlə yoxdursa dayanır');
{
  // Nothing to find. The sweep has to give up rather than turn for ever: a
  // rover spinning on the spot is not looking for the line, it is just
  // spinning.
  const r = drive('A2', { blind: true });
  ok(r.res.phase === 'lost', `dayandı: ${r.res.why}`);
  ok(/tapılmadı/.test(r.res.why), 'və nə tapmadığını deyir');
}

console.log('\nQovşağı görməsə dayanır — səhv stansiyaya getmir');
{
  // The camera misses J2 entirely. The wrong answer is to carry on: J3 would
  // then be taken for J2, the rover would turn there, and it would arrive at
  // A3 and report that it had reached A2.
  const r = drive('A2', { lie: (j, at) => (at > 3.2 && at < 6 ? null : j) });
  ok(r.res.phase === 'lost', `dayandı: ${r.res.why}`);
  ok(r.res.target === 'A2' && r.res.next === 'J2', 'nəyi itirdiyini deyir');
}

console.log('\nOlmayan qovşaq sayılmır');
{
  // A strip of light across the line just after the start area — nowhere near
  // where the map says J1 is.
  const fake = { dist: 1, left: true, right: true };
  const r = drive('A2', { lie: (j, at) => (at > 0.9 && at < 1.3 ? fake : j) });
  ok(r.res.phase === 'done' && r.res.target === 'A2',
     `saxta qovşaqdan sonra da A2 (${r.res.why})`);
}

console.log('\nQolu səhv tərəfdə olan qovşaq sayılmır');
{
  // The right junction at the right distance, but the branch is reported on
  // the side the map does not have one. That is not J2 seen badly, it is
  // something else — and taking it would be a turn into a wall.
  const r = drive('A2', {
    lie: (j) => (j && j.left && !j.right ? { ...j, left: false, right: true } : j),
  });
  ok(r.res.phase === 'lost', `qol tutmadı → ${r.res.phase} (${r.res.why})`);
}

console.log('\nQapıya yaddaşdan gedir — yükü götürdükdən sonra');
{
  // The second half of the run the şartname asks for: the rover has the load,
  // it is standing at A2 pointing back down the branch, and it has to reach
  // the door. Nothing new is needed — turning round at the station left it
  // facing the way out.
  const r = drive('KAPI', { from: 'A2', heading: 180, holdGate: true });
  ok(r.res.phase === 'gate', `qapıda dayandı (${r.res.why})`);
  ok(r.res.seen === 2, `iki qovşaqdan keçdi (${r.res.seen})`);
  const kinds = r.st.q.map((m) => m.kind);
  ok(kinds.join(' ') === 'follow wait', `qapı üçün sıra: ${kinds.join(' ')}`);

  // Held there, nothing may move it — not even a junction in shot. A
  // stationary rover still has a picture.
  const before = r.res.next;
  let out = null;
  for (let i = 0; i < 20; i++) {
    out = missionStep(r.st, { junction: { dist: 1, left: true, right: true },
                              bands: 4, dLeftMm: 100, dRightMm: 100, turning: false });
  }
  ok(out.phase === 'gate' && out.next === before, 'saxta qovşaq onu tərpətmir');
  missionResume(r.st);
  out = missionStep(r.st, { bands: 4, dLeftMm: 0, dRightMm: 0 });
  ok(out.phase === 'done', `deyiləndən sonra keçir (${out.why})`);
}

console.log('\nDüşürmə nöqtələri');
for (const target of ['B1', 'B2', 'B3']) {
  const r = drive(target, { from: 'A2', heading: 180 });
  ok(r.res.phase === 'done' && r.res.target === target, `${target} → ${r.res.phase}`);
  ok(near(forkAt(r), r.total, 0.25),
     `${target}: çəngəl ${((forkAt(r) - r.total) * 100).toFixed(0)} sm sapma ilə bölgədə`);
}

console.log('\nHesablama qovşaqlarda düzəlir');
{
  // Anchored against open loop, over the same wheels. Anchoring cannot fix the
  // last leg — nothing is seen between J2 and A2 — so the comparison, not the
  // number, is the assertion. What would fix the last leg too is the QR code
  // at the far end of it.
  const st = missionSet(missionState(), 'A2', 'START', 0);
  const open = fieldState('START', 0);
  const { legs, marks } = marksOf('START', 'A2', 0);
  let res = null, turning = 0, spin = 1, crept = 0;
  for (let i = 0; i < 40000; i++) {
    let mmL = 0, mmR = 0;
    if (res && res.drive) { mmL = res.drive.p25 * MM_PER_PCT; mmR = res.drive.p26 * MM_PER_PCT; }
    else if (res && res.phase === 'turn') {
      if (crept < MISSION_DEFAULTS.leadM) {
        mmL = FOLLOW_MM / 2; mmR = FOLLOW_MM / 2;
        crept += (mmL * MISSION_DEFAULTS.scale) / 1000;
      } else { mmL = 20 * spin; mmR = -20 * spin; }
    }
    else if (res && res.phase === 'run') { mmL = FOLLOW_MM * 1.06; mmR = FOLLOW_MM; }
    fieldStep(open, mmL * MISSION_DEFAULTS.scale, mmR * MISSION_DEFAULTS.scale);
    // The camera is honest here; the wheels are not.
    let j = null;
    for (const m of marks) {
      const node = fieldNode(m.id);
      if (!node || node.kind !== 'junction') continue;
      const away = m.at - open.dist;
      if (away < -0.15 || away > SEE_M) continue;
      j = { dist: Math.max(0, Math.min(1, 1 - away / SEE_M)), ...armsAt(m.id, legs) };
      break;
    }
    res = missionStep(st, { junction: j, bands: 4, dLeftMm: mmL, dRightMm: mmR,
                            turning: turning > 0 });
    if (turning > 0) turning--;
    if (res.corner) { turning = 70; spin = res.corner.dir; crept = 0; }
    if (res.phase === 'done' || res.phase === 'lost') break;
  }
  const a2 = fieldNode('A2');
  const err = Math.hypot(res.pose.x - a2.x, res.pose.y - a2.y);
  const raw = Math.hypot(open.x - a2.x, open.y - a2.y);
  ok(res.seen === 2, `iki qovşaq təsdiqləndi (${res.seen})`);
  // Roughly half, and all of what is left is the last leg — the one stretch
  // with no junction on it to anchor against.
  ok(err < raw * 0.6,
     `lövbərli ${(err * 100).toFixed(0)} sm, lövbərsiz ${(raw * 100).toFixed(0)} sm`);
}

console.log('\nBilinməyən hədəf işi başlatmır');
{
  const st = missionSet(missionState(), 'A9');
  ok(st.phase === 'idle' && !st.target, `${st.why}`);
  const res = missionStep(st, { dLeftMm: 100, dRightMm: 100 });
  ok(res.phase === 'idle', 'addım da heç nə etmir');
}

// ── the cargo run ────────────────────────────────────────────────────

/**
 * A cargo run, on one simulated stub of line.
 *
 * `x` is how far along the stub the rover's axle is — 0 at the line's start,
 * `stub` at the load — and `h` its heading, 0 pointing at the load. The taught
 * legs are the server's business and are faked as it answers them: a replay
 * status under the page's id that runs for a few frames and then says done
 * (or aborted, or failed). The QR reader is a status with a text in it.
 *
 * The rover "finds" the line at `x0`, which is wherever the taught leg put it
 * — not necessarily the paint's first centimetre — and that is the point it
 * has to come back to.
 */
const CARGO_DT = 0.05;
function cargoRun(o = {}) {
  const c = { ...MISSION_DEFAULTS, ...(o.cfg || {}) };
  const stub = o.stub ?? 2.7;
  const seeEnd = 0.25;                     // the paint's end in shot, this far ahead
  const st = missionCargo(missionState(), o.slot ?? 2,
    { qrKey: qrKey(o.want ?? 'ALIM2'), have: { to: o.to !== false, out: o.out !== false },
      runId: 7 }, o.cfg);
  let x = o.x0 ?? 0.4, h = o.h0 ?? 0;
  let res = missionOut(st);
  let srv = null;
  const legs = [], ids = [], moves = [];
  let upS = 0, qrS = 0, endOut = null, homeFrom = null, lastMove = null, qrFrom = null, liftAt = null;

  for (let i = 0; i < 20000; i++) {
    // ── the server ──
    if (res.replay && (!srv || srv.id !== res.replay.id)) {
      legs.push(res.replay.leg);
      ids.push(res.replay.id);
      srv = { id: res.replay.id, active: !o.replayErr, done: false, aborted: false,
              err: o.replayErr || null, seg: 1, of: 3, left: 10 };
    } else if (srv && srv.active) {
      if (o.abortReplay) { srv.active = false; srv.aborted = true; }
      else if (--srv.left <= 0) { srv.active = false; srv.done = true; }
    }
    if (res.act === 'up') upS += CARGO_DT;
    if (res.move === 'qr') qrS += CARGO_DT;

    // ── the wheels ──
    let mmL = 0, mmR = 0;
    if (res.drive) {
      mmL = res.drive.p25 * MM_PER_PCT;
      mmR = res.drive.p26 * MM_PER_PCT;
    } else if (res.phase === 'run' || (res.creep && o.armed !== false)) {
      // The pilot on the line — at the QR step's crawl while that creeps.
      mmL = mmR = res.creep ? FOLLOW_MM * res.creep / 18 : FOLLOW_MM;
      // On the line the pilot works off whatever heading error is left.
      const to = Math.abs(wrap(h)) < 90 ? 0 : 180;
      h = to + wrap(h - to) * 0.9;
    }
    const gL = mmL * c.scale / 1000, gR = mmR * c.scale / 1000;
    h += (gL - gR) / FIELD_TRACK_M * 180 / Math.PI;
    x += ((gL + gR) / 2) * Math.cos(h * Math.PI / 180);

    // ── the camera ──
    const off = Math.min(Math.abs(wrap(h)), Math.abs(wrap(h - 180)));
    const sees = off < SEE_DEG;
    const signed = Math.abs(wrap(h)) < Math.abs(wrap(h - 180)) ? wrap(h) : wrap(h - 180);
    const facingLoad = Math.cos(h * Math.PI / 180) > 0;
    const end = sees && (facingLoad ? x >= stub - seeEnd : x <= seeEnd);
    // A code in shot all run long, none, or — a function of the step and of
    // where the rover is — one that comes and goes as it drives.
    const text = typeof o.qr === 'function' ? o.qr(res.move, x)
               : o.qr === undefined ? 'ALIM2' : o.qr;

    res = missionStep(st, {
      junction: null, bands: sees ? 4 : 0,
      near: sees ? Math.max(-1, Math.min(1, -signed / SEE_DEG)) : null,
      end: end ? { dist: 0.9 } : null,
      dLeftMm: mmL, dRightMm: mmR,
      dt: o.armed === false ? 0 : CARGO_DT,
      qr: text ? { available: true, text, key: qrKey(text), seen_age_s: 0.3 }
               : { available: o.reader !== false, text: null, key: null, seen_age_s: null,
                   err: o.reader === false ? 'jsqr yoxdur' : null },
      replay: srv,
    }, o.cfg);

    if (res.move !== lastMove) {
      if (res.move) moves.push(res.move);
      // Where the outward trace ended: the paint's end, before the back-off.
      if (lastMove === 'trace' && endOut === null) endOut = x;
      if (res.move === 'lift') liftAt = x;
      if (res.move === 'qr') qrFrom = x;
      if (res.move === 'trace' && moves.filter((m) => m === 'trace').length === 2) homeFrom = x;
      lastMove = res.move;
    }
    if (res.phase === 'done' || res.phase === 'lost') break;
    if (o.frames && i >= o.frames) break;
  }
  return { res, st, x, h, legs, ids, moves, upS, qrS, endOut, homeFrom, qrFrom, liftAt };
}

console.log('\nYük daşıma — yaddaşdan yol, QR, xətt, 180°, aktuator, geri, qapı');
{
  const r = cargoRun();
  ok(r.res.phase === 'done', `bitdi — ${r.res.why}`);
  eq(r.moves, ['path', 'seek', 'qr', 'trace', 'back', 'spin', 'seek', 'back', 'lift', 'trace', 'path'],
     'hərəkət sırası');
  eq(r.legs, ['to', 'out'], 'serverdən iki öyrədilmiş yol istədi, bu sırada');
  ok(r.ids[0] !== r.ids[1], `hər biri öz adı ilə (${r.ids.join(', ')})`);
  ok(near(r.endOut, 2.7 - 0.25, 0.1), `yük tərəfdə boya bitəndə dayandı (${r.endOut.toFixed(2)} m)`);
  // The back-off before the 180° and the longer back-in after it cancel: the
  // fork ends up where it did before the rover's length was accounted for.
  ok(near(r.liftAt - r.endOut, MISSION_DEFAULTS.dockBackM, 0.05),
     `yükdən ${missionBackOff().toFixed(2)} m aralanıb döndü, çəngəl yenə boyanın sonundan `
   + `${(r.liftAt - r.endOut).toFixed(2)} m irəlidə (dockBackM ${MISSION_DEFAULTS.dockBackM})`);
  ok(Math.abs(r.upS - MISSION_DEFAULTS.liftS) <= CARGO_DT * 1.5,
     `aktuator ${r.upS.toFixed(2)} s yuxarı işlədi (liftS ${MISSION_DEFAULTS.liftS})`);
  ok(near(r.x, 0.4, 0.06), `xəttin əvvəlki nöqtəsinə qayıtdı (${r.x.toFixed(2)} m, tapdığı yer 0.40)`);
  ok(Math.abs(wrap(r.h - 180)) < 10, `yükü arxasında, yuvanın əksinə baxır (${wrap(r.h).toFixed(0)}°)`);
}

console.log('\nXətti lap başında tapıbsa — boyanın bitdiyi yerdə dayanır');
{
  const r = cargoRun({ x0: 0.05 });
  ok(r.res.phase === 'done', `bitdi — ${r.res.why}`);
  ok(r.x >= 0.1 && r.x <= 0.3, `boya bitdi, məsafədən əvvəl (${r.x.toFixed(2)} m)`);
}

console.log('\nQR — doğru kod davam edir, səhv kod dayandırır');
{
  const fold = cargoRun({ qr: 'Alım-2' });
  ok(fold.res.phase === 'done', `«Alım-2» ALIM2-dir — ${fold.res.why}`);

  const wrong = cargoRun({ qr: 'ALIM3' });
  ok(wrong.res.phase === 'lost' && /səhv QR: ALIM3/.test(wrong.res.why), wrong.res.why);
  ok(!wrong.moves.includes('trace') && wrong.upS === 0,
     'başqa yuvanın xəttinə girmir, aktuatora toxunmur');

  const none = cargoRun({ qr: null });
  ok(none.res.phase === 'lost' && /QR oxunmadı/.test(none.res.why), none.res.why);
  ok(near(none.x - none.qrFrom, MISSION_DEFAULTS.qrCreepM, 0.05)
     && none.qrS < MISSION_DEFAULTS.qrWaitS,
     `durub gözləmir — xətlə ${(none.x - none.qrFrom).toFixed(2)} m yavaş irəlilədi, `
   + `${none.qrS.toFixed(1)} s (qrCreepM ${MISSION_DEFAULTS.qrCreepM})`);

  const dead = cargoRun({ qr: null, reader: false });
  ok(/oxuyucu işləmir/.test(dead.res.why), `oxuyucu yoxdursa bunu deyir — ${dead.res.why}`);

  // Disarmed, the clock does not run: a page left open and idle in front of a
  // blank wall must not time out a run that nothing is running.
  const idle = cargoRun({ qr: null, armed: false, frames: 400 });
  ok(idle.res.phase === 'qr', `silahsız 20 s — hələ də QR gözləyir (${idle.res.phase})`);
}

console.log('\nQR hərəkətdə oxunur — oxunan kimi xətt izlənir');
{
  // Seen only along the taught leg: by the time the rover is on its line the
  // code has been read, and it does not stand there waiting for it again.
  const onWay = cargoRun({ qr: (move) => (move === 'path' ? 'ALIM2' : null) });
  ok(onWay.res.phase === 'done', `yolda oxundu — ${onWay.res.why}`);
  ok(onWay.qrS <= CARGO_DT * 2,
     `QR addımı dərhal keçdi, xətt izləmə başladı (${onWay.qrS.toFixed(2)} s)`);
  ok(onWay.st.qrOk && onWay.st.qrOk.move === 'path', 'harada oxunduğu yadda qalır: path');

  // In shot only once the rover has crept 0.2 m along the line.
  const late = cargoRun({ qr: (move, x) => (move === 'qr' && x >= 0.6 ? 'ALIM2' : null) });
  ok(late.res.phase === 'done', `sürünərkən oxundu — ${late.res.why}`);
  ok(late.qrS > 0.3, `yavaş irəlilədi (${late.qrS.toFixed(2)} s)`);
  ok(near(late.x, 0.4, 0.08),
     `geri yolda sürünmə də sayılır — xətti tapdığı yerə qayıtdı (${late.x.toFixed(2)} m)`);

  // Another slot's code glimpsed on the way is not a stop: the taught leg may
  // well pass other slots. At the line, the right one is what counts.
  const past = cargoRun({ qr: (move) => (move === 'path' ? 'ALIM3' : 'ALIM2') });
  ok(past.res.phase === 'done', `yolda ALIM3 görmək dayandırmır — ${past.res.why}`);

  // A code seen before the run began was somewhere else.
  const st = missionCargo(missionState(), 2, { qrKey: 'ALIM2', have: { to: true } });
  missionStep(st, { dt: 0.05, qr: { key: 'ALIM2', text: 'ALIM2', seen_age_s: 1.2 } });
  ok(!st.qrOk, 'qaçışdan əvvəl görünən kod sayılmır');
}

console.log('\nYaddaşdan yol — yarımçıq qalsa və ya heç başlamasa');
{
  const aborted = cargoRun({ abortReplay: true });
  ok(aborted.res.phase === 'lost' && /yarımçıq/.test(aborted.res.why),
     `DAYAN yolun ortasında → ${aborted.res.why}`);
  ok(aborted.legs.length === 1, 'yenidən başdan başlamır');

  const failed = cargoRun({ replayErr: 'kart bağlı deyil' });
  ok(failed.res.phase === 'lost' && /kart bağlı deyil/.test(failed.res.why), failed.res.why);

  const noOut = cargoRun({ out: false });
  ok(noOut.res.phase === 'done' && noOut.moves[noOut.moves.length - 1] === 'trace',
     'qapı yolu öyrədilməyibsə xəttin başında bitir');
  eq(noOut.legs, ['to'], 'və yalnız bir yol istəyir');

  const noTo = cargoRun({ to: false });
  ok(noTo.res.phase === 'idle' && /öyrədilməyib/.test(noTo.st.why),
     `birinci yol yoxdursa heç başlamır — ${noTo.st.why}`);

  const bad = missionCargo(missionState(), 4, { have: { to: true } });
  ok(bad.phase === 'idle', `yuva 4 — ${bad.why}`);
}

console.log('\nXəttin sonu heç gəlmirsə dayanır');
{
  const r = cargoRun({ stub: 20 });
  ok(r.res.phase === 'lost' && /sonu tapılmadı/.test(r.res.why), r.res.why);
  ok(r.upS === 0, 'aktuator işə düşmədi');
}

// ── the yard: three lines, three loads, a 1.20 m rover ───────────────

/**
 * The pickup end of the field, in 2-D, with the loads on it.
 *
 * x east and y north, in metres; y = 0 is the row the three lines start on,
 * each with its QR code there (Şekil 1, Şekil 6). The lines are A1..A3's, at
 * field.js's x, 2.7 m of paint each, and the pallet — 700 across, 600 deep
 * (Şekil 4) — stands 1.5 m up each one, hiding the paint under it. Heading is
 * a compass bearing, 0 up the lines towards the loads.
 *
 * The rover is a rectangle: `front` from the axle to the camera end, the rest
 * of its 1.20 m behind, 0.6 m wide. Every frame of a move that turns or runs
 * along the row, every point of it is checked against every load still
 * standing — so "did it hit one" is geometry, not the mission's opinion of
 * itself. A test further down lies to the mission about the length, to show
 * the check can fail.
 *
 * The camera sees 0.15–0.55 m ahead of the axle, ± 0.15 m across for a QR
 * (read at 5 fps, like qr.js) and ± 0.2 m for a line. `qrSeeM` in the mission
 * is 0.15 — the same bottom edge — and `leadM` 0.20 is inside the picture.
 */
const YARD_X = { 1: fieldNode('A1').x, 2: fieldNode('A2').x, 3: fieldNode('A3').x };
const YARD = { paint: 2.7, edge: 1.5, deep: 0.6, half: 0.35, wide: 0.6, len: 1.2 };
const YARD_TURNS = new Set(['spin', 'seek', 'align', 'hop']);

function yardRun(o = {}) {
  const cfg = { axleM: 0.15, ...(o.cfg || {}) };
  const c = { ...MISSION_DEFAULTS, ...cfg };
  const F = o.front ?? 0.15, B = YARD.len - F;
  const slot = o.slot ?? 2, via = o.via ?? 1;
  const keys = { 1: 'ALIM1', 2: 'ALIM2', 3: 'ALIM3' };
  const st = missionCargo(missionState(), slot,
    { keys, qrKey: keys[slot], via, have: { to: via === slot, out: false }, runId: 9 }, cfg);
  // Where the taught scenario leaves the rover: short of via's line, looking up it.
  let x = YARD_X[via] + (o.dx ?? 0.02), y = o.y0 ?? -0.35, h = o.h0 ?? 2;
  const loads = new Set([1, 2, 3]);
  let res = missionOut(st), srv = null, t = 0, seen = null, readAt = -1;
  const legs = [], moves = [], spins = [];
  let hit = null, lastMove = null, traceX = null, endY = null, liftY = null;

  const fwd = () => [Math.sin(h * Math.PI / 180), Math.cos(h * Math.PI / 180)];
  const offAxis = () => Math.min(Math.abs(wrap(h)), Math.abs(wrap(h - 180)));
  const hidden = (k, py) => loads.has(k) && py >= YARD.edge && py <= YARD.edge + YARD.deep;
  const onPaint = (px, py) => [1, 2, 3].some((k) =>
    Math.abs(px - YARD_X[k]) <= 0.2 && py >= 0 && py <= YARD.paint && !hidden(k, py));

  for (let i = 0; i < 40000; i++) {
    t += CARGO_DT;
    // ── the server ──
    if (res.replay && (!srv || srv.id !== res.replay.id)) {
      legs.push(`${res.replay.slot}:${res.replay.leg}`);
      srv = { id: res.replay.id, active: true, done: false, aborted: false, err: null,
              seg: 1, of: 1, left: 10 };
    } else if (srv && srv.active && --srv.left <= 0) {
      srv.active = false; srv.done = true;
    }

    // ── the wheels ──
    let mmL = 0, mmR = 0;
    if (res.drive) {
      mmL = res.drive.p25 * MM_PER_PCT;
      mmR = res.drive.p26 * MM_PER_PCT;
    } else if (res.phase === 'run' || res.creep) {
      mmL = mmR = res.creep ? FOLLOW_MM * res.creep / 18 : FOLLOW_MM;
      const to = Math.abs(wrap(h)) < 90 ? 0 : 180;
      h = to + wrap(h - to) * 0.9;
      const k = [1, 2, 3].reduce((a, b) => (Math.abs(YARD_X[b] - x) < Math.abs(YARD_X[a] - x) ? b : a));
      x += (YARD_X[k] - x) * 0.1;
    }
    const gL = mmL * c.scale / 1000, gR = mmR * c.scale / 1000;
    h += (gL - gR) / FIELD_TRACK_M * 180 / Math.PI;
    const [fx, fy] = fwd();
    x += ((gL + gR) / 2) * fx;
    y += ((gL + gR) / 2) * fy;

    // ── the loads ──
    if (!hit && YARD_TURNS.has(res.move)) {
      for (let u = -B; u <= F + 1e-9 && !hit; u += 0.05) {
        for (let v = -YARD.wide / 2; v <= YARD.wide / 2 + 1e-9 && !hit; v += 0.05) {
          const px = x + u * fx + v * fy, py = y + u * fy - v * fx;
          for (const k of loads) {
            if (Math.abs(px - YARD_X[k]) <= YARD.half && py >= YARD.edge && py <= YARD.edge + YARD.deep) {
              hit = { move: res.move, slot: k, x: +x.toFixed(2), y: +y.toFixed(2), h: Math.round(wrap(h)) };
            }
          }
        }
      }
    }

    // ── the camera ──
    const sees = offAxis() < SEE_DEG;
    let bands = 0;
    for (const a of [0.15, 0.25, 0.35, 0.45, 0.55]) if (sees && onPaint(x + a * fx, y + a * fy)) bands++;
    const signed = Math.abs(wrap(h)) < Math.abs(wrap(h - 180)) ? wrap(h) : wrap(h - 180);
    const onLine = [1, 2, 3].some((k) => Math.abs(x - YARD_X[k]) <= 0.2);
    const north = Math.cos(h * Math.PI / 180) > 0;
    const stop = [1, 2, 3].some((k) => Math.abs(x - YARD_X[k]) <= 0.2 && loads.has(k))
      ? YARD.edge : YARD.paint;
    const end = sees && onLine && (north ? y + 0.25 >= stop && y < stop : y - 0.25 <= 0);
    // The reader: 5 frames a second, a code in shot 0.15–0.55 m ahead.
    if (t - readAt >= 0.2) {
      readAt = t;
      for (const k of [1, 2, 3]) {
        if ((o.torn || []).includes(k)) continue;
        const rx = YARD_X[k] - x, ry = -y;
        const ahead = rx * fx + ry * fy, across = rx * fy - ry * fx;
        if (ahead >= 0.15 && ahead <= 0.55 && Math.abs(across) <= 0.15) seen = { k, t };
      }
      // Glimpsed along the taught leg, which the page's wheels did not drive.
      if (o.pathQr && res.move === 'path') seen = { k: via, t };
    }
    const qr = seen
      ? { available: true, text: keys[seen.k], key: qrKey(keys[seen.k]),
          seen_age_s: Math.round((t - seen.t) * 10) / 10 }
      : { available: true, text: null, key: null, seen_age_s: null };

    res = missionStep(st, {
      junction: null, bands, near: sees ? Math.max(-1, Math.min(1, -signed / SEE_DEG)) : null,
      end: end ? { dist: 0.9 } : null,
      dLeftMm: mmL, dRightMm: mmR, dt: CARGO_DT, qr, replay: srv,
    }, cfg);

    if (res.move !== lastMove) {
      if (lastMove === 'trace' && endY === null) endY = y;
      if (res.move === 'trace' && traceX === null) traceX = x;
      if (res.move === 'spin') spins.push({ y: +y.toFixed(3), x: +x.toFixed(3) });
      if (res.move === 'lift') { liftY = y; loads.delete(slot); }  // on the fork from here
      if (res.move) moves.push(res.move);
      lastMove = res.move;
    }
    if (res.phase === 'done' || res.phase === 'lost' || res.phase === 'idle') break;
  }
  return { res, st, x, y, h, legs, moves, spins, hit, traceX, endY, liftY };
}

console.log('\nRoverin boyu — 1.20 m, dönəndə süpürdüyü dairə');
{
  const worst = missionReach();
  ok(near(worst, Math.hypot(1.2, 0.35), 0.005),
     `aks ölçülməyib: ən pis hal, bir ucdan fırlanır — ${worst.toFixed(2)} m`);
  ok(near(missionReach({ axleM: 0.15 }), Math.hypot(1.05, 0.35), 0.005),
     `aks kamera ucundan 0.15 m: uzun tərəf 1.05 m — ${missionReach({ axleM: 0.15 }).toFixed(2)} m`);
  ok(near(missionReach({ axleM: 0.6 }), Math.hypot(0.6, 0.35), 0.005), 'aks ortada: 0.69 m');
  const room = missionTurnRoom();
  ok(room > 0 && near(room, 1.5 - worst - 0.1, 0.005),
     `QR sırasında ən pis halda da dönmək olar — yükə qədər ${room.toFixed(2)} m ehtiyat qalır`);
}

console.log('\nBir ssenari — A1 öyrədilib, A2 və A3 QR sırası ilə');
for (const [via, slot] of [[1, 2], [1, 3], [3, 1], [2, 3]]) {
  const r = yardRun({ via, slot });
  ok(r.res.phase === 'done', `A${via} → A${slot}: ${r.res.why}`);
  eq(r.legs, [`${via}:to`], `  yalnız A${via}-in ssenarisi sürüldü`);
  ok(r.traceX !== null && near(r.traceX, YARD_X[slot], 0.08),
     `  A${slot}-in xəttini izlədi (x ${r.traceX && r.traceX.toFixed(2)}, xətt ${YARD_X[slot]})`);
  ok(!r.hit, `  heç bir yükə dəymədi${r.hit ? ` — ${JSON.stringify(r.hit)}` : ''}`);
  // The two 90° turns happen with the axle on the QR row, 1.5 m short of a
  // load. The second one is off it by the row's drift — `rowNear`'s degree or
  // so over 1.8 m per slot — and that is budgeted in the turn room.
  const row = r.spins.slice(0, 2);
  const drift = 0.02 + Math.abs(YARD_X[slot] - YARD_X[via]) * 0.022;
  ok(row.length === 2 && Math.abs(row[0].y) <= 0.03 && Math.abs(row[1].y) <= drift,
     `  90° dönmələr QR sırasında (y ${row.map((s) => s.y.toFixed(2)).join(', ')} m)`);
  ok(r.moves.includes('lift'), '  yükü götürdü');
}
{
  const r = yardRun({ via: 1, slot: 2 });
  eq(r.moves, ['path', 'seek', 'qr', 'align', 'seek', 'spin', 'hop', 'spin', 'seek', 'qr', 'trace',
               'back', 'spin', 'seek', 'back', 'lift', 'trace'], 'A1 → A2 hərəkət sırası');
  ok(r.st.qrOk && r.st.qrOk.move === 'hop', 'A2-nin QR-ı sıra boyu, hərəkətdə oxundu');
}

console.log('\n180° yükün qarşısında — əvvəl aralanır');
{
  const r = yardRun({ via: 2, slot: 2 });
  ok(r.res.phase === 'done' && !r.moves.includes('hop'), `öz ssenarisi ilə, sırasız — ${r.res.why}`);
  ok(!r.hit, `dönəndə yükə dəymədi${r.hit ? ` — ${JSON.stringify(r.hit)}` : ''}`);
  const dock = r.spins[r.spins.length - 1];
  ok(YARD.edge - dock.y >= missionReach({ axleM: 0.15 }),
     `180° yükdən ${(YARD.edge - dock.y).toFixed(2)} m aralıda (radius ${missionReach({ axleM: 0.15 }).toFixed(2)})`);
  ok(near(r.liftY - r.endY, MISSION_DEFAULTS.dockBackM, 0.05),
     `çəngəl əvvəlki yerinə girdi — boyanın bitdiyi yerdən ${(r.liftY - r.endY).toFixed(2)} m`);

  // The check can fail: tell the mission the rover is 0.4 m long and it turns
  // where a 0.4 m rover could — and the real 1.20 m goes through the load.
  const liar = yardRun({ via: 2, slot: 2, cfg: { roverLenM: 0.4, axleM: 0.2 } });
  ok(liar.hit && liar.hit.slot === 2,
     `1.20 m nəzərə alınmasa yükə dəyir — ${liar.hit ? `${liar.hit.move}, y ${liar.hit.y}` : 'dəymədi?!'}`);

  // The axle not measured: the worst case turns further off — and still fetches it.
  const worst = yardRun({ via: 1, slot: 3, cfg: { axleM: null } });
  ok(worst.res.phase === 'done' && !worst.hit,
     `aks ölçülməyib (ən pis hal): A1 → A3 yenə də dəymədən — ${worst.res.why}`);
}

console.log('\nQR sırası — oxunmasa, keçilsə, sığmasa');
{
  const torn = yardRun({ via: 1, slot: 2, torn: [2] });
  ok(torn.res.phase === 'lost' && /ALIM2 görünmədi/.test(torn.res.why), torn.res.why);
  ok(!torn.moves.includes('trace'), '  heç bir xəttə dönmədi');

  const past = yardRun({ via: 1, slot: 2, torn: [2], cfg: { hopOverM: 3 } });
  ok(past.res.phase === 'lost' && /ALIM3 göründü — A2 keçildi/.test(past.res.why), past.res.why);

  const long = missionCargo(missionState(), 2, { via: 1, have: { to: false } }, { roverLenM: 1.6 });
  ok(long.phase === 'idle' && /keçmək olmur/.test(long.why), `1.6 m rover QR sırasında dönə bilmir — ${long.why}`);
  const own = missionCargo(missionState(), 2, { via: 2, have: { to: true } }, { roverLenM: 1.6 });
  ok(own.phase !== 'idle', '  öz ssenarisi olan yuvaya isə gedir (sıra lazım deyil)');

  const none = missionCargo(missionState(), 2, { via: null, have: { to: false } });
  ok(none.phase === 'idle' && /öyrədilməyib/.test(none.why), `heç bir ssenari yoxdur — ${none.why}`);

  // The scenario drove past A1's code: seen only along the taught leg, so the
  // rover backs up until it is in shot again, and measures the row from there.
  const over = yardRun({ via: 1, slot: 2, y0: 0.05, pathQr: true });
  ok(over.res.phase === 'done' && !over.hit, `QR yolda keçilib — geri qayıdıb tapdı: ${over.res.why}`);
  ok(Math.abs(over.spins[0].y) <= 0.06, `  yenə QR sırasında döndü (y ${over.spins[0].y.toFixed(2)} m)`);
}

console.log('\nXəritə işi yük işini silir');
{
  const st = missionCargo(missionState(), 1, { have: { to: true } });
  missionSet(st, 'A2');
  ok(st.cargo === null && st.target === 'A2' && st.q[0].kind !== 'path',
     'missionSet() yük sahələrini təmizləyir');
}

console.log(`\n${fail ? 'FAILED' : 'ALL CHECKS PASSED'} — ${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
