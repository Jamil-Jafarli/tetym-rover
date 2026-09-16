/**
 * qrwarp.js — reading a QR code the camera sees at a slant.
 *
 * No camera and no printed code: the test draws its own. A tiny QR encoder
 * (version 1, level L, mask 0 — enough for "ALIM2") makes the code, and the
 * slant is made with the same K·R·K⁻¹ the reader undoes, so the scene is "a
 * flat code on the floor, seen by a camera leaning forward". What is asserted
 * is the one thing the module is for: jsQR cannot read that picture as it is,
 * and can once it has been straightened.
 *
 *   node test/test_qrwarp.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  homography, applyH, inv3, mul3, tiltH, readWarped, warpGray, fitWarp, saveGray,
  locateQr, lookQr, LOCATE_DEFAULTS, loadGray,
} from '../qrwarp.js';
import { QrReader, QrLooker } from '../qr.js';

const require = createRequire(import.meta.url);
const jsQR = require('jsqr');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };

// ── a QR encoder, version 1-L, byte mode, mask 0 ─────────────────────
function qrMatrix(text) {
  const N = 21, data = [...Buffer.from(text, 'latin1')];
  if (data.length > 17) throw new Error('v1-L holds 17 bytes');
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(data.length, 8); data.forEach((b) => put(b, 8));
  put(0, Math.min(4, 152 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; cw.length < 19; p ^= 1) cw.push(p ? 0x11 : 0xec);
  // Reed–Solomon, 7 check bytes, GF(256) over 0x11d
  const exp = new Array(512), log = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const gm = (a, b) => (a && b ? exp[log[a] + log[b]] : 0);
  let gen = [1];
  for (let i = 0; i < 7; i++) {
    const g = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => { g[j] ^= c; g[j + 1] ^= gm(c, exp[i]); });
    gen = g;
  }
  const rem = new Array(7).fill(0);
  for (const b of cw) {
    const f = b ^ rem.shift(); rem.push(0);
    for (let j = 0; j < 7; j++) rem[j] ^= gm(gen[j + 1], f);
  }
  const all = [...cw, ...rem];

  const M = Array.from({ length: N }, () => new Array(N).fill(0));
  const fn = Array.from({ length: N }, () => new Array(N).fill(false));
  const set = (x, y, v) => { M[y][x] = v ? 1 : 0; fn[y][x] = true; };
  for (const [cx, cy] of [[3, 3], [N - 4, 3], [3, N - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  for (let i = 8; i < N - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // format: level L (01), mask 0 → BCH, xor 0x5412
  let r = 1 << 3;
  let fb = r; for (let i = 0; i < 10; i++) fb = (fb << 1) ^ ((fb >>> 9) * 0x537);
  const fmt = ((r << 10) | fb) ^ 0x5412;
  const bit = (i) => ((fmt >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(N - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, N - 15 + i, bit(i));
  set(8, N - 8, true);
  let k = 0;
  for (let right = N - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < N; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? N - 1 - v : v;
        if (fn[y][x]) continue;
        const b = k < all.length * 8 ? (all[k >>> 3] >>> (7 - (k & 7))) & 1 : 0;
        k++;
        M[y][x] = b ^ ((x + y) % 2 === 0 ? 1 : 0);
      }
    }
  }
  return M;
}

/**
 * A camera picture of a flat code on the floor.
 *
 * The code is drawn in the "looking straight down" view, as a square of
 * `side` px centred where the camera pixel (px, py) lands; the camera picture
 * is that view taken back through tiltH⁻¹, 3x3 supersampled so the edges blur
 * the way a lens blurs them. Dim, like the field: paper 170, ink 45, floor 80.
 */
function scene(M, { w = 640, h = 480, tilt = 50, hfov = 70, px = 290, py = 330, side = 40 } = {}) {
  const T = tiltH(w, h, { tilt, hfov });
  const [ox, oy] = applyH(T, px, py);
  const n = M.length, q = 4, cell = side / n;
  const x0 = ox - side / 2, y0 = oy - side / 2;
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const p = applyH(T, x + (sx + 0.5) / 3, y + (sy + 0.5) / 3);
          let v = 80;
          if (p) {
            const u = Math.floor((p[0] - x0) / cell), t = Math.floor((p[1] - y0) / cell);
            if (u >= -q && t >= -q && u < n + q && t < n + q) {
              v = u >= 0 && t >= 0 && u < n && t < n && M[t][u] ? 45 : 170;
            }
          }
          acc += v;
        }
      }
      img[y * w + x] = acc / 9;
    }
  }
  const Ti = inv3(T);
  const corners = [[x0, y0], [x0 + side, y0], [x0 + side, y0 + side], [x0, y0 + side]]
    .map(([a, b]) => applyH(Ti, a, b));
  return { img, w, h, corners };
}

const rgba = (g) => {
  const o = new Uint8ClampedArray(g.length * 4);
  for (let i = 0; i < g.length; i++) { o[4 * i] = o[4 * i + 1] = o[4 * i + 2] = g[i]; o[4 * i + 3] = 255; }
  return o;
};

console.log('\nThe homography maths');
{
  const src = [[10, 20], [200, 30], [190, 180], [15, 170]];
  const dst = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const H = homography(src, dst);
  const err = Math.max(...src.map((p, i) => {
    const q = applyH(H, ...p);
    return Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]);
  }));
  ok(err < 1e-6, `four points land on the four asked for (err ${err.toExponential(1)})`);
  const R = mul3(H, inv3(H));
  ok(R.every((v, i) => Math.abs(v - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) < 1e-9), 'H · H⁻¹ is the identity');
  ok(homography([[0, 0], [1, 1], [2, 2], [3, 3]], dst) === null, 'four points on a line: null, not NaN');

  const T = tiltH(640, 480, { tilt: 30 });
  const c = applyH(T, 320, 240 + 240 * 0.3);
  ok(c[1] < 240 + 240 * 0.3, 'tilting the camera down moves a low point up the picture');
  ok(Math.abs(applyH(T, 320, 400)[0] - 320) < 1e-9, 'and keeps the centre column where it is');
  // hfov 70 → the frame's top edge is 27.7° above its axis; 80° more puts it
  // behind the virtual camera.
  const fit = fitWarp(tiltH(640, 480, { tilt: 80 }), [0, 0, 640, 480], 800);
  ok(fit === null, 'a warp that puts the top of the frame past the horizon is refused');

  const g = new Uint8Array(4 * 4).map((_, i) => i * 10);
  const same = warpGray(g, 4, 4, [1, 0, 0, 0, 1, 0, 0, 0, 1], 4, 4, 0);
  ok(same[5] === g[5] && same[10] === g[10], 'warping through the identity changes nothing inside');
}

console.log('\nThe test\'s own QR encoder (so the rest means something)');
const M = qrMatrix('ALIM2');
{
  const s = 8, q = 4, n = M.length, W = (n + 2 * q) * s;
  const g = new Uint8Array(W * W).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!M[y][x]) continue;
    for (let dy = 0; dy < s; dy++) g.fill(0, ((y + q) * s + dy) * W + (x + q) * s, ((y + q) * s + dy) * W + (x + q + 1) * s);
  }
  const r = jsQR(rgba(g), W, W);
  ok(r && r.data === 'ALIM2', `a flat, big code reads as ALIM2 (${r && r.data})`);
}

console.log('\nA code on the floor, seen at a slant');
{
  // 50° further down than the camera looks, a code ~91x72 px in shot: plenty
  // of pixels across, rows squashed and the far edge narrower. In a sweep of
  // tilt 40–65° and 42–133 px, jsQR alone read none of them and a tilt warp
  // read 15 of 16; a code much smaller than this (46x32 at 60°) is where even
  // the warps start to miss, which is resolution, not geometry.
  const sc = scene(M, { tilt: 50, side: 100, py: 360 });
  const plain = jsQR(rgba(sc.img), sc.w, sc.h, { inversionAttempts: 'dontInvert' });
  const box = sc.corners.map((p) => p.map(Math.round).join(',')).join(' ');
  ok(!plain, `jsQR alone does not read it (code at ${box})`);

  const xs = sc.corners.map((p) => p[0]), ys = sc.corners.map((p) => p[1]);
  const roi = [Math.min(...xs) - 25, Math.min(...ys) - 25,
    Math.max(...xs) - Math.min(...xs) + 50, Math.max(...ys) - Math.min(...ys) + 50].map(Math.round);
  const res = readWarped(sc.img, sc.w, sc.h, { roi, all: true, tilts: [30, 45, 60] });
  const reads = res.tried.filter((t) => t.ok).map((t) => t.name);
  ok(res.text === 'ALIM2', `straightened, it reads as ALIM2 (${reads.join(', ') || 'heç biri'})`);
  ok(!res.tried.find((t) => t.name === 'düz').ok, 'the plain crop, even magnified, is still not enough');
  ok(res.tried.some((t) => t.ok && t.name.startsWith('əy')), 'a tilt warp is among the ones that read');
  if (res.corners) {
    // jsQR's corners are the code's outer corners; the scene knows the truth.
    // jsQR places them to about a module, so one module (at the code's widest)
    // is the tolerance; a corner still in warped-view pixels would be off by
    // tens.
    const mod = (Math.max(...xs) - Math.min(...xs)) / M.length;
    const err = Math.max(...res.corners.map((p, i) => Math.hypot(p[0] - sc.corners[i][0], p[1] - sc.corners[i][1])));
    ok(err < mod, `corners come back in frame pixels, within ${err.toFixed(1)} px of the truth (a module is ${mod.toFixed(1)})`);
  } else ok(false, 'corners come back in frame pixels');

  const one = readWarped(sc.img, sc.w, sc.h, { roi, tilts: [30, 45, 60] });
  ok(one.tried.length < res.tried.length && one.tried.at(-1).ok,
     `without --all it stops at the first read (${one.tried.length} of ${res.tried.length} tried)`);

  const byHand = readWarped(sc.img, sc.w, sc.h, {
    corners: sc.corners, cornersOnly: true, tilts: [], stretches: [], all: true,
  });
  ok(byHand.tried.find((t) => t.name === 'künclər')?.ok,
     'four corners given by hand pull it square and it reads');

  // Nothing there: nothing read, no throw, every warp reported.
  const empty = readWarped(new Uint8Array(640 * 480).fill(80), 640, 480, {});
  ok(empty.text === null && empty.tried.length > 3, `an empty floor reads nothing (${empty.tried.length} warps tried)`);

  console.log('\nFinding it in a 1920x1080 frame first (what the server does)');
  {
    // The field's geometry: 1080p, camera leaning ~45°, the code ~65 px wide
    // in the lower middle. jsQR on the whole frame does not read it; the
    // reader locates the patch, cuts it tight, magnifies and straightens it.
    const big = scene(M, { w: 1920, h: 1080, tilt: 45, hfov: 70, px: 850, py: 668, side: 70 });
    // (This clean synthetic code is read by jsQR even on the whole frame; the
    // real one below is not. What is tested here is the locate-and-read path.)
    const bx = big.corners.map((p) => p[0]), by = big.corners.map((p) => p[1]);
    const truth = [Math.min(...bx), Math.min(...by), Math.max(...bx), Math.max(...by)];

    const t0 = Date.now();
    const cands = locateQr(big.img, big.w, big.h);
    const ms = Date.now() - t0;
    const c = cands[0];
    const overlap = c && c.x < truth[2] && c.x + c.w > truth[0] && c.y < truth[3] && c.y + c.h > truth[1];
    ok(overlap, `the locator's best patch is on the code (${c && [c.x, c.y, c.w, c.h].join(',')}, score ${c && c.v}, ${ms} ms)`);
    ok(c && c.v >= LOCATE_DEFAULTS.minScore, `and scores above the threshold (${c && c.v} ≥ ${LOCATE_DEFAULTS.minScore})`);

    const r = lookQr(big.img, big.w, big.h);
    ok(r.text === 'ALIM2', `one look reads it (${r.text}, ${r.warp}, ${r.tries} patch tried)`);
    const err = r.corners
      ? Math.max(...r.corners.map((p, i) => Math.hypot(p[0] - big.corners[i][0], p[1] - big.corners[i][1]))) : Infinity;
    ok(err < 70 / 21 * 1.5, `its corners are in frame pixels (${err.toFixed(1)} px off)`);

    const floor = new Uint8Array(1920 * 1080);
    for (let i = 0; i < floor.length; i++) floor[i] = 80 + ((i * 2654435761) >>> 28);   // grain, no code
    const none = lookQr(floor, 1920, 1080);
    ok(none.text === null && none.tries === 0, 'bare floor: nothing located above the threshold, no decode spent');
    const forced = lookQr(floor, 1920, 1080, { force: true });
    ok(forced.text === null && forced.tries <= 1, 'force tries the best patch anyway, and still reads nothing');

    console.log('\nThe real field frame (2026-09-15, 1920x1080, fixtures/qr_field_1080.jpg)');
    {
      // The frame that started this: ALIM1 on the orange stripe, camera
      // leaning forward, dim room, the code ~63x48 px. jsQR on the whole
      // frame spends a second and reads nothing; one look reads it.
      const f = loadGray(new URL('./fixtures/qr_field_1080.jpg', import.meta.url).pathname);
      const whole = jsQR(rgba(f.gray), f.w, f.h, { inversionAttempts: 'dontInvert' });
      ok(!whole, 'jsQR on the whole frame: nothing');
      const t1 = Date.now();
      const look = lookQr(f.gray, f.w, f.h);
      ok(look.text === 'ALIM1', `one look: ${look.text} (${look.warp}, ${Date.now() - t1} ms)`);
      ok(look.box && look.box.x > 780 && look.box.x < 880 && look.box.y > 600 && look.box.y < 700,
         `found where the code is (${look.box && [look.box.x, look.box.y].join(',')})`);
    }

    console.log('\nThe reader, fed through the worker thread');
    const reader = new QrReader();
    const looker = new QrLooker(reader);
    try {
      looker.offer(Buffer.from(big.img), big.w, big.h);
      ok(looker.offer(Buffer.from(big.img), big.w, big.h) === false, 'a frame offered while a look is running is dropped');
      const until = Date.now() + 20000;
      while (reader.frames < 1 && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
      const s = reader.status();
      ok(s.text === 'ALIM2' && s.count === 1, `the worker's look is counted as a reading (${s.text}, ${s.ms} ms)`);
      ok(s.loc && s.loc.every(([x, y]) => x > 0.4 && x < 0.5 && y > 0.55 && y < 0.7),
         `loc is fractions of the whole frame (${s.loc && s.loc.map((p) => p.join(',')).join(' ')})`);
      ok(s.cand && s.cand.v >= LOCATE_DEFAULTS.minScore && s.warp, `status carries the patch and the warp (${s.warp})`);
      ok(!looker.busy, 'and the looker is free for the next frame');
    } finally {
      await looker.close();
    }
  }

  console.log('\nThe script, on a file');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrwarp-test-'));
  try {
    const f = path.join(dir, 'slant.png');
    saveGray(f, sc.img, sc.w, sc.h);
    const run = (...a) => spawnSync(process.execPath, [new URL('../qrwarp.js', import.meta.url).pathname, ...a],
      { encoding: 'utf8', timeout: 60000 });
    const p = run(f, '--roi', roi.join(','), '--out', dir);
    ok(p.status === 0 && /oxundu: "ALIM2"/.test(p.stdout), `node qrwarp.js reads it, exit 0 (${p.status})`);
    ok(fs.existsSync(path.join(dir, 'qrwarp-plain.png')) && fs.existsSync(path.join(dir, 'qrwarp-tilt30.png')),
       '--out writes the warped views, under ASCII names');
    const j = JSON.parse(run(f, '--roi', roi.join(','), '--json').stdout);
    ok(j.w === 640 && Array.isArray(j.tried), '--json is JSON');
    const nothing = run(f, '--roi', '0,0,100,100');
    ok(nothing.status === 1 && /oxunmadı/.test(nothing.stdout), 'nothing in the ROI: exit 1 and says so');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
