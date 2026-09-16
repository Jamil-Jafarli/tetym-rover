/**
 * The pin error log: failures kept, repeats counted, and /pins able to read it.
 *
 * Nothing here touches a real pin. This suite runs on the robot's own Pi, so
 * the lift gets a stand-in for pinctrl that fails on purpose, and the server
 * is started dry (--no-gpio, --no-actuator, --no-lidar).
 *
 *   node test/test_pinlog.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PinLog, PIN_SOURCES } from '../pinlog.js';
import { Actuator } from '../actuator.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };

console.log('\nGünlük — kalır, tekrar sayılır');
{
  const log = new PinLog({ max: 5, repeatMs: 1000 });
  const t = 1_000_000;
  log.add({ source: 'lift', pin: 10, action: 'pinctrl dl', message: 'pinctrl: izin yok' }, t);
  log.add({ source: 'lift', pin: 10, action: 'pinctrl dh', message: 'pinctrl: izin yok' }, t + 300);
  log.add({ source: 'lift', pin: 10, message: 'pinctrl: izin yok' }, t + 900);
  let s = log.status();
  ok(s.entries.length === 1 && s.entries[0].count === 3, 'aynı hata 1 s içinde üç kez: tek satır, ×3');
  ok(s.entries[0].action === 'pinctrl dh', 'satır son işlemi gösteriyor');
  ok(s.total === 3 && s.counts.lift === 3, 'sayaçlar tekrarları da sayıyor');

  log.add({ source: 'lift', pin: 10, message: 'pinctrl: izin yok' }, t + 5000);
  ok(log.status().entries.length === 2, 'uzun aradan sonra aynı hata yeni satır — yeniden başladı demek');
  log.add({ source: 'lift', pin: 22, message: 'pinctrl: izin yok' }, t + 5100);
  log.add({ source: 'pins', pin: 17, message: 'EACCES' }, t + 5200);
  log.add({ source: 'lidar', message: 'python3 tapılmadı' }, t + 5300);
  s = log.status();
  ok(s.entries[0].source === 'lidar' && s.entries[0].pin === null, 'en yeni başta; pinsiz hata da olur');
  ok(s.counts.pins === 1 && s.counts.lidar === 1, 'her kaynak ayrı sayılıyor');
  ok(Object.keys(PIN_SOURCES).join() === 'pins,lift,lidar', 'üç kaynak: pinler/buzzer, lift, lidar motoru');
  for (let i = 0; i < 10; i++) log.add({ source: 'pins', pin: i, message: `hata ${i}` }, t + 6000 + i);
  ok(log.status().entries.length === 5, 'bellekte en fazla max satır');
  log.add({ source: 'bilinmeyen', message: '' }, t + 7000);
  ok(log.status().entries[0].source === 'pins' && log.status().entries[0].message === 'bilinmeyen hata',
     'tanınmayan kaynak ve boş mesaj güvenli şekilde yazılıyor');
  log.clear(t + 8000);
  ok(log.status().entries.length === 0 && log.total === 0 && log.since === t + 8000, 'temizle');
}

console.log('\nDosya — yeniden başlatmadan sonra da durur');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinlog-'));
  const file = path.join(dir, 'logs', 'pins.log');
  const log = new PinLog({ file, repeatMs: 1000 });
  log.add({ source: 'pins', pin: 17, message: 'EACCES' }, 1000);
  log.add({ source: 'pins', pin: 17, message: 'EACCES' }, 1200);
  log.add({ source: 'lift', pin: 10, message: 'pinctrl yok' }, 1300);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(lines.length === 2, 'dosyaya yalnız yeni hatalar yazıldı, tekrar değil');
  ok(lines[0].pin === 17 && lines[0].time && lines[1].source === 'lift', 'her satır JSON, zamanı ile');
  fs.rmSync(dir, { recursive: true, force: true });

  const bad = new PinLog({ file: path.join(os.tmpdir(), 'yok\0yol', 'pins.log') });
  bad.add({ source: 'pins', message: 'x' });
  ok(bad.status().entries.length === 1 && bad.status().file_err, 'dosya yazılamazsa günlük yine çalışıyor, sebebi söyleniyor');
}

console.log('\nLift — pinctrl hatası günlükte kalıyor, sonraki başarılı yazma silmiyor');
{
  const log = new PinLog();
  let failNext = true;
  const act = new Actuator({ log, set: async (pin) => {
    if (failNext && pin === 10) throw new Error('pinctrl: GPIO10 izin reddedildi');
  } });
  await act.start('up');
  await act.settled();
  ok(act.status().err && /izin reddedildi/.test(act.status().err), 'modül son hatayı biliyor');
  failNext = false;
  await act.stop();
  await act.settled();
  ok(act.status().err === null, 'sonraki yazma başarılı: modülün "son hatası" silindi');
  const e = log.status().entries[0];
  ok(e && e.source === 'lift' && e.pin === 10 && /izin reddedildi/.test(e.message) && e.action === 'pinctrl dl',
     `ama günlükte duruyor — GPIO10, pinctrl dl (${e && e.message})`);
}

console.log('\nSunucu — /api/pins/log');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinlog-srv-'));
  const PORT = 18231;
  const proc = spawn('node', ['server.js', '--no-connect', '--http', String(PORT), '--host', '127.0.0.1',
                              '--no-camera', '--no-advertise', '--no-actuator', '--no-lidar', '--no-radar',
                              '--no-gpio', '--routes', path.join(dir, 'routes.json')],
                     { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
                       env: { ...process.env, TETYM_FOLLOW_FILE: path.join(dir, 'follow.json') } });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const B = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 150; i++) {
    try { await fetch(B + '/api/pages'); break; } catch { await sleep(100); }
  }
  try {
    const d = await (await fetch(B + '/api/pins/log')).json();
    ok(Array.isArray(d.entries) && d.counts && 'lift' in d.counts, 'günlük okunuyor');
    ok(d.now && d.now.pins && d.now.lift && d.now.lidar, 'her kısmın şu anki durumu da geliyor');
    ok(d.now.lift.dry && d.now.lidar.dry && d.now.pins.dry, 'quru rejim: hiçbir pin sürülmüyor, sayfa bunu biliyor');
    ok(d.file === null, 'quru rejimde logs/pins.log yazılmıyor');
    const cleared = await fetch(B + '/api/pins/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                      body: JSON.stringify({ action: 'clear' }) });
    ok(cleared.ok && (await cleared.json()).total === 0, 'POST clear temizliyor');
    const bad = await fetch(B + '/api/pins/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                  body: JSON.stringify({ action: 'sil' }) });
    ok(bad.status === 400, 'bilinmeyen işlem → 400');
    const pins = await (await fetch(B + '/api/pins')).json();
    ok(pins.errors && typeof pins.errors.total === 'number', '/api/pins hata sayısını da veriyor');
    const page = await (await fetch(B + '/pins')).text();
    ok(/id="errCard"/.test(page) && /api\/pins\/log/.test(page), '/pins sayfasında hata kartı var');
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (fail) console.log('\nserver output:\n' + out);
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
