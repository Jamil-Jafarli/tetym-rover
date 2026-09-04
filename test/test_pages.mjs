/**
 * Every page, in a real browser, against a real server — both machines.
 *
 * The unit tests cover what each server puts on the wire. What they cannot see
 * is a page that throws on load, and a page that throws on load looks exactly
 * like one that is fine until you try to drive with it. So: open every page,
 * fail on any console error, and assert on what actually left the browser.
 *
 * Two servers, because there are two boards and the pages differ:
 *
 *   · the ESP32 DAC bench, faked, on 8199 — the hub, /manual, /drive, /pins,
 *     /setup, /obstacle, /dashboard, and the shared wheel-trim strip
 *   · the Creality mainboard, with no port opened, on 8198 — /gcode and the
 *     road-following pages, with /api/marlin intercepted so nothing reaches a
 *     serial port. What that half tests is key -> vector -> request body.
 *
 * /vision, /follow and /tune are served by both and checked against both: they
 * are the same pages, and the whole point of them is that they do not care
 * which board is at the far end.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DIRECTIONS, Jogger } from '../marlin.js';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.log('\nplaywright not installed — skipping (npm i -D playwright)\n');
  process.exit(0);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
                           `${m}  (${JSON.stringify(a)})`);

/** A server, its output kept so a failure can show why it would not start. */
function serve(argv) {
  const proc = spawn('node', ['server.js', ...argv],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { boot: '', dead: null };
  proc.stdout.on('data', (d) => { out.boot += d; });
  proc.stderr.on('data', (d) => { out.boot += d; });
  // A server that dies mid-suite otherwise shows up as a connection refused on
  // whichever page happened to be next, which says nothing about why.
  proc.on('exit', (code, sig) => { out.dead = sig || code; });
  return { proc, out };
}

const browser = await chromium.launch();

// ══ the ESP32 DAC bench ══════════════════════════════════════════════
const bench = serve(['--fake', '--esp', '127.0.0.1', '--http', '8199',
                     '--host', '127.0.0.1', '--no-camera']);
await sleep(1400);

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
  ok(/ham/i.test(await m.innerText('.wtrim')), '/manual «ham çıkış» yazır');
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

bench.proc.kill();

// ══ the Creality mainboard ═══════════════════════════════════════════
const BASE = 'http://127.0.0.1:8198';
const marlin = serve(['--marlin', '--http', '8198', '--host', '127.0.0.1',
                      '--no-connect', '--no-camera']);
await sleep(1400);

/** A board that is plugged in, powered, and answering. */
const boardStatus = (extra = {}) => ({
  connected: true, responsive: true, port: '/dev/ttyUSB0', baud: 115200,
  firmware: 'FIRMWARE_NAME:Marlin 2.0.8.2 SOURCE_CODE_URL:...',
  position: { X: 12.5, Y: -3.25, Z: 0, E: 0 },
  queue: 1, steppers_on: true, soft_endstops: true,
  invert: { X: false, Y: false }, emergency_parser: true, jogging: false,
  m400_blocks: true, barrier_ms: 305,
  steps_per_mm: 80, mm_per_rev: { X: 40, Y: 40 },
  settings: { M92: { X: 80, Y: 80 }, M204: { T: 1000 },
              M203: { X: 500, Y: 500 }, M906: { X: 580, Y: 580 } },
  unsupported: ['M350'], directions: DIRECTIONS, ports: ['/dev/ttyUSB0'],
  ...extra,
});

/**
 * A page wired to a fake board, plus the list of requests it makes.
 * Every /api/marlin call is answered here, so nothing reaches a serial port.
 */
async function openPage(browser, statusExtra = {}) {
  const page = await browser.newPage();
  const errs = [];
  const sent = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.route('**/api/marlin/**', async (route) => {
    const req = route.request();
    const name = new URL(req.url()).pathname.split('/').pop();
    let body = { ok: true };
    if (name === 'status') body = boardStatus(statusExtra);
    else if (name === 'log') body = { lines: [], seq: 0 };
    else sent.push({ name, body: JSON.parse(req.postData() || '{}') });
    await route.fulfill({ status: 200, contentType: 'application/json',
                          body: JSON.stringify(body) });
  });

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  return { page, errs, sent };
}

console.log('\nThe page loads and shows the board');
const { page, errs, sent } = await openPage(browser);
{
  ok(errs.length === 0, `no console errors ${errs[0] || ''}`);
  ok(/Marlin 2\.0\.8\.2/.test(await page.innerText('#fw')),
     `the firmware string is shown: ${await page.innerText('#fw')}`);
  ok((await page.innerText('#posX')) === '12.50', 'X position');
  ok((await page.innerText('#revX')) === '0.313',
     `12.5 mm at 40 mm/rev is 0.313 revolutions (${await page.innerText('#revX')})`);
  ok(/80 steps\/mm/.test(await page.innerText('#cal')), 'the calibration line reads back');
  ok(/queue 1/.test(await page.innerText('#qdepth')), 'the planner depth is shown');

  const current = await page.inputValue('input[data-code="M906"][data-letter="X"]');
  ok(current === '580', `the board's motor current fills the field (${current})`);
  ok(await page.$eval('.set[data-code="M350"]', (e) => e.classList.contains('na')),
     'a code the firmware rejected is greyed out');
  ok(!await page.$eval('.set[data-code="M906"]', (e) => e.classList.contains('na')),
     '...and one it answered is not');
}

console.log('\nThe four keys are labelled with the G-code they send');
{
  eq(await page.innerText('#gW'), 'X-5.00 Y5.00', 'W');
  eq(await page.innerText('#gA'), 'X5.00 Y5.00',  'A');
  eq(await page.innerText('#gS'), 'X5.00 Y-5.00', 'S');
  eq(await page.innerText('#gD'), 'X-5.00 Y-5.00','D');

  // The chunk size is a stopping distance, and the page has to say so — the
  // 100 mm default it shipped with was a 141 mm diagonal, eight and a half
  // seconds of coasting after the key came up.
  const hint = await page.innerText('#stopHint');
  // X and Y are the two wheels, so a 5 mm chunk on each moves the rover 5 mm
  // forward — not the 7.07 mm diagonal Marlin plans and times the move by.
  ok(/stops within 5\.0 mm of travel/.test(hint),
     `the stopping distance is ground travel, not Marlin's vector: ${hint}`);
  ok(!/7\.1/.test(hint), 'the planned distance is not passed off as the real one');
  const secs = parseFloat(/every ([\d.]+) s/.exec(hint)?.[1]);
  ok(secs > 0 && secs < 0.3, `and how often a chunk goes out (${secs} s)`);
  ok(/each finishes before the next is sent/.test(hint),
     'plus why that is the stopping distance');

  // Spinning in place covers no ground, so quoting a distance would be a lie.
  await page.keyboard.down('a');
  await page.waitForTimeout(150);
  const spin = await page.innerText('#stopHint');
  ok(/turning/.test(spin) && /wheel travel each way/.test(spin),
     `a spin is reported as rotation, not travel: ${spin}`);
  await page.keyboard.up('a');
  await page.waitForTimeout(250);

  await page.fill('#step', '100');
  await page.waitForTimeout(120);
  const big = await page.innerText('#stopHint');
  ok(/100\.0 mm of travel/.test(big) && /lower the chunk size/.test(big),
     `a chunk that would coast is called out: ${big}`);
  await page.fill('#step', '5');
  await page.locator('#step').blur();
  await page.waitForTimeout(120);
}

console.log('\nHolding a key');
{
  sent.length = 0;
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  ok(await page.$eval('.key[data-code="KeyW"]', (e) => e.classList.contains('on')),
     'the W tile lights up');
  eq(await page.innerText('#kbState'), 'forward', 'the state line names the direction');
  eq(await page.innerText('#gline'), 'G1 X-5.00 Y5.00 F6000',
     'the live line is the one the operator asked for');

  const run = sent.find((r) => r.name === 'run');
  ok(!!run, 'holding W posts a run');
  eq(run?.body.axes, { X: -1, Y: 1 }, 'forward is X− Y+');
  eq([run?.body.step, run?.body.feedrate], [5, 6000],
     'streamed in short chunks at the default speed');

  await page.keyboard.up('w');
  await page.waitForTimeout(200);
  ok(sent.some((r) => r.name === 'halt'), 'releasing it stops the stream');
  eq(await page.innerText('#kbState'), 'idle', 'and the state line goes back to idle');
}

console.log('\nTwo keys at once');
{
  sent.length = 0;
  await page.keyboard.down('w');
  await page.keyboard.down('a');
  await page.waitForTimeout(250);
  const runs = sent.filter((r) => r.name === 'run');
  eq(runs.at(-1)?.body.axes, { X: 0, Y: 1 },
     'W+A sums to one motor — the CoreXY diagonal');
  eq(await page.innerText('#gline'), 'G1 Y5.00 F6000',
     'and the line drops the motor that is not turning');
  ok((await page.innerText('#kbState')).includes('forward')
     && (await page.innerText('#kbState')).includes('left'), 'both are named');

  await page.keyboard.up('a');
  await page.waitForTimeout(250);
  eq(sent.filter((r) => r.name === 'run').at(-1)?.body.axes, { X: -1, Y: 1 },
     'letting go of A re-aims to plain forward without stopping');
  await page.keyboard.up('w');
  await page.waitForTimeout(200);

  // Opposites must cancel rather than fighting: W+S is not a direction.
  sent.length = 0;
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  await page.keyboard.down('s');
  await page.waitForTimeout(250);
  eq(await page.innerText('#gline'), 'G1 — F6000', 'W+S cancels to no move');
  ok(sent.filter((r) => r.name === 'halt').length >= 1, '...and stops the machine');
  await page.keyboard.up('w'); await page.keyboard.up('s');
  await page.waitForTimeout(200);
}

console.log('\nSpace is the panic key');
{
  sent.length = 0;
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  const panic = sent.find((r) => r.name === 'halt');
  ok(!!panic, 'space stops');
  ok(panic?.body.hard === undefined,
     'the same stop as letting go — there is no quickstop to ask for');
  ok(!await page.$eval('.key[data-code="KeyW"]', (e) => e.classList.contains('on')),
     'every key is released');
  await page.keyboard.up('w');
  await page.waitForTimeout(200);

  // The release of the still-held key must not fire a second, pointless halt.
  sent.length = 0;
  await page.waitForTimeout(200);
  ok(sent.length === 0, 'and letting go afterwards sends nothing more');
}

console.log('\nThe numbers are live');
{
  await page.fill('#feed', '3000');
  await page.fill('#step', '25');
  await page.waitForTimeout(100);
  eq(await page.innerText('#gW'), 'X-25.00 Y25.00', 'the tiles follow the chunk size');
  // ...and then get out of the box, or the keys are correctly ignored as typing.
  await page.locator('#step').blur();
  sent.length = 0;
  await page.keyboard.down('d');
  await page.waitForTimeout(200);
  const run = sent.find((r) => r.name === 'run');
  eq([run?.body.feedrate, run?.body.step], [3000, 25], 'and so does the request');
  eq(run?.body.axes, DIRECTIONS.right, 'D is right');
  await page.keyboard.up('d');
  await page.waitForTimeout(200);
  await page.fill('#feed', '6000');
  await page.fill('#step', '5');
  await page.locator('#step').blur();
}

console.log('\nThe page and the server agree about the pacing');
{
  // The stopping distance the page promises is computed in the page; the
  // pacing that delivers it is computed in marlin.js. Two copies of one
  // trapezoid, so they are checked against each other rather than trusted.
  const link = { connected: true, settings: { M204: { T: 1000 } }, sign: () => 1,
                 send: () => {} };
  const jog = new Jogger(link);
  for (const [dist, feed] of [[7.07, 1000], [141.4, 1000], [1.41, 6000], [50, 300]]) {
    const theirs = await page.evaluate(([d, f]) => {
      state.settings = { M204: { T: 1000 } };
      return chunkSeconds(d, f);
    }, [dist, feed]);
    const ours = jog.chunkSeconds(dist, feed);
    ok(Math.abs(theirs - ours) < 1e-9,
       `${dist} mm at F${feed}: ${ours.toFixed(4)} s both sides`);
  }
  jog.stop();
  await page.fill('#feed', '6000');
  await page.locator('#feed').blur();
}

console.log('\nAuto-repeat that arrives as keyup + keydown');
{
  // X11, VNC and most remote-desktop stacks implement a held key as a stream
  // of keyup/keydown pairs, with event.repeat false on both. Believed, that
  // halts and restarts the stream dozens of times a second — and every halt
  // drains the queue, which can drop the M400 pacing the chunk already on the
  // board.
  sent.length = 0;
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  const started = sent.filter((r) => r.name === 'run').length;
  ok(started === 1, 'the hold starts once');

  // The gap matters. A pair sent in the same tick is already absorbed by the
  // 25 ms that coalesces near-simultaneous presses into a diagonal; what needs
  // the release grace is a stack whose repeat is slow enough to clear that —
  // 35 ms here, inside RELEASE_GRACE and outside the coalescer.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => document.dispatchEvent(
      new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true })));
    await page.waitForTimeout(35);
    await page.evaluate(() => document.dispatchEvent(
      new KeyboardEvent('keydown',
        { code: 'KeyW', key: 'w', bubbles: true, repeat: false })));
    await page.waitForTimeout(35);
  }
  await page.waitForTimeout(200);

  ok(!sent.some((r) => r.name === 'halt'),
     'repeats do not halt the stream even once');
  ok(sent.filter((r) => r.name === 'run').length === started,
     'and do not restart it either');
  ok(await page.$eval('.key[data-code="KeyW"]', (e) => e.classList.contains('on')),
     'the key still reads as held');

  // A real release must still work, just a moment later.
  await page.keyboard.up('w');
  await page.waitForTimeout(250);
  ok(sent.some((r) => r.name === 'halt'), 'letting go for real still stops it');
  ok(!await page.$eval('.key[data-code="KeyW"]', (e) => e.classList.contains('on')),
     'and the key goes dark');
}

console.log('\nChanging the speed reaches a hold already running');
{
  sent.length = 0;
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  const first = sent.filter((r) => r.name === 'run').at(-1);
  eq(first?.body.feedrate, 6000, 'the hold starts at the current speed');

  await page.fill('#feed', '9000');
  await page.waitForTimeout(250);
  const retuned = sent.filter((r) => r.name === 'run').at(-1);
  eq(retuned?.body.feedrate, 9000,
     'raising it while the key is down re-tunes the stream in place');
  ok(!sent.some((r) => r.name === 'halt'),
     '...without a halt, so the machine does not stutter as you drag the box');
  ok(/F9000/.test(await page.innerText('#gline')), 'and the live line follows');

  await page.locator('#feed').blur();
  await page.keyboard.up('w');
  await page.waitForTimeout(200);
  await page.fill('#feed', '6000');
  await page.locator('#feed').blur();
  await page.waitForTimeout(120);
}

console.log('\nNothing on the page can ask for a quickstop');
{
  const html = await page.content();
  ok(!/M410/.test(html), 'M410 does not appear on the page at all');
  ok(!(await page.$('#modeSeg')) && !(await page.$('#span')),
     'and neither does the hold mode that needed it');
  ok(await page.isVisible('#stepField'), 'the chunk size is still there');
  ok(/STOP/.test(await page.innerText('#halt')), 'the button is a stop, not a panic');

  sent.length = 0;
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  const body = sent.find((r) => r.name === 'run')?.body;
  ok(body && body.mode === undefined && body.span === undefined,
     `run asks for nothing but a direction, speed and chunk: ${JSON.stringify(body)}`);
  await page.keyboard.up('w');
  await page.waitForTimeout(250);
}

console.log('\nTyping into a field is not driving');
{
  sent.length = 0;
  await page.click('#cmd');
  await page.keyboard.type('was');
  await page.waitForTimeout(250);
  ok(!sent.some((r) => r.name === 'run'),
     'w, a and s in the command box do not move the gantry');
  eq(await page.inputValue('#cmd'), 'was', 'they go in the box, which is the point');
  await page.fill('#cmd', '');
}
await page.close();

console.log('\nWhat is actually pacing the stream');
{
  const good = await openPage(browser, { m400_blocks: true, barrier_ms: 306 });
  ok(/M400 confirms each move/.test(await good.page.innerText('#barrierNote')),
     'a board where M400 blocks says so quietly');
  await good.page.close();

  const bad = await openPage(browser, { m400_blocks: false, barrier_ms: 11 });
  const note = await bad.page.innerText('#barrierNote');
  ok(/answers M400 without waiting/.test(note), `and one where it does not: ${note}`);
  ok(/11 ms/.test(note) && /clock/.test(note),
     'with the measurement and what it fell back to');
  await bad.page.close();
}

console.log('\nWith no board attached');
{
  const p3 = await browser.newPage();
  const seen = [];
  await p3.route('**/api/marlin/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'status') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ connected: false, responsive: false, port: null,
          baud: 115200, firmware: '', position: { X: 0, Y: 0, Z: 0, E: 0 }, queue: 0,
          steppers_on: false, soft_endstops: true, invert: { X: false, Y: false },
          emergency_parser: null, jogging: false, steps_per_mm: 80,
          mm_per_rev: { X: 40, Y: 40 }, settings: {}, unsupported: [],
          directions: DIRECTIONS, ports: [] }) });
    }
    if (name === 'log') {
      return route.fulfill({ status: 200, contentType: 'application/json',
                             body: JSON.stringify({ lines: [], seq: 0 }) });
    }
    seen.push(name);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await p3.goto(BASE + '/', { waitUntil: 'load' });
  await p3.waitForTimeout(500);

  await p3.keyboard.down('w');
  await p3.waitForTimeout(250);
  await p3.keyboard.up('w');
  await p3.waitForTimeout(150);
  ok(!seen.includes('run'), 'holding a key with no printer sends nothing');
  ok(await p3.$eval('body', (e) => e.classList.contains('offline')),
     'and the pad is dimmed so it is obvious why');
  ok(/no ports found/.test(await p3.innerText('#portSel')),
     'the port list says there is nothing to open');
  await p3.close();
}

console.log('\n/gcode is still the same page');
{
  const p4 = await browser.newPage();
  await p4.goto(BASE + '/gcode', { waitUntil: 'load' });
  ok(/Hold W A S D/.test(await p4.content()), 'the old path still works');
  await p4.close();
  const missing = await fetch(BASE + '/nope');
  ok(missing.status === 404, 'anything else is a 404');
}

console.log('\nThe road-following pages load and see the rover');
{
  // These came back from git after being removed with the ESP32 half. What
  // matters is that they still open without throwing — a page that throws on
  // load looks exactly like one that is fine until you try to drive with it.
  for (const route of ['/vision', '/follow', '/tune']) {
    const p = await browser.newPage();
    const errs = [];
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(BASE + route, { waitUntil: 'load' });
    await p.waitForTimeout(900);
    ok(errs.length === 0, `${route} — no console errors ${errs[0] || ''}`);
    // /follow is the exception: it owns the trim controls rather than showing
    // the read-only strip, because it is the page you adjust them from.
    if (route !== '/follow') {
      ok(!!(await p.$('.wtrim')), `${route} — the shared wheel-trim strip rendered`);
    } else {
      ok(!!(await p.$('#vFull')), `${route} — its own trim panel rendered`);
    }
    await p.close();
  }

  // /vision has no socket at all: it is the detector and its tuning, and it
  // reads the shared trim over HTTP. That is why it survives the ESP32 going
  // away completely unchanged.
  const v = await browser.newPage();
  const asked = [];
  v.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await v.goto(BASE + '/vision', { waitUntil: 'load' });
  await v.waitForTimeout(700);
  ok(asked.includes('/api/wheels'), '/vision reads the trim over HTTP');
  ok(asked.includes('/road.js'), '...and shares the detector rather than copying it');
  await v.close();

  // /follow does drive, so it gets a socket, and the status it receives has to
  // be the rover's rather than the DAC bench's.
  const f = await browser.newPage();
  await f.goto(BASE + '/follow', { waitUntil: 'load' });
  await f.waitForTimeout(900);
  const seen = await f.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${location.host}/`);
    ws.onmessage = (e) => { ws.close(); resolve(JSON.parse(e.data)); };
    setTimeout(() => resolve(null), 3000);
  }));
  ok(seen && seen.type === 'status', 'the socket pushes a status frame');
  ok(seen && 'running' in seen && 'esp_fresh' in seen && 'follow_cfg' in seen,
     'in the shape the page was written against');
  ok(seen && seen.motion !== undefined && seen.max_feed !== undefined,
     'plus what the rover is doing, in mm rather than volts');
  await f.close();
}


await browser.close();
marlin.proc.kill();
if (fail) {
  console.log('\nbench server output:\n' + bench.out.boot);
  console.log('\nmarlin server output:\n' + marlin.out.boot);
}
console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
