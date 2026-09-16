/**
 * QR localisation checks — public/qrnav.js on this repo's field, and nav.js,
 * the server's odometer that feeds it off the wire.
 *
 * qrnav.js is pure, so a whole run can be played out here as a list of codes:
 * "read BASLA, then ALIM2" is a rover that left the start area and drove up to
 * A2, and every claim it makes on the way — which leg, which way, what to do
 * at the next junction — is arithmetic with a known answer.
 *
 * The parts worth being strict about are the ones that are silently wrong on a
 * real field rather than loudly wrong:
 *
 *   - a QR names an edge, not a direction. Backwards puts the rover in exactly
 *     the right place pointing exactly the wrong way, and the next
 *     instruction sends it back where it came from.
 *   - between codes the pose is odometry in a frame that starts wherever the
 *     trail was reset. A wrong rotation at the anchor looks fine at every QR
 *     and drifts sideways in between.
 *   - the wire speaks motor axes and the odometer speaks the camera's wheels.
 *     A sign wrong there draws every right turn as a left one.
 *
 *   node test/test_qrnav.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Nav } from '../nav.js';
import { Rover } from '../rover.js';
import { Jogger, DIRECTIONS } from '../marlin.js';

const here = dirname(fileURLToPath(import.meta.url));
// field.js first: qrnav.js reads its globals, exactly as a page loads them.
const src = ['field.js', 'qrnav.js']
  .map((f) => readFileSync(join(here, '..', 'public', f), 'utf8')).join('\n;\n');
const names = ['FIELD', 'fieldNode', 'fieldBearing', 'navQrId', 'navQr', 'navQrs',
               'navTurn', 'navPlan', 'navLegs', 'navState', 'navSee', 'navMission',
               'navPose', 'navStatus', 'navToField', 'navOdoState', 'navOdoStep',
               'navOdoPose'];
const F = new Function(`${src}\nreturn { ${names.join(', ')} };`)();
const { FIELD, fieldNode, fieldBearing, navQrId, navQr, navQrs, navTurn, navPlan,
        navLegs, navState, navSee, navMission, navPose, navStatus, navToField,
        navOdoState, navOdoStep, navOdoPose } = F;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const near = (a, b, eps, m) =>
  ok(Math.abs(a - b) <= eps, `${m}  (${(+a).toFixed(3)} ≈ ${(+b).toFixed(3)})`);

// ── the codes ────────────────────────────────────────────────────────
console.log('\nDoqquz QR sahədə, hər biri öz kənarında');
{
  const qs = navQrs();
  ok(qs.length === 9, `doqquz kod  (${qs.map((q) => q.qr).join(' ')})`);
  for (const q of qs) {
    const a = fieldNode(q.a), b = fieldNode(q.b);
    const onX = Math.min(a.x, b.x) - 1e-6 <= q.x && q.x <= Math.max(a.x, b.x) + 1e-6;
    const onY = Math.min(a.y, b.y) - 1e-6 <= q.y && q.y <= Math.max(a.y, b.y) + 1e-6;
    ok(onX && onY, `${q.qr} (${q.text}) ${q.a}–${q.b} kənarının üstündə: ${q.x}, ${q.y}`);
  }
  // Drawn and localised from the same `s`: ALIM2 is 3.05 m up the J2 branch.
  const q3 = navQr('q3');
  near(q3.x, fieldNode('J2').x, 1e-9, 'ALIM2 J2 ilə eyni sütunda');
  near(q3.y - fieldNode('J2').y, 3.05, 1e-3, 'ALIM2 J2-dən 3.05 m şimalda');
}

console.log('\nQR mətni id-yə çevrilir');
{
  ok(navQrId('BASLA') === 'q1', '«BASLA» → q1');
  ok(navQrId('Başla') === 'q1', '«Başla» (Ş, kiçik hərf) → q1');
  ok(navQrId('ALIM2') === 'q3', '«ALIM2» → q3');
  ok(navQrId('Alım-2') === 'q3', '«Alım-2» → q3 (qr.js-in qrKey qaydası)');
  ok(navQrId('KAPI1') === 'q5' && navQrId('KAPI2') === 'q6', 'KAPI1 / KAPI2 → q5 / q6');
  ok(navQrId('BIRAK3') === 'q7' && navQrId('bırak 1') === 'q9', 'BIRAK3 → q7, «bırak 1» → q9');
  ok(navQrId('q5') === 'q5' && navQrId(' QR5 ') === 'q5', '«q5», «QR5»');
  ok(navQrId('https://saha.local/qr/5') === 'q5', 'URL sonundakı nömrə');
  ok(navQrId('5') === 'q5', 'yalnız nömrə');
  ok(navQrId('q12') === null, 'sahədə olmayan nömrə tanınmır');
  ok(navQrId(null) === null && navQrId('') === null, 'boş mətn tanınmır');
  // The dangerous half: a stray label must never become a fix.
  ok(navQrId('kargo-9') === null, '«kargo-9» yük etiketidir, yol nişanı deyil');
  ok(navQrId('BOX-2024-3') === null, 'rəqəmlə bitən kod tanınmır');
  ok(navQrId('iraq5') === null, 'sözün quyruğundakı q sayılmır');
  ok(navQrId('ALIM23') === null, '«ALIM23» ALIM2 deyil');
}

console.log('\nDönüşlər');
{
  ok(navTurn(90, 0).dir === 'left', 'şərqdən şimala — sola');
  ok(navTurn(90, 180).dir === 'right', 'şərqdən cənuba — sağa');
  ok(navTurn(90, 104).dir === 'straight', '14° hələ düz sayılır');
  ok(navTurn(0, 180).dir === 'back', 'tərs istiqamət — geri');
  ok(navTurn(0, 359).dir === 'straight', 'sıfırdan keçəndə fərq düz sayılır');
}

console.log('\nMarşrut');
{
  const p = navPlan('START', ['A2', 'B3']);
  ok(p.ok, `tam tapşırıq: ${p.nodes.join('>')}`);
  ok(p.nodes.join('>') === 'START>J1>J2>A2>J2>J3>KAPI>J4>B3', 'START → A2 → B3, qapıdan keçir');
  ok(p.nodes.filter((n) => n === 'A2').length === 1, 'A2 bir dəfə yazılır');
  ok(navPlan('START', ['YOX']).ok === false, 'olmayan hədəf açıq-aşkar uğursuz');

  const legs = navLegs(['START', 'J1', 'J2', 'A2']);
  ok(legs[0].turn.dir === 'right', `J1-də sağa  (${legs[0].turn.deg}°)`);
  ok(legs[1].turn.dir === 'left', `J2-də sola  (${legs[1].turn.deg}°)`);
  ok(legs[0].qr === 'q1' && legs[2].qr === 'q3', 'START→J1 üstündə q1, J2→A2 üstündə q3');
  ok(legs[2].turn === null, 'son addımdan sonra dönüş yoxdur');
}

// ── localisation ─────────────────────────────────────────────────────
console.log('\nQR oxunanda rover harada olduğunu bilir');
{
  const st = navState();
  const r = navSee(st, 'BASLA', 1000);
  ok(r.ok && r.qr === 'q1', 'BASLA tanındı');
  ok(r.sure === false, 'plan yoxdursa ilk kodda istiqamət təxmindir — və bu deyilir');

  const st2 = navState();
  navMission(st2, ['A2'], null, 'START');
  const a = navSee(st2, 'BASLA', 1000);
  ok(a.from === 'START' && a.to === 'J1' && a.sure, 'plan sayəsində istiqamət dəqiq: START→J1');
  ok(a.turn && a.turn.node === 'J1' && a.turn.dir === 'right', 'J1-də sağa dönmək lazımdır');
  const b = navSee(st2, 'ALIM2', 2000);
  ok(b.from === 'J2' && b.to === 'A2', 'ALIM2 oxunanda J2→A2 etapında');
  ok(b.turn && b.turn.dir === 'arrive', 'A2 planın sonu — «varış»');
  near(b.bearing, 0, 0.01, 'A2-yə şimala doğru gedilir');
}

console.log('\nGeri qayıdanda eyni kod tərs istiqamətdə oxunur');
{
  const st = navState();
  navMission(st, ['A2', 'B3'], null, 'START');
  const there = navSee(st, 'ALIM2', 1000, null, { x: 0, y: 0, bearing: 0 });
  ok(there.from === 'J2' && there.to === 'A2', 'gedişdə q3 J2→A2');
  const again = navSee(st, 'ALIM2', 3000, null, { x: 0.1, y: 0, bearing: 0 });
  ok(again.from === 'J2' && again.to === 'A2', 'yerindən tərpənmədən təkrar oxunanda istiqamət dəyişmir');
  const back = navSee(st, 'ALIM2', 9000, null, { x: 0, y: 2.4, bearing: 180 });
  ok(back.from === 'A2' && back.to === 'J2', 'qayıdışda q3 A2→J2');
  ok(back.onPlan && back.turn && back.turn.node === 'J2' && back.turn.then === 'J3',
     `J2-də marşrut J3-ə davam edir  (${back.turn && back.turn.label})`);
}

console.log('\nPlan olmadan ardıcıllıq istiqaməti tapır');
{
  const st = navState();
  navSee(st, 'ALIM1', 1000);             // J1→A1 as written: a guess
  ok(st.to === 'A1' && !st.sure, 'ALIM1 kənarın yazıldığı kimi — təxmin');
  navSee(st, 'q2', 1000);                // same code, same spot: still a guess
  const st2 = navState();
  navSee(st2, 'KAPI1', 1000);            // J3→KAPI
  const r = navSee(st2, 'KAPI2', 4000, null, null);   // touches KAPI
  ok(r.from === 'KAPI' && r.to === 'J4' && r.sure, 'KAPI-dən keçib J4-ə getdiyi ardıcıllıqdan çıxarıldı');
}

console.log('\nYad QR mövqeyi pozmur');
{
  const st = navState();
  navSee(st, 'KAPI1', 1000);
  const before = { from: st.from, to: st.to, anchor: st.anchor };
  const r = navSee(st, 'kargo-4471', 2000);
  ok(r.ok === false, 'sahəyə aid olmayan kod qəbul olunmur');
  ok(st.from === before.from && st.to === before.to && st.anchor === before.anchor,
     'köhnə mövqe olduğu kimi qalır');
  ok(st.strays === 1 && st.unknown === 'kargo-4471', 'tanınmayan kod ayrıca sayılır');
}

// ── the pose between codes ───────────────────────────────────────────
console.log('\nİki QR arasında mövqe hesablanır, oxunanda düzəlir');
{
  const st = navState();
  ok(navPose(st, null).known === false, 'heç nə oxunmayıbsa mövqe bilinmir — başlanğıca çəkilmir');

  // An odometer that has already pivoted 90° in its own frame before the code
  // is read. The anchor's rotation has to cancel that exactly: a metre of
  // "forward" afterwards must land on the leg's own bearing.
  const od = navOdoState(0);
  for (let i = 0; i < 20; i++) navOdoStep(od, 11.781, -11.781, i, 0.30);   // ≈ 90° right
  near(od.h, 90, 0.5, 'odometr öz çərçivəsində 90° dönüb');
  for (let i = 0; i < 10; i++) navOdoStep(od, 50, 50, 100 + i, 0.30);
  const stAt = navState();
  navSee(stAt, 'KAPI1', 200, null, navOdoPose(od));
  const q5 = navQr('q5');
  let p = navPose(stAt, navOdoPose(od));
  near(p.x, q5.x, 1e-3, 'kod oxunan an mövqe tam QR-ın yeri');
  near(p.y, q5.y, 1e-3, '…hər iki oxda');
  near(p.bearing, 90, 0.5, 'və istiqamət kənarın istiqaməti (J3→KAPI şərqə)');
  for (let i = 0; i < 20; i++) navOdoStep(od, 50, 50, 300 + i, 0.30);     // 1 m more
  p = navPose(stAt, navOdoPose(od));
  near(p.x, q5.x + 1, 0.01, 'sonrakı 1 m şərqə yazılır — çünki etap şərqə gedir');
  near(p.y, q5.y, 0.01, 'şimala sürüşmə yoxdur');
  near(p.dead, 1, 0.01, 'koddan bəri 1 m hesablanıb');
  // The bearing between codes: a further 90° left in the odometer's frame is a
  // further 90° left on the field — north — whatever the odometer called it.
  for (let i = 0; i < 20; i++) navOdoStep(od, -11.781, 11.781, 400 + i, 0.30);
  p = navPose(stAt, navOdoPose(od));
  near(p.bearing, 0, 0.5, 'kodlar arasında 90° sola dönmək sahədə şimala baxmaqdır');
  const t = navToField(stAt.anchor, { x: stAt.anchor.rx, y: stAt.anchor.ry });
  near(t.x, q5.x, 1e-6, 'iz nöqtəsi anker anında tam QR-ın yerindədir');
}

console.log('\nVəziyyət bir yerdə toplanır');
{
  const st = navState();
  navMission(st, ['A3', 'B2'], null, 'START');
  navSee(st, 'BASLA', 1000);
  const s = navStatus(st, null);
  ok(s.qr === 'q1' && s.from === 'START' && s.to === 'J1', 'harada olduğu yazılır');
  ok(s.turn && s.turn.dir === 'right', 'sıradakı dönüş yazılır');
  ok(s.plan.includes('A3') && s.plan.includes('B2'), 'marşrut hər iki dayanacaqdan keçir');
  ok(s.left[0] === 'J1', 'qalan düğümlərin ilki qarşıdakı');
}

// ── nav.js: the wire, heard ──────────────────────────────────────────
console.log('\nnav.js: məftildəki G1 kameranın təkərlərinə çevrilir');
{
  const link = { sign: () => 1, settings: {}, connected: false, onWrite: () => () => {} };
  const jog = new Jogger(link);
  const rover = new Rover({ link, jog });
  // The exact line /follow's steering stream would write for a demand, built
  // by the same two functions rover.setAuto() and the jogger use.
  const lineFor = (camL, camR) => {
    const { dLeft, dRight, feed } = rover.chunkFor(camL, camR);
    return jog.lineFor({ X: dRight, Y: -dLeft }, feed);     // startWheels(-dR, -dL)
  };

  const n = new Nav({ link });
  for (let i = 0; i < 40; i++) n.wrote(lineFor(50, 50), i * 150);
  const s = n.status(6000).route;
  near(s.bearing, 0, 0.01, '/follow düz — istiqamət dəyişmir');
  ok(s.y > 0 && Math.abs(s.x) < 1e-6, `/follow düz — irəli gedir  (${s.y} m)`);
  const mm = rover.chunkFor(50, 50).dLeft * 40 / 1000;
  near(s.dist, mm, 0.01, 'məsafə göndərilən millimetrlərin cəmidir');

  const r = new Nav({ link });
  for (let i = 0; i < 20; i++) r.wrote(lineFor(60, 20), i * 150);
  const b = r.status().route.bearing;
  ok(b > 0 && b < 180, `kameranın sol təkəri sürətli — sağa dönür  (${b}°)`);

  // /gcode's W is DIRECTIONS.forward with the ends swapped (manualVec()).
  const w = new Nav({ link });
  const W = { X: -DIRECTIONS.forward.X * 5, Y: -DIRECTIONS.forward.Y * 5 };
  w.wrote(jog.lineFor(W, 3000));
  ok(w.status().route.y > 0, `/gcode W — irəli  (${jog.lineFor(W, 3000)})`);

  // An inverted axis is undone by link.sign(), exactly as the jogger applied it.
  const inv = { ...link, sign: (a) => (a === 'X' ? -1 : 1) };
  const ji = new Jogger(inv);
  const ni = new Nav({ link: inv });
  const { dLeft, dRight, feed } = rover.chunkFor(50, 50);
  ni.wrote(ji.lineFor({ X: dRight, Y: -dLeft }, feed));
  near(ni.status().route.bearing, 0, 0.01, 'tərs X oxu ilə də düz — düz qalır');

  const g = new Nav({ link });
  ok(!g.wrote('G90') && !g.wrote('G1 X10 Y10'), 'G90 qüvvədə — mövqe sətirləri sayılmır');
  ok(!g.wrote('G91') && g.wrote('G1 X1 Y-1'), 'G91 qayıdanda yenə sayılır');
  ok(!g.wrote('M114') && !g.wrote('G28'), 'hərəkət olmayan sətirlər sayılmır');

  // A code read through the server: fixed, and a reset forgets the fix but
  // keeps the mission.
  n.setMission(['A2']);
  const { fix } = n.seeQr('BASLA', 7000);
  ok(fix.ok && n.status().field.known, 'server QR-ı oxudu və mövqe bilinir');
  ok(n.status().field.route === undefined && n.status().route.marks.length === 1,
     'oxuma izin üstünə işarə kimi düşür');
  n.reset(8000);
  const after = n.status(8000);
  ok(!after.field.known && after.route.dist === 0, 'sıfırlama mövqeni və izi unudur');
  ok(after.field.stops.join() === 'A2', '…amma tapşırıq qalır');
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
