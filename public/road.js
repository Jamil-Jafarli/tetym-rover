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

// 'line'  = THE COMPETITION LINE: three equal stripes, blue | orange | blue.
//           See scanLine(). This is the one the rules describe and the only
//           one that will be on the floor at the event.
// 'dark'  = the road is the dark corridor, bounded by something brighter on
//           either side — white edge lines, but plain floor will do.
// 'white' = the road itself is the bright strip. Both of these are tape on a
//           workshop floor: still worth having, because that is what you can
//           lay out at home, but neither is the competition track.
// 'auto'  = work it out from the frame, every frame. See decide().
//
// `edge` is the minimum brightness step, in luma levels, that a border has to
// jump for the thing beside it to count as a line at all. It is what makes the
// monochrome modes line detectors rather than colour classifiers — see scan().
// 0 turns the requirement off and hands the frame back to bare thresholding.
// `arm` is the 90° corner's threshold, in units of the road's own width — see
// the corner block in scan(). Neither applies in 'line' mode, which is looking
// for something else entirely.
// `chroma` and `hueTol` are 'line' mode's own two numbers: how strong a
// pixel's colour has to be before its hue is worth reading at all, and how far
// off the nominal blue and orange it may sit. `fill` is how much of a column
// has to be one of those colours for the column to count as that stripe.
const cfg = { mode: 'auto', roi: 0.45, bias: 0, sat: 60, minw: 0.06, bands: 8,
              side: 0.18, jump: 0.14, contrast: 0, edge: 18, arm: 0.8,
              chroma: 45, hueTol: 32, fill: 0.5 };

// The line's two colours, as hue angles. Straight off the rules drawing: its
// vector fills are rgb(52,101,164) and rgb(255,128,0), which are 214° and 30°.
//
// Hue and not RGB, because hue is the part of a colour that survives the room:
// a dimmer bulb, a darker patch of floor and a camera's auto-exposure all move
// brightness and saturation and leave hue very nearly alone. `chroma` is the
// guard that stops that from being a liability — near grey the hue angle is
// numerical noise, so a pixel has to have real colour in it before its hue is
// read at all.
const HUE_ORANGE = 30;
const HUE_BLUE = 214;

// The stripes are equal thirds, so the gap between the two blue ones is about
// as wide as either of them. These are how far from "about" a candidate may
// sit and still be believed — generous, because the camera looks along the
// line at an angle and the near end of a band is wider than its far end, but
// nothing like wide enough to admit two unrelated blue things in a room.
const GAP_LO = 0.45, GAP_HI = 2.2;   // gap width ÷ mean blue stripe width
const BLUE_RATIO = 2.5;              // how unequal the two blue stripes may be

// Over a QR code. A real code's white paper is wider than the orange stripe —
// its quiet zone bites into both blues — and next to a sheet of white the
// camera's exposure drops and the blue beside it can lose its colour
// altogether. The rover met both: with the code under its wheels the bottom
// band found nothing and the whole line vanished, and a code further up cut
// the chain, which then read as the END of the line. So a band that looks like
// a QR code (qrLike()) — and only such a band — gets two allowances:
//
//   · the gap between the blues may be up to QR_GAP_HI of their width, as
//     long as the pair is as wide overall as the line below it
//   · if it still finds nothing, it is stepped over — up to QR_SKIP bands in
//     a row — and the chain carries on above it, or starts above it
//
// Neither lets a line be invented: a code lying on bare floor has no blue on
// either side of it, and a chain that finds nothing above the code still ends
// where the paint did.
const QR_GAP_HI = 4.0;
const QR_SKIP = 3;

// Where the road was last frame, and how wide it was there, so a momentary
// blob cannot steal the lock. The width is not decoration: it is the yardstick
// the corner test measures an arm's overhang against, and the bottom band —
// the one a corner arrives in — has no band below it to take a width from.
let lastNear = null, lastW = 0, lockAge = 0;

// The corner's own lock. One frame's L is a shadow across the road or a strip
// of light under a door; two frames agreeing is a corner. This is deliberately
// short — a corner arrives, it does not need to be believed for long, and the
// thing that has to remember it once the road disappears is the pilot, which
// is where committing to a turn is decided.
const CORNER_VOTES = 2;
let cornerDir = 0, cornerVote = 0;

// The same idea for the end of a painted stub. Two frames, because one band
// dropping out of the chain is what a dropped frame looks like and what a
// shadow across the far end of the line looks like, and neither is the line
// having run out.
const END_VOTES = 2;
let endVote = 0;

// ── junctions ────────────────────────────────────────────────────────
//
// The competition track branches. A1, A2 and A3 hang off three junctions in a
// row and are otherwise the same station three times over, so telling them
// apart is entirely a matter of counting the junctions on the way — which
// means seeing them is not a nicety, it is the task. field.js holds the count;
// this holds the seeing.
//
// A branch leaves the line square, so from a camera looking along the line it
// does not appear as a line beside this one. It appears as one band of the
// picture painted right across. That is the whole measurement: how wide the
// unbroken run of line colour through the lock is, against how wide the line
// itself is there.
//
// `JUNC_WIDE` is that ratio. Nearly 2 rather than a hair over 1 because
// perspective already widens the line towards the wheels and a camera that is
// a few degrees off square sees a wider line still; a branch is not a bit
// wider, it is the width of the frame.
const JUNC_WIDE = 1.9;
// How far past the line's own edge the paint must reach before that side
// counts as an arm, in units of the line's width. This is what separates a
// crossroads from a T, and a T-left from a T-right — the thing the count is
// actually made of. Same idea, and deliberately the same sort of number, as
// `cfg.arm` in the monochrome corner test.
const JUNC_ARM = 0.7;
// Two frames, for the same reason a corner needs two: one frame's band
// painted across is a strip of sunlight, a pallet edge, or the load itself.
const JUNC_VOTES = 2;
// How many rows of neither colour the cross-section walk may cross — see
// juncArmIsLine(). Two, because that is what a stripe seam costs; more would
// start joining the branch to the floor markings beside it.
const JUNC_SEAM = 2;
let juncSide = '', juncVote = 0;

// ── detection ───────────────────────────────────────────────────────
// Scratch buffers, allocated once — reallocating every frame would churn the
// garbage collector at 30 fps.
const luma = new Uint8Array(W * H);
const white = new Uint8Array(W * H);
// 'line' mode's masks: is this pixel the line's orange, or the line's blue?
// Full-frame like the others so the overlay can paint straight from them.
const orange = new Uint8Array(W * H);
const blue = new Uint8Array(W * H);
const hist = new Uint32Array(256);
// Every colourless-or-not pixel, unlike `hist` — the fallback below needs a
// histogram that still has a real gap in it even when the saturation gate
// throws almost everything away.
const histAll = new Uint32Array(256);
// Contrast lookup, rebuilt once per frame — see buildContrastLUT().
const clut = new Uint8Array(256);
// One band's stripe profile, for 'line' mode: how much of each column was
// orange, and how much was blue. Counts, turned into fractions of the band's
// height by scanLine().
const oCol = new Int32Array(W);
const bCol = new Int32Array(W);
// One band's column profile: `prof` is the summed brightness down each column,
// `sm` the same smoothed and averaged, `clean` how many of the column's pixels
// were colourless. Reused band after band — see scan().
const prof = new Float32Array(W);
const sm = new Float32Array(W);
const clean = new Int32Array(W);
// That profile's histogram, for the band's own Otsu split.
const bhist = new Uint32Array(256);

/**
 * Contrast, as a 256-entry brightness lookup rebuilt once per frame.
 *
 * This is deliberately an S-curve (tanh), not a plain gain. A gain is an
 * affine map of luma, and Otsu's between-class-variance split is *invariant*
 * to any increasing affine map — it always lands on the same pixels, just
 * relabelled, so a plain "multiply away from grey" control would not change a
 * single detection outcome, only how the mask looks. An S-curve pivoted on
 * mid-grey is not affine: it pushes values near the pivot apart harder than
 * values already far from it, which is exactly where a washed-out feed (dim
 * light, worn tape, an over-exposed camera) puts the real floor/line boundary
 * — so it can turn a shallow, easily-confused gap into one Otsu actually
 * finds. `cfg.contrast` is the curve's steepness: 0 is the identity (off).
 *
 * It has a second job since the scan started measuring edge steps: those are
 * differences in luma levels, so stretching the curve stretches them too, and
 * a faint-but-real edge can be lifted over `cfg.edge` with it. That is a knob
 * to reach for only after the edge bar itself, though — the curve amplifies
 * noise by the same factor as it amplifies the line.
 *
 * Negative values ask for the opposite — a washed-out feed is rare, a glary
 * one (direct sun on tape, a reflective floor) is not, and there the real
 * boundary is a false spike rather than a shallow gap, so *reducing* contrast
 * flattens the spike back into the histogram Otsu already handles. tanh is
 * odd, so feeding it a negative steepness the same way as positive would
 * cancel out (sign flips top and bottom of the same fraction) and land on the
 * identical curve — not an inverse, just the S-curve again. So negative uses
 * plain linear shrink-toward-grey instead, pivoted on the same 128.
 */
function buildContrastLUT() {
  if (cfg.contrast === 0) {
    for (let i = 0; i < 256; i++) clut[i] = i;
    return;
  }
  if (cfg.contrast > 0) {
    const den = Math.tanh(cfg.contrast);
    for (let i = 0; i < 256; i++) {
      const y = Math.tanh(cfg.contrast * (i - 128) / 128) / den;
      const v = Math.round(128 + y * 128);
      clut[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  } else {
    const shrink = 1 / (1 - cfg.contrast);
    for (let i = 0; i < 256; i++) clut[i] = Math.round(128 + (i - 128) * shrink);
  }
}

// A real road never fills the strip a band is allowed to look at. If the
// widest run does, the threshold has failed rather than the road having got
// enormous — report nothing instead of a confident lie. Measured against the
// band's OWN span, not the frame: the trapezoid gate narrows the upper bands,
// and a run filling one of those is just as much a failure as one filling the
// bottom band, even though it is only ~80 % of the frame wide.
//
// Such a run is still kept, flagged `wide`, rather than thrown away at birth:
// it cannot be followed, but it is evidence. A 90° corner arriving at the
// wheels genuinely does fill the bottom band, and the corner test below is
// the one reader that wants to see it.
const MAX_RUN = 0.88;

// How many columns either side of a border the brightness step is measured
// over, and how far the column profile is smoothed before anything is read off
// it. Both are small: a tape edge is a few pixels wide at this resolution, and
// smoothing past that would blunt the very step we are looking for.
const EDGE_K = 4;
const SMOOTH = 2;

/**
 * Otsu: split the histogram where between-class variance is largest.
 *
 * On a clean, evenly lit track the histogram has a real gap between floor and
 * road, and EVERY threshold inside that gap scores identically. Taking the
 * first winner parks the threshold on the gap's lower edge — one shadow and
 * the floor starts reading as road. So track the whole winning plateau and
 * return its midpoint, which is the middle of the gap.
 */
function otsu(total, h = hist) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * h[i];
  let sumB = 0, wB = 0, best = -1, lo = 128, hi = 128;
  for (let t = 0; t < 256; t++) {
    wB += h[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * h[t];
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
    lastNear = null; lastW = 0;       // the lock is meaningless in the other mode
  }
}

/**
 * How far a hue sits from a nominal one, in degrees, the short way round.
 *
 * The short way round matters: orange is 30°, and a warm-lit orange reading
 * 355° is five degrees away from it, not 325. Getting that wrong throws away
 * exactly the pixels at the red end of the tape, which is where a warm bulb
 * or a low sun puts them.
 */
function hueOff(h, want) {
  const d = Math.abs(h - want) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The competition line: three equal stripes, blue | orange | blue.
 *
 * A different question from scan()'s. The monochrome modes ask "is this thing
 * bounded like a line" because brightness alone cannot tell a line from a
 * shadow. Here the line announces itself: no floor, shadow, doorway or unlit
 * corner is saturated orange between two stripes of saturated blue, so the
 * signature can simply be looked for, and anything that is not it is not the
 * line — no thresholding, no Otsu, nothing to fool.
 *
 * **The line is found by its BLUE stripes, and its centre is the gap between
 * them.** That is deliberate, and it is not the obvious way round. The obvious
 * way is to hunt for the orange middle and check it is flanked — but the rules
 * print a 50 mm QR code ON the line at the end of every stub, and a 50 mm
 * patch of white covers most of a stripe that is itself about 50 mm wide. Hunt
 * for orange and the line vanishes at exactly the place the robot most needs
 * it: the end it is driving to, where the QR it has come to read is. The blue
 * stripes are not interrupted by anything, so looking for the pair and taking
 * the middle keeps working over the QR, and the orange in between becomes
 * confirmation rather than the whole test.
 *
 * Same band-by-band chain as scan(), and for the same reasons — the line is
 * one connected thing that starts under the robot — so the two return the same
 * shape and everything downstream is untouched.
 *
 * Pure with respect to the temporal lock: reads `anchor`, writes nothing.
 */
/**
 * Is the paint at (px, py) a LINE crossing the picture, or just a coloured
 * band lying across it?
 *
 * The station areas are outlined in yellow tape, and yellow is close enough to
 * orange in hue that a strip of it across the line has exactly the shape a
 * branch has: one band of the picture painted right across, reaching out to
 * one side. Width cannot tell them apart. Colour can — a branch is a LINE, so
 * it is blue │ orange │ blue like every other metre of paint on this field,
 * only stacked up the frame instead of across it, because that is what looking
 * along a line square to yours does to it.
 *
 * So the run of paint through the arm is grown vertically and read like a
 * cross-section: blue a third of the way in from each end, orange in the
 * middle. Sampled at three rows rather than counted, because the seams are
 * anti-aliased and the far edge of a branch is a pixel or two of neither.
 *
 * The walk bridges a pixel or two of nothing, because the seam between two
 * stripes is a blend of them and a blend of blue and orange is neither: it
 * lands somewhere near grey, fails the chroma gate, and would otherwise stop
 * the walk one stripe short and hand back "blue, then blue" — which is not a
 * line and is exactly the shape a real branch produces.
 *
 * The masks only exist below the ROI, which is why the walk stops at y0.
 */
function juncArmIsLine(px, py, y0) {
  const x = Math.round(px), y = Math.round(py);
  if (x < 0 || x >= W || y < y0 || y >= H) return false;
  const paint = (yy) => orange[yy * W + x] || blue[yy * W + x];
  if (!paint(y)) return false;
  let a = y, z = y, gap = 0;
  for (let yy = y - 1; yy >= y0; yy--) {
    if (paint(yy)) { a = yy; gap = 0; } else if (++gap > JUNC_SEAM) break;
  }
  gap = 0;
  for (let yy = z + 1; yy < H; yy++) {
    if (paint(yy)) { z = yy; gap = 0; } else if (++gap > JUNC_SEAM) break;
  }
  const t = z - a + 1;
  if (t < 6) return false;
  // A third of the way in from each end, and the middle. Sampled rather than
  // counted because the run has already been proved contiguous, and three
  // reads cost nothing on a frame that has fifty of these.
  const in6 = Math.max(1, (t / 6) | 0);
  return !!(blue[(a + in6) * W + x] && blue[(z - in6) * W + x]
            && orange[((a + z) >> 1) * W + x]);
}

/**
 * Does this stretch of a band look like a QR code — a patch with both paper
 * white and print black in it?
 *
 * Luma, not colour: the code has none, and that is the point — the floor, the
 * tape and the stripes are each one tone, and a code is the one thing on this
 * field that is bright and dark at once, within a stripe's width. Both are
 * required: a light floor is all bright and a dark one all dark.
 */
function qrLike(yA, yB, cx, half) {
  const xa = Math.max(0, Math.floor(cx - half));
  const xz = Math.min(W, Math.ceil(cx + half));
  let bright = 0, dark = 0, n = 0;
  for (let y = yA; y < yB; y++) {
    const off = y * W;
    for (let x = xa; x < xz; x++) {
      const v = luma[off + x];
      if (v >= 200) bright++; else if (v <= 70) dark++;
      n++;
    }
  }
  return n > 0 && bright >= n * 0.06 && dark >= n * 0.03;
}

function scanLine(y0, anchor) {
  const bandH = Math.max(1, Math.floor((H - y0) / cfg.bands));
  const minRun = Math.max(2, Math.floor(W * cfg.minw));
  const maxJump = Math.max(4, W * cfg.jump);
  const pts = [];
  const bands = [];
  const crossings = [];
  let confirmed = 0, chroma0 = 0;
  let prevX = null, prevW = null, relocked = false;
  // Bands stepped over in a row, and bands read over a QR code in all — see
  // QR_GAP_HI / QR_SKIP.
  let skips = 0, qrBands = 0;
  // Where the chain stopped, and whether it stopped inside the picture. See
  // the `end` note at the bottom.
  let lastBand = -1, endedAt = null;

  for (let b = 0; b < cfg.bands; b++) {
    const yB = H - b * bandH;
    const yA = Math.max(y0, yB - bandH);
    if (yB - yA < 1) continue;

    const up = (H - (yA + yB) / 2) / Math.max(1, H - y0);
    const halfAllowed = (W / 2) * (1 - cfg.side * up);
    const xLo = Math.max(0, Math.floor(W / 2 - halfAllowed));
    const xHi = Math.min(W, Math.ceil(W / 2 + halfAllowed));
    const rows = yB - yA;
    if (xHi - xLo < minRun) break;

    for (let x = xLo; x < xHi; x++) { oCol[x] = 0; bCol[x] = 0; }
    for (let y = yA; y < yB; y++) {
      const off = y * W;
      for (let x = xLo; x < xHi; x++) {
        if (orange[off + x]) oCol[x]++;
        else if (blue[off + x]) bCol[x]++;
      }
    }

    // A column is a stripe if enough of it is that colour. Counting down the
    // column IS the noise filter — a JPEG artefact or a fleck of dirt moves a
    // column's fraction by one row out of forty — and it is what lets a band
    // survive the top of the line passing behind a shadow.
    const need = Math.max(1, Math.round(rows * cfg.fill));
    const runs = [];
    let start = -1;
    for (let x = xLo; x <= xHi; x++) {
      const isBlue = x < xHi && bCol[x] >= need;
      if (isBlue) { if (start < 0) start = x; continue; }
      if (start >= 0 && x - start >= 2) runs.push({ a: start, z: x, w: x - start });
      start = -1;
    }

    // Peak chroma in the band in front of the wheels, for the pages: when
    // nothing is found, this is the number that separates "the line is not in
    // shot" from "the colour bar is set too high for this light".
    if (b === 0) {
      let peak = 0;
      for (let x = xLo; x < xHi; x++) {
        const f = (oCol[x] + bCol[x]) / rows;
        if (f > peak) peak = f;
      }
      chroma0 = peak;
    }

    // Is this band a crossing rather than a stretch of line?
    //
    // Taken here, before the chain does its work, because the chain cannot
    // survive a crossing and should not be asked to: a band painted right
    // across is one enormous blue run, no pair of stripes inside it sits at
    // the right proportions, and the continuity rule below throws out what is
    // left. That is why a junction reads as `end` today — the line appears to
    // stop, because as far as the chain is concerned it has. The chain is
    // right to refuse it. It is just not the whole story, and the rest of the
    // story is in oCol/bCol, which are already filled in.
    //
    // The run is grown outwards from where the line was in the band below —
    // the stem — rather than from the widest thing in the band, so a second
    // line elsewhere in shot cannot be mistaken for this line's branch.
    const stemX = prevX !== null ? prevX : (anchor !== null ? anchor : W / 2);
    const stemW = prevW !== null ? prevW : (lastW > 0 ? lastW : 0);
    const cx = Math.round(stemX);
    // A column counts as paint when it is line-COLOURED, blue and orange
    // added together, rather than when it is one stripe or the other. On the
    // line that changes nothing — the middle of it is solid orange. On the
    // branch it changes everything: the branch runs across the picture, so its
    // three stripes stack up the frame rather than across it, and a band that
    // lands on the seam between two of them is half blue and half orange and
    // would fail both halves of the test while sitting squarely on the paint.
    const lit = (x) => oCol[x] + bCol[x] >= need;
    // No stem width means no yardstick, and half a minimum width is a guess
    // that turns every wide patch into a junction. Refuse instead: one frame
    // without a lock costs nothing, and JUNC_VOTES needs two anyway.
    if (stemW > 0 && cx >= xLo && cx < xHi && lit(cx)) {
      let ja = cx, jz = cx;
      while (ja > xLo && lit(ja - 1)) ja--;
      while (jz + 1 < xHi && lit(jz + 1)) jz++;
      const span = jz - ja + 1;
      if (span >= stemW * JUNC_WIDE) {
        const y = (yA + yB) / 2;
        const need2 = stemW * JUNC_ARM;
        const lEdge = stemX - stemW / 2, rEdge = stemX + stemW / 2;
        // An arm counts when it is both long enough to be a branch and
        // striped like one. Probed half way along itself: at the line's own
        // edge the two are still touching, and at the far end a branch has
        // usually run out of frame.
        const armL = lEdge - ja >= need2 && juncArmIsLine((ja + lEdge) / 2, y, y0);
        const armR = jz - rEdge >= need2 && juncArmIsLine((jz + rEdge) / 2, y, y0);
        // Only bands with an arm are kept, so that the pick below is the
        // nearest band that showed a BRANCH rather than the nearest band that
        // merely looked wide. A branch is a couple of bands tall, and its
        // bottom edge — where the stripes are cut off by the band and the
        // cross-section cannot be read — is exactly the band that would
        // otherwise win and then report nothing.
        if (armL || armR) crossings.push({
          band: b, y, span,
          left: armL,
          right: armR,
          // Same convention as a corner's: 0 at the top of the ROI, 1 under
          // the wheels. Bigger means nearer, which is what "now" looks like.
          dist: (y - y0) / Math.max(1, H - y0),
        });
      }
    }

    // Is this band over a QR code? Asked lazily — only a band that fails the
    // ordinary test needs the answer — and around where the line is.
    let occl = null;
    const occluded = () => (occl ??= qrLike(yA, yB, stemX, Math.max(stemW, W * 0.08)));
    // The line's width below this band, or last frame's: what a pair read
    // over a QR must match, since its gap alone no longer says "equal thirds".
    const yard = prevW !== null ? prevW : (lastW > 0 ? lastW : 0);

    // Every adjacent pair of blue stripes is a candidate line. Adjacent and
    // not every pair, because a third blue stripe between two others is
    // another line, not a wider one.
    const cands = [];
    for (let i = 0; i + 1 < runs.length; i++) {
      const p = runs[i], q = runs[i + 1];
      const gap = q.a - p.z;
      if (gap < 2) continue;
      const mean = (p.w + q.w) / 2;
      const ratio = gap / Math.max(1, mean);
      const total = q.z - p.a;
      if (ratio < GAP_LO) continue;                            // not equal thirds
      // Too wide a gap for equal thirds — unless a QR's paper has eaten into
      // both blues, in which case the pair is still the line's full width.
      let viaQr = false;
      if (ratio > GAP_HI) {
        if (!(ratio <= QR_GAP_HI && yard > 0 && total >= yard * 0.6
              && total <= yard * 1.6 && occluded())) continue;
        viaQr = true;
      }
      if (Math.max(p.w, q.w) > Math.min(p.w, q.w) * BLUE_RATIO) continue;
      if (total < minRun) continue;
      // Is the middle actually orange? Normally yes; over the QR code it is
      // white instead, and that is a line with a QR on it rather than not a
      // line — so this scores the candidate, it does not gate it.
      let oc = 0;
      for (let x = p.z; x < q.a; x++) if (oCol[x] >= need) oc++;
      cands.push({ x: (p.z + q.a) / 2, w: total, gap,
                   orange: oc / Math.max(1, gap), edges: 2, qr: viaQr });
    }

    // Nothing usable in this band. Over a QR code that is the code, not the
    // end of the line: step over the band and look above it. Never at a
    // crossing, which is a real shape the chain is right to stop at.
    const bridge = () => {
      if (skips >= QR_SKIP || !occluded()) return false;
      if (crossings.length && crossings[crossings.length - 1].band === b) return false;
      skips++;
      qrBands++;
      return true;
    };

    // Nothing paired up. One blue stripe with orange beside it is still the
    // line seen with one edge out of shot — worth having, but only when there
    // is nothing better, exactly as scan() prefers a two-sided corridor.
    if (!cands.length) {
      for (const r of runs) {
        for (const dir of [-1, 1]) {
          const a = dir < 0 ? Math.max(xLo, r.a - Math.round(r.w * GAP_HI)) : r.z;
          const z = dir < 0 ? r.a : Math.min(xHi, r.z + Math.round(r.w * GAP_HI));
          let oc = 0;
          for (let x = a; x < z; x++) if (oCol[x] >= need) oc++;
          if (z - a < 2 || oc / (z - a) < 0.5) continue;
          // The centre is half a stripe past the orange, on the far side from
          // the blue we can see — the stripe we cannot see is that wide too.
          const oMid = (a + z) / 2;
          cands.push({ x: oMid, w: r.w * 3, gap: z - a,
                       orange: oc / (z - a), edges: 1 });
        }
      }
    }

    const both = cands.filter(c => c.edges === 2);
    const pool = both.length ? both : cands;
    if (!pool.length) { if (bridge()) continue; break; }

    let pick = null;
    if (prevX === null) {
      const near = anchor === null ? []
        : pool.filter(c => Math.abs(c.x - anchor) <= maxJump * 2);
      const from = near.length ? near : pool;
      if (!near.length && anchor !== null) relocked = true;
      pick = from.reduce((a, c) => (c.w > a.w ? c : a));
    } else {
      // A band stepped over is a band the line was allowed to drift in.
      const ok = pool.filter(c => Math.abs(c.x - prevX) <= maxJump * (1 + skips)
                                && c.w <= prevW * 1.6 + minRun);
      if (!ok.length) { if (bridge()) continue; break; }
      pick = ok.reduce((a, c) => (Math.abs(c.x - prevX) < Math.abs(a.x - prevX) ? c : a));
    }
    skips = 0;
    if (pick.qr) qrBands++;

    bands.push({ yA, yB, xLo, xHi, mid: 0, contrast: 0 });
    pts.push({ x: pick.x, y: (yA + yB) / 2, w: pick.w, band: b });
    if (pick.orange >= 0.5) confirmed++;
    prevX = pick.x;
    prevW = pick.w;
    lastBand = b;
    endedAt = yA;
  }

  // Where the painted line STOPS.
  //
  // This is the shape of the competition track, and it is not a fault. The
  // rules paint a line only inside the station areas — 2.7 m at a pickup or
  // drop-off, 3.4 m at the start — with a QR code at its end and nothing at
  // all in between. So a chain that dies part way up the picture, on a track
  // whose colour the detector is otherwise seeing perfectly well, is the robot
  // arriving at the end of its stub: the thing it is driving TOWARD, not the
  // thing that has gone wrong.
  //
  // Reported only when the chain both started and stopped inside the frame:
  // one that runs off the top has not ended, it has left the picture, and a
  // robot that stops for that stops in the middle of the line.
  const ended = pts.length >= 2 && lastBand < cfg.bands - 1;
  const end = ended
    ? { y: endedAt, band: lastBand,
        // Where up the picture the line ran out, on a corner's scale: 0 at the
        // top of the ROI, 1 under the wheels. This is the "how close am I to
        // the end" number, and bigger means closer.
        dist: (endedAt - y0) / Math.max(1, H - y0) }
    : null;

  // The junction, if there is one: the nearest band that showed a branch.
  //
  // The nearest and not the clearest, because this number is going to be
  // compared against a distance driven. A junction seen in two bands at once
  // is one junction, and the one under the wheels is the one the rover is
  // about to be standing on.
  //
  // A crossing that reaches both ways is reported as such rather than being
  // resolved into a side. It is a real shape on this field — J1 is a
  // crossroads, with A1 ahead, the start behind and the main line off to the
  // east — and which arm to take there is the plan's business, not the
  // detector's.
  const cross = crossings.length
    ? crossings.reduce((a, c) => (c.dist > a.dist ? c : a))
    : null;
  const junction = cross
    ? { band: cross.band, y: cross.y, dist: cross.dist, span: cross.span,
        left: cross.left, right: cross.right,
        side: cross.left && cross.right ? 'both' : (cross.left ? 'left' : 'right') }
    : null;

  return { pts, confirmed, relocked, bands, contrast0: chroma0 * 100,
           corner: null, end, junction, qrBands };
}

/**
 * One interpretation of the frame, scanned bottom-up.
 *
 * The road is found by its EDGES, not by its colour. Each band builds a
 * brightness profile across its own columns, splits that profile where it
 * separates best, and then only accepts a run whose border is a real step — a
 * jump of at least `cfg.edge` levels over a handful of columns, in the
 * direction the mode expects: brighter outside a dark road, brighter inside a
 * white one.
 *
 * That is the difference between a line and a region, and it is what a single
 * frame-wide threshold cannot tell you. On a dark floor Otsu still has to
 * return a split — it splits noise if there is nothing else — and everything
 * below it then reads as "road", which is how an unlit corner of a room ends
 * up being followed as though it were the line. A region has no step at its
 * border, so here it is simply not a candidate: the band reports nothing and
 * the robot is told it lost the road, which is the truth.
 *
 * The band's own split also means a shadow no longer matters. A frame-wide
 * threshold has to be right for the bright half and the dark half of the
 * picture at once; a per-band one only has to be right for that band, so a
 * line crossing a shadow keeps being found as long as it is still darker than
 * the floor beside it.
 *
 * Pure with respect to the temporal lock: it reads `anchor` but writes
 * nothing, so `auto` can run it twice — once per mode — and compare, without
 * the speculative run poisoning the state of the one that wins.
 */
function scan(mode, y0, anchor, anchorW = 0) {
  const bandH = Math.max(1, Math.floor((H - y0) / cfg.bands));
  const minRun = Math.max(2, Math.floor(W * cfg.minw));
  const maxJump = Math.max(4, W * cfg.jump);
  // 'white' looks for a bright strip, 'dark' for a dark corridor. Everything
  // below is written once and flipped by this one flag.
  const wantBright = mode === 'white';
  const pts = [];
  // What each band decided, kept for the mask overlay: the mask has to show
  // the split the scan actually used, or tuning against it is guesswork.
  const bands = [];
  let confirmed = 0, contrast0 = 0;
  // The lowest — i.e. nearest — 90° corner this reading of the frame found.
  // Lowest and not best, because the one about to arrive under the wheels is
  // the one being driven into; a second corner further up the picture is next
  // lap's problem.
  let corner = null;

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
    const span = xHi - xLo;
    const rows = yB - yA;
    if (span < minRun) break;

    // The band's brightness profile: one number per column, averaged down the
    // band. Averaging IS the noise filter — a thin horizontal glint moves a
    // column's mean by a fraction of its height — and it is what makes the
    // step at a real edge measurable instead of a per-pixel coin toss.
    for (let x = xLo; x < xHi; x++) { prof[x] = 0; clean[x] = 0; }
    for (let y = yA; y < yB; y++) {
      const off = y * W;
      for (let x = xLo; x < xHi; x++) {
        prof[x] += luma[off + x];
        clean[x] += white[off + x];
      }
    }
    for (let x = xLo; x < xHi; x++) {
      let s = 0, n = 0;
      for (let q = Math.max(xLo, x - SMOOTH); q < Math.min(xHi, x + SMOOTH + 1); q++) {
        s += prof[q]; n++;
      }
      sm[x] = s / (n * rows);
    }

    // Which columns get a say. Colourless ones only — a big coloured object
    // would otherwise set the band's range and drag its split with it, the
    // same reason the frame histogram is saturation-gated. If a band has
    // almost no colourless columns (a strongly tinted floor) there is nothing
    // to be gained by ignoring most of it, so fall back to all of them.
    const half = rows * 0.5;
    let nClean = 0;
    for (let x = xLo; x < xHi; x++) if (clean[x] >= half) nClean++;
    const gated = nClean >= minRun;

    bhist.fill(0);
    let lo = 255, hi = 0, n = 0;
    for (let x = xLo; x < xHi; x++) {
      if (gated && clean[x] < half) continue;
      const v = sm[x] < 0 ? 0 : sm[x] > 255 ? 255 : Math.round(sm[x]);
      bhist[v]++; n++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }

    // Nothing in this band is as bright-against-dark as a line has to be, so
    // there is no line in it — whatever a threshold would happily carve out of
    // the noise. This is the gate that stops an unlit corner of the room from
    // being followed: a dark REGION has a flat profile, a dark LINE does not.
    const contrast = hi - lo;
    if (b === 0) contrast0 = contrast;
    if (contrast < Math.max(1, cfg.edge)) break;

    // Split the band where its own profile separates best. Otsu rather than
    // the midpoint of lo..hi, for the same reason it is used on the frame: one
    // specular highlight is enough to drag a midpoint clean past the floor,
    // and then the road and the floor land on the same side of it. `bias`
    // still nudges the result, exactly as it nudged the frame-wide threshold.
    const mid = otsu(n, bhist) + cfg.bias;
    bands.push({ yA, yB, xLo, xHi, mid, contrast });

    const mean = (a, z) => {
      let t = 0;
      for (let x = a; x < z; x++) t += sm[x];
      return t / Math.max(1, z - a);
    };

    const runs = [];
    let start = -1;
    for (let x = xLo; x <= xHi; x++) {
      if (x < xHi && (sm[x] >= mid) === wantBright) { if (start < 0) start = x; continue; }
      if (start < 0) continue;
      const end = x, w = end - start;
      if (w >= minRun) {
        // Is each border a real step, or just where the split happened to
        // fall? A road leaving the view has one real border and one that is
        // the frame edge, which is why one is enough to be accepted — but a
        // run with NO real border is the whole strip, i.e. the failure this
        // gate exists for, and is dropped however wide and confident it looks.
        let realL = false, realR = false;
        if (start > xLo) {
          const out = mean(Math.max(xLo, start - EDGE_K), start);
          const inn = mean(start, Math.min(end, start + EDGE_K));
          realL = (wantBright ? inn - out : out - inn) >= cfg.edge;
        }
        if (end < xHi) {
          const out = mean(end, Math.min(xHi, end + EDGE_K));
          const inn = mean(Math.max(start, end - EDGE_K), end);
          realR = (wantBright ? inn - out : out - inn) >= cfg.edge;
        }
        if (realL || realR) {
          runs.push({ x: start + w / 2, w, a: start, z: end,
                      wide: w > span * MAX_RUN,
                      edges: (realL ? 1 : 0) + (realR ? 1 : 0), solid: realL && realR });
        }
      }
      start = -1;
    }

    // ── the 90° corner ───────────────────────────────────────────────
    // A bend is the road moving sideways band by band; a corner is the road
    // *ending* and another one leaving from its side. In the picture that is
    // an L: the band still contains the road below it — same connected thing —
    // but instead of being a strip of about the same width it sticks out to
    // ONE side by more than the road is wide. That overhang is the corner's
    // arm, and the side it lies on is the way the road goes.
    //
    // Read here rather than from the chain, because the chain cannot carry it:
    // the arm is exactly what the "no more than ~1.6× wider" rule below throws
    // out, and above the corner there is no road at all, so by the time the
    // pilot sees the chain the corner has become plain "yol görünmüyor". The
    // asymmetry is the whole test — a road that widens evenly (perspective, a
    // start pad, a threshold that slipped) grows on both sides at once and is
    // not a corner, however wide it gets.
    if (corner === null) {
      // What the arm has to stick out FROM, and how wide that is. Above the
      // bottom band both come from the run already accepted below; in the
      // bottom band — where a corner arrives — they come from the last frame,
      // because the road under the wheels does not move much in 30 ms.
      //
      // Falling back to the run's own width when there is no history is not a
      // guess, it is a refusal: an arm cannot stick out past itself by more
      // than its own width, so the test simply never fires on the first frame
      // after a lock is lost. Anything cheaper — half a minimum width, say —
      // makes every road the robot is not exactly centred on into a corner.
      const stemX = prevX === null ? (anchor === null ? W / 2 : anchor) : prevX;
      for (const r of runs) {
        if (r.a > stemX || r.z < stemX) continue;   // not the road we are on
        const stemW = prevW !== null ? prevW : (anchorW > 0 ? anchorW : r.w);
        const ovL = stemX - r.a, ovR = r.z - stemX;
        const long = Math.max(ovL, ovR), short = Math.min(ovL, ovR);
        if (long - short < cfg.arm * stemW + minRun) continue;
        const y = (yA + yB) / 2;
        corner = {
          dir: ovR > ovL ? 1 : -1,                  // +1 right, −1 left
          band: b,
          y,
          over: (long - short) / W,                 // how pronounced the L is
          // How far down the frame it sits: 0 at the top of the ROI, 1 under
          // the wheels. This is the number that says "now", and it is what the
          // pilot waits for before committing to the turn.
          dist: (y - y0) / Math.max(1, H - y0),
        };
        break;
      }
    }

    // Runs that fill the strip are evidence, not roads — see MAX_RUN. Prefer
    // a run with a real border on BOTH sides: that is a strip, which is what
    // we came for. Only fall back to one-sided runs if this band has nothing
    // better.
    let pool = runs.filter(r => !r.wide);
    const both = pool.filter(r => r.edges === 2);
    if (both.length) pool = both;
    if (!pool.length) break;          // the road ended; stop climbing

    let pick = null;
    if (prevX === null) {
      // Bottom band. Prefer the run nearest where the road was last frame —
      // that is what stops a bright patch sliding through and stealing the
      // lock. With no lock yet, take the widest.
      const near = anchor === null ? []
        : pool.filter(r => Math.abs(r.x - anchor) <= maxJump * 2);
      const from = near.length ? near : pool;
      if (!near.length && anchor !== null) relocked = true;
      pick = from.reduce((a, r) => (r.w > a.w ? r : a));
    } else {
      // Higher bands must continue the one below: close in x, and not wildly
      // wider — perspective means the road narrows with distance, never
      // suddenly balloons.
      const ok = pool.filter(r => Math.abs(r.x - prevX) <= maxJump
                                && r.w <= prevW * 1.6 + minRun);
      if (!ok.length) break;
      pick = ok.reduce((a, r) => (Math.abs(r.x - prevX) < Math.abs(a.x - prevX) ? r : a));
    }

    pts.push({ x: pick.x, y: (yA + yB) / 2, w: pick.w, band: b });
    if (pick.solid) confirmed++;
    prevX = pick.x;
    prevW = pick.w;
  }

  return { pts, confirmed, relocked, bands, contrast0, corner };
}

function detect(data) {
  const y0 = Math.floor(H * cfg.roi);
  const area = (H - y0) * W;
  hist.fill(0);
  histAll.fill(0);
  buildContrastLUT();

  // One pass: luma, "is it colourless", and the histogram for Otsu.
  let gated = 0;
  for (let y = y0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const v = clut[(r * 77 + g * 151 + b * 28) >> 8];
      luma[p] = v;
      // White means bright AND colourless. The saturation gate is what keeps
      // a yellow board or a sunlit wooden floor out of the mask.
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const chroma = mx - mn;
      const colourless = chroma <= cfg.sat;
      white[p] = colourless ? 1 : 0;

      // The line's two colours, by hue. Only worth asking of a pixel with real
      // colour in it: at low chroma the hue angle is the ratio of two small
      // noisy numbers and will happily report any hue at all, which on a grey
      // floor means a scatter of false orange and false blue in every band.
      let isO = 0, isB = 0;
      if (chroma >= cfg.chroma) {
        let h;
        if (mx === r)      h = 60 * (((g - b) / chroma) % 6);
        else if (mx === g) h = 60 * (((b - r) / chroma) + 2);
        else               h = 60 * (((r - g) / chroma) + 4);
        if (h < 0) h += 360;
        if (hueOff(h, HUE_ORANGE) <= cfg.hueTol) isO = 1;
        else if (hueOff(h, HUE_BLUE) <= cfg.hueTol) isB = 1;
      }
      orange[p] = isO;
      blue[p] = isB;
      // `histAll` gets every pixel, `hist` only the colourless ones. Letting a
      // big coloured object into `hist` drags Otsu's split away from where
      // the road actually is — a bright yellow board pulled the threshold
      // down to the floor level and turned the entire frame into "road".
      histAll[v]++;
      if (colourless) { hist[v]++; gated++; }
    }
  }

  // Too few colourless pixels for `hist`'s split to mean anything — typically
  // a floor with enough tint to fail the saturation gate everywhere. Otsu on
  // `histAll` still finds the real line/floor gap; a fixed fallback threshold
  // could not, because it knows nothing about this frame's actual lighting.
  let thr = (gated > area * 0.02 ? otsu(gated) : otsu(area, histAll)) + cfg.bias;
  thr = thr < 0 ? 0 : thr > 255 ? 255 : thr;

  // Which kind of track is this? In auto, run BOTH readings of the frame and
  // let them compete — "which interpretation actually finds a road" is a
  // second opinion that owes nothing to the brightness probe.
  let mode = cfg.mode, out;
  if (cfg.mode === 'line') {
    autoWhy = null;
    out = scanLine(y0, lastNear);
  } else if (cfg.mode === 'auto') {
    // The competition line gets asked first, and wins outright when it is
    // there. That is not favouritism, it is that the question has a definite
    // answer: two blue stripes with an orange one between them, at the right
    // proportions, is not something a workshop floor produces by accident. So
    // there is nothing to weigh against it — where the monochrome readings
    // have to argue with each other about which of two guesses is less wrong,
    // this one either found the line or did not.
    const ln = scanLine(y0, lastNear);
    if (quality(ln) >= 2.5) {
      autoWhy = null;
      autoMode = mode = 'line';
      autoSeen = true;
      out = ln;
    } else {
      const dark = scan('dark',  y0, lastNear, lastW);
      const wht  = scan('white', y0, lastNear, lastW);
      // A mode locked onto 'line' by a run that has since driven off the paint
      // must not be answered with 'line' for ever — the gaps between stations
      // have no line in them at all. Fall back to whichever monochrome reading
      // the frame supports, and let decide() carry on as it always did.
      if (autoMode === 'line') autoMode = quality(wht) > quality(dark) ? 'white' : 'dark';
      decide(thr, y0, dark, wht);
      mode = autoMode;
      out = mode === 'dark' ? dark : wht;
    }
  } else {
    autoWhy = null;
    out = scan(mode, y0, lastNear, lastW);
  }
  const pts = out.pts;

  // Only trust the lock once a couple of bands agree — a single band is just
  // a bright patch.
  //
  // The exception is a corner that has arrived at the wheels. Its arm is then
  // the widest thing in the bottom band and the chain locks on to it, which
  // drags the lock sideways onto the arm's middle — and the corner test, which
  // measures the arm's overhang FROM the lock, promptly stops seeing anything
  // lopsided at all: the L disappears from the report at exactly the moment
  // the robot is standing on it. So while the arm is under the wheels the mark
  // is held where it was, and held without ageing, because the road has not
  // been lost — it is right there, turning.
  const armAtWheels = !!(out.corner && out.corner.band === 0);
  if (armAtWheels) lockAge = 0;
  else if (pts.length >= 2) { lastNear = pts[0].x; lastW = pts[0].w; lockAge = 0; }
  else if (++lockAge > 15) { lastNear = null; lastW = 0; }   // lost ~0.5 s: forget

  // The corner has to say the same thing two frames running before it is
  // reported at all. Reported means "there is an L in front of the robot and
  // it points this way", nothing more: whether that is worth turning for, and
  // whether it is still worth turning for once the road has gone, is the
  // pilot's to decide — see the corner block in pilotStep().
  const c = out.corner;
  if (c && c.dir === cornerDir) cornerVote++;
  else { cornerDir = c ? c.dir : 0; cornerVote = c ? 1 : 0; }
  const corner = c && cornerVote >= CORNER_VOTES ? c : null;

  // Same again for the end of the paint — see the `end` note in scanLine().
  endVote = out.end ? endVote + 1 : 0;
  const end = out.end && endVote >= END_VOTES ? out.end : null;

  // And for the junction. The vote is on the SIDE, not on there being one at
  // all: a strip of light lying across the line is a crossing for one frame
  // and the pallet beside it is a crossing the next, and a counter that took
  // those two as agreement would count a junction that is not there. Two
  // frames saying "there is a branch on the left" is a branch on the left.
  const j = out.junction;
  if (j && j.side === juncSide) juncVote++;
  else { juncSide = j ? j.side : ''; juncVote = j ? 1 : 0; }
  const junction = j && juncVote >= JUNC_VOTES ? j : null;

  // `contrast` is what the band in front of the wheels actually measured
  // between its brightest and darkest columns. It is the number to compare
  // `cfg.edge` against when nothing is being found — the pages print it, so
  // "there is no line here" and "the line is there but the bar is set too
  // high" stop looking the same from the outside.
  // `qrBands`: how many bands were read over a QR code (see QR_GAP_HI) — the
  // pages show it, so "the line was found through the code" is visible.
  return { thr, y0, pts, relocked: out.relocked, mode, corner, end, junction,
           bands: out.bands, contrast: Math.round(out.contrast0),
           qrBands: out.qrBands || 0 };
}

/**
 * Paint the mask overlay: what the scan classified, not what a frame-wide
 * threshold would have.
 *
 * Lives here rather than on the pages because it has to agree with scan() by
 * construction — a mask drawn from a different rule than the detector uses is
 * worse than no mask, since it sends you off tuning the wrong slider. Green is
 * always "road" in either mode; the dimmed areas are the ones no band looked
 * at (above the ROI, or cut off by the trapezoid gate).
 */
function roadPaintMask(data, res) {
  // 'line' mode classified by colour, not by a per-band split, so the mask is
  // painted straight from the two colour masks. Green is "road" here as
  // everywhere else — the orange middle, which is what the robot steers by —
  // and the blue stripes are drawn in blue, because seeing WHICH of the two
  // the detector lost is the whole diagnostic: one missing blue stripe is a
  // camera aimed off the line, both missing is a colour bar set too high.
  if (res.mode === 'line') {
    for (let y = res.y0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x, i = p * 4;
        if (orange[p])      { data[i] = 40;  data[i + 1] = 220; data[i + 2] = 90; }
        else if (blue[p])   { data[i] = 60;  data[i + 1] = 120; data[i + 2] = 230; }
        else {
          // Everything else, dimmed to its own brightness so the QR code, the
          // yellow box tape and the floor stay distinguishable from each other.
          const v = luma[p] >> 1;
          data[i] = v; data[i + 1] = v + 4; data[i + 2] = v + 10;
        }
      }
    }
    return;
  }
  const wantBright = res.mode === 'white';
  for (let y = res.y0; y < H; y++) {
    let bd = null;
    for (const q of res.bands) if (y >= q.yA && y < q.yB) { bd = q; break; }
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      const seen = !!bd && x >= bd.xLo && x < bd.xHi;
      const bright = luma[p] >= (seen ? bd.mid : res.thr);
      if (seen && bright === wantBright) {
        data[i] = 40; data[i + 1] = 220; data[i + 2] = 90;
      } else if (!seen) {
        const v = bright ? 96 : 30;
        data[i] = v; data[i + 1] = v + 4; data[i + 2] = v + 10;
      } else if (bright) {
        data[i] = 210; data[i + 1] = 210; data[i + 2] = 210;
      } else {
        data[i] = 12; data[i + 1] = 14; data[i + 2] = 18;
      }
    }
  }
}

// ── mode switching ──────────────────────────────────────────────────
// The pages own their own buttons; this is the part that has to happen
// whichever page you are on. Both /vision and /follow define a setMode() that
// updates their UI and then calls this.
function roadSetMode(m) {
  cfg.mode = m;
  endVote = 0;                        // a half-counted line end means nothing here
  autoSeen = false;                   // re-lock instantly on the next frame
  autoVotes = 0;
  lastNear = null; lastW = 0;         // the lock means nothing across modes
  cornerDir = 0; cornerVote = 0;      // nor does half a corner's worth of votes
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
//   near   — the band right in front of the wheels: where the robot IS wrong
//   far    — the mean of the upper half of the chain: where the road IS GOING
//   corner — the 90° turn ahead, or null: where the road STOPS going
//   end    — where the painted line RUNS OUT, or null. On the competition
//            track that is a station's QR code arriving, not a failure
//   junction — the branch ahead and which side it leaves on, or null: where
//            the road SPLITS. Only 'line' mode reports it, because only the
//            competition track has any
//
// A pilot needs the first three: near to correct, far to slow down before the
// bend rather than in the middle of it, and the corner because no amount of
// either gets a robot round a right angle. The fourth is not for the pilot at
// all — a junction is not a steering problem, it is a *which one is this*
// problem, and answering that needs the map. mission.js is where it goes.
//
// All of them are passed through untouched: the detector owns what each looks
// like, whoever reads it owns what to do about it, and this function is only
// the wire between them.
function roadError(res) {
  const half = W / 2;
  const corner = res.corner || null;
  const end = res.end || null;
  const junction = res.junction || null;
  const near = res.pts[0];
  if (!near) return { near: null, far: null, bands: res.pts.length, corner, end, junction };
  const up = res.pts.filter(p => p.band >= Math.floor(cfg.bands / 2));
  return {
    near: (near.x - half) / half,
    far: up.length
      ? up.reduce((a, p) => a + (p.x - half) / half, 0) / up.length
      : (near.x - half) / half,
    bands: res.pts.length,
    corner,
    end,
    junction,
  };
}
