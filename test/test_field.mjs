/**
 * Field checks — the map, the QR localisation, and the turns it hands out.
 *
 * `field.js` is pure, so the whole of a run can be played out here as a list of
 * codes: "read q1, then q3" is a robot that left the start area and drove up to
 * A2, and every claim it makes on the way — which leg it is on, which way it is
 * pointing, what it does at the next junction — is arithmetic with a known
 * answer.
 *
 * The parts worth being strict about are the ones that are silently wrong on a
 * real field rather than loudly wrong:
 *
 *   - a QR names an edge, not a direction. Getting the direction backwards puts
 *     the robot in exactly the right place pointing exactly the wrong way, and
 *     the very next instruction sends it back where it came from.
 *   - the pose between codes is dead reckoning in a frame that starts wherever
 *     the run started. If the rotation at the anchor is wrong, the map looks
 *     fine at every QR and drifts sideways in between.
 *
 *   node test/test_field.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (file, names) => new Function(
  `${readFileSync(join(here, '..', 'public', file), 'utf8')}
   return { ${names.join(', ')} };`)();

const { FIELD, fieldNode, fieldEdge, fieldQrId, fieldQr, fieldQrs, fieldBearing,
        fieldDist, fieldTurn, fieldPath, fieldPlan, fieldLegs, fieldState,
        fieldSee, fieldMission, fieldPose, fieldStatus, fieldBounds } =
  load('field.js', ['FIELD', 'fieldNode', 'fieldEdge', 'fieldQrId', 'fieldQr',
                    'fieldQrs', 'fieldBearing', 'fieldDist', 'fieldTurn',
                    'fieldPath', 'fieldPlan', 'fieldLegs', 'fieldState', 'fieldSee',
                    'fieldMission', 'fieldPose', 'fieldStatus', 'fieldBounds']);
// Dead reckoning, to drive the pose between codes with the real integrator
// rather than with numbers typed to make the test pass.
const { routeState, routeStep, routeBearing } =
  load('route.js', ['routeState', 'routeStep', 'routeBearing']);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const near = (a, b, eps, m) =>
  ok(Math.abs(a - b) <= eps, `${m}  (${(+a).toFixed(2)} ≈ ${(+b).toFixed(2)})`);

// ── the map is the map ───────────────────────────────────────────────
console.log('\nSaha şemadaki gibi');
{
  const ids = FIELD.nodes.map((n) => n.id);
  for (const want of ['START', 'A1', 'A2', 'A3', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6',
                      'GATE', 'B1', 'B2', 'B3']) {
    ok(ids.includes(want), `${want} haritada`);
  }
  ok(new Set(ids).size === ids.length, 'düğüm adları tekrarlanmıyor');

  const qrs = fieldQrs().map((q) => q.qr);
  ok(qrs.length === 9, `dokuz QR var  (${qrs.join(' ')})`);
  ok(new Set(qrs).size === qrs.length, 'aynı QR iki kenara konmamış');
  for (let i = 1; i <= 9; i++) ok(qrs.includes(`q${i}`), `q${i} bir kenarın üzerinde`);

  // Every edge has to join two nodes that exist, or the planner walks off it.
  const bad = FIELD.edges.filter((e) => !fieldNode(e.a) || !fieldNode(e.b));
  ok(bad.length === 0, `her kenar var olan düğümleri birleştiriyor  (${FIELD.edges.length} kenar)`);

  // The layout from test.png: the D corridor is one straight line, and the
  // pickups sit directly above the first three of its nodes.
  ok(['D1', 'D2', 'D3', 'GATE', 'D4'].every((id) => fieldNode(id).y === 0),
     'D1…D4 ve kapı aynı koridorda');
  ok(fieldNode('A2').x === fieldNode('D2').x, 'A2 doğrudan D2 üzerinde');
  ok(fieldNode('B1').y === fieldNode('D5').y && fieldNode('B3').y === fieldNode('D6').y,
     'B1 D5 ile, B3 ise D6 ile karşı karşıya');
  ok(fieldNode('GATE').kind === 'gate', 'kapı ayrı bir tür — orada beklenebilir');
}

console.log("\nQR metni id'ye çevriliyor");
{
  ok(fieldQrId('q5') === 'q5', '«q5»');
  ok(fieldQrId('Q5') === 'q5', 'büyük harf');
  ok(fieldQrId(' qr5 ') === 'q5', '«qr5», boşluklarla');
  ok(fieldQrId('q-5') === 'q5', 'tire');
  ok(fieldQrId('https://saha.local/qr/5') === 'q5', 'url sonundaki numara');
  ok(fieldQrId('5') === 'q5', 'yalnızca numara');
  ok(fieldQrId('q12') === null, 'sahada olmayan numara tanınmıyor');
  ok(fieldQrId('salam') === null, 'rakamsız metin tanınmıyor');
  ok(fieldQrId(null) === null, 'boş metin tanınmıyor');

  // The dangerous half: anything that ends in a digit is not a waypoint. A
  // pallet label read as q9 puts the robot at the other end of the arena and
  // it will be very sure about it.
  ok(fieldQrId('kargo-9') === null, '«kargo-9» yük etiketidir, yol işareti değil');
  ok(fieldQrId('palet 7') === null, '«palet 7» tanınmıyor');
  ok(fieldQrId('BOX-2024-3') === null, 'sonu rakamla biten kod tanınmıyor');
  ok(fieldQrId('iraq5') === null, 'kelimenin kuyruğundaki q sayılmıyor');
}

console.log('\nAçılar ve dönüşler');
{
  near(fieldBearing('D1', 'D2'), 90, 0.01, 'D1→D2 doğuya bakıyor');
  near(fieldBearing('D1', 'A1'), 0, 0.01, 'D1→A1 kuzeye bakıyor');
  near(fieldBearing('D4', 'D6'), 180, 0.01, 'D4→D6 güneye bakıyor');
  near(fieldDist('D1', 'D2'), 1.5, 0.001, 'D1 ile D2 arası 1.5 m');

  ok(fieldTurn(90, 0).dir === 'left', 'doğudan kuzeye — sola');
  ok(fieldTurn(90, 180).dir === 'right', 'doğudan güneye — sağa');
  ok(fieldTurn(90, 90).dir === 'straight', 'aynı yön — düz');
  ok(fieldTurn(90, 270).dir === 'back', 'ters yön — geri');
  // The dead band: a field measured with a tape is not a field measured to the
  // degree, and "sağa 4°" is not an instruction anybody can follow.
  ok(fieldTurn(90, 104).dir === 'straight', '14° hâlâ düz sayılır');
  ok(fieldTurn(0, 359).dir === 'straight', 'sıfırdan geçerken fark düz sayılır');
}

console.log('\nRota kuruluyor');
{
  ok(fieldPath('START', 'D1').join('>') === 'START>D1', 'komşu düğümler');
  ok(fieldPath('D1', 'D1').join('>') === 'D1', 'zaten oradasın');
  ok(fieldPath('START', 'YOX').length === 0, 'olmayan hedef için rota yok');
  ok(fieldPath('START', 'A2').join('>') === 'START>D1>D2>A2', 'başlangıçtan A2ye');
  ok(fieldPath('START', 'B3').join('>') === 'START>D1>D2>D3>GATE>D4>D6>B3',
     `başlangıçtan B3e kapıdan geçiyor  (${fieldPath('START', 'B3').join('>')})`);

  const p = fieldPlan('START', ['A2', 'B3']);
  ok(p.ok && p.nodes[0] === 'START' && p.nodes[p.nodes.length - 1] === 'B3',
     `tam görev: ${p.nodes.join('>')}`);
  ok(p.nodes.filter((n) => n === 'A2').length === 1,
     'A2 rotada bir kez yazılıyor — birleşme noktası tekrarlanmıyor');
  ok(p.nodes.includes('GATE'), 'Bye giden yol kapıdan geçiyor');
  ok(fieldPlan('START', ['YOX']).ok === false, 'ulaşılamayan hedef açıkça başarısız');

  // The turn is attached to the node being arrived at, which is the node the
  // QR on the leg being driven announces.
  const legs = fieldLegs(fieldPath('D1', 'A2'));
  ok(legs.length === 2, 'D1→A2 iki adım');
  ok(legs[0].from === 'D1' && legs[0].to === 'D2' && legs[0].turn.dir === 'left',
     `D2de sola dönülüyor  (${legs[0].turn.deg}°)`);
  ok(legs[0].qr === null && legs[1].qr === 'q3', 'A2 kolunun üzerindeki QR q3');
  ok(legs[1].turn === null, 'son adımdan sonra dönüş yok');
}

// ── localisation ─────────────────────────────────────────────────────
console.log('\nQR okunduğunda robot nerede olduğunu bilir');
{
  const st = fieldState();
  const r = fieldSee(st, 'q1', 1000);
  ok(r.ok && r.qr === 'q1', 'q1 tanındı');
  near(r.x, 0, 0.01, 'q1 D1 ile aynı sütunda');
  ok(r.y > -1.6 && r.y < 0, 'q1 başlangıç alanı ile D1 arasında');
  ok(r.sure === false, 'plan yoksa ilk kodda yön tahmindir — ve bu söylenir');

  // Second code: continuity decides the direction with no plan at all. The
  // robot was heading for D1; q3 is on the A2 branch, which does not touch D1,
  // so continuity cannot help and it stays unsure.
  const st2 = fieldState();
  fieldMission(st2, ['A2'], null, 'START');
  ok(st2.plan.join('>') === 'START>D1>D2>A2', 'görev başlangıçtan planlandı');
  const a = fieldSee(st2, 'q1', 1000);
  ok(a.ok && a.from === 'START' && a.to === 'D1' && a.sure,
     'plan sayesinde yön kesin: START→D1');
  ok(a.onPlan, 'q1 rotanın üzerinde');
  ok(a.turn && a.turn.node === 'D1' && a.turn.dir === 'right',
     `D1de sağa dönmek gerekiyor  (${a.turn && a.turn.deg}°)`);

  const b = fieldSee(st2, 'q3', 2000);
  ok(b.from === 'D2' && b.to === 'A2', 'q3 okunduğunda D2→A2 etabında');
  ok(b.turn && b.turn.dir === 'arrive', 'A2 planın sonu — «varış»');
  near(b.bearing, 0, 0.01, 'A2ye kuzeye doğru gidiliyor');
}

console.log('\nGeri dönerken aynı kod ters yönde okunuyor');
{
  // The mission doubles back: START → A2 → B3 drives D2 → A2 and then A2 → D2,
  // and both legs carry q3. Only the direction of travel tells them apart, and
  // getting it wrong here sends the robot back up the branch it just came down.
  const st = fieldState();
  fieldMission(st, ['A2', 'B3'], null, 'START');
  const there = fieldSee(st, 'q3', 1000, null, { x: 0, y: 0, bearing: 0 });
  ok(there.from === 'D2' && there.to === 'A2', 'gidişte q3 D2→A2');

  // Same code again from the same spot: one sign seen twice, nothing changed.
  const again = fieldSee(st, 'q3', 3000, null, { x: 0.1, y: 0, bearing: 0 });
  ok(again.from === 'D2' && again.to === 'A2',
     'yerinden kımıldamadan tekrar okunduğunda yön değişmiyor');

  // And now with a couple of metres of driving in between: it went into A2,
  // turned round, and is coming back past the same sign.
  const back = fieldSee(st, 'q3', 9000, null, { x: 2.4, y: 0, bearing: 0 });
  ok(back.from === 'A2' && back.to === 'D2', 'dönüşte q3 A2→D2');
  ok(back.onPlan, 'dönüş etabı da rotanın üzerinde');
  ok(back.turn && back.turn.node === 'D2' && back.turn.then === 'D3',
     `D2de rota D3e devam ediyor  (${back.turn && back.turn.label})`);
}

console.log('\nPlan yoksa süreklilik yönü buluyor');
{
  const st = fieldState();
  fieldSee(st, 'q2', 1000);           // on the A1 branch, direction a guess: A1→D1
  ok(st.to === 'D1', 'q2 A1→D1 olarak okundu (kenarın yazıldığı yön)');
  const r = fieldSee(st, 'q1', 2000); // q1 touches D1, so it drove through D1
  ok(r.from === 'D1' && r.to === 'START' && r.sure,
     'D1den geçip başlangıca doğru gittiği süreklilikten çıkarıldı');
}

console.log('\nYabancı QR konumu bozmuyor');
{
  const st = fieldState();
  fieldSee(st, 'q5', 1000);
  const before = { from: st.from, to: st.to, anchor: st.anchor };
  const r = fieldSee(st, 'kargo-4471', 2000);
  ok(r.ok === false, 'sahaya ait olmayan kod kabul edilmiyor');
  ok(st.from === before.from && st.to === before.to && st.anchor === before.anchor,
     'eski konum olduğu gibi kalıyor');
  ok(st.strays === 1 && st.unknown === 'kargo-4471', 'tanınmayan kod ayrıca sayılıyor');
}

// ── the pose between codes ───────────────────────────────────────────
console.log('\nİki QR arasında konum hesaplanıyor, okununca düzeliyor');
{
  const st = fieldState();
  ok(fieldPose(st, null).known === false,
     'hiçbir şey okunmadıysa konum bilinmiyor — başlangıca çekilmiyor');

  // Dead reckoning that starts pointing at its own zero, drives 1 m forward.
  // The field says the robot was at q1 heading north (bearing 0) when the code
  // was read, so 1 m of "forward" has to come out 1 m north of q1 — whatever
  // the route's own frame thinks north is.
  const CALIB = { pct: 50, metres: 2, seconds: 4, dead: 0 };
  const rt = routeState(0);
  const step = (p25, p26, secs, t0, rev = [false, false]) => {
    let t = t0;
    routeStep(rt, { p25, p26, rev, calib: CALIB, swap: false }, { track: 0.3 }, t);
    for (let i = 0; i < secs * 20; i++) {
      t += 50;
      routeStep(rt, { p25, p26, rev, calib: CALIB, swap: false }, { track: 0.3 }, t);
    }
    return t;
  };
  let t = step(0, 0, 0.2, 0);
  const snap = () => ({ x: rt.x, y: rt.y, bearing: routeBearing(rt) });

  fieldSee(st, 'q1', t, null, snap());          // anchor: q1, heading north
  const q1 = fieldQr('q1');
  t = step(50, 50, 2, t);                       // 0.5 m/s for 2 s = 1 m
  let pose = fieldPose(st, snap());
  ok(pose.known, 'konum biliniyor');
  near(pose.x, q1.x, 0.05, 'düz giderken doğuya kaymıyor');
  near(pose.y, q1.y + 1, 0.05, 'q1den 1 m kuzeyde');
  near(pose.dead, 1, 0.05, 'ölçülen koddan beri 1 m hesaplandı');

  // Now the same run, but the route frame is rotated: pivot 90° first, and the
  // anchor's rotation has to cancel it exactly.
  const st2 = fieldState();
  const rt2 = routeState(0);
  const step2 = (p25, p26, secs, t0, rev = [false, false]) => {
    let t2 = t0;
    routeStep(rt2, { p25, p26, rev, calib: CALIB, swap: false }, { track: 0.3 }, t2);
    for (let i = 0; i < secs * 20; i++) {
      t2 += 50;
      routeStep(rt2, { p25, p26, rev, calib: CALIB, swap: false }, { track: 0.3 }, t2);
    }
    return t2;
  };
  const snap2 = () => ({ x: rt2.x, y: rt2.y, bearing: routeBearing(rt2) });
  let t2 = step2(0, 0, 0.2, 0);
  // The robot happens to be pointing 90° away in its own frame when it reads a
  // code that says "you are on D1→D2, heading east".
  t2 = step2(50, 50, 1, t2);
  const stAt = fieldState();
  fieldMission(stAt, ['D3'], null, 'D1');
  fieldSee(stAt, 'q0-nonsense', t2, null, snap2());   // ignored
  fieldSee(stAt, 'q5', t2, null, snap2());
  ok(stAt.from === 'D3' && stAt.to === 'GATE', 'q5 D3→kapı etabı');
  const p0 = fieldPose(stAt, snap2());
  const spot5 = fieldQr('q5');
  near(p0.x, spot5.x, 0.001, "kod okunduğu anda konum tam QR'ın yeri");
  near(p0.y, spot5.y, 0.001, '...her iki eksende');
  near(p0.bearing, 90, 0.5, 've yön kenarın yönü');
  t2 = step2(50, 50, 2, t2);                    // another metre, still "forward"
  const p1 = fieldPose(stAt, snap2());
  near(p1.x, spot5.x + 1, 0.05, 'sonraki 1 m doğuya yazılıyor — çünkü etap doğuya gidiyor');
  near(p1.y, spot5.y, 0.05, 'kuzeye kayma yok');
}

console.log('\nDurum tek yerde toplanıyor');
{
  const st = fieldState();
  fieldMission(st, ['A3', 'B2'], null, 'START');
  fieldSee(st, 'q1', 1000);
  const s = fieldStatus(st, null);
  ok(s.qr === 'q1' && s.from === 'START' && s.to === 'D1', 'nerede olduğu yazılıyor');
  ok(s.turn && s.turn.dir === 'right', 'sıradaki dönüş yazılıyor');
  ok(s.plan.includes('A3') && s.plan.includes('B2'), 'rota her iki durağı geçiyor');
  ok(s.left[0] === 'D1', 'kalan düğümlerin ilki karşıdaki');
  ok(s.pose.known === true, 'konum biliniyor');

  const b = fieldBounds();
  ok(b.w > b.h && b.minX < 0 && b.maxX > 9, `saha geniş: ${b.w.toFixed(1)} × ${b.h.toFixed(1)} m`);
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
