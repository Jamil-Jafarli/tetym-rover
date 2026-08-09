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
const { PILOT_DEFAULTS, pilotState, pilotStep, metresPerSecond, lift } =
  new Function(`${src}
    return { PILOT_DEFAULTS, pilotState, pilotStep, metresPerSecond, lift };`)();

// Most of the checks below are about the control law, not about the motor's
// dead band, so they run with it switched off and read demands directly.
const NOSTALL = { stall: 0 };

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}  (${a} ≈ ${b})`);

const DT = 50;                       // 20 Hz, the rate the page actually runs at
const road = (e, bands = 8) => ({ near: e, far: e, bands, want: 8 });
const lost = { near: null, far: null, bands: 0, want: 8 };

/** Run `n` steps of the same observation and return the last output. */
function run(obs, cfg = {}, n = 40, st = null, t0 = 0) {
  const s = st || pilotState(t0);
  const c = { ...NOSTALL, ...cfg };
  let out = null, t = s.t;
  for (let i = 0; i < n; i++) { t += DT; out = pilotStep(s, typeof obs === 'function' ? obs(i) : obs, c, t); }
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

console.log('\n«swap» yalnız iki pini dəyişir');
{
  const a = run(road(0.5)).out;
  const b = run(road(0.5), { swap: true }).out;
  ok(a.p25 === b.p26 && a.p26 === b.p25,
     `sütunlar yer dəyişir  (${a.p25}/${a.p26} → ${b.p25}/${b.p26})`);
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
  const first = pilotStep(s, road(0), NOSTALL, DT);
  ok(first.speed < PILOT_DEFAULTS.base / 2,
     `ilk kadrda birdən tam qaza basmır  (${first.speed} %)`);
  near(first.speed, PILOT_DEFAULTS.accel * DT / 1000, 0.01, 'sürətlənmə «accel» ilə məhdud');
  // A stalled tab must not turn into a jump when it comes back.
  const s2 = pilotState(0);
  const jump = pilotStep(s2, road(0), NOSTALL, 5000);
  ok(jump.speed <= PILOT_DEFAULTS.accel * 0.25 + 0.01,
     `5 s donmuş tab-dan sonra da sıçrayış yoxdur  (${jump.speed} %)`);
}

console.log('\nYol itəndə: son istiqamətlə yavaş, sonra dayanır');
{
  const { st, t } = run(road(0.5));  // steady on a right-hand bend
  const before = st.speed, steer = st.steer;

  const a = pilotStep(st, lost, NOSTALL,t + DT);
  ok(a.lost, 'itki qeyd olunur');
  ok(Math.abs(a.steer - steer) < 1e-9, `sükan saxlanılır  (${a.steer})`);
  ok(a.speed < before, `sürət azalır  (${before} → ${a.speed})`);
  ok(!a.stop, 'hələ ENABLE düşmür');

  // ... through the hold window ...
  let out = a, tt = t + DT;
  for (let i = 0; i < 12; i++) { tt += DT; out = pilotStep(st, lost, NOSTALL,tt); }
  ok(tt - t > PILOT_DEFAULTS.hold, `${tt - t} ms sonra hold pəncərəsi bitib`);
  ok(out.speed === 0, `dayanıb  (${out.speed} %)`);
  ok(!out.stop, 'amma hələ ENABLE saxlanır — yol qayıda bilər');

  // ... and past the grace period it gives up.
  for (let i = 0; i < 40; i++) { tt += DT; out = pilotStep(st, lost, NOSTALL,tt); }
  ok(out.stop, `${tt - t} ms sonra ENABLE-nin düşməsini istəyir`);
  ok(out.reason === 'yol yoxdur — dayandı', `səbəb: ${out.reason}`);
}

console.log('\nYol qayıdanda özü davam edir');
{
  const { st, t } = run(road(0));
  let tt = t, out = null;
  for (let i = 0; i < 8; i++) { tt += DT; out = pilotStep(st, lost, NOSTALL,tt); }
  const dip = out.speed;
  for (let i = 0; i < 30; i++) { tt += DT; out = pilotStep(st, road(0), NOSTALL, tt); }
  ok(out.speed > dip, `sürət geri qalxır  (${dip} → ${out.speed})`);
  ok(!out.stop && !out.lost, 'normal rejimə qayıdır');
}

console.log('\nBir zolaq yol sayılmır');
{
  const { out } = run(road(0, 1));
  ok(out.lost, 'tək zolaq təsadüfi ləkədir — yol kimi qəbul edilmir');
}

console.log('\nÖlü zona: 1.5 V-dən aşağı təkər dönmür');
{
  // 22 % of a 3.3 V ceiling is 1.5 V. Below it the wheel is not slow, it is off.
  const st = { stall: 22 };
  ok(lift(0, 22) === 0, 'sıfır sıfır qalır — təkəri dayandırmaq mümkün olmalıdır');
  near(lift(100, 22), 100, 1e-9, 'tam qaz tam qaz qalır');
  near(lift(50, 22), 61, 1e-9, 'ortadakı tələb istifadə olunan aralığa yayılır');
  ok(lift(0.1, 22) > 22, 'ən kiçik müsbət tələb belə dönmə həddinin üstündədir');

  const { out } = run(road(0), { ...st, base: 20 });
  ok(out.p25 >= 22, `düz yolda hər iki təkər həddin üstündədir  (${out.p25} %)`);
  near(out.p25, 22 + 20 * 0.78, 0.2, 'tələb [22,100] aralığına köçürülür');

  // The failure in the logs: a modest steer used to drop the inner wheel into
  // the dead band, so it did not slow down — it stopped.
  const turn = run(road(0.3), { ...st, base: 20, hard: 2 }).out;
  ok(turn.p26 >= 22, `yumşaq döngədə daxili təkər hələ də dönür  (${turn.p26} %)`);
  ok(turn.p26 < turn.p25, `amma xaricidən yavaşdır  (${turn.p26} < ${turn.p25})`);

  // Full steer must still be able to stop the inner wheel outright — that is
  // what makes the tightest turn.
  const hardTurn = run(road(0.95), { ...st, base: 20 }).out;
  ok(hardTurn.p26 === 0, `tam sükanda daxili təkər tam dayanır  (${hardTurn.p26} %)`);

  // And the old numbers explain themselves: base 25 with a 0.2 error put the
  // inner wheel at 25 × (1 − 0.17) = 20.8 %, under the threshold.
  const old = run(road(0.2), { stall: 0, base: 25, hard: 2 }).out;
  ok(old.p26 < 22,
     `ölü zona nəzərə alınmasa köhnə davranış geri qayıdır  (${old.p26} % < 22 %)`);
}

console.log('\nYoldan çox uzaqda: sürət minimuma, üzü yola');
{
  const cfg = { stall: 0, hard: 0.6, crawl: 10, base: 40 };
  const r = run(road(0.9), cfg).out;
  ok(r.recover, 'geri qayıtma rejimi işə düşür');
  ok(r.steer === 1, `sükan tam sağa  (${r.steer})`);
  ok(r.p26 === 0, `daxili təkər dayanır — yerində çevrilir  (${r.p26})`);
  ok(r.p25 > 0, `xarici təkər sürünür  (${r.p25})`);
  near(r.speed, 10, 0.5, 'sürət «crawl»-a düşür');
  ok(/çox sağda/.test(r.reason), `səbəb: ${r.reason}`);

  const l = run(road(-0.9), cfg).out;
  ok(l.steer === -1 && l.p25 === 0 && l.p26 > 0, `sola simmetrikdir  (${l.p25}/${l.p26})`);

  // It has to be much slower than an ordinary bend, not just a bit.
  const bend = run(road(0.45), cfg).out;
  ok(r.speed < bend.speed * 0.75,
     `adi döngədən xeyli yavaş  (${r.speed} < ${bend.speed})`);
}

console.log('\nGeri qayıtma rejimi titrəmir');
{
  const cfg = { stall: 0, hard: 0.6, crawl: 10, base: 40 };
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
