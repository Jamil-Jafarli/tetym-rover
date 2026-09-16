/**
 * The competition field, and where the rover is on it.
 *
 * Pure, like road.js and pilot.js: no clock of its own, and no DOM beyond the
 * canvas context fieldDraw() is handed. /map draws it, /follow drives against
 * it, and test/test_field.mjs runs it in node with no hardware and no browser.
 *
 * The drawing lives here, with the data, for the same reason road.js is one
 * file: a picture drawn from a second copy of the coordinates is worse than no
 * picture, because it looks right while the rover drives somewhere else.
 *
 * ── Why a map at all ─────────────────────────────────────────────────
 *
 * road.js can follow a line and pilot.js can take a corner, and between them
 * that is enough to drive — but not enough to run the task. The task is "go to
 * A2", and A2 is not something you can see from the start: it is the second
 * branch on the left after the first junction. Telling those three branches
 * apart is the whole job, and it cannot be done by looking at one of them,
 * because they are identical. It is done by knowing where you are.
 *
 * So this file is the field written down — every wall, every metre of paint,
 * every station — and three things done with it:
 *
 *   1. plan     from where I am to where I am going, as a list of nodes
 *   2. turn     at the node ahead: left, right, or straight on
 *   3. reckon   how far I have driven since the last node I was sure of
 *
 * The camera says *a junction is here now*. The map says *which one it must
 * be*. Neither is much use alone: vision cannot count and dead reckoning
 * cannot see. mission.js is where the two are put together.
 *
 * ── The coordinate frame ─────────────────────────────────────────────
 *
 * Metres. +x is east (right on the şartname's Şekil 1), +y is north (up). The
 * origin is the inside of the south-west corner of the left hall, so the whole
 * field is 0 ≤ x ≤ 18, 0 ≤ y ≤ 10 and nothing is ever negative.
 *
 * Headings are compass bearings in degrees: 0 = north, 90 = east, clockwise
 * positive. That is not the same as the maths convention and it is chosen on
 * purpose — it is what a turn reads as. "Turn right 90°" adds 90.
 *
 * ── Where the numbers come from ──────────────────────────────────────
 *
 * 2026_SRU_EK_TEKNİK_SARTNAME, Şekil 1 (field and QR placement), Şekil 5
 * (start area) and Şekil 6 (pick and drop zones). Şekil 1 is dimensioned for
 * the building — 18 × 10 m, halls at 7.5 m and 9 m, the openings at 2.5 m and
 * 4.5 m — and drawn to scale for everything else, which is how the branch
 * positions below were recovered: they are measured off the drawing at the
 * scale its own dimensions fix (37.28 px/m), and they agree with Şekil 5 and
 * Şekil 6 to within a couple of centimetres wherever the two overlap.
 *
 * Trust order, when they disagree: a printed dimension beats the drawing, and
 * the drawing beats anything inferred here. Every value below says which it
 * is. If the real field is measured on the day and comes out different, this
 * table is the only thing to edit — the planner, the pose and /map all read
 * it and none of them has a second copy of a coordinate.
 */

// ── the building ─────────────────────────────────────────────────────

/**
 * The field itself: two halls with a 1.5 m corridor between them.
 *
 * The halls are dimensioned (0–7.5 m and 9–18 m of an 18 m span). Each hall
 * wall facing the corridor has a 3 m opening — Şekil 1 dimensions its edges as
 * 4.5 m down from the north wall and 2.5 m up from the south wall — and the
 * track runs through the middle of both.
 *
 * `gate` is the door the factory automation opens: a leaf standing in the
 * corridor, across the track, between the two openings. It is the reason KAPI1
 * and KAPI2 exist and the reason a run can be made to wait, so it is on the
 * map rather than being a fact about the rules.
 */
const FIELD_BUILDING = {
  w: 18, h: 10,                                    // dimensioned
  halls: [{ x0: 0, x1: 7.5 }, { x0: 9, x1: 18 }],  // dimensioned
  openings: [                                      // dimensioned (4.5 m / 2.5 m)
    { x: 7.5, y0: 2.5, y1: 5.5 },
    { x: 9.0, y0: 2.5, y1: 5.5 },
  ],
  gate: { x: 8.25, y0: 2.12, y1: 5.24 },           // scaled off Şekil 1
};

/**
 * The painted line, in cross-section.
 *
 * Three equal stripes, blue │ orange │ blue, in the colours road.js already
 * looks for — Şekil 5's and Şekil 6's own vector fills are rgb(52,101,164) and
 * rgb(255,128,0), which is where HUE_BLUE and HUE_ORANGE in road.js came from.
 *
 * The total width is the one number on this page that the şartname does not
 * print. 100 mm is what Şekil 6 draws at its own scale, and it is used here
 * only to draw the track on /map and to size the junction test's expectation
 * of how wide a line looks. Nothing that decides where the rover goes depends
 * on it.
 */
const FIELD_LINE_W = 0.10;          // metres, scaled off Şekil 6 — not dimensioned

/** The QR codes are 50 × 50 mm — Şekil 2, dimensioned. Not read yet. */
const FIELD_QR_M = 0.05;

// ── the track ────────────────────────────────────────────────────────

/** The main line's y, and the two ends of the paint on it. */
const FIELD_MAIN_Y = 4.0;

/**
 * The nodes.
 *
 * `kind` says what the rover does there:
 *
 *   junction  a place where the paint splits. Nothing happens here except a
 *             decision, which is why they are the only nodes the camera has to
 *             recognise.
 *   gate      the factory-automation door. A junction with no branch, kept as
 *             a node because it is a place a run may have to *stop*.
 *   start     the başlangıç alanı — where the rover is before the run.
 *   pick      A1..A3, the yük alım istasyonları.
 *   drop      B1..B3, the yük bırakma noktaları.
 *
 * A station's x,y is the centre of its marked zone — the place the load
 * actually is, not the end of the paint. `tip` is how much further the line
 * runs past it, because that is what the rover sees: it drives up the branch,
 * the zone arrives, and the paint carries on for another 0.9 m before running
 * out. Getting that backwards is the difference between stopping on the load
 * and stopping short of it.
 *
 * `zone` is the marked rectangle: `along` the branch and `across` it. The
 * stations are all 615 × 715 mm (Şekil 6, dimensioned) and the start area is
 * 1900 × 1000 mm (Şekil 5, dimensioned).
 */
const FIELD_NODES = [
  // The main line, west to east. x measured off Şekil 1; y is dimensioned.
  { id: 'J1',   kind: 'junction', x: 1.90,  y: FIELD_MAIN_Y },
  { id: 'J2',   kind: 'junction', x: 3.69,  y: FIELD_MAIN_Y },
  { id: 'J3',   kind: 'junction', x: 5.49,  y: FIELD_MAIN_Y },
  { id: 'KAPI', kind: 'gate',     x: 8.25,  y: FIELD_MAIN_Y, label: 'Fabrika kapısı' },
  { id: 'J4',   kind: 'junction', x: 11.51, y: FIELD_MAIN_Y },

  // Start: south off J1. Şekil 5 — 3.8 m of paint, the 1.9 × 1.0 m area
  // starting 1.5 m down from the junction, so its centre is 2.45 m down and
  // the paint runs on for 1.35 m past it.
  { id: 'START', kind: 'start', x: 1.90, y: 1.55, tip: 1.35,
    zone: { along: 1.90, across: 1.00 }, label: 'Başlangıç' },

  // The three pick stations, north off J1/J2/J3. Şekil 1 draws the branches
  // 5.75 m long; Şekil 6 dimensions their last 2.7 m, and the two agree.
  { id: 'A1', kind: 'pick', x: 1.90,  y: 8.86, tip: 0.89, zone: { along: 0.615, across: 0.715 } },
  { id: 'A2', kind: 'pick', x: 3.69,  y: 8.86, tip: 0.89, zone: { along: 0.615, across: 0.715 } },
  { id: 'A3', kind: 'pick', x: 5.49,  y: 8.86, tip: 0.89, zone: { along: 0.615, across: 0.715 } },

  // The three drop points, all off J4: B3 north, B1 south, B2 straight on east.
  { id: 'B3', kind: 'drop', x: 11.51, y: 8.74, tip: 0.89, zone: { along: 0.615, across: 0.715 } },
  { id: 'B1', kind: 'drop', x: 11.51, y: 1.18, tip: 0.91, zone: { along: 0.615, across: 0.715 } },
  { id: 'B2', kind: 'drop', x: 16.82, y: FIELD_MAIN_Y, tip: 0.91, zone: { along: 0.615, across: 0.715 } },
];

/**
 * The edges — every metre of paint on the floor.
 *
 * `qr` is the code standing on that leg and `s` is how far along it stands,
 * in metres from `a`. Nothing reads a QR yet; they are here because the
 * placement is what fixes several of the lengths above, and because when a
 * reader is added it needs somewhere to look the code up. Q1 sits at the
 * junction end of the start branch (Şekil 5); the station codes sit 2.7 m
 * back from the end of their paint (Şekil 6). KAPI1 and KAPI2 are the two
 * this file is least sure of: Şekil 1 labels them but does not dimension
 * them, so their `s` is scaled off the drawing like the branch positions.
 */
const FIELD_EDGES = [
  { a: 'J1', b: 'START', qr: 'q1', text: 'BASLA',  s: 0.00 },
  { a: 'J1', b: 'A1',    qr: 'q2', text: 'ALIM1',  s: 3.05 },
  { a: 'J2', b: 'A2',    qr: 'q3', text: 'ALIM2',  s: 3.05 },
  { a: 'J3', b: 'A3',    qr: 'q4', text: 'ALIM3',  s: 3.05 },
  { a: 'J1', b: 'J2' },
  { a: 'J2', b: 'J3' },
  { a: 'J3', b: 'KAPI',  qr: 'q5', text: 'KAPI1',  s: 1.61 },
  { a: 'KAPI', b: 'J4',  qr: 'q6', text: 'KAPI2',  s: 1.86 },
  { a: 'J4', b: 'B3',    qr: 'q7', text: 'BIRAK3', s: 2.93 },
  { a: 'J4', b: 'B2',    qr: 'q8', text: 'BIRAK2', s: 3.52 },
  { a: 'J4', b: 'B1',    qr: 'q9', text: 'BIRAK1', s: 1.03 },
];

const FIELD = { building: FIELD_BUILDING, nodes: FIELD_NODES, edges: FIELD_EDGES,
                lineW: FIELD_LINE_W, qrM: FIELD_QR_M };

// ── reading the graph ────────────────────────────────────────────────

const fRound = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

/** A node by id, or null. Ids compare upper case: a QR is not a shout. */
function fieldNode(id, map) {
  const m = map || FIELD;
  const want = String(id == null ? '' : id).toUpperCase();
  return m.nodes.find((n) => n.id === want) || null;
}

/** The stations a run can be sent to, in the order a person reads them. */
function fieldStations(kind, map) {
  const m = map || FIELD;
  return m.nodes.filter((n) => (kind ? n.kind === kind : n.kind === 'pick' || n.kind === 'drop'));
}

/** Every edge touching a node, as {edge, other}. */
function fieldLinks(id, map) {
  const m = map || FIELD;
  const want = String(id == null ? '' : id).toUpperCase();
  const out = [];
  for (const e of m.edges) {
    if (e.a === want) out.push({ edge: e, other: e.b });
    else if (e.b === want) out.push({ edge: e, other: e.a });
  }
  return out;
}

/** Compass bearing from node `a` to node `b`, in degrees. */
function fieldBearing(aId, bId, map) {
  const a = fieldNode(aId, map), b = fieldNode(bId, map);
  if (!a || !b) return null;
  const deg = Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI;   // note: (dx, dy)
  return fRound((deg + 360) % 360, 2);
}

/** Straight-line distance between two nodes, in metres. */
function fieldSpan(aId, bId, map) {
  const a = fieldNode(aId, map), b = fieldNode(bId, map);
  if (!a || !b) return null;
  return fRound(Math.hypot(b.x - a.x, b.y - a.y), 3);
}

/**
 * A signed turn, in degrees, from one bearing to another: −180..+180, where
 * positive is to the right. This is the only place the sign convention lives,
 * so a turn cannot come out mirrored in one caller and not another.
 */
function fieldTurn(fromDeg, toDeg) {
  let d = (Number(toDeg) - Number(fromDeg)) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return fRound(d, 2);
}

// ── planning ─────────────────────────────────────────────────────────

/**
 * The nodes to drive through, from `fromId` to `toId`, breadth first.
 *
 * Breadth first and not anything cleverer because the graph is a tree with
 * eleven edges in it: there is exactly one route between any two nodes, so
 * every search finds the same one and the only thing a cost function could
 * change is how long it takes to find it.
 *
 * Returns [] when either end is not a node, or when they are not connected —
 * never a partial route, because a partial route is one the rover would drive.
 */
function fieldPlan(fromId, toId, map) {
  const m = map || FIELD;
  const from = fieldNode(fromId, m), to = fieldNode(toId, m);
  if (!from || !to) return [];
  if (from.id === to.id) return [from.id];

  const prev = new Map([[from.id, null]]);
  const queue = [from.id];
  while (queue.length) {
    const at = queue.shift();
    if (at === to.id) break;
    for (const { other } of fieldLinks(at, m)) {
      if (prev.has(other)) continue;
      prev.set(other, at);
      queue.push(other);
    }
  }
  if (!prev.has(to.id)) return [];

  const out = [];
  for (let at = to.id; at !== null; at = prev.get(at)) out.push(at);
  return out.reverse();
}

/**
 * A plan, turned into the thing the rover actually needs: what to do at each
 * node it will meet.
 *
 * One entry per leg. `from`/`to` are the nodes at its ends, `len` is how far
 * it is, `bearing` is the way to point down it, and `turn` is the signed turn
 * to make AT `from` to get onto it — which is why the first leg's turn is
 * measured against `heading`, the way the rover is already pointing, and every
 * later one against the leg before.
 *
 * `act` is that turn as a word, because that is what the pilot's corner
 * manoeuvre takes and what a person reads on /map. FIELD_STRAIGHT_DEG is
 * generous: every junction on this field is square, so anything that is not
 * plainly a turn is the line carrying on.
 */
const FIELD_STRAIGHT_DEG = 45;

function fieldLegs(plan, heading = 0, map) {
  const m = map || FIELD;
  const out = [];
  let facing = Number(heading) || 0;
  for (let i = 0; i + 1 < plan.length; i++) {
    const bearing = fieldBearing(plan[i], plan[i + 1], m);
    if (bearing === null) return [];
    const turn = fieldTurn(facing, bearing);
    out.push({
      from: plan[i], to: plan[i + 1],
      len: fieldSpan(plan[i], plan[i + 1], m),
      bearing, turn,
      act: Math.abs(turn) <= FIELD_STRAIGHT_DEG ? 'straight' : (turn > 0 ? 'right' : 'left'),
    });
    facing = bearing;
  }
  return out;
}

/**
 * The junctions on a plan, in the order the camera will meet them, with what
 * to do at each.
 *
 * This is the list mission.js counts against, and it is deliberately not the
 * same as fieldLegs(): a leg exists for every hop, but only some hops start at
 * something the camera can see. A station is not a junction — the paint ends
 * there — and the rover's own starting node is behind it, not ahead.
 *
 * `at` is how far into the run the junction is, in metres of driving. That is
 * what makes a sighting checkable: a junction reported two metres from where
 * the map says the next one is, is not that junction. `into` and `bearing` are
 * the ways to be pointing arriving and leaving — see below for why both.
 */
function fieldJunctions(plan, heading = 0, map) {
  const m = map || FIELD;
  const legs = fieldLegs(plan, heading, m);
  const out = [];
  let run = 0;
  for (let i = 0; i < legs.length; i++) {
    const node = fieldNode(legs[i].from, m);
    // The first node of the plan is where the rover already is, so there is
    // nothing to see there and nothing to decide.
    if (i > 0 && node && (node.kind === 'junction' || node.kind === 'gate')) {
      out.push({ id: node.id, kind: node.kind, at: fRound(run, 3),
                 act: legs[i].act, turn: legs[i].turn,
                 // Two bearings, because a junction is two moments. `into` is
                 // the way the rover is pointing when it gets there — what a
                 // sighting proves — and `bearing` is the way it will be
                 // pointing when it leaves. Anchoring with the wrong one of
                 // these puts the whole rest of the run at right angles to
                 // where it should be, and it does it silently.
                 into: legs[i - 1].bearing,
                 bearing: legs[i].bearing });
    }
    run += legs[i].len;
  }
  return out;
}

// ── where the rover is ───────────────────────────────────────────────

/**
 * Dead reckoning, and why it is worth having here.
 *
 * The ESP32 version of this robot had to guess how far it had gone from a
 * throttle percentage and a stopwatch. This one does not: the wheels are
 * steppers driven by G-code, so rover.js hands out the millimetres it asked
 * each wheel for, and those are the millimetres the wheels turned unless
 * something slipped. That makes the distance nearly exact and leaves the
 * heading as the only real error — it is an integral, so a wheel that slips
 * once bends the whole rest of the map.
 *
 * Which is what mission.js is for. Every junction the camera confirms is a
 * place with a known position, so the run is dead reckoning between junctions
 * and truth at them, rather than dead reckoning for the whole lap.
 */
const FIELD_TRACK_M = 0.30;    // wheel centre to wheel centre — measure it

/** Fresh state, sitting on a node and pointing somewhere. */
function fieldState(nodeId = 'START', heading = 0, map) {
  const n = fieldNode(nodeId, map);
  return {
    x: n ? n.x : 0,
    y: n ? n.y : 0,
    h: (Number(heading) || 0) % 360,
    at: n ? n.id : null,      // the last node we were sure of
    run: 0,                   // metres driven since `at`
    dist: 0,                  // metres driven in total
    ds: 0, dth: 0,            // the last step, for a manoeuvre counting itself out
    path: [{ x: n ? n.x : 0, y: n ? n.y : 0 }],
  };
}

/**
 * One step of dead reckoning, from the two wheels' millimetres.
 *
 * Takes millimetres because that is rover.js's own currency — chunkFor()
 * returns dLeft and dRight in mm — so the caller does not have to convert and
 * cannot convert wrongly. Everything else on this page is metres.
 *
 * The integration is the exact-arc one rather than "advance, then turn": at
 * the chunk sizes rover.js uses the difference is microscopic, but the exact
 * form costs two extra lines and cannot accumulate a bias on a long curve.
 */
const FIELD_PATH_MAX = 2000;
const FIELD_PATH_STEP = 0.03;    // metres between kept path points

function fieldStep(st, dLeftMm, dRightMm, track = FIELD_TRACK_M) {
  const dL = (Number(dLeftMm) || 0) / 1000;
  const dR = (Number(dRightMm) || 0) / 1000;
  const t = Number(track) > 0 ? Number(track) : FIELD_TRACK_M;

  const ds = (dL + dR) / 2;
  // Radians of bearing, so clockwise is positive: the LEFT wheel going faster
  // is what swings the nose to the right. Left and right are the camera's —
  // the same two numbers the pilot steers with, which is the whole reason
  // rover.js does its own end-swap and this does not.
  const dth = (dL - dR) / t;
  const h0 = st.h * Math.PI / 180;

  if (Math.abs(dth) < 1e-9) {
    st.x += ds * Math.sin(h0);
    st.y += ds * Math.cos(h0);
  } else {
    // Exact arc: the centre of rotation is ds/dth away, square to the heading.
    const r = ds / dth;
    st.x += r * (Math.cos(h0) - Math.cos(h0 + dth));
    st.y += r * (Math.sin(h0 + dth) - Math.sin(h0));
  }
  st.h = ((st.h + dth * 180 / Math.PI) % 360 + 360) % 360;
  // `run` is measured against the map — how far past the last known node the
  // rover is — so backing up has to take it back down again. `dist` is the
  // odometer, and an odometer counts every metre whichever way it was driven.
  st.run += ds;
  st.dist += Math.abs(ds);
  // What this step was, kept on the state for whoever is counting one out.
  // A blind manoeuvre — drive 60 cm, turn 180° — has no landmark to end on,
  // so it ends on its own arithmetic, and this is that arithmetic. Metres and
  // radians, both signed, both ground rather than commanded.
  st.ds = ds;
  st.dth = dth;

  const last = st.path[st.path.length - 1];
  if (!last || Math.hypot(st.x - last.x, st.y - last.y) >= FIELD_PATH_STEP) {
    st.path.push({ x: fRound(st.x), y: fRound(st.y) });
    if (st.path.length > FIELD_PATH_MAX) st.path.shift();
  }
  return st;
}

/**
 * Put the rover on a node it has just proved it is standing on.
 *
 * This is the whole point of the map. A confirmed junction is a measurement —
 * not "12.4 m into the run" but "at J2, pointing east" — so the position and
 * the heading are both replaced outright rather than blended. Blending would
 * be the right thing if there were two noisy estimates; there are not. There
 * is a guess that has been drifting and a fact.
 *
 * The heading is snapped to the leg being driven for the same reason: at a
 * square junction on a painted line there are only four ways to be pointing,
 * and the rover is pointing down one of them.
 */
function fieldAnchor(st, nodeId, bearing, map) {
  const n = fieldNode(nodeId, map);
  if (!n) return st;
  st.x = n.x;
  st.y = n.y;
  if (bearing !== null && bearing !== undefined) st.h = ((Number(bearing) % 360) + 360) % 360;
  st.at = n.id;
  st.run = 0;
  st.path.push({ x: fRound(st.x), y: fRound(st.y) });
  if (st.path.length > FIELD_PATH_MAX) st.path.shift();
  return st;
}

/** The pose, rounded, for a status message or a drawing. */
function fieldPose(st) {
  return { x: fRound(st.x), y: fRound(st.y), h: fRound(st.h, 1),
           at: st.at, run: fRound(st.run), dist: fRound(st.dist) };
}

// The pages load this with <script src>, so everything above is already
// global. Node gets at it through shared.js, which evaluates the same bytes.

// ── drawing it ───────────────────────────────────────────────────────

/**
 * How the field maps onto a canvas: scale, offset, and the two conversions.
 *
 * Kept apart from the drawing because a click has to go the other way. The
 * page hit-tests a tap against station positions in metres, not in pixels, so
 * the page would otherwise need its own copy of this arithmetic — and a
 * picker that disagrees with the picture by a few pixels is a picker that
 * sends the rover to A3 when A2 was tapped.
 *
 * y is flipped: the field's +y is north, the canvas's +y is down.
 */
function fieldView(w, h, pad = 14, map) {
  const m = map || FIELD;
  const s = Math.min((w - pad * 2) / m.building.w, (h - pad * 2) / m.building.h);
  const ox = (w - m.building.w * s) / 2;
  const oy = (h - m.building.h * s) / 2;
  return {
    s, ox, oy,
    px: (x, y) => [ox + x * s, oy + (m.building.h - y) * s],
    metres: (px, py) => [(px - ox) / s, m.building.h - (py - oy) / s],
  };
}

/**
 * The station nearest a point on the map, or null if nothing is near enough.
 *
 * `within` is in metres, not pixels, so the target stays the same size on the
 * field however big the canvas is — a tap lands on the station a person was
 * aiming at rather than on whichever one the zoom happened to make fattest.
 */
function fieldPickAt(x, y, within = 1.4, map) {
  const m = map || FIELD;
  let best = null, bestD = within;
  for (const n of m.nodes) {
    if (n.kind === 'junction' || n.kind === 'gate') continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

const FIELD_COLOURS = {
  wall: '#8b949e', floor: 'rgba(255,255,255,0.02)', gate: '#d29922',
  blue: '#3465a4', orange: '#ff8000', zone: '#ffe000',
  ink: '#e6edf3', dim: '#8b949e', plan: '#58a6ff', rover: '#3fb950',
};

/**
 * Draw the field.
 *
 * @param ctx   a 2D canvas context, already sized
 * @param w,h   its pixel size
 * @param o     { pose, plan, target, colours } — everything optional. `pose`
 *              is field.js's own state (or a fieldPose() of one); `plan` is a
 *              list of node ids from fieldPlan(), drawn as the route.
 *
 * Drawn back to front: room, then paint, then zones, then the route over the
 * top, then the rover over that. The order is the point — the route has to be
 * legible against the paint it is drawn on, and the rover has to be legible
 * against everything.
 */
function fieldDraw(ctx, w, h, o = {}) {
  const m = o.map || FIELD;
  const c = { ...FIELD_COLOURS, ...(o.colours || {}) };
  const v = fieldView(w, h, o.pad, m);
  const P = v.px;
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ── the building ──
  // Each hall is drawn as four walls rather than a rectangle, because two of
  // them have a 3 m hole in the middle that the track goes through, and a hole
  // is the whole reason the corridor and the gate exist.
  ctx.lineWidth = Math.max(2, v.s * 0.12);
  ctx.strokeStyle = c.wall;
  for (const hall of m.building.halls) {
    const gaps = m.building.openings.filter((g) => g.x === hall.x0 || g.x === hall.x1);
    ctx.beginPath();
    const [x0, y1] = P(hall.x0, m.building.h);
    const [x1, y0] = P(hall.x1, 0);
    ctx.moveTo(x0, y1); ctx.lineTo(x1, y1);      // north
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y0);      // south
    for (const x of [hall.x0, hall.x1]) {
      const gap = gaps.find((g) => g.x === x);
      const [px] = P(x, 0);
      if (!gap) { ctx.moveTo(px, y0); ctx.lineTo(px, y1); continue; }
      ctx.moveTo(px, y0); ctx.lineTo(px, P(x, gap.y0)[1]);
      ctx.moveTo(px, P(x, gap.y1)[1]); ctx.lineTo(px, y1);
    }
    ctx.stroke();
  }

  // The factory door, standing across the corridor. Drawn in warning yellow
  // because it is the one thing on the field that can stop a run that is
  // otherwise going perfectly.
  ctx.strokeStyle = c.gate;
  ctx.lineWidth = Math.max(2, v.s * 0.10);
  ctx.beginPath();
  ctx.moveTo(...P(m.building.gate.x, m.building.gate.y0));
  ctx.lineTo(...P(m.building.gate.x, m.building.gate.y1));
  ctx.stroke();

  // ── the paint ──
  // Blue casing with an orange core, at the line's real width, because that is
  // what the camera is looking for and seeing it drawn that way is half of
  // understanding what the detector is doing.
  //
  // Every edge on this field is axis-aligned, so both the width and the centre
  // are snapped: an odd line width centred on a half-pixel is the one
  // combination a canvas draws without spreading it over two columns. Without
  // that the orange core — a third of a 100 mm line, which at any sane zoom is
  // between one and two pixels — lands on the pixel grid for some branches and
  // between it for others, and the map shows three identical branches painted
  // three different colours.
  const snap = (pt) => [Math.round(pt[0]) + 0.5, Math.round(pt[1]) + 0.5];
  const odd = (n, min) => Math.max(min, Math.round(n) | 1);
  const paint = (a, b, extra) => {
    const A = fieldNode(a, m), B = fieldNode(b, m);
    if (!A || !B) return;
    // Station edges run PAST the station to where the paint stops.
    const dx = Math.sign(B.x - A.x), dy = Math.sign(B.y - A.y);
    const ex = B.x + dx * (extra || 0), ey = B.y + dy * (extra || 0);
    ctx.beginPath();
    ctx.moveTo(...snap(P(A.x, A.y)));
    ctx.lineTo(...snap(P(ex, ey)));
    ctx.stroke();
  };
  for (const pass of [[c.blue, odd(m.lineW * v.s, 3)],
                      [c.orange, odd(m.lineW / 3 * v.s, 1)]]) {
    ctx.strokeStyle = pass[0];
    ctx.lineWidth = pass[1];
    for (const e of m.edges) {
      const B = fieldNode(e.b, m);
      paint(e.a, e.b, B && B.tip ? B.tip : 0);
    }
  }

  // ── the marked areas ──
  // The zones are the thing a run is actually for. Yellow, as on the field.
  ctx.lineWidth = Math.max(1, v.s * 0.05);
  ctx.strokeStyle = c.zone;
  for (const n of m.nodes) {
    if (!n.zone) continue;
    // `along` runs down the branch, which for every station on this field is
    // north–south except B2, which hangs off the east end of the main line.
    const alongY = n.id !== 'B2';
    const ww = alongY ? n.zone.across : n.zone.along;
    const hh = alongY ? n.zone.along : n.zone.across;
    const [px, py] = P(n.x - ww / 2, n.y + hh / 2);
    ctx.strokeRect(px, py, ww * v.s, hh * v.s);
  }

  // ── the route ──
  if (o.plan && o.plan.length > 1) {
    ctx.strokeStyle = c.plan;
    ctx.lineWidth = Math.max(2, v.s * 0.09);
    ctx.setLineDash([v.s * 0.25, v.s * 0.2]);
    ctx.beginPath();
    o.plan.forEach((id, i) => {
      const n = fieldNode(id, m);
      if (!n) return;
      const pt = P(n.x, n.y);
      if (i === 0) ctx.moveTo(...pt); else ctx.lineTo(...pt);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── the labels ──
  ctx.font = `600 ${Math.max(9, Math.round(v.s * 0.34))}px ui-monospace,Menlo,monospace`;
  ctx.textAlign = 'center';
  for (const n of m.nodes) {
    const [px, py] = P(n.x, n.y);
    const junc = n.kind === 'junction' || n.kind === 'gate';
    ctx.fillStyle = n.id === o.target ? c.plan : (junc ? c.dim : c.ink);
    if (junc) {
      ctx.beginPath();
      ctx.arc(px, py, Math.max(2, v.s * 0.07), 0, Math.PI * 2);
      ctx.fill();
    }
    // Stations are labelled beside the zone, junctions under the dot, so a
    // label never sits on the paint the eye is trying to follow.
    const half = n.zone ? (n.id === 'B2' ? n.zone.across : n.zone.along) / 2 : 0;
    ctx.fillText(n.id, px, junc ? py + v.s * 0.62 : py - (half + 0.22) * v.s);
  }

  // ── the rover ──
  if (o.pose) {
    if (o.pose.path && o.pose.path.length > 1) {
      ctx.strokeStyle = c.rover;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = Math.max(1, v.s * 0.05);
      ctx.beginPath();
      o.pose.path.forEach((p, i) => {
        const pt = P(p.x, p.y);
        if (i === 0) ctx.moveTo(...pt); else ctx.lineTo(...pt);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // A triangle, not a dot: which way it is pointing is half of what the pose
    // says, and the half that goes wrong first.
    const [px, py] = P(o.pose.x, o.pose.y);
    const r = Math.max(4, v.s * 0.28);
    const a = (o.pose.h || 0) * Math.PI / 180;
    ctx.fillStyle = c.rover;
    ctx.beginPath();
    // Bearings, so the nose is (sin, cos) and the canvas's y runs the other way.
    ctx.moveTo(px + Math.sin(a) * r, py - Math.cos(a) * r);
    ctx.lineTo(px + Math.sin(a + 2.5) * r * 0.8, py - Math.cos(a + 2.5) * r * 0.8);
    ctx.lineTo(px + Math.sin(a - 2.5) * r * 0.8, py - Math.cos(a - 2.5) * r * 0.8);
    ctx.closePath();
    ctx.fill();
  }
  return v;
}
