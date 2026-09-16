/**
 * The run — a list of moves, and which junction is which.
 *
 * Pure, like field.js, road.js and pilot.js: state in, observation in, decision
 * out, no clock and no DOM of its own. /follow steps it once per frame and
 * test/test_mission.mjs drives it with made-up frames.
 *
 * ── The problem ──────────────────────────────────────────────────────
 *
 * A1, A2 and A3 are the same station three times over. They are the same
 * distance up identical branches off three identical junctions, and no camera
 * looking at one of them can say which it is. Neither can the odometer on its
 * own: it is open loop, it drifts, and "I have driven 4.24 m" is not "I am at
 * J2" on a field where a wheel slipping once puts those half a metre apart.
 *
 * So neither half answers it and both halves together do:
 *
 *   the camera says   a junction is HERE, NOW, with a branch on the left
 *   the map says      the next junction is 1.79 m along, and it is J2
 *   together          this is J2 — and now the odometer is right again
 *
 * That last clause is the part worth the file. Every junction the two agree on
 * is a place with a known position, so the drift is thrown away three or four
 * times a lap instead of accumulating for the whole of it. Between junctions
 * the rover is dead reckoning; at them it is not guessing at all.
 *
 * And when they disagree — a junction where the map says there is none, or
 * none where the map says there is — that is worth *saying*, not worth quietly
 * picking one. A rover that turns at the wrong junction arrives at the wrong
 * station and reports success. See `lost`.
 *
 * ── A run is a list of moves ─────────────────────────────────────────
 *
 * Not everything on this field can be done by following a line. Getting out of
 * the start area, turning round to put the fork on the load, backing into it —
 * none of those has a line to follow, and two of them happen with the line
 * squarely out of shot. So a run is a queue of steps, and following a line is
 * only one kind of step:
 *
 *   go      drive forward, blind, a measured distance
 *   back    the same, in reverse
 *   spin    turn on the spot, blind, through a measured angle
 *   seek    sweep until the line is found again, then hand back to the pilot
 *   follow  the line, counting junctions — most of this file
 *   wait    hold here until somebody says carry on
 *
 * The rule the field imposes is that **every blind step is followed by a
 * seek**. A blind move ends wherever the wheels put it, which after 27 % of
 * scale error and an unknown floor is not exactly where it was asked to be;
 * `seek` is what turns "about there" back into "on the line", and the line is
 * the only thing here that can say so.
 *
 * ── The 27 % ─────────────────────────────────────────────────────────
 *
 * 100 mm of commanded travel is 125–130 mm on the floor. The board is set up
 * for an Ender-3's X axis — 80 steps/mm of a belt — and this is a rover on
 * wheels, so the number was never going to be right.
 *
 * That is *two* problems, not one, and they need separating:
 *
 *   the 27 %   systematic, and therefore removable. `scale` below.
 *   the ± 2 %  the spread between 125 and 130: floor, slip, tyre wear. Not
 *              removable by any constant, and the reason a blind step can
 *              never be trusted past a metre or two.
 *
 * The scale is applied HERE, at the one boundary where commanded millimetres
 * become ground millimetres, rather than in rover.js — because it must reach
 * the heading too. A pivot is two wheels running opposite ways, so a chassis
 * asked to turn 90° with an uncorrected scale turns 115°, and no amount of
 * correcting the distance afterwards recovers that. Scale the wheels and both
 * come right together; scale the pose and only one does.
 *
 * The ± 2 % is not corrected, it is *budgeted*: the window a junction has to
 * appear in gets wider the further the rover has driven since it last knew
 * where it was. See `gateM`.
 *
 * ── What it does not do ──────────────────────────────────────────────
 *
 * It does not steer a line. pilot.js steers, and it already knows how to take
 * a square turn — creep up, pivot, pick the road up on the far side. All this
 * does is hand it a corner at the moment the map says to turn, so the pilot
 * cannot tell a junction from a corner and does not have to. Deciding WHEN is
 * here, because that needs the map; doing it is there, because that needs the
 * wheels.
 *
 * The map run does not read QR codes. On the day every junction will have one
 * and the count below becomes a check on something certain rather than the
 * certainty itself. Nothing here has to change for that: a QR read is a better
 * anchor than a junction sighting and goes in the same place — see
 * missionSee().
 *
 * ── The cargo run ────────────────────────────────────────────────────
 *
 * The second kind of run, and the one that does read them — see
 * missionCargo() at the bottom. No map: the way from the start area to a
 * slot's line is TAUGHT — the slot's scenario, a step at a time (routes.js
 * records each step off the wire while a person drives it on /gcode) — and
 * the server drives it again from memory. Everything
 * after that is seen, and is the same queue of moves with six more kinds:
 *
 *   path    a taught leg, driven by the server; this only waits for it
 *   qr      the slot's QR, read while moving — creep along the line until it
 *           has been; the wrong code is a stop
 *   align   put the axle on the row the QR codes stand on
 *   hop     along that row, blind, until the wanted code passes underneath
 *   trace   follow the line until its paint runs out
 *   lift    run the actuator for a measured time
 *
 * The pickup lines are parallel and start on one row, so one taught scenario
 * reaches all three: the other two are along the row from it (align, hop).
 * And the rover is 1.20 m long, so no turn happens anywhere its sweep would
 * reach a load — see missionReach() and the `roverLenM` block.
 */

const MISSION_DEFAULTS = {
  // ── the machine ──
  //
  // Ground travelled per millimetre commanded. MEASURED: 100 mm asked for
  // comes out as 125–130 mm on the floor, so 1.275 is the middle of it and
  // `scaleTol` is the half-width. Re-measure it and change it here; nothing
  // else in the project holds a second copy.
  //
  // The alternative is to fix it at the board with `M92 X62.7 Y62.7`
  // (80 ÷ 1.275) so that a commanded millimetre IS a millimetre. That is the
  // better fix and the README says so — but it changes every feedrate and
  // every distance /gcode quotes, so it is a decision rather than a patch, and
  // until it is taken this is what makes the map right.
  scale: 1.275,
  scaleTol: 0.02,
  // Wheel demand during a blind step. Slow, because a blind move is being
  // counted out by arithmetic and arithmetic is more wrong the faster a wheel
  // slips.
  manPct: 12,
  seekPct: 9,

  // ── believing a junction ──
  //
  // How far down the picture a junction must have come before the rover acts
  // on it: 0 at the top of the ROI, 1 under the wheels. Short of the pilot's
  // own `cornerAt`, because by the time this fires the decision is already
  // made — the pilot is handed a corner that says "now" and does its own
  // creeping from there.
  commitAt: 0.72,
  // How far from where the map says the junction is a sighting may be, in
  // metres, and still be believed to be that junction — plus `scaleTol` of
  // everything driven since the last anchor, because that is where the
  // irreducible part of the 125–130 mm lives.
  //
  // The base is the knob to widen if the rover starts calling real junctions
  // strangers, and to narrow if it starts believing shadows. A metre is about
  // a third of the shortest gap between two junctions (J1→J2 is 1.79 m), so a
  // sighting cannot be inside two windows at once.
  gateM: 1.0,
  // How far in front of the axle the rover is looking when it says "junction,
  // now" — the camera is mounted ahead of the wheels and `commitAt` is part
  // way up the frame on top of that, so a sighting is a statement about a
  // place the rover has not reached yet.
  //
  // Anchoring without it credits the rover with this much distance it has not
  // driven, on every junction, always in the same direction — and a bias that
  // never changes sign is the one kind dead reckoning cannot average away.
  // It shows up at the far end as a station approach that stops short.
  //
  // MEASURE IT: drive up to a junction until the page reports one, stop, and
  // measure from the axle to the paint. It is the same quantity as the pilot's
  // `creepCm`, which exists for the same reason.
  leadM: 0.20,
  // How far past the window the rover may drive before giving up on ever
  // seeing the junction. Past this the count is wrong, and driving on is
  // driving to the wrong station.
  overM: 1.2,

  // ── the opening ──
  //
  // How far to drive out of the start area before looking for anything. The
  // line does run through the başlangıç alanı, but the rover is placed in it
  // by hand and the first thing in front of the camera there is as likely to
  // be the pallet as the line. So: move first, look second.
  //
  // Set it to 0 for a rover that starts already lined up and can see it.
  openM: 0.6,

  // ── finding the line again ──
  //
  // The sweep after a blind step. `seekDeg` is how far it turns before
  // reversing, `seekMax` is the total it will turn before admitting the line
  // is not there, and `seekVotes` is how many frames of line end the sweep —
  // one frame is a reflection going past.
  seekDeg: 35,
  seekMax: 400,
  seekVotes: 3,
  // Finding the line is not the same as being on it. `seekNear` is how close
  // to the middle of the frame the line has to sit before the sweep is called
  // finished, in the same −1..+1 the pilot steers by, and `seekTurn` is the
  // most it will turn trying to get it there before settling for what it has.
  //
  // This half matters most where there is no pilot afterwards to tidy up: the
  // back-in at a station is blind, so whatever heading error is left when the
  // sweep ends is carried straight into it. At 0.25 m of reverse, 25° of
  // leftover error is 10 cm of the fork arriving sideways.
  seekNear: 0.12,
  seekTurn: 60,

  // ── the fork ──
  //
  // MEASURE BOTH OF THESE. They are the only two numbers in this file that
  // come from the chassis rather than from the şartname or from a measurement
  // already taken, and they are placeholders.
  //
  // `forkM` is from the point the rover pivots about — the middle of the
  // driven axle — to where the load sits on the fork. It is what makes the
  // approach stop SHORT: the rover parks its axle `forkM + dockBackM` before
  // the zone, turns round, and the fork ends up in it.
  //
  // `dockBackM` is the last bit, driven in reverse after the turn, so the fork
  // slides under the pallet rather than the whole rover arriving at it in one
  // movement it cannot correct.
  forkM: 0.35,
  dockBackM: 0.25,
  // Which way round to turn at a station. Either is fine on this field — the
  // branch ends in open floor — so this exists to be changed if the chassis
  // turns better one way than the other.
  dockSpin: 180,

  // ── the rover's size: turning near a load ──
  //
  // The rover is 1.20 m long, fork included — measured, not a placeholder.
  // A turn on the spot sweeps a circle round the pivot (the middle of the
  // driven axle), and a load inside that circle gets hit. missionReach() is
  // its radius: pivot to the furthest corner.
  //
  // Where along those 1.20 m the axle sits decides the radius, and THAT has
  // not been measured. `axleM` null means "do not know", and the reach is then
  // the worst case — the pivot at one end, the whole length swinging round:
  // hypot(1.20, 0.35) = 1.25 m. MEASURE `axleM` (the camera end to the axle
  // centre) and the reach becomes the longer of the two overhangs.
  //
  // `roverWideM` is the pallet's 700 mm (Şekil 4) — the widest the rover ever
  // is, carrying one. A wider chassis: change it. `clearM` is the gap kept on
  // top, because every one of these numbers is ± a few centimetres.
  roverLenM: 1.20,
  roverWideM: 0.70,
  axleM: null,
  clearM: 0.10,
  // Şekil 6, dimensioned: from the start of a pickup line — where its QR code
  // is — to the near edge of the zone the load stands in.
  loadGapM: 1.50,

  // ── one scenario, three slots ──
  //
  // The three pickup lines are parallel and start on one row: Şekil 1 draws
  // q2, q3 and q4 level with each other, 1.79 m apart. So one taught scenario
  // is enough — to ANY slot's line — and the others are reached from there
  // along that row, by reading the QR codes on it. See missionCargo().
  //
  // `rowM` is where the axle stands, along the line from its QR, to turn onto
  // the row: 0 is over the QR, so the camera then runs straight over the next
  // slot's code. It is clamped to missionTurnRoom() — the turn has to clear
  // the load 1.5 m up the line — and with the worst-case reach that room is
  // only 0.15 m, which is why the rover must not turn anywhere further up.
  //
  // `qrSeeM`: axle → the bottom edge of the camera's picture. A code last seen
  // while the rover drives over it is this far ahead of the axle, so it is
  // what turns "the reader saw ALIM2" into "the axle is here". MEASURE IT —
  // and if in doubt, err small: too big a number walks the rover towards the
  // load. Short of `leadM`, because commitAt is part way UP the picture.
  // `qrNowS`: how recently a code must have been seen to be in shot NOW.
  // `hopPct` is the row's speed — slow, for the reader's sake — and `hopOverM`
  // how far past where the map puts the slot the row may run before stopping.
  // `alignFindM`: how far to back up looking for a code the rover drove past.
  rowM: 0,
  // How square to the line the rover must be before it turns onto the row, in
  // the seek's −1..+1 (seekNear's 0.12 is about 3.6°). The row is blind, so
  // every degree left over here is 3 cm sideways per 1.8 m of row, and
  // A1 → A3 is two of those: at 0.12 the camera went past ALIM3 22 cm to one
  // side (test_mission's yard). 0.03 is about 1°: 7 cm at A3 in the same
  // yard, inside the turn room's `clearM` even when it drifts towards a load.
  rowNear: 0.03,
  qrSeeM: 0.15,
  qrNowS: 0.4,
  hopPct: 8,
  hopOverM: 0.5,
  alignFindM: 1.0,

  // ── the cargo run ──
  //
  // The QR is read WHILE THE ROVER MOVES. The reader runs all the time, on
  // the server (qr.js, 5 frames a second), and the slot's code seen at any
  // moment of the run — along the taught leg, during the sweep — counts.
  // Only if it has not been seen by the time the rover is on the line does
  // the `qr` step do anything of its own: it creeps along the line at
  // `qrCreepPct`, slow enough for the reader to get several looks at a code
  // as it goes by, for at most `qrCreepM` of ground or `qrWaitS` armed
  // seconds. Line following proper — the trace — starts once it has been read.
  //
  // `qrFreshS` is how recently a code must have been SEEN to count as the one
  // in front of the rover — seen_age_s in qr.js, not age_s: a code that came
  // into view during the sweep is not read "again" when the sweep ends, it is
  // simply still there.
  qrWaitS: 8,
  qrCreepM: 0.6,
  qrCreepPct: 8,
  qrFreshS: 1.5,
  // Frames of "the paint ends here" before a trace believes it, and the least
  // distance it drives first, so a trace cannot end on the frame it starts in.
  endVotes: 3,
  traceMinM: 0.10,
  // The most a trace follows a slot's line looking for its end. The stubs are
  // 2.7 m; past this the end was missed and the next thing is a wall.
  traceMaxM: 4.0,
  // How long the actuator runs up to take the load. MEASURE IT: the time the
  // lift takes to raise the fork clear, plus a little. The server cuts any
  // run at its own `--act-max-s` whatever this says.
  liftS: 5,
};

// ── the queue ────────────────────────────────────────────────────────

/** Fresh state, with nothing to do. */
function missionState() {
  return {
    phase: 'idle',        // idle | blind | seek | run | turn | gate | done | lost
    target: null,         // where the run is going
    plan: [],             // the nodes it goes through
    steps: [],            // the junctions on the way, with what to do at each
    idx: 0,               // how many of them are behind us
    finish: 0,            // metres from the last junction to where the run stops
    q: [],                // the moves, in order
    qi: 0,                // which one is running
    man: null,            // that move's own counter, while it runs
    pose: null,           // field.js's dead reckoning
    corner: null,         // what to hand the pilot this frame, or null
    drive: null,          // wheel demand that OVERRIDES the pilot, or null
    pending: null,        // the junction being turned at, for the second anchor
    why: 'boş',
    seen: 0,              // junctions actually confirmed, for the readout
    missed: 0,            // …and windows that closed with nothing in them
    // ── the cargo run only ──
    cargo: null,          // the slot, 1..3, while this is a cargo run
    runId: 0,             // names this run's replays, so an old "done" is not ours
    traced: null,         // how far the trace to the load went, for the way back
    replay: null,         // a taught leg the server should drive, this frame
    act: null,            // what the lift should be doing, this frame: 'up' | 'down' | null
    qrWant: null,         // the folded text the slot's QR must have
    qrOk: null,           // { text, move } once it has been seen, on the move
    qrHits: {},           // every code seen since the run began: key → { text, move }
    qrAt: {},             // key → `odo` when that code was last in shot (not on a taught leg)
    odo: 0,               // signed ground metres driven, forward positive
    odoLog: [],           // [armed seconds, odo], the last few seconds of it
    pathDoneT: 0,         // armed seconds when the last taught leg finished
    via: null,            // whose scenario the run drives: the slot itself, or a neighbour
    runT: 0,              // armed seconds since the run began
    crept: 0,             // metres the QR step crept along the line
    creep: null,          // this frame: the QR step's speed ceiling, percent
  };
}

/**
 * The circle a turn on the spot sweeps: pivot to the furthest corner, metres.
 * Worst case — the whole length swinging round — until `axleM` is measured.
 */
function missionReach(cfg) {
  const c = { ...MISSION_DEFAULTS, ...(cfg || {}) };
  const len = Math.max(0, Number(c.roverLenM) || 0);
  const a = c.axleM == null ? NaN : Number(c.axleM);
  const arm = a >= 0 && a <= len ? Math.max(a, len - a) : len;
  return Math.hypot(arm, Math.max(0, Number(c.roverWideM) || 0) / 2);
}

/**
 * How far up a pickup line, from its QR, the axle may be and still turn
 * through any angle without touching the load. Negative: nowhere on the line.
 */
function missionTurnRoom(cfg) {
  const c = { ...MISSION_DEFAULTS, ...(cfg || {}) };
  return c.loadGapM - missionReach(c) - c.clearM;
}

/**
 * How far to back away from a load before the 180° in front of it.
 *
 * The trace stops when the paint disappears under the pallet, and that
 * happens about `leadM` in front of the axle — the same place in the picture
 * a junction is committed at. Turning there swings the rover's far end
 * straight through the load. So it backs off until the whole circle clears,
 * and the back-in after the turn is longer by the same amount.
 */
function missionBackOff(cfg) {
  const c = { ...MISSION_DEFAULTS, ...(cfg || {}) };
  return Math.max(0, missionReach(c) + c.clearM - c.leadM);
}

/**
 * Point a run at a station.
 *
 * `from` and `heading` are where the rover is starting: the başlangıç alanı
 * pointing north, before the first run, and wherever the last one ended after
 * that. Both are the map's, not the camera's — there is nothing to see yet.
 *
 * The queue it builds is the whole plan for the run, built here rather than
 * decided step by step, so that /map can show it and a person can read it
 * before pressing anything.
 */
function missionSet(st, targetId, from = 'START', heading = 0, cfg, map) {
  const c = { ...MISSION_DEFAULTS, ...(cfg || {}) };
  const target = fieldNode(targetId, map);
  const start = fieldNode(from, map);
  const plan = fieldPlan(from, targetId, map);
  if (!target || plan.length < 2) {
    Object.assign(st, missionState());
    st.why = `${targetId} bilinmir`;
    return st;
  }

  const junctions = fieldJunctions(plan, heading, map);
  const legs = fieldLegs(plan, heading, map);
  const total = legs.reduce((a, l) => a + l.len, 0);

  // Each junction carries the distance from the one before it rather than from
  // the start, because that is what the odometer will actually be holding:
  // it is reset at every junction, so a window measured from the start would
  // be measured from a number that no longer exists.
  st.steps = junctions.map((j, i) => ({
    ...j, leg: j.at - (i ? junctions[i - 1].at : 0),
  }));

  // Where the FOLLOW stops, which at a station is short of the station: the
  // fork is on the back, so the rover parks its axle far enough before the
  // zone that turning round puts the fork in it. Anywhere that is not a
  // station — the door, a junction — is driven to outright.
  const docks = target.kind === 'pick' || target.kind === 'drop';
  const lastAt = junctions.length ? junctions[junctions.length - 1].at : 0;
  st.finish = total - lastAt - (docks ? c.forkM + c.dockBackM : 0);

  st.q = [
    // Out of the start area blind — see `openM`.
    ...(start && start.kind === 'start' && c.openM > 0
        ? [{ kind: 'go', m: c.openM }, { kind: 'seek' }] : []),
    { kind: 'follow' },
    // At a station: turn round, make sure the line is still there, then back
    // the fork in. At the door: stop and wait to be let through.
    ...(docks
        ? [{ kind: 'spin', deg: c.dockSpin }, { kind: 'seek' },
           { kind: 'back', m: c.dockBackM }]
        : []),
    ...(target.kind === 'gate' ? [{ kind: 'wait' }] : []),
  ];

  st.target = target.id;
  st.plan = plan;
  st.cargo = null;
  st.runId = 0;
  st.traced = null;
  st.idx = 0;
  st.qi = 0;
  st.man = null;
  st.seen = 0;
  st.missed = 0;
  st.corner = null;
  st.drive = null;
  st.pending = null;
  st.pose = fieldState(from, heading, map);
  st.phase = missionPhaseOf(st);
  st.why = `${target.id}: ${st.steps.length} qovşaq, ${st.q.length} hərəkət`;
  return st;
}

/** The step being run, or null once the queue is empty. */
function missionMove(st) {
  return st.qi < st.q.length ? st.q[st.qi] : null;
}

/** The phase a step shows up as. Kept apart so the two names cannot drift. */
function missionPhaseOf(st) {
  const mv = missionMove(st);
  if (!mv) return 'done';
  if (mv.kind === 'seek') return 'seek';
  if (mv.kind === 'follow' || mv.kind === 'trace') return 'run';
  if (mv.kind === 'wait') return 'gate';
  if (mv.kind === 'path') return 'path';
  if (mv.kind === 'qr') return 'qr';
  if (mv.kind === 'hop') return 'hop';
  if (mv.kind === 'lift') return 'lift';
  return 'blind';
}

/** Finish the current step and start the next. */
function missionNextMove(st) {
  st.qi += 1;
  st.man = null;
  st.drive = null;
  st.phase = missionPhaseOf(st);
  return st;
}

/** The junction being driven towards, or null once they are all behind us. */
function missionNext(st) {
  return st.idx < st.steps.length ? st.steps[st.idx] : null;
}

/** How far the rover should have driven since the last anchor to be there. */
function missionLeg(st) {
  const n = missionNext(st);
  return n ? n.leg : st.finish;
}

/**
 * A junction, confirmed: put the rover on it and take the next step.
 *
 * This is the anchor, and it is deliberately the only way `idx` ever moves.
 * A QR read, when there is one, comes through here too — same node, same
 * reset, better evidence.
 */
function missionSee(st, nodeId, bearing, lead, map) {
  fieldAnchor(st.pose, nodeId, bearing, map);
  // Standing `lead` metres SHORT of it, because that is where the rover is
  // when it can see it — see `leadM`. The pose keeps the node's coordinates
  // rather than being backed off them: a few centimetres of position is worth
  // less than a heading that is exactly right, and it is the count that the
  // next leg is measured with anyway.
  st.pose.run = -(Number(lead) || 0);
  st.idx += 1;
  st.seen += 1;
  return st;
}

// ── one frame ────────────────────────────────────────────────────────

/**
 * @param st   state from missionState()
 * @param obs  { junction, end, bands, near, dLeftMm, dRightMm, turning }
 *             junction/end/bands/near straight off roadError(); the two mm
 *             figures are what rover.js **asked the wheels for** since the
 *             last call — commanded, not ground, because commanded is what the
 *             page can know. The scale is applied here.
 * @param cfg  MISSION_DEFAULTS, or the page's copy of it
 */
function missionStep(st, obs, cfg) {
  const c = { ...MISSION_DEFAULTS, ...(cfg || {}) };
  const o = obs || {};
  st.corner = null;
  st.drive = null;
  st.creep = null;
  // Both are levels, not events: asked for on every frame the step wants
  // them, and absent the moment it does not. The page turns the edges into
  // commands, so a run that stops for any reason at all stops asking.
  st.replay = null;
  st.act = null;

  const mv = missionMove(st);
  if (st.phase === 'idle' || st.phase === 'lost' || !mv) {
    if (st.phase !== 'idle' && st.phase !== 'lost') st.phase = 'done';
    return missionOut(st);
  }

  // Commanded millimetres become ground millimetres exactly here, once, before
  // anything looks at them — so the pose, the windows and every blind step's
  // own counter are all in the same units, and all of them are the floor's.
  const k = Number(c.scale) > 0 ? Number(c.scale) : 1;
  fieldStep(st.pose, (Number(o.dLeftMm) || 0) * k, (Number(o.dRightMm) || 0) * k);
  st.odo += st.pose.ds;
  if (st.cargo) missionQrLook(st, mv, o, c);

  switch (mv.kind) {
    case 'go':
    case 'back':
      missionGoStep(st, mv, c);
      break;
    case 'spin':
      missionSpinStep(st, mv, c);
      break;
    case 'seek':
      missionSeekStep(st, mv, o, c);
      break;
    case 'wait':
      st.why = 'qapı — fabrika sistemini gözləyir';
      break;
    case 'path':
      missionPathStep(st, mv, o);
      break;
    case 'qr':
      missionQrStep(st, mv, o, c);
      break;
    case 'align':
      missionAlignStep(st, mv, o, c);
      break;
    case 'hop':
      missionHopStep(st, mv, o, c);
      break;
    case 'trace':
      missionTraceStep(st, mv, o, c);
      break;
    case 'lift':
      missionLiftStep(st, mv, o);
      break;
    default:
      missionFollowStep(st, o, c);
  }
  return missionOut(st);
}

/**
 * A blind straight line, counted out in ground metres.
 *
 * There is nothing to look at during one of these — that is what makes it
 * blind — so it ends on its own arithmetic, and the arithmetic is only as good
 * as `scale`. Which is why nothing longer than a metre or so is ever asked of
 * one, and why the step after it is always a `seek`.
 */
function missionGoStep(st, mv, c) {
  const rev = mv.kind === 'back';
  if (!st.man) st.man = { done: 0 };
  st.man.done += Math.abs(st.pose.ds);
  const left = mv.m - st.man.done;
  // `clear`: the back-off in front of a load, so the turn after it clears.
  const what = mv.clear ? 'dönmək üçün yükdən geri' : rev ? 'geri' : 'düz';
  if (left <= 0) {
    st.why = `${what} ${mv.m.toFixed(2)} m bitdi`;
    missionNextMove(st);
    return;
  }
  const p = rev ? -c.manPct : c.manPct;
  st.drive = { p25: p, p26: p };
  st.why = `${what} — ${left.toFixed(2)} m qaldı`;
}

/**
 * A blind turn on the spot, counted out in ground degrees.
 *
 * Named apart from the junction turn because it is a different thing: that one
 * is handed to the pilot and ended by the line coming back, this one is
 * counted and ended by arithmetic. The 180° at a station HAS to be this kind —
 * the pilot's way of ending a turn is "the road is in front of me again", and
 * on a line you are standing on that is true at 0° as well as at 180°.
 *
 * The angle comes out of the same wheel millimetres as everything else, so it
 * carries the same ± 2 %: about 4° on a half turn, plus whatever the track
 * width is wrong by. The `seek` after it is what picks that up.
 */
function missionSpinStep(st, mv, c) {
  if (!st.man) st.man = { done: 0 };
  st.man.done += Math.abs(st.pose.dth) * 180 / Math.PI;
  const want = Math.abs(mv.deg);
  const left = want - st.man.done;
  if (left <= 0) {
    st.why = `${want}° döndü`;
    missionNextMove(st);
    return;
  }
  // Left wheel forward and right wheel back swings the nose to the right —
  // the same sign convention fieldStep integrates with, deliberately, so a
  // turn cannot be commanded one way and reckoned the other.
  const dir = mv.deg >= 0 ? 1 : -1;
  st.drive = { p25: c.manPct * dir, p26: -c.manPct * dir };
  st.why = `dönür — ${left.toFixed(0)}° qaldı`;
}

/**
 * Sweep until the line is there.
 *
 * This is the step that makes every blind move survivable. A blind move puts
 * the rover somewhere near where it was asked to be; a sweep turns "near" back
 * into "on it". Nothing else in a blind step has to be accurate, because this
 * is here.
 *
 * The sweep grows: `seekDeg` one way, then twice that back the other, then
 * twice again — so the first guess is that the line is close, and the rover
 * only commits to a full turn once the close guesses have failed. It gives up
 * at `seekMax` rather than spinning for ever, because a rover turning on the
 * spot is not looking for the line, it is just turning.
 *
 * It runs in two halves, and the second one is the one that is easy to leave
 * out. FINDING the line only gets the rover to within however wide the
 * detector's acceptance is — a good half of a right angle — and that is not
 * the same as being ON it. So once the line is in shot the sweep stops hunting
 * and starts CENTRING: turn towards it until it sits in the middle of the
 * frame. Where a pilot follows next this is only a head start; where one does
 * not — the blind back-in at a station — it is the whole of the alignment.
 *
 * `soft` is the one seek that does not sweep: the one after the 180° in front
 * of a load, once the rover has backed off far enough for its 1.20 m to turn
 * (missionBackOff()). There the camera, facing away from the load, looks at
 * the first few centimetres of paint at best — the rover is standing on the
 * rest of it. If the line is in shot it centres on it as usual; if not, it
 * does NOT go hunting: the heading was exact a moment ago (the trace had the
 * pilot on the line, the back-off was straight) and the 180° is counted to
 * ± 2 %, which a sweep looking at bare floor could only make worse.
 */
function missionSeekStep(st, mv, o, c) {
  if (!st.man) st.man = { done: 0, leg: 0, dir: 1, votes: 0, first: true, on: 0 };
  const m = st.man;
  const step = Math.abs(st.pose.dth) * 180 / Math.PI;
  m.done += step;
  m.leg += step;

  if ((o.bands || 0) >= 2) m.votes += 1; else m.votes = 0;
  if (m.votes >= c.seekVotes) {
    // ── found: now centre on it ──
    const near = Number(o.near);
    m.on += step;
    const good = mv.near != null ? mv.near : c.seekNear;
    if (!Number.isFinite(near) || Math.abs(near) <= good || m.on >= c.seekTurn) {
      st.why = Number.isFinite(near) && Math.abs(near) > good
        ? `xətt tapıldı, tam ortalanmadı (${near.toFixed(2)})`
        : `xətt ortalandı (${m.done.toFixed(0)}° axtardı)`;
      missionNextMove(st);
      return;
    }
    // The line to the right of the frame means the rover is pointing left of
    // it, so turn the way the line is: the same sign the pilot steers with.
    const dir = near > 0 ? 1 : -1;
    st.drive = { p25: c.seekPct * dir, p26: -c.seekPct * dir };
    st.why = `ortalayır — ${near.toFixed(2)}`;
    return;
  }

  if (mv.soft) {
    m.look = (m.look || 0) + 1;
    if (m.look >= c.seekVotes * 4) {
      st.why = 'xətt kadrda deyil — sayılmış 180° ilə davam, axtarmadan';
      missionNextMove(st);
      return;
    }
    st.drive = { p25: 0, p26: 0 };
    st.why = 'xəttə baxır — yerində';
    return;
  }

  if (m.done >= c.seekMax) {
    st.phase = 'lost';
    st.why = `xətt tapılmadı — ${m.done.toFixed(0)}° tarandı`;
    return;
  }

  // Half width on the first leg and full width on every one after, so the
  // sweep stays centred on the heading the rover arrived with.
  if (m.leg >= c.seekDeg * (m.first ? 1 : 2)) {
    m.leg = 0;
    m.first = false;
    m.dir = -m.dir;
  }
  st.drive = { p25: c.seekPct * m.dir, p26: -c.seekPct * m.dir };
  st.why = `xətt axtarır — ${m.done.toFixed(0)}°`;
}

/**
 * Follow the line, counting junctions.
 *
 * Everything the file header is about, and unchanged in shape from before
 * there was a queue: it is simply the longest of the steps, and the only one
 * with something to look at the whole way.
 */
function missionFollowStep(st, o, c) {
  // ── mid-manoeuvre ──
  // The pilot owns a junction turn once it has been handed one. Nothing is
  // decided here until it says it has finished, because a junction is in the
  // picture for the whole of a pivot and would be counted again on every
  // frame of it.
  if (st.phase === 'turn') {
    if (o.turning) { st.why = 'dönür'; return; }
    // The turn is over, so anchor a second time — same node, the other
    // bearing. This is not tidying up: the pilot creeps a camera-to-axle
    // offset past the junction before it pivots and then turns by however
    // much the wheels happened to slip, so the pose coming out of a turn is
    // the worst it ever is, and it is the only moment on the whole run when
    // the exact heading is known without looking at anything.
    // No lead this time: the pilot creeps the camera up to the junction before
    // it pivots, so when the turn ends the axle really is on it.
    if (st.pending) fieldAnchor(st.pose, st.pending.id, st.pending.bearing);
    st.pending = null;
    st.phase = 'run';
    st.why = 'döndü';
    return;
  }

  const next = missionNext(st);
  const leg = missionLeg(st);
  const run = st.pose.run;

  // ── the last leg ──
  // Every junction is behind us; what is left is a station at a known
  // distance. There is nothing to see at a station — the paint simply runs
  // out past it — so this is odometry, with `end` as the thing that says so
  // out loud when it arrives early.
  if (!next) {
    const short = o.end && o.end.dist >= c.commitAt;
    if (run >= leg || short) {
      st.why = short && run < leg ? 'boya bitdi — dayandı' : `${st.target}: yerində`;
      // Deliberately NOT anchored onto the node. At a station the follow stops
      // `forkM + dockBackM` short of it, and saying so — leaving the pose where
      // the rover actually is — is what keeps the next run's first window
      // measured from the right place.
      missionNextMove(st);
      return;
    }
    st.why = `${st.target}-ə ${(leg - run).toFixed(2)} m`;
    return;
  }

  // ── the gate ──
  // Nothing about the picture changes at the factory door. It is reached on
  // the odometer alone, and then waited at.
  if (next.kind === 'gate') {
    if (run >= leg) {
      // The gate is reached by counting, not by seeing, so there is no lead to
      // take off: the rover stops where the odometer says, wherever that is.
      missionSee(st, next.id, next.into == null ? st.pose.h : next.into, 0);
      st.why = 'qapıya çatdı';
    } else {
      st.why = `qapıya ${(leg - run).toFixed(2)} m`;
    }
    return;
  }

  // ── a junction ──
  const j = o.junction || null;
  // The window widens with everything driven since the last anchor: that is
  // where the irreducible part of the 125–130 mm has been accumulating, and
  // pretending otherwise makes the rover disbelieve real junctions at the far
  // end of a long leg.
  const window = c.gateM + c.scaleTol * Math.abs(leg);
  const inWindow = Math.abs(run - leg) <= window;
  // The map says which way the branch leaves; the camera says which way it
  // sees one. Requiring them to agree is what makes this a check rather than
  // a count — and it costs nothing, because a junction the rover drives
  // straight through makes no demand at all.
  const sideOk = next.act === 'straight'
              || (next.act === 'left' ? !!(j && j.left) : !!(j && j.right));

  if (j && j.dist >= c.commitAt && inWindow && sideOk) {
    // The bearing to anchor with is the one the rover is on NOW — it has not
    // turned yet. Anchoring with the outgoing bearing here would credit the
    // rover with a turn it is about to make, and then the pivot would make it
    // again on top: a 90° error that dead reckoning has no way to notice.
    missionSee(st, next.id, next.into, c.leadM);
    if (next.act === 'straight') {
      st.why = `${next.id} — düz`;
    } else {
      // Hand the pilot a corner that says "now". The decision of WHEN has
      // already been made, here, with the map — so `dist` is 1 rather than
      // whatever the picture measured, and the pilot goes straight to its
      // creep instead of waiting for a sighting to come further down a frame
      // it is no longer the only judge of.
      st.corner = { dir: next.act === 'right' ? 1 : -1, dist: 1, band: 0, over: 0.5 };
      st.pending = { id: next.id, bearing: next.bearing };
      st.phase = 'turn';
      st.why = `${next.id} — ${next.act === 'right' ? 'sağa' : 'sola'}`;
    }
    return;
  }

  // ── driven past it ──
  // The window has closed with nothing in it. That is not a junction missed,
  // it is the COUNT being wrong from here on: every junction after this one
  // would be taken for its neighbour and the rover would arrive somewhere
  // else and call it success. Stopping and saying so is the only honest
  // option — see the file header.
  if (run > leg + window + c.overM) {
    st.missed += 1;
    st.phase = 'lost';
    st.why = `${next.id} görünmədi — ${run.toFixed(2)} m sürüldü, ${leg.toFixed(2)} m gözlənilirdi`;
    return;
  }

  st.why = j && !inWindow ? `qovşaq var, yeri tutmur (${run.toFixed(2)} m)`
         : j && !sideOk ? `qovşaq var, qolu tutmur (${j.side})`
         : `${next.id}-ə ${(leg - run).toFixed(2)} m`;
}

/** Everything a page or a log needs, and nothing it has to reach inside for. */
function missionOut(st) {
  const next = missionNext(st);
  const mv = missionMove(st);
  return {
    phase: st.phase,
    target: st.target,
    move: mv ? mv.kind : null,
    moves: st.q.length,
    mi: st.qi,
    next: next ? next.id : null,
    act: next ? next.act : 'arrive',
    left: missionLeg(st) - (st.pose ? st.pose.run : 0),
    corner: st.corner,
    drive: st.drive,
    why: st.why,
    seen: st.seen,
    steps: st.steps.length,
    idx: st.idx,
    pose: st.pose ? fieldPose(st.pose) : null,
    cargo: st.cargo,
    via: st.via,
    replay: st.replay,
    act: st.act,
    // The `qr` step's speed ceiling for the pilot, in percent, while it creeps
    // along the line reading; null means the pilot's own speeds.
    creep: st.creep,
    qrOk: st.qrOk ? st.qrOk.text : null,
  };
}

/**
 * The factory automation said carry on.
 *
 * A person, for now. The şartname's PLC simulator speaks UDP on
 * 192.168.100.100:1515 and answers a status packet with "bekle" or "başla";
 * until that is written, this is the whole of it, and a human pressing a
 * button is a fair stand-in for a door nobody can open yet.
 */
function missionResume(st) {
  const mv = missionMove(st);
  if (mv && mv.kind === 'wait') { missionNextMove(st); st.why = 'qapı açıldı'; }
  return st;
}

// ── the cargo run ────────────────────────────────────────────────────

/**
 * A cargo run: fetch the load from slot `slot` and take it to the door.
 *
 *   1  path   the taught way from the start area to the slot's line
 *   2  seek   find the line and centre on it
 *   3  qr     read the slot's QR — the wrong one, or none, is a stop
 *   4  trace  follow the line until its paint runs out, at the load
 *   5  back   away from the load, until a turn clears it (missionBackOff())
 *   6  spin   180° — the fork is on the other end
 *   7  seek   the line again, square to it
 *   8  back   the fork under the load: step 5 again, plus `dockBackM`
 *   9  lift   the actuator up for `liftS`
 *  10  trace  back along the line to where step 4 began
 *  11  path   the taught way from there to the door — if one was taught
 *
 * Step 3 is the reason the QR exists. Three slots, three identical stubs of
 * line: a taught route that drifted half a metre puts the rover on the
 * NEIGHBOUR's line, and nothing about the paint says so. The code does. A
 * wrong code is therefore a stop, not a warning — the failure it catches is
 * the one that looks like success.
 *
 * Step 5 is the rover's 1.20 m. The paint disappears under the pallet about
 * `leadM` in front of the axle, and a 180° there puts the far end of the rover
 * through the load; backing off first, and backing in by as much more after,
 * leaves the fork exactly where it used to end up.
 *
 * Step 10 ends at whichever comes first: the paint running out, or the
 * distance step 4 drove plus the back-in. Either is "where it started", and
 * the taught leg 2 begins there — that is where it has to be taught from.
 *
 * ── One scenario is enough ───────────────────────────────────────────
 *
 * The three pickup lines are parallel and begin on one row, each with its QR
 * code at its start (Şekil 1, Şekil 6). So a slot with no scenario of its own
 * is reached through a neighbour's — `opt.via` — and the QR row:
 *
 *   path   the NEIGHBOUR's scenario, to its line
 *   seek   centre on that line
 *   qr     the neighbour's code — proof the row starts where the map says
 *   align  axle onto the row: `rowM` from the QR, never beyond the turn room
 *   spin   90° towards the slot
 *   hop    along the row, blind, until the slot's code passes under the camera
 *   spin   90° back, facing up the slot's line
 *   seek   centre on it
 *   qr     the slot's code — read on the row already, so this passes at once
 *   …and on from step 4.
 *
 * The two 90° turns are where the 1.20 m matters. Both happen with the axle on
 * the row, 1.5 m short of a load, and missionTurnRoom() says whether a turn
 * there clears it — a run that cannot turn without touching one is refused
 * before it arms.
 *
 * @param opt.qrKey  the folded text the slot's QR must have (qr.js's key)
 * @param opt.keys   { 1, 2, 3 } — every slot's key, for the row
 * @param opt.have   { to, out } — which of the slot's two legs are taught
 * @param opt.via    whose scenario to drive: the slot itself, a neighbour, or
 *                   null for none. routes.js picks it (RouteBook.via()).
 *                   Absent: the slot's own, if it has one.
 * @param opt.runId  names this run's replays; anything unique per run
 */
function missionCargo(st, slot, opt = {}, cfg, map) {
  const c = { ...MISSION_DEFAULTS, ...(cfg || {}) };
  const have = opt.have || {};
  Object.assign(st, missionState());
  const n = Number(slot);
  if (!(n >= 1 && n <= 3)) {
    st.why = `yuva ${slot} yoxdur`;
    return st;
  }
  const via = opt.via !== undefined ? (opt.via == null ? null : Number(opt.via))
            : (have.to ? n : null);
  // Refused up front, not discovered at step 1: a run that cannot get to its
  // line should not arm, drive nothing, and then say so.
  if (!(via >= 1 && via <= 3)) {
    st.why = `A${n} ssenarisi öyrədilməyib, başqa yuvanınkı da — /gcode-da «Ssenarilər»də birini öyrət`;
    return st;
  }
  const keys = { 1: 'ALIM1', 2: 'ALIM2', 3: 'ALIM3', ...(opt.keys || {}) };
  if (opt.qrKey) keys[n] = opt.qrKey;

  const hop = via !== n;
  let row = [];
  if (hop) {
    const a = fieldNode(`A${via}`, map), b = fieldNode(`A${n}`, map);
    const room = missionTurnRoom(c);
    if (!a || !b) {
      st.why = `A${via} → A${n}: xəritədə yoxdur`;
      return st;
    }
    if (room < 0) {
      st.why = `A${via}-dən A${n}-ə keçmək olmur — rover ${missionReach(c).toFixed(2)} m radiusla `
             + `dönür, QR-dan yükə ${c.loadGapM} m var (${c.clearM} m ehtiyat). `
             + `axleM-i ölç, ya da A${n} ssenarisini öyrət`;
      return st;
    }
    const dir = Math.sign(b.x - a.x);        // +1: east, a right turn facing the loads
    row = [
      { kind: 'qr', want: keys[via], slot: via },
      { kind: 'align', want: keys[via], at: Math.min(c.rowM, room) },
      // Square to the line before the row, tighter than any other seek: the
      // row is blind, and it runs on whatever heading this leaves.
      { kind: 'seek', near: c.rowNear },
      { kind: 'spin', deg: 90 * dir },
      { kind: 'hop', want: keys[n], slot: n, m: Math.abs(b.x - a.x),
        // Codes past the slot, in the direction of travel: one of those in
        // shot means the slot's own went by unread.
        beyond: [1, 2, 3].filter((k) => (k - n) * dir > 0).map((k) => keys[k]) },
      { kind: 'spin', deg: -90 * dir },
      { kind: 'seek' },
    ];
  }

  const off = missionBackOff(c);
  st.cargo = n;
  st.via = via;
  st.runId = opt.runId || 1;
  st.qrWant = keys[n];
  st.q = [
    { kind: 'path', leg: 'to', slot: via },
    { kind: 'seek' },
    ...row,
    { kind: 'qr', want: st.qrWant, slot: n },
    { kind: 'trace' },
    ...(off > 0 ? [{ kind: 'back', m: off, clear: true }] : []),
    { kind: 'spin', deg: c.dockSpin },
    // Soft after a back-off: see missionSeekStep().
    { kind: 'seek', soft: off > 0 },
    ...(c.dockBackM + off > 0 ? [{ kind: 'back', m: Math.max(0, c.dockBackM) + off }] : []),
    { kind: 'lift', dir: 'up', s: c.liftS },
    { kind: 'trace', home: true },
    ...(have.out ? [{ kind: 'path', leg: 'out', slot: n }] : []),
  ];
  // No map here — a pose is kept only because every blind step counts itself
  // out in its ds and dth. Where on the field it says the rover is means
  // nothing, and /follow does not send it to /map.
  st.pose = fieldState('START', 0, map);
  st.phase = missionPhaseOf(st);
  st.why = (hop ? `A${n}: A${via} ssenarisi, sonra QR sırası ilə — ` : `yuva ${n}: `)
         + `${st.q.length} hərəkət`
         + (have.out ? '' : ' — qapı yolu öyrədilməyib, xəttin başında bitir');
  return st;
}

/**
 * What the QR reader says, kept for the run — every frame of a cargo run.
 *
 * Two things, for two different questions. `qrHits`: has this code been read
 * at any moment since the run began — the `qr` step's question, answered on
 * the move. "Since the run began" is the min(): a code last seen a second
 * before the run started was in front of the rover somewhere else.
 *
 * `qrAt`: where, on the signed odometer, the code was last IN SHOT — `align`'s
 * and `hop`'s question, "how far is the axle from it now". Looked up in a few
 * seconds of odometer history at the moment the reader last saw it, not taken
 * as "now": the reader goes on saying "seen 0.3 s ago" while the rover keeps
 * rolling, and 0.3 s of rolling is centimetres of error in the one number
 * that decides how close to a load the next turn is. Not recorded for a moment
 * inside a taught leg: the server drives those, this page does not count
 * their wheels, and a position read off a counter that was not counting would
 * be a guess.
 */
function missionQrLook(st, mv, o, c) {
  st.runT += Number(o.dt) || 0;
  st.odoLog.push([st.runT, st.odo]);
  while (st.odoLog.length > 2 && st.odoLog[1][0] < st.runT - 3) st.odoLog.shift();
  const q = o.qr;
  if (!q || !q.key || q.seen_age_s == null) return;
  if (q.seen_age_s <= Math.min(c.qrFreshS, st.runT) && !st.qrHits[q.key]) {
    st.qrHits[q.key] = { text: q.text, move: mv.kind };
  }
  if (!st.qrOk && st.qrHits[st.qrWant]) st.qrOk = st.qrHits[st.qrWant];
  const t = st.runT - q.seen_age_s;
  if (mv.kind !== 'path' && q.seen_age_s <= c.qrNowS && t >= 0 && t >= st.pathDoneT) {
    st.qrAt[q.key] = missionOdoAt(st, t);
  }
}

/** The odometer at armed second `t`, from the log — the last entry not after it. */
function missionOdoAt(st, t) {
  const log = st.odoLog;
  for (let i = log.length - 1; i >= 0; i--) if (log[i][0] <= t + 1e-9) return log[i][1];
  return log.length ? log[0][1] : st.odo;
}

/** The code `key` in the reader's picture right now — not a second ago. */
function missionQrNow(st, o, key, c) {
  const q = o.qr;
  return !!(q && q.key === key && q.seen_age_s != null
            && q.seen_age_s <= Math.min(c.qrNowS, st.runT));
}

/**
 * Put the axle on the QR row: `mv.at` metres up the line from the code.
 *
 * The one place a code's position is known exactly is where it LEAVES the
 * picture: the bottom edge, `qrSeeM` in front of the axle. So:
 *
 *   still in shot     creep forward until it leaves — anywhere higher in the
 *                     picture is further off by an amount nothing measures
 *   left the shot     the axle is `qrSeeM` short of it at that moment, plus
 *                     whatever the odometer has counted since — drive to `at`
 *   never seen here   only along the taught leg, whose wheels were not
 *                     counted: back up until it comes into shot again, then
 *                     as above
 *
 * Forward is always the right way to creep: `at` is never below −`qrSeeM`,
 * because a run whose turn room is negative is refused before it arms.
 */
function missionAlignStep(st, mv, o, c) {
  if (!st.man) st.man = { find: 0, left: null, dir: 0 };
  const m = st.man;
  if (m.left === null) {
    const at = st.qrAt[mv.want];
    if (missionQrNow(st, o, mv.want, c)) {
      st.drive = { p25: c.manPct, p26: c.manPct };
      st.why = `${mv.want} kadrda — kadrdan çıxana qədər irəli`;
      return;
    }
    if (at == null) {
      m.find += Math.abs(st.pose.ds);
      if (m.find > c.alignFindM) {
        st.phase = 'lost';
        st.why = `${mv.want} arxada qaldı — ${m.find.toFixed(2)} m geri getdi, görünmədi`;
        return;
      }
      st.drive = { p25: -c.manPct, p26: -c.manPct };
      st.why = `${mv.want} yolda keçilib — geri, kadra girənə qədər`;
      return;
    }
    const p = st.odo - at - c.qrSeeM;     // the axle, along the line from the code
    m.left = mv.at - p;
    m.dir = Math.sign(m.left);
  } else {
    m.left -= st.pose.ds;
  }
  if (m.dir === 0 || m.left * m.dir <= 0.005) {
    st.why = `QR sırasında — ${mv.want}-dan ${mv.at.toFixed(2)} m`;
    missionNextMove(st);
    return;
  }
  st.drive = { p25: c.manPct * m.dir, p26: c.manPct * m.dir };
  st.why = `QR sırasına ${m.dir > 0 ? 'irəli' : 'geri'} — ${Math.abs(m.left).toFixed(2)} m`;
}

/**
 * Along the QR row, blind, until the slot's code has passed under the camera.
 *
 * There is no paint on the row — the pickup lines begin on it and run away
 * from it — so this is counted, like `go`, but it does not END on the count.
 * It ends on the code: last seen `qrSeeM` ahead of the axle, so once the
 * rover has gone that much further the axle is over it, and the line starts
 * right there. The count is only the limit: the map's distance plus
 * `hopOverM`, and past that the code was missed.
 *
 * A code from beyond the slot in shot means the same thing, sooner. The
 * codes of the slots in between are passed on the way and mean nothing.
 */
function missionHopStep(st, mv, o, c) {
  if (!st.man) st.man = { done: 0, from: st.odo - st.pose.ds };
  const m = st.man;
  m.done += Math.abs(st.pose.ds);
  const q = o.qr;
  if (q && mv.beyond.includes(q.key) && missionQrNow(st, o, q.key, c)) {
    st.phase = 'lost';
    st.why = `${q.text} göründü — A${mv.slot} keçildi, QR-ı oxunmadı`;
    return;
  }
  // Where the slot's code was last in shot, on the odometer — see
  // missionQrLook(). Only a sighting made on this row counts.
  const at = st.qrAt[mv.want];
  const seen = at != null && at >= m.from ? at : null;
  if (seen !== null && st.odo - seen >= c.qrSeeM && !missionQrNow(st, o, mv.want, c)) {
    st.why = `${mv.want} altında — A${mv.slot} xəttinə dönür (${m.done.toFixed(2)} m)`;
    missionNextMove(st);
    return;
  }
  if (m.done > mv.m + c.hopOverM) {
    st.phase = 'lost';
    st.why = `${mv.want} görünmədi — QR sırası ilə ${m.done.toFixed(2)} m getdi, `
           + `A${mv.slot} ${mv.m.toFixed(2)} m-də olmalı idi`;
    return;
  }
  st.drive = { p25: c.hopPct, p26: c.hopPct };
  st.why = seen !== null ? `${mv.want} oxundu — üstünə çıxır`
         : `QR sırası ilə A${mv.slot}-ə — ${m.done.toFixed(2)}/${mv.m.toFixed(2)} m`;
}

/**
 * A taught leg. The server drives it (routes.js's Replayer); this step asks
 * for it by name on every frame and waits for the answer under its own id.
 *
 * The wheels are held at zero meanwhile — `drive` rather than nothing, because
 * with no drive the pilot would be steering, and the pilot's answer to "I
 * cannot see a line" is to give up and disarm, halfway along a route that
 * has no line on it by design.
 */
function missionPathStep(st, mv, o) {
  const id = `${st.runId}:${st.qi}`;
  // Whose leg: a run that reaches its slot along the QR row drives the
  // NEIGHBOUR's scenario (missionCargo()), so the slot is on the move itself.
  const slot = mv.slot || st.cargo;
  st.drive = { p25: 0, p26: 0 };
  const r = o.replay;
  if (r && r.id === id) {
    if (r.err) { st.phase = 'lost'; st.why = `yol: ${r.err}`; return; }
    // Aborted is DAYAN, a lost socket, a closed tab. The rover is somewhere
    // along a blind route, and starting it again from the top would drive the
    // whole route again from the wrong place.
    if (r.aborted) { st.phase = 'lost'; st.why = 'yaddaşdan yol yarımçıq qaldı'; return; }
    if (r.done) {
      // Nothing seen before now can be placed on the odometer: the server
      // moved the rover and this page counted none of it.
      st.pathDoneT = st.runT;
      st.why = mv.leg === 'out' ? 'qapıya çatdı' : 'yol bitdi — xətti axtarır';
      missionNextMove(st);
      return;
    }
    st.replay = { id, slot, leg: mv.leg };
    // Paused by a PLC bekle: the server holds the route where it is and carries
    // on from there on devam, so this page just keeps waiting for ITS done.
    st.why = r.paused ? `fasilə — ${r.held || 'PLC bekle'} · ${r.seg}/${r.of}`
                      : `yaddaşdan gedir — ${r.seg}/${r.of}`;
    return;
  }
  st.replay = { id, slot, leg: mv.leg };
  st.why = mv.leg === 'out' ? 'qapıya yol başlayır'
         : slot !== st.cargo ? `A${slot} ssenarisi başlayır — oradan QR sırası ilə A${st.cargo}-ə`
         : `yuva ${st.cargo}-ə yol başlayır`;
}

/**
 * The slot's QR, read on the move.
 *
 * Usually over before it starts: the code was seen along the taught leg or
 * during the sweep (missionStep() keeps `st.qrOk`), and the trace — line
 * following — begins at once. Otherwise the rover creeps along the line at
 * `qrCreepPct` with the pilot steering, so the reader gets its looks at a code
 * coming towards it, and stops if it has not read it within `qrCreepM` of
 * ground or `qrWaitS` armed seconds.
 *
 * `o.qr` is the server's reader status (qr.js), `o.dt` the seconds this frame
 * covered — only counted while armed, so a page left disarmed in front of a
 * blank wall does not time out a run nobody is running.
 */
function missionQrStep(st, mv, o, c) {
  if (!st.man) st.man = { t: 0, m: 0 };
  const m = st.man;
  m.t += Number(o.dt) || 0;
  m.m += Math.abs(st.pose.ds);
  // The run's own slot, or — on a run along the QR row — the neighbour whose
  // scenario it drove, checked before the row is trusted to start there.
  const mine = mv.want === st.qrWant;
  // The way back has to know the rover went further along the line than the
  // trace alone measured — see missionTraceStep(). Only on the slot's own
  // line: creeping up the neighbour's is undone by `align` before the row.
  if (mine) st.crept = m.m;
  const hit = st.qrHits[mv.want];
  if (hit) {
    st.why = `QR doğrudur: ${hit.text} — ${mine ? 'xətt izlənir' : 'QR sırasına çıxır'}`;
    missionNextMove(st);
    return;
  }
  const q = o.qr;
  const fresh = !!(q && q.key && q.seen_age_s != null && q.seen_age_s <= c.qrFreshS);
  if (fresh) {
    st.phase = 'lost';
    st.why = `səhv QR: ${q.text} — gözlənilən ${mv.want}. Bu başqa yuvadır`;
    return;
  }
  if (m.m >= c.qrCreepM || m.t >= c.qrWaitS) {
    st.phase = 'lost';
    st.why = q && q.available === false
      ? `QR oxunmadı — oxuyucu işləmir (${q.err || 'naməlum'})`
      : `QR oxunmadı — xətlə ${m.m.toFixed(2)} m getdi, ${m.t.toFixed(1)} s, ${mv.want} görünmədi`;
    return;
  }
  st.creep = c.qrCreepPct;
  st.why = `QR axtarır, yavaş irəliləyir — ${mv.want} (${m.m.toFixed(2)}/${c.qrCreepM} m)`;
}

/**
 * Follow the line until the paint runs out. The pilot steers — this only
 * decides when it is over, and measures how far that was.
 */
function missionTraceStep(st, mv, o, c) {
  if (!st.man) st.man = { done: 0, votes: 0 };
  const m = st.man;
  m.done += Math.abs(st.pose.ds);
  m.votes = o.end && o.end.dist >= c.commitAt ? m.votes + 1 : 0;

  if (m.done >= c.traceMinM && m.votes >= c.endVotes) {
    if (!mv.home) st.traced = m.done;
    st.why = mv.home ? `xəttin başına qayıtdı (${m.done.toFixed(2)} m)`
                     : `xəttin sonu — yük burada (${m.done.toFixed(2)} m)`;
    missionNextMove(st);
    return;
  }
  if (mv.home) {
    // Back to where the rover found the line: the distance the outward trace
    // drove, what the QR step crept before it, and the back-in that took the
    // rover further along the same line.
    const back = (st.traced || 0) + (st.crept || 0) + (c.dockBackM > 0 ? c.dockBackM : 0);
    if (st.traced != null && m.done >= back) {
      st.why = `əvvəlki nöqtəyə qayıtdı (${m.done.toFixed(2)} m)`;
      missionNextMove(st);
      return;
    }
    st.why = `xətlə geri — ${Math.max(0, back - m.done).toFixed(2)} m`;
    return;
  }
  if (m.done >= c.traceMaxM) {
    st.phase = 'lost';
    st.why = `xəttin sonu tapılmadı — ${m.done.toFixed(2)} m getdi`;
    return;
  }
  st.why = `xətti izləyir — ${m.done.toFixed(2)} m`;
}

/** Run the lift for a measured time, standing still. */
function missionLiftStep(st, mv, o) {
  if (!st.man) st.man = { t: 0 };
  st.man.t += Number(o.dt) || 0;
  st.drive = { p25: 0, p26: 0 };
  if (st.man.t >= mv.s) {
    st.why = `yük götürüldü — aktuator ${mv.s} s ${mv.dir === 'up' ? 'yuxarı' : 'aşağı'}`;
    missionNextMove(st);
    return;
  }
  st.act = mv.dir;
  st.why = `aktuator ${mv.dir === 'up' ? 'yuxarı' : 'aşağı'} — ${(mv.s - st.man.t).toFixed(1)} s`;
}
