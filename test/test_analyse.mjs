/**
 * Log analysis checks — what /tune tells you after a lap.
 *
 * The runs below are synthetic and each one has exactly one thing wrong with
 * it, because the whole value of this file is that a finding points at one
 * cause. A analyser that says "try lowering everything" is a horoscope.
 *
 *   node test/test_analyse.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'analyse.js'), 'utf8');
const { analyse, metrics, segments, calibrate } =
  new Function(`${src}
    return { analyse, metrics, segments, calibrate };`)();

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}  (${a} ≈ ${b})`);

const DT = 100;                                  // the page logs at 10 Hz
const has = (r, title) => r.findings.some((f) => f.title === title);

/** Build a run from a function of the frame index. */
function run(n, f, pilot = { base: 34, kP: 0.85, kD: 0.12, curve: 0.75 }) {
  const rows = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const r = { t: i * DT, ...f(i) };
    r.speed = r.speed ?? 30;
    r.err = r.err ?? 0;
    r.far = r.far ?? r.err;
    r.steer = r.steer ?? 0;
    r.lost = r.lost ?? false;
    dist += (r.speed / 100) * 0.5 * (DT / 1000);   // an arbitrary but steady model
    r.dist = +dist.toFixed(3);
    rows.push(r);
  }
  return { started: 'x', pilot, rows };
}

console.log('\nPis fayl gözəlliklə rədd olunur');
{
  ok(analyse(null).ok === false, 'null → xəta, çökmə yox');
  ok(analyse({}).ok === false, '«rows» yoxdursa xəta');
  ok(analyse({ rows: [] }).ok === false, 'boş qeyd');
  ok(/rows/.test(analyse({}).error), `xəta mətni səbəbi deyir: ${analyse({}).error}`);
}

console.log('\nSakit dövrə: heç nə pis deyil, sürət ehtiyatı var');
{
  const r = analyse(run(400, (i) => ({ err: 0.05 * Math.sin(i / 40), speed: 30 })));
  ok(r.ok, 'oxundu');
  ok(has(r, 'Hız payı var'), 'sürəti qaldırmağı təklif edir');
  ok(r.suggest.base > 34, `yeni base ${r.suggest.base} > 34`);
  ok(!has(r, 'Düz yolda salınıyor'), 'yırğalanma iddiası yoxdur');
  ok(r.suggest.kP === undefined, 'kP-yə toxunmur — səbəb yoxdur');
}

console.log('\nYırğalanma → kP azalır');
{
  // Crossing the centre every ~3 frames: a controller fighting itself.
  const r = analyse(run(400, (i) => ({ err: 0.3 * Math.sin(i / 1.2), steer: 0.3 })));
  ok(has(r, 'Düz yolda salınıyor'), 'yırğalanmanı tutur');
  ok(r.metrics.wobble > 1.5, `saniyədə ${r.metrics.wobble} kəsişmə`);
  ok(r.suggest.kP < 0.85, `kP ${r.suggest.kP} < 0.85`);
  ok(r.suggest.base === undefined, 'eyni anda «sürəti qaldır» demir');
}

console.log('\nAğır, gec düzəliş → kP artır');
{
  const r = analyse(run(400, () => ({ err: 0.35, far: 0.05, steer: 0.3 })));
  ok(has(r, 'Yavaş düzeliyor'), 'daimi sapmanı tutur');
  ok(r.suggest.kP > 0.85, `kP ${r.suggest.kP} > 0.85`);
}

console.log('\nSükan dirənirsə döngədə daha çox yavaşla');
{
  const r = analyse(run(400, (i) => ({
    err: i % 2 ? 0.8 : 0.75, far: 0.8, steer: 1, speed: 40 })));
  ok(has(r, 'Direksiyon dayanağa dayanıyor'), 'doymanı tutur');
  ok(r.suggest.curve > 0.75, `curve ${r.suggest.curve} > 0.75`);
}

console.log('\nYol itirsə sürəti azalt');
{
  const r = analyse(run(600, (i) => {
    const lost = (i % 100) > 92;                 // six short dropouts
    return { err: lost ? 0 : 0.1, lost, speed: lost ? 10 : 40 };
  }));
  ok(has(r, 'Yolu kaybediyor'), 'itkiləri tutur');
  ok(r.metrics.lost_events === 6, `${r.metrics.lost_events} ayrı itki`);
  ok(r.suggest.base < 34, `base ${r.suggest.base} < 34`);
  ok(!has(r, 'Hız payı var'), 'yol itirən dövrədə «sürəti qaldır» demir');
}

console.log('\nDöngəyə gec girmək → kD artır');
{
  // The road ahead has swung out but the near end has been let go with it.
  const r = analyse(run(400, () => ({ err: 0.6, far: 0.7, steer: 0.5, speed: 25 })));
  ok(has(r, 'Viraja geç tepki'), 'gecikməni tutur');
  ok(r.suggest.kD > 0.12, `kD ${r.suggest.kD} > 0.12`);
}

console.log('\nHər tapıntı bir səbəb, bir rəqəm göstərir');
{
  const r = analyse(run(400, (i) => ({ err: 0.3 * Math.sin(i / 1.2), steer: 0.3 })));
  for (const f of r.findings) {
    ok(typeof f.title === 'string' && typeof f.detail === 'string',
       `«${f.title}» izah edilir`);
    if (f.fix) ok(Object.keys(f.fix).length === 1,
       `«${f.title}» yalnız bir parametr dəyişir (${Object.keys(f.fix)})`);
  }
}

console.log('\nÇox qısa qeydə rəy verilmir');
{
  const r = analyse(run(5, () => ({ err: 0.9, steer: 1 })));
  ok(has(r, 'Kayıt çok kısa'), 'qısa olduğunu deyir');
  ok(Object.keys(r.suggest).length === 0, '5 sətirdən nəticə çıxarmır');
}

console.log('\nHərəkətlər: düz / sağ / sol / itki');
{
  const rows = [];
  const push = (n, o) => { for (let i = 0; i < n; i++) rows.push({ t: rows.length * DT, speed: 30, err: 0, far: 0, lost: false, dist: rows.length * 0.02, ...o }); };
  push(20, { steer: 0 });                    // straight
  push(15, { steer: 0.5 });                  // right
  push(20, { steer: 0 });                    // straight
  push(15, { steer: -0.6 });                 // left
  push(5,  { steer: 0, lost: true });        // lost it
  const segs = segments(rows);
  ok(segs.length === 5, `beş hissə tapıldı (${segs.map((s) => s.kind).join(', ')})`);
  ok(segs[1].kind === 'sağ viraj' && segs[3].kind === 'sol viraj',
     'sağ və sol düzgün ayrılır');
  ok(segs[4].kind === 'kayıp', 'itki ayrıca hissədir');
  near(segs[1].dur_s, 1.5, 0.11, 'sağ döngənin müddəti');
  ok(segs[3].peak_steer === 0.6, `sol döngənin ən kəskin nöqtəsi ${segs[3].peak_steer}`);
  ok(segs.every((s) => s.dist_m !== null), 'hər hissə üçün məsafə var');
}
{
  // One stray frame is a sample, not a manoeuvre.
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ t: i * DT, speed: 30, err: 0, far: 0, lost: false,
                steer: i === 20 ? 0.9 : 0 });
  }
  ok(segments(rows).length === 1,
     `tək kadrlıq sıçrayış ayrıca döngə sayılmır (${segments(rows).length} hissə)`);
}

console.log('\nÖlü zona: köhnə qeydlər özünü izah edir');
{
  // The real logs: base 25, so the outer wheel sat at 25 % (1.575 V) and the
  // inner one dropped under 22 % (1.5 V) as soon as the steer passed 0.13.
  const old = run(300, () => ({ err: 0.2, far: 0.2, steer: 0.17, speed: 25,
                                p25: 25, p26: 20.8 }),
                  { base: 25, kP: 0.85, stall: 22 });
  const r = analyse(old);
  ok(r.metrics.dead_frac >= 0.45,
     `təkər əmrlərinin ${Math.round(r.metrics.dead_frac * 100)} %-i ölü zonada`);
  ok(has(r, 'İç teker ölü bölgede kalıyor'), 'ölü zonanı ayrıca deyir');
  ok(!has(r, 'Hız payı var'),
     'ölü zonada qalan dövrəyə «sürəti qaldır» demir');

  // Both wheels under the threshold: the robot was not driving at all.
  const dead = run(300, () => ({ err: 0.1, speed: 18, p25: 18, p26: 15 }),
                   { base: 18, stall: 22 });
  const d = analyse(dead);
  ok(has(d, 'Tekerler hiç dönmüyordu'), 'heç tərpənmədiyini tutur');
  ok(d.suggest.base > 18, `sürəti qaldırmağı təklif edir → ${d.suggest.base}`);

  // With the dead band compensated there is nothing to report.
  const good = run(300, () => ({ err: 0.05, speed: 18, p25: 36, p26: 34 }),
                   { base: 18, stall: 22 });
  const g = analyse(good);
  ok(g.metrics.dead_frac === 0, 'kompensasiyadan sonra ölü zona qalmır');
  ok(!has(g, 'İç teker ölü bölgede kalıyor'), 'şikayət yoxdur');
}

console.log('\nYoldan uzaqlaşma sayılır');
{
  const r = analyse(run(400, (i) => {
    const off = (i % 100) > 80;
    return { err: off ? 0.8 : 0.1, far: off ? 0.8 : 0.1, steer: off ? 1 : 0.1,
             speed: off ? 10 : 20, reason: off ? 'yol çox sağda — çevrilir' : 'düz yol' };
  }));
  ok(r.metrics.recover_events === 4, `${r.metrics.recover_events} dəfə çevrilib`);
  ok(has(r, 'Yoldan uzaklaşıyor'), 'ayrıca tapıntı kimi göstərir');
}

console.log('\n90° köşələr itki kimi sayılmır');
{
  // Four corners on a lap. Each one takes the chain with it for a moment —
  // that is what a right angle looks like from the camera — and the pilot
  // drives through it on purpose. Counting those frames as "lost the road"
  // would have the analyser recommend slowing down on the straights because
  // the robot successfully took its corners.
  const r = analyse(run(600, (i) => {
    const turning = (i % 150) > 130;
    return { err: turning ? null : 0.08, lost: turning, turn: turning ? 1 : 0,
             steer: turning ? 1 : 0.05, speed: turning ? 10 : 40,
             reason: turning ? 'köşe — sağa dönüyor' : 'düz yol' };
  }));
  ok(r.metrics.corner_events === 4, `${r.metrics.corner_events} köşə sayıldı`);
  ok(r.metrics.lost_events === 0, `heç bir köşə itki kimi yazılmadı  (${r.metrics.lost_events})`);
  ok(!has(r, 'Yolu kaybediyor'), '«yolu kaybediyor» tapıntısı yoxdur');
  ok(has(r, '90° köşe'), 'köşələr ayrıca tapıntı kimi göstərilir');
  ok(r.metrics.corner_failed === 0, 'hamısında yol yenidən qarşıya çıxdı');
}
{
  // A turn that ends with the road still missing is the corner handling
  // failing, and is a different fault from never having seen the corner.
  const rows = [];
  const push = (n, o) => { for (let i = 0; i < n; i++)
    rows.push({ t: rows.length * DT, speed: 20, err: 0, far: 0, steer: 0,
                lost: false, turn: 0, dist: rows.length * 0.02, ...o }); };
  push(40, {});                                        // following
  push(20, { lost: true, turn: 1, err: null });        // a corner, taken
  push(40, {});                                        // road picked up again
  push(20, { lost: true, turn: -1, err: null });       // a corner, given up on
  push(20, { lost: true, err: null });                 // …still nothing
  const m = metrics(rows);
  ok(m.corner_events === 2, `iki köşəyə girildi  (${m.corner_events})`);
  ok(m.corner_failed === 1, `biri yarımçıq qaldı  (${m.corner_failed})`);
  const segs = segments(rows);
  ok(segs.map(s => s.kind).join(',') === 'düz,90° sağa,düz,90° sola,kayıp',
     `hərəkətlər ayrı-ayrı görünür  (${segs.map(s => s.kind).join(', ')})`);
}
{
  // Logs recorded before any of this exists have no `turn` field. They must
  // read exactly as they always did.
  const old = run(300, (i) => {
    const lost = (i % 100) > 92;
    return { err: lost ? 0 : 0.1, lost, speed: lost ? 10 : 40 };
  });
  const m = metrics(old.rows);
  ok(m.corner_events === 0 && m.lost_events === 3,
     `köhnə qeyd dəyişmir  (${m.lost_events} itki, ${m.corner_events} köşə)`);
}

console.log('\nMəsafə kalibrasiyası: lentlə ölçdüyün rəqəmdən');
{
  // 40 s at exactly 50 %, and the lap was 12 m.
  const r = run(400, () => ({ speed: 50 }));
  const c = calibrate(r.rows, 12);
  near(c.pct, 50, 0.6, 'orta faiz sürət profilindən çıxır');
  near(c.seconds, 39.9, 0.2, 'müddət qeyddən gəlir');
  ok(c.metres === 12, 'ölçdüyün məsafə olduğu kimi saxlanır');
  near(c.mps_at_100, 0.6, 0.02, '100 %-də m/s hesablanır');

  // The same lap driven at half the throttle must give the same constant per
  // percent — that is the whole claim the model makes.
  const slow = run(800, () => ({ speed: 25 }));
  const c2 = calibrate(slow.rows, 12);
  near(c2.mps_at_100, (12 / 79.9) * 4, 0.05, 'faiz başına sabit eyni məntiqlə çıxır');

  ok(calibrate(r.rows, 0) === null, 'məsafə verilməyibsə kalibrasiya yoxdur');
  ok(calibrate([{ t: 0, speed: 0 }, { t: 100, speed: 0 }], 5) === null,
     'tərpənməyibsə kalibrasiya yoxdur');
  ok(analyse(r).calib === null, 'məsafə soruşulmayıbsa analiz də vermir');
  ok(analyse(r, 12).calib.metres === 12, 'verilibsə analizin içindədir');
  // A log with no `pilot.stall` field is read as having no dead band at all
  // now — steppers do not have one — rather than guessing the old ESP32
  // threshold (22 %).
  ok(analyse(r, 12).calib.dead === 0,
     'stall sahəsi olmayan qeyd ölü zonasız oxunur');

  // What reached the pin is what the wheel responded to, so that is what the
  // constant is built from — not the demand behind it.
  const withPins = run(400, () => ({ speed: 20, p25: 60, p26: 60 }));
  const c3 = calibrate(withPins.rows, 12);
  near(c3.pct, 60, 0.6, 'pinə gedən faiz əsas götürülür, tələb yox');
}

console.log(`\n${fail ? 'FAILED' : 'ALL CHECKS PASSED'} — ${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
