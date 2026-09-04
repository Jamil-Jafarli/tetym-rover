/**
 * Vision page checks — runs the REAL detection code out of public/vision.html
 * in a real browser, against synthetic frames.
 *
 * It does not reimplement anything: the <script> is lifted verbatim out of the
 * page and evaluated, so a change to the page is a change to what is tested.
 *
 *   node test/test_vision.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// Playwright is a dev-only dependency and may well be installed globally
// rather than in this folder, so resolve it the forgiving way.
const req = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = req('playwright'));
} catch {
  try {
    ({ chromium } = req(
      req('child_process').execSync('npm root -g').toString().trim() + '/playwright'));
  } catch {
    console.log('\nplaywright tapılmadı — bu test atlanır (npm i -D playwright)\n');
    process.exit(0);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, '..', 'public', 'vision.html');
const ROAD = join(here, '..', 'public', 'road.js');
// The page's picture source. Loaded because the page loads it: the script
// lifted below calls camMount() near the top, and a missing dependency there
// leaves every `const` after it in the temporal dead zone — which shows up as
// a baffling error about an unrelated name.
const CAM = join(here, '..', 'public', 'cam.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };

/* ── synthetic frames ──────────────────────────────────────────────────
 * Painted straight onto the canvas the page already uses, so the pipeline
 * downstream is the real one, pixels and all.
 */
// `shift` is a constant lateral offset (the robot sitting off-centre); the
// road is WIDEST at the bottom, because that is what perspective does.
const track = (dark, shift = 0) => `
  ctx.fillStyle = '${dark ? '#8a8a8a' : '#1b1b1b'}'; ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y++) {
    const k = y / H;                       // 0 far (top), 1 near (bottom)
    const c = W/2 + ${shift} * W * 0.26;
    const w = W * (0.17 + 0.19 * k);
    ${dark ? `
      ctx.fillStyle = '#f4f4f4';
      ctx.fillRect(c - w/2 - W*0.05, y, W*0.05, 1);
      ctx.fillRect(c + w/2,          y, W*0.05, 1);
      ctx.fillStyle = '#111';    ctx.fillRect(c - w/2, y, w, 1);
    ` : `
      ctx.fillStyle = '#f4f4f4'; ctx.fillRect(c - w/2, y, w, 1);
    `}
  }`;

const SCENES = {
  darkTrack:  (t = 0) => track(true,  t),   // the real track: black road, white edges
  whiteTrack: (t = 0) => track(false, t),   // the other kind: white road, dark floor
};

const CLUTTER = {
  sofa:  `ctx.fillStyle = '#ededed'; ctx.fillRect(W*0.80, H*0.50, W*0.20, H*0.32);`,
  light: `ctx.fillStyle = '#e8e8e8'; ctx.beginPath();
          ctx.ellipse(W*0.20, H*0.80, W*0.13, H*0.07, 0, 0, 7); ctx.fill();`,
  // a yellow board — the thing that used to drag Otsu down to floor level
  board: `ctx.fillStyle = '#e8d24a'; ctx.fillRect(W*0.02, H*0.46, W*0.22, H*0.24);`,
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('data:text/html,<canvas id="view" width="480" height="360"></canvas>'
              + '<video id="cam"></video>');

// Lift the page's own script in, minus the parts that need a camera or a DOM
// full of controls. Everything that decides anything survives verbatim.
const html = readFileSync(PAGE, 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];

// Stub the controls the script binds to, so the real code runs untouched.
await page.evaluate(() => {
  const need = ['dot','state','err','rErr','rBands','rFps','steer','hint','devs',
                'start','mirror','flip','mask','pick','file','mAuto','mDark','mWhite',
                'vAuto','modeHint','autoWhy','vRoi','roi','vBias','bias','vSat','sat',
                'vMin','minw','vBands','bands','vSide','side','vJump','jump','vThr'];
  const vals = { roi:45, bias:0, sat:60, minw:6, bands:8, side:18, jump:14 };
  for (const id of need) {
    if (document.getElementById(id)) continue;
    const el = document.createElement(id in vals ? 'input' : 'div');
    if (id in vals) { el.type = 'range'; el.value = String(vals[id]); }
    el.id = id;
    document.body.appendChild(el);
  }
  // The live loop would run detect() on its own schedule; the tests drive it
  // themselves, one frame at a time, so the frame is known when it is read.
  window.requestAnimationFrame = () => 0;
  window.navigator.mediaDevices ??= { enumerateDevices: async () => [] };
});
// As real <script>s, so their top-level declarations land in global scope and
// the tests can call detect() / setMode() exactly as the page does. road.js
// first: it is what the page itself loads first.
await page.addScriptTag({ content: readFileSync(ROAD, 'utf8') });
await page.addScriptTag({ content: readFileSync(CAM, 'utf8') });
await page.addScriptTag({ content: script });

// `from` seeds the auto decision with a *wrong* answer, so a pass can only
// mean the algorithm actively changed its mind — not that it inherited the
// right mode from the previous scene.
async function run(scene, clutter = [], mode = 'auto', from = null) {
  return page.evaluate(({ scene, clutter, mode, from }) => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const W = c.width, H = c.height;
    new Function('ctx', 'W', 'H', scene + clutter.join('\n'))(ctx, W, H);
    setMode(mode);
    if (from) autoMode = from;
    let res = null;
    // A few frames: the temporal lock and the auto vote are stateful, and a
    // one-frame answer would not exercise either.
    for (let i = 0; i < 4; i++) {
      const d = ctx.getImageData(0, 0, W, H);
      res = detect(d.data);
    }
    const near = res.pts[0];
    return {
      mode: res.mode,
      bands: res.pts.length,
      err: near ? +((near.x - W / 2) / (W / 2)).toFixed(2) : null,
      why: autoWhy && { probe: +autoWhy.probe.toFixed(2),
                        contrast: +autoWhy.contrast.toFixed(2),
                        qd: autoWhy.qd, qw: autoWhy.qw,
                        votes: [autoWhy.vP, autoWhy.vC, autoWhy.vQ]
                                 .map(v => (v >= 0 ? '+' : '') + v.toFixed(2)).join(' '),
                        sum: +autoWhy.sum.toFixed(2) },
    };
  }, { scene, clutter, mode, from });
}

console.log('\nAvto rejim — trek növünü özü seçir');
for (const [name, want, scene, clutter] of [
  ['qara yol, düz',            'dark',  SCENES.darkTrack(0),     []],
  ['qara yol, sağa sürüşmüş',  'dark',  SCENES.darkTrack(0.5),   []],
  ['qara yol + ağ mebel',      'dark',  SCENES.darkTrack(0),     [CLUTTER.sofa]],
  ['qara yol + işıq ləkəsi',   'dark',  SCENES.darkTrack(0),     [CLUTTER.light]],
  ['qara yol + sarı lövhə',    'dark',  SCENES.darkTrack(0),     [CLUTTER.board]],
  ['qara yol + hamısı',        'dark',  SCENES.darkTrack(0.3),   [CLUTTER.sofa, CLUTTER.light, CLUTTER.board]],
  ['ağ yol, düz',              'white', SCENES.whiteTrack(0),    []],
  ['ağ yol, sola sürüşmüş',    'white', SCENES.whiteTrack(-0.5), []],
  ['ağ yol + ağ mebel',        'white', SCENES.whiteTrack(0),    [CLUTTER.sofa]],
]) {
  // start from the opposite conclusion every time
  const r = await run(scene, clutter, 'auto', want === 'dark' ? 'white' : 'dark');
  ok(r.mode === want,
     `${name.padEnd(26)} → ${r.mode.padEnd(5)} (gözlənilən ${want})`
   + `  alt ${r.why.probe} · kontrast ${r.why.contrast}`
   + ` · keyfiyyət ${r.why.qd}/${r.why.qw} · [${r.why.votes}] = ${r.why.sum}`);
}

console.log('\nAldadıcı hallarda qərarını dəyişmir');
{
  // The robot parked straddling a white edge line: the patch under it IS
  // white, so the probe argues "white road" — loudly and wrongly. The other
  // two signals have to hold the line.
  const r = await run(SCENES.darkTrack(0.79), [], 'auto', 'dark');
  ok(r.mode === 'dark',
     `ağ kənar xəttin üstündə dayanmış → ${r.mode}`
   + `  alt ${r.why.probe} · [${r.why.votes}] = ${r.why.sum}`);
}
{
  // Hysteresis: a genuine change of track type is accepted, but not instantly.
  const r = await page.evaluate(() => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const px = s => new Function('ctx', 'W', 'H', s)(ctx, c.width, c.height);
    const step = n => { let m; for (let i = 0; i < n; i++)
      m = detect(ctx.getImageData(0, 0, c.width, c.height).data).mode; return m; };
    setMode('auto');
    px(`ctx.fillStyle='#8a8a8a';ctx.fillRect(0,0,W,H);
        ctx.fillStyle='#f4f4f4';ctx.fillRect(W*0.28,0,W*0.05,H);ctx.fillRect(W*0.67,0,W*0.05,H);
        ctx.fillStyle='#111';ctx.fillRect(W*0.33,0,W*0.34,H);`);
    const locked = step(4);
    px(`ctx.fillStyle='#1b1b1b';ctx.fillRect(0,0,W,H);
        ctx.fillStyle='#f4f4f4';ctx.fillRect(W*0.33,0,W*0.34,H);`);
    return { locked, after3: step(3), after15: step(15) };
  });
  ok(r.locked === 'dark',   `qara trekə kilidlənir → ${r.locked}`);
  ok(r.after3 === 'dark',   `ağ trek 3 kadr göstərilir → hələ ${r.after3} (tələsmir)`);
  ok(r.after15 === 'white', `15 kadr sonra → ${r.after15} (həqiqi dəyişiklik qəbul olunur)`);
}

console.log('\nQərar düzgün olanda yol da tapılır');
for (const [name, scene, clutter, want] of [
  ['qara yol düz',            SCENES.darkTrack(0),     [], 0],
  ['qara yol sağa',           SCENES.darkTrack(0.5),   [], 1],
  ['qara yol sola',           SCENES.darkTrack(-0.5),  [], -1],
  ['qara yol + mebel + işıq', SCENES.darkTrack(0),     [CLUTTER.sofa, CLUTTER.light], 0],
  ['ağ yol düz',              SCENES.whiteTrack(0),    [], 0],
  ['ağ yol sağa',             SCENES.whiteTrack(0.5),  [], 1],
]) {
  const r = await run(scene, clutter);
  const sign = r.err == null ? null : r.err > 0.08 ? 1 : r.err < -0.08 ? -1 : 0;
  ok(r.bands >= 3 && sign === want,
     `${name.padEnd(26)} → sapma ${String(r.err).padStart(5)} , ${r.bands} zolaq`);
}

console.log('\nƏl ilə seçim avtonu üstələyir');
{
  const r = await run(SCENES.darkTrack(0), [], 'white');
  ok(r.mode === 'white', `qara trekdə «Ağ yol» düyməsi → ${r.mode} (avto qərarı ləğv olunur)`);
  const d = await run(SCENES.whiteTrack(0), [], 'dark');
  ok(d.mode === 'dark', `ağ trekdə «Qara yol» düyməsi → ${d.mode}`);
}

console.log('\nSürüş boyu rejim kilidlənir');
{
  // The whole point: a run commits to one kind of track and stays there. Half
  // a lap in, the only things that can still argue for the other reading are a
  // shadow or a person walking past.
  const r = await page.evaluate(() => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const px = s => new Function('ctx', 'W', 'H', s)(ctx, c.width, c.height);
    const step = n => { let m; for (let i = 0; i < n; i++)
      m = detect(ctx.getImageData(0, 0, c.width, c.height).data).mode; return m; };
    const DARK = `ctx.fillStyle='#8a8a8a';ctx.fillRect(0,0,W,H);
        ctx.fillStyle='#f4f4f4';ctx.fillRect(W*0.28,0,W*0.05,H);ctx.fillRect(W*0.67,0,W*0.05,H);
        ctx.fillStyle='#111';ctx.fillRect(W*0.33,0,W*0.34,H);`;
    const WHITE = `ctx.fillStyle='#1b1b1b';ctx.fillRect(0,0,W,H);
        ctx.fillStyle='#f4f4f4';ctx.fillRect(W*0.33,0,W*0.34,H);`;

    setMode('auto');
    px(DARK);
    const locked = step(4);            // decide, as it would before you press
    roadLockAuto(true);                // ARM
    px(WHITE);
    const held = step(60);             // three seconds of the other track type
    const scored = autoWhy && autoWhy.want;   // still measuring, just not acting
    roadLockAuto(false);               // STOP
    const freed = step(20);
    return { locked, held, scored, freed };
  });
  ok(r.locked === 'dark',  `sürüşdən əvvəl qara seçir → ${r.locked}`);
  ok(r.held === 'dark',
     `kilidlidirsə 60 kadr ağ trek də fikrini dəyişdirmir → ${r.held}`);
  ok(r.scored === 'white',
     `amma ölçməyə davam edir, sadəcə tətbiq etmir (autoWhy.want = ${r.scored})`);
  ok(r.freed === 'white', `dayandıqdan sonra yenidən sərbəstdir → ${r.freed}`);
}
{
  // Locking before anything has been decided must not freeze the default —
  // the next frame still gets its one instant commit.
  const r = await page.evaluate(() => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    setMode('auto');                   // clears autoSeen
    roadLockAuto(true);
    new Function('ctx', 'W', 'H', `ctx.fillStyle='#1b1b1b';ctx.fillRect(0,0,W,H);
      ctx.fillStyle='#f4f4f4';ctx.fillRect(W*0.33,0,W*0.34,H);`)(ctx, c.width, c.height);
    let m;
    for (let i = 0; i < 4; i++) m = detect(ctx.getImageData(0, 0, c.width, c.height).data).mode;
    roadLockAuto(false);
    return m;
  });
  ok(r === 'white', `heç nə seçilməmişkən kilidlənsə, ilk kadr yenə qərar verir → ${r}`);
}

console.log('\nQərarsız kadrda rejim dəyişmir');
{
  // Uniform grey: nothing to see. The mode must not thrash.
  const r = await page.evaluate(() => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    setMode('auto');
    // establish a dark-track lock first
    new Function('ctx', 'W', 'H', `
      ctx.fillStyle = '#8a8a8a'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#111'; ctx.fillRect(W*0.33, 0, W*0.34, H);
      ctx.fillStyle = '#f4f4f4';
      ctx.fillRect(W*0.28, 0, W*0.05, H); ctx.fillRect(W*0.67, 0, W*0.05, H);
    `)(ctx, c.width, c.height);
    for (let i = 0; i < 4; i++) detect(ctx.getImageData(0, 0, c.width, c.height).data);
    const locked = detect(ctx.getImageData(0, 0, c.width, c.height).data).mode;
    // now a featureless frame
    ctx.fillStyle = '#9a9a9a'; ctx.fillRect(0, 0, c.width, c.height);
    let after = locked;
    for (let i = 0; i < 30; i++)
      after = detect(ctx.getImageData(0, 0, c.width, c.height).data).mode;
    return { locked, after };
  });
  ok(r.locked === 'dark', `əvvəlcə qara trekə kilidlənir → ${r.locked}`);
  ok(r.after === 'dark',  `30 kadr boz ekrandan sonra hələ də → ${r.after}`);
}

await browser.close();
console.log(`\n${fail ? 'FAILED' : 'ALL CHECKS PASSED'} — ${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
