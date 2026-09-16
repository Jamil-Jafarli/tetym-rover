/**
 * The cargo run's server half: the lift, the QR reader's key, and the taught
 * routes — recorded off the wire, kept on disk, and driven again.
 *
 * No board and no GPIO. The actuator is given a stand-in for pinctrl, the
 * routes a stand-in for the serial link — the tests assert on the pin writes
 * and the G-code lines that WOULD have gone out, in the order they would
 * have gone. Order is most of what can go wrong with both: a stop that lands
 * before the start it was meant to end, a direction set after the enable.
 *
 * The last part starts the real server (with --no-actuator, so the pins on the
 * machine running the tests are never touched) and checks the HTTP surface.
 *
 *   node test/test_cargo.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Actuator, actuatorCommand } from '../actuator.js';
import { QrReader, qrKey } from '../qr.js';
import { RouteRecorder, RouteBook, Replayer, parseMove, moveName, legSummary,
         typedStep, aggregate } from '../routes.js';
import { Rover } from '../rover.js';
import { Jogger, DIRECTIONS, DEFAULT_STEP_MM, HOLD_MARGIN_S } from '../marlin.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (${JSON.stringify(a)})`);

/** pinctrl, written down instead of run. Optionally slow and uneven. */
function pins({ jitter = 0, failOn = null } = {}) {
  const log = [];
  const set = async (pin, level) => {
    if (jitter) await sleep(Math.random() * jitter);
    if (failOn && failOn(pin, level)) throw new Error('pinctrl: boom');
    log.push(`${pin}=${level}`);
  };
  return { log, set };
}

// ── the lift ─────────────────────────────────────────────────────────

console.log('\nAktuator — GPIO10 başlat/dayan (aktiv aşağı), GPIO22 istiqamət');
{
  const p = pins();
  const a = new Actuator({ set: p.set });
  await a.init();
  eq(p.log, ['10=dh', '22=dh'], 'açılışda əvvəlcə DAYAN, sonra istiqamət');

  p.log.length = 0;
  await a.start();
  eq(p.log, ['22=dh', '10=dl'], 'başlat: əvvəl istiqamət, sonra enable (dl)');
  ok(a.status().running && a.status().dir === 'up', 'status: işləyir, yuxarı');

  p.log.length = 0;
  await a.stop();
  eq(p.log, ['10=dh'], 'dayan: GPIO10 dh');

  p.log.length = 0;
  await a.stop();
  eq(p.log, ['10=dh'], 'artıq dayanıbsa da dayan yazılır — dayan heç vaxt atlanmır');

  p.log.length = 0;
  await a.setDir('down');
  eq(p.log, ['22=dl'], 'dayanıqlıkən istiqamət: yalnız GPIO22 dl (aşağı)');

  p.log.length = 0;
  await a.start();
  const t0 = Date.now();
  await a.flip();
  const took = Date.now() - t0;
  eq(p.log, ['22=dl', '10=dl', '10=dh', '22=dh', '10=dl'],
     'işləyərkən E: dayan → gözlə → çevir → başlat');
  ok(took >= a.cfg.reversePauseMs - 5, `hərəkətdə tərsinə dönmə gözləyir (${took} ms)`);
  ok(a.status().running && a.status().dir === 'up', 'və yenə işləyir, bu dəfə yuxarı');
  await a.stop();
}

console.log('\nQ-E-Q tez basılanda əmrlər sırasını qoruyur');
{
  const p = pins({ jitter: 15 });
  const a = new Actuator({ set: p.set, reversePauseMs: 5 });
  a.toggle(); a.flip(); a.toggle();
  await a.settled();
  eq(p.log, ['22=dh', '10=dl', '10=dh', '22=dl', '10=dl', '10=dh'],
     'yavaş, qeyri-bərabər pinctrl ilə belə — dayan sonda gəlir');
  ok(!a.status().running, 'və son vəziyyət: dayanıb');
}

console.log('\nUzun işləmə kəsilir');
{
  const p = pins();
  const a = new Actuator({ set: p.set, maxRunMs: 60 });
  await a.start();
  await sleep(120);
  await a.settled();
  ok(!a.status().running && a.status().cut, `${a.cfg.maxRunMs} ms sonra kəsildi, cut=true`);
  ok(p.log[p.log.length - 1] === '10=dh', 'sonuncu yazı GPIO10 dh');
  await a.start();
  ok(!a.status().cut, 'yenidən başlatmaq cut-u təmizləyir');
  await a.stop();
}

console.log('\nQuru rejim və xətalar');
{
  const p = pins();
  const a = new Actuator({ set: p.set, enabled: false });
  await a.start('down');
  await a.stop();
  eq(p.log, [], '--no-actuator: heç bir pinə toxunulmur');
  ok(a.status().dry && a.status().writes.join(' ') === 'GPIO22=dl GPIO10=dl GPIO10=dh',
     `amma nə yazılacağı görünür (${a.status().writes.join(' ')})`);

  const bad = pins({ failOn: (pin, lvl) => pin === 10 && lvl === 'dl' });
  const b = new Actuator({ set: bad.set });
  await b.start();
  ok(/boom/.test(b.status().err || ''), `pinctrl xətası statusda: ${b.status().err}`);
  await b.stop();
  ok(bad.log.includes('10=dh'), 'xətadan sonra zəncir davam edir — dayan yenə yazılır');

  let threw = false;
  try { actuatorCommand(b, 'jump'); } catch { threw = true; }
  ok(threw, 'naməlum əmr rədd edilir');
  const s = actuatorCommand(b, 'start', 'down');
  ok(s.running && s.dir === 'down', 'actuatorCommand(start, down)');
  await b.stop();
}

// ── QR ───────────────────────────────────────────────────────────────

console.log('\nQR açarı — yazılış fərqi ALIM2-ni dəyişmir, ALIM3 isə ALIM2 deyil');
{
  eq(['ALIM2', 'Alım 2', 'alim-2', 'ALİM_2'].map(qrKey), ['ALIM2', 'ALIM2', 'ALIM2', 'ALIM2'],
     'böyük/kiçik, boşluq, tire, nöqtəli İ — hamısı eyni');
  ok(qrKey('ALIM3') !== qrKey('ALIM2'), 'ALIM3 ≠ ALIM2');

  let next = null;
  const r = new QrReader({ decode: () => next });
  const g = Buffer.alloc(4 * 3);
  ok(r.status().key === null, 'hələ oxunmayıb: key null');
  next = { data: 'Alım 2', location: null };
  r.feed(g, 4, 3, 1000);
  r.feed(g, 4, 3, 1300);
  const s = r.status(1400);
  ok(s.text === 'Alım 2' && s.key === 'ALIM2', `status həm mətni, həm açarı verir (${s.key})`);
  ok(s.count === 1, 'eyni kod iki kadrda — bir oxunuş');
  ok(s.seen_age_s === 0.1 && s.age_s === 0.4, `seen_age ${s.seen_age_s} s, age ${s.age_s} s`);
}

// ── routes ───────────────────────────────────────────────────────────

/** A serial link with no serial port: it keeps what it was sent. */
function fakeLink() {
  const taps = new Set();
  return {
    connected: true, steppersOn: false,
    settings: { M204: { T: 1000 } },
    invert: { X: false, Y: false },
    sent: [], dropped: 0,
    sign(a) { return this.invert[a] ? -1 : 1; },
    send(l) { if (!this.connected) throw new Error('not connected'); this.sent.push({ l, t: Date.now() }); },
    dropMotion() { this.dropped += 1; },
    queued: () => 0,
    inFlight: () => 0,
    onWrite(fn) { taps.add(fn); return () => taps.delete(fn); },
    wire(l) { for (const f of taps) f(l); },
  };
}

console.log('\nG-kod sətri və klaviş adı');
{
  eq(parseMove('G1 X-80.00 Y80.00 F6000'), { x: -80, y: 80, f: 6000 }, 'G1 oxunur');
  eq(parseMove('G0 Y5'), { y: 5 }, 'G0, yalnız Y');
  ok(parseMove('G28 X') === null && parseMove('M114') === null, 'hərəkət olmayan sətirlər null');
  const W = { X: -DIRECTIONS.forward.X, Y: -DIRECTIONS.forward.Y };
  eq(['W', 'S', 'A', 'D'].map((k) => {
    const v = { W, S: { X: -DIRECTIONS.back.X, Y: -DIRECTIONS.back.Y },
                A: DIRECTIONS.left, D: DIRECTIONS.right }[k];
    return moveName(v.X * 80, v.Y * 80);
  }), ['W', 'S', 'A', 'D'], '/gcode-un W/S dəyişməsi nəzərə alınır');
  ok(moveName(80, 0) === 'qövs', 'tək təkər: qövs');
}

console.log('\nÖyrətmə — karta gedən sətirlər yazılır');
{
  const link = fakeLink();
  const jog = new Jogger(link);
  const rec = new RouteRecorder({ link, jog });
  const ms = jog.chunkSeconds(Math.hypot(80, 80), 6000) * 1000;

  rec.start(2, 'to');
  ok(rec.status().active && rec.status().slot === 2, 'yazma başladı: yuva 2, "to"');
  let threw = false;
  try { rec.start(1, 'to'); } catch { threw = true; }
  ok(threw, 'ikinci yazma eyni vaxtda başlamır');

  // W held for three chunks, on the Jogger's own schedule…
  rec._line('G91', 0);
  rec._line('G1 X80.00 Y-80.00 F6000', 0);
  rec._line('G1 X80.00 Y-80.00 F6000', ms * 0.5);
  rec._line('G1 X80.00 Y-80.00 F6000', ms * 1.5);
  rec._line('M114', ms * 2);
  // …let go, a pause, and W again: a separate move, so the replay stops too.
  rec._line('G1 X80.00 Y-80.00 F6000', ms * 2 + 3000);
  // A: a spin, at a different feed and step.
  rec._line('G1 X40.00 Y40.00 F3000', ms * 3 + 3000);
  // An absolute move from the console cannot be replayed from elsewhere.
  rec._line('G90', ms * 4 + 3000);
  rec._line('G1 X0 Y0', ms * 4 + 3000);
  rec._line('G91', ms * 4 + 3100);

  const out = rec.stop();
  eq(out.segs, [{ x: 80, y: -80, f: 6000, n: 3 }, { x: 80, y: -80, f: 6000, n: 1 },
                { x: 40, y: 40, f: 3000, n: 1 }],
     'bir basılı saxlama bir hərəkətdir; buraxıb yenidən basmaq ikincisidir');
  ok(out.skipped === 1, 'mütləq (G90) hərəkət atlanır və sayılır');
  ok(!rec.active, 'dayandı');
  link.wire('G1 X80.00 Y-80.00 F6000');
  ok(rec.segs.length === 0 || out.segs.length === 3, 'dayandıqdan sonra məftil dinlənilmir');

  eq(legSummary(out.segs).list, ['W 240', 'W 80', 'A 40'], 'oxunaqlı xülasə');

  // A motor wired backwards: the wire says X-80 for what is physically X+80.
  link.invert.X = true;
  rec.start(1, 'out');
  rec._line('G1 X-80.00 Y-80.00 F6000', 0);
  const inv = rec.stop();
  eq(inv.segs[0], { x: 80, y: -80, f: 6000, n: 1 }, 'tərs motor: fiziki istiqamət saxlanır');
}

console.log('\nYollar diskdə qalır');
{
  const file = path.join(os.tmpdir(), `routes-test-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch { /* none yet */ }
  const book = new RouteBook(file);
  let s = book.summary();
  ok(s[1].qr === 'ALIM1' && s[3].qr === 'ALIM3' && s[2].to === null,
     'boş: QR mətni şartnamədəki ALIMn, yol yoxdur');
  book.set(2, 'to', [{ x: 80, y: -80, f: 6000, n: 3 }]);
  book.setQr(2, 'Alım 2');
  const again = new RouteBook(file);
  s = again.summary();
  ok(s[2].to && s[2].to.moves === 1 && s[2].to.mm === 240, 'yenidən açanda yol yerindədir');
  ok(s[2].qr === 'Alım 2' && s[2].qr_key === 'ALIM2', `QR mətni və açarı (${s[2].qr_key})`);
  eq(again.get(2, 'to'), [{ x: 80, y: -80, f: 6000, n: 3 }], 'get() hərəkətləri qaytarır');
  ok(again.get(2, 'out') === null, 'öyrədilməyən yol null');
  again.clear(2, 'to');
  ok(new RouteBook(file).get(2, 'to') === null, 'sil — diskdən də gedir');
  let threw = false;
  try { again.set(4, 'to', []); } catch { threw = true; }
  ok(threw, 'yuva 4 yoxdur');
  fs.unlinkSync(file);
}

console.log('\nSsenarilər — başlanğıcdan yuvaya yol, addım-addım');
{
  // A typed step is the same move as a held key: equal chunks, none longer
  // than a held key's, the same "W 400" legSummary would print for it.
  const w = typedStep('w', 400, 6000);
  const W = { X: -DIRECTIONS.forward.X, Y: -DIRECTIONS.forward.Y };
  eq(w, [{ x: W.X * 80, y: W.Y * 80, f: 6000, n: 5 }], 'W 400 → 5 × 80 mm, W istiqamətində');
  const a = typedStep('A', 100, 3000)[0];
  ok(a.n === 2 && Math.abs(a.x) === 50 && Math.abs(a.x) <= DEFAULT_STEP_MM
     && Math.sign(a.x) === DIRECTIONS.left.X && Math.sign(a.y) === DIRECTIONS.left.Y,
     `A 100 → 2 × 50 mm, yerində sola (${JSON.stringify(a)})`);
  eq(legSummary(typedStep('D', 250)).list, ['D 250'], 'yazılan addım oxunanda da D 250-dir');
  let bad = 0;
  for (const [k, mm] of [['X', 100], ['W', 0], ['W', 99999], ['W', 'çox']]) {
    try { typedStep(k, mm); } catch { bad += 1; }
  }
  ok(bad === 4, 'naməlum klaviş, 0 mm, 5 m-dən çox, rəqəm olmayan — hamısı rədd edilir');

  // A routes.json written before scenarios existed: "to" is one recording.
  const file = path.join(os.tmpdir(), `routes-sc-${process.pid}.json`);
  const s1 = [{ x: 80, y: -80, f: 6000, n: 3 }];
  const s2 = [{ x: 40, y: 40, f: 3000, n: 2 }];
  const s3 = [{ x: -80, y: 80, f: 6000, n: 1 }];
  fs.writeFileSync(file, JSON.stringify({ 2: { qr: 'ALIM2', to: { at: 'köhnə', segs: s1 } } }));
  const book = new RouteBook(file);
  eq(book.steps(2).map((s) => s.segs), [s1], 'köhnə yol bir addımlı ssenari kimi oxunur');
  eq(book.get(2, 'to'), s1, 'və eyni hərəkətləri sürür');

  book.setStep(2, null, s2, 'typed');
  eq(book.get(2, 'to'), [...s1, ...s2], 'addım 2 sona əlavə olunur; yol = addımlar ardıcıl');
  ok(Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8'))[2].to.steps),
     'dəyişəndə diskə yeni formada yazılır');
  book.moveStep(2, 1, -1);
  eq(book.get(2, 'to'), [...s2, ...s1], 'addım yuxarı — sıra dəyişir');
  book.moveStep(2, 0, -1);
  eq(book.get(2, 'to'), [...s2, ...s1], 'birincini yuxarı: heç nə olmur');
  book.setStep(2, 1, s3);
  eq(new RouteBook(file).get(2, 'to'), [...s2, ...s3], 'addım 2 yenidən öyrədilir, digəri toxunulmur');
  eq(book.stepSegs(2, 0), s2, 'bir addımı tək almaq olar (▶)');
  let threw = false;
  try { book.stepSegs(2, 5); } catch (e) { threw = /addım 6 yoxdur/.test(e.message); }
  ok(threw, 'olmayan addım: xəta, adı ilə');

  const sum = book.summary()[2];
  ok(sum.name === 'A2' && sum.to.steps.length === 2 && sum.to.steps[0].how === 'typed'
     && sum.to.steps[1].how === 'drive' && sum.to.moves === 2,
     `xülasə addımları, növlərini göstərir (${sum.to.steps.map((s) => s.how).join(', ')})`);
  // One scenario serves all three slots: the lines are parallel, and a slot
  // with none of its own is reached along the QR row from the nearest.
  eq([1, 2, 3].map((n) => book.via(n)), [2, 2, 2], 'yalnız A2 öyrədilib: üçü də A2-dən gedir');
  eq([1, 2, 3].map((n) => book.summary()[n].via), [2, 2, 2], 'xülasədə də (via)');
  book.setStep(3, null, s3, 'typed');
  eq([1, 2, 3].map((n) => book.via(n)), [2, 2, 3], 'A3-ün özü öyrədiləndə öz ssenarisi üstündür');
  book.clear(2, 'to');
  eq([1, 2, 3].map((n) => book.via(n)), [3, 3, 3], 'A2 silinəndə ən yaxın qalan: A3');
  book.clear(3, 'to');
  eq([1, 2, 3].map((n) => book.via(n)), [null, null, null], 'heç biri yoxdursa: null');
  book.setStep(2, null, s2, 'typed');
  book.setStep(2, null, s1, 'drive');
  book.removeStep(2, 0);
  book.removeStep(2, 0);
  ok(book.get(2, 'to') === null && book.summary()[2].to === null,
     'sonuncu addım silinəndə ssenari öyrədilməyib olur');
  fs.unlinkSync(file);

  const link = fakeLink();
  const rec = new RouteRecorder({ link, jog: new Jogger(link) });
  rec.start(2, 'to', 1);
  ok(rec.status().step === 1 && rec.stop().step === 1, 'yazma hansı addımı əvəz etdiyini bilir');
  rec.start(2, 'to');
  ok(rec.status().step === null, 'addımsız: yeni addım');
  rec.cancel();
  threw = false;
  try { rec.start(2, 'out', 0); } catch { threw = true; }
  ok(threw && !rec.active, 'qapı yolunun addımları yoxdur');
}

console.log('\nF addımı — ssenaridə «xətti bu QR-a qədər izlə»');
{
  const file = path.join(os.tmpdir(), `routes-f-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch { /* none */ }
  const s1 = [{ x: 80, y: -80, f: 6000, n: 3 }];
  const s2 = [{ x: 40, y: 40, f: 3000, n: 2 }];
  const s3 = [{ x: -80, y: 80, f: 6000, n: 1 }];
  const book = new RouteBook(file);
  book.setStep(2, null, s1, 'drive');
  book.setFollowStep(2, null, 'KAPI1');
  book.setStep(2, null, s2, 'typed');
  book.setStep(2, null, s3, 'typed');

  const parts = book.parts(2);
  eq(parts.map((p) => p.kind), ['path', 'follow', 'path'],
     'ssenari F-də hissələrə bölünür: hərəkətlər, F, hərəkətlər');
  eq(parts[2].steps, [2, 3], 'F-dən sonrakı iki addım bir hissədir — aralarında dayanmır');
  eq(book.part(2, 0), s1, 'hissə 1: F-dən əvvəlki hərəkətlər');
  eq(book.part(2, 2), [...s2, ...s3], 'hissə 3: F-dən sonrakılar, birlikdə');
  ok(parts[1].qr === 'KAPI1' && parts[1].key === qrKey('KAPI1'), 'F hissəsi QR mətnini və açarını daşıyır');
  let threw = '';
  try { book.part(2, 1); } catch (e) { threw = e.message; }
  ok(/F addımıdır/.test(threw), `F hissəsini server sürmür — ${threw}`);
  threw = '';
  try { book.stepSegs(2, 1); } catch (e) { threw = e.message; }
  ok(/kamera lazımdır/.test(threw), 'F addımını ▶ ilə tək sürmək olmur, səbəbi yazılır');
  eq(book.get(2, 'to'), [...s1, ...s2, ...s3], 'get() F-siz hərəkətləri verir — köhnə istifadəçilər üçün');
  ok(book.hasFollow(2) && !book.hasFollow(1), 'ssenaridə F olub-olmadığı bilinir');

  const sum = new RouteBook(file).summary()[2];
  ok(sum.to.follow === true && sum.to.steps[1].how === 'follow' && sum.to.steps[1].list[0] === 'F → KAPI1',
     'diskdən oxunur, xülasədə F addımı görünür');
  eq(sum.to.parts.map((p) => p.kind), ['path', 'follow', 'path'], 'xülasə /follow üçün hissələri verir');
  ok(sum.to.plan.includes('F→KAPI1'), `sürüləcək plan F-i göstərir (${sum.to.plan.join(' → ')})`);

  book.moveStep(2, 1, -1);
  eq(book.parts(2).map((p) => p.kind), ['follow', 'path'], 'F addımı yuxarı: indi başda, hərəkətlər birləşir');
  book.setFollowStep(2, 0, 'ALIM2');
  ok(book.parts(2)[0].qr === 'ALIM2', 'F addımı başqa QR ilə əvəzlənir');
  threw = '';
  try { book.setFollowStep(2, null, '   '); } catch (e) { threw = e.message; }
  ok(/QR mətni yaz/.test(threw), 'QR mətni olmayan F addımı olmur');

  const only = new RouteBook(null);
  only.setFollowStep(1, null, 'KAPI1');
  ok(only.summary()[1].to && only.summary()[1].to.steps.length === 1 && only.via(1) === 1,
     'yalnız F addımından ibarət ssenari də öyrədilmiş sayılır');
  fs.unlinkSync(file);
}

console.log('\nAqreqator — eyni istiqamətdə ardıcıl hərəkətlər bir hərəkətdir');
{
  eq(aggregate([{ x: 80, y: -80, f: 6000, n: 3 }]), [{ x: 80, y: -80, f: 6000, n: 3 }],
     'tək hərəkət olduğu kimi qalır');
  eq(aggregate([{ x: 40, y: -40, f: 6000, n: 2 }, { x: 80, y: -80, f: 6000, n: 3 },
                 { x: 80, y: -80, f: 6000, n: 1 }]),
     [{ x: 80, y: -80, f: 6000, n: 5 }],
     'iki yarım parça + basılı W + bir toxunuş = bir W 400, 80 mm-lik parçalarla');
  eq(aggregate([...typedStep('W', 400), ...typedStep('W', 300)]), typedStep('W', 700),
     'ssenari addımları: W 400 + W 300 = bir W 700');
  ok(aggregate([{ x: 80, y: -80, f: 6000, n: 2 }, { x: 40, y: 40, f: 3000, n: 1 },
                { x: 80, y: -80, f: 6000, n: 1 }]).length === 3, 'arada dönmə varsa birləşmir');
  ok(aggregate([{ x: 80, y: -80, f: 6000, n: 1 }, { x: 80, y: -80, f: 3000, n: 1 }]).length === 2,
     'fərqli sürət birləşmir');
  ok(aggregate([{ x: 80, y: -80, f: 6000, n: 1 }, { x: -80, y: 80, f: 6000, n: 1 }]).length === 2,
     'əks istiqamət (W, sonra S) birləşmir');
  const total = (ss) => ss.reduce((a, s) => a + s.n * Math.hypot(s.x, s.y), 0);
  const odd = [{ x: 33.33, y: -33.33, f: 6000, n: 7 }, { x: 80, y: -80, f: 6000, n: 2 }];
  const j = aggregate(odd);
  ok(j.length === 1 && Math.abs(total(j) - total(odd)) < 0.1
     && Math.hypot(j[0].x, j[0].y) <= Math.hypot(80, 80) + 1e-9,
     `məsafə qorunur, parça ən uzunundan uzun olmur (${j[0].n} × ${j[0].x})`);
  ok(aggregate([{ x: 0, y: 0, f: 6000, n: 3 }]).length === 0, 'boş hərəkət atılır');
}

console.log('\nYaddaşdan sürmək — basılı klaviş kimi, hərəkətlər arasında dayanmadan');
{
  const link = fakeLink();                      // M204 T1000
  const jog = new Jogger(link);
  const rp = new Replayer({ link, jog });
  const segs = [{ x: 10, y: -10, f: 6000, n: 3 }, { x: 10, y: 10, f: 6000, n: 1 }];
  const cruise = jog.holdSeconds({ X: 10, Y: -10 }, 6000) * 1000;       // 141 ms
  const ramp = (100 / (2 * jog.accel())) * 1000;                        // 50 ms
  const t0 = Date.now();
  rp.run('r1', segs, 'yuva 2');
  ok(rp.active && rp.status().id === 'r1', 'başladı, öz adı ilə');
  for (let i = 0; i < 200 && rp.active; i++) await sleep(10);
  const took = Date.now() - t0;
  const st = rp.status();
  ok(st.done && !st.err, 'bitdi');
  const lines = link.sent.map((s) => s.l);
  eq(lines, ['G91', 'G1 X10.00 Y-10.00 F6000', 'G1 X10.00 Y-10.00 F6000',
             'G1 X10.00 Y-10.00 F6000', 'G1 X10.00 Y10.00 F6000'],
     'eyni sətirlər, eyni sıra');
  const t = link.sent.map((s) => s.t);
  const g1 = t[2] - t[1], g3 = t[4] - t[3];
  // The first chunk must not start alone — Marlin would plan it to stop.
  ok(g1 < 20, `ilk iki parça ardıcıl gedir — ikincisi birincisi başlamazdan əvvəl lövhədədir (${g1} ms)`);
  // Across the turn: no waiting for the move to run out, no 300 ms settle —
  // the next chunk goes out on the same schedule, and the board slows for
  // the turn by itself.
  ok(Math.abs(g3 - cruise) < 40,
     `dönmədə də ara bir axıcı parçadır, gözləmə yoxdur (${g3} ms ≈ ${Math.round(cruise)})`);
  // Done when the board is predicted to have stopped: 3 chunks + a turn + the
  // ramps — 3·141 + 50 (start) + 50 + 141 + 50 (the turn) + 50 (the stop).
  const predicted = 4 * cruise + 4 * ramp;
  ok(took >= predicted - 30 && took < predicted + 200,
     `rover dayanan kimi bitir, əvvəl yox (${took} ms ≈ ${Math.round(predicted)})`);
  ok(HOLD_MARGIN_S > 0, 'aralıq HOLD_MARGIN_S ilə, basılı klaviş kimi');

  link.sent.length = 0;
  link.invert.X = true;
  rp.run('r2', [{ x: 10, y: -10, f: 6000, n: 1 }]);
  for (let i = 0; i < 100 && rp.active; i++) await sleep(20);
  ok(link.sent[1].l === 'G1 X-10.00 Y-10.00 F6000', `tərs motor yenidən işarələnir (${link.sent[1].l})`);
}

console.log('\nDAYAN yolu dayandırır');
{
  const link = fakeLink();
  const jog = new Jogger(link);
  const rp = new Replayer({ link, jog });
  rp.run('long', [{ x: 10, y: -10, f: 6000, n: 60 }]);
  await sleep(300);
  const before = link.sent.length;
  rp.cancel('DAYAN');
  await sleep(300);
  ok(link.sent.length === before, `ləğvdən sonra heç nə göndərilmir (${before} sətir)`);
  ok(rp.status().aborted && !rp.status().done && link.dropped === 1,
     'aborted, növbədəki hərəkətlər atıldı');

  link.connected = false;
  rp.run('off', [{ x: 1, y: 1, f: 600, n: 1 }]);
  await sleep(30);
  ok(/bağlı deyil/.test(rp.status().err || ''), `kart yoxdursa: ${rp.status().err}`);
  rp.run('empty', []);
  await sleep(30);
  ok(/boşdur/.test(rp.status().err || ''), `boş yol: ${rp.status().err}`);
}

console.log('\nSsenari — PLC bekle fasilə verir, devam qaldığı yerdən davam etdirir');
{
  // A link whose last two lines are still "in the queue" when a pause comes:
  // dropMotion takes them back, the way MarlinLink does for unwritten moves.
  const link = fakeLink();
  link.dropMotion = function () {
    const g1 = this.sent.filter((s) => s.l.startsWith('G1'));
    const n = Math.min(2, g1.length);
    for (let j = 0; j < n; j++) this.sent.splice(this.sent.lastIndexOf(g1[g1.length - 1 - j]), 1);
    this.dropped += n;
    return n;
  };
  const jog = new Jogger(link);
  const rp = new Replayer({ link, jog });
  const segs = [{ x: 10, y: -10, f: 6000, n: 12 }, { x: 10, y: 10, f: 6000, n: 6 }];
  const g1s = () => link.sent.filter((s) => s.l.startsWith('G1')).length;
  rp.run('p', segs, 'A1 ssenarisi');
  await sleep(500);
  rp.hold('PLC bekle dedi');
  const atPause = g1s();
  ok(rp.status().paused && rp.active && !rp.status().aborted,
     `fasilə — ləğv deyil  (${rp.status().seg}/${rp.status().of})`);
  await sleep(600);
  ok(g1s() === atPause && link.dropped === 2,
     `fasilədə heç nə getmir, növbədəki 2 parça geri alındı  (${atPause} sətir)`);
  rp.hold(null);
  for (let i = 0; i < 400 && rp.active; i++) await sleep(10);
  ok(rp.status().done && !rp.status().aborted, 'devam: yol sona çatdı');
  eq(g1s(), 18, 'geri alınan parçalar yenidən sürüldü — heç biri atlanmadı, heç biri iki dəfə yox');
  const lines = link.sent.filter((s) => s.l.startsWith('G1')).map((s) => s.l);
  ok(lines.slice(0, 12).every((l) => l === 'G1 X10.00 Y-10.00 F6000')
     && lines.slice(12).every((l) => l === 'G1 X10.00 Y10.00 F6000'), 'sıra da eynidir');

  // Held before it starts: it starts paused.
  const link2 = fakeLink();
  const rp2 = new Replayer({ link: link2, jog: new Jogger(link2) });
  rp2.hold('PLC bekle dedi');
  rp2.run('q', [{ x: 10, y: -10, f: 6000, n: 3 }]);
  await sleep(300);
  ok(rp2.active && rp2.status().paused && !link2.sent.some((s) => s.l.startsWith('G1')),
     'bekle altında başlayan ssenari fasilədə gözləyir');
  rp2.hold(null);
  for (let i = 0; i < 200 && rp2.active; i++) await sleep(10);
  ok(rp2.status().done, 'devam gələndə sürür');

  // Through the rover: a hold pauses, release resumes, an emergency stop ends it.
  const link3 = fakeLink();
  const jog3 = new Jogger(link3);
  const rp3 = new Replayer({ link: link3, jog: jog3 });
  const rover = new Rover({ link: link3, jog: jog3, replayer: rp3 });
  rover.start();
  rover.replay('r', [{ x: 10, y: -10, f: 6000, n: 40 }], 'A2 ssenarisi');
  await sleep(200);
  rover.hold('PLC bekle dedi — devam komutu bekleniyor');
  ok(rp3.status().paused && rp3.active, 'rover.hold → ssenari fasilədə');
  rover.hold(null);
  await sleep(100);
  ok(!rp3.status().paused && rp3.active, 'hold götürüldü → ssenari davam edir');
  rover.hold('acil stop', true);
  ok(!rp3.active && rp3.status().aborted, 'acil stop ssenarini bitirir');
  rover.hold(null);
  rover.close();
}

console.log('\nRover — yol yalnız silahlı ikən, və o vaxt pilot təkərlərə toxunmur');
{
  const link = fakeLink();
  const jog = new Jogger(link);
  const replayer = new Replayer({ link, jog });
  const rover = new Rover({ link, jog, replayer });
  const segs = [{ x: 10, y: -10, f: 6000, n: 40 }];

  let s = rover.replay('a', segs, 'yuva 1');
  ok(/SÜRMƏYƏ BAŞLA/.test(s.err || '') && !replayer.active, `silahsız: ${s.err}`);
  rover.start();
  s = rover.replay('b', null, 'yuva 1, yuva → qapı');
  ok(/öyrədilməyib/.test(s.err || ''), `öyrədilməyən yol: ${s.err}`);
  rover.replay('c', segs, 'yuva 1');
  ok(replayer.active, 'silahlı: yol başladı');
  rover.setAuto(40, 40, 'pilot');
  ok(!jog.active, 'pilotun 20 Hz tələbi yolun altında jogger-i işə salmır');
  ok(rover.snapshot().replay && rover.snapshot().replay.id === 'c', 'snapshot yolu göstərir');
  rover.stop('DAYAN');
  ok(replayer.status().aborted && !replayer.active, 'rover.stop() yolu da dayandırır');
}

// ── the real server ──────────────────────────────────────────────────

console.log('\nSunucu — /api/qr, /api/actuator, /api/cargo');
{
  const PORT = 8193;
  const routes = path.join(os.tmpdir(), `routes-srv-${process.pid}.json`);
  try { fs.unlinkSync(routes); } catch { /* none */ }
  const proc = spawn('node', ['server.js', '--http', String(PORT), '--host', '127.0.0.1',
                              '--no-connect', '--no-camera', '--no-actuator', '--no-lidar', '--no-advertise',
                              '--routes', routes],
                     { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = '';
  proc.stdout.on('data', (d) => { boot += d; });
  proc.stderr.on('data', (d) => { boot += d; });
  const B = `http://127.0.0.1:${PORT}`;
  // Poll rather than sleep a fixed time: this Pi takes anywhere from one to
  // three seconds to have the port open.
  for (let i = 0; i < 80; i++) {
    try { await fetch(B + '/api/qr'); break; } catch { await sleep(100); }
  }
  const get = async (u) => (await fetch(B + u)).json();
  const post = async (u, body) => {
    const r = await fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                   body: JSON.stringify(body) });
    return { code: r.status, body: await r.json() };
  };

  try {
    const q = await get('/api/qr');
    ok(q.available === true && q.text === null && 'key' in q,
       `/api/qr: oxuyucu hazır, hələ kod yoxdur`);

    let a = await get('/api/actuator');
    ok(a.dry && !a.running && a.pins.en === 10 && a.pins.dir === 22,
       '/api/actuator: quru rejim, GPIO10/GPIO22');
    a = (await post('/api/actuator', { action: 'toggle' })).body;
    ok(a.running && a.dir === 'up', 'toggle (Q) → işləyir');
    a = (await post('/api/actuator', { action: 'flip' })).body;
    ok(a.running && a.dir === 'down', 'flip (E) → aşağı');
    a = (await post('/api/actuator', { action: 'toggle' })).body;
    ok(!a.running, 'toggle yenə → dayandı');
    const bad = await post('/api/actuator', { action: 'fly' });
    ok(bad.code === 400, 'naməlum əmr → 400');

    let c = await get('/api/cargo');
    ok(Object.keys(c.routes).join() === '1,2,3' && c.routes[2].to === null && !c.rec.active,
       '/api/cargo: üç yuva, heç biri öyrədilməyib');
    c = (await post('/api/cargo', { action: 'record', slot: 2, leg: 'to' })).body;
    ok(c.rec.active && c.rec.slot === 2, 'record → yazılır');
    const empty = await post('/api/cargo', { action: 'save' });
    ok(empty.code === 400 && /heç bir hərəkət/.test(empty.body.error) && !empty.body.rec.active,
       'hərəkətsiz yol saxlanmır, yazma dayanır');
    ok(!fs.existsSync(routes), 'və diskə heç nə yazılmadı');
    c = (await post('/api/cargo', { action: 'run', slot: 2 })).body;
    ok(c.want && c.want.slot === 2, 'run → /follow üçün istək');
    const nope = await post('/api/cargo', { action: 'record', slot: 9, leg: 'to' });
    ok(nope.code === 400, 'yuva 9 → 400');

    // Scenarios, over HTTP — the card's own calls.
    const untaught = await post('/api/cargo', { action: 'test', slot: 1 });
    ok(untaught.code === 400 && /A1 ssenarisi öyrədilməyib/.test(untaught.body.error),
       `öyrədilməyən ssenari sınanmır (${untaught.body.error})`);
    c = (await post('/api/cargo', { action: 'step_add', slot: 3, key: 'W', mm: 400 })).body;
    c = (await post('/api/cargo', { action: 'step_add', slot: 3, key: 'D', mm: 120 })).body;
    ok(c.routes[3].to && c.routes[3].to.steps.map((s) => s.list.join()).join(' | ') === 'W 400 | D 120',
       `yazılı addımlar: ${c.routes[3].to && c.routes[3].to.steps.map((s) => s.list.join()).join(' | ')}`);
    const badKey = await post('/api/cargo', { action: 'step_add', slot: 3, key: 'Q', mm: 100 });
    ok(badKey.code === 400, 'Q addım deyil → 400');
    c = (await post('/api/cargo', { action: 'record', slot: 3, leg: 'to', step: 0 })).body;
    ok(c.rec.active && c.rec.step === 0, 'addım 1 yenidən öyrədilir');
    const clash = await post('/api/cargo', { action: 'test', slot: 3 });
    ok(clash.code === 400 && /yazılır/.test(clash.body.error), 'yazılarkən sınaq olmur');
    await post('/api/cargo', { action: 'cancel' });
    c = (await post('/api/cargo', { action: 'test', slot: 3, step: 1 })).body;
    await sleep(80);
    c = await get('/api/cargo');
    ok(c.replay.route === 'A3 ssenarisi, addım 2' && /bağlı deyil/.test(c.replay.err || ''),
       `addım 2 tək sürülür — kartsız: ${c.replay.err}`);
    c = (await post('/api/cargo', { action: 'step_move', slot: 3, step: 1, by: -1 })).body;
    ok(c.routes[3].to.steps[0].list.join() === 'D 120', 'addım yuxarı');
    c = (await post('/api/cargo', { action: 'clear', slot: 3, leg: 'to' })).body;
    ok(c.routes[3].to === null, 'bütün ssenari silinir');

    // An F step, over HTTP.
    await post('/api/cargo', { action: 'step_add', slot: 1, key: 'W', mm: 300 });
    c = (await post('/api/cargo', { action: 'step_add', slot: 1, key: 'F', qr: 'KAPI1' })).body;
    ok(c.routes[1].to.steps[1].how === 'follow' && c.routes[1].to.follow,
       'step_add key F → F addımı (xətti KAPI1-a qədər izlə)');
    const noQr = await post('/api/cargo', { action: 'step_add', slot: 1, key: 'F', qr: '' });
    ok(noQr.code === 400 && /QR mətni/.test(noQr.body.error), 'QR mətnsiz F → 400');
    const whole = await post('/api/cargo', { action: 'test', slot: 1 });
    ok(whole.code === 400 && /F addımı var/.test(whole.body.error),
       `F-li ssenarini /gcode bütöv sürmür — kamera yoxdur (${whole.body.error})`);
    const fOne = await post('/api/cargo', { action: 'test', slot: 1, step: 1 });
    ok(fOne.code === 400 && /kamera lazımdır/.test(fOne.body.error), 'F addımını tək də sürmür');
    c = (await post('/api/cargo', { action: 'clear', slot: 1, leg: 'to' })).body;
    ok(c.routes[1].to === null, 'F-li ssenari də silinir');

    const WS = (await import('ws')).default;
    const status = await new Promise((resolve) => {
      const ws = new WS(`ws://127.0.0.1:${PORT}/`);
      ws.on('message', (d) => { ws.close(); resolve(JSON.parse(String(d))); });
      setTimeout(() => resolve(null), 3000);
    });
    ok(status && status.qr && status.act && status.cargo && status.cargo.want.slot === 2,
       'WebSocket statusu qr, act və cargo daşıyır');
    ok(status && status.replay && status.replay.active === false, 'və replay');
  } finally {
    proc.kill();
    try { fs.unlinkSync(routes); } catch { /* never written */ }
  }
  if (fail) console.log('\nserver output:\n' + boot);
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
