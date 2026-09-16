/**
 * The reversing buzzer: when it sounds, what it drives, and who decides.
 *
 * The rule it enforces is a safety one — the robot does not back up silently —
 * so the parts worth being strict about are the ones that would fail quietly:
 * a pivot counted as reversing (the buzzer cries wolf and nobody listens), a
 * robot that is stopped still sounding, and a buzzer that is quiet because the
 * pins could not be driven while the page says it is armed.
 *
 *   node test/test_buzzer.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { Buzzer, BUZZER_DEFAULTS } from '../buzzer.js';
import { Gpio, gpioValid } from '../gpio.js';
import { Rover } from '../rover.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until true or out of time — the Pi this runs on is not fast. */
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); }
  return fn();
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };

/** A Gpio stand-in: records every level it was asked for. */
function stubGpio() {
  return {
    log: [],
    levels: new Map(),
    async set(pin, value) { this.log.push([pin, value ? 1 : 0]); this.levels.set(pin, value ? 1 : 0); return true; },
    status() { return { backend: 'stub', available: true, error: null, writes: this.log.length,
                        failed: 0, pins: Object.fromEntries(this.levels) }; },
  };
}

console.log('\nBip deseni');
{
  const gpio = stubGpio();
  const b = new Buzzer({ gpio, cfg: { buzzer: { enabled: true, pins: [17, 27], beepMs: 200, gapMs: 300 } } });
  const t = 1_000_000;
  ok(b.wants(t) === false, 'ileri giderken sessiz');
  b.setReversing(true, t);
  ok(b.wants(t) === true, 'geri vites: hemen öter');
  ok(b.wants(t + 199) === true && b.wants(t + 201) === false, '200 ms bip, sonra sessizlik');
  ok(b.wants(t + 499) === false && b.wants(t + 501) === true, '300 ms bekleme, sonra yine bip');
  b.setReversing(false, t + 600);
  ok(b.wants(t + 700) === false, 'ileri vitese geçince susar');

  b.setCfg({ buzzer: { mode: 'steady' } });
  b.setReversing(true, t + 1000);
  ok(b.wants(t + 1900) === true, 'sürekli modda ara vermez');
  b.close();
}

console.log('\nPinler');
{
  const gpio = stubGpio();
  const b = new Buzzer({ gpio, cfg: { buzzer: { enabled: true, pins: [17, 27], beepMs: 200, gapMs: 200 } } });
  b.setReversing(true);
  ok(gpio.log.length === 2 && gpio.log.every(([, v]) => v === 1), 'iki pin birden yükseliyor');
  ok(gpio.log.map(([p]) => p).join(',') === '17,27', 'yazılan pinler ayarlardaki pinler');
  await sleep(320);
  ok(gpio.levels.get(17) === 0 && gpio.levels.get(27) === 0, 'bip arasında ikisi de düşüyor');
  b.close();

  const inv = stubGpio();
  const bi = new Buzzer({ gpio: inv, cfg: { buzzer: { enabled: true, pins: [5], invert: true } } });
  bi.setReversing(true);
  ok(inv.levels.get(5) === 0, 'ters modülde ötmek pini LOW yapar');
  bi.close();
  ok(inv.levels.get(5) === 1, 'kapanışta pin güvenli seviyeye (ters modülde HIGH) bırakılıyor');

  const off = stubGpio();
  const bo = new Buzzer({ gpio: off, cfg: { buzzer: { enabled: false, pins: [17] } } });
  bo.setReversing(true);
  ok(off.log.length === 0, 'buzzer kapalıyken hiçbir pin sürülmüyor');
  bo.close();

  const b2 = new Buzzer({ gpio: stubGpio() });
  ok(b2.cfg.enabled === false && BUZZER_DEFAULTS.enabled === false,
     'varsayılan kapalı — kablolar bağlanmadan pin sürülmez');
  b2.setCfg({ buzzer: { pins: [99, 3, 3, -1], beepMs: 5, gapMs: 999999 } });
  ok(b2.cfg.pins.join(',') === '3', 'aralık dışı ve tekrarlanan pinler atılıyor');
  ok(b2.cfg.beepMs === 50 && b2.cfg.gapMs === 5000, 'süreler makul aralığa çekiliyor');
  b2.close();
}

console.log('\nGeri gitmek nedir, ne değildir');
{
  const jog = { startWheels() {}, stop() {} };
  const rover = new Rover({ link: { connected: true }, jog });
  ok(rover.reversing === false, 'duran robot geri gitmiyor');
  rover.start();
  rover.setKeys(['s'], 50);
  ok(rover.reversing === true, 'S: iki teker de geri — buzzer öter');
  rover.setKeys(['s', 'a'], 50);
  ok(rover.reversing === true, 'geri dönerek giderken de öter');
  rover.setKeys(['d'], 50);
  ok(rover.reversing === false, 'yerinde dönüş geri gitmek değildir — bir teker geri, robot geri gitmiyor');
  rover.setKeys(['w'], 50);
  ok(rover.reversing === false, 'ileri giderken sessiz');
  rover.setKeys(['s'], 50);
  rover.hold('kapı: PLC devam komutu bekleniyor');
  ok(rover.reversing === false, 'tutulan robot geri gitmiyor — tekerler dönmüyor');
  rover.hold(null);
  rover.stop('DUR');
  ok(rover.reversing === false, 'DUR sonrası sessiz');
  rover.close();
}

console.log('\nBu makinede pin var mı — dürüstçe');
{
  // Dry, not the real pins: this suite runs on the robot's own Pi, and GPIO17
  // is not ours to raise just because a test wants to see it go up.
  const g = new Gpio({ enabled: false });
  const done = await g.set(17, 1);
  const st = g.status();
  ok(gpioValid(17) && !gpioValid(28) && !gpioValid('x'), 'GPIO 0–27 arası kabul ediliyor');
  ok(st.backend === 'none' && done === false && !st.available, 'quru rejimde pin sürülmüyor');
  ok(/quru rejim/.test(st.error || ''), `ve sebebi yazılıyor  (${st.error})`);
  ok(st.pins[17] === 1, 'ne istendiği yine de kaydediliyor — sayfa ne olması gerektiğini gösterir');
  await g.close();
}

// ══ the server ═══════════════════════════════════════════════════════
console.log('\nSunucuda: ayar kaydediliyor, geri vitese göre ötüyor');
{
  // Its own settings file: this test turns the buzzer on and writes pin notes,
  // and neither belongs in the robot's follow.json.
  const dir = mkdtempSync(path.join(tmpdir(), 'tetym-buzzer-'));
  const proc = spawn('node', ['server.js', '--no-connect', '--http', '18203',
                              '--host', '127.0.0.1', '--no-camera', '--no-advertise',
                              '--no-actuator', '--no-lidar', '--no-radar', '--no-gpio',
                              '--routes', path.join(dir, 'routes.json')],
                     { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
                       env: { ...process.env, TETYM_FOLLOW_FILE: path.join(dir, 'follow.json') } });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  // Until it answers, not a fixed sleep: on a throttled Pi the server takes
  // seconds to come up.
  for (let i = 0; i < 150; i++) {
    try { await fetch('http://127.0.0.1:18203/api/pages'); break; } catch { await sleep(100); }
  }
  try {
    const ws = new WebSocket('ws://127.0.0.1:18203/');
    let st = null;
    ws.on('message', (d) => { try { const m = JSON.parse(d); if (m.type === 'status') st = m; } catch { /* */ } });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    await sleep(200);
    ok(st && st.buzzer && st.buzzer.enabled === false, 'buzzer varsayılan olarak kapalı geliyor');

    ws.send(JSON.stringify({ cmd: 'follow_cfg', cfg: { buzzer: { enabled: true, pins: [17, 27], beepMs: 120, gapMs: 120 },
                                                       pins: [{ pin: 17, label: 'buzzer +', note: 'geri vites', dir: 'out' }] } }));
    await sleep(250);
    ok(st.buzzer.enabled && st.buzzer.pins.join(',') === '17,27', 'ayar kaydedildi ve durumda görünüyor');

    ws.send(JSON.stringify({ cmd: 'start' }));
    ws.send(JSON.stringify({ cmd: 'keys', keys: ['s'], pct: 50 }));
    await sleep(250);
    ok(st.reversing === true && st.buzzer.reversing === true, 'S basılıyken sunucu geri gittiğini biliyor');
    ws.send(JSON.stringify({ cmd: 'keys', keys: ['w'], pct: 50 }));
    await sleep(250);
    ok(st.buzzer.reversing === false, 'W basılınca susuyor');

    // A pin that is not written down as an output is refused, whatever a page asks.
    ws.send(JSON.stringify({ cmd: 'pi_pin', pin: 14, value: 1 }));
    ok(await until(() => /pin refused: GPIO14/.test(out)), 'listede olmayan pin sürülmüyor (seri konsol pini)');
    ws.send(JSON.stringify({ cmd: 'pi_pin', pin: 17, value: 1 }));
    ok(await until(() => /GPIO17 = 1/.test(out)), 'listedeki çıkış pini sürülüyor (quru rejimde: istenen yazılıyor)');
    ws.close();

    const pins = await (await fetch('http://127.0.0.1:18203/api/pins')).json();
    ok(pins.pins.length === 1 && pins.pins[0].label === 'buzzer +',
       'pin notları /api/pins ile her sayfaya açık');
    const pages = await (await fetch('http://127.0.0.1:18203/api/pages')).json();
    ok(pages.machine === 'marlin' && pages.pages.includes('/pins') && pages.pages.includes('/gcode'),
       'ana sayfa hangi sayfaların olduğunu buradan öğreniyor');
    const hub = await (await fetch('http://127.0.0.1:18203/')).text();
    ok(/Robot kontrol/.test(hub) && /api\/pages/.test(hub), '/ artık tek ana sayfa');
    ok((await fetch('http://127.0.0.1:18203/gcode')).ok, 've elle sürüş /gcode adresinde');
    ok((await fetch('http://127.0.0.1:18203/pins')).ok, '/pins Pi pinleri sayfasını veriyor');
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
