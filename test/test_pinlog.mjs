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
import { Gpio, sysfsBase } from '../gpio.js';

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

console.log('\nPi pin yolu — pinctrl önce, sysfs çipin tabanıyla');
{
  // A fake /sys/class/gpio: nothing here reaches a real pin.
  const fakeSysfs = (chips, preexport = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysfs-'));
    fs.writeFileSync(path.join(dir, 'export'), '');
    fs.writeFileSync(path.join(dir, 'unexport'), '');
    for (const [name, label, base, ngpio] of chips) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, 'label'), label + '\n');
      fs.writeFileSync(path.join(dir, name, 'base'), base + '\n');
      fs.writeFileSync(path.join(dir, name, 'ngpio'), ngpio + '\n');
    }
    for (const n of preexport) {
      fs.mkdirSync(path.join(dir, `gpio${n}`));
      fs.writeFileSync(path.join(dir, `gpio${n}`, 'direction'), 'in');
      fs.writeFileSync(path.join(dir, `gpio${n}`, 'value'), '0');
    }
    return dir;
  };
  const pi4 = [['gpiochip512', 'pinctrl-bcm2711', 512, 58], ['gpiochip570', 'raspberrypi-exp-gpio', 570, 8]];
  const pi5 = [['gpiochip571', 'pinctrl-rp1', 571, 54], ['gpiochip512', 'gpio-brcmstb@107d508500', 512, 32]];

  ok(sysfsBase(fakeSysfs(pi4)) === 512, 'Pi 4 (6.6+ çekirdek): GPIO0 = 512, GPIO17 = 529');
  ok(sysfsBase(fakeSysfs(pi5)) === 571, 'Pi 5: pinctrl-rp1, GPIO0 = 571 — genişletici çip seçilmiyor');
  ok(sysfsBase(fakeSysfs([])) === 0, 'eski çekirdek, çip yok: numaralar BCM ile aynı');

  // pinctrl works: used, even with a writable sysfs next to it.
  const calls = [];
  const withPinctrl = new Gpio({ platform: 'linux', sysfs: fakeSysfs(pi4),
    run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return null; } });
  ok(await withPinctrl.set(17, 1) && withPinctrl.status().backend === 'pinctrl',
     'pinctrl çalışıyorsa sysfs yazılabilir olsa da pinctrl seçiliyor');
  ok(calls.includes('pinctrl set 17 op dh'), 'BCM numarasıyla: pinctrl set 17 op dh');

  // No pinctrl, Pi 4 sysfs: the write goes to gpio529, not gpio17.
  const log = new PinLog();
  const dir4 = fakeSysfs(pi4, [529]);
  const g4 = new Gpio({ platform: 'linux', sysfs: dir4, log, run: async () => 'ENOENT' });
  const done4 = await g4.set(17, 1);
  ok(done4 && g4.status().backend === 'sysfs' && g4.status().sysfs_base === 512, 'pinctrl yoksa sysfs, taban 512');
  ok(fs.readFileSync(path.join(dir4, 'gpio529', 'value'), 'utf8') === '1'
     && fs.readFileSync(path.join(dir4, 'gpio529', 'direction'), 'utf8') === 'out',
     'GPIO17 → gpio529: yön out, değer 1');
  ok(!fs.existsSync(path.join(dir4, 'gpio17')), 'gpio17 diye bir şeye yazılmadı — ilk sürümün hatası buydu');
  ok(log.status().entries.length === 0, 'hata yok');

  // A pin whose directory never appears: logged with the sysfs number.
  const g4b = new Gpio({ platform: 'linux', sysfs: fakeSysfs(pi4), log, run: async () => 'ENOENT' });
  const done4b = await g4b.set(27, 1);
  const e = log.status().entries[0];
  ok(!done4b && e && e.pin === 27 && e.action === 'sysfs gpio539 HIGH',
     `yazılamayan pin günlükte sysfs numarasıyla: ${e && e.action}`);
  ok(fs.readFileSync(path.join(g4b.sysfs, 'export'), 'utf8') === '539', "export'a 17+512 değil 27+512 = 539 yazıldı");

  // Neither: nothing driven, said once.
  const log2 = new PinLog();
  const none = new Gpio({ platform: 'linux', sysfs: path.join(os.tmpdir(), 'yok-boyle-bir-yer'), log: log2,
                          run: async () => 'pinctrl: command not found' });
  ok(!(await none.set(17, 1)) && none.status().backend === 'none', 'ikisi de yoksa pin sürülmüyor');
  ok(log2.status().entries.length === 1 && /pinctrl/.test(log2.status().entries[0].message),
     've bir kez günlüğe yazılıyor');
}

console.log('\n/pins sayfası — betik ayrıştırılıyor, eski sunucuda takılmıyor');
{
  // A syntax error in the page script is a card stuck on "yükleniyor…" forever,
  // with nothing on the page to say so. Parsed here, with no browser.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'pins_pi.html'), 'utf8');
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  let parsed = null;
  try { new Function(script); parsed = true; } catch (e) { parsed = e.message; }
  ok(parsed === true, `sayfa betiği geçerli JavaScript  (${parsed === true ? 'tamam' : parsed})`);
  ok(/r\.status === 404/.test(script) && /sunucu eski kodla/.test(script),
     '404 gelirse kart «sunucu yeniden başlatılmadı» diyor, yükleniyor…da kalmıyor');
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
