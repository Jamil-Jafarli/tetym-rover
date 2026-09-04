/**
 * The competition field, and where the robot is on it.
 *
 * Pure, like pilot.js, sonar.js and route.js: no DOM, no clock of its own, so
 * the server localises with it, /dashboard draws it, and test/test_field.mjs
 * runs it in node with no hardware.
 *
 * ── Why this file exists ────────────────────────────────────────────
 *
 * route.js knows how far the robot has driven and which way it is pointing,
 * and both of those are a model's opinion: no encoder, no IMU, open loop, and
 * a heading error that only ever grows. On its own that is enough to draw a
 * pretty line and not enough to answer the two questions the run actually
 * asks — *where am I* and *which way do I turn next*.
 *
 * The QR codes answer both. Each one is bolted to a known place on the field,
 * so reading q5 is not "a code was read 12.4 m into the run", it is "the robot
 * is on the D3→gate leg, 3.9 m east of D1, pointing east". That is a
 * measurement. Everything between two codes is still dead reckoning, but it is
 * dead reckoning that gets reset to the truth every few metres instead of
 * drifting for the whole lap.
 *
 * So the field is written down here as a graph — the schematic in test.png,
 * node for node — and this module does three things with it:
 *
 *   1. localise:  a QR id  → which leg the robot is on, and which way along it
 *   2. plan:      a target → the nodes to drive through, breadth first
 *   3. steer:     the plan → what to do at the node ahead: left, right, on
 *
 * ── The coordinate frame ────────────────────────────────────────────
 *
 * Metres. +x is east (right on the drawing), +y is north (up). The origin is
 * D1, because D1 is the corner the start area feeds into and every other node
 * is a whole number of steps from it. Headings are compass bearings in
 * degrees: 0 = north, 90 = east, clockwise positive — the same convention
 * routeBearing() returns, which is what lets the two be added together in
 * fieldPose() without a sign to get wrong.
 */

const FIELD_STRAIGHT_DEG = 25;   // less of a turn than this and it is "carry on"
const FIELD_BACK_DEG = 150;      // more than this and it is a U-turn, not a turn
// Reading the same code again after moving less than this is the same sighting
// of the same sign, not a second pass. See fieldSee() for what hangs on it.
const FIELD_SAME_M = 0.5;

/**
 * The field itself.
 *
 * Distances are the schematic's proportions carried over to metres. If the
 * real field is measured and comes out different, this table is the only thing
 * to edit — the planner, the localiser and the drawing all read it, and none
 * of them has a second copy of a coordinate.
 *
 * Node kinds, straight off the legend in test.png:
 *   node  Dx — düyüm noktası, a junction the robot drives through
 *   pick  Ax — alma noktası, where a load is picked up
 *   drop  Bx — bırakma noktası, where it is dropped
 *   start    the başlangıç alanı
 *   gate     the door the factory automation opens; a node you may have to
 *            wait at, which is why it is a node and not just a spot on a leg
 *
 * An edge's `qr` is the code standing on that leg, and `at` is how far along
 * it stands as a fraction from `a` to `b`. Position comes from that fraction
 * rather than being typed out again, so a QR cannot end up drawn in one place
 * and localised to another.
 */
const FIELD = {
  nodes: [
    { id: 'START', kind: 'start', x: 0,   y: -1.6, label: 'Başlangıç alanı' },

    { id: 'A1', kind: 'pick', x: 0,   y: 2.6, label: 'A1' },
    { id: 'A2', kind: 'pick', x: 1.5, y: 2.6, label: 'A2' },
    { id: 'A3', kind: 'pick', x: 3.0, y: 2.6, label: 'A3' },

    { id: 'D1', kind: 'node', x: 0,   y: 0,   label: 'D1' },
    { id: 'D2', kind: 'node', x: 1.5, y: 0,   label: 'D2' },
    { id: 'D3', kind: 'node', x: 3.0, y: 0,   label: 'D3' },
    { id: 'GATE', kind: 'gate', x: 4.6, y: 0, label: 'Fabrika otomasyon sistemi kontrollü kapı' },
    { id: 'D4', kind: 'node', x: 6.4, y: 0,   label: 'D4' },
    { id: 'D5', kind: 'node', x: 6.4, y: 1.7, label: 'D5' },
    { id: 'D6', kind: 'node', x: 6.4, y: -1.7, label: 'D6' },

    { id: 'B1', kind: 'drop', x: 9.3, y: 1.7,  label: 'B1' },
    { id: 'B2', kind: 'drop', x: 9.3, y: 0,    label: 'B2' },
    { id: 'B3', kind: 'drop', x: 9.3, y: -1.7, label: 'B3' },
  ],
  edges: [
    { a: 'START', b: 'D1', qr: 'q1', at: 0.56 },
    { a: 'A1', b: 'D1', qr: 'q2', at: 0.54 },
    { a: 'A2', b: 'D2', qr: 'q3', at: 0.54 },
    { a: 'A3', b: 'D3', qr: 'q4', at: 0.54 },
    { a: 'D1', b: 'D2', qr: null, at: 0.5 },
    { a: 'D2', b: 'D3', qr: null, at: 0.5 },
    { a: 'D3', b: 'GATE', qr: 'q5', at: 0.56 },
    { a: 'GATE', b: 'D4', qr: 'q6', at: 0.33 },
    { a: 'D4', b: 'D5', qr: null, at: 0.5 },
    { a: 'D4', b: 'D6', qr: null, at: 0.5 },
    { a: 'D5', b: 'B1', qr: 'q9', at: 0.48 },
    { a: 'D4', b: 'B2', qr: 'q8', at: 0.48 },
    { a: 'D6', b: 'B3', qr: 'q7', at: 0.48 },
  ],
};

// ── the graph, read ──────────────────────────────────────────────────

/** A node by id, or null. Ids are compared upper case: a QR is not a shout. */
function fieldNode(id, map) {
  const m = map || FIELD;
  const want = String(id == null ? '' : id).toUpperCase();
  return m.nodes.find((n) => n.id === want) || null;
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

/** The edge between two nodes, whichever way round it was written. */
function fieldEdge(a, b, map) {
  const m = map || FIELD;
  const A = String(a || '').toUpperCase(), B = String(b || '').toUpperCase();
  return m.edges.find((e) => (e.a === A && e.b === B) || (e.a === B && e.b === A)) || null;
}

/**
 * The code on a QR, reduced to the id this field knows it by.
 *
 * The sticker may say "q5", "Q5", "qr5", "qr/5" at the end of a URL, or just
 * "5" — none of which is worth a failed localisation, because the one thing
 * they all agree on is the number after a q.
 *
 * That q is not decoration, it is the whole safety margin. A field has other
 * codes on it — a pallet label, a cargo id, somebody's stock sticker — and
 * "any string ending in a digit is a waypoint" reads `kargo-9` as q9 and puts
 * the robot at the far end of the arena with total confidence. A wrong fix is
 * far worse than no fix, so the only bare number accepted is a string that is
 * *nothing but* a number. Everything else needs the q.
 */
function fieldQrId(text, map) {
  const m = map || FIELD;
  if (text == null) return null;
  const s = String(text).trim();
  // q, optionally the r of "qr", optionally a separator, then the number — and
  // the q may not be the tail of a longer word.
  const tagged = s.match(/(?:^|[^a-z0-9])q(?:r)?[-_/ ]?(\d{1,2})(?![0-9])/i);
  const bare = s.match(/^(\d{1,2})$/);
  const n = tagged ? tagged[1] : bare ? bare[1] : null;
  if (n === null) return null;
  const id = `q${Number(n)}`;
  return m.edges.some((e) => e.qr === id) ? id : null;
}

/** Where a QR stands, and the leg it stands on: {qr, edge, x, y} or null. */
function fieldQr(qrId, map) {
  const m = map || FIELD;
  const e = m.edges.find((x) => x.qr === qrId);
  if (!e) return null;
  const a = fieldNode(e.a, m), b = fieldNode(e.b, m);
  const t = Number(e.at);
  return {
    qr: qrId, edge: e, a: e.a, b: e.b,
    x: fieldRound(a.x + (b.x - a.x) * t),
    y: fieldRound(a.y + (b.y - a.y) * t),
  };
}

/** Every QR on the field, in the order the field lists them. */
function fieldQrs(map) {
  const m = map || FIELD;
  return m.edges.filter((e) => e.qr).map((e) => fieldQr(e.qr, m));
}

// ── angles ───────────────────────────────────────────────────────────

/** Compass bearing from node `a` to node `b`, degrees, 0 = north. */
function fieldBearing(a, b, map) {
  const m = map || FIELD;
  const na = typeof a === 'string' ? fieldNode(a, m) : a;
  const nb = typeof b === 'string' ? fieldNode(b, m) : b;
  if (!na || !nb) return null;
  const deg = Math.atan2(nb.x - na.x, nb.y - na.y) * 180 / Math.PI;
  return fieldRound((deg % 360 + 360) % 360, 1);
}

/** Metres between two nodes. */
function fieldDist(a, b, map) {
  const m = map || FIELD;
  const na = typeof a === 'string' ? fieldNode(a, m) : a;
  const nb = typeof b === 'string' ? fieldNode(b, m) : b;
  if (!na || !nb) return null;
  return fieldRound(Math.hypot(nb.x - na.x, nb.y - na.y), 2);
}

/** A difference of bearings, folded into (-180, 180]. */
function fieldWrapDeg(d) {
  let v = ((Number(d) || 0) + 180) % 360;
  if (v <= 0) v += 360;
  return v - 180;
}

/**
 * What the robot does at a junction: come in on one bearing, leave on another.
 *
 * The dead band matters. A field laid out on a grid gives turns of 90° and
 * legs of 0°, but the two A-branch legs meet their corridor at exactly 90°
 * while a wonky measurement might make it 87 — and "sağa 3°" is not an
 * instruction, it is noise. Anything under FIELD_STRAIGHT_DEG is düz.
 */
function fieldTurn(inBearing, outBearing) {
  if (inBearing == null || outBearing == null) return null;
  const d = fieldWrapDeg(outBearing - inBearing);
  const mag = Math.abs(d);
  const dir = mag >= FIELD_BACK_DEG ? 'back'
            : mag <= FIELD_STRAIGHT_DEG ? 'straight'
            : d > 0 ? 'right' : 'left';
  return { deg: fieldRound(d, 1), dir, label: FIELD_TURN_LABEL[dir] };
}

const FIELD_TURN_LABEL = {
  left: 'sola dön', right: 'sağa dön', straight: 'düz devam et',
  back: 'geri dön',
};

// ── planning ─────────────────────────────────────────────────────────

/**
 * The shortest way from one node to another, as a list of node ids.
 *
 * Breadth first on metres-per-edge would be Dijkstra; breadth first on edges
 * is enough here and is worth the simplicity, because this graph has no
 * alternative routes to weigh up — between any two points there is one way
 * round, and the only choice the robot ever makes is which branch to take.
 * Returns [] when there is no path, and [id] when you are already there.
 */
function fieldPath(from, to, map) {
  const m = map || FIELD;
  const A = String(from || '').toUpperCase(), B = String(to || '').toUpperCase();
  if (!fieldNode(A, m) || !fieldNode(B, m)) return [];
  if (A === B) return [A];
  const prev = new Map([[A, null]]);
  const queue = [A];
  while (queue.length) {
    const cur = queue.shift();
    for (const { other } of fieldLinks(cur, m)) {
      if (prev.has(other)) continue;
      prev.set(other, cur);
      if (other === B) {
        const out = [];
        for (let n = B; n !== null; n = prev.get(n)) out.unshift(n);
        return out;
      }
      queue.push(other);
    }
  }
  return [];
}

/**
 * A whole mission: start here, call at each target in turn.
 *
 * The scenario in test.png is "başlanğıc → an Ax → a Bx", so a mission is a
 * list of stops and the plan is the legs between them, joined without
 * repeating the node they share. A target that cannot be reached truncates the
 * plan rather than dropping the stop silently — half a route you can see is
 * easier to argue with than a route that quietly skips a delivery.
 */
function fieldPlan(from, targets, map) {
  const m = map || FIELD;
  const stops = (Array.isArray(targets) ? targets : [targets])
    .map((t) => String(t || '').toUpperCase()).filter(Boolean);
  let at = String(from || '').toUpperCase();
  if (!fieldNode(at, m)) return { nodes: [], stops, ok: false, reason: 'başlangıç düğümü tanınmıyor' };
  const nodes = [at];
  for (const t of stops) {
    const leg = fieldPath(at, t, m);
    if (leg.length === 0) {
      return { nodes, stops, ok: false, reason: `${t} için yol yok` };
    }
    nodes.push(...leg.slice(1));
    at = t;
  }
  return { nodes, stops, ok: nodes.length > 0, reason: null };
}

/**
 * The plan, spelled out leg by leg: drive this far, then turn that way.
 *
 * The turn is attached to the node the robot *arrives* at, not to the one it
 * leaves, because that is the moment the instruction is needed and the QR that
 * announces it is the one on the leg being driven.
 */
function fieldLegs(nodes, map) {
  const m = map || FIELD;
  const ns = Array.isArray(nodes) ? nodes : [];
  const out = [];
  for (let i = 0; i + 1 < ns.length; i++) {
    const from = ns[i], to = ns[i + 1];
    const edge = fieldEdge(from, to, m);
    const bearing = fieldBearing(from, to, m);
    const next = ns[i + 2] || null;
    out.push({
      i, from, to, next,
      qr: edge ? edge.qr : null,
      dist: fieldDist(from, to, m),
      bearing,
      // Nothing to turn towards at the last node: the leg ends there.
      turn: next ? fieldTurn(bearing, fieldBearing(to, next, m)) : null,
      kind: (fieldNode(to, m) || {}).kind || null,
    });
  }
  return out;
}

// ── where the robot is ───────────────────────────────────────────────

/** Fresh localisation state: nothing read, nothing planned, nothing known. */
function fieldState() {
  return {
    qr: null,          // the last code understood, e.g. 'q5'
    at: 0,             // when it was read
    from: null,        // the node the robot left
    to: null,          // the node it is driving towards
    sure: false,       // was the direction deduced, or guessed?
    seen: [],          // [{qr, at, from, to, onPlan}] — newest last
    stops: [],         // the mission as asked for
    plan: [],          // node ids, start to finish
    step: 0,           // index in plan of the node being driven towards
    onPlan: false,     // was the last code where the plan said it would be?
    // Set at every read: the field pose and the dead-reckoned pose at the same
    // instant, which is what lets one be expressed in the other's frame.
    anchor: null,
    unknown: null,     // the last code that meant nothing here
    reads: 0,          // codes understood since boot
    strays: 0,         // ...and codes that were not ours
  };
}

/**
 * A QR was read. Work out which leg the robot is on and which way it is going.
 *
 * A code identifies an edge, and an edge has two ends — reading q5 says the
 * robot is between D3 and the qapı but not whether it is coming or going. That
 * is decided, in order:
 *
 *   1. the same code again, from more or less the same spot: one sign, seen
 *      twice, so nothing about the direction has changed. "More or less" is
 *      dead reckoning, which is hopeless at absolute position and perfectly
 *      good at "have we moved half a metre".
 *   2. continuity: the last code left the robot heading for a node, and this
 *      edge touches that node, so it drove through it and is now on the far
 *      side. This is what keeps localisation working with no mission set at
 *      all — and it is what gets a turnaround right, because coming back off
 *      A2 reads the same code from the far side of the node.
 *   3. the plan, if this edge is a leg of it. Only reached on the first code
 *      of a run, when there is no previous reading to be continuous with.
 *   4. failing all three, the edge as written, flagged `sure: false` — a
 *      position that is right and a heading that is a coin toss, said out loud
 *      rather than pretended.
 *
 * @returns {{ok: boolean, qr: string|null, from: string|null, to: string|null,
 *             x: number, y: number, bearing: number, sure: boolean,
 *             onPlan: boolean, turn: object|null}}
 */
function fieldSee(st, text, now = 0, map = null, route = null) {
  const m = map || FIELD;
  const qrId = fieldQrId(text, m);
  if (!qrId) {
    st.unknown = text == null ? null : String(text).slice(0, 120);
    st.strays++;
    return { ok: false, qr: null, reason: 'bu sahaya ait bir QR değil' };
  }
  const spot = fieldQr(qrId, m);

  // Which way along the edge?
  let from = spot.a, to = spot.b, sure = false;
  if (st.qr === qrId && st.from && st.to && fieldMoved(st, route) < FIELD_SAME_M) {
    from = st.from; to = st.to; sure = st.sure;   // same sign, same spot, same way
  } else if (st.to === spot.a || st.to === spot.b) {
    // Drove through the node it was heading for, and out the other side.
    from = st.to; to = st.to === spot.a ? spot.b : spot.a; sure = true;
  } else {
    const guess = fieldPlanIndex(st, spot);
    if (guess >= 0) { from = st.plan[guess]; to = st.plan[guess + 1]; sure = true; }
  }

  // Where that leg sits in the plan — oriented, so a field the plan crosses
  // twice matches the crossing being driven rather than the one already done.
  const planIdx = fieldLegIndex(st, from, to);
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

  // The anchor: this position, and the dead reckoning that was running at the
  // same moment. Everything fieldPose() does afterwards is a difference from
  // these two, which is why a QR read is worth more than a mark on a map.
  st.anchor = {
    x: spot.x, y: spot.y, bearing, at: now,
    rx: route ? Number(route.x) || 0 : null,
    ry: route ? Number(route.y) || 0 : null,
    rb: route ? Number(route.bearing) || 0 : null,
  };

  st.seen.push({ qr: qrId, at: now, from, to, onPlan: st.onPlan });
  while (st.seen.length > 40) st.seen.shift();

  return { ok: true, qr: qrId, from, to, x: spot.x, y: spot.y, bearing,
           sure, onPlan: st.onPlan, turn: fieldTurnAt(st, m) };
}

/**
 * Where in the plan this edge is, ignoring which way round, or -1.
 *
 * Only used to guess a direction on the first code of a run, when there is no
 * previous reading to be continuous with.
 */
function fieldPlanIndex(st, spot) {
  const plan = st.plan || [];
  const hit = (i) => (plan[i] === spot.a && plan[i + 1] === spot.b)
                  || (plan[i] === spot.b && plan[i + 1] === spot.a);
  for (let i = Math.max(0, (st.step || 1) - 1); i + 1 < plan.length; i++) if (hit(i)) return i;
  for (let i = 0; i + 1 < plan.length; i++) if (hit(i)) return i;
  return -1;
}

/**
 * Where in the plan this *directed* leg is, or -1.
 *
 * Directed matters on a mission that doubles back: the plan through A2 is
 * …D2 → A2 → D2…, so the leg between them appears twice and only the direction
 * of travel says which of the two the robot is on. Searched from the current
 * step forwards first, so the answer is the crossing still ahead.
 */
function fieldLegIndex(st, from, to) {
  const plan = st.plan || [];
  const hit = (i) => plan[i] === from && plan[i + 1] === to;
  for (let i = Math.max(0, (st.step || 1) - 1); i + 1 < plan.length; i++) if (hit(i)) return i;
  for (let i = 0; i + 1 < plan.length; i++) if (hit(i)) return i;
  return -1;
}

/**
 * How far the dead reckoning says the robot has come since the last code.
 *
 * Zero when there is nothing to compare — no anchor, or a caller with no dead
 * reckoning to hand in. That reads as "it has not moved", which keeps the
 * previous direction: with no odometry at all, a code seen twice would
 * otherwise flip the heading every single time it is re-read, and a heading
 * that oscillates is worse than one that is merely stale.
 */
function fieldMoved(st, route) {
  const a = st.anchor;
  if (!a || a.rx === null || !route) return 0;
  return Math.hypot((Number(route.x) || 0) - a.rx, (Number(route.y) || 0) - a.ry);
}

/** The instruction for the node the robot is driving towards, or null. */
function fieldTurnAt(st, map) {
  const m = map || FIELD;
  if (!st.to) return null;
  const plan = st.plan || [];
  const i = st.step;
  // On plan: the turn is decided by where the plan goes after this node.
  if (plan[i] === st.to && plan[i + 1]) {
    return {
      node: st.to,
      ...fieldTurn(fieldBearing(st.from, st.to, m), fieldBearing(st.to, plan[i + 1], m)),
      then: plan[i + 1],
      dist: fieldDist(st.from, st.to, m),
    };
  }
  // On plan, and this is where the plan ends.
  if (plan[i] === st.to && plan.length && i === plan.length - 1) {
    return { node: st.to, deg: 0, dir: 'arrive', label: 'vardın — dur',
             then: null, dist: fieldDist(st.from, st.to, m) };
  }
  return null;
}

/**
 * Set the mission, and plan it from where the robot is now.
 *
 * `from` defaults to the node the robot is heading towards, because a mission
 * given mid-run has to start from the next junction rather than from the last
 * one, which is already behind it.
 */
function fieldMission(st, targets, map, from = null) {
  const m = map || FIELD;
  const start = from || st.to || 'START';
  const plan = fieldPlan(start, targets, m);
  st.stops = plan.stops;
  st.plan = plan.nodes;
  st.step = plan.nodes.length > 1 ? 1 : 0;
  st.onPlan = false;
  return plan;
}

/** Forget the mission; keep knowing where we are. */
function fieldClearMission(st) {
  st.stops = []; st.plan = []; st.step = 0; st.onPlan = false;
  return st;
}

/**
 * Best estimate of the pose, right now.
 *
 * Between codes this is the anchor plus however far the dead reckoning has
 * moved since — rotated into the field frame, because route.js starts every
 * run pointing at its own zero and the field does not care which way that was.
 * The rotation is the difference of the two bearings at the anchor, so both
 * the drift *and* the arbitrary starting heading are cancelled at every read.
 *
 * With no anchor there is no answer: an unlocalised robot is not at the origin
 * of the field, it is somewhere, and drawing it at D1 would be a lie the map
 * tells confidently.
 */
function fieldPose(st, route) {
  const a = st.anchor;
  if (!a) return { known: false, x: null, y: null, bearing: null, since: null };
  if (!route || a.rx === null) {
    return { known: true, x: a.x, y: a.y, bearing: a.bearing, since: 0, dead: 0 };
  }
  const th = (a.bearing - a.rb) * Math.PI / 180;
  const dx = (Number(route.x) || 0) - a.rx;
  const dy = (Number(route.y) || 0) - a.ry;
  const c = Math.cos(th), s = Math.sin(th);
  return {
    known: true,
    x: fieldRound(a.x + dx * c + dy * s),
    y: fieldRound(a.y + dy * c - dx * s),
    bearing: fieldRound((((Number(route.bearing) || 0) + a.bearing) % 360 + 360) % 360, 1),
    // How much of this is measured and how much is a guess: the distance dead
    // reckoned since the last code. Past a couple of metres, believe the map
    // less than you believe the next QR.
    dead: fieldRound(Math.hypot(dx, dy), 2),
  };
}

/** The box the whole field fits in, padded — the drawing's viewport. */
function fieldBounds(map, pad = 0.9) {
  const m = map || FIELD;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of m.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad,
           w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

/**
 * Everything a page or a log needs, in one object.
 *
 * Assembled here rather than in the status frame so the server and the tests
 * describe the robot's position the same way, and so /dashboard does not have
 * to re-derive an instruction that has already been worked out.
 */
function fieldStatus(st, route, map) {
  const m = map || FIELD;
  const pose = fieldPose(st, route);
  const legs = fieldLegs(st.plan, m);
  return {
    qr: st.qr,
    at: st.at || null,
    from: st.from,
    to: st.to,
    sure: st.sure,
    known: pose.known,
    pose,
    // The two frames, side by side at the moment of the last code. A page
    // needs it to draw the dead-reckoned trail on the field at all: the trail
    // is in route coordinates and this is the only thing that says where those
    // coordinates were on the field.
    anchor: st.anchor,
    turn: fieldTurnAt(st, m),
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

function fieldRound(v, n = 3) { return Math.round(v * 10 ** n) / 10 ** n; }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FIELD, FIELD_STRAIGHT_DEG, FIELD_BACK_DEG, FIELD_TURN_LABEL,
                     fieldNode, fieldLinks, fieldEdge, fieldQrId, fieldQr, fieldQrs,
                     fieldBearing, fieldDist, fieldWrapDeg, fieldTurn,
                     fieldPath, fieldPlan, fieldLegs,
                     fieldState, fieldSee, fieldTurnAt, fieldMission, fieldClearMission,
                     fieldPose, fieldBounds, fieldStatus };
}
