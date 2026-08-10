/**
 * Every page, in a real browser, against a real server.
 *
 * The static checks cannot see a page that throws on load, and a page that
 * throws on load looks exactly like a page that is fine until you try to drive
 * with it. So: open each one, fail on any console error, and assert the shared
 * strip actually rendered the numbers the server is holding.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.log('\nplaywright tapılmadı — bu test atlanır (npm i -D playwright)\n');
  process.exit(0);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn('node', ['server.js', '--fake', '--esp', '127.0.0.1', '--http', '8199', '--host', '127.0.0.1', '--no-camera'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let boot = '';
server.stdout.on('data', d => { boot += d; });
server.stderr.on('data', d => { boot += d; });
await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };

const browser = await chromium.launch();
const PAGES = ['/', '/dashboard', '/setup', '/manual', '/drive', '/vision', '/follow',
               '/tune', '/obstacle', '/pins'];

console.log('\nHər səhifə səhvsiz açılır və zolağı göstərir');
for (const path of PAGES) {
  const page = await browser.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:8199${path}`, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  const strip = await page.$('.wtrim');
  const txt = strip ? (await strip.innerText()).replace(/\s+/g, ' ') : '';
  ok(errs.length === 0, `${path} — konsol səhvi yoxdur ${errs[0] || ''}`);
  if (path !== '/follow' && path !== '/setup') {
    ok(!!strip && /GPIO25/.test(txt) && /GPIO26/.test(txt),
       `${path} — təkər zolağı görünür: ${txt.slice(0, 62)}`);
  }
  await page.close();
}

console.log('\nOxunan ayar hər səhifədə eynidir');
{
  // Change it once, then look at three pages that had no part in the change.
  const setup = await browser.newPage();
  await setup.goto('http://127.0.0.1:8199/setup', { waitUntil: 'load' });
  await setup.waitForTimeout(600);
  await setup.evaluate(() => {
    const ws = new WebSocket(`ws://${location.host}/`);
    return new Promise(res => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ cmd: 'follow_cfg',
          cfg: { pilot: { stall25: 27, stall26: 19, gain25: 0.88, gain26: 1 } } }));
        setTimeout(() => { ws.close(); res(); }, 300);
      };
    });
  });
  await setup.close();

  for (const path of ['/manual', '/vision', '/pins']) {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:8199${path}`, { waitUntil: 'load' });
    await p.waitForTimeout(800);
    const txt = (await p.innerText('.wtrim')).replace(/\s+/g, ' ');
    ok(/27 %/.test(txt) && /19 %/.test(txt) && /0\.88/.test(txt),
       `${path} — /setup-da yazılan rəqəmlər burada da görünür: ${txt.slice(0, 62)}`);
    ok(!/\*/.test(txt), `${path} — ölçülüb işarəsi, ulduz yoxdur`);
    await p.close();
  }

  // And the raw pages must say so, or you will measure through a filter and
  // record a threshold that is not the threshold.
  const m = await browser.newPage();
  await m.goto('http://127.0.0.1:8199/manual', { waitUntil: 'load' });
  await m.waitForTimeout(500);
  ok(/xam/i.test(await m.innerText('.wtrim')), '/manual «xam çıxış» yazır');
  await m.close();

  const f = await browser.newPage();
  await f.goto('http://127.0.0.1:8199/follow', { waitUntil: 'load' });
  await f.waitForTimeout(700);
  ok((await f.$$('.i')).length >= 8,
     `/follow-da ${(await f.$$('.i')).length} izah nişanı var`);
  await f.hover('.i');
  await f.waitForTimeout(200);
  const tip = await f.$('.itip');
  ok(!!tip, 'nişanın üstünə gələndə izah açılır');
  if (tip) {
    const t = await tip.innerText();
    ok(t.length > 30, `izah mətni doludur: ${t.slice(0, 48).replace(/\n/g, ' · ')}`);
    const box = await tip.boundingBox();
    const vp = f.viewportSize();
    ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 1,
       'izah qutusu ekrandan çıxmır');
  }
  await f.close();
}

console.log('\n/setup addımları');
{
  const p = await browser.newPage();
  await p.goto('http://127.0.0.1:8199/setup', { waitUntil: 'load' });
  await p.waitForTimeout(700);
  const steps = await p.$$('.step');
  ok(steps.length === 6, `altı addım göstərilir  (${steps.length})`);
  ok((await p.$$('.step.done')).length >= 2, 'ölçülmüş addımlar yaşıl işarələnib');
  ok((await p.$$('.drive')).length === 2, 'iki təkər üçün ayrıca test düyməsi var');

  // The tester must send one pin and zero the other, or "measure this wheel"
  // quietly measures both and the robot drives off the table.
  const sent = await p.evaluate(async () => {
    const out = [];
    const real = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { out.push(d); return real.call(this, d); };
    const rng = document.querySelectorAll('.drive input[type=range]')[0];
    rng.value = 31;
    rng.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.querySelectorAll('.hold')[0];
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    WebSocket.prototype.send = real;
    return out.map(x => JSON.parse(x));
  });
  const started = sent.find(x => x.cmd === 'start');
  ok(!!started && started.p25 === 31 && started.p26 === 0,
     `test yalnız bir pinə gedir, xam faizlə  (${JSON.stringify(started)})`);
  ok(sent.some(x => x.cmd === 'idle'), 'buraxanda dayanır');
  await p.close();
}

await browser.close();
server.kill();
console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
