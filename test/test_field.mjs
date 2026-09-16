/**
 * Field checks — the map, the planner and the dead reckoning.
 *
 * Three things worth a test and one thing worth two.
 *
 * The map itself is checked against the şartname rather than against itself:
 * the interesting assertions below are the ones that recompute a printed
 * dimension out of the coordinates — the 3 m wall openings, Şekil 5's
 * 1.5 + 1.9 + 0.4 m of start branch, Şekil 6's 2.7 m station stub. A typo in a
 * coordinate is invisible to a test that only asks whether the number is the
 * number; it is not invisible to one that asks whether the branch still adds
 * up to 3.8 m.
 *
 * The planner is checked for the one case the whole task turns on: A1, A2 and
 * A3 are the same station three times over, and the only thing that tells them
 * apart is which junction you turn at.
 *
 * The reckoning is checked for shape, not for numbers — drive a square, come
 * back to where you started — and then for the thing that actually matters,
 * which is that an anchor throws away the drift instead of averaging it in.
 *
 *   node test/test_field.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'field.js'), 'utf8');
const {
  FIELD, FIELD_TRACK_M, fieldNode, fieldStations, fieldLinks, fieldBearing,
  fieldSpan, fieldTurn, fieldPlan, fieldLegs, fieldJunctions,
  fieldState, fieldStep, fieldAnchor, fieldPose,
} = new Function(`${src}
  return { FIELD, FIELD_TRACK_M, fieldNode, fieldStations, fieldLinks, fieldBearing,
           fieldSpan, fieldTurn, fieldPlan, fieldLegs, fieldJunctions,
           fieldState, fieldStep, fieldAnchor, fieldPose };`)();

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

console.log('\nBina — şartnamədəki ölçülər');
{
  const b = FIELD.building;
  ok(b.w === 18 && b.h === 10, 'saha 18 × 10 m');
  ok(b.halls[0].x1 === 7.5, 'sol salon 7.5 m-də bitir');
  ok(b.halls[1].x0 === 9, 'sağ salon 9 m-də başlayır');
  ok(near(b.halls[1].x0 - b.halls[0].x1, 1.5), 'aralarındakı dəhliz 1.5 m');
  // Şekil 1 dimensions the openings from opposite walls — 4.5 m down from the
  // north, 2.5 m up from the south — so the 3 m is a thing the drawing implies
  // rather than prints, and worth recomputing.
  for (const o of b.openings) ok(near(o.y1 - o.y0, 3), `divar boşluğu ${o.x} m-də 3 m`);
  ok(b.openings.every((o) => near((o.y0 + o.y1) / 2, 4)),
     'boşluqların ortası ana xəttin üstündə');
  ok(b.gate.x > b.halls[0].x1 && b.gate.x < b.halls[1].x0, 'qapı dəhlizin içində');
}

console.log('\nXətt — Şekil 5 və Şekil 6 ilə üst-üstə düşür');
{
  // Şekil 5: the start branch is 1.5 m of paint, then the 1.9 m area, then
  // 0.4 m more — 3.8 m in all. Nothing below writes 3.8 down; it has to come
  // out of the junction, the area's centre and its length.
  const j1 = fieldNode('J1'), s = fieldNode('START');
  const toNear = fieldSpan('J1', 'START') - s.zone.along / 2;
  ok(near(toNear, 1.5, 0.06), `qovşaqdan başlanğıc sahəsinə ${toNear.toFixed(2)} m ≈ 1.5 m`);
  ok(near(fieldSpan('J1', 'START') + s.tip, 3.8, 0.06),
     'başlanğıc qolu cəmi 3.8 m');
  ok(near(s.zone.along, 1.9) && near(s.zone.across, 1.0), 'başlanğıc sahəsi 1.9 × 1.0 m');
  ok(j1.x === s.x, 'başlanğıc J1-in altında — eyni xətt');

  // Şekil 6: every station is the same 2.7 m stub — 1.5 m, the 615 mm zone,
  // then 585 mm of tail. The branches are different lengths, the stubs are not.
  for (const st of fieldStations()) {
    const link = fieldLinks(st.id)[0];
    const junc = link.edge.a === st.id ? link.edge.b : link.edge.a;
    const stub = 1.5 + st.zone.along + 0.585;
    ok(near(st.zone.along, 0.615) && near(st.zone.across, 0.715),
       `${st.id} sahəsi 615 × 715 mm`);
    ok(near(st.zone.along / 2 + st.tip, stub - 1.5, 0.03),
       `${st.id}: mərkəzdən boyanın sonuna ${(st.zone.along / 2 + st.tip).toFixed(2)} m`);
    ok(fieldSpan(junc, st.id) > 1.5, `${st.id} qovşaqdan uzaqda`);
  }
}

console.log('\nQR-lar — hələ oxunmur, amma yerləri xəritədədir');
{
  const codes = FIELD.edges.filter((e) => e.qr).map((e) => e.qr);
  ok(codes.length === 9, `doqquz kod (${codes.length})`);
  ok(new Set(codes).size === 9, 'təkrarlanan kod yoxdur');
  ok(FIELD.edges.every((e) => !e.qr || (e.s >= 0 && e.s <= fieldSpan(e.a, e.b) + 1.5)),
     'hər kod öz ayağının üstündə');
  const q1 = FIELD.edges.find((e) => e.qr === 'q1');
  ok(q1.s === 0 && q1.text === 'BASLA', 'q1 qovşaqda — Şekil 5');
}

console.log('\nGraf — hər düyün bağlıdır, dövrə yoxdur');
{
  ok(FIELD.edges.every((e) => fieldNode(e.a) && fieldNode(e.b)),
     'hər kənarın iki ucu da düyündür');
  // A tree with n nodes has exactly n−1 edges. If that ever stops being true
  // the planner's "there is only one route" reasoning stops being true too.
  ok(FIELD.edges.length === FIELD.nodes.length - 1,
     `${FIELD.nodes.length} düyün, ${FIELD.edges.length} kənar — ağac`);
  ok(FIELD.nodes.every((n) => fieldPlan('START', n.id).length > 0),
     'başlanğıcdan hər düyünə yol var');
}

console.log('\nMarşrut — A1, A2, A3 bir-birindən yalnız dönüşlə seçilir');
{
  // The rover starts in the area facing the junction, which is north.
  const j1 = fieldJunctions(fieldPlan('START', 'A1'), 0);
  ok(j1.length === 1 && j1[0].id === 'J1' && j1[0].act === 'straight',
     'A1: birinci qovşaqdan düz keç');

  const j2 = fieldJunctions(fieldPlan('START', 'A2'), 0);
  ok(j2.map((j) => `${j.id}:${j.act}`).join(' ') === 'J1:right J2:left',
     `A2: ${j2.map((j) => `${j.id}:${j.act}`).join(' ')}`);

  const j3 = fieldJunctions(fieldPlan('START', 'A3'), 0);
  ok(j3.map((j) => `${j.id}:${j.act}`).join(' ') === 'J1:right J2:straight J3:left',
     `A3: ${j3.map((j) => `${j.id}:${j.act}`).join(' ')}`);

  // The distances are what makes a sighting checkable, so they have to be
  // increasing and they have to be the map's, not the plan's order.
  ok(j3.every((j, i) => i === 0 || j.at > j3[i - 1].at), 'qovşaqlar sıra ilə uzaqlaşır');
  ok(near(j3[0].at, fieldSpan('START', 'J1')), 'birinci qovşaq 2.45 m-də');

  // Every drop point is reached through the gate, and the gate is a place the
  // run can be made to wait — so it must appear in the list, not be skipped
  // for having no branch.
  const jb = fieldJunctions(fieldPlan('A2', 'B1'), 180);
  ok(jb.some((j) => j.id === 'KAPI'), `B1 marşrutunda qapı var (${jb.map((j) => j.id).join(' ')})`);
  ok(jb[jb.length - 1].act === 'right', 'B1 üçün J4-də sağa');
  ok(fieldJunctions(fieldPlan('A2', 'B3'), 180).pop().act === 'left', 'B3 üçün J4-də sola');
  ok(fieldJunctions(fieldPlan('A2', 'B2'), 180).pop().act === 'straight', 'B2 üçün J4-dən düz');
}

console.log('\nİstiqamət — sağ müsbətdir, həmişə');
{
  ok(fieldBearing('J1', 'J2') === 90, 'J1→J2 şərqə');
  ok(fieldBearing('J1', 'A1') === 0, 'J1→A1 şimala');
  ok(fieldBearing('J1', 'START') === 180, 'J1→başlanğıc cənuba');
  ok(fieldTurn(0, 90) === 90 && fieldTurn(90, 0) === -90, 'sağ +, sol −');
  ok(fieldTurn(350, 10) === 20, '0-dan keçəndə də');
  ok(fieldTurn(0, 180) === 180 || fieldTurn(0, 180) === -180, 'geriyə dönüş ±180');
}

console.log('\nHesablama — kvadrat qapanır');
{
  // 1 m forward, pivot 90° right, four times. Straight-line driving and a
  // turn on the spot are the only two things the rover does, so between them
  // they are the whole model.
  const st = fieldState('J1', 0);
  const arc = (FIELD_TRACK_M * Math.PI / 2) / 2 * 1000;   // mm per wheel for 90°
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 10; k++) fieldStep(st, 100, 100);  // 1 m in 10 chunks
    for (let k = 0; k < 10; k++) fieldStep(st, arc / 10, -arc / 10);
  }
  const j1 = fieldNode('J1');
  ok(near(st.x, j1.x, 0.02) && near(st.y, j1.y, 0.02),
     `kvadrat qapandı: ${st.x.toFixed(3)}, ${st.y.toFixed(3)}`);
  ok(near(((st.h % 360) + 360) % 360, 0, 1) || near(st.h, 360, 1), 'istiqamət geri qayıtdı');
  ok(near(st.dist, 4, 0.01), `dörd metr sürüldü (${st.dist.toFixed(2)})`);
}

console.log('\nHesablama — sol təkər sürətlidirsə burun sağa');
{
  const st = fieldState('J1', 0);
  fieldStep(st, 100, 50);
  ok(st.h > 0 && st.h < 90, `sağa döndü (${st.h.toFixed(1)}°)`);
  ok(st.x > fieldNode('J1').x, 'və şərqə sürüşdü');

  const st2 = fieldState('J1', 0);
  fieldStep(st2, 50, 100);
  ok(st2.h > 270, `sağ təkər sürətlidirsə sola (${st2.h.toFixed(1)}°)`);
}

console.log('\nLövbər — sürüşməni ortalamır, atır');
{
  // Drive from J1 towards J2 with the left wheel 4 % long: by J2 the rover
  // thinks it is a good way off the line. Anchoring is a measurement, so it
  // must land exactly on the node, not somewhere between the two opinions.
  const st = fieldState('J1', 90);
  const n = 200, per = fieldSpan('J1', 'J2') * 1000 / n;
  for (let i = 0; i < n; i++) fieldStep(st, per * 1.04, per);
  const j2 = fieldNode('J2');
  const drift = Math.hypot(st.x - j2.x, st.y - j2.y);
  ok(drift > 0.05, `sürüşmə yığıldı (${(drift * 100).toFixed(1)} sm)`);
  ok(st.run > 0, 'qovşaqdan bəri məsafə sayılır');

  fieldAnchor(st, 'J2', 0);
  ok(st.x === j2.x && st.y === j2.y, 'lövbər tam qovşağın üstünə qoyur');
  ok(st.h === 0 && st.at === 'J2', 'istiqamət də ayağa oturur');
  ok(st.run === 0, 'sayğac sıfırlanır');
  ok(fieldPose(st).dist > 1, 'ümumi məsafə isə sıfırlanmır');
}

console.log('\nGeri sürsə sayğac geri gedir');
{
  const st = fieldState('J1', 90);
  fieldStep(st, 500, 500);
  fieldStep(st, -500, -500);
  ok(near(st.run, 0, 0.001), 'qovşaqdan bəri məsafə sıfıra qayıtdı');
  ok(near(st.dist, 1, 0.001), 'odometr isə 1 m saydı');
}

console.log(`\n${fail ? 'FAILED' : 'ALL CHECKS PASSED'} — ${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
