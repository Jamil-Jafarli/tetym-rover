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

// Scenes with no line in them at all. These are what the detector used to get
// wrong: a threshold always returns a split, so an unlit corner of a room came
// back as a wide, confident, entirely imaginary corridor.
const NOLINE = {
  // A dim room, with sensor noise on it so it is not an impossibly flat frame.
  dim: `
    ctx.fillStyle = '#1e1e1e'; ctx.fillRect(0, 0, W, H);
    const im = ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < im.data.length; i += 4) {
      const n = (Math.random() * 14) | 0;
      im.data[i] += n; im.data[i + 1] += n; im.data[i + 2] += n;
    }
    ctx.putImageData(im, 0, 0);`,
  // A soft light gradient across the floor: plenty of contrast end to end, but
  // no step anywhere — the difference between a REGION and a LINE.
  gradient: `
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#141414'); g.addColorStop(1, '#c8c8c8');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);`,
};

// A real line in bad light: dim floor, dimmer tape, no white edge lines at all
// and nothing in the frame a human would call white.
const DIM_LINE = `
  ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y++) {
    const w = W * (0.17 + 0.19 * (y / H));
    ctx.fillStyle = '#101010'; ctx.fillRect(W / 2 - w / 2, y, w, 1);
  }`;

/**
 * A 90° corner: a road up the middle that stops at `at` and leaves sideways.
 *
 * `dir` is +1 for a road that turns right, -1 for left. The arm is drawn thick
 * enough to fill a band of its own, which is what a corner actually looks like
 * from a camera this close to the ground — the arm is nearer than the road
 * that led to it, so it is the widest thing in the picture.
 */
const CORNER = (dir, at = 0.72, dark = true) => `
  ctx.fillStyle = '${dark ? '#8a8a8a' : '#1b1b1b'}'; ctx.fillRect(0, 0, W, H);
  const cx = W / 2, w = W * 0.16, yc = H * ${at};
  ctx.fillStyle = '${dark ? '#111' : '#f4f4f4'}';
  ctx.fillRect(cx - w / 2, yc - w / 2, w, H - (yc - w / 2));   // the road in
  ${dir > 0 ? `ctx.fillRect(cx - w / 2, yc - w / 2, W - (cx - w / 2), w);`
            : `ctx.fillRect(0, yc - w / 2, cx + w / 2, w);`}   // the arm out
`;

/**
 * The competition line, to the rules' own drawing: three EQUAL stripes,
 * blue | orange | blue, in the colours the PDF's vector fills actually use —
 * rgb(52,101,164) and rgb(255,128,0).
 *
 * `upTo` paints only the lower part of the frame, which is the shape of the
 * real track: paint exists inside a station and stops, with a QR code at its
 * end and nothing at all beyond. `qr` puts that 50 mm white patch on the line,
 * over the orange, which is the case the whole blue-pair design exists for.
 */
//
// A real QR is not a clean white square one stripe wide. `qrW` is its paper's
// width in stripes — the white quiet zone round the code makes it wider than
// the orange, so it eats into both blues. `modules` prints the black squares
// on it. `wash` is what the camera does next to a sheet of white paper:
// exposure drops and the blue beside it goes pale enough to lose its colour
// altogether, for the height of the paper.
const LINE = ({ shift = 0, upTo = 0, qr = null, floor = '#8f8f8f',
                qrW = 1, modules = false, wash = false } = {}) => `
  ctx.fillStyle = '${floor}'; ctx.fillRect(0, 0, W, H);
  for (let y = Math.floor(H * ${upTo}); y < H; y++) {
    const k = y / H;                      // 0 far (top), 1 near (bottom)
    const c = W / 2 + ${shift} * W * 0.26;
    const w = W * (0.10 + 0.16 * k);      // perspective: nearer is wider
    const s = w / 3;                      // equal thirds
    ctx.fillStyle = '#3465a4'; ctx.fillRect(c - w / 2, y, s, 1);
    ctx.fillStyle = '#ff8000'; ctx.fillRect(c - s / 2, y, s, 1);
    ctx.fillStyle = '#3465a4'; ctx.fillRect(c + s / 2, y, s, 1);
  }
  ${qr === null ? '' : QR_AT(qr, shift, qrW, modules, wash)}
`;

/** A QR code's paper at `k` down the frame, centred on where the line is. */
const QR_AT = (k, shift = 0, qrW = 1, modules = false, wash = false) => `{
    const k = ${k}, y = H * k, c = W / 2 + ${shift} * W * 0.26;
    const w = W * (0.10 + 0.16 * k), s = w / 3, q = s * ${qrW};
    ${wash ? `ctx.fillStyle = 'rgba(255,255,255,0.75)';
              ctx.fillRect(c - w / 2 - 2, y - q / 2, w + 4, q);` : ''}
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(c - q / 2, y - q / 2, q, q);   // 50 mm QR's paper
    ${modules ? `ctx.fillStyle = '#111';
      const n = 7, m = q * 0.8 / n, x0 = c - q * 0.4, y0 = y - q * 0.4;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
        if ((i * 3 + j * 5 + i * j) % 3 === 0) ctx.fillRect(x0 + i * m, y0 + j * m, m, m);` : ''}
  }`;

/**
 * The same line with a branch leaving it — a junction, which is the shape the
 * whole A1/A2/A3 problem is made of.
 *
 * The branch is square to the line, so from a camera looking along the line it
 * runs ACROSS the picture: its three stripes stack up the frame instead of
 * across it, and it reaches from the line out to the edge on whichever side it
 * leaves. `side` may be 'left', 'right' or 'both' — 'both' is J1, the only
 * crossroads on the field, where the start branch comes in behind and the main
 * line leaves east.
 *
 * `at` is where down the frame it sits, 0 at the top and 1 at the wheels, so
 * driving up to a junction is the same scene at a growing `at`. The stripe is
 * drawn 60 % as thick as the line is wide, which is roughly what
 * foreshortening does to a line you are looking along rather than across —
 * generous enough to be visible, mean enough that a detector needing the full
 * width would fail it.
 */
const BRANCH = ({ at = 0.7, side = 'left', shift = 0, floor = '#8f8f8f' } = {}) => `
  ${LINE({ shift, floor })}
  {
    const k = ${at}, yc = H * k;
    const c = W / 2 + ${shift} * W * 0.26;
    const w = W * (0.10 + 0.16 * k), s = w / 3, t = w * 0.6, ts = t / 3;
    const x0 = ${JSON.stringify(side)} === 'right' ? c - s / 2 : 0;
    const x1 = ${JSON.stringify(side)} === 'left'  ? c + s / 2 : W;
    ctx.fillStyle = '#3465a4'; ctx.fillRect(x0, yc - t / 2,      x1 - x0, ts);
    ctx.fillStyle = '#ff8000'; ctx.fillRect(x0, yc - ts / 2,     x1 - x0, ts);
    ctx.fillStyle = '#3465a4'; ctx.fillRect(x0, yc + ts / 2,     x1 - x0, ts);
  }
`;

// Things in a room that are the line's colours but are not the line. Each one
// breaks a different half of the test: the blue chair has no orange beside it,
// the orange crate has no blue either side, and the pair of blue boxes has the
// right colours in the right order but nothing between them at the right width.
const COLOUR_CLUTTER = {
  chair: `ctx.fillStyle = '#3465a4'; ctx.fillRect(W*0.80, H*0.55, W*0.17, H*0.30);`,
  crate: `ctx.fillStyle = '#ff8000'; ctx.fillRect(W*0.03, H*0.60, W*0.15, H*0.25);`,
  pair:  `ctx.fillStyle = '#3465a4';
          ctx.fillRect(W*0.02, H*0.50, W*0.06, H*0.40);
          ctx.fillRect(W*0.30, H*0.50, W*0.06, H*0.40);`,
  // The yellow box tape the rules put around every station, right beside the
  // line. Yellow is close enough to orange in hue to be worth proving against.
  tape:  `ctx.fillStyle = '#ffe000';
          ctx.fillRect(W*0.14, H*0.50, W*0.04, H*0.45);
          ctx.fillRect(W*0.82, H*0.50, W*0.04, H*0.45);`,
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
                'vAuto','modeHint','autoWhy','vRoi','roi','vBias','bias',
                'vContrast','contrast','vEdge','edge','vSat','sat',
                'vMin','minw','vBands','bands','vSide','side','vJump','jump',
                'vThr','vSeen','vArm','arm','rCorner','mLine','rEnd','rJunc',
                'vChroma','chroma','vHueTol','hueTol','vFill','fill'];
  const vals = { roi:45, bias:0, contrast:0, edge:18, sat:60, minw:6, bands:8,
                 side:18, jump:14, arm:80, chroma:45, hueTol:32, fill:50 };
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
// The QR card's poller and its overlay — the page calls both. Its fetch fails
// on a data: URL, which it is written to survive.
await page.addScriptTag({ content: readFileSync(ROAD.replace(/road\.js$/, 'qrview.js'), 'utf8') });
await page.addScriptTag({ content: script });

console.log('\nKontrast əyrisi (buildContrastLUT)');
{
  // A flat-colour synthetic frame cannot show contrast changing a detection
  // outcome: Otsu's split is invariant to any *linear* remap of luma, so it
  // finds the exact same gap whatever cfg.contrast is set to — this is
  // exactly why the feature is an S-curve (tanh) rather than a plain gain,
  // and is what this checks directly, against the lookup itself rather than
  // against a scene that cannot tell the two apart.
  const r = await page.evaluate(() => {
    cfg.contrast = 0;
    buildContrastLUT();
    const identity = Array.from(clut).every((v, i) => v === i);

    cfg.contrast = 2;
    buildContrastLUT();
    const endpoints = clut[0] === 0 && clut[255] === 255;
    const pivot = clut[128] === 128;
    let monotonic = true;
    for (let i = 1; i < 256; i++) if (clut[i] < clut[i - 1]) monotonic = false;
    // The whole point of tanh over a plain gain: a step near the pivot moves
    // further than the same-sized step near an extreme.
    const nearPivot = clut[138] - clut[118];
    const nearEdge = clut[255] - clut[235];
    cfg.contrast = 0;
    return { identity, endpoints, pivot, monotonic, nearPivot, nearEdge };
  });
  ok(r.identity, 'kontrast 0 → kimlik dönüşümü (dəyişiklik yoxdur)');
  ok(r.endpoints, 'uc nöqtələr qorunur → clut[0]=0, clut[255]=255');
  ok(r.pivot, 'orta boz nöqtə sabit qalır → clut[128]=128');
  ok(r.monotonic, 'əyri monoton — sıralamanı pozmur');
  ok(r.nearPivot > r.nearEdge,
     `S-əyrisi: pivot yaxınlığında fərq güclənir (${r.nearPivot} > ${r.nearEdge}), ucda yumşalır`);

  // Negative asks for the opposite: shrink everything toward mid-grey rather
  // than push it apart, so a glary frame's false spike softens back down.
  const r2 = await page.evaluate(() => {
    cfg.contrast = -2;
    buildContrastLUT();
    const pivot = clut[128] === 128;
    let monotonic = true;
    for (let i = 1; i < 256; i++) if (clut[i] < clut[i - 1]) monotonic = false;
    const shrunk = clut[255] < 255 && clut[0] > 0;
    cfg.contrast = 0;
    return { pivot, monotonic, shrunk };
  });
  ok(r2.pivot, 'mənfi kontrast: orta boz nöqtə sabit qalır → clut[128]=128');
  ok(r2.monotonic, 'mənfi kontrast: əyri monoton qalır');
  ok(r2.shrunk, 'mənfi kontrast: uc nöqtələr griyə yaxınlaşır (clut[0]>0, clut[255]<255)');
}

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
      contrast: res.contrast,
      corner: res.corner && { dir: res.corner.dir, dist: +res.corner.dist.toFixed(2),
                              over: +res.corner.over.toFixed(2) },
      end: res.end && { dist: +res.end.dist.toFixed(2) },
      junction: res.junction && { side: res.junction.side,
                                  dist: +res.junction.dist.toFixed(2),
                                  span: res.junction.span },
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

console.log('\nYarış xətti: mavi | narıncı | mavi');
for (const [name, scene, want] of [
  ['düz',                  LINE(),                        0],
  ['sağa sürüşmüş',        LINE({ shift: 0.5 }),          1],
  ['sola sürüşmüş',        LINE({ shift: -0.5 }),        -1],
  ['tünd döşəmədə',        LINE({ floor: '#3a3a3a' }),    0],
  ['açıq döşəmədə',        LINE({ floor: '#d8d8d8' }),    0],
]) {
  const r = await run(scene, [], 'line');
  const sign = r.err == null ? null : r.err > 0.08 ? 1 : r.err < -0.08 ? -1 : 0;
  ok(r.bands >= 3 && sign === want,
     `${name.padEnd(20)} → sapma ${String(r.err).padStart(5)} , ${r.bands} zolaq`);
}

console.log('\nQR kod xətti kəsmir — bütün məsələ budur');
{
  // The rules print a 50 mm QR ON the line at the end of every stub, and 50 mm
  // covers most of a 50 mm orange stripe. Hunt for the orange and the line
  // disappears exactly where the robot is heading; find the two BLUE stripes
  // and take the middle, and the QR is just a white patch between them.
  for (const at of [0.70, 0.80, 0.90]) {
    const r = await run(LINE({ qr: at }), [], 'line');
    ok(r.bands >= 3 && Math.abs(r.err) < 0.10,
       `QR kadrın ${Math.round(at * 100)} %-ində → zəncir qırılmır `
     + `(${r.bands} zolaq, sapma ${r.err})`);
  }
}

console.log('\nƏsl QR: kağızı narıncıdan enlidir, qara modulludur, yanındakı göyü soldurur');
{
  // What the rover actually met: the code's white paper is wider than the
  // orange stripe and bites into both blues, and next to it the camera's
  // exposure washes the blue out. Worst of all when the code is under the
  // wheels — the bottom band is where the chain has to start.
  for (const [name, o] of [
    ['1.3× en, 80 %',                      { qr: 0.80, qrW: 1.3, modules: true }],
    ['1.6× en, 80 %',                      { qr: 0.80, qrW: 1.6, modules: true }],
    ['1.6× en, təkərlərin altında',        { qr: 0.93, qrW: 1.6, modules: true }],
    ['göy solub, 75 %',                    { qr: 0.75, qrW: 1.3, modules: true, wash: true }],
    ['göy solub, təkərlərin altında',      { qr: 0.93, qrW: 1.3, modules: true, wash: true }],
    ['1.6× en, sağa sürüşmüş',             { qr: 0.85, qrW: 1.6, modules: true, shift: 0.4 }],
  ]) {
    const r = await run(LINE(o), [], 'line');
    const want = o.shift ? 1 : 0;
    const sign = r.err == null ? null : r.err > 0.08 ? 1 : r.err < -0.08 ? -1 : 0;
    ok(r.bands >= 5 && sign === want && !r.end,
       `${name.padEnd(30)} → ${r.bands} zolaq, sapma ${r.err}, son: ${r.end ? r.end.dist : 'yox'}`);
  }
  const auto = await run(LINE({ qr: 0.93, qrW: 1.6, modules: true }), [], 'auto');
  ok(auto.mode === 'line' && auto.bands >= 5,
     `avto rejimdə də — /follow belə sürür (${auto.mode}, ${auto.bands} zolaq)`);

  // Not a licence to invent a line: a QR lying on bare floor is still no line.
  const lone = await run(`ctx.fillStyle = '#8f8f8f'; ctx.fillRect(0, 0, W, H);
                          ${QR_AT(0.85, 0, 1.6, true)} ${QR_AT(0.6, 0, 1.6, true)}`, [], 'line');
  ok(lone.bands === 0, `xətsiz döşəmədə QR xətt deyil (${lone.bands} zolaq)`);
  // …and a stub that ends at its QR still ends there.
  const stub = await run(LINE({ upTo: 0.62, qr: 0.64, qrW: 1.3, modules: true }), [], 'line');
  ok(!!stub.end, `QR-la bitən xəttin sonu yenə görünür (son: ${stub.end && stub.end.dist})`);
}

console.log('\nXəttin bitdiyi yeri görür');
{
  // The competition track paints a line only inside a station — 2.7 m at a
  // pickup, 3.4 m at the start — and nothing between. A chain that stops part
  // way up a frame whose colours are otherwise perfect is the robot ARRIVING,
  // not the detector failing.
  const full = await run(LINE(), [], 'line');
  ok(!full.end, `bütöv xətt: son yoxdur  (${full.bands} zolaq)`);

  const stops = await run(LINE({ upTo: 0.72 }), [], 'line');
  ok(stops.end, `qısa xətt: son tapıldı  (${stops.end && stops.end.dist})`);

  // And it has to move down the picture as the robot drives up to it.
  const far = await run(LINE({ upTo: 0.62 }), [], 'line');
  const near = await run(LINE({ upTo: 0.82 }), [], 'line');
  ok(far.end && near.end && near.end.dist > far.end.dist,
     `yaxınlaşdıqca aşağı düşür  (${far.end && far.end.dist} → ${near.end && near.end.dist})`);
}

console.log('\nQovşağı görür — A1, A2, A3 yalnız bununla seçilir');
{
  // A plain line is not a junction, whatever else is true of it. This is the
  // assertion that matters most: a false junction is a miscount, and a
  // miscount sends the rover to the wrong station with nothing to notice it.
  for (const [name, scene] of [
    ['düz xətt',        LINE()],
    ['sürüşmüş',        LINE({ shift: 0.5 })],
    ['tünd döşəmədə',   LINE({ floor: '#3a3a3a' })],
    ['QR-ın üstündə',   LINE({ qr: 0.8 })],
    ['xətt bitir',      LINE({ upTo: 0.72 })],
  ]) {
    const r = await run(scene, [], 'line');
    ok(!r.junction, `${name.padEnd(16)} → qovşaq yoxdur`);
  }

  // …and the branch itself, on each side.
  for (const [side, want] of [['left', 'left'], ['right', 'right'], ['both', 'both']]) {
    const r = await run(BRANCH({ side, at: 0.72 }), [], 'line');
    ok(r.junction && r.junction.side === want,
       `${side.padEnd(5)} qol → ${r.junction ? r.junction.side : 'yoxdur'}`);
  }

  // A branch is wider than the line it leaves — that IS the measurement, so
  // it is worth asserting rather than assuming.
  const one = await run(BRANCH({ side: 'left', at: 0.72 }), [], 'line');
  ok(one.junction && one.junction.span > 100,
     `qol xəttdən enlidir  (${one.junction && one.junction.span} piksel)`);

  // Driving up to it, the junction has to come DOWN the picture — that is what
  // lets a run commit to the turn at the right moment instead of two metres
  // early.
  const far  = await run(BRANCH({ at: 0.58 }), [], 'line');
  const near = await run(BRANCH({ at: 0.86 }), [], 'line');
  ok(far.junction && near.junction && near.junction.dist > far.junction.dist,
     `yaxınlaşdıqca aşağı düşür  (${far.junction && far.junction.dist} → `
   + `${near.junction && near.junction.dist})`);

  // A junction must not cost the steering. The rover has to drive THROUGH the
  // ones it is not turning at, and it steers by the line the whole way.
  const straight = await run(BRANCH({ side: 'left', at: 0.72 }), [], 'line');
  ok(straight.bands >= 2 && Math.abs(straight.err) < 0.12,
     `qovşaqda da xətti saxlayır  (sapma ${straight.err}, ${straight.bands} zolaq)`);

  // The station's yellow box tape runs across the line beside the zone, and it
  // is not a branch. Hue tells them apart; nothing else would.
  const tape = await run(LINE(), [`
    ctx.fillStyle = '#ffe000'; ctx.fillRect(0, H*0.68, W, H*0.05);`], 'line');
  ok(!tape.junction, 'sarı lent qovşaq deyil');

  // /vision has to SHOW it, not just compute it. The page is where a person
  // decides whether the detector is right about a branch, and a claim about
  // which side one leaves on cannot be checked from a number — it has to be
  // drawn over the paint it was measured from.
  const shows = (scene) => page.evaluate((sc) => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    new Function('ctx', 'W', 'H', sc)(ctx, c.width, c.height);
    setMode('line');
    let res = null;
    for (let i = 0; i < 4; i++) res = detect(ctx.getImageData(0, 0, c.width, c.height).data);
    drawOverlay(res);
    paintReadout(res);
    return { read: document.getElementById('rJunc').textContent,
             hint: document.getElementById('hint').textContent };
  }, scene);

  const plain = await shows(LINE());
  ok(plain.read === 'yok', `düz xəttdə oxunuş «${plain.read}»`);
  const onBranch = await shows(BRANCH({ side: 'left', at: 0.72 }));
  ok(/SOL/.test(onBranch.read), `qolun üstündə oxunuş «${onBranch.read}»`);
  ok(/[Kk]avşak/.test(onBranch.hint), `və izah edilir: ${onBranch.hint}`);
}

console.log('\nOtaqdakı mavi və narıncı əşyalar xətt sayılmır');
for (const [name, clutter] of Object.entries(COLOUR_CLUTTER)) {
  // Each of these has one half of the signature and not the other. The line is
  // orange between two blue stripes of matching width — the whole thing, or
  // nothing.
  const r = await run(LINE(), [clutter], 'line');
  ok(r.bands >= 3 && Math.abs(r.err) < 0.12,
     `${name.padEnd(6)} yanında → xətti saxlayır  (sapma ${r.err}, ${r.bands} zolaq)`);
}
{
  // …and with no line in the frame at all, the clutter must not become one.
  for (const [name, clutter] of Object.entries(COLOUR_CLUTTER)) {
    const r = await run(`ctx.fillStyle='#8f8f8f';ctx.fillRect(0,0,W,H);`, [clutter], 'line');
    ok(r.bands < 2, `xəttsiz kadrda tək ${name} → ${r.bands} zolaq (yol yoxdur)`);
  }
}

console.log('\nİşıq dəyişəndə də tapır — rəng tonu qalır');
{
  // Hue is the part of a colour that survives a room. These are the same line
  // under a warm bulb, in shade, and through a camera that has washed the
  // saturation out — brightness and saturation move a long way, hue barely.
  // The last one is the honest limit: strip the colour out far enough and
  // there is nothing left to detect, which is what `chroma` is there to say.
  const LIGHTS = {
    'isti işıq':   { blue: '#3f6ea8', orange: '#ff6a00' },   // warm, hue pulled red
    'soyuq işıq':  { blue: '#2a63b4', orange: '#ff9a1e' },   // cool, hue pulled yellow
    'kölgədə':     { blue: '#22406a', orange: '#a85400' },   // half the brightness
    'solğun':      { blue: '#5b7ba6', orange: '#e09a4e' },   // washed-out camera
  };
  for (const [name, c] of Object.entries(LIGHTS)) {
    const scene = `
      ctx.fillStyle = '#8f8f8f'; ctx.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y++) {
        const k = y / H, w = W * (0.10 + 0.16 * k), s = w / 3, cx = W / 2;
        ctx.fillStyle = '${c.blue}';   ctx.fillRect(cx - w/2, y, s, 1);
        ctx.fillStyle = '${c.orange}'; ctx.fillRect(cx - s/2, y, s, 1);
        ctx.fillStyle = '${c.blue}';   ctx.fillRect(cx + s/2, y, s, 1);
      }`;
    const r = await run(scene, [], 'line');
    ok(r.bands >= 3 && Math.abs(r.err) < 0.10,
       `${name.padEnd(11)} → ${r.bands} zolaq, sapma ${r.err}, renkli ${r.contrast} %`);
  }
}

console.log('\nXətt yoxdursa uydurmur');
for (const [name, scene] of [['qaranlıq otaq', NOLINE.dim],
                             ['yumşaq işıq keçidi', NOLINE.gradient],
                             ['qara bant treki', SCENES.darkTrack(0)],
                             ['ağ bant treki', SCENES.whiteTrack(0)]]) {
  // The monochrome tracks matter here: they are a real line, and 'line' mode
  // must still say no. Grey tape is not the competition line.
  const r = await run(scene, [], 'line');
  ok(r.bands < 2, `${name.padEnd(20)} → ${r.bands} zolaq, renkli ${r.contrast} %`);
}

console.log('\nAvto rejim yarış xəttini dərhal seçir');
{
  const r = await run(LINE(), [], 'auto', 'dark');
  ok(r.mode === 'line', `qara rejimdən başlasa da → ${r.mode}`);
  ok(r.bands >= 3 && Math.abs(r.err) < 0.10, `və xətti izləyir  (${r.bands} zolaq)`);

  // The gaps between stations have no line at all. A mode locked onto 'line'
  // must not answer 'line' for ever once the paint has run out.
  const back = await page.evaluate((scenes) => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const px = s => new Function('ctx', 'W', 'H', s)(ctx, c.width, c.height);
    const step = n => { let d; for (let i = 0; i < n; i++)
      d = detect(ctx.getImageData(0, 0, c.width, c.height).data); return d; };
    setMode('auto');
    px(scenes[0]); const on = step(4).mode;
    px(scenes[1]); const off = step(6).mode;
    return { on, off };
  }, [LINE(), SCENES.darkTrack(0)]);
  ok(back.on === 'line', `xətt üstündə → ${back.on}`);
  ok(back.off !== 'line', `xətt bitəndən sonra «line»-da ilişmir → ${back.off}`);
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

console.log('\n90° döngəni tapır və hansı tərəfə olduğunu deyir');
for (const [name, dir, scene, mode] of [
  ['qara yol, sağa dönür', 1, CORNER(1), 'dark'],
  ['qara yol, sola dönür', -1, CORNER(-1), 'dark'],
  ['ağ yol, sağa dönür',   1, CORNER(1, 0.72, false), 'white'],
  ['ağ yol, sola dönür',  -1, CORNER(-1, 0.72, false), 'white'],
]) {
  const r = await run(scene, [], mode);
  ok(r.corner && r.corner.dir === dir,
     `${name.padEnd(24)} → ${r.corner ? (r.corner.dir > 0 ? 'SAĞA' : 'SOLA') : 'köşe yox'}`
   + `  (kadrın ${r.corner ? Math.round(r.corner.dist * 100) : '–'} % aşağısında,`
   + ` çıxıntı ${r.corner ? r.corner.over : '–'})`);
  // The road INTO the corner is still there and still followable: the corner
  // is a warning about what happens next, not a loss of the road now.
  ok(r.bands >= 2 && Math.abs(r.err) < 0.12,
     `  …və köşəyə qədər olan yol hələ izlənir  (${r.bands} zolaq, sapma ${r.err})`);
}
{
  // Auto mode, the way a run actually reaches a corner: it decides the track
  // type on the straight, ARM locks that in, and only then does the corner
  // arrive. Deciding the type FROM a corner frame is a different question —
  // half that picture is road — and is exactly what the lock exists to avoid.
  const r = await page.evaluate((scene) => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const px = s => new Function('ctx', 'W', 'H', s)(ctx, c.width, c.height);
    const step = n => { let d; for (let i = 0; i < n; i++)
      d = detect(ctx.getImageData(0, 0, c.width, c.height).data); return d; };
    setMode('auto');
    px(`ctx.fillStyle='#8a8a8a';ctx.fillRect(0,0,W,H);
        ctx.fillStyle='#111';ctx.fillRect(W*0.42,0,W*0.16,H);`);
    const mode = step(4).mode;         // the straight, before ARM
    roadLockAuto(true);
    px(scene);
    const d = step(4);
    roadLockAuto(false);
    return { mode, corner: d.corner && d.corner.dir, bands: d.pts.length };
  }, CORNER(1));
  ok(r.mode === 'dark', `düz yolda qara trekə qərar verir → ${r.mode}`);
  ok(r.corner === 1, `sonra gələn köşəni avto rejimdə də tapır → ${r.corner}`);
}
{
  // Driving up to it. The corner has to come DOWN the picture as the robot
  // approaches — "close enough to turn now" means nothing otherwise — and it
  // has to still be there in the last frames, when the arm is under the wheels
  // and fills the bottom of the picture. That last part is where the report
  // used to vanish at exactly the wrong moment: the chain locks on to the arm,
  // and an arm measured from its own middle is not lopsided about anything.
  const r = await page.evaluate((scenes) => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    setMode('dark');
    const seen = [];
    for (const scene of scenes) {
      new Function('ctx', 'W', 'H', scene)(ctx, c.width, c.height);
      let d = null;
      for (let i = 0; i < 3; i++) d = detect(ctx.getImageData(0, 0, c.width, c.height).data);
      seen.push(d.corner && { dir: d.corner.dir, dist: +d.corner.dist.toFixed(2) });
    }
    return seen;
  }, [CORNER(1, 0.55), CORNER(1, 0.65), CORNER(1, 0.75), CORNER(1, 0.86)]);
  ok(r.every(c => c && c.dir === 1),
     `yaxınlaşma boyu hər kadrda görünür  (${r.map(c => c ? c.dist : 'yox').join(' → ')})`);
  ok(r.every((c, i) => !i || c.dist >= r[i - 1].dist),
     'və hər addımda kadrın daha aşağısına düşür');
  ok(r[r.length - 1].dist > 0.85,
     `sonunda təkərlərin altındadır  (${r[r.length - 1].dist})`);
}

console.log('\nDüz yolda köşe uydurmur');
for (const [name, scene, clutter, mode] of [
  ['qara yol düz',            SCENES.darkTrack(0),    [], 'dark'],
  ['qara yol sağa sürüşmüş',  SCENES.darkTrack(0.5),  [], 'dark'],
  ['ağ yol düz',              SCENES.whiteTrack(0),   [], 'white'],
  ['qara yol + mebel + işıq', SCENES.darkTrack(0),    [CLUTTER.sofa, CLUTTER.light], 'dark'],
  ['sönük işıqda sönük xətt', DIM_LINE,               [], 'dark'],
]) {
  // Perspective widens the road toward the bottom of the frame on both sides
  // at once. The corner test asks for the opposite — growth on ONE side — so
  // a straight road, however much it widens, is never an L.
  const r = await run(scene, clutter, mode);
  ok(!r.corner, `${name.padEnd(26)} → köşe yoxdur`
   + (r.corner ? `  (səhvən ${r.corner.dir > 0 ? 'SAĞA' : 'SOLA'}, çıxıntı ${r.corner.over})` : ''));
}

console.log('\nXətt olmayan yerdə xətt uydurmur');
{
  // The bug this is here for: in a dark room the whole frame came back as one
  // enormous "corridor" and the robot followed it. A dark region has no edge;
  // only a dark line does.
  for (const [name, scene] of [['qaranlıq otaq', NOLINE.dim],
                               ['yumşaq işıq keçidi', NOLINE.gradient]]) {
    for (const mode of ['dark', 'white', 'auto']) {
      const r = await run(scene, [], mode);
      ok(r.bands < 2,
         `${(name + ' · ' + mode).padEnd(30)} → ${r.bands} zolaq (yol yoxdur), `
       + `ölçülən kənar fərqi ${r.contrast}`);
    }
  }
}
{
  // …and the bar is a knob, not a wall: turn it off and the same frame goes
  // back to being read by brightness alone. That is what the slider does.
  const r = await page.evaluate((scene) => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    new Function('ctx', 'W', 'H', scene)(ctx, c.width, c.height);
    setMode('dark');
    const was = cfg.edge;
    cfg.edge = 40;
    let strict = 0;
    for (let i = 0; i < 4; i++)
      strict = detect(ctx.getImageData(0, 0, c.width, c.height).data).pts.length;
    cfg.edge = was;
    return strict;
  }, DIM_LINE);
  ok(r < 2, `kənar çubuğu 40-a qaldırılsa sönük xətt də rədd olunur → ${r} zolaq`);
}

console.log('\nZəif işıqda və kölgədə xətti tapır');
{
  // No white edge lines, nothing in the frame brighter than #3a3a3a: the old
  // reading ("find the white edges, the road is the gap") has nothing to hold
  // on to here. The edge step does.
  const r = await run(DIM_LINE, [], 'dark');
  ok(r.bands >= 3 && Math.abs(r.err) < 0.08,
     `sönük döşəmədə sönük xətt → ${r.bands} zolaq, sapma ${r.err}, `
   + `kənar fərqi ${r.contrast}`);
}
{
  // A shadow across the far half of the track. One threshold for the whole
  // frame cannot be right for both halves at once; a per-band one only has to
  // be right for its own band.
  const shade = SCENES.darkTrack(0)
    + `ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, W, H * 0.55);`;
  const r = await run(shade, [], 'dark');
  ok(r.bands >= 5 && Math.abs(r.err) < 0.08,
     `uzaq yarısı kölgədə olan trek → ${r.bands} zolaq, sapma ${r.err}`);
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
