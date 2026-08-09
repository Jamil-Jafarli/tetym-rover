/**
 * Road detection — shared by /vision (look and tune) and /follow (drive).
 *
 * Kept in one file on purpose: two copies of a tuned detector drift, and then
 * the robot follows something different from what the tuning page shows. Both
 * pages draw their camera into a 480×360 canvas and hand the pixels to detect().
 *
 * Loaded as a plain script, so everything below is global — that is also how
 * test/test_vision.mjs gets at detect(), scan() and the auto-mode state.
 */

// The detector's working resolution. Both pages size their canvas to match, so
// the scratch buffers below can be allocated once and never resized.
const W = 480, H = 360;

// 'dark'  = the road is the dark corridor between two white edges (the real
//           track). 'white' = the road itself is the white strip.
// 'auto'  = work it out from the frame, every frame. See decide().
const cfg = { mode: 'auto', roi: 0.45, bias: 0, sat: 60, minw: 0.06, bands: 8,
              side: 0.18, jump: 0.14 };

// Where the road was last frame, so a momentary blob cannot steal the lock.
let lastNear = null, lockAge = 0;

// ── detection ───────────────────────────────────────────────────────
// Scratch buffers, allocated once — reallocating every frame would churn the
// garbage collector at 30 fps.
const luma = new Uint8Array(W * H);
const white = new Uint8Array(W * H);
const cols = new Int32Array(W);
const hist = new Uint32Array(256);

// A real road never fills the whole view. If the widest run does, the
// threshold has failed rather than the road having got enormous — report
// nothing instead of a confident lie.
const MAX_RUN = 0.88;

/**
 * Otsu: split the histogram where between-class variance is largest.
 *
 * On a clean, evenly lit track the histogram has a real gap between floor and
 * road, and EVERY threshold inside that gap scores identically. Taking the
 * first winner parks the threshold on the gap's lower edge — one shadow and
 * the floor starts reading as road. So track the whole winning plateau and
 * return its midpoint, which is the middle of the gap.
 */
function otsu(total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, lo = 128, hi = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best * 1.000001) { best = v; lo = hi = t; }
    else if (v >= best * 0.999999) { hi = t; }
  }
  return (lo + hi) >> 1;
}

// ── automatic track-type decision ───────────────────────────────────
// The camera sits low and looks at the ground just ahead, so the bottom-centre
// of the frame IS the road, whatever the track happens to be. That means the
// track type does not have to be guessed from the scene as a whole: it can be
// *measured* off the one patch whose identity we already know.
//
// Three independent signals, each voting white / dark / abstain. Two have to
// agree, which is what stops a single misleading one from flipping the mode:
//
//   1. probe   — is the patch under the robot bright or dark?
//   2. roi     — is white the majority of the view, or a minority?
//                A white road fills the frame; two edge lines never do.
//   3. contrast— is the centre brighter than the sides, or the sides brighter
//                than the centre? That is literally the difference between
//                "white road on dark floor" and "black road with white edges".
//
// The case all three exist for: the robot parked straddling a white edge line.
// Then the probe says white (+1) and the contrast says white (+1) but the ROI
// still says white is a minority (-1) — net +1, below the threshold, so the
// mode holds instead of flipping to nonsense.
const PROBE_W = 0.34;   // centre 34 % of the width
const PROBE_H = 0.14;   // bottom 14 % of the height
const FLANK_W = 0.15;   // outer 15 % on each side, same rows

let autoMode = 'dark';  // the resolved mode when cfg.mode === 'auto'
let autoVotes = 0;      // consecutive frames arguing for the other mode
let autoSeen = false;   // has it ever committed? first commit is instant
let autoWhy = null;     // the three signals, for the UI
let autoLocked = false; // committed for the rest of the run — see roadLockAuto

function frac(thr, xA, xB, yA, yB) {
  let on = 0;
  for (let y = yA; y < yB; y++) {
    const off = y * W;
    for (let x = xA; x < xB; x++) {
      const p = off + x;
      if (white[p] && luma[p] >= thr) on++;
    }
  }
  const n = (xB - xA) * (yB - yA);
  return n > 0 ? on / n : 0;
}

const clamp1 = v => v < -1 ? -1 : v > 1 ? 1 : v;

// How well-formed is a scan? A long chain whose corridors are bounded on both
// sides by real pixels is a road; two bands of something is noise. Corridors
// that only "close" because they hit the frame edge do not count — floor
// beside a white road does that too, and would score the wrong reading just
// as highly as the right one.
const quality = s => s.pts.length + s.confirmed * 0.5;

function decide(thr, y0, dark, wht) {
  const yA = Math.max(y0, Math.floor(H * (1 - PROBE_H)));
  const xA = Math.floor(W * (0.5 - PROBE_W / 2));
  const xB = Math.ceil (W * (0.5 + PROBE_W / 2));
  const probe = frac(thr, xA, xB, yA, H);

  // The flanks sit immediately outside the probe, not at the frame edge —
  // what matters is what borders the road, not what is happening in the far
  // corners of the room.
  const fl = frac(thr, Math.max(0, Math.floor(xA - W * FLANK_W)), xA, yA, H);
  const fr = frac(thr, xB, Math.min(W, Math.ceil(xB + W * FLANK_W)), yA, H);
  const contrast = probe - (fl + fr) / 2;

  const qd = quality(dark), qw = quality(wht);

  // Each signal scores in [-1, +1] rather than casting a hard vote, because
  // "just under the line" is information and rounding it to zero throws it
  // away: a road shifted far enough that the probe box straddles its edge
  // makes two signals marginal at once, and three marginals all pointing the
  // same way should still be an answer.
  const vP = clamp1((probe - 0.45) / 0.12);   // what is under the robot
  const vC = clamp1(contrast / 0.22);         // centre vs what borders it
  const vQ = clamp1((qw - qd) / 2);           // which reading finds a road
  const sum = vP + vC + vQ;

  // The cut is above 1.0 on purpose: no single signal, however sure of itself,
  // can carry the decision alone. Two have to lean the same way.
  const want = sum >= 1.2 ? 'white' : sum <= -1.2 ? 'dark' : null;

  autoWhy = { probe, contrast, qd, qw, vP, vC, vQ, sum, want };

  if (!want) { autoVotes = 0; return; }
  if (want === autoMode) { autoVotes = 0; autoSeen = true; return; }
  // Locked: the track does not change type halfway round, so once a run has
  // committed to one, every later disagreement is something else — a shadow, a
  // doorway, a person's shoe. Keep scoring it (the numbers stay on screen and
  // in the log) but stop acting on it.
  if (autoLocked && autoSeen) { autoVotes = 0; return; }
  // Committing the very first time is instant; changing its mind afterwards
  // costs ~10 frames of agreement, so a hand waving past cannot flip the mode.
  if (++autoVotes >= (autoSeen ? 10 : 1)) {
    autoMode = want; autoVotes = 0; autoSeen = true;
    lastNear = null;                  // the lock is meaningless in the other mode
  }
}

/**
 * One interpretation of the frame, scanned bottom-up.
 *
 * Pure with respect to the temporal lock: it reads `anchor` but writes
 * nothing, so `auto` can run it twice — once per mode — and compare, without
 * the speculative run poisoning the state of the one that wins.
 */
function scan(mode, thr, y0, anchor) {
  const bandH = Math.max(1, Math.floor((H - y0) / cfg.bands));
  const minRun = Math.max(2, Math.floor(W * cfg.minw));
  const maxJump = Math.max(4, W * cfg.jump);
  const pts = [];
  let confirmed = 0;

  // The road is one connected thing that starts under the robot. So: lock on
  // to the bottom band, then climb, and at each step only accept a run that
  // continues the one below it. White furniture off to the side never touches
  // the bottom band and never lines up with the run below, so it is dropped
  // by geometry rather than by hoping a brightness threshold excludes it.
  let prevX = null, prevW = null, relocked = false;

  for (let b = 0; b < cfg.bands; b++) {
    const yB = H - b * bandH;
    const yA = Math.max(y0, yB - bandH);
    if (yB - yA < 1) continue;

    // Trapezoid gate: the further up the frame, the narrower the strip we are
    // willing to look at. Furniture and skirting live at the edges.
    const up = (H - (yA + yB) / 2) / Math.max(1, H - y0);   // 0 near, 1 far
    const halfAllowed = (W / 2) * (1 - cfg.side * up);
    const xLo = Math.max(0, Math.floor(W / 2 - halfAllowed));
    const xHi = Math.min(W, Math.ceil(W / 2 + halfAllowed));

    cols.fill(0);
    for (let y = yA; y < yB; y++) {
      const rowOff = y * W;
      for (let x = xLo; x < xHi; x++) {
        const p = rowOff + x;
        if (white[p] && luma[p] >= thr) cols[x]++;
      }
    }

    // A column counts as white only if most of the band's rows agree — that
    // drops thin horizontal glints without needing a blur pass.
    const need = Math.max(1, Math.floor((yB - yA) * 0.5));
    const runs = [];
    let run = 0;

    if (mode === 'white') {
      // Runs OF white: the road is the bright strip. "Confirmed" here means
      // the strip is bounded by something darker on both sides rather than
      // bleeding off into more white.
      for (let x = xLo; x <= xHi; x++) {
        if (x < xHi && cols[x] >= need) run++;
        else {
          if (run >= minRun && run <= W * MAX_RUN) {
            const start = x - run;
            const left  = start > xLo + 1 && cols[start - 1] < need;
            const right = x < xHi - 1     && cols[x] < need;
            const e = (left ? 1 : 0) + (right ? 1 : 0);
            runs.push({ x: start + run / 2, w: run, edges: e, solid: e === 2 });
          }
          run = 0;
        }
      }
    } else {
      // Runs BETWEEN white: the road is the dark corridor. A gap is by
      // definition flanked by white, which is exactly the confirmation we
      // want — a white sofa or a pool of light is an edge, never a road.
      for (let x = xLo; x <= xHi; x++) {
        const isWhite = x < xHi && cols[x] >= need;
        if (!isWhite && x < xHi) run++;
        else {
          if (run >= minRun && run <= W * MAX_RUN) {
            const start = x - run;
            // Touching the frame edge counts as confirmed: the road is simply
            // leaving the view, which happens on every sharp corner.
            const wL = start > xLo + 1 && cols[start - 1] >= need;
            const wR = x < xHi - 1       && cols[x] >= need;
            // Touching the frame edge counts as confirmed for the purpose of
            // ACCEPTING a corridor — the road is simply leaving the view,
            // which happens on every sharp corner. It does not count towards
            // `solid`, which is the evidence that this reading of the frame is
            // the right one: floor beside a white road also runs off the edge.
            const left  = wL || start <= xLo + 1;
            const right = wR || x >= xHi - 1;
            runs.push({ x: start + run / 2, w: run,
                        edges: (left ? 1 : 0) + (right ? 1 : 0), solid: wL && wR });
          }
          run = 0;
        }
      }
      // Prefer corridors with white on both sides; only fall back to
      // one-sided ones if nothing better exists in this band.
      const both = runs.filter(r => r.edges === 2);
      if (both.length) runs.length = 0, runs.push(...both);
    }
    if (!runs.length) break;          // the road ended; stop climbing

    let pick = null;
    if (prevX === null) {
      // Bottom band. Prefer the run nearest where the road was last frame —
      // that is what stops a bright patch sliding through and stealing the
      // lock. With no lock yet, take the widest.
      const near = anchor === null ? []
        : runs.filter(r => Math.abs(r.x - anchor) <= maxJump * 2);
      const pool = near.length ? near : runs;
      if (!near.length && anchor !== null) relocked = true;
      pick = pool.reduce((a, r) => (r.w > a.w ? r : a));
    } else {
      // Higher bands must continue the one below: close in x, and not wildly
      // wider — perspective means the road narrows with distance, never
      // suddenly balloons.
      const ok = runs.filter(r => Math.abs(r.x - prevX) <= maxJump
                                && r.w <= prevW * 1.6 + minRun);
      if (!ok.length) break;
      pick = ok.reduce((a, r) => (Math.abs(r.x - prevX) < Math.abs(a.x - prevX) ? r : a));
    }

    pts.push({ x: pick.x, y: (yA + yB) / 2, w: pick.w, band: b });
    if (pick.solid) confirmed++;
    prevX = pick.x;
    prevW = pick.w;
  }

  return { pts, confirmed, relocked };
}

function detect(data) {
  const y0 = Math.floor(H * cfg.roi);
  hist.fill(0);

  // One pass: luma, "is it colourless", and the histogram for Otsu.
  let gated = 0;
  for (let y = y0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const v = (r * 77 + g * 151 + b * 28) >> 8;
      luma[p] = v;
      // White means bright AND colourless. The saturation gate is what keeps
      // a yellow board or a sunlit wooden floor out of the mask.
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const colourless = (mx - mn) <= cfg.sat;
      white[p] = colourless ? 1 : 0;
      // Only colourless pixels feed the histogram. Letting a big coloured
      // object into it drags Otsu's split away from where the road actually
      // is — a bright yellow board pulled the threshold down to the floor
      // level and turned the entire frame into "road".
      if (colourless) { hist[v]++; gated++; }
    }
  }

  // Too few colourless pixels for a split to mean anything — fall back to a
  // fixed mid threshold rather than trusting a degenerate histogram.
  let thr = (gated > (H - y0) * W * 0.02 ? otsu(gated) : 160) + cfg.bias;
  thr = thr < 0 ? 0 : thr > 255 ? 255 : thr;

  // Which kind of track is this? In auto, run BOTH readings of the frame and
  // let them compete — "which interpretation actually finds a road" is a
  // second opinion that owes nothing to the brightness probe.
  let mode = cfg.mode, out;
  if (cfg.mode === 'auto') {
    const dark = scan('dark',  thr, y0, lastNear);
    const wht  = scan('white', thr, y0, lastNear);
    decide(thr, y0, dark, wht);
    mode = autoMode;
    out = mode === 'dark' ? dark : wht;
  } else {
    autoWhy = null;
    out = scan(mode, thr, y0, lastNear);
  }
  const pts = out.pts;

  // Only trust the lock once a couple of bands agree — a single band is just
  // a bright patch.
  if (pts.length >= 2) { lastNear = pts[0].x; lockAge = 0; }
  else if (++lockAge > 15) { lastNear = null; }   // lost for ~0.5 s: forget

  return { thr, y0, pts, relocked: out.relocked, mode };
}

// ── mode switching ──────────────────────────────────────────────────
// The pages own their own buttons; this is the part that has to happen
// whichever page you are on. Both /vision and /follow define a setMode() that
// updates their UI and then calls this.
function roadSetMode(m) {
  cfg.mode = m;
  autoSeen = false;                   // re-lock instantly on the next frame
  autoVotes = 0;
  lastNear = null;                    // the lock means nothing across modes
}

/**
 * Freeze (or release) the automatic track type.
 *
 * A real track is one kind of track from start to finish. While you are
 * pointing the camera around and tuning, letting `auto` re-decide every frame
 * is exactly what you want — but during a run it is a liability: half a lap in,
 * the only things that can still argue for the other reading are a shadow, a
 * bright doorway or someone's shoe, and switching costs the lock, the chain and
 * usually the lap.
 *
 * So /follow locks it on ARM and releases it on stop. If nothing had been
 * decided yet, the very next frame still gets to commit once — locking before
 * the first look would just freeze the default.
 */
function roadLockAuto(on) {
  autoLocked = !!on;
  if (!on) autoVotes = 0;
}

// ── steering error ──────────────────────────────────────────────────
// One place that turns a detection into numbers a controller can use, so the
// tuning page and the pilot cannot disagree about what "sapma" means.
//
//   near — the band right in front of the wheels: where the robot IS wrong
//   far  — the mean of the upper half of the chain: where the road IS GOING
//
// A pilot needs both: near to correct, far to slow down before the bend
// rather than in the middle of it.
function roadError(res) {
  const half = W / 2;
  const near = res.pts[0];
  if (!near) return { near: null, far: null, bands: res.pts.length };
  const up = res.pts.filter(p => p.band >= Math.floor(cfg.bands / 2));
  return {
    near: (near.x - half) / half,
    far: up.length
      ? up.reduce((a, p) => a + (p.x - half) / half, 0) / up.length
      : (near.x - half) / half,
    bands: res.pts.length,
  };
}
