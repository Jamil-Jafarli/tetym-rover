/**
 * The radar: every way a lidar might say where things are, read into one
 * distance per degree — and the real server's radar port answering all of
 * them: UDP, TCP, HTTP POST, WebSocket, and TLS under the last three.
 *
 * No lidar. The LD06 packets are built here (ld06Encode) and everything goes
 * over loopback, to a port of its own so a running server is never touched.
 *
 *   node test/test_radar.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { ScanDecoder, Radar, crc8, ld06Packet, ld06Encode, scn1Frame, scn1Encode } from '../radar.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (${JSON.stringify(a)})`);
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const B = (s) => Buffer.from(s);

console.log('\nLD06 / LD19 — 47 bayt, CRC-8');
{
  const dists = Array.from({ length: 12 }, (_, k) => 1000 + k * 10);
  const pkt = ld06Encode(10, 21, dists);
  eq(pkt.length, 47, 'paket 47 baytdır');
  eq(crc8(pkt, 0, 46), pkt[46], 'CRC son baytdadır');
  const p = ld06Packet(pkt);
  ok(p && p.points.length === 12, '12 nöqtə');
  ok(p && near(p.points[0].a, 10) && near(p.points[11].a, 21) && near(p.points[5].a, 15),
     'açılar başla–son arasında bərabər bölünür (10° … 21°)');
  eq(p && p.points.map((x) => x.d).slice(0, 3), [1000, 1010, 1020], 'məsafələr mm');
  const bad = Buffer.from(pkt); bad[10] ^= 0xff;
  eq(ld06Packet(bad), null, 'pozulmuş bayt → CRC tutur, paket atılır');
  const wrap = ld06Packet(ld06Encode(355, 6, dists));
  ok(wrap && near(wrap.points[11].a, 6) && near(wrap.points[1].a, 356),
     '360-dan keçən paket: 355° → 6°');

  const d = new ScanDecoder();
  eq(d.decode(pkt.subarray(0, 20)).length, 0, 'yarım paket: hələ heç nə');
  const got = d.decode(pkt.subarray(20));
  ok(got.length === 12 && got[0].d === 1000, 'ikinci yarı gələndə bütöv paket');
  eq(d.fmt, 'ld06', 'biçim: ld06');
  const junk = Buffer.concat([B('\x00\x13\x54\x99'), ld06Encode(100, 111, dists), ld06Encode(112, 123, dists)]);
  eq(new ScanDecoder().decode(junk).length, 24, 'zibildən sonra iki paket tapılır');
}

console.log('\nSCN1 — iPhone ARKit, 256 sütun');
{
  const d = Array(256).fill(0);
  d[0] = 3000; d[128] = 2000; d[255] = 1000;
  const pkt = scn1Encode(d, { seq: 657, ang: [0.25, 0.13, 0], t: 1789442478819.4, h32: 1.618 });
  eq(pkt.length, 560, '48 bayt başlıq + 256 × u16 = 560 (telefonun göndərdiyi kimi)');
  const f = scn1Frame(pkt);
  ok(f.seq === 657 && f.n === 256 && near(f.a[0], 0.25, 1e-6) && f.rot === 0 && f.quality === 1
     && near(f.h32, 1.618, 1e-6) && f.t === 1789442478819.4, 'başlıq: kadr, bucaqlar, vaxt, izləmə');
  ok(scn1Frame(pkt.subarray(0, 300)).need === 560, 'yarım kadr: 560 bayt lazımdır');

  const dec = new ScanDecoder();
  const p = dec.decode(pkt, true);
  eq(p.length, 3, 'yalnız sıfır olmayan sütunlar nöqtədir');
  eq(dec.fmt, 'scn1', 'biçim: scn1');
  ok(dec.pose && dec.pose.seq === 657, 'mövqe saxlanılır');
  const mid = p.find((x) => x.d < 2100);
  ok(mid && near(mid.a, 359.883, 0.002) && mid.d === 2000, 'sütun 128 → telefonun baxdığı yön, 2000 mm');
  const c0 = p.find((x) => x.d === 3000);
  ok(c0 && near(c0.a, 29.883, 0.002), 'sütunlar sağdan sola: sütun 0 → 30°, məsafə olduğu kimi');
  const c255 = p.find((x) => x.d === 1000);
  ok(c255 && near(c255.a, 330.117, 0.002), 'sütun 255 → 330°');
  const wide = new ScanDecoder().decode(pkt, true, 'auto', 90).find((x) => x.d === 3000);
  ok(wide && near(wide.a, 44.824, 0.002), 'FOV 90 → sütun 0 44.8°-də');
  const turned = new ScanDecoder().decode(scn1Encode(d, { ang: [0, 0, Math.PI / 2] }), true)
    .find((x) => x.d === 2000);
  ok(turned && near(turned.a, 269.883, 0.002), 'telefon motorla 90° dönəndə dilim də 90° sürüşür (→ 270°)');

  dec.decode(B('{"t":1789443139738.4661,"type":"ping"}'), true);
  eq(dec.fmt, 'scn1', 'telefonun {"type":"ping"} mesajı biçimi dəyişmir');

  const two = Buffer.concat([scn1Encode(d, { seq: 1 }), scn1Encode(d, { seq: 2 })]);
  const s = new ScanDecoder();
  const got = s.decode(two.subarray(0, 700)).length + s.decode(two.subarray(700)).length;
  ok(got === 6 && s.pose.seq === 2, 'TCP axınında bölünmüş iki kadr: ikisi də oxunur');

  const r = new Radar({ enabled: false });
  for (let k = 0; k < 5; k++) {
    r.ingest(scn1Encode(d, { seq: k, ang: [0, 0, 0.3 * k], t: 5000 + k * 100 }), 'ws', '1.2.3.4:5', true,
             1000 + k * 100);
  }
  let st = r.status(1400);
  ok(st.fmt === 'scn1' && near(st.scan_hz, 0.48, 0.001),
     `dönmə sürəti bucaqdan: 0.3 rad / 100 ms → 0.48 tur/sn  (${st.scan_hz})`);
  ok(st.pose.seq === 4 && st.fov === 60 && st.pose.quality === 1, 'pose, fov 60, izləmə 1');
  ok(st.fresh >= 10, `5 kadr, hər biri başqa yöndə → radar dolur  (${st.fresh}°)`);
  const m = r.mapJson();
  ok(m.pts === 15 && m.cells.length / 3 >= 10, `otaq xəritəsi: 5 kadr × 3 nöqtə yığılır  (${m.pts})`);
  const z = r.setCfg({ zero: true });
  ok(near(z.offset, 1.2 * 180 / Math.PI, 0.01) && r.mapJson().pts === 0,
     '"Bu yön = ön": offset telefonun indiki dönüşü, xəritə təmizlənir');
  r.ingest(scn1Encode(d, { seq: 5, ang: [0, 0, 1.2], t: 5500 }), 'ws', '1.2.3.4:5', true, 1500);
  st = r.status(1500);
  ok(st.scan[359] === 2000, 'indi telefonun baxdığı yön radarın önündədir (359°)');
  r.ingest(scn1Encode(d, { seq: 0, ang: [0, 0, 0], t: 9000 }), 'ws', '1.2.3.4:5', true, 1600);
  ok(r.mapJson().pts === 3, 'proqram yenidən başlayanda (kadr nömrəsi geri) xəritə sıfırlanır');
}

console.log('\nJSON');
{
  const one = (s, whole = true) => new ScanDecoder().decode(B(s), whole);
  let p = one('{"angle": 90, "distance": 1500}');
  ok(p.length === 1 && p[0].a === 90 && p[0].d === 1500, '{angle, distance} → 90°, 1500 mm');
  p = one('{"angle": 45, "distance": 0.75}');
  ok(p[0].d === 750, 'kiçik kəsr ədəd → metr sayılır: 0.75 → 750 mm');
  p = one('{"a": 10, "dist_cm": 50}');
  ok(p[0].d === 500, 'dist_cm → 500 mm');
  p = one('{"angle_rad": 1.5707963, "distance_m": 2}');
  ok(near(p[0].a, 90) && p[0].d === 2000, 'angle_rad, distance_m → 90°, 2000 mm');
  p = one('{"points": [[0, 1000], [1, 1010], [2, 1020]]}');
  eq(p.map((x) => [x.a, x.d]), [[0, 1000], [1, 1010], [2, 1020]], '{points: [[a, d], …]}');
  p = one('[{"angle": 5, "distance": 500}, {"angle": 6, "distance": 510}]');
  eq(p.length, 2, '[{…}, {…}]');
  p = one(JSON.stringify({ angle_min: 0, angle_increment: Math.PI / 180, ranges: [1, 1.5, null, 2] }));
  ok(p.length === 3 && near(p[1].a, 1) && p[1].d === 1500 && near(p[2].a, 3),
     'ROS LaserScan: radian və metr, null atılır');
  p = one(JSON.stringify(Array.from({ length: 360 }, (_, i) => 1000 + i)));
  ok(p.length === 360 && p[90].a === 90 && p[90].d === 1090, '360 məsafəlik massiv → hər dərəcəyə bir');
  p = one(JSON.stringify({ start_angle: 350, end_angle: 10, distances: [1, 2, 3, 4, 5].map((x) => x * 100) }));
  ok(p.length === 5 && near(p[0].a, 350) && near(p[4].a, 10), '{start_angle, end_angle, distances}');
  p = one('{"angle":1,"distance":900}{"angle":2,"distance":910}');
  eq(p.length, 2, 'yapışıq iki obyekt');
  p = one(JSON.stringify(Array.from({ length: 10 }, (_, i) => [0.1 + i * 0.6, 1000])));
  ok(near(p[0].a, 5.73, 0.01), 'bütün açılar ≤ 2π və kəsr → radian (0.1 → 5.73°)');
}

console.log('\nMətn sətirləri');
{
  const d = new ScanDecoder();
  let p = d.decode(B('12.5,340\n13.5,350\n'));
  eq(p.map((x) => [x.a, x.d]), [[12.5, 340], [13.5, 350]], '"açı,məsafə" sətirləri');
  eq(d.decode(B('14.5,3')).length, 0, 'yarım sətir saxlanılır');
  p = d.decode(B('60\n'));
  ok(p.length === 1 && p[0].d === 360, 'qalanı gələndə: 14.5°, 360 mm');
  eq(d.fmt, 'text', 'biçim: text');
  p = new ScanDecoder().decode(B('A:90 D:1000 Q:12;A:91 D:1001 Q:12'), true);
  eq(p.map((x) => [x.a, x.d]), [[90, 1000], [91, 1001]], '"A:… D:…" ; ilə ayrılmış');
  p = new ScanDecoder().decode(B('angle,distance\n'), false);
  eq(p.length, 0, 'başlıq sətri nöqtə deyil');
  const cfgUnit = new ScanDecoder().decode(B('10,35\n'), false, 'cm');
  eq(cfgUnit[0].d, 350, '--radar-unit cm: 35 → 350 mm');
  p = new ScanDecoder().decode(B('{"angle": 7, "distance": 700}\n'), false);
  ok(p.length === 1 && p[0].d === 700, 'TCP-də bir sətir JSON');
  p = new ScanDecoder().decode(B('{"angle": 8, "distance": 800}'), false);
  ok(p.length === 1 && p[0].d === 800, 'TCP-də yeni sətirsiz tam JSON da oxunur');

  const bin = new ScanDecoder();
  eq(bin.decode(Buffer.from(Array.from({ length: 120 }, (_, i) => (i * 37 + 1) & 0xff)), true).length, 0,
     'tanınmayan ikili: nöqtə yox');
  eq(bin.fmt, 'binary?', 'və biçim "binary?" deyilir');
  ok(bin.decode(B('{"angle":1,"distance":1000}'), true).length === 1,
     'sonra gələn JSON mesajı zibillə qarışmır');
}

console.log('\nRadar — dərəcələr, köhnəlmə, ən yaxın, dövr');
{
  const r = new Radar({ enabled: false });
  r.add([{ a: 0, d: 1000 }, { a: 90.4, d: 400 }, { a: 359.9, d: 2000 }], 1000);
  let s = r.status(1000);
  ok(s.scan.length === 360 && s.scan[0] === 1000 && s.scan[90] === 400 && s.scan[359] === 2000,
     'hər nöqtə öz dərəcəsinə düşür');
  ok(s.near && s.near.d === 400 && near(s.near.a, 90.5), 'ən yaxın: 400 mm, 90°');
  eq(r.status(1000 + 3100).scan.filter(Boolean).length, 0, '3 s sonra şəkil boşalır');

  const off = new Radar({ enabled: false, offset: 90 });
  off.add([{ a: 0, d: 1000 }, { a: 300, d: 1100 }], 5);
  ok(off.status(5).scan[90] === 1000 && off.status(5).scan[30] === 1100, 'offset 90: 0° → 90°, 300° → 30°');
  const ccw = new Radar({ enabled: false, ccw: true });
  ccw.add([{ a: 10, d: 1000 }], 5);
  ok(ccw.status(5).scan[350] === 1000, 'ccw: 10° → 350°');

  const hz = new Radar({ enabled: false });
  for (let rev = 0; rev < 5; rev++) {
    hz.add(Array.from({ length: 36 }, (_, i) => ({ a: i * 10, d: 1000 })), 1000 + rev * 100);
  }
  eq(hz.status(1400).scan_hz, 10, 'hər 100 ms-də bir dövr → 10 Hz');

  s = hz.setCfg({ offset: -90, ccw: true });
  ok(s.offset === 270 && s.ccw && s.fresh === 0, 'setCfg: -90 → 270°, şəkil təmizlənir');
  let threw = false;
  try { hz.setCfg({ unit: 'inch' }); } catch { threw = true; }
  ok(threw, 'naməlum vahid atılır');
}

console.log('\nSunucu — radar portu');
{
  const PORT = 8195, RP = 18443;
  const proc = spawn('node', ['server.js', '--http', String(PORT), '--host', '127.0.0.1',
                              '--no-connect', '--no-camera', '--no-actuator', '--no-lidar', '--no-advertise',
                              '--radar-port', String(RP),
                              '--routes', path.join(os.tmpdir(), `routes-radar-${process.pid}.json`)],
                     { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = '';
  proc.stdout.on('data', (d) => { boot += d; });
  proc.stderr.on('data', (d) => { boot += d; });
  const H = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 80; i++) {
    try { await fetch(H + '/api/radar'); break; } catch { await sleep(100); }
  }
  const st = async () => (await fetch(H + '/api/radar')).json();
  const waitFor = async (fn, ms = 2500) => {
    const end = Date.now() + ms;
    let s;
    while (Date.now() < end) {
      s = await st();
      if (fn(s)) return s;
      await sleep(40);
    }
    return s;
  };
  const socks = [];
  try {
    let s = await st();
    ok(s.on && s.udp && s.tcp && s.port === RP, `/api/radar: UDP və TCP :${RP} dinlənir`);
    ok(s.scan.length === 360 && s.fresh === 0, 'hələ boş, 360 dərəcə');
    ok(/radar: lidar data on :18443/.test(boot), 'başlanğıcda deyilir');

    const u = dgram.createSocket('udp4');
    socks.push(u);
    u.send(B('{"angle": 0, "distance": 1000}'), RP, '127.0.0.1');
    s = await waitFor((x) => x.scan[0] === 1000);
    ok(s.scan[0] === 1000 && s.via === 'udp' && s.fmt === 'json', 'UDP JSON → 0°, 1000 mm');

    const t = net.connect(RP, '127.0.0.1');
    socks.push(t);
    await new Promise((r) => t.once('connect', r));
    const pkt = ld06Encode(90, 101, Array(12).fill(1200));
    t.write(pkt.subarray(0, 20));
    await sleep(60);
    t.write(pkt.subarray(20));
    s = await waitFor((x) => x.scan[90] === 1200 && x.scan[101] === 1200);
    ok(s.scan[90] === 1200 && s.scan[101] === 1200 && s.fmt === 'ld06',
       'TCP LD06, iki yazıya bölünmüş → 90–101°');

    const t2 = net.connect(RP, '127.0.0.1');
    socks.push(t2);
    await new Promise((r) => t2.once('connect', r));
    t2.write('180,1800\n181,1810\n');
    s = await waitFor((x) => x.scan[180] === 1800);
    ok(s.scan[180] === 1800 && s.scan[181] === 1810 && s.fmt === 'text', 'TCP mətn sətirləri');

    const ws = new WebSocket(`ws://127.0.0.1:${RP}/`);
    socks.push(ws);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send('{"points": [[270, 2700]]}');
    s = await waitFor((x) => x.scan[270] === 2700);
    ok(s.scan[270] === 2700 && s.via === 'ws', 'WebSocket JSON → 270°');

    const r = await fetch(`http://127.0.0.1:${RP}/scan`, { method: 'POST', body: '{"angle": 45, "distance": 0.45}' });
    const j = await r.json();
    ok(r.ok && j.ok && j.points === 1, 'HTTP POST → {ok, points: 1}');
    s = await st();
    ok(s.scan[45] === 450 && s.via === 'http', 'və 45°-də 450 mm (metr tanındı)');
    const g = await (await fetch(`http://127.0.0.1:${RP}/`)).json();
    ok(g.on && g.port === RP, `GET :${RP}/ → radarın vəziyyəti`);

    s = await waitFor((x) => x.tls, 20000);
    ok(s.tls && !s.tls_err, 'TLS sertifikatı hazırdır (certs/)');
    const ts = tls.connect({ host: '127.0.0.1', port: RP, rejectUnauthorized: false });
    socks.push(ts);
    await new Promise((res, rej) => { ts.once('secureConnect', res); ts.once('error', rej); });
    ts.write('200,2000\n');
    s = await waitFor((x) => x.scan[200] === 2000);
    ok(s.scan[200] === 2000 && s.via === 'tls', 'TLS üzərində mətn → 200°');

    const wss = new WebSocket(`wss://127.0.0.1:${RP}/`, { rejectUnauthorized: false });
    socks.push(wss);
    await new Promise((res, rej) => { wss.once('open', res); wss.once('error', rej); });
    wss.send('{"angle": 300, "distance": 3000}');
    s = await waitFor((x) => x.scan[300] === 3000);
    ok(s.scan[300] === 3000 && s.via === 'wss', 'wss:// JSON → 300°');

    const iw = new WebSocket(`ws://127.0.0.1:${RP}/`);
    socks.push(iw);
    await new Promise((res, rej) => { iw.once('open', res); iw.once('error', rej); });
    const cols = Array(256).fill(0);
    cols[128] = 2500; cols[129] = 2500;
    iw.send(scn1Encode(cols, { seq: 7 }));
    iw.send('{"type":"ping","t":1}');
    s = await waitFor((x) => x.fmt === 'scn1' && x.scan[359] === 2500);
    ok(s.scan[359] === 2500 && s.fmt === 'scn1' && s.pose && s.pose.seq === 7,
       'iPhone SCN1 WebSocket-lə → önündə 2500 mm, ping-dən sonra da scn1');
    const mp = await (await fetch(H + '/api/radar/map')).json();
    ok(mp.pts > 0 && mp.cells.length > 0 && mp.cell === 50, '/api/radar/map otaq xəritəsini verir');
    const fv = await fetch(H + '/api/radar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                               body: JSON.stringify({ fov: 70 }) });
    ok(fv.ok && (await fv.json()).fov === 70, 'POST {fov: 70}');
    const fbad = await fetch(H + '/api/radar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                 body: JSON.stringify({ fov: 500 }) });
    ok(fbad.status === 400, 'fov 500 → 400');

    const set = await fetch(H + '/api/radar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ offset: 90 }) });
    s = await set.json();
    ok(set.ok && s.offset === 90 && s.fresh === 0, 'POST /api/radar {offset: 90} → şəkil təmizlənir');
    u.send(B('{"angle": 0, "distance": 1000}'), RP, '127.0.0.1');
    s = await waitFor((x) => x.scan[90] === 1000);
    ok(s.scan[90] === 1000 && s.scan[0] === 0, 'indi 0° → 90°-də çəkilir');
    const bad = await fetch(H + '/api/radar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ unit: 'inch' }) });
    ok(bad.status === 400, 'naməlum vahid → 400');

    const frame = await new Promise((res) => {
      const c = new WebSocket(`ws://127.0.0.1:${PORT}/`);
      c.on('message', (d) => { c.close(); res(JSON.parse(d)); });
      setTimeout(() => res(null), 3000);
    });
    ok(frame && frame.radar && frame.radar.scan.length === 360 && frame.radar.scan[90] === 1000,
       'status kadrı radarı daşıyır');
    ok((await fetch(H + '/radar.js')).ok, '/radar.js verilir');
    ok(/radarMount/.test(await (await fetch(H + '/dashboard')).text()), '/dashboard radar kartını qurur');
  } catch (e) {
    ok(false, `gözlənilməz xəta: ${e.message}`);
  } finally {
    for (const x of socks) { try { x.close ? x.close() : x.destroy(); } catch { /* gone */ } }
    proc.kill();
  }
  if (fail) console.log('\nserver output:\n' + boot);
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
