/**
 * Sonar checks — the obstacle state machine and the 360° map.
 *
 * Both are pure functions, so the sensor can be made to behave in exactly the
 * ways a real HC-SR04 misbehaves: dropouts, single bad readings, a target
 * sitting right on the threshold, and someone stepping half out of the way.
 *
 *   node test/test_sonar.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'sonar.js'), 'utf8');
const { OBSTACLE_DEFAULTS, valid, obstacleState, obstacleStep,
        scanAngle, scanMap, spinPeriod } =
  new Function(`${src}
    return { OBSTACLE_DEFAULTS, valid, obstacleState, obstacleStep,
             scanAngle, scanMap, spinPeriod };`)();

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}  (${a} ≈ ${b})`);

const DT = 100;                                   // the pages poll at 10 Hz
const CFG = { stopCm: 25, clearCm: 35, confirm: 3, waitMs: 1200 };

/** Feed a list of readings and return every step, so a whole episode is visible. */
function feed(st, readings, cfg = CFG, t0 = 0) {
  const out = [];
  let t = t0;
  for (const cm of readings) { t += DT; out.push(obstacleStep(st, cm, cfg, t)); }
  return out;
}
const rep = (cm, n) => new Array(n).fill(cm);

console.log('\nOxunuş etibarlıdır, ya deyil — üçüncü variant yoxdur');
{
  ok(valid(50) === 50, 'normal məsafə');
  ok(valid(0) === null, '0 sm — HC-SR04 bunu ayırd edə bilmir');
  ok(valid(1) === null, '2 sm-dən aşağı etibarsızdır');
  ok(valid(401) === null, '4 m-dən uzaq — əks-səda qayıtmır');
  ok(valid(null) === null && valid(undefined) === null && valid('x') === null,
     'yoxluq və zibil də null');
  ok(valid(400) === 400 && valid(2) === 2, 'sərhədlər özləri etibarlıdır');
}

console.log('\nAçıq yolda sürür');
{
  const st = obstacleState(0);
  const r = feed(st, rep(120, 10));
  ok(r.every((x) => !x.blocked), 'heç bir kadrda dayanmır');
  ok(r[9].phase === 'go' && /açıq/.test(r[9].reason), `səbəb: ${r[9].reason}`);
}

console.log('\nManeə: bir oxunuş yox, üç oxunuş dayandırır');
{
  const st = obstacleState(0);
  // One stray 12 cm in the middle of a corridor is noise, not a wall.
  const r = feed(st, [120, 120, 12, 120, 120]);
  ok(!r[2].blocked, 'tək oxunuş dayandırmır');
  ok(r[4].phase === 'go', 'və rejim dəyişmir');

  const st2 = obstacleState(0);
  const s = feed(st2, [120, 12, 12, 12, 12]);
  ok(!s[1].blocked && !s[2].blocked, 'iki oxunuş hələ kifayət etmir');
  ok(s[3].blocked && s[3].phase === 'stop', `üçüncüdə dayanır  (${s[3].reason})`);
  ok(/12 sm/.test(s[3].reason), 'səbəb məsafəni deyir');
}

console.log('\nHədd üstündə titrəmir');
{
  // 25 stops, 35 clears. Everything between changes nothing — which is what
  // stops a robot parked at 30 cm from buzzing.
  const st = obstacleState(0);
  feed(st, rep(12, 5));                             // firmly blocked
  const r = feed(st, rep(30, 20), CFG, 1000);       // in the gap
  ok(r.every((x) => x.blocked), '30 sm-də dayanmış qalır — açılmış saymır');
  ok(r[19].phase === 'stop', `hələ «stop»  (${r[19].phase})`);
}

console.log('\nKeçəndən sonra dərhal yox, gecikmə ilə davam edir');
{
  const st = obstacleState(0);
  feed(st, rep(12, 5));                             // blocked
  const r = feed(st, rep(120, 3), CFG, 1000);       // it walks away
  ok(r[2].phase === 'wait', `yol açılan kimi «wait»-ə keçir  (${r[2].phase})`);
  ok(r[2].blocked, 'amma hələ hərəkət yoxdur');
  ok(r[2].waitLeft > 0 && r[2].waitLeft <= 1200, `qalan gözləmə ${r[2].waitLeft} ms`);
  ok(/gözləyir/.test(r[2].reason), `səbəb: ${r[2].reason}`);

  // …and after the window it goes.
  const more = feed(st, rep(120, 14), CFG, 1300);
  const went = more.findIndex((x) => x.phase === 'go');
  ok(went >= 0, `${(went + 1) * DT} ms sonra yola düşür`);
  ok(more[more.length - 1].phase === 'go' && !more[more.length - 1].blocked,
     'sonda normal sürür');
}

console.log('\nAyağını çəkməyən adam: gözləmə vaxtı yenidən bağlanır');
{
  const st = obstacleState(0);
  feed(st, rep(12, 5));                             // blocked
  feed(st, rep(120, 3), CFG, 1000);                 // seems clear
  ok(st.phase === 'wait', 'gözləyir');
  // Back it comes, half a second in.
  const r = feed(st, rep(12, 3), CFG, 1400);
  ok(r[2].phase === 'stop', `yenidən tam dayanır, gözləmə sıfırlanır  (${r[2].phase})`);
  // And the full wait has to run again from the new clearance.
  const c = feed(st, rep(120, 3), CFG, 2000);
  ok(c[2].waitLeft > 1000, `gözləmə yenidən başdan  (${c[2].waitLeft} ms)`);
}

console.log('\nƏks-səda gəlmirsə: «açıq» yox, «məlumat yoxdur»');
{
  // Driving along, the sensor drops out: keep going, nothing has been learned.
  const st = obstacleState(0);
  feed(st, rep(120, 4));
  const r = feed(st, [null, null, null], CFG, 1000);
  ok(!r[2].blocked && r[2].phase === 'go', 'gedirdisə gedir');
  ok(r[2].cm === null && /əks-səda yoxdur/.test(r[2].reason), `səbəb: ${r[2].reason}`);

  // Stopped in front of something soft, the echo dies. That must NOT read as
  // "the way is clear" — this is the reading that would drive into a sofa.
  const st2 = obstacleState(0);
  feed(st2, rep(12, 5));
  const s = feed(st2, [null, null, null, null, null], CFG, 1000);
  ok(s.every((x) => x.blocked), 'dayanmışdısa dayanmış qalır');
  ok(s[4].phase === 'stop', `«stop» qalır  (${s[4].phase})`);
  ok(/yerində qalır/.test(s[4].reason), `səbəb: ${s[4].reason}`);
}

console.log('\nBucaq: fasiləsiz servo vaxtdan hesablanır');
{
  ok(scanAngle(0, 2400) === 0, 'dövrün başı 0°');
  near(scanAngle(600, 2400), 90, 1e-9, 'dörddə bir → 90°');
  near(scanAngle(1200, 2400), 180, 1e-9, 'yarı → 180°');
  near(scanAngle(2400, 2400), 0, 1e-9, 'tam dövr → yenə 0°');
  near(scanAngle(3000, 2400), 90, 1e-9, 'ikinci dövr də düzgün sarılır');
  near(scanAngle(600, 2400, 45), 135, 1e-9, 'başlanğıc bucağı sürüşdürür');
  near(scanAngle(600, 2400, -180), 270, 1e-9, 'mənfi sürüşmə də müsbətə çevrilir');
  ok(scanAngle(600, 0) === null, 'kalibrasiya yoxdursa bucaq da yoxdur');
  ok(scanAngle(600, null) === null, '…və xəritə çəkilmir');

  ok(spinPeriod(24, 10) === 2400, 'on dövr 24 s → 2400 ms');
  ok(spinPeriod(0, 10) === null && spinPeriod(24, 0) === null, 'yarımçıq ölçü null');
}

console.log('\nXəritə: bucaqlara bölünür, ən yaxın saxlanılır');
{
  const samples = [];
  for (let a = 0; a < 360; a += 2) samples.push({ ang: a, cm: 100 });
  const m = scanMap(samples, 6);
  ok(m.bins.length === 60, `60 bölmə  (${m.bins.length})`);
  ok(m.covered === 1, 'tam dairə örtülüb');
  ok(m.points.every((p) => p.cm === 100), 'hamısı 100 sm');

  // A doorway: the near frame and the far room in the same bin. The mean would
  // invent a wall halfway; the nearest is at least something that was there.
  const door = scanMap([{ ang: 10, cm: 40 }, { ang: 11, cm: 380 }], 6);
  ok(door.points[0].cm === 40, `qapı çərçivəsi saxlanılır, orta götürülmür  (${door.points[0].cm})`);

  // Junk in, nothing out.
  const junk = scanMap([{ ang: 10, cm: 0 }, { ang: 20, cm: 900 },
                        { ang: null, cm: 50 }, { ang: 30, cm: null }], 6);
  ok(junk.hits === 0 && junk.points.length === 0, 'etibarsız oxunuşlar xəritəyə düşmür');
  ok(junk.nearest === null, 'ən yaxın nöqtə də yoxdur');

  const part = scanMap([{ ang: 0, cm: 50 }, { ang: 90, cm: 70 }], 6);
  ok(part.covered < 0.05, `yarımçıq skan yarımçıq görünür  (${part.covered})`);
  ok(part.nearest.cm === 50 && part.nearest.ang === 3,
     `ən yaxın: ${part.nearest.cm} sm @ ${part.nearest.ang}°`);
  ok(scanMap([], 6).hits === 0 && scanMap(null, 6).hits === 0,
     'boş və null skan çökmür');
}

console.log('\nBucaq 360-ı keçəndə sarılır');
{
  // 359° and −1° are the same direction and must share a bin; 361° is 1°, which
  // is a different one. Wrapping has to be arithmetic, not a special case.
  const m = scanMap([{ ang: 359, cm: 30 }, { ang: 361, cm: 40 }, { ang: -1, cm: 20 }], 6);
  ok(m.hits === 3, 'hər üçü qəbul olunur');
  ok(m.points.length === 2, `iki ayrı istiqamət  (${m.points.length})`);
  ok(m.bins[59].cm === 20, `359° və −1° eyni bölmə, ən yaxını qalır  (${m.bins[59].cm} sm)`);
  ok(m.bins[0].cm === 40, `361° isə 1°-dir, ayrı bölmə  (${m.bins[0].cm} sm)`);
  ok(m.nearest.cm === 20, `ən yaxın: ${m.nearest.cm} sm`);
}

console.log(`\n${fail ? 'FAILED' : 'ALL CHECKS PASSED'} — ${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
