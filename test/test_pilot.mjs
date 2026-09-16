/**
 * Pilot checks — the control law that turns a steering error into two wheel
 * percentages. No browser and no hardware: pilotStep is a pure function, so
 * a whole run can be simulated in a loop and asserted on.
 *
 *   node test/test_pilot.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'pilot.js'), 'utf8');

// public/pilot.js is a plain browser script. Rather than adding module
// plumbing to it just for the tests, evaluate it and take the globals out —
// the file under test is then exactly the file the browser loads.
const { PILOT_DEFAULTS, pilotState, pilotStep, metresPerSecond,
        SPEED_DEFAULTS, speedState, speedStep } =
  new Function(`${src}
    return { PILOT_DEFAULTS, pilotState, pilotStep, metresPerSecond,
             SPEED_DEFAULTS, speedState, speedStep };`)();

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}  (${a} ≈ ${b})`);

const DT = 50;                       // 20 Hz, the rate the page actually runs at
const road = (e, bands = 8) => ({ near: e, far: e, bands, want: 8 });
const lost = { near: null, far: null, bands: 0, want: 8 };

/** Run `n` steps of the same observation and return the last output. */
function run(obs, cfg = {}, n = 40, st = null, t0 = 0) {
  const s = st || pilotState(t0);
  let out = null, t = s.t;
  for (let i = 0; i < n; i++) { t += DT; out = pilotStep(s, typeof obs === 'function' ? obs(i) : obs, cfg, t); }
  return { out, st: s, t };
}

console.log('\nDüz yolda sabit sürət');
{
  const { out } = run(road(0));
  ok(out.p25 === out.p26, `hər iki təkər eyni  (${out.p25} / ${out.p26})`);
  near(out.speed, PILOT_DEFAULTS.base, 0.5, 'sürət «base»-ə oturur');
  ok(out.steer === 0, `sükan sıfır  (${out.steer})`);
  ok(out.reason === 'düz yol', `səbəb: ${out.reason}`);
  ok(!out.stop && !out.lost, 'nə itki, nə dayanma');
}

console.log('\nSükan doğru tərəfə dönür');
{
  const r = run(road(0.5)).out;      // road to the RIGHT
  ok(r.p26 < r.p25, `yol sağda → GPIO26 yavaşlayır  (${r.p25} / ${r.p26})`);
  const l = run(road(-0.5)).out;
  ok(l.p25 < l.p26, `yol solda → GPIO25 yavaşlayır  (${l.p25} / ${l.p26})`);
  ok(Math.abs(l.steer + r.steer) < 1e-9, 'simmetrik');
}

console.log('\nSürət həddi — döngədə yavaşlayır');
{
  const straight = run(road(0)).out.speed;
  const gentle = run(road(0.25)).out.speed;
  const sharp = run(road(0.8), { hard: 2 }).out.speed;
  ok(straight > gentle && gentle > sharp,
     `düz ${straight} > yumşaq ${gentle} > kəskin ${sharp}`);
  ok(sharp >= PILOT_DEFAULTS.min, `kəskin döngədə belə «min»-dən aşağı düşmür  (${sharp})`);
  // The far error is what makes this early rather than mid-corner.
  const ahead = run({ near: 0, far: 0.8, bands: 8, want: 8 }, { hard: 2 }).out.speed;
  ok(ahead < straight,
     `hələ düz gedərkən qabaqdakı döngəyə görə yavaşlayır  (${ahead} < ${straight})`);
}

console.log('\nQısa zəncir də sürəti kəsir');
{
  const full = run(road(0, 8)).out.speed;
  const half = run(road(0, 4)).out.speed;
  ok(half < full, `8 zolaq ${full} > 4 zolaq ${half}`);
}

console.log('\nTavan və döşəmə');
{
  const hi = run(road(0), { base: 900 }).out.speed;
  ok(hi === PILOT_DEFAULTS.max, `«max» tavanı saxlanır  (${hi})`);
  const lo = run(road(0.95), { base: 20, min: 12, hard: 2 }).out.speed;
  ok(lo >= 12, `«min» döşəməsi saxlanır  (${lo})`);
  const out = run(road(0), { base: 900 }).out;
  ok(out.p25 <= 100 && out.p26 <= 100, `faiz 100-ü keçmir  (${out.p25})`);
}

console.log('\nSürətlənmə pillə-pillə, tormoz sərt');
{
  const s = pilotState(0);
  const first = pilotStep(s, road(0), {}, DT);
  ok(first.speed < PILOT_DEFAULTS.base / 2,
     `ilk kadrda birdən tam qaza basmır  (${first.speed} %)`);
  near(first.speed, PILOT_DEFAULTS.accel * DT / 1000, 0.01, 'sürətlənmə «accel» ilə məhdud');
  // A stalled tab must not turn into a jump when it comes back.
  const s2 = pilotState(0);
  const jump = pilotStep(s2, road(0), {}, 5000);
  ok(jump.speed <= PILOT_DEFAULTS.accel * 0.25 + 0.01,
     `5 s donmuş tab-dan sonra da sıçrayış yoxdur  (${jump.speed} %)`);
}

console.log('\nYol itəndə: son istiqamətlə yavaş, sonra dayanır');
{
  const { st, t } = run(road(0.5));  // steady on a right-hand bend
  const before = st.speed, steer = st.steer;

  const a = pilotStep(st, lost, {}, t + DT);
  const lostAt = t + DT;
  ok(a.lost, 'itki qeyd olunur');
  ok(Math.abs(a.steer - steer) < 1e-9, `sükan saxlanılır  (${a.steer})`);
  ok(a.speed < before, `sürət azalır  (${before} → ${a.speed})`);
  ok(!a.stop, 'hələ ENABLE düşmür');
  near(a.speed, before * PILOT_DEFAULTS.holdCut / 100, before * 0.05,
       `itki anındakı sürətin ${PILOT_DEFAULTS.holdCut} %-inə düşür`);

  // It has to HOLD there, not keep cutting 55 % of an already-falling number
  // every frame — that used to compound to zero well inside the window, and
  // the wheel then jumped back to speed the instant the road reappeared.
  // That silent, fast-then-slam cycle was the "impulse".
  let out = a, tt = lostAt;
  for (let i = 0; i < 8; i++) { tt += DT; out = pilotStep(st, lost, {}, tt); }
  ok(tt - lostAt < PILOT_DEFAULTS.hold, `hələ hold pəncərəsindəyik  (${tt - lostAt} ms)`);
  near(out.speed, a.speed, 0.5, `pəncərə boyu sürət sabit qalır, sönmür  (${out.speed} %)`);

  // ... and only past the window does it actually brake to a stop.
  for (let i = 0; i < 6; i++) { tt += DT; out = pilotStep(st, lost, {}, tt); }
  ok(tt - lostAt > PILOT_DEFAULTS.hold, `${tt - lostAt} ms sonra hold pəncərəsi bitib`);
  ok(out.speed === 0, `dayanıb  (${out.speed} %)`);
  ok(!out.stop, 'amma hələ ENABLE saxlanır — yol qayıda bilər');

  // ... and past the grace period it gives up.
  for (let i = 0; i < 40; i++) { tt += DT; out = pilotStep(st, lost, {}, tt); }
  ok(out.stop, `${tt - lostAt} ms sonra ENABLE-nin düşməsini istəyir`);
  ok(out.reason === 'yol yok — durdu', `səbəb: ${out.reason}`);
}

console.log('\nYol qayıdanda özü davam edir');
{
  const { st, t } = run(road(0));
  let tt = t, out = null;
  for (let i = 0; i < 8; i++) { tt += DT; out = pilotStep(st, lost, {}, tt); }
  const dip = out.speed;
  for (let i = 0; i < 30; i++) { tt += DT; out = pilotStep(st, road(0), {}, tt); }
  ok(out.speed > dip, `sürət geri qalxır  (${dip} → ${out.speed})`);
  ok(!out.stop && !out.lost, 'normal rejimə qayıdır');
}

console.log('\nBir zolaq yol sayılmır');
{
  const { out } = run(road(0, 1));
  ok(out.lost, 'tək zolaq təsadüfi ləkədir — yol kimi qəbul edilmir');
}

console.log('\nYoldan çox uzaqda: sürət minimuma, üzü yola');
{
  const cfg = { hard: 0.6, crawl: 10, base: 40 };
  const r = run(road(0.9), cfg).out;
  ok(r.recover, 'geri qayıtma rejimi işə düşür');
  ok(r.steer === 1, `sükan tam sağa  (${r.steer})`);
  ok(r.p26 === 0, `daxili təkər dayanır — yerində çevrilir  (${r.p26})`);
  ok(r.p25 > 0, `xarici təkər sürünür  (${r.p25})`);
  near(r.speed, 10, 0.5, 'sürət «crawl»-a düşür');
  ok(/çok sağda/.test(r.reason), `səbəb: ${r.reason}`);

  const l = run(road(-0.9), cfg).out;
  ok(l.steer === -1 && l.p25 === 0 && l.p26 > 0, `sola simmetrikdir  (${l.p25}/${l.p26})`);

  // It has to be much slower than an ordinary bend, not just a bit.
  const bend = run(road(0.45), cfg).out;
  ok(r.speed < bend.speed * 0.75,
     `adi döngədən xeyli yavaş  (${r.speed} < ${bend.speed})`);
}

console.log('\nGeri qayıtma rejimi titrəmir');
{
  const cfg = { hard: 0.6, crawl: 10, base: 40 };
  // Enter at 0.6…
  const { st, t } = run(road(0.65), cfg);
  ok(st.recover, 'daxil oldu');
  // …and 0.55 is not enough to leave: that would flicker on the threshold.
  let tt = t, out = null;
  for (let i = 0; i < 10; i++) { tt += DT; out = pilotStep(st, road(0.5), cfg, tt); }
  ok(out.recover, `0.50-də hələ çevrilir (histerezis)  (${out.reason})`);
  for (let i = 0; i < 30; i++) { tt += DT; out = pilotStep(st, road(0.3), cfg, tt); }
  ok(!out.recover, `0.30-da normal sürməyə qayıdır  (${out.reason})`);
}

console.log('\n90° döngə: uzaqdakı köşe hələ döngə deyil');
{
  // The L is in the picture but at the top of it — half a metre of road still
  // to drive before it matters. Committing here would turn in the middle of a
  // straight.
  const obs = { ...road(0), corner: { dir: 1, dist: 0.35 } };
  const { out } = run(obs);
  ok(out.turn === 0, 'döngəyə keçmir');
  ok(out.corner === 1, `köşeni görür və istiqamətini bilir  (${out.corner})`);
  ok(out.reason === 'düz yol', `düz sürməyə davam edir  (${out.reason})`);
}

console.log('\n90° döngə: yaxınlaşanda əvvəl sürünür, sonra yerində çevrilir');
{
  const cfg = { base: 40, crawl: 10 };
  const obs = { ...road(0), corner: { dir: 1, dist: 0.9 } };   // right at the wheels
  // First the creep: still straight, but already down to crawl speed.
  const { st, t } = run(obs, cfg, 3);
  ok(st.turn !== null, 'döngəyə keçdi');
  const creep = pilotStep(st, obs, cfg, t + DT);
  ok(creep.turn === 1, `sağa döngə  (${creep.turn})`);
  ok(creep.steer === 0, `hələ düz gedir — kamera təkərlərdən qabağa baxır  (${creep.steer})`);
  ok(creep.reason === 'köşe — yaklaşıyor', `səbəb: ${creep.reason}`);

  // Then the pivot, once `creepMs` of that has been driven.
  let tt = t + DT, out = creep;
  for (let i = 0; i < 12; i++) { tt += DT; out = pilotStep(st, { ...lost, corner: { dir: 1, dist: 0.95 } }, cfg, tt); }
  ok(out.steer === 1, `sükan tam sağa  (${out.steer})`);
  ok(out.p26 === 0 && out.p25 > 0, `daxili təkər dayanır, yerində çevrilir  (${out.p25}/${out.p26})`);
  near(out.speed, cfg.crawl, 0.5, 'sürət «crawl»-dadır');
  ok(out.reason === 'köşe — sağa dönüyor', `səbəb: ${out.reason}`);

  // The mirror image.
  const lobs = { ...road(0), corner: { dir: -1, dist: 0.9 } };
  const l = run({ ...lost, corner: { dir: -1, dist: 0.95 } }, cfg, 16,
                run(lobs, cfg, 3).st, 0).out;
  ok(l.steer === -1 && l.p25 === 0 && l.p26 > 0, `sola simmetrikdir  (${l.p25}/${l.p26})`);
}

console.log('\n90° döngə: dönmədən əvvəl santimetr gedir, saniyə yox');
{
  // The camera is on the FRONT of the rover, so when the corner reaches the
  // bottom of the picture the axle is still a camera-to-axle offset short of
  // it. That offset is a distance — the same 15 cm at any speed — so the creep
  // is driven in cm, not ms. A timed creep turns early, and turns earlier the
  // slower the robot happens to be going.
  //
  // 0.5 m/s at 50 %, no dead band: at `crawl` 10 % that is 0.1 m/s, so 15 cm
  // is 1.5 s — six times the 250 ms fallback.
  const calib = { pct: 50, metres: 3, seconds: 6 };
  const cfg = { base: 40, crawl: 10, creepCm: 15, calib };
  const obs = { ...road(0), corner: { dir: 1, dist: 0.9 } };
  const { st, t } = run(obs, cfg, 3);
  ok(st.turn !== null, 'döngəyə keçdi');

  let tt = t, out = null, pivotAt = 0, cm = null;
  for (let i = 0; i < 60; i++) {
    tt += DT;
    out = pilotStep(st, obs, cfg, tt);
    if (out.turn && out.creep === null && !pivotAt) { pivotAt = tt; cm = st.turn.cm; }
  }
  ok(pivotAt, 'nə vaxtsa çevrilməyə başlayır');
  ok(pivotAt - t > 1000,
     `250 ms-dən çox əvvəl dönmür — ${Math.round(pivotAt - t)} ms sürünür`);
  near(cm, 15, 1.5, 'və təxminən 15 sm gedir');

  // The same 15 cm, driven twice as fast, has to take half as long — that is
  // the whole difference between a distance and a duration.
  const fast = { ...cfg, crawl: 20 };
  const r2 = run(obs, fast, 3);
  let t2 = r2.t, pivot2 = 0;
  for (let i = 0; i < 60; i++) {
    t2 += DT;
    const o = pilotStep(r2.st, obs, fast, t2);
    if (o.turn && o.creep === null && !pivot2) pivot2 = t2;
  }
  ok(pivot2 && pivot2 - r2.t < (pivotAt - t) * 0.75,
     `iki dəfə sürətli getsə yarı vaxtda çatır  (${Math.round(pivot2 - r2.t)} ms `
   + `< ${Math.round(pivotAt - t)} ms)`);
}

console.log('\n90° döngə: kalibrasiya yoxdursa vaxta düşür');
{
  // No calibration means no cm to measure, and a creep that never ends is
  // worse than one that ends early. Same for a `crawl` inside the motor's dead
  // band: the wheel is not turning, so no distance is accumulating either.
  for (const [name, cfg] of [
    ['kalibrasiya yoxdur', { base: 40, crawl: 10, creepCm: 15 }],
    ['ölü zonada sürünür', { base: 40, crawl: 10, creepCm: 15,
                             calib: { pct: 50, metres: 3, seconds: 6, dead: 20 } }],
  ]) {
    const obs = { ...road(0), corner: { dir: 1, dist: 0.9 } };
    const { st, t } = run(obs, cfg, 3);
    let tt = t, pivotAt = 0;
    for (let i = 0; i < 40; i++) {
      tt += DT;
      const o = pilotStep(st, obs, cfg, tt);
      if (o.turn && o.creep === null && !pivotAt) pivotAt = tt;
    }
    ok(pivotAt && pivotAt - t <= PILOT_DEFAULTS.creepMs + DT,
       `${name}: ${PILOT_DEFAULTS.creepMs} ms sonra yenə çevrilir `
     + `(${pivotAt ? Math.round(pivotAt - t) : 'heç vaxt'} ms)`);
  }
}

console.log('\n90° döngə: zəncir yoxa çıxanda dayanmır, çevrilir');
{
  // This is the case the whole thing exists for. The corner takes the chain
  // with it a frame or two before the robot reaches it, and the old code then
  // ran the lost-road timers: 0.6 s of blind rolling, then a stop, then
  // ENABLE dropped — in the middle of a corner it could have taken.
  // `turnMs` is raised out of the way here: what is being asserted is that the
  // lost-road timers do not run during a turn, not how long a turn may last —
  // that is the next check's job.
  const cfg = { base: 40, crawl: 10, turnMs: 6000 };
  const { st, t } = run({ ...road(0), corner: { dir: 1, dist: 0.9 } }, cfg, 3);
  let tt = t, out = null;
  const n = Math.ceil((PILOT_DEFAULTS.hold + PILOT_DEFAULTS.give + 500) / DT);
  for (let i = 0; i < n; i++) { tt += DT; out = pilotStep(st, lost, cfg, tt); }
  ok(tt - t > PILOT_DEFAULTS.hold + PILOT_DEFAULTS.give,
     `${tt - t} ms — köhnə məntiqlə çoxdan ENABLE düşərdi`);
  ok(!out.stop, 'ENABLE düşmür');
  ok(out.turn === 1, `hələ döngədədir  (${out.reason})`);
  ok(out.speed > 0, `hərəkət davam edir  (${out.speed} %)`);
}

console.log('\n90° döngə: yol qabağa çıxanda bitir');
{
  const cfg = { base: 40, crawl: 10 };
  const { st, t } = run({ ...road(0), corner: { dir: 1, dist: 0.9 } }, cfg, 3);
  let tt = t, out = null;
  // Pivoting: the road is not in front yet, so the L is still reported.
  for (let i = 0; i < 12; i++) { tt += DT; out = pilotStep(st, { ...lost, corner: { dir: 1, dist: 0.95 } }, cfg, tt); }
  ok(out.turn === 1, 'çevrilir');
  // Now the arm is dead ahead and there is no L left in the picture.
  for (let i = 0; i < 20; i++) { tt += DT; out = pilotStep(st, road(0.05), cfg, tt); }
  ok(out.turn === 0, 'döngə bitdi');
  ok(out.reason === 'düz yol', `adi sürməyə qayıtdı  (${out.reason})`);
  ok(out.speed > cfg.crawl, `sürət yenidən qalxır  (${out.speed} %)`);
}

console.log('\n90° döngə: dönüşü bitirən kimi geri dönmür');
{
  // Mid-pivot the camera sweeps across the junction it is already turning at,
  // and the same L comes back pointing at the road the robot has just left.
  // Acting on that means finishing a right turn and immediately committing to
  // a left one — back the way it came, for ever.
  const cfg = { base: 40, crawl: 10 };
  const { st, t } = run({ ...road(0), corner: { dir: 1, dist: 0.9 } }, cfg, 3);
  let tt = t, out = null;
  // Pivoting, and now the L appears to point back to the left.
  for (let i = 0; i < 12; i++) { tt += DT; out = pilotStep(st, { ...lost, corner: { dir: -1, dist: 0.95 } }, cfg, tt); }
  ok(out.turn === 1, `başladığı istiqamətdə qalır  (${out.turn})`);
  // The road turns up in front — and the L, still in the picture for a moment
  // as the camera clears the junction, now points back the way it came. The
  // turn has to end (an L pointing the other way is not a reason to keep
  // pivoting) and no new one may start while the robot is still on that
  // junction.
  let ended = 0;
  for (let i = 0; i < 12; i++) {
    tt += DT;
    out = pilotStep(st, { ...road(0.05), corner: { dir: -1, dist: 0.95 } }, cfg, tt);
    if (!out.turn && !ended) ended = tt;
  }
  ok(ended, 'əks tərəfə baxan köşe dönüşü uzatmır — dönüş bitir');
  ok(out.turn === 0, `və yenidən sola dönməyə başlamır  (${out.reason})`);
  ok(out.reason === 'düz yol', `adi sürməyə qayıdır  (${out.reason})`);
  // Clear road afterwards: still following, still not turning.
  for (let i = 0; i < 10; i++) { tt += DT; out = pilotStep(st, road(0.05), cfg, tt); }
  ok(out.turn === 0 && out.reason === 'düz yol', 'sonra da düz sürür');
}

console.log('\n90° döngə: yol tapılmasa əbədi fırlanmır');
{
  const cfg = { base: 40, crawl: 10 };
  const { st, t } = run({ ...road(0), corner: { dir: 1, dist: 0.9 } }, cfg, 3);
  let tt = t, out = null;
  // Nothing ever comes back — a corner that was a shadow, or a robot that
  // pivoted past the road. It must give the turn up and let the ordinary lost
  // handling stop the robot, rather than spin on the spot for ever.
  const n = Math.ceil((PILOT_DEFAULTS.turnMs + PILOT_DEFAULTS.creepMs
                     + PILOT_DEFAULTS.hold + PILOT_DEFAULTS.give + 500) / DT);
  for (let i = 0; i < n; i++) { tt += DT; out = pilotStep(st, lost, cfg, tt); }
  ok(out.turn === 0, 'döngədən çıxdı');
  ok(out.stop, `ENABLE-nin düşməsini istəyir  (${out.reason})`);
}

console.log('\nSürət dövrəsi: gərginlik nə olursa olsun, sürət eynidir');
{
  const CFG = { closed: true, hzFull: 200, kP: 0.15, kI: 0.6, maxTrim: 35 };
  const SDT = 50;

  /**
   * A wheel that needs MORE volts than the open-loop guess thinks.
   * `k` is how many Hz it gives per pin %, so a small k is a heavy wheel.
   */
  function spin(k, ffPin, cfg = CFG, n = 200, demand = 50) {
    const st = speedState(0);
    let t = 0, out = null, hz = 0;
    for (let i = 0; i < n; i++) {
      t += SDT;
      out = speedStep(st, demand, ffPin, hz, cfg, t);
      hz = Math.max(0, out.pin * k);       // the wheel responds instantly
    }
    return { out, hz, st };
  }

  // Same demand, two very different wheels: one needs 40 % to do 100 Hz, the
  // other needs 62 %. The loop has to land both on 100 Hz.
  const strong = spin(2.5, 40);
  const weak = spin(1.6, 40);
  near(strong.hz, 100, 2, 'güclü təkər hədəfə oturur');
  near(weak.hz, 100, 2, 'zəif təkər də eyni sürətə oturur');
  ok(weak.out.pin > strong.out.pin,
     `zəif təkərə daha çox verilir  (${weak.out.pin} vs ${strong.out.pin} %)`);
  ok(Math.abs(strong.hz - weak.hz) < 3,
     `iki fərqli motor, eyni sürət  (${Math.round(strong.hz)} / ${Math.round(weak.hz)} Hz)`);

  // The point of the whole thing: the open-loop guess can be wrong and the
  // answer does not change — as long as the correction fits inside maxTrim.
  const badGuess = spin(2.0, 25);
  near(badGuess.hz, 100, 2, 'açıq dövrə təxmini səhv olsa da hədəfə çatır');

  // And when it does not fit, the loop stops at the limit rather than pretending.
  // maxTrim exists so a wrong guess cannot become full throttle.
  const wayOff = spin(2.0, 5);
  ok(wayOff.out.trim <= 35 + 1e-6 && wayOff.hz < 100,
     `düzəliş həddi aşılmır — hədəfə çatmır, amma qaçmır da  (${wayOff.out.trim} %)`);

  // Halve the demand, halve the speed.
  const half = spin(2.0, 40, CFG, 200, 25);
  near(half.hz, 50, 2, 'tələb yarıya düşəndə sürət də yarıya düşür');
}

console.log('\nSürət dövrəsi təhlükəsiz dayanır');
{
  const CFG = { closed: true, hzFull: 200, deadMs: 500 };
  const st = speedState(0);

  // Zero demand: no integral, no output, whatever the sensor says.
  const stopped = speedStep(st, 0, 40, 0, CFG, 100);
  ok(stopped.pin === 0 && stopped.trim === 0, `sıfır tələb, sıfır çıxış  (${stopped.pin})`);

  // A wheel that never moves: jammed, or the sensor wire fell off. The loop
  // must NOT ramp to full throttle against it.
  const st2 = speedState(0);
  let out = null, t = 0;
  for (let i = 0; i < 40; i++) { t += 50; out = speedStep(st2, 50, 40, 0, CFG, t); }
  ok(!out.ok, 'impuls gəlmədiyini bildirir');
  ok(out.pin === 40, `açıq dövrə təxminində qalır, tam qaza basmır  (${out.pin} %)`);
  ok(/darbe gelmiyor/.test(out.reason), `səbəb: ${out.reason}`);

  // No sensor at all is the same answer.
  const st3 = speedState(0);
  const none = speedStep(st3, 50, 40, null, CFG, 100);
  ok(!none.ok && none.pin === 40, 'sensor yoxdursa da açıq dövrə');

  // Not calibrated: behave exactly as before, and say why.
  const st4 = speedState(0);
  const raw = speedStep(st4, 50, 40, 120, { closed: true, hzFull: 0 }, 100);
  ok(raw.pin === 40 && !raw.closed, `hzFull ölçülməyibsə dövrə bağlanmır  (${raw.reason})`);
  const off = speedStep(st4, 50, 40, 120, { closed: false, hzFull: 200 }, 150);
  ok(off.pin === 40 && !off.closed, 'söndürülübsə də toxunmur');
}

console.log('\nSürət dövrəsi doymada ilişmir');
{
  // Ask for more than the wheel can ever give: the output pins at 100 and the
  // integral must not keep growing, or the wheel stays at full throttle for
  // seconds after the demand drops.
  const CFG = { closed: true, hzFull: 200, kP: 0.15, kI: 0.6, maxTrim: 35 };
  const st = speedState(0);
  let t = 0, hz = 0, out = null;
  for (let i = 0; i < 200; i++) {
    t += 50;
    out = speedStep(st, 100, 80, hz, CFG, t);
    hz = out.pin * 1.0;                     // can only ever reach 100 Hz
  }
  ok(out.pin === 100, `çıxış tavanda  (${out.pin})`);
  ok(Math.abs(st.i) <= 35 + 1e-6, `inteqral həddi keçmir  (${st.i.toFixed(1)})`);

  // Now the demand drops. It must come down promptly, not after a long unwind.
  let low = null;
  for (let i = 0; i < 20; i++) { t += 50; low = speedStep(st, 20, 25, hz, CFG, t); hz = low.pin * 1.0; }
  ok(low.pin < 60, `tələb düşəndə çıxış da düşür  (${low.pin} %)`);
  near(hz, 40, 8, 'yeni hədəfə yaxınlaşır');
}

console.log('\nMəsafə: kalibrasiya sabiti');
{
  ok(metresPerSecond(50, null) === null, 'kalibrasiya yoxdursa null qaytarır');
  ok(metresPerSecond(50, { pct: 50, metres: 0, seconds: 4 }) === null,
     'yarımçıq kalibrasiya da null');
  const c = { pct: 50, metres: 3, seconds: 4 };       // 0.75 m/s at 50 %
  near(metresPerSecond(50, c), 0.75, 1e-9, 'ölçülən nöqtədə düz gəlir');
  near(metresPerSecond(25, c), 0.375, 1e-9, 'yarı faiz → yarı sürət');
  ok(metresPerSecond(0, c) === 0, '0 % → 0 m/s');
  // With a dead band the line starts where the wheel actually starts turning.
  const d = { pct: 50, metres: 3, seconds: 4, dead: 10 };
  near(metresPerSecond(10, d), 0, 1e-9, 'ölü zonanın altında hərəkət yoxdur');
  near(metresPerSecond(50, d), 0.75, 1e-9, 'ölçülən nöqtə yenə düz gəlir');
  near(metresPerSecond(30, d), 0.375, 1e-9, 'ölü zonadan yuxarı xətti');
}

console.log(`\n${fail ? 'FAILED' : 'ALL CHECKS PASSED'} — ${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
