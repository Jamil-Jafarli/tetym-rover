/**
 * Sonar checks — the obstacle state machine.
 *
 * It is a pure function, so the sensor can be made to behave in exactly the
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
const { OBSTACLE_DEFAULTS, valid, obstacleState, obstacleStep } =
  new Function(`${src}
    return { OBSTACLE_DEFAULTS, valid, obstacleState, obstacleStep };`)();

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };

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
  ok(r[9].phase === 'go' && /açık/.test(r[9].reason), `səbəb: ${r[9].reason}`);
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
  ok(/bekliyor/.test(r[2].reason), `səbəb: ${r[2].reason}`);

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
  ok(r[2].cm === null && /yankı yok/.test(r[2].reason), `səbəb: ${r[2].reason}`);

  // Stopped in front of something soft, the echo dies. That must NOT read as
  // "the way is clear" — this is the reading that would drive into a sofa.
  const st2 = obstacleState(0);
  feed(st2, rep(12, 5));
  const s = feed(st2, [null, null, null, null, null], CFG, 1000);
  ok(s.every((x) => x.blocked), 'dayanmışdısa dayanmış qalır');
  ok(s[4].phase === 'stop', `«stop» qalır  (${s[4].phase})`);
  ok(/yerinde kalıyor/.test(s[4].reason), `səbəb: ${s[4].reason}`);
}

console.log(`\n${fail ? 'FAILED' : 'ALL CHECKS PASSED'} — ${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
