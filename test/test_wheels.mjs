/**
 * The shared wheel trim.
 *
 * The thing worth protecting here is not the arithmetic — it is the agreement
 * between pages. If /manual maps a demand to a pin differently from /follow,
 * then every number measured on /manual is measured on a robot that does not
 * exist, and the tuning session is wasted. So the interesting checks below are
 * the ones that compare wheels.js against pilot.js directly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f, names) => new Function(`${readFileSync(path.join(HERE, '..', 'public', f), 'utf8')}
  return { ${names} };`)();

const { wheelsOf, wheelThreshold, wheelPin, wheelVolts, wheelsMeasured,
        wheelsSteps, wheelsSummary, INFO, infoHtml, WHEELS_CSS } =
  load('wheels.js', 'wheelsOf, wheelThreshold, wheelPin, wheelVolts, wheelsMeasured, '
     + 'wheelsSteps, wheelsSummary, INFO, infoHtml, WHEELS_CSS');

const { PILOT_DEFAULTS, pilotState, pilotStep } =
  load('pilot.js', 'PILOT_DEFAULTS, pilotState, pilotStep');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };
const near = (a, b, tol, m) =>
  ok(Math.abs(a - b) <= tol, `${m}  (${Math.round(a * 100) / 100} ≈ ${b})`);

console.log('\nAyarları oxumaq: hansı formada gəlsə də');
{
  const trim = { stall: 20, stall25: 24, stall26: 21, gain25: 0.9, gain26: 1 };
  const bare = wheelsOf(trim);
  const nested = wheelsOf({ pilot: trim, camera: {} });
  ok(JSON.stringify(bare) === JSON.stringify(nested),
     'follow_cfg da, onun pilot yarısı da eyni nəticə verir');
  ok(JSON.stringify(wheelsOf(null)) === JSON.stringify(wheelsOf({})),
     'null da boş obyekt kimi');
  ok(wheelsOf({}).stall === 22 && wheelsOf({}).gain25 === 1,
     'heç nə gəlməsə standart dəyərlər');
}

console.log('\nSıfır «ölçülməyib» deməkdir, «hədd sıfırdır» yox');
{
  // The whole dead-band compensation is undone by a threshold of zero, and the
  // sliders bottom out at 0, so the two have to be told apart. Number(null) is
  // 0 and Number.isFinite(0) is true, which is exactly how this goes wrong.
  ok(wheelsOf({ stall25: 0 }).stall25 === null, 'sürgü 0-dadırsa — təyin edilməyib');
  ok(wheelsOf({ stall25: null }).stall25 === null, 'null — təyin edilməyib');
  ok(wheelsOf({ stall25: '' }).stall25 === null, 'boş sətir — təyin edilməyib');
  ok(wheelsOf({ stall25: 24 }).stall25 === 24, 'rəqəm gələndə saxlanır');
  ok(wheelThreshold(25, { stall: 22, stall25: 0 }) === 22, 'təyin edilməyibsə ümumi hədd');
  ok(wheelThreshold(25, { stall: 22, stall25: 26 }) === 26, 'təyin edilibsə öz həddi');
  ok(wheelThreshold(26, { stall: 22, stall25: 26 }) === 22, 'GPIO25-in həddi GPIO26-ya keçmir');
}

console.log('\nAyarlar həddi keçmir');
{
  ok(wheelsOf({ gain25: 9 }).gain25 === 1.5, `güc tavanda saxlanır  (${wheelsOf({ gain25: 9 }).gain25})`);
  ok(wheelsOf({ gain25: 0.1 }).gain25 === 0.5, 'güc döşəmədə saxlanır');
  ok(wheelsOf({ stall: 500 }).stall === 99, 'hədd 99-u keçmir — 100 heç vaxt dönməzdi');
  ok(wheelsOf({ gain25: 'abc' }).gain25 === 1, 'zibil rəqəm standarta düşür');
  ok(wheelsOf({ swap: 1 }).swap === true, 'swap boolean-a çevrilir');
}

console.log('\nSəhifələr eyni robotu sürür');
{
  // /manual sends wheelPin(); /follow sends pilotStep(). They have to agree,
  // or a threshold measured by hand on one page is a fiction on the other.
  const trim = { stall: 20, stall25: 26, stall26: 19, gain25: 0.9, gain26: 1.1 };
  const cfg = { ...PILOT_DEFAULTS, ...trim, base: 40, max: 100, kP: 0, kD: 0,
                curve: 0, short: 0, accel: 1e6, brake: 1e6 };
  const st = pilotState(0);
  // Dead straight, so both wheels get the full demand and nothing is steered.
  let out;
  for (let i = 0; i < 5; i++) out = pilotStep(st, { near: 0, far: 0, bands: 8, want: 8 }, cfg, (i + 1) * 50);

  near(out.p25, wheelPin(out.speed, 25, trim), 0.11, 'GPIO25: pilot və manual eyni faizi verir');
  near(out.p26, wheelPin(out.speed, 26, trim), 0.11, 'GPIO26: pilot və manual eyni faizi verir');

  for (const d of [0, 1, 12.5, 50, 99, 100]) {
    const a = wheelPin(d, 25, trim);
    ok(a >= 0 && a <= 100, `tələb ${d} → ${a} % (0-100 arasında)`);
  }
}

console.log('\nÖlü zonanın mənası');
{
  const trim = { stall: 22, stall25: 30, stall26: 22 };
  ok(wheelPin(0, 25, trim) === 0, 'sıfır tələb sıfır qalır — dayanmaq mümkün olmalıdır');
  near(wheelPin(0.0001, 25, trim), 30, 0.05, 'ən kiçik tələb dərhal həddin üstünə qalxır');
  ok(wheelPin(100, 25, trim) === 100, 'tam tələb tam çıxış');
  ok(wheelPin(50, 25, trim) > wheelPin(50, 26, trim),
     'ağır təkərə eyni tələbdə daha çox verilir');

  // gain below 1 must not push a moving wheel under its threshold and stall it.
  const soft = wheelPin(10, 25, { stall: 22, stall25: 30, gain25: 0.5 });
  ok(soft >= 30, `güc azaldılsa da təkər hələ dönür  (${soft} % ≥ 30)`);
}

console.log('\nVolt oxunuşu');
{
  near(wheelVolts(100, 3.3), 3.3, 0.001, '100 % = tavan');
  near(wheelVolts(50, 3.3), 1.65, 0.001, 'yarı faiz yarı volt');
  near(wheelVolts(0, 3.3), 0, 0.001, '0 % = 0 V');
  near(wheelVolts(50, 5), 2.5, 0.001, 'başqa tavanda da düz');
  near(wheelVolts(50, null), 1.65, 0.001, 'tavan bilinmirsə 3.3 fərz edilir');
  near(wheelVolts(200, 3.3), 3.3, 0.001, '100-dən yuxarı tavanda kəsilir');
}

console.log('\nÖlçülüb, ya standart dəyərdir?');
{
  ok(!wheelsMeasured({}), 'boş ayar «ölçülməyib» sayılır');
  ok(!wheelsMeasured({ stall25: 24 }), 'yalnız biri ölçülübsə hələ tamam deyil');
  ok(wheelsMeasured({ stall25: 24, stall26: 21 }), 'hər ikisi ölçülübsə tamam');
}

console.log('\nYoxlama siyahısı');
{
  const empty = wheelsSteps({});
  ok(empty.length === 6, `altı addım  (${empty.length})`);
  ok(empty.every(s => s.n && s.title && s.what && s.then && s.why),
     'hər addımda: nə et, sonra nə yaz, niyə');
  ok(empty.map(s => s.n).join() === '1,2,3,4,5,6', 'ardıcıl nömrələnib');

  const g = empty.find(s => s.id === 'gain');
  ok(g.blocked === true, 'həddlər ölçülməyibsə güc addımı bağlıdır');
  const done = wheelsSteps({ stall25: 24, stall26: 21 });
  ok(done.find(s => s.id === 'stall25').done === true, 'ölçülən addım tamamlanmış görünür');
  ok(done.find(s => s.id === 'gain').blocked === false, 'həddlərdən sonra güc addımı açılır');
  ok(done.find(s => s.id === 'gain').done === false,
     'açılır, amma hələ tamamlanmayıb — 1.00 toxunulmamış deməkdir');
  ok(wheelsSteps({ stall25: 24, stall26: 21, gain25: 0.9 }).find(s => s.id === 'gain').done,
     'güc dəyişdirilibsə tamamlanmış sayılır');

  // Steps that only a person with a multimeter can confirm must not pretend to
  // know their own state — a green tick nobody earned is worse than no tick.
  ok(empty.filter(s => s.manual).every(s => s.done === null),
     'əl ilə yoxlanan addımlar özlərini tamamlanmış elan etmir');
}

console.log('\nZolaq mətni');
{
  const [a, b] = wheelsSummary({ stall: 22, stall25: 26, gain25: 0.92 });
  ok(/GPIO25/.test(a) && /26 %/.test(a) && /0\.92/.test(b === a ? a : a),
     `ölçülən dəyər göstərilir  (${a})`);
  ok(/\*/.test(b), `ölçülməyən dəyər ulduzla işarələnir  (${b})`);
  ok(!/\*/.test(a), 'ölçülən dəyərdə ulduz yoxdur');
}

console.log('\nİzah nişanları');
{
  const keys = Object.keys(INFO);
  ok(keys.length >= 12, `${keys.length} ayar izah olunub`);
  ok(keys.every(k => INFO[k].length >= 3),
     'hər izahda başlıq + ən azı iki sətir var');
  ok(keys.every(k => INFO[k].every(l => typeof l === 'string' && l.length > 0)),
     'boş sətir yoxdur');
  ok(/data-info="stall25"/.test(infoHtml('stall25')), 'nişan açarı markup-a düşür');
  ok(infoHtml('yoxdur') === '', 'tanınmayan açar boş qaytarır — səhv nişan çıxmır');
  ok(/\.itip/.test(WHEELS_CSS) && /\.wtrim/.test(WHEELS_CSS), 'CSS hər ikisini əhatə edir');
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
