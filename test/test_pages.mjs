/**
 * Every page, in a real browser, against a real server.
 *
 * The unit tests cover what the server puts on the wire. What they cannot see
 * is a page that throws on load, and a page that throws on load looks exactly
 * like one that is fine until you try to drive with it. So: open every page,
 * fail on any console error, and assert on what actually left the browser.
 *
 * One server: the Creality mainboard, with no port opened, on 8198 — /gcode
 * and the road-following pages, with /api/marlin intercepted so nothing
 * reaches a serial port. What most of this tests is key -> vector -> request
 * body.
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

const BASE = 'http://127.0.0.1:8198';
// --no-actuator / --no-lidar: this suite runs on the Pi, and pressing Q or
// the lidar's START in a test must not run a real motor. --routes: nor may it
// read or write the routes somebody actually taught.
const ROUTES = path.join((await import('node:os')).tmpdir(), `routes-pages-${process.pid}.json`);
const marlin = serve(['--http', '8198', '--host', '127.0.0.1',
                      '--no-connect', '--no-camera', '--no-actuator', '--no-lidar', '--no-advertise',
                      '--routes', ROUTES]);
// Wait for the port rather than a fixed time. A fixed 1.4 s was sometimes not
// enough on the Pi, and a suite that starts early dies on its first page —
// leaving its server running with nobody reading its stdout, which the next
// run then finds on 8198 and loses to EPIPE halfway through.
for (let i = 0; i < 100 && marlin.out.dead === null; i++) {
  try { await fetch(BASE + '/api/qr'); break; } catch { await sleep(100); }
}

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

  await page.goto(BASE + '/gcode', { waitUntil: 'load' });
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
  // W and S are the OPPOSITE of DIRECTIONS.forward/back on the wire, on
  // purpose: the camera sits on the end DIRECTIONS calls the back, so the
  // pilot drives the chassis that way round and a human at the keyboard is
  // standing at the other end looking at what they call the front. See
  // manualVec() in public/gcode.html. A and D are untouched — which way a
  // thing spins does not depend on which end you call the front — but they are
  // scaled by turnScale (0.1), because the same wheel distance spent turning
  // on the spot reads as a much bigger movement than it does going forward.
  eq(await page.innerText('#gW'), 'X80.00 Y-80.00', 'W is the camera\'s forward');
  eq(await page.innerText('#gA'), 'X8.00 Y8.00',    'A spins, at a tenth of the step');
  eq(await page.innerText('#gS'), 'X-80.00 Y80.00', 'S');
  eq(await page.innerText('#gD'), 'X-8.00 Y-8.00',  'D');

  // The chunk size is most of the stopping distance, and the page has to say
  // so — the 100 mm default it shipped with was a 141 mm diagonal, eight and
  // a half seconds of coasting after the key came up.
  const hint = await page.innerText('#stopHint');
  // X and Y are the two wheels, so an 80 mm chunk on each moves the rover
  // 80 mm forward — not the 113.1 mm diagonal Marlin plans and times the
  // move by. The next chunk is on the board before the current one starts
  // (HOLD_MARGIN_S, 0.15 s), so up to two chunks plus 0.15 s of travel are
  // there when the key comes up: 113.1 mm at F16000 is 0.42 s, 188.6 mm/s of
  // ground, so 2 × 80 + 0.15 × 188.6 = 188.3 mm. (The fixture's M204 T1000
  // lets an 80 mm chunk reach F16000; the planner cap √(2·a·d) is 476 mm/s.)
  ok(/stops within 188\.3 mm of travel/.test(hint),
     `the stopping distance accounts for the two chunks on the board: ${hint}`);
  ok(!/113\.1/.test(hint), 'the planned distance is not passed off as the real one');
  const secs = parseFloat(/every ([\d.]+) s/.exec(hint)?.[1]);
  ok(secs === 0.42, `and how often a chunk goes out — its cruise time (${secs} s)`);
  ok(/always on the board before this one starts/.test(hint) && /never brakes/.test(hint),
     'plus why that is the stopping distance');

  // Spinning in place covers no ground, so quoting a distance would be a lie.
  await page.keyboard.down('a');
  await page.waitForTimeout(150);
  const spin = await page.innerText('#stopHint');
  ok(/turning/.test(spin) && /wheel travel each way/.test(spin),
     `a spin is reported as rotation, not travel: ${spin}`);
  await page.keyboard.up('a');
  await page.waitForTimeout(250);

  // 120 mm at F6000: a 169.7 mm diagonal, 1.70 s a chunk — past the 1.5 s
  // warning. At the page's own F16000 the same chunk is 0.64 s and says
  // nothing, so the slow feed is asked for here rather than assumed.
  await page.fill('#feed', '6000');
  await page.fill('#step', '120');
  await page.waitForTimeout(120);
  const big = await page.innerText('#stopHint');
  ok(/250\.6 mm of travel/.test(big) && /lower the chunk size/.test(big),
     `a chunk that would coast is called out: ${big}`);
  await page.fill('#feed', '16000');
  await page.fill('#step', '80');
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
  eq(await page.innerText('#gline'), 'G1 X80.00 Y-80.00 F16000',
     'the live line is the one the operator asked for');

  const run = sent.find((r) => r.name === 'run');
  ok(!!run, 'holding W posts a run');
  eq(run?.body.axes, { X: 1, Y: -1 }, 'the operator\'s forward is the camera end');
  eq([run?.body.step, run?.body.feedrate], [80, 16000],
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
  eq(runs.at(-1)?.body.axes, { X: 1, Y: 0 },
     'W+A sums to one motor — the CoreXY diagonal');
  eq(await page.innerText('#gline'), 'G1 X80.00 F16000',
     'and the line drops the motor that is not turning');
  ok((await page.innerText('#kbState')).includes('forward')
     && (await page.innerText('#kbState')).includes('left'), 'both are named');

  await page.keyboard.up('a');
  await page.waitForTimeout(250);
  eq(sent.filter((r) => r.name === 'run').at(-1)?.body.axes, { X: 1, Y: -1 },
     'letting go of A re-aims to plain forward without stopping');
  await page.keyboard.up('w');
  await page.waitForTimeout(200);

  // Opposites must cancel rather than fighting: W+S is not a direction.
  sent.length = 0;
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  await page.keyboard.down('s');
  await page.waitForTimeout(250);
  eq(await page.innerText('#gline'), 'G1 — F16000', 'W+S cancels to no move');
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
  eq(await page.innerText('#gW'), 'X25.00 Y-25.00', 'the tiles follow the chunk size');
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
  await page.fill('#feed', '16000');
  await page.fill('#step', '80');
  await page.locator('#step').blur();
}

console.log('\nThe page and the server agree about the pacing');
{
  // The stopping distance the page promises is computed in the page; the
  // pacing that delivers it is computed in marlin.js. Two copies of one
  // chunk clock (Jogger.holdSeconds), so they are checked against each other
  // rather than trusted — caps included: M203 per axis, and the planner's own
  // v² ≤ 2·a·d for a tiny chunk at a high feed.
  const settings = { M204: { T: 1000 }, M203: { X: 500, Y: 300 } };
  const link = { connected: true, settings, sign: () => 1, send: () => {} };
  const jog = new Jogger(link);
  for (const [x, y, feed] of [[5, 5, 1000], [100, 100, 1000], [1, 1, 6000],
                              [35, -35, 300], [0, 80, 30000], [2, 2, 30000]]) {
    const theirs = await page.evaluate(([xc, yc, f, s]) => {
      state.settings = s;
      return holdSeconds(xc, yc, f);
    }, [x, y, feed, settings]);
    const ours = jog.holdSeconds({ X: x, Y: y }, feed);
    ok(Math.abs(theirs - ours) < 1e-9,
       `X${x} Y${y} at F${feed}: ${ours.toFixed(4)} s both sides`);
  }
  await page.evaluate(() => { state.settings = {}; });
  jog.stop();
  await page.fill('#feed', '16000');
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
  eq(first?.body.feedrate, 16000, 'the hold starts at the current speed');

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
  await page.fill('#feed', '16000');
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

console.log('\nA slider or checkbox does not take the keyboard away from driving');
{
  // Every quick-tune slider and both invert boxes keep focus after use; they
  // used to count as "typing" and leave W A S D dead until a click elsewhere.
  for (const sel of ['#tuneAccel', '#invX']) {
    sent.length = 0;
    await page.focus(sel);
    await page.keyboard.down('w');
    await page.waitForTimeout(200);
    ok(sent.some((r) => r.name === 'run'), `W drives with ${sel} focused`);
    await page.keyboard.up('w');
    await page.waitForTimeout(250);
  }

  // A number box still types, and Enter hands the keyboard back.
  sent.length = 0;
  await page.click('#step');
  await page.keyboard.press('Enter');
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  ok(sent.some((r) => r.name === 'run'), 'Enter in a number box returns the keys to driving');
  await page.keyboard.up('w');
  await page.waitForTimeout(250);
}

console.log('\nApply sends what was edited');
{
  // One untouched value outside the server's guard (M203 X at 150000, say)
  // used to ride along with every Apply of that row and get it refused.
  sent.length = 0;
  await page.fill('input[data-code="M203"][data-letter="Y"]', '400');
  await page.click('button[data-apply="M203"]');
  await page.waitForTimeout(150);
  eq(sent.find((r) => r.name === 'setting')?.body, { code: 'M203', params: { Y: 400 } },
     'only Y, the field that was changed');
  await page.waitForTimeout(900);
  eq(await page.inputValue('input[data-code="M203"][data-letter="Y"]'), '400',
     'and the poll does not paint the old value back before the board confirms');

  sent.length = 0;
  await page.click('#btnMatch');
  await page.waitForTimeout(150);
  ok(sent.some((r) => r.name === 'match'), 'Match Y to X asks the server to do it');
}

console.log('\nEvery other page is one click away');
{
  for (const href of ['/dashboard', '/vision', '/follow', '/map', '/tune']) {
    ok(await page.$(`nav a[href="${href}"]`), `the main page links to ${href}`);
  }
}

console.log('\nThe lift: Q starts and stops, E turns it round');
{
  const act = async () => (await fetch(BASE + '/api/actuator')).json();
  sent.length = 0;
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  // textContent, not innerText: the heading is CSS-uppercased, and innerText
  // reports the text as rendered.
  ok(/Aktuator/.test(await page.textContent('#actCard')), 'the card is on the drive page');
  await page.keyboard.press('q');
  await page.waitForTimeout(250);
  let a = await act();
  ok(a.running && a.dry, 'Q starts it (dry here: --no-actuator, no pin touched)');
  await page.keyboard.press('e');
  await page.waitForTimeout(400);
  a = await act();
  ok(a.running && a.dir === 'down', 'E turns it round, still running');
  await page.keyboard.press('q');
  await page.waitForTimeout(250);
  ok(!(await act()).running, 'Q again stops it');
  await page.keyboard.press('q');
  await page.waitForTimeout(700);          // the card has polled and knows it runs
  await page.keyboard.press(' ');
  await page.waitForTimeout(250);
  ok(!(await act()).running, 'Space stops it, like everything else');
  await page.click('#actCard [data-a="up"]');
  await page.waitForTimeout(700);
  ok((await act()).dir === 'up', 'the ▲ button sets it to go up');
  const said = await page.innerText('#actCard [data-a="state"]');
  ok(/dayanıb · yuxarı/.test(said), `and the card says what it is doing  (${said})`);
  ok(!sent.some((r) => r.name === 'run'), 'none of it reached the wheels');
}

console.log('\nThe lidar: one START/STOP button and the voltage');
{
  const lid = async () => (await fetch(BASE + '/api/lidar-motor')).json();
  ok(/Lidar/.test(await page.textContent('#lidarCard')), 'the Lidar card is on the drive page');
  await page.click('#lidarCard [data-l="run"]');
  await page.waitForTimeout(250);
  let l = await lid();
  ok(l.running && l.dry && l.volts === 1.6, 'START spins it at 1.6 V (dry here: --no-lidar)');
  ok(/STOP/.test(await page.textContent('#lidarCard [data-l="run"]')), 'and the button now says STOP');
  await page.keyboard.press(' ');
  await page.waitForTimeout(250);
  ok((await lid()).running, 'Space leaves it spinning — it turns through a whole run');
  await page.fill('#lidarCard [data-l="volts"]', '2');
  await page.press('#lidarCard [data-l="volts"]', 'Enter');
  await page.locator('#lidarCard [data-l="volts"]').blur();
  await page.waitForTimeout(250);
  l = await lid();
  ok(l.volts === 2 && l.writes.at(-1) === 'on 55.6', `the voltage field applies at once  (${l.writes.at(-1)})`);
  await page.click('#lidarCard [data-l="run"]');
  await page.waitForTimeout(250);
  ok(!(await lid()).running, 'STOP stops it');
}

console.log('\nScenarios — the way to a load, taught one step at a time');
{
  const t = await page.textContent('#teachCard');
  ok(/Ssenarilər/.test(t) && /öyrədilməyib/.test(t), 'the card is there, nothing taught yet');
  await page.click('#teachCard [data-slot="2"]');
  await page.click('#teachCard [data-t="recStep"]');
  await page.waitForTimeout(400);
  ok(await page.isVisible('#teachCard [data-t="rec"]'), '+ Addım öyrət puts up the recording banner');
  const said = await page.innerText('#teachCard [data-t="recText"]');
  ok(/A2/.test(said) && /addım 1 \(yeni\)/.test(said),
     `for the slot that was picked, as its first step  (${said})`);
  await page.click('#teachCard [data-t="cancel"]');
  await page.waitForTimeout(400);
  ok(!(await page.isVisible('#teachCard [data-t="rec"]')), 'and Ləğv et throws it away');
  ok(await page.isDisabled('#teachCard [data-t="run"]'),
     'there is nothing to carry until the scenario has a step');

  await page.selectOption('#teachCard [data-t="key"]', 'W');
  await page.fill('#teachCard [data-t="mm"]', '400');
  await page.click('#teachCard [data-t="addStep"]');
  await page.waitForTimeout(400);
  const steps = await page.innerText('#teachCard [data-t="steps"]');
  ok(/1\.\s*W 400/.test(steps) && /yazılıb/.test(steps), `a typed step is listed  (${steps.replace(/\s+/g, ' ')})`);
  ok(!(await page.isDisabled('#teachCard [data-t="run"]')), 'one step is enough to send a run');
  ok(/A2 YÜKÜNƏ GET/.test(await page.innerText('#teachCard [data-t="run"]')), 'named after the pickup point');
  page.once('dialog', (d) => d.accept());
  await page.click('#teachCard [data-t="steps"] [data-do="del"]');
  await page.waitForTimeout(400);
  ok(await page.isDisabled('#teachCard [data-t="run"]'), 'and deleting it leaves the scenario untaught');
}
await page.close();

console.log('\nWhat the board did not keep, and whether it is saved');
{
  const p = await openPage(browser, {
    unsaved: true, save_pending: false,
    rejected: { M205: { Y: { asked: 6, kept: 0.6 } } },
    settings: { M92: { X: 80, Y: 80 }, M204: { T: 1000 }, M203: { X: 500, Y: 500 },
                M205: { X: 6, Y: 0.6 }, M906: { X: 580, Y: 580 } },
  });
  const msg = await p.page.innerText('.rowmsg[data-msg="M205"]');
  ok(/asked 6, the board kept 0\.6/.test(msg) && /caps it/.test(msg),
     `a firmware cap is shown on its row: ${msg}`);
  ok(/Press Save to EEPROM/.test(await p.page.innerText('#saveState')),
     'unsaved settings with no save coming say to press Save');
  eq(p.errs, [], 'no console errors');
  await p.page.close();

  const q = await openPage(browser, { unsaved: false });
  ok(/saved in EEPROM/.test(await q.page.innerText('#saveState')), 'and saved says saved');
  await q.page.close();
}

console.log('\nWhat the M400 button will actually do');
{
  // The held-key stream no longer relies on M400 either way (see marlin.js) —
  // this is purely a readout of what pressing the M400 button below will do.
  const good = await openPage(browser, { m400_blocks: true, barrier_ms: 306 });
  ok(/M400 waits for the planner/.test(await good.page.innerText('#barrierNote')),
     'a board where M400 blocks says so');
  await good.page.close();

  const bad = await openPage(browser, { m400_blocks: false, barrier_ms: 11 });
  const note = await bad.page.innerText('#barrierNote');
  ok(/answers M400 without waiting/.test(note), `and one where it does not: ${note}`);
  ok(/11 ms/.test(note) && /will not actually block/.test(note),
     'with the measurement and what pressing it would do');
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
  await p3.goto(BASE + '/gcode', { waitUntil: 'load' });
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

console.log('\n/ is the hub, /gcode the drive page');
{
  const p4 = await browser.newPage();
  await p4.goto(BASE + '/gcode', { waitUntil: 'load' });
  ok(/Hold W A S D/.test(await p4.content()), '/gcode is the drive page');
  await p4.close();
  const hub = await (await fetch(BASE + '/')).text();
  ok(/Robot kontrol/.test(hub) && /api\/pages/.test(hub), '/ is the hub, built from /api/pages');
  const missing = await fetch(BASE + '/nope');
  ok(missing.status === 404, 'anything else is a 404');
}

console.log('\nThe road-following pages load and see the rover');
{
  // A page that throws on load looks exactly like one that is fine until you
  // try to drive with it.
  for (const route of ['/', '/vision', '/follow', '/tune', '/map', '/dashboard', '/lidar', '/plc', '/pins']) {
    const p = await browser.newPage();
    const errs = [];
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(BASE + route, { waitUntil: 'load' });
    await p.waitForTimeout(900);
    ok(errs.length === 0, `${route} — no console errors ${errs[0] || ''}`);
    await p.close();
  }

  // /vision has no socket at all: it is the detector and its tuning, sharing
  // road.js with /follow rather than each page keeping its own copy.
  const v = await browser.newPage();
  const asked = [];
  v.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await v.goto(BASE + '/vision', { waitUntil: 'load' });
  await v.waitForTimeout(700);
  ok(asked.includes('/road.js'), '/vision shares the detector rather than copying it');
  await v.close();

  // /follow does drive, so it gets a socket.
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
  ok(seen && 'mission' in seen && 'want' in seen,
     'and the run, so /map can draw it without a camera');
  await f.close();
}

console.log('\nThe map page draws the field and picks a station');
{
  const p = await browser.newPage();
  await p.goto(BASE + '/map', { waitUntil: 'load' });
  await p.waitForTimeout(900);

  // The map is the field, not a picture of one: every station in FIELD has to
  // have a button, or a station exists that nobody can send the rover to.
  const got = await p.evaluate(() =>
    [...document.querySelectorAll('[data-go]')].map((b) => b.dataset.go).sort().join(' '));
  ok(got === 'A1 A2 A3 B1 B2 B3', `all six stations are pickable  (${got})`);

  // Picking one has to reach the server, because /follow is what acts on it
  // and it is a different page — possibly on a different machine.
  await p.click('[data-go="A2"]');
  await p.waitForTimeout(400);
  const want = await p.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${location.host}/`);
    ws.onmessage = (e) => { ws.close(); resolve(JSON.parse(e.data).want); };
    setTimeout(() => resolve('timeout'), 3000);
  }));
  ok(want === 'A2', `the choice reaches the server  (${want})`);

  // And the plan it shows has to be the plan the rover will drive: two
  // junctions to A2, right then left. If this list and mission.js ever
  // disagree, the page is lying about what is about to happen.
  const steps = await p.evaluate(() => $('steps').textContent.replace(/\s+/g, ' ').trim());
  ok(/J1.*sağa.*J2.*sola.*A2/.test(steps), `and reads as the route  (${steps})`);

  // …and as the moves, which is the half a person cannot check against the
  // field by eye: a 180° at the station is not visible on a map.
  ok(/körlemesine.*çizgiyi ara.*çizgiyi takip.*180° dön.*geri gir/s.test(steps),
     'and lists the blind moves either side of it');

  // Tapping the field itself must pick the same way the buttons do.
  const tapped = await p.evaluate(() => {
    const v = fieldView(cv.width, cv.height);
    const n = fieldNode('A3');
    const [px, py] = v.px(n.x, n.y);
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r.left + px * (r.width / cv.width),
      clientY: r.top + py * (r.height / cv.height) }));
    return $('rTarget').textContent;
  });
  ok(tapped === 'A3', `tapping the map picks a station too  (${tapped})`);
  await p.close();
}

console.log('\n/vision shows what the QR reader read');
{
  const v = await browser.newPage();
  await v.goto(BASE + '/vision', { waitUntil: 'load' });
  await v.waitForTimeout(900);
  const st = await v.innerText('#qrState');
  ok(st === 'gözləyir', `the card asks the server, which has read nothing yet  (${st})`);
  ok(/kadra baxıldı/.test(await v.innerText('#qrMeta')),
     'and says how many frames it has looked at');
  await v.close();
}

console.log('\n/follow offers the cargo run, and refuses one never taught');
{
  const f = await browser.newPage();
  const errs = [];
  f.on('pageerror', (e) => errs.push(String(e)));
  await f.goto(BASE + '/follow', { waitUntil: 'load' });
  await f.waitForTimeout(900);
  const got = await f.evaluate(() =>
    [...document.querySelectorAll('[data-cargo]')].map((b) => b.dataset.cargo).join(' '));
  ok(got === '1 2 3', `three slots  (${got})`);
  await f.click('[data-cargo="2"]');
  await f.waitForTimeout(300);
  const why = await f.innerText('#mWhy');
  ok(/öyrədilməyib/.test(why), `says the way there has not been taught  (${why})`);
  // The QR reader's answer is on the driving page too, not only on /vision.
  const qrMeta = await f.innerText('#qrMeta');
  ok(/kadra baxıldı/.test(qrMeta) && (await f.innerText('#qrState')) !== '–',
     `and shows what the QR reader sees while it drives  (${qrMeta})`);
  eq(errs, [], 'no page errors');
  await f.close();
}

console.log('\n/follow ignores a stale "not running" that arrives just after arming');
{
  // Every cargo run on 2026-09-14 died 10–150 ms after SÜRMƏYƏ BAŞLA: a status
  // the server sent before our START arrived late, still said running: false,
  // and was taken for the server stopping the run. Its STOP then cancelled the
  // taught leg. Driven here by handing ws.onmessage the statuses directly, in
  // one synchronous evaluate, so no real status can land in between.
  const f = await browser.newPage();
  const errs = [];
  f.on('pageerror', (e) => errs.push(String(e)));
  await f.goto(BASE + '/follow', { waitUntil: 'load' });
  await f.waitForTimeout(900);
  const stale = await f.evaluate(() => {
    src.ready = () => true;               // no camera on this server
    const feed = (running) => ws.onmessage({ data: JSON.stringify({ type: 'status', running }) });
    arm();
    feed(false);                          // sent before START reached the server
    const afterStale = armed;
    feed(true);                           // START confirmed
    feed(false);                          // and now a real stop
    return { afterStale, afterStop: armed, why: $('why').textContent };
  });
  ok(stale.afterStale, 'a running: false from before START does not disarm');
  ok(!stale.afterStop && stale.why === 'sunucu durdurdu',
     `one after the server said running: true does  (${stale.why})`);
  eq(errs, [], 'no page errors');
  await f.close();
}


await browser.close();
marlin.proc.kill();
try { (await import('node:fs')).unlinkSync(ROUTES); } catch { /* never written */ }
if (fail) {
  console.log('\nserver output:\n' + marlin.out.boot);
}
console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
