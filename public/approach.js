/**
 * The pallet manoeuvre: how the robot gets its forks into a pallet at a
 * station, and how it puts one down again.
 *
 * Pure, like plc.js, field.js and scenario.js: no camera, no clock, no serial
 * port. It says what the manoeuvre IS — the steps, in order, with the G-code
 * for the ones that are just distance — and approach_run.js is what runs it
 * against a real line and a real board.
 *
 * ── Why there is a manoeuvre at all ──────────────────────────────────
 *
 * The forks are on the end of the robot the camera is NOT on. The camera has
 * to lead, because following the line is how the robot arrives square at the
 * station at all — so it arrives with its forks pointing the wrong way, and
 * the last two metres cannot be driven, they have to be turned round.
 *
 * Six steps, and the middle four are the turn-round:
 *
 *      1  find    the line is in front of the camera
 *      2  align   square up on it — this is what makes the rest repeatable
 *      3  line    follow it forward by `along` …
 *      4  back    … straight back the same distance …
 *      5  turn    … 180° on the spot …
 *      6  in      … and the same distance forward again, forks first
 *      7  lift    15 s of actuator, up for a pick and down for a drop
 *
 * Steps 3 and 6 cover the same ground in opposite directions, so the robot
 * finishes step 6 where it finished step 3 with its forks where its camera
 * was: `along` is "how far past the pallet the robot has to be before a 180°
 * would leave the forks able to reach it", and the robot is 130 cm long, so
 * that is where the default comes from. Step 4 exists because the 180° has to
 * happen in the clear space the robot just drove through, not on top of the
 * pallet.
 *
 * All four distances are settable. The default is the robot's own length for
 * each, which is the right first guess and the wrong final answer: the pallet
 * is where the pallet is, and the numbers get measured on the field.
 *
 * ── Which way is forward ─────────────────────────────────────────────
 *
 * The camera is bolted to the end of the chassis that marlin.js's DIRECTIONS
 * calls the BACK — rover.js drives /follow's stream with the wheels swapped
 * and negated for exactly that reason, and /gcode's manualVec() flips W and S
 * for it too. This manoeuvre is written in the camera's frame, because that is
 * the frame the line is seen and followed in, so every straight line of G-code
 * here is scenarioLine()'s opposite one. `camFront` in the geometry turns that
 * off, for a robot whose camera is moved to the other end.
 */

const APPROACH_DEFAULTS = {
  // The robot, nose to forks. Every distance below defaults to it.
  rover_mm: 1300,
  along_mm: 0,          // 0 = rover_mm: how far along the line, past the pallet
  back_mm: 0,           // 0 = along_mm: straight back, to turn in clear space
  turn_deg: 180,
  in_mm: 0,             // 0 = along_mm: forward again, forks first
  lift_s: 15,           // the actuator, up at a pick and down at a drop
  // Clocks. Each step gives up after its own, because a manoeuvre that is
  // stuck has to say so rather than hold the lap open for ever.
  find_s: 15,           // to see the line at all
  align_s: 25,          // to square up on it
  line_s: 90,           // to drive `along` down it
  // Following the line. `speed` is the pilot's straight-line demand, in the
  // same percent /follow's slider sets; the manoeuvre is a crawl, not a lap.
  speed: 16,
  // Square on the line: |near| and |far| both under `tol`, this many frames
  // running. Two numbers, because near alone is a robot sitting on the line
  // pointing off it, and far alone is one pointing along it from beside it.
  tol: 0.12,
  square: 5,
};

/** Read one number out of the saved settings, falling back to the default. */
function approachNum(cfg, key) {
  const v = Number((cfg || {})[key]);
  return Number.isFinite(v) && v > 0 ? v : APPROACH_DEFAULTS[key];
}

/**
 * The four distances a manoeuvre is made of, in millimetres and degrees.
 * Each one that is not set falls back to the one before it, and the first
 * falls back to the robot's own length.
 */
function approachMm(cfg = {}) {
  const rover = approachNum(cfg, 'rover_mm');
  const along = Number(cfg.along_mm) > 0 ? Number(cfg.along_mm) : rover;
  const back = Number(cfg.back_mm) > 0 ? Number(cfg.back_mm) : along;
  const inMm = Number(cfg.in_mm) > 0 ? Number(cfg.in_mm) : along;
  const turn = Number.isFinite(Number(cfg.turn_deg)) && Number(cfg.turn_deg) !== 0
    ? Number(cfg.turn_deg) : APPROACH_DEFAULTS.turn_deg;
  return { rover, along, back, in: inMm, turn };
}

/**
 * One straight or one pivot, as the G-code line that drives it — in the
 * camera's frame. See the header for why forward and back are swapped.
 *
 * @param {'forward'|'back'|'left'|'right'} kind
 * @param {number} amount  mm, or degrees for a pivot
 * @param {object} geom    scenarioLine()'s geometry, plus camFront
 */
function approachGcode(kind, amount, geom = {}) {
  const flip = { forward: 'back', back: 'forward' };
  const k = geom.camFront ? kind : (flip[kind] || kind);
  return scenarioLine(k, amount, geom);
}

const approachM = (mm) => `${(mm / 1000).toFixed(2)} m`;

/**
 * The whole manoeuvre, as the list of steps to run.
 *
 * @param {'pick'|'drop'} kind
 * @param {object} cfg   APPROACH_DEFAULTS overrides — follow.json's `approach`
 * @param {object} geom  scenarioLine()'s geometry: circumference, track,
 *                       mmPerRev, feed, invert, camFront
 * @returns {{ok: boolean, why: string|null, kind: string, mm: object,
 *            steps: object[]}}
 *   A step is {n, kind, label, …}: `find`, `align` and `line` are driven by
 *   the camera (`ms` is how long each may take, `mm` how far `line` goes),
 *   `move` is one G-code line, `lift` is the actuator for `ms`.
 */
function approachPlan(kind, cfg = {}, geom = {}) {
  const mm = approachMm(cfg);
  const up = kind !== 'drop';
  const secs = (k) => Math.round(approachNum(cfg, k) * 1000);
  const steps = [
    { n: 1, kind: 'find', label: 'xətt axtarılır', ms: secs('find_s') },
    { n: 2, kind: 'align', label: 'xəttə nizamlanır', ms: secs('align_s') },
    { n: 3, kind: 'line', label: `xətt üzrə ${approachM(mm.along)} irəli`,
      mm: mm.along, ms: secs('line_s') },
    // `measured`: how far the robot actually came is what these two drive,
    // unless `key` was pinned in the settings. The runner rebuilds the line
    // when it sends it — see approach_run.js — because the plan was made
    // before the robot had driven anywhere.
    { n: 4, kind: 'move', label: `düz geri ${approachM(mm.back)}`,
      cmd: approachGcode('back', mm.back, geom), mm: -mm.back,
      measured: true, key: 'back_mm', dir: 'back' },
    { n: 5, kind: 'move', label: `${Math.round(Math.abs(mm.turn))}° dönüş`,
      cmd: approachGcode(mm.turn > 0 ? 'right' : 'left', Math.abs(mm.turn), geom),
      deg: mm.turn },
    { n: 6, kind: 'move', label: `çəngəllərlə ${approachM(mm.in)} irəli`,
      cmd: approachGcode('forward', mm.in, geom), mm: mm.in,
      measured: true, key: 'in_mm', dir: 'forward' },
    { n: 7, kind: 'lift', label: `aktuator ${up ? 'yuxarı' : 'aşağı'} ${approachNum(cfg, 'lift_s')} s`,
      dir: up ? 'up' : 'down', ms: secs('lift_s') },
  ];
  // A missing measurement is a missing G-code line, and a manoeuvre with a
  // hole in it must not start: the robot would turn round and drive nowhere.
  const bad = steps.find((s) => s.kind === 'move' && !s.cmd);
  return {
    ok: !bad,
    why: bad ? 'tekerlek çevresi, iz genişliği ya da kartın mm/tur değeri yok — /plc-də ölç' : null,
    kind: up ? 'pick' : 'drop', mm, steps,
  };
}

/** The pilot's settings while a manoeuvre follows the line: a crawl. */
function approachPilot(cfg = {}, pilot = {}) {
  const speed = approachNum(cfg, 'speed');
  return { ...pilot, base: speed, max: Math.max(speed, Number(pilot.max) || speed) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { APPROACH_DEFAULTS, approachMm, approachGcode, approachPlan,
                     approachPilot, approachNum };
}
