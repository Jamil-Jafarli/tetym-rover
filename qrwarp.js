/**
 * Straightening a QR code the camera sees at a slant.
 *
 * The camera is mounted leaning forward, looking down the line at an angle,
 * not straight down on it. A 50 mm code on the floor therefore does not reach
 * the picture as a square: it is squashed top-to-bottom (foreshortening) and
 * its far edge is narrower than its near edge (keystone). On the field at
 * 640x480 it came out as ~30x22 px — the rows of modules are packed tighter
 * than the columns, and jsQR gave up on every frame (0 of 1571 on 2026-09-15).
 *
 * jsQR does handle *some* perspective: once it has found the three finder
 * patterns it samples the grid through a homography of its own. What it cannot
 * do is find those finder patterns when the vertical module pitch has dropped
 * below a couple of pixels, because its binariser works in 8x8 blocks and a
 * 1:1:3:1:1 run squashed into 5 px is not a finder pattern to anyone. So the
 * fix is to undo the camera's slant *before* jsQR looks: resample the part of
 * the picture where the code sits into a view from directly above, magnified,
 * and hand that to the decoder.
 *
 * Everything here is a 3x3 homography, because any "view the same flat floor
 * from somewhere else" warp is one. Three kinds are built:
 *
 *   tilt     the physically right one: the picture a camera would take if it
 *            were rotated `tilt` degrees further down, K·R·K⁻¹. Needs the lens's
 *            horizontal field of view (a guess, 70° by default, for a 1080p
 *            webcam); an angle sweep covers not knowing the mount angle.
 *   stretch  cheaper approximation: just pull the rows apart (×sy). Undoes the
 *            squash, not the keystone. In the test's scene sweep (tilt 40–65°,
 *            code 42–133 px) it never read once where a tilt did, so it is off
 *            unless asked for (--stretch 1.5,2,3).
 *   corners  any shape at all: four points in the picture (the code's corners,
 *            clockwise from top-left) are pulled onto a square. This is what
 *            to use when you can see where the code is but nothing decodes it.
 *
 * Every warp is fitted to the region of interest (ROI) and scaled so its long
 * side is `scale` × the ROI's, so a small code is also *magnified* — resolution
 * was half the problem. The corners jsQR reports in the warped view are mapped
 * back to the original frame, so what comes out is still "where in the picture
 * the code is".
 *
 * As a script, on a still (a file, the server's current frame, or the webcam
 * at 1080p when the server is not holding it):
 *
 *   node qrwarp.js frame.jpg
 *   node qrwarp.js --grab                          the server's /camera/frame.jpg
 *   node qrwarp.js --device /dev/video0 --size 1920x1080
 *   node qrwarp.js frame.jpg --roi 0.3,0.5,0.4,0.35 --tilt 20,35,50,65 --all
 *   node qrwarp.js frame.jpg --corners 265,283,297,283,298,305,266,305
 *
 * It prints every warp it tried, whether it read, and how long it took, and
 * with --out writes each warped view as a PNG so you can see what the decoder
 * was given. Nothing here is wired into qr.js yet: this is for finding out on
 * real frames *which* warp reads, before the robot pays for it at 5 fps.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let jsQR = null;
try { const m = require('jsqr'); jsQR = m && (m.default || m); } catch { /* reported by the CLI */ }

export const WARP_DEFAULTS = {
  hfov: 70,                    // lens horizontal field of view, degrees (guess)
  // Extra downward rotation to try, degrees. On the 2026-09-15 field frame 45°
  // (with hfov 70) is the one that made the code come out square.
  tilts: [30, 45, 60],
  stretches: [],               // row pull-apart factors to try (see above)
  scale: 2,                    // output long side = scale × ROI long side...
  maxSide: 1400,               // ...but never more than this (jsQR is O(pixels))
  // Lower-middle of the frame: where the code is when the rover has driven up
  // to it (0.44, 0.61 of the frame in the 2026-09-15 field picture). Fractions
  // of the frame: x, y, w, h.
  roi: [0.25, 0.4, 0.5, 0.6],
  normalize: true,             // stretch ROI contrast 1st..99th percentile
  invert: false,               // also try light-on-dark (printed codes are not)
};

// ── 3x3 matrices, row-major arrays of 9 ────────────────────────────────

export const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}

export function inv3(M) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

/** H·(x, y, 1), divided out. null for a point behind the virtual camera. */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  if (!(w > 1e-9)) return null;
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/**
 * The homography taking four points onto four others (dst ≈ H·src).
 * Plain 8x8 elimination with partial pivoting; null if the points are
 * degenerate (three on a line).
 */
export function homography(src, dst) {
  const A = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = src[k], [u, v] = dst[k];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let p = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[p][col])) p = r;
    if (Math.abs(A[p][col]) < 1e-12) return null;
    [A[col], A[p]] = [A[p], A[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
    }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1];
}

/**
 * The picture the same camera would take rotated `tilt` degrees further down
 * (and `roll` degrees about its axis), as a homography on frame pixels.
 *
 * Pure rotation about the lens centre, so it is exact for anything — no
 * assumption about the floor, the height or the distance. The only unknown is
 * the focal length, which comes from the horizontal field of view.
 */
export function tiltH(w, h, { tilt = 0, roll = 0, hfov = WARP_DEFAULTS.hfov } = {}) {
  const f = (w / 2) / Math.tan((hfov * Math.PI) / 360);
  const cx = w / 2, cy = h / 2;
  const K = [f, 0, cx, 0, f, cy, 0, 0, 1];
  const Ki = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const t = (tilt * Math.PI) / 180, r = (roll * Math.PI) / 180;
  // y points down the picture, z out of the lens: rotating the camera down by
  // t brings a ray that was at the bottom of the picture back to its middle.
  const Rx = [1, 0, 0, 0, Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t)];
  const Rz = [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0, 0, 0, 1];
  return mul3(K, mul3(mul3(Rz, Rx), Ki));
}

/** Pull rows apart by sy (and columns by sx). */
export const stretchH = (sy, sx = 1) => [sx, 0, 0, 0, sy, 0, 0, 0, 1];

/**
 * The code's four corners (clockwise from top-left, as jsQR reports them)
 * onto a square, with a quiet zone of `margin` × the side around it.
 */
export function cornersH(quad, side = 300, margin = 0.2) {
  const m = side * margin;
  return homography(quad, [[m, m], [m + side, m], [m + side, m + side], [m, m + side]]);
}

/**
 * Fit a warp to a rectangle: compose H with the scale-and-shift that puts the
 * rectangle's image at the origin with its long side `side` px.
 * Returns {H, w, h}, or null when part of the rectangle lands behind the
 * virtual camera (tilted past the horizon) or blows up.
 */
export function fitWarp(H, rect, side, maxSide = WARP_DEFAULTS.maxSide) {
  const [x, y, w, h] = rect;
  const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => applyH(H, px, py));
  if (pts.some((p) => !p)) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  if (!(bw > 0 && bh > 0) || Math.max(bw, bh) / Math.min(bw, bh) > 20) return null;
  const sc = Math.min(side, maxSide) / Math.max(bw, bh);
  const T = [sc, 0, -Math.min(...xs) * sc, 0, sc, -Math.min(...ys) * sc, 0, 0, 1];
  return { H: mul3(T, H), w: Math.max(1, Math.round(bw * sc)), h: Math.max(1, Math.round(bh * sc)) };
}

/**
 * Resample a grey picture through H (output = H·input), bilinear.
 * Pixels that come from outside the source are `fill`.
 */
export function warpGray(src, sw, sh, H, ow, oh, fill = 128) {
  const Hi = inv3(H);
  const out = new Uint8Array(ow * oh);
  if (!Hi) return out.fill(fill);
  const [a, b, c, d, e, f, g, h, i] = Hi;
  for (let y = 0; y < oh; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < ow; x++) {
      const xc = x + 0.5;
      const w = g * xc + h * yc + i;
      const sx = (a * xc + b * yc + c) / w - 0.5;
      const sy = (d * xc + e * yc + f) / w - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (!(w > 0) || x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
        out[y * ow + x] = fill;
        continue;
      }
      const fx = sx - x0, fy = sy - y0, k = y0 * sw + x0;
      const top = src[k] + (src[k + 1] - src[k]) * fx;
      const bot = src[k + sw] + (src[k + sw + 1] - src[k + sw]) * fx;
      out[y * ow + x] = top + (bot - top) * fy + 0.5;
    }
  }
  return out;
}

/** Cut a rectangle out, optionally stretching its contrast (dim room). */
export function crop(src, sw, [x, y, w, h], normalize = false) {
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) out.set(src.subarray((y + r) * sw + x, (y + r) * sw + x + w), r * w);
  if (!normalize) return out;
  const hist = new Uint32Array(256);
  for (const v of out) hist[v]++;
  const pick = (q) => { let n = 0; for (let v = 0; v < 256; v++) { n += hist[v]; if (n >= q * out.length) return v; } return 255; };
  const lo = pick(0.01), hi = pick(0.99);
  if (hi - lo < 8) return out;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / (hi - lo))));
  for (let k = 0; k < out.length; k++) out[k] = lut[out[k]];
  return out;
}

/** ROI in pixels, from fractions (all ≤ 1) or pixels, clipped to the frame. */
export function roiPx(roi, w, h) {
  let [x, y, rw, rh] = roi;
  if (roi.every((v) => v <= 1)) { x *= w; y *= h; rw *= w; rh *= h; }
  x = Math.max(0, Math.min(w - 2, Math.round(x)));
  y = Math.max(0, Math.min(h - 2, Math.round(y)));
  rw = Math.max(2, Math.min(w - x, Math.round(rw)));
  rh = Math.max(2, Math.min(h - y, Math.round(rh)));
  return [x, y, rw, rh];
}

/**
 * Every warp to try, as homographies on *full-frame* pixels. Order matters
 * when stopping at the first read: plain first (cheapest, and a code seen
 * head-on must not be "found" only through a warp), then the exact tilts,
 * then the stretches, then the user's own corners. `name` is for people,
 * `id` is ASCII, for file names.
 */
export function plan(w, h, o = {}) {
  const cfg = { ...WARP_DEFAULTS, ...o };
  const out = cfg.plain === false ? [] : [{ id: 'plain', name: 'düz', H: I3 }];
  for (const t of cfg.tilts) {
    for (const r of cfg.rolls || [0]) {
      out.push({ id: `tilt${t}${r ? `-roll${r}` : ''}`, name: `əy ${t}°${r ? ` fır ${r}°` : ''}`,
        H: tiltH(w, h, { tilt: t, roll: r, hfov: cfg.hfov }) });
    }
  }
  for (const sy of cfg.stretches) out.push({ id: `stretch${sy}`, name: `uzat×${sy}`, H: stretchH(sy) });
  if (cfg.corners) {
    const H = cornersH(cfg.corners);
    if (H) out.push({ id: 'corners', name: 'künclər', H, fullRoi: true });
  }
  return out;
}

/**
 * Try each warp on one grey frame. Returns
 *   { text, warp, corners (full-frame px, TL TR BR BL), tried: [...] }
 * or { text: null, tried } — `tried` has one row per warp: name, size, ms, ok.
 *
 * `o.all` keeps going after the first read (to see *which* warps read);
 * `o.keep` keeps each warped picture on its row (for --out).
 */
export function readWarped(gray, w, h, o = {}) {
  const cfg = { ...WARP_DEFAULTS, ...o };
  const decode = cfg.decode || jsQR;
  if (!decode) throw new Error('jsqr yüklənmədi (npm install)');

  // With --corners the ROI is the code's own bounding box, padded — the user
  // has said where it is, and a frame-wide ROI would only cost pixels.
  let rect = roiPx(cfg.roi, w, h);
  if (cfg.corners) {
    const xs = cfg.corners.map((p) => p[0]), ys = cfg.corners.map((p) => p[1]);
    const pad = 0.6 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const cr = roiPx([Math.min(...xs) - pad, Math.min(...ys) - pad,
      Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad], w, h);
    if (cfg.cornersOnly) rect = cr;
    else rect.cornersRect = cr;
  }
  const cache = new Map();
  const cut = (r) => {
    const k = r.join(',');
    if (!cache.has(k)) cache.set(k, crop(gray, w, r, cfg.normalize));
    return cache.get(k);
  };

  // `first`: the id of a warp to try before the others — the one that read
  // last time. The code is still at the same slant a fifth of a second
  // later, so on a live camera this is one decode per look instead of two.
  const order = plan(w, h, cfg);
  const fi = cfg.first ? order.findIndex((p) => p.id === cfg.first) : -1;
  if (fi > 0) order.unshift(order.splice(fi, 1)[0]);

  const tried = [];
  let best = null;
  for (const wp of order) {
    const r = wp.fullRoi && rect.cornersRect ? rect.cornersRect : rect;
    const [rx, ry, rw, rh] = r;
    const src = cut(r);
    // Warps are defined on full-frame pixels (the lens centre is the frame's
    // centre); the crop starts at (rx, ry), so shift into frame coords first.
    const Hc = mul3(wp.H, [1, 0, rx, 0, 1, ry, 0, 0, 1]);
    const fit = fitWarp(Hc, [0, 0, rw, rh], cfg.scale * Math.max(rw, rh), cfg.maxSide);
    if (!fit) { tried.push({ id: wp.id, name: wp.name, skipped: 'üfüqdən o yana' }); continue; }
    const t0 = Date.now();
    const img = warpGray(src, rw, rh, fit.H, fit.w, fit.h, 255);
    const rgba = new Uint8ClampedArray(fit.w * fit.h * 4);
    for (let k = 0, j = 0; k < img.length; k++, j += 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = img[k]; rgba[j + 3] = 255;
    }
    let found = null;
    try {
      found = decode(rgba, fit.w, fit.h, { inversionAttempts: cfg.invert ? 'attemptBoth' : 'dontInvert' });
    } catch { found = null; }
    const row = { id: wp.id, name: wp.name, roi: r, w: fit.w, h: fit.h, ms: Date.now() - t0, ok: !!(found && found.data) };
    if (cfg.keep) row.img = img;
    if (row.ok) {
      row.text = String(found.data);
      // Back through the warp, then out of the crop.
      const back = inv3(fit.H);
      const L = found.location;
      row.corners = ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner'].map((k) => {
        const p = applyH(back, L[k].x, L[k].y);
        return p ? [Math.round((p[0] + rx) * 10) / 10, Math.round((p[1] + ry) * 10) / 10] : null;
      });
      if (!best) best = row;
    }
    tried.push(row);
    if (best && !cfg.all) break;
  }
  const roi = [...rect];
  return best
    ? { text: best.text, warp: best.name, warpId: best.id, corners: best.corners, roi, tried }
    : { text: null, roi, tried };
}

// ── finding it first ─────────────────────────────────────────────────

/**
 * Where in the frame a QR code might be — cheaply.
 *
 * jsQR on a whole 1920x1080 frame does not read the 50 mm code (0/10 at ×1 on
 * the 2026-09-15 field frame), and the whole frame magnified ×2 is 8 Mpx per
 * look — seconds on a Pi. The same patch cut tight and magnified ×2 reads
 * 10/10 in ~50 ms. So the frame is first searched for something that looks
 * like a code, and only that patch is warped and decoded.
 *
 * On a 1/4 subsample (1/2 below 1280 px wide), per cell of 4x4 samples: the
 * sum of neighbour differences, counted only where the cell spans real black
 * *and* real white (max − min > 60) — tile seams and chalk marks are edges,
 * but not both. The best window of 2..4 cells is the seed; its box grows over
 * neighbouring cells that score at least a third of the seed's best cell,
 * which is the code's extent whatever its size in shot.
 *
 * Measured on the field frames of 2026-09-15 at 1080p: the code's window
 * scored 812 (camera brightness 1) and 1179 (brightness 128); the best patch
 * of bare floor in the same frames, 388. ~40 ms a frame on the Pi while it
 * was throttled to 600 MHz.
 */
export const LOCATE_DEFAULTS = {
  minScore: 500,    // a window below this is not worth a decode (1080p, step 4)
  max: 2,           // candidates returned, best first
};

export function locateQr(gray, w, h, o = {}) {
  const cfg = { ...LOCATE_DEFAULTS, ...o };
  const step = cfg.step || (w >= 1280 ? 4 : 2), cell = 4;
  const sw = Math.floor(w / step), sh = Math.floor(h / step);
  // Mean of every other pixel in each step×step block: a cheap blur, and the
  // sampling the scores above were measured with.
  const s = new Float32Array(sw * sh), n = (step / 2) * (step / 2);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let a = 0;
      for (let dy = 0; dy < step; dy += 2) {
        const row = (y * step + dy) * w + x * step;
        for (let dx = 0; dx < step; dx += 2) a += gray[row + dx];
      }
      s[y * sw + x] = a / n;
    }
  }
  const cw = Math.floor(sw / cell), ch = Math.floor(sh / cell);
  const score = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let lo = 255, hi = 0, e = 0;
      for (let y = cy * cell; y < cy * cell + cell; y++) {
        for (let x = cx * cell; x < cx * cell + cell; x++) {
          const v = s[y * sw + x];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          if (x + 1 < sw) e += Math.abs(v - s[y * sw + x + 1]);
          if (y + 1 < sh) e += Math.abs(v - s[(y + 1) * sw + x]);
        }
      }
      score[cy * cw + cx] = hi - lo > 60 ? e : 0;
    }
  }
  const W1 = cw + 1;
  const I = new Float64Array(W1 * (ch + 1));
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      I[(y + 1) * W1 + x + 1] = score[y * cw + x] + I[y * W1 + x + 1] + I[(y + 1) * W1 + x] - I[y * W1 + x];
    }
  }
  const used = new Uint8Array(cw * ch);
  const out = [];
  while (out.length < cfg.max) {
    let best = null;
    for (const k of [2, 3, 4]) {
      for (let cy = 0; cy + k <= ch; cy++) {
        for (let cx = 0; cx + k <= cw; cx++) {
          const v = (I[(cy + k) * W1 + cx + k] - I[cy * W1 + cx + k] - I[(cy + k) * W1 + cx] + I[cy * W1 + cx]) / (k * k);
          if (best && v <= best.v) continue;
          let free = true;
          for (let y = cy; y < cy + k && free; y++) for (let x = cx; x < cx + k; x++) if (used[y * cw + x]) { free = false; break; }
          if (free) best = { cx, cy, k, v };
        }
      }
    }
    if (!best || !(best.v > 0)) break;
    let peak = 0;
    const stack = [];
    for (let y = best.cy; y < best.cy + best.k; y++) {
      for (let x = best.cx; x < best.cx + best.k; x++) {
        peak = Math.max(peak, score[y * cw + x]);
        used[y * cw + x] = 1;
        stack.push(x, y);
      }
    }
    const thr = peak / 3;
    let x0 = best.cx, y0 = best.cy, x1 = best.cx + best.k - 1, y1 = best.cy + best.k - 1;
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch || used[ny * cw + nx]) continue;
          if (score[ny * cw + nx] < thr) continue;
          // A code is compact: never grow past half the frame either way.
          if (Math.max(x1, nx) - Math.min(x0, nx) >= cw / 2 || Math.max(y1, ny) - Math.min(y0, ny) >= ch / 2) continue;
          used[ny * cw + nx] = 1;
          x0 = Math.min(x0, nx); x1 = Math.max(x1, nx); y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
          stack.push(nx, ny);
        }
      }
    }
    const px = cell * step;
    out.push({ x: x0 * px, y: y0 * px, w: (x1 - x0 + 1) * px, h: (y1 - y0 + 1) * px, v: Math.round(best.v) });
  }
  return out;
}

export const LOOK_DEFAULTS = {
  // Plain first, then these. On the 1080p field frames: brightness 1 read
  // only through tilt 30° and 60°, brightness 128 through plain and 30°.
  tilts: [30, 60],
  targetPx: 130,    // magnify so the candidate's long side is about this...
  maxScale: 4,      // ...but never more than ×4
  candidates: 2,    // how many located patches to try per look
};

/**
 * One look: locate, then straighten and decode each candidate until one
 * reads. `force` tries the best candidate even below minScore — the reader
 * does that every few looks, so a threshold tuned on two frames can make
 * reading slower but never impossible. `first` (a warp id, e.g. 'tilt30')
 * is tried before the rest — see readWarped().
 *
 * @returns {{text, corners, warp, box, tries}}  — text null when nothing read;
 *          box is the best candidate either way (for "saw something there").
 */
export function lookQr(gray, w, h, o = {}) {
  const cfg = { ...LOCATE_DEFAULTS, ...LOOK_DEFAULTS, ...o };
  const cands = locateQr(gray, w, h, cfg);
  const best = cands[0] || null;
  let tries = 0;
  for (const c of cands.slice(0, cfg.candidates)) {
    if (c.v < cfg.minScore && !(cfg.force && c === best)) continue;
    const pad = 0.5 * Math.max(c.w, c.h) + 8;
    const roi = roiPx([c.x - pad, c.y - pad, c.w + 2 * pad, c.h + 2 * pad], w, h);
    const scale = Math.max(1, Math.min(cfg.maxScale, cfg.targetPx / Math.max(c.w, c.h)));
    tries++;
    const r = readWarped(gray, w, h, {
      roi, scale, tilts: cfg.tilts, stretches: [], hfov: cfg.hfov || WARP_DEFAULTS.hfov,
      decode: cfg.decode, normalize: true, maxSide: cfg.maxSide || WARP_DEFAULTS.maxSide,
      first: cfg.first,
    });
    if (r.text) return { text: r.text, corners: r.corners, warp: r.warp, warpId: r.warpId, box: c, tries };
  }
  return { text: null, corners: null, warp: null, warpId: null, box: best, tries };
}

// ── the script ───────────────────────────────────────────────────────

/** Any picture ffmpeg can read, as grey bytes. */
export function loadGray(file) {
  const p = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  if (p.error) throw new Error(`ffprobe yoxdur (sudo apt install ffmpeg): ${p.error.message}`);
  const [w, h] = String(p.stdout).trim().split(',').map(Number);
  if (!(w > 0 && h > 0)) throw new Error(`şəkil oxunmadı: ${file} ${String(p.stderr).trim()}`);
  const d = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 64 << 20 });
  if (d.status !== 0 || d.stdout.length < w * h) throw new Error(`ffmpeg: ${String(d.stderr).trim()}`);
  return { gray: d.stdout.subarray(0, w * h), w, h };
}

export function saveGray(file, gray, w, h) {
  const p = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray',
    '-s', `${w}x${h}`, '-i', 'pipe:0', file], { input: Buffer.from(gray.buffer, gray.byteOffset, gray.length) });
  if (p.status !== 0) throw new Error(`ffmpeg: ${String(p.stderr).trim()}`);
}

/** One still straight off the webcam — only when nothing else has it open. */
function grabDevice(dev, size, file) {
  // Skip a dozen frames: the first ones after opening are dark while the
  // webcam's auto-exposure catches up, and this room is dim already.
  const p = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'v4l2', '-input_format', 'mjpeg',
    '-video_size', size, '-i', dev, '-vf', 'select=gte(n\\,12)', '-frames:v', '1', file],
  { encoding: 'utf8', timeout: 15000 });
  if (p.status !== 0) {
    const e = String(p.stderr || p.error || '').trim();
    throw new Error(/busy/i.test(e)
      ? `${dev} məşğuldur — server kameranı tutur. Serveri --no-camera ilə başlat, ya da --grab işlət (640x480).`
      : `ffmpeg: ${e}`);
  }
}

const nums = (s) => String(s).split(/[,:x ]+/).filter(Boolean).map(Number);

function usage() {
  return `qrwarp — slant-corrected QR reading on a still

  node qrwarp.js <şəkil.jpg>            a file
  node qrwarp.js --grab [url]           the server's current frame
                                        (default http://localhost:8090/camera/frame.jpg)
  node qrwarp.js --device /dev/video0 [--size 1920x1080]
                                        straight off the webcam (server must not hold it)

  --roi x,y,w,h        where to look; fractions of the frame (≤1) or pixels
                       (default ${WARP_DEFAULTS.roi.join(',')})
  --tilt a,b,...       tilt angles to try, degrees (default ${WARP_DEFAULTS.tilts.join(',')})
  --roll a,b,...       roll angles to combine with each tilt (default 0)
  --hfov deg           lens horizontal field of view (default ${WARP_DEFAULTS.hfov})
  --stretch a,b,...    row stretch factors to try (default none; e.g. 1.5,2,3)
  --corners x1,y1,..x4,y4   the code's corners TL,TR,BR,BL in frame px → pulled square
  --only-corners       with --corners: try only that warp
  --scale n            magnification (default ${WARP_DEFAULTS.scale})
  --max px             cap on the warped picture's long side (default ${WARP_DEFAULTS.maxSide})
  --no-norm            do not stretch the ROI's contrast
  --invert             also try light-on-dark codes
  --all                try every warp, not just until the first read
  --out dir            write the source and each warped view as PNG there
  --json               print the result as JSON`;
}

async function main(argv) {
  const o = {};
  let file = null, grab = null, device = null, size = '1920x1080', out = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') { console.log(usage()); return 0; }
    else if (a === '--grab') grab = argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : 'http://localhost:8090/camera/frame.jpg';
    else if (a === '--device') device = next();
    else if (a === '--size') size = next();
    else if (a === '--roi') o.roi = nums(next());
    else if (a === '--tilt') o.tilts = nums(next());
    else if (a === '--roll') o.rolls = nums(next());
    else if (a === '--hfov') o.hfov = Number(next());
    else if (a === '--stretch') o.stretches = nums(next());
    else if (a === '--scale') o.scale = Number(next());
    else if (a === '--max') o.maxSide = Number(next());
    else if (a === '--corners') {
      const v = nums(next());
      if (v.length !== 8) { console.error('--corners: 8 ədəd lazımdır (x1,y1,...,x4,y4)'); return 2; }
      o.corners = [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]], [v[6], v[7]]];
    }
    else if (a === '--only-corners') { o.cornersOnly = true; o.tilts = []; o.stretches = []; o.plain = false; }
    else if (a === '--no-norm') o.normalize = false;
    else if (a === '--invert') o.invert = true;
    else if (a === '--all') o.all = true;
    else if (a === '--out') out = next();
    else if (a === '--json') json = true;
    else if (!a.startsWith('--')) file = a;
    else { console.error(`bilinməyən seçim: ${a}\n\n${usage()}`); return 2; }
  }
  if (!jsQR) { console.error('jsqr yüklənmədi — npm install'); return 2; }

  if (out) fs.mkdirSync(out, { recursive: true });
  const tmp = out || fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'qrwarp-'));
  if (grab) {
    const r = await fetch(grab);
    if (!r.ok) { console.error(`${grab}: HTTP ${r.status}`); return 2; }
    file = path.join(tmp, 'qrwarp-src.jpg');
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  } else if (device) {
    file = path.join(tmp, 'qrwarp-src.jpg');
    grabDevice(device, size, file);
  }
  if (!file) { console.error(usage()); return 2; }

  const { gray, w, h } = loadGray(file);
  o.keep = !!out;
  const res = readWarped(gray, w, h, o);

  if (out) {
    for (const t of res.tried) {
      if (!t.img) continue;
      const f = path.join(out, `qrwarp-${t.id}.png`);
      saveGray(f, t.img, t.w, t.h);
      t.file = f;
      delete t.img;
    }
  }
  for (const t of res.tried) delete t.img;

  if (json) {
    console.log(JSON.stringify({ file, w, h, ...res }, null, 1));
  } else {
    console.log(`${file}: ${w}x${h}, ROI ${res.roi.join(',')}`);
    for (const t of res.tried) {
      if (t.skipped) { console.log(`  ${t.name.padEnd(14)} –  ${t.skipped}`); continue; }
      console.log(`  ${t.name.padEnd(14)} ${`${t.w}x${t.h}`.padEnd(10)} ${String(t.ms).padStart(4)} ms  `
        + (t.ok ? `✓ ${t.text}` : '–') + (t.file ? `   ${t.file}` : ''));
    }
    console.log(res.text
      ? `\noxundu: "${res.text}" — ${res.warp}; künclər ${res.corners.map((p) => p && p.join(',')).join('  ')}`
      : '\noxunmadı. --out ilə baxın decoder nə görür; kod ROI-dadırmı, yetərincə böyükdürmü?');
  }
  if (!out && tmp !== out && (grab || device)) {
    // Keep the grabbed frame (so the same picture can be tried again with
    // other settings); drop only an empty temp dir.
    try { fs.rmdirSync(tmp); } catch { /* the frame is in it: leave it */ }
  }
  return res.text ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(e.message || e);
    process.exit(2);
  });
}
