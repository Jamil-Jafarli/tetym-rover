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
const { PILOT_DEFAULTS, pilotState, pilotStep, metresPerSecond, lift,
        SPEED_DEFAULTS, speedState, speedStep } =
  new Function(`${src}
    return { PILOT_DEFAULTS, pilotState, pilotStep, metresPerSecond, lift,
             SPEED_DEFAULTS, speedState, speedStep };`)();

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

  const a = pilotStep(st, lost, NOSTALL, t + DT);
  ok(a.lost, 'itki qeyd olunur');
  ok(Math.abs(a.steer - steer) < 1e-9, `sükan saxlanılır  (${a.steer})`);
  ok(a.speed < before, `sürət azalır  (${before} → ${a.speed})`);
  ok(!a.stop, 'hələ ENABLE düşmür');

  // ... through the hold window ...
  let out = a, tt = t + DT;
  for (let i = 0; i < 12; i++) { tt += DT; out = pilotStep(st, lost, NOSTALL, tt); }
  ok(tt - t > PILOT_DEFAULTS.hold, `${tt - t} ms sonra hold pəncərəsi bitib`);
  ok(out.speed === 0, `dayanıb  (${out.speed} %)`);
  ok(!out.stop, 'amma hələ ENABLE saxlanır — yol qayıda bilər');

  // ... and past the grace period it gives up.
  for (let i = 0; i < 40; i++) { tt += DT; out = pilotStep(st, lost, NOSTALL, tt); }
  ok(out.stop, `${tt - t} ms sonra ENABLE-nin düşməsini istəyir`);
  ok(out.reason === 'yol yok — durdu', `səbəb: ${out.reason}`);
}

console.log('\nYol qayıdanda özü davam edir');
{
  const { st, t } = run(road(0));
  let tt = t, out = null;
  for (let i = 0; i < 8; i++) { tt += DT; out = pilotStep(st, lost, NOSTALL, tt); }
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

console.log('\nHər təkərin öz ölü zonası və öz düzəlişi');
{
  // Two motors are never the same motor: one starts at 1.5 V, the other at
  // 1.6 V. One shared number cannot be right for both.
  const r = run(road(0), { stall: 22, stall25: 22, stall26: 29, base: 20 }).out;
  ok(r.p26 > r.p25, `ağır təkərə daha çox verilir  (${r.p25} / ${r.p26})`);
  ok(r.p25 >= 22 && r.p26 >= 29, 'hər ikisi öz həddinin üstündədir');

  // Fall back to the shared number when a wheel has none of its own.
  const d = run(road(0), { stall: 25, base: 20 }).out;
  ok(d.p25 === d.p26, `ayrıca verilməyibsə ümumi hədd işləyir  (${d.p25})`);
  const half = run(road(0), { stall: 25, stall25: 40, base: 20 }).out;
  ok(half.p25 > half.p26, `yalnız biri verilsə, yalnız o dəyişir  (${half.p25} / ${half.p26})`);

  // Gain is the last trim: same volts, still faster, so take it down.
  const g = run(road(0), { stall: 0, base: 40, gain26: 0.8 }).out;
  near(g.p26, g.p25 * 0.8, 0.2, 'gain tələbi miqyaslayır');
  const g0 = run(road(0), { stall: 0, base: 40 }).out;
  ok(g0.p25 === g0.p26, 'düzəliş verilməyibsə heç nə dəyişmir');

  // A stopped wheel must stay stopped whatever the trim says.
  const stop = run(road(0.95), { stall: 22, stall26: 30, base: 20 }).out;
  ok(stop.p26 === 0, `tam sükanda daxili təkər yenə tam dayanır  (${stop.p26})`);
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
