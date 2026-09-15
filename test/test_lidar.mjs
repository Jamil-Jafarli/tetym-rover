/**
 * The LiDAR map: wire format, grid, simulator, and the relay on a real server.
 *
 * The first section is the one that matters most and is the easiest to get
 * subtly wrong: the SCN1 bytes. The phone app is Swift, webscan's relay and
 * viewer are TypeScript, and this server is plain JS — three encoders of one
 * format. So the encoder here is checked against the golden vector webscan's
 * Swift test pins (apps/ios/native/tests/ScanFrameEncoderTests.swift), which
 * was itself produced by the TypeScript encoder. Matching it is what "the phone
 * app needs no change" actually rests on.
 *
 * Then the grid and the simulator with no browser, then the relay end to end:
 * a sender and viewers on /ws, the rover's own socket on / beside them, on both
 * boards.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

import { loadShared } from '../shared.js';
import { castRay, simPose, LidarSim, SIM_ROOM } from '../lidar_sim.js';
import { LidarRelay } from '../lidar_relay.js';

const L = loadShared('lidar.js', [
  'LIDAR_HEADER', 'LIDAR_FLAG_MATCHED', 'LIDAR_GRID', 'lidarEncode', 'lidarDecode',
  'lidarHeader', 'lidarInspect', 'lidarBuffer', 'lidarRoom', 'lidarRenderGrid',
  'LidarGrid', 'LidarMotion',
]);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ══ the wire format ══════════════════════════════════════════════════
console.log('\nSCN1 baytları webscan-ın Swift/TypeScript etalonu ilə eynidir');
{
  const ranges = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    if (i % 17 === 0) { ranges[i] = 0; continue; }
    if (i === 5) { ranges[i] = 99; continue; }
    ranges[i] = 0.25 + (i % 91) * 0.0537;
  }
  const buf = L.lidarEncode({
    seq: 305419896, tMs: 1757000000123.5, flags: 0b110, x: 1.25, z: -3.5, yaw: 0.7771,
    fovRad: 1.7453292519943295, matchScore: 0.875, cameraHeightM: 1.0,
    ranges, binCount: 256,
  });
  const bytes = new Uint8Array(buf);
  const hex = Buffer.from(bytes.subarray(0, 48)).toString('hex');
  const sum = (arr) => { let h = 0; for (const b of arr) h = (h * 31 + b) >>> 0; return h; };

  ok(buf.byteLength === 560, `256 zolaq = 560 bayt  (${buf.byteLength})`);
  ok(hex === '53434e3101060001785634120000a03f000060c007f0463f'
           + '00b827c655917942f366df3f0000603f0000803f00000000',
     'başlıq (48 bayt) etalonla bayt-bayt eynidir');
  ok(sum(bytes) === 2225435042, `bütün kadrın yoxlama cəmi  (${sum(bytes)})`);
  ok(sum(bytes.subarray(48)) === 888287967, 'yalnız məsafələrin yoxlama cəmi');

  const back = L.lidarDecode(buf);
  ok(back.header.seq === 305419896 && near(back.header.x, 1.25, 1e-6)
     && near(back.header.yaw, 0.7771, 1e-6) && back.header.tMs === 1757000000123.5,
     'geri oxunur: seq, x, yaw, zaman');
  ok(back.ranges[0] === 0, 'qayıtmayan zolaq 0 olaraq qalır');
  // Float32 on the way out, so a micrometre either side is the storage.
  ok(near(back.ranges[5], 65.535, 1e-4), '99 m uint16 tavanına kəsilir');
  ok(near(back.ranges[1], 0.304, 1e-4), '0.3037 m → 304 mm');
}

console.log('\nRöle zibili qəbul etmir');
{
  const good = L.lidarEncode({ seq: 1, tMs: 1, x: 0, z: 0, yaw: 0, fovRad: 1,
                               ranges: new Float32Array(8), binCount: 8 });
  ok(L.lidarInspect(good)?.kind === 'scan', 'düzgün SCN1 — scan');
  ok(L.lidarInspect(good.slice(0, 60)) === null, 'kəsilmiş kadr rədd edilir');
  const bad = good.slice(0); new DataView(bad).setUint32(0, 0xdeadbeef, true);
  ok(L.lidarInspect(bad) === null, 'yanlış magic rədd edilir');
  const v2 = good.slice(0); new DataView(v2).setUint8(4, 2);
  ok(L.lidarInspect(v2) === null, 'başqa protokol versiyası rədd edilir');

  // webscan's 3D point frame: 72-byte header + 9 bytes a point.
  const pcf = new ArrayBuffer(72 + 3 * 9);
  const dv = new DataView(pcf);
  dv.setUint32(0, 0x31464350, true); dv.setUint8(4, 1); dv.setUint32(12, 3, true);
  ok(L.lidarInspect(pcf)?.kind === 'points', "3D 'PCF1' kadrı tanınır (keçir, xəritəyə düşmür)");
  ok(L.lidarDecode(pcf) === null, '...amma 2D xəritə onu açmır');

  const pooled = Buffer.concat([Buffer.from('xxxx'), Buffer.from(good)]).subarray(4);
  ok(L.lidarInspect(L.lidarBuffer(pooled))?.kind === 'scan',
     'ws-in hovuz Buffer-i öz ArrayBuffer-inə köçürülür, qonşu bayt oxunmur');
  ok(L.lidarRoom('Demo') === 'demo' && L.lidarRoom('../x') === 'default'
     && L.lidarRoom('') === 'default', 'otaq adı təmizlənir');
}

// ══ the grid ═════════════════════════════════════════════════════════
console.log('\nİşğal şəbəkəsi divarı divar, keçidi boş görür');
{
  const g = new L.LidarGrid();
  // One beam straight ahead (yaw 0 = -Z), 2 m.
  g.insertScan(0, 0, 0, new Float32Array([2]), 1, 0);
  ok(g.at(g.cellX(0), g.cellZ(-2)) > 0, 'şüanın ucu dolu');
  ok(g.at(g.cellX(0), g.cellZ(-1)) < 0, 'yolu boş');
  ok(g.at(g.cellX(0), g.cellZ(-3)) === 0, 'arxası görülməyib — bilinmir');

  const g2 = new L.LidarGrid();
  g2.insertScan(0, 0, 0, new Float32Array([0, 0, 0]), 3, 0.3);
  ok(g2.revision === 1 && g2.exploredM2() === 0,
     'qayıtmayan zolaq heç nə çəkmir — divarda deşik açmır');

  const g3 = new L.LidarGrid();
  g3.insertScan(0, 0, 0, new Float32Array([20]), 1, 0);
  ok(g3.occupiedCells() === 0 && g3.exploredM2() > 0.3,
     'maksimumdan uzaq oxunuş: boş şüa var, uydurma divar yoxdur');

  const m = new L.LidarMotion();
  ok(m.accept(0, 0, 0, 0), 'ilk poz qəbul');
  ok(!m.accept(0.01, 0, 0, 100), '1 sm tərpənmə — atılır');
  ok(m.accept(0.05, 0, 0, 200), '5 sm — qəbul');
  ok(m.accept(0.05, 0, 0.05, 300), '3° dönmə — qəbul');
  ok(m.accept(0.05, 0, 0.05, 1200), 'hərəkətsiz, amma 700 ms keçdi — qəbul');

  const px = new Uint8ClampedArray(g.size * g.size * 4);
  L.lidarRenderGrid(g, px, 'light');
  ok(px[3] === 255, 'rəngləmə hər hüceyrəni doldurur');
}

// ══ the simulator ════════════════════════════════════════════════════
console.log('\nSimulyator otağı düzgün ölçür və xəritə ondan qurulur');
{
  ok(near(castRay(0, 0, 1, 0), 0.4, 1e-9), 'mərkəzdən sağa: sütuna 0.4 m');
  ok(near(castRay(-2, 0, -1, 0), 3, 1e-9), 'x=-2-dən sola: divara 3 m');
  ok(castRay(-0.5, -2, 0, -1) === Infinity, 'qapı yerindən çıxan şüa heç nəyə dəymir');

  const p0 = simPose(0);
  ok(near(p0.x, 3.1, 1e-9) && near(p0.z, 0, 1e-9), 'başlanğıc poz ellipsin ucunda');
  // ±π are the same heading; which one atan2 returns depends on the sign of 0.
  ok(near(Math.abs(p0.yaw), Math.PI, 1e-9), 'başlanğıcda yön +Z-yə, yolun toxunanı boyunca');

  const sim = new LidarSim({ relay: { room: 'x' } });
  const grid = new L.LidarGrid();
  const motion = new L.LidarMotion();
  let decoded = 0;
  for (let t = 0; t < 40; t += 0.1) {
    const s = L.lidarDecode(sim.scan(t, t * 1000));
    decoded++;
    const h = s.header;
    if (motion.accept(h.x, h.z, h.yaw, h.tMs)) {
      grid.insertScan(h.x, h.z, h.yaw, s.ranges, h.binCount, h.fovRad);
    }
  }
  ok(decoded === 400, '40 s × 10 Hz tarama açıldı');
  // Every occupied cell should sit on a wall, within a couple of cells.
  const segDist = (x, z, [x1, z1, x2, z2]) => {
    const ex = x2 - x1, ez = z2 - z1;
    const t = Math.max(0, Math.min(1, ((x - x1) * ex + (z - z1) * ez) / (ex * ex + ez * ez)));
    return Math.hypot(x - (x1 + t * ex), z - (z1 + t * ez));
  };
  let occ = 0, onWall = 0;
  for (let cz = 0; cz < grid.size; cz++) {
    for (let cx = 0; cx < grid.size; cx++) {
      if (grid.at(cx, cz) <= 20) continue;
      occ++;
      const x = (cx - grid.half + 0.5) * grid.res, z = (cz - grid.half + 0.5) * grid.res;
      if (Math.min(...SIM_ROOM.map((w) => segDist(x, z, w))) < 0.1) onWall++;
    }
  }
  ok(occ > 400, `xəritədə divar var  (${occ} dolu hüceyrə)`);
  ok(onWall / occ > 0.97, `dolu hüceyrələrin ${(onWall / occ * 100).toFixed(1)} %-i həqiqi divarın 10 sm-indədir`);
  const mid = grid.at(grid.cellX(-2), grid.cellZ(0));
  ok(mid < 0, 'otağın boş hissəsi boş kimi görünür');
}

console.log('\nRöle prosesin içində: göndərən, tarixçə, sıfırlama');
{
  const relay = new LidarRelay({ room: 'unit' });
  const sender = relay.localSender('unit', 'test');
  const frame = L.lidarEncode({ seq: 1, tMs: Date.now(), x: 0, z: 0, yaw: 0, fovRad: 1,
                                ranges: new Float32Array(16).fill(1), binCount: 16 });
  ok(sender.send(frame) === null, 'düzgün kadr qəbul olunur');
  ok(sender.send(new ArrayBuffer(10)) === 'malformed frame', 'zibil kadra səbəb deyilir');
  let st = relay.status();
  ok(st.room === 'unit' && st.senders === 1 && st.frames === 1 && st.history === 1 && st.live,
     `status: 1 göndərən, 1 kadr, canlı  (${JSON.stringify({ s: st.senders, f: st.frames, l: st.live })})`);
  // The ARKit app marks every scan: tracked (4) while ARKit is "normal",
  // trackingLost (8) while it is limited. The status carries the newest.
  const flagged = (flags) => L.lidarEncode({ seq: 2, tMs: Date.now(), flags, x: 0, z: 0, yaw: 0,
    fovRad: 1, ranges: new Float32Array(16).fill(1), binCount: 16 });
  sender.send(flagged(0b1010));
  st = relay.status();
  ok(st.tracking === 'lost' && st.lost === 1, `ARKit takibi itəndə status "lost" deyir  (${st.tracking}, ${st.lost})`);
  sender.send(flagged(0b0110));
  ok(relay.status().tracking === 'ok', 'takip qayıdanda "ok"');
  relay.announced = 'tetym-rover on test';
  ok(relay.status().announced === 'tetym-rover on test' && relay.info().announced === 'tetym-rover on test',
     'elan olunan ad statusda və /api/lidar-da var');
  ok(relay.reset('unit') && relay.status().history === 0 && relay.status().tracking === null,
     'sıfırlama tarixçəni və takip vəziyyətini silir');
  sender.close();
  ok(relay.status().senders === 0 && relay.status().active === false, 'göndərən gedəndə aktiv deyil');
  relay.close();
}

// ══ the relay on a real server ═══════════════════════════════════════
function serve(argv) {
  const proc = spawn('node', ['server.js', ...argv], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  proc.stdout.on('data', (d) => { out.text += d; });
  proc.stderr.on('data', (d) => { out.text += d; });
  return { proc, out };
}

/** A socket that keeps what it receives, binary and text apart. */
function client(url) {
  const ws = new WebSocket(url);
  const got = { bin: [], text: [] };
  ws.on('message', (d, isBinary) => {
    if (isBinary) got.bin.push(d);
    else { try { got.text.push(JSON.parse(d.toString())); } catch { /* not json */ } }
  });
  const open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return { ws, got, open };
}

async function relaySuite(label, port, argv) {
  console.log(`\n${label}: /ws röledir, / robotun öz soketi olaraq qalır`);
  const srv = serve([...argv, '--http', String(port), '--host', '127.0.0.1', '--no-camera',
                     '--lidar-room', 'rover', '--no-advertise']);
  await sleep(1500);
  const base = `ws://127.0.0.1:${port}`;
  try {
    const rover = client(`${base}/`);
    await rover.open;
    await sleep(300);
    const st = rover.got.text.filter((m) => m.type === 'status').pop();
    ok(!!st, 'robotun soketi / üzərində status göndərir');
    ok(st && st.lidar && st.lidar.room === 'rover' && st.lidar.path === '/ws' && st.lidar.senders === 0,
       `status.lidar var, otaq --lidar-room-dan  (${JSON.stringify(st && st.lidar && st.lidar.room)})`);

    const early = client(`${base}/ws?room=rover&role=viewer`);
    await early.open;
    const sender = client(`${base}/ws?room=rover&role=sender&label=phone`);
    await sender.open;
    await sleep(150);
    ok(early.got.text.some((m) => m.type === 'welcome' && m.role === 'viewer'),
       'izləyici welcome alır');
    sender.ws.send(JSON.stringify({ type: 'sender-state', active: true, mode: 'map2d', calibrated: true }));

    const sim = new LidarSim({ relay: null });
    for (let i = 0; i < 12; i++) {
      sender.ws.send(Buffer.from(sim.scan(i * 0.1)));
      await sleep(60);                                  // well under the 30 fps cap
    }
    sender.ws.send(Buffer.from('not a scan at all'));
    await sleep(300);

    ok(early.got.bin.length === 12, `izləyici 12 kadrın hamısını alır  (${early.got.bin.length})`);
    const first = L.lidarDecode(L.lidarBuffer(early.got.bin[0]));
    ok(first && first.header.binCount === 256 && first.header.seq === 0,
       'kadr dəyişmədən keçir — izləyici açır');
    ok(early.got.text.some((m) => m.type === 'sender-state' && m.active && m.calibrated),
       'göndərənin vəziyyəti izləyiciyə çatır');
    ok(sender.got.text.some((m) => m.type === 'error' && /malformed/.test(m.message)),
       'zibil kadr göndərənə səhv kimi qayıdır, izləyiciyə getmir');

    const late = client(`${base}/ws?room=rover&role=viewer`);
    await late.open;
    await sleep(400);
    ok(late.got.bin.length === 12, `gec gələn izləyici bütün seansı alır  (${late.got.bin.length})`);
    const other = client(`${base}/ws?room=elsewhere&role=viewer`);
    await other.open;
    await sleep(200);
    ok(other.got.bin.length === 0, 'başqa otaq bu kadrları görmür');

    await sleep(200);
    const st2 = rover.got.text.filter((m) => m.type === 'status').pop();
    ok(st2.lidar.senders === 1 && st2.lidar.frames === 12 && st2.lidar.live && st2.lidar.label === 'phone',
       `robot statusu tarayıcını görür: ${st2.lidar.label}, ${st2.lidar.frames} kadr, canlı`);

    const api = await (await fetch(`http://127.0.0.1:${port}/api/lidar`)).json();
    const room = api.rooms.find((r) => r.id === 'rover');
    ok(room && room.frames === 12 && room.viewers === 2, 'GET /api/lidar otaqları sayır');
    for (const p of ['/lidar', '/viewer.html', '/lidar.js', '/lidarmap.js']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      ok(r.status === 200, `GET ${p} → 200`);
    }
    ok((await fetch(`http://127.0.0.1:${port}/sender.html`)).status === 404,
       '--webscan olmadan /sender.html yoxdur');

    rover.ws.send(JSON.stringify({ cmd: 'lidar_reset', room: 'rover' }));
    await sleep(300);
    ok(early.got.text.some((m) => m.type === 'reset') && late.got.text.some((m) => m.type === 'reset'),
       'lidar_reset bütün izləyicilərə reset göndərir');
    const again = client(`${base}/ws?room=rover&role=viewer`);
    await again.open;
    await sleep(300);
    ok(again.got.bin.length === 0, 'sıfırlamadan sonra yeni izləyiciyə köhnə xəritə verilmir');

    sender.ws.close();
    await sleep(300);
    ok(early.got.text.some((m) => m.type === 'sender-state' && m.active === false),
       'tarayıcı gedəndə izləyicilər bilir');
    for (const c of [rover, early, late, other, again]) c.ws.close();
  } finally {
    srv.proc.kill();
    await sleep(300);
  }
  return srv.out.text;
}

const benchOut = await relaySuite('ESP32 (saxta)', 8197, ['--fake', '--esp', '127.0.0.1']);
ok(/app relay URL, if typed:\s+ws:\/\/127\.0\.0\.1:8197/.test(benchOut),
   'başlanğıcda tarayıcının hara göndərəcəyi yazılır');
ok(/mDNS announcement off/.test(benchOut), '--no-advertise olanda bunu deyir');
await relaySuite('Creality (port açılmır)', 8196, ['--marlin', '--no-connect']);

console.log('\n--lidar-sim: telefon olmadan xəritə axır');
{
  const srv = serve(['--fake', '--esp', '127.0.0.1', '--http', '8195', '--host', '127.0.0.1',
                     '--no-camera', '--lidar-sim', '--no-advertise']);
  await sleep(2200);
  try {
    const v = client('ws://127.0.0.1:8195/ws?role=viewer');
    await v.open;
    await sleep(700);
    ok(v.got.bin.length > 10, `simulyator otağa kadr axıdır  (${v.got.bin.length})`);
    ok(v.got.text.some((m) => m.type === 'sender-state' && /simülasyon/.test(m.note || '')),
       'simulyasiya olduğunu özü deyir');
    const api = await (await fetch('http://127.0.0.1:8195/api/lidar')).json();
    const r = api.rooms.find((x) => x.id === 'default');
    ok(r && r.live && /SİMÜLE/.test(r.label), `etiket: ${r && r.label}`);
    v.ws.close();
  } finally {
    srv.proc.kill();
    await sleep(200);
  }
}

// ══ mDNS: the phone finds the rover by itself ════════════════════════
//
// The webscan app browses `_webscan._tcp` and reads `tls` and `path` from the
// TXT record. Two halves, as in webscan's own discovery smoke test: it has to
// appear, and it has to WITHDRAW — without the goodbye a phone keeps a stale
// entry and dials a server that is gone, which looks like a network fault.
console.log('\nmDNS: telefon rover-i IP yazmadan tapır');
{
  const { Bonjour } = await import('bonjour-service');
  const { advertise } = await import('../lidar_discovery.js');
  const watcher = new Bonjour();
  const ups = [], downs = [];
  const browser = watcher.find({ type: 'webscan', protocol: 'tcp' });
  browser.on('up', (s) => ups.push(s));
  browser.on('down', (s) => downs.push(s));
  await sleep(1200);
  const before = new Set(ups.map((s) => s.name));

  const ad = await advertise({ port: 18190, tls: false });
  await sleep(2500);
  const mine = ups.find((s) => s.name === ad.name && s.port === 18190);
  if (!mine && ad.error) {
    // No multicast here at all (a container, a locked-down adapter): say so
    // rather than failing on the network instead of on the code.
    console.log(`  [SKIP] bu maşında multicast işləmir: ${ad.error}`);
  } else {
    ok(!!mine, `xidmət görünür: "${ad.name}" (_webscan._tcp)`);
    ok(mine && mine.txt && mine.txt.path === '/ws' && mine.txt.tls === '0',
       `TXT webscan açarları ilə: tls=${mine && mine.txt && mine.txt.tls}, path=${mine && mine.txt && mine.txt.path}`);
    ok(mine && (mine.addresses || []).some((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)),
       `IPv4 ünvanı var — tətbiq IPv4 istəyir  (${mine && (mine.addresses || []).join(', ')})`);
    await ad.stop();
    await sleep(2500);
    ok(downs.some((s) => s.name === ad.name), 'dayananda goodbye göndərir — köhnə qeyd qalmır');

    // The real server announces itself too, on its own port. (Its goodbye on
    // shutdown is SIGTERM's job, and Windows cannot deliver SIGTERM to a
    // child — the in-process check above is the one that covers withdrawal.)
    const srv = serve(['--fake', '--esp', '127.0.0.1', '--http', '8194', '--host', '127.0.0.1',
                       '--no-camera']);
    await sleep(3500);
    const served = ups.find((s) => s.port === 8194 && !before.has(s.name) && /^tetym-rover on /.test(s.name));
    ok(!!served, `server özü elan edir, port 8194  (${served ? served.name : 'tapılmadı'})`);
    ok(/lidar: announced as "tetym-rover on /.test(srv.out.text), 'başlanğıcda elan olunan ad yazılır');
    try {
      const api = await (await fetch('http://127.0.0.1:8194/api/lidar')).json();
      ok(/^tetym-rover on /.test(api.announced || ''), `/api/lidar adı verir: ${api.announced}`);
    } finally {
      srv.proc.kill();
      await sleep(300);
    }
  }
  browser.stop();
  watcher.destroy();
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
