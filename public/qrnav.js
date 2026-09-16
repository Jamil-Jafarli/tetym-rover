/**
 * Where the rover is on the field, from the QR codes — and which way it turns
 * at the junction ahead.
 *
 * Pure, like field.js and mission.js: no DOM, no clock of its own. The server
 * localises with it (nav.js), /dashboard draws it, and test/test_qrnav.mjs
 * runs it in node with no hardware. Loaded AFTER field.js — everything about
 * the field itself (the nodes, the edges, where each code stands, bearings,
 * the planner) is field.js's, and this file has no second copy of any of it.
 *
 * ── How it differs from mission.js ──────────────────────────────────
 *
 * mission.js runs the map run on /follow: it counts junctions with the camera
 * and anchors the pose at each one. That needs /follow open and armed. This is
 * the other half, and it needs neither: the QR reader runs on the server
 * whether or not a page is open, and every code it reads is bolted to a known
 * place. So reading q5 is not "a code was read 12.4 m into the run", it is
 * "the rover is on the J3 → KAPI leg, 1.61 m east of J3". That is a
 * measurement. Between two codes it is dead reckoning again — the wheel
 * millimetres that went down the wire — but dead reckoning that is thrown away
 * and replaced by the truth at every code.
 *
 * Three things are done with it:
 *
 *   1. localise   a QR text  → which leg the rover is on, and which way along it
 *   2. plan       stops      → the nodes to drive through (field.js's planner)
 *   3. instruct   the plan   → what to do at the node ahead: left, right, on
 *
 * ── Two frames ──────────────────────────────────────────────────────
 *
 * The odometer (navOdo*) integrates in its own frame, which starts at 0,0
 * pointing at bearing 0 whenever it was last reset — it has no idea where on
 * the field that was. The field frame is field.js's: metres, +x east, +y
 * north, compass bearings. A QR read joins the two: it records the field pose
 * AND the odometer pose at the same instant (the anchor), and every later
 * odometer reading is rotated into the field by the difference of the two
 * bearings. Both the drift and the arbitrary starting heading cancel at every
 * read.
 *
 * Ported from the ESP32 rover's field.js onto this repo's measured field.
 */

const NAV_STRAIGHT_DEG = 25;   // less of a turn than this and it is "carry on"
const NAV_BACK_DEG = 150;      // more than this and it is a U-turn, not a turn
// Reading the same code again after moving less than this is the same sighting
// of the same sign, not a second pass. See navSee() for what hangs on it.
const NAV_SAME_M = 0.5;
const NAV_TURN_LABEL = {
  left: 'sola dön', right: 'sağa dön', straight: 'düz devam et', back: 'geri dön',
};
const NAV_MARKS_MAX = 60;

const navRound = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

// ── the codes ────────────────────────────────────────────────────────

/**
 * Text folded the way qr.js's qrKey() folds it — case, spaces, dashes and the
 * Turkish dotted/dotless I — plus Ş/Ç/Ğ/Ö/Ü to their plain letters, because
 * "BAŞLA" and "BASLA" are one sign to a person holding it.
 */
function navFold(text) {
  return String(text == null ? '' : text)
    .replace(/[İIıi]/g, 'I')
    .replace(/[Şş]/g, 'S').replace(/[Çç]/g, 'C').replace(/[Ğğ]/g, 'G')
    .replace(/[Öö]/g, 'O').replace(/[Üü]/g, 'U')
    .toUpperCase()
    .replace(/[\s_\-.]+/g, '');
}

/**
 * The code on a QR, reduced to the id this field knows it by — 'q1'..'q9' —
 * or null.
 *
 * Two spellings are accepted:
 *
 *   - the text the şartname prints on each code (FIELD_EDGES' `text`): BASLA,
 *     ALIM1..3, KAPI1..2, BIRAK1..3 — the whole string, folded, and nothing
 *     else in it. These are the codes that will actually be on the floor.
 *   - the field's own id: "q5", "Q5", "qr5", "qr/5" at the end of a URL, or a
 *     string that is nothing but the number.
 *
 * The q is not decoration, it is the whole safety margin. A field has other
 * codes on it — a pallet label, somebody's stock sticker — and "any string
 * ending in a digit is a waypoint" reads `kargo-9` as q9 and puts the rover at
 * the far end of the arena with total confidence. A wrong fix is far worse
 * than no fix, so everything else is a stray.
 */
function navQrId(text, map) {
  const m = map || FIELD;
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  const key = navFold(s);
  const printed = m.edges.find((e) => e.qr && e.text && navFold(e.text) === key);
  if (printed) return printed.qr;
  // q, optionally the r of "qr", optionally a separator, then the number — and
  // the q may not be the tail of a longer word.
  const tagged = s.match(/(?:^|[^a-z0-9])q(?:r)?[-_/ ]?(\d{1,2})(?![0-9])/i);
  const bare = s.match(/^(\d{1,2})$/);
  const n = tagged ? tagged[1] : bare ? bare[1] : null;
  if (n === null) return null;
  const id = `q${Number(n)}`;
  return m.edges.some((e) => e.qr === id) ? id : null;
}

/**
 * Where a code stands, and the leg it stands on: {qr, text, a, b, x, y} or
 * null. From the edge's `s` — metres from `a` — so a code cannot be drawn in
 * one place and localised to another.
 */
function navQr(qrId, map) {
  const m = map || FIELD;
  const e = m.edges.find((x) => x.qr === qrId);
  if (!e) return null;
  const a = fieldNode(e.a, m), b = fieldNode(e.b, m);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const t = len > 0 ? Math.max(0, Math.min(1, (Number(e.s) || 0) / len)) : 0;
  return {
    qr: qrId, text: e.text || null, a: e.a, b: e.b,
    x: navRound(a.x + (b.x - a.x) * t),
    y: navRound(a.y + (b.y - a.y) * t),
  };
}

/** Every code on the field, in the order the field lists them. */
function navQrs(map) {
  const m = map || FIELD;
  return m.edges.filter((e) => e.qr).map((e) => navQr(e.qr, m));
}

// ── turns and plans ──────────────────────────────────────────────────

/**
 * What the rover does at a node: arrive on one bearing, leave on another.
 * field.js's fieldTurn() is the one place the sign convention lives
 * (positive = right); this only puts a word on it, with a dead band so a
 * tape-measured field does not produce "sağa 4°".
 */
function navTurn(inBearing, outBearing) {
  if (inBearing == null || outBearing == null) return null;
  const d = fieldTurn(inBearing, outBearing);
  const mag = Math.abs(d);
  const dir = mag >= NAV_BACK_DEG ? 'back'
            : mag <= NAV_STRAIGHT_DEG ? 'straight'
            : d > 0 ? 'right' : 'left';
  return { deg: navRound(d, 1), dir, label: NAV_TURN_LABEL[dir] };
}

/**
 * A whole mission: from here, call at each stop in turn — ['A2', 'B3'].
 *
 * field.js plans one hop; this joins the hops without repeating the node they
 * share. A stop that cannot be reached truncates the plan and says so, rather
 * than being dropped silently.
 */
function navPlan(from, targets, map) {
  const m = map || FIELD;
  const stops = (Array.isArray(targets) ? targets : [targets])
    .map((t) => String(t || '').toUpperCase()).filter(Boolean);
  let at = String(from || '').toUpperCase();
  if (!fieldNode(at, m)) return { nodes: [], stops, ok: false, reason: 'başlangıç düğümü tanınmıyor' };
  const nodes = [at];
  for (const t of stops) {
    const hop = fieldPlan(at, t, m);
    if (hop.length === 0) return { nodes, stops, ok: false, reason: `${t} için yol yok` };
    nodes.push(...hop.slice(1));
    at = t;
  }
  return { nodes, stops, ok: true, reason: null };
}

/**
 * The plan, spelled out leg by leg: drive this far, then turn that way. The
 * turn is attached to the node the rover ARRIVES at, because that is when the
 * instruction is needed and the code announcing it is the one on this leg.
 */
function navLegs(nodes, map) {
  const m = map || FIELD;
  const ns = Array.isArray(nodes) ? nodes : [];
  const out = [];
  for (let i = 0; i + 1 < ns.length; i++) {
    const from = ns[i], to = ns[i + 1], next = ns[i + 2] || null;
    const e = m.edges.find((x) => (x.a === from && x.b === to) || (x.a === to && x.b === from));
    const bearing = fieldBearing(from, to, m);
    out.push({
      i, from, to, next,
      qr: e && e.qr ? e.qr : null,
      dist: fieldSpan(from, to, m),
      bearing,
      turn: next ? navTurn(bearing, fieldBearing(to, next, m)) : null,
      kind: (fieldNode(to, m) || {}).kind || null,
    });
  }
  return out;
}

// ── the odometer ─────────────────────────────────────────────────────

/**
 * Fresh odometer: 0,0, bearing 0, in its own frame. field.js's fieldState()
 * with no node, so fieldStep() — the exact-arc integrator mission.js uses —
 * can integrate it, plus a timestamp on every kept point: /dashboard draws
 * only the part of the trail since the last code, and needs to know which
 * part that is.
 */
function navOdoState(now = 0) {
  const od = fieldState(null, 0);
  od.path = [{ x: 0, y: 0, at: now }];
  od.marks = [];
  od.seq = 0;
  od.since = now;
  od.t = now;
  return od;
}

/**
 * One wheel move: millimetres per wheel, in the CAMERA's left/right — the
 * frame the pilot steers in and the one mission.js integrates. Same call as
 * fieldStep(), so both odometers agree on what a turn is.
 */
function navOdoStep(od, dLeftMm, dRightMm, now = 0, track) {
  const last = od.path[od.path.length - 1];
  fieldStep(od, dLeftMm, dRightMm, track);
  const kept = od.path[od.path.length - 1];
  if (kept !== last) { kept.at = now; od.seq++; }
  od.t = now;
  return od;
}

/** Pin something to where the odometer was when it happened. */
function navOdoMark(od, kind, text, now = 0) {
  const mark = { kind, text: text == null ? null : String(text).slice(0, 120),
                 x: navRound(od.x), y: navRound(od.y), at: now };
  od.marks.push(mark);
  while (od.marks.length > NAV_MARKS_MAX) od.marks.shift();
  return mark;
}

/** The odometer, as navSee() and navPose() want it: {x, y, bearing}. */
function navOdoPose(od) {
  return { x: od.x, y: od.y, bearing: od.h };
}

// ── where the rover is ───────────────────────────────────────────────

/** Fresh localisation state: nothing read, nothing planned, nothing known. */
function navState() {
  return {
    qr: null,          // the last code understood, e.g. 'q5'
    at: 0,             // when it was read
    from: null,        // the node the rover left
    to: null,          // the node it is driving towards
    sure: false,       // was the direction deduced, or guessed?
    seen: [],          // [{qr, at, from, to, onPlan}] — newest last
    stops: [],         // the mission as asked for
    plan: [],          // node ids, start to finish
    step: 0,           // index in plan of the node being driven towards
    onPlan: false,     // was the last code where the plan said it would be?
    // Set at every read: the field pose and the odometer pose at the same
    // instant, which is what lets one be expressed in the other's frame.
    anchor: null,
    unknown: null,     // the last code that meant nothing here
    reads: 0,          // codes understood since boot
    strays: 0,         // ...and codes that were not ours
  };
}

/**
 * A code was read. Work out which leg the rover is on and which way it is
 * going.
 *
 * A code names an edge, and an edge has two ends — reading q5 says the rover
 * is between J3 and the door, not whether it is coming or going. Decided, in
 * order:
 *
 *   1. the same code again, from more or less the same spot: one sign seen
 *      twice, nothing about the direction has changed. "More or less" is the
 *      odometer, hopeless at absolute position and perfectly good at "have we
 *      moved half a metre".
 *   2. continuity: the last code left the rover heading for a node, and this
 *      edge touches that node, so it drove through it and out the other side.
 *      This is what gets a turnaround right: coming back off A2 reads q3 again
 *      from the far side of the station.
 *   3. the plan, if this edge is one of its legs. Only reached on the first
 *      code of a run.
 *   4. failing all three, the edge as written, flagged `sure: false` — a
 *      position that is right and a heading that is a coin toss, said out
 *      loud rather than pretended.
 */
function navSee(st, text, now = 0, map = null, odo = null) {
  const m = map || FIELD;
  const qrId = navQrId(text, m);
  if (!qrId) {
    st.unknown = text == null ? null : String(text).slice(0, 120);
    st.strays++;
    return { ok: false, qr: null, reason: 'bu sahaya ait bir QR değil' };
  }
  const spot = navQr(qrId, m);

  let from = spot.a, to = spot.b, sure = false;
  if (st.qr === qrId && st.from && st.to && navMoved(st, odo) < NAV_SAME_M) {
    from = st.from; to = st.to; sure = st.sure;       // same sign, same spot
  } else if (st.to === spot.a || st.to === spot.b) {
    from = st.to; to = st.to === spot.a ? spot.b : spot.a; sure = true;
  } else {
    const i = navPlanIndex(st, spot);
    if (i >= 0) { from = st.plan[i]; to = st.plan[i + 1]; sure = true; }
  }

  const planIdx = navLegIndex(st, from, to);
  const bearing = fieldBearing(from, to, m);
  st.qr = qrId;
  st.at = now;
  st.from = from;
  st.to = to;
  st.sure = sure;
  st.reads++;
  st.unknown = null;
  st.onPlan = planIdx >= 0;
  if (planIdx >= 0) st.step = planIdx + 1;

  st.anchor = {
    x: spot.x, y: spot.y, bearing, at: now,
    rx: odo ? Number(odo.x) || 0 : null,
    ry: odo ? Number(odo.y) || 0 : null,
    rb: odo ? Number(odo.bearing) || 0 : null,
  };

  st.seen.push({ qr: qrId, text: spot.text, at: now, from, to, onPlan: st.onPlan });
  while (st.seen.length > 40) st.seen.shift();

  return { ok: true, qr: qrId, text: spot.text, from, to, x: spot.x, y: spot.y, bearing,
           sure, onPlan: st.onPlan, turn: navTurnAt(st, m) };
}

/** Where in the plan this edge is, either way round, or -1 — first code only. */
function navPlanIndex(st, spot) {
  const plan = st.plan || [];
  const hit = (i) => (plan[i] === spot.a && plan[i + 1] === spot.b)
                  || (plan[i] === spot.b && plan[i + 1] === spot.a);
  for (let i = Math.max(0, (st.step || 1) - 1); i + 1 < plan.length; i++) if (hit(i)) return i;
  for (let i = 0; i + 1 < plan.length; i++) if (hit(i)) return i;
  return -1;
}

/**
 * Where in the plan this DIRECTED leg is, or -1. Directed matters on a
 * mission that doubles back: …J2 → A2 → J2… has the same leg twice and only
 * the direction says which one the rover is on. Searched from the current
 * step forwards first, so the answer is the crossing still ahead.
 */
function navLegIndex(st, from, to) {
  const plan = st.plan || [];
  const hit = (i) => plan[i] === from && plan[i + 1] === to;
  for (let i = Math.max(0, (st.step || 1) - 1); i + 1 < plan.length; i++) if (hit(i)) return i;
  for (let i = 0; i + 1 < plan.length; i++) if (hit(i)) return i;
  return -1;
}

/**
 * How far the odometer says the rover has come since the last code. Zero with
 * nothing to compare, which reads as "it has not moved" and keeps the previous
 * direction — a heading that flips at every re-read is worse than a stale one.
 */
function navMoved(st, odo) {
  const a = st.anchor;
  if (!a || a.rx === null || !odo) return 0;
  return Math.hypot((Number(odo.x) || 0) - a.rx, (Number(odo.y) || 0) - a.ry);
}

/** The instruction for the node the rover is driving towards, or null. */
function navTurnAt(st, map) {
  const m = map || FIELD;
  if (!st.to) return null;
  const plan = st.plan || [];
  const i = st.step;
  if (plan[i] === st.to && plan[i + 1]) {
    return {
      node: st.to,
      ...navTurn(fieldBearing(st.from, st.to, m), fieldBearing(st.to, plan[i + 1], m)),
      then: plan[i + 1],
      dist: fieldSpan(st.from, st.to, m),
    };
  }
  if (plan[i] === st.to && plan.length && i === plan.length - 1) {
    return { node: st.to, deg: 0, dir: 'arrive', label: 'vardın — dur',
             then: null, dist: fieldSpan(st.from, st.to, m) };
  }
  return null;
}

/**
 * Set the mission, planned from where the rover is now: the node it is
 * heading for, because a mission given mid-run starts at the next junction,
 * not at the one already behind it.
 */
function navMission(st, targets, map, from = null) {
  const m = map || FIELD;
  const plan = navPlan(from || st.to || 'START', targets, m);
  st.stops = plan.stops;
  st.plan = plan.nodes;
  st.step = plan.nodes.length > 1 ? 1 : 0;
  st.onPlan = false;
  return plan;
}

/** Forget the mission; keep knowing where we are. */
function navClearMission(st) {
  st.stops = []; st.plan = []; st.step = 0; st.onPlan = false;
  return st;
}

/**
 * An odometer point, in field metres, through an anchor. The dashboard draws
 * the trail with this and navPose() places the rover with it, so the two
 * cannot disagree.
 */
function navToField(a, p) {
  const th = (a.bearing - a.rb) * Math.PI / 180;
  const dx = (Number(p.x) || 0) - a.rx, dy = (Number(p.y) || 0) - a.ry;
  const c = Math.cos(th), s = Math.sin(th);
  return { x: navRound(a.x + dx * c + dy * s), y: navRound(a.y + dy * c - dx * s) };
}

/**
 * Best estimate of the pose, right now: the anchor plus however far the
 * odometer has moved since, rotated into the field.
 *
 * With no anchor there is no answer. An unlocalised rover is not at the
 * origin of the field, it is somewhere, and drawing it on the start line
 * because nothing better is available is a lie the map tells confidently.
 */
function navPose(st, odo) {
  const a = st.anchor;
  if (!a) return { known: false, x: null, y: null, bearing: null, dead: null };
  if (!odo || a.rx === null) return { known: true, x: a.x, y: a.y, bearing: a.bearing, dead: 0 };
  const p = navToField(a, odo);
  const turned = (Number(odo.bearing) || 0) - a.rb;
  // Rounded before it is wrapped: -0.01° wraps to 359.99, which rounds to a
  // "360°" that no compass shows.
  const b = navRound(((a.bearing + turned) % 360 + 360) % 360, 1);
  return {
    known: true,
    x: p.x, y: p.y,
    bearing: b >= 360 ? b - 360 : b,
    // How much of this is measured and how much is reckoned: the distance the
    // odometer has come since the last code. Past a couple of metres, believe
    // the next QR more than the map.
    dead: navRound(Math.hypot((Number(odo.x) || 0) - a.rx, (Number(odo.y) || 0) - a.ry), 2),
  };
}

/** Everything a page or a log needs, in one object. */
function navStatus(st, odo, map) {
  const m = map || FIELD;
  const pose = navPose(st, odo);
  const legs = navLegs(st.plan, m);
  return {
    qr: st.qr,
    // What that code says (BASLA, KAPI1…) — what /plc and a person read.
    text: st.qr ? (navQr(st.qr, m) || {}).text || null : null,
    at: st.at || null,
    from: st.from,
    to: st.to,
    sure: st.sure,
    known: pose.known,
    pose,
    // The two frames side by side at the last code — the only thing that says
    // where odometer coordinates are on the field.
    anchor: st.anchor,
    turn: navTurnAt(st, m),
    plan: st.plan,
    stops: st.stops,
    step: st.step,
    on_plan: st.onPlan,
    legs,
    left: legs.slice(Math.max(0, st.step - 1)).map((l) => l.to),
    reads: st.reads,
    strays: st.strays,
    unknown: st.unknown,
    seen: st.seen.slice(-12),
  };
}
