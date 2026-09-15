/**
 * The factory automation PLC: packets, mission, UDP link, and both servers.
 *
 * The bytes first, because they are the part that is silently wrong: a Y that
 * goes out big-endian is a robot the PLC sees at -115 m, and nothing on the
 * robot side notices. Then the mission, played through the real field model
 * with the real QR texts — a whole lap, door both ways — so "robot stops at the
 * door" is checked against the codes that are actually taped to the floor.
 * Then the link against the simulator over real UDP, and last a server of each
 * kind with the simulator inside it.
 *
 *   node test/test_plc.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

import { loadShared } from '../shared.js';
import { PlcLink, parsePlcAddr } from '../plc_link.js';
import { PlcSim } from '../plc_sim.js';

const P = loadShared('plc.js', [
  'PLC_HOST', 'PLC_PORT', 'PLC_ROBOT_IP', 'PLC_CODE_LABEL', 'plcEncodeTx', 'plcDecodeTx',
  'plcEncodeRx', 'plcDecodeRx', 'plcHex', 'plcMission', 'plcMissionCode', 'plcMissionHold',
  'plcMissionRx', 'plcMissionFix', 'plcMissionEvent', 'plcMissionTick', 'plcTxFields',
  'plcMissionStatus',
]);
const F = loadShared('field.js', ['FIELD', 'FIELD_DENEME', 'fieldState', 'fieldSee',
                                  'fieldMission']);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };

// ══ the packets ══════════════════════════════════════════════════════
console.log('\nPAKET_TX — 7 bayt, koordinatlar int16 little endian');
{
  const b = P.plcEncodeTx({ code: 4, a: 2, b: 3, x: 6.6, y: 4.5 });
  ok(b.length === 7, 'yedi bayt');
  ok(P.plcHex(b) === '04 02 03 94 02 c2 01', `baytlar şartnamedeki sırada  (${P.plcHex(b)})`);
  // 6.6 m → 660 = 0x0294: LSB first.
  ok(b[3] === 0x94 && b[4] === 0x02, 'X = integer(6.6 × 100) = 660, önce LSB');
  ok(b[5] === 0xc2 && b[6] === 0x01, 'Y = 450, önce LSB');

  const back = P.plcDecodeTx(b);
  ok(back.ok && back.code === 4 && back.a === 2 && back.b === 3 && back.x === 6.6 && back.y === 4.5,
     'geri okununca aynı değerler');
  const neg = P.plcDecodeTx(P.plcEncodeTx({ code: 1, x: -1.25, y: 0 }));
  ok(neg.xRaw === -125, 'negatif koordinat iki tümleyenle  (−1.25 m → −125)');
  ok(P.plcDecodeTx(P.plcEncodeTx({ code: 1, x: 400 })).xRaw === 32767, 'int16 sınırında kırpılıyor');
  ok(P.plcDecodeTx(P.plcEncodeTx({ code: 1, x: 0.019 })).xRaw === 1,
     'integer() kesiyor, yuvarlamıyor  (0.019 m → 1)');
  ok(P.plcDecodeTx(P.plcEncodeTx({ code: 1, x: 0.29, y: 11.57 })).xRaw === 29
     && P.plcDecodeTx(P.plcEncodeTx({ code: 1, x: 0.29, y: 11.57 })).yRaw === 1157,
     'kayan nokta kesmeyi bozmuyor  (0.29 × 100 = 28.999… → yine 29)');
  ok(P.plcDecodeTx(Uint8Array.from([9, 0, 0, 0, 0, 0, 0])).ok === false, 'durum 9 geçersiz');
  ok(P.plcDecodeTx(Uint8Array.from([1, 2, 3])) === null, 'yedi bayttan kısa paket okunmuyor');
  ok(Object.keys(P.PLC_CODE_LABEL).length === 8, 'sekiz durum kodu');
}

console.log('\nPAKET_RX — 3 bayt');
{
  const r = P.plcDecodeRx(P.plcEncodeRx({ a: 3, b: 1, control: 2 }));
  ok(r.ok && r.a === 3 && r.b === 1 && r.control === 2, 'A3 → B1, kontrol 2');
  ok(P.plcDecodeRx(Uint8Array.from([0, 0, 1])).ok && P.plcDecodeRx(Uint8Array.from([0, 0, 1])).a === null,
     'istasyon 0 = henüz görev yok');
  ok(P.plcDecodeRx(Uint8Array.from([4, 1, 1])).ok === false, 'A4 reddediliyor');
  ok(P.plcDecodeRx(Uint8Array.from([1, 1, 3])).ok === false, 'kontrol 3 reddediliyor');
  ok(P.plcDecodeRx(Uint8Array.from([1, 1])).ok === false, 'iki bayt reddediliyor');
  ok(P.plcDecodeRx(Uint8Array.from([1, 1, 2, 0])).ok === false, 'dört bayt reddediliyor');
}

console.log('\nAdres ayarları');
{
  ok(P.PLC_HOST === '192.168.100.100' && P.PLC_PORT === 1515, 'PLC 192.168.100.100:1515');
  ok(P.PLC_ROBOT_IP === '192.168.100.10', 'robot 192.168.100.10');
  const d = parsePlcAddr(true);
  ok(d.host === '192.168.100.100' && d.port === 1515, '--plc tek başına şartnamedeki adres');
  const e = parsePlcAddr('127.0.0.1:1600');
  ok(e.host === '127.0.0.1' && e.port === 1600, '--plc 127.0.0.1:1600');
  ok(parsePlcAddr('10.0.0.5').port === 1515, 'port verilmezse 1515');
}

// ══ the mission, against the real field ══════════════════════════════
/** A robot on paper: the mission, the field it plans on, and a read. */
function paperRobot(map = F.FIELD) {
  const ms = P.plcMission();
  const st = F.fieldState();
  const rx = (a, b, control, replyTo) => {
    const out = P.plcMissionRx(ms, { ok: true, a, b, control, replyTo }, 0);
    if (out.plan) F.fieldMission(st, out.plan, map, 'START');
    return out;
  };
  const see = (text) => {
    const fix = F.fieldSee(st, text, 0, map, null);
    P.plcMissionFix(ms, fix, 0);
    return fix;
  };
  return { ms, st, rx, see, code: () => P.plcMissionCode(ms), hold: () => P.plcMissionHold(ms) };
}

console.log('\nGörev: PLC görevi verir, robot başlat komutunu bekler');
{
  const r = paperRobot();
  ok(r.code() === 1 && !r.hold(), 'başta hazır (1), tutulmuyor');
  ok(P.plcTxFields(r.ms).a === 0 && P.plcTxFields(r.ms).b === 0, 'görev yokken alım/bırakma 0');

  const out = r.rx(2, 3, 1, 1);
  ok(out.plan && out.plan.join(' ') === 'A2 B3 START', 'görev A2 → B3 → başlangıç olarak planlanıyor');
  ok(r.code() === 2 && !!r.hold(), 'görev alındı (2), robot tutuluyor');
  ok(r.st.plan.join('>') === 'START>D1>D2>A2>D2>D3>GATE>D4>B3>D4>GATE>D3>D2>D1>START',
     `rota sahada: ${r.st.plan.join('>')}`);
  const tx = P.plcTxFields(r.ms);
  ok(tx.code === 2 && tx.a === 2 && tx.b === 3, 'PAKET_TX görevi geri bildiriyor');

  r.rx(2, 3, 2, 1);
  ok(r.code() === 2, "hazır (1) paketine gelen kontrol 2 başlat sayılmıyor — soru 'görev alındı' değildi");
  r.rx(2, 3, 1, 2);
  ok(r.code() === 2, 'kontrol 1: beklemeye devam');
  r.rx(1, 3, 1, 2);
  ok(r.ms.task.a === 1 && r.st.plan.includes('A1'), 'başlamadan görev değişirse yeniden planlanıyor');
  r.rx(1, 3, 2, 2);
  ok(r.code() === 3 && !r.hold(), 'görev alındı paketine kontrol 2 → yüksüz hareket (3), serbest');
}

console.log('\nGörev: tam tur, kapıda iki yönde bekleme');
{
  const r = paperRobot();
  r.rx(2, 3, 2, 1); r.rx(2, 3, 2, 2);
  ok(r.code() === 3, 'yola çıktı');

  r.see('BASLA');
  r.see('ALIM2');
  ok(r.code() === 3 && r.st.to === 'A2', 'ALIM2 istasyona giderken okundu — hâlâ yüksüz');
  const back = r.see('ALIM2');
  ok(r.code() === 3, 'aynı yerde tekrar okunması yükü değiştirmiyor');
  // Now it has actually been to A2 and comes back past the same code.
  r.st.anchor = null;
  r.st.qr = null;
  const out = r.see('ALIM2');
  ok(out.from === 'A2' && r.code() === 4, `A2'den çıkarken ALIM2 → yüklü hareket (4)  (${back.from}→${back.to}, sonra ${out.from}→${out.to})`);

  const k1 = r.see('KAPI1');
  ok(k1.to === 'GATE' && r.code() === 5 && /kapı/.test(r.hold()),
     'KAPI1 kapıya doğru okundu → fabrika komutu bekleniyor (5), robot tutuluyor');
  r.rx(2, 3, 2, 4);
  ok(r.code() === 5, 'yüklü (4) paketine gelen kontrol 2 kapıyı açmıyor');
  r.rx(2, 3, 1, 5);
  ok(r.code() === 5, 'kapı sorusuna kontrol 1 → beklemeye devam');
  r.rx(2, 3, 2, 5);
  ok(r.code() === 4 && !r.hold(), 'kapı sorusuna kontrol 2 → yüklü harekete devam');
  r.see('KAPI1');
  ok(r.code() === 4, 'geçerken KAPI1 yeniden okunsa da ikinci kez durmuyor');
  r.see('KAPI2');
  ok(r.code() === 4, 'kapıdan sonra KAPI2 (kapıdan uzağa) durdurmuyor');

  r.see('BIRAK3');
  ok(r.code() === 4 && r.st.to === 'B3', 'BIRAK3 B3e giderken');
  r.st.qr = null;
  r.see('BIRAK3');
  ok(r.st.from === 'B3' && r.code() === 6, "B3'ten çıkarken BIRAK3 → dönüş (6)");

  const k2 = r.see('KAPI2');
  ok(k2.to === 'GATE' && r.code() === 5, 'dönüşte KAPI2 kapıya doğru → yine bekleme (5)');
  r.rx(2, 3, 2, 5);
  ok(r.code() === 6, 'kontrol 2 → dönüşe devam');
  r.see('KAPI1');
  r.see('BASLA');
  ok(r.ms.homing && r.code() === 6, 'BASLA başlangıca doğru okundu — hâlâ dönüşte');
  P.plcMissionTick(r.ms, { armed: true }, 0);
  ok(r.code() === 6, 'robot hâlâ sürüyorsa tur bitmedi');
  P.plcMissionTick(r.ms, { armed: false }, 0);
  ok(r.code() === 1 && r.ms.task === null, 'başlangıçta durunca göreve hazır (1)');

  // The PLC has not caught up yet and is still naming the same task.
  r.rx(2, 3, 2, 1);
  ok(r.code() === 1, 'biten görev PLC tekrar söylese de ikinci kez alınmıyor');
  r.rx(2, 3, 1, 1);
  r.rx(2, 3, 2, 1);
  ok(r.code() === 2, 'PLC bekle dedikten sonra aynı görev yeniden alınabiliyor');
}

console.log('\nGörev: düğmeler, acil stop, hata');
{
  const r = paperRobot();
  r.rx(1, 2, 2, 1); r.rx(1, 2, 2, 2);
  ok(P.plcMissionEvent(r.ms, 'dropped') === false, 'yük alınmadan «bırakıldı» yok sayılıyor');
  ok(P.plcMissionEvent(r.ms, 'picked') && r.code() === 4, '«yük alındı» → 4');
  ok(P.plcMissionEvent(r.ms, 'dropped') && r.code() === 6, '«yük bırakıldı» → 6');

  P.plcMissionEvent(r.ms, 'estop');
  ok(r.code() === 8 && r.hold() === 'acil stop', 'acil stop → 8, robot tutuluyor');
  r.rx(1, 2, 2, 8);
  ok(r.ms.phase === 'returning', 'acil stoptayken PLC komutları görevi ilerletmiyor');
  P.plcMissionEvent(r.ms, 'release');
  ok(r.code() === 6 && !r.hold(), 'acil stop kalkınca kaldığı yerden');

  P.plcMissionTick(r.ms, { armed: true, fault: 'esp32 erişilemiyor' }, 0);
  ok(r.code() === 7, 'sürüş kartına erişilemiyor → hata (7)');
  P.plcMissionTick(r.ms, { armed: true, fault: null }, 0);
  ok(r.code() === 6, 'hata giderilince dönüş kodu geri geliyor');
  P.plcMissionTick(r.ms, { pose: { known: true, x: 11.5, y: 6 } }, 0);
  ok(P.plcTxFields(r.ms).x === 11.5 && P.plcTxFields(r.ms).y === 6, 'PAKET_TX sahadaki konumu taşıyor');

  P.plcMissionEvent(r.ms, 'home');
  ok(r.code() === 1, '«başlangıca vardı» → 1');
  const s = P.plcMissionStatus(r.ms, 0);
  ok(s.events.length > 5 && s.label === 'Göreve hazır bekleme durumu', 'durum özeti ve olay günlüğü');
}

console.log('\nGörev: deneme alanında');
{
  const r = paperRobot(F.FIELD_DENEME);
  r.rx(1, 1, 2, 1); r.rx(1, 1, 2, 2);
  ok(r.st.plan.join('>') === 'START>D1>A1>D1>GATE>D4>B1>D4>GATE>D1>START', 'deneme alanında rota');
  P.plcMissionEvent(r.ms, 'picked');
  const k = r.see('KAPI1');
  ok(k.to === 'GATE' && r.code() === 5, 'deneme alanında da KAPI1 kapıda durduruyor');
}

// ══ the link, over real UDP ══════════════════════════════════════════
console.log('\nUDP: bağlantı ↔ simülatör');
{
  const sim = new PlcSim({ host: '127.0.0.1', port: 0, gateWaitMs: 400 }).start();
  await sleep(150);
  const port = sim.sock.address().port;
  let code = 1;
  const rxs = [];
  const link = new PlcLink({ host: '127.0.0.1', port, periodMs: 100,
    getTx: () => ({ code, a: 0, b: 0, x: 1.9, y: 1.3 }) }).onRx((rx) => rxs.push(rx));
  link.start();
  await sleep(560);
  const s = link.status();
  ok(s.bound && s.connected, 'bağlandı, cevap geliyor');
  ok(s.tx_count >= 5 && s.tx_count <= 7, `sabit saatle gönderiyor  (${s.tx_count} paket / 560 ms, 100 ms aralık)`);
  ok(rxs.length >= 4 && rxs[0].ok && rxs[0].a === 1 && rxs[0].control === 2,
     'simülatör hazır robota görev ve başlat veriyor');
  ok(rxs.every((r) => r.replyTo === 1), 'her cevap hangi duruma cevap olduğunu biliyor');
  ok(sim.status().max_gap_ms < 200 && sim.status().timeouts === 0, `simülatör zaman aşımı görmedi  (en uzun ara ${sim.status().max_gap_ms} ms)`);
  const last = sim.status().last;
  ok(last.x === 1.9 && last.y === 1.3, 'simülatör koordinatı doğru okudu');

  code = 5;
  await sleep(250);
  ok(link.status().rx.control === 1 && link.status().rx.replyTo === 5, 'kapıda: önce bekle');
  await sleep(500);
  ok(link.status().rx.control === 2, `kapı açıldı: devam  (${sim.cfg.gateWaitMs} ms sonra)`);

  sim.set({ auto: false, a: 3, b: 2, control: 1 });
  await sleep(250);
  ok(link.status().rx.a === 3 && link.status().rx.b === 2 && link.status().rx.control === 1,
     'elle modda simülatör ayarlanan cevabı veriyor');

  link.close();
  await sleep(1500);
  ok(sim.status().lost && sim.status().timeouts === 1, "robot susunca simülatör 1 s'de bağlantı koptu diyor");
  sim.close();

  // A socket bound to an address this machine does not have: said plainly.
  const bad = new PlcLink({ host: '127.0.0.1', port: 9, bind: '192.0.2.77', retryMs: 60000 });
  bad.start();
  await sleep(300);
  ok(!bad.status().bound && /192\.0\.2\.77/.test(bad.status().error || ''),
     `olmayan yerel adres anlaşılır hata veriyor  (${bad.status().error})`);
  bad.close();
}

// ══ both servers ═════════════════════════════════════════════════════
function serve(argv) {
  const proc = spawn('node', ['server.js', ...argv], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  proc.stdout.on('data', (d) => { out.text += d; });
  proc.stderr.on('data', (d) => { out.text += d; });
  return { proc, out };
}

function client(url) {
  const ws = new WebSocket(url);
  const got = { last: null };
  ws.on('message', (d) => {
    try { const m = JSON.parse(d.toString()); if (m.type === 'status') got.last = m; } catch { /* not json */ }
  });
  const open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return { ws, got, open, send: (o) => ws.send(JSON.stringify(o)) };
}

async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); }
  return false;
}

console.log('\nESP32 sunucusu, içinde PLC simülatörü: kapıda tekerlekler duruyor');
{
  const srv = serve(['--fake', '--http', '18195', '--host', '127.0.0.1', '--no-camera',
                     '--no-advertise', '--plc-sim', '18515']);
  await sleep(1500);
  try {
    const c = client('ws://127.0.0.1:18195/');
    await c.open;
    const code = () => c.got.last && c.got.last.plc && c.got.last.plc.mission.code;
    ok(await until(() => code() === 3, 5000), 'simülatör görevi verdi, başlat dedi → 3');
    const m = c.got.last.plc.mission;
    ok(m.task && m.task.a === 1 && m.task.b === 1, 'görev A1 → B1');
    ok(c.got.last.field.plan.includes('A1') && c.got.last.field.plan.includes('B1'), 'saha rotası kuruldu');
    ok(/SİMÜLATÖR/.test(srv.out.text) && /plc: görev alındı/.test(srv.out.text), 'konsol durumu yazıyor');

    c.send({ cmd: 'start' });
    c.send({ cmd: 'field_qr', text: 'BASLA' });
    c.send({ cmd: 'plc', event: 'picked' });
    ok(await until(() => code() === 4, 2000), '«yük alındı» → 4');
    c.send({ cmd: 'field_qr', text: 'KAPI1' });
    ok(await until(() => code() === 5, 2000), 'KAPI1 → 5');
    ok(await until(() => /kapı/.test(c.got.last.reason || ''), 1000),
       `sürüş katmanı tutuyor  (sebep: «${c.got.last.reason}»)`);
    ok(c.got.last.out && c.got.last.out[0] === 0 && c.got.last.out[1] === 0, 'çıkışlar sıfır');
    ok(await until(() => code() === 4, 6000), 'simülatör kapıyı açtı → 4');
    ok(!/kapı/.test(c.got.last.reason || ''), 'tutma kalktı');

    c.send({ cmd: 'plc', event: 'estop' });
    ok(await until(() => code() === 8, 1500), 'acil stop → 8');
    ok(await until(() => c.got.last.plc.link.tx && c.got.last.plc.link.tx.code === 8, 2500),
       'PAKET_TX acil stopu PLCye iletti');
    ok(c.got.last.running === false, 'acil stop sürüşü de kapattı');
    c.ws.close();

    const page = await fetch('http://127.0.0.1:18195/plc');
    ok(page.status === 200 && /Fabrika otomasyonu/.test(await page.text()), '/plc sayfası sunuluyor');
    const api = await (await fetch('http://127.0.0.1:18195/api/plc')).json();
    ok(api.mission && api.link.enabled && api.sim, '/api/plc durumu veriyor');
  } finally {
    srv.proc.kill();
  }
}

console.log('\nEnder (Marlin) sunucusu: kart yokken hata, tutulurken klavye de reddediliyor');
{
  const srv = serve(['--marlin', '--no-connect', '--http', '18196', '--host', '127.0.0.1',
                     '--no-camera', '--no-advertise', '--plc-sim', '18516', '--field', 'deneme']);
  await sleep(1500);
  try {
    const c = client('ws://127.0.0.1:18196/');
    await c.open;
    ok(await until(() => c.got.last && c.got.last.plc && c.got.last.plc.link.rx_count > 0, 3000),
       'Marlin tarafında da PLC bağlantısı çalışıyor');
    const s = c.got.last;
    ok(s.plc.mission.code === 7 && /motor kartı/.test(s.plc.mission.fault || ''),
       'motor kartı bağlı değil → hata (7)');
    ok(s.field && s.field.map === 'deneme', '--field deneme seçildi');
    ok(s.plc.mission.pose.x === 1.2 && s.plc.mission.pose.known === false,
       'QR okunmadan konum başlangıç alanı olarak bildiriliyor, tahmin diye işaretli');
    ok(await until(() => c.got.last.plc.mission.phase === 'accepted', 3000), 'görev alındı');
    ok(await until(() => c.got.last.hold && /başlat/.test(c.got.last.hold), 1500),
       `rover tutuluyor  («${c.got.last.hold}»)`);
    const run = await fetch('http://127.0.0.1:18196/api/marlin/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 1 }) });
    ok(run.status === 423, `tutulurken WASD sürüşü reddediliyor  (HTTP ${run.status})`);
    c.send({ cmd: 'field_qr', text: 'BASLA' });
    ok(await until(() => c.got.last.field.qr === 'q1' && c.got.last.field.text === 'BASLA', 1500),
       'Marlin tarafında QR sahaya işleniyor');
    c.ws.close();
  } finally {
    srv.proc.kill();
  }
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail` : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
