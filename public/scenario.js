/**
 * Scenarios: G-code the team writes for the legs of a lap.
 *
 * Pure, like plc.js and field.js: the page edits and checks with it, the server
 * runs with it (scenario_run.js), and test/test_scenario.mjs checks both halves
 * with no board attached.
 *
 * A scenario is plain Marlin G-code, one command per line, written by the team
 * on /plc for one leg of the field — "A2'den kapıya", "kapıdan geçiş",
 * "B3'e yük bırakma" — and started with a button. Nothing here decides a route
 * or reads a QR: it sends what was written, in order, and says how far it got.
 *
 * Two things are added around what was written, because without them a
 * scenario would be unsafe to stop or would break the next thing to drive:
 *
 *   · M400 after every motion line. Marlin acknowledges a G1 when it is
 *     *planned*, not when it is done, so without it "line 3 of 10" would be a
 *     lie by up to sixteen moves and STOP would let all of them run. With it,
 *     the next line waits for the robot, and STOP stops after the current move.
 *   · G91 at the end, and after a stop. The hand-drive and follow streams send
 *     relative moves; a scenario that switched to G90 would otherwise turn the
 *     next W press into "drive to X-5 absolute".
 */

/** The legs, in the order a lap drives them. */
const SCENARIO_SLOTS = [
  { id: 'A1_KAPI',   group: 'Alımdan kapıya',      label: 'A1 → kapı' },
  { id: 'A2_KAPI',   group: 'Alımdan kapıya',      label: 'A2 → kapı' },
  { id: 'A3_KAPI',   group: 'Alımdan kapıya',      label: 'A3 → kapı' },
  { id: 'KAPI_GIT',  group: 'Kapı',                label: 'Kapıdan geçiş (B tarafına)' },
  { id: 'B1_BIRAK',  group: 'Yük bırakma',         label: 'Kapıdan B1 · yük bırak' },
  { id: 'B2_BIRAK',  group: 'Yük bırakma',         label: 'Kapıdan B2 · yük bırak' },
  { id: 'B3_BIRAK',  group: 'Yük bırakma',         label: 'Kapıdan B3 · yük bırak' },
  { id: 'B1_KAPI',   group: 'Dönüş',               label: 'B1 → kapı' },
  { id: 'B2_KAPI',   group: 'Dönüş',               label: 'B2 → kapı' },
  { id: 'B3_KAPI',   group: 'Dönüş',               label: 'B3 → kapı' },
  { id: 'KAPI_DON',  group: 'Dönüş',               label: 'Kapıdan geri geçiş (A tarafına)' },
  { id: 'KAPI_BASLA', group: 'Dönüş',              label: 'Kapı → başlangıç' },
];

/** Longest scenario accepted, in commands. A lap is tens, not thousands. */
const SCENARIO_MAX_LINES = 500;

/** A command that moves something, and so gets an M400 after it. */
const SCENARIO_MOTION = /^G0?[0-3]\b|^G28\b|^G29\b/;

/**
 * Commands a scenario may not send.
 *
 * M112 halts the board until it is reset; M500–M502 rewrite or reset its
 * EEPROM. None of those is a step in a lap, and each is a very bad surprise
 * when a typo or a pasted snippet triggers it on the field.
 */
const SCENARIO_REFUSED = {
  M112: 'acil durdurma kartı kilitler — senaryoda kullanılmaz',
  M500: "EEPROM'a yazar — senaryoda kullanılmaz",
  M501: "EEPROM'dan yükler — senaryoda kullanılmaz",
  M502: 'kart ayarlarını fabrikaya döndürür — senaryoda kullanılmaz',
};

function scenarioSlot(id) {
  return SCENARIO_SLOTS.find((s) => s.id === id) || null;
}

/**
 * The text as written → the commands to send, or what is wrong with it.
 *
 * Comments are Marlin's own: `;` to the end of the line and `( … )`. A line is
 * accepted if it starts with a G, M or T code — anything else is a typo, and a
 * typo is reported with its line number rather than sent to a board that will
 * answer "Unknown command" and carry on with the next move.
 *
 * @returns {{ok: boolean, commands: string[], errors: {line: number, text: string, why: string}[]}}
 */
function scenarioParse(text) {
  const commands = [];
  const errors = [];
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
    if (!line) return;
    const code = (line.match(/^([GMT]\d+)/) || [])[1];
    if (!code) {
      errors.push({ line: i + 1, text: raw.trim(), why: 'G, M ya da T komutu değil' });
      return;
    }
    const norm = code.replace(/^([GMT])0+(\d)/, '$1$2');
    if (SCENARIO_REFUSED[norm]) {
      errors.push({ line: i + 1, text: raw.trim(), why: SCENARIO_REFUSED[norm] });
      return;
    }
    commands.push(line);
  });
  if (commands.length > SCENARIO_MAX_LINES) {
    errors.push({ line: 0, text: '', why: `${commands.length} komut — en fazla ${SCENARIO_MAX_LINES}` });
  }
  return { ok: errors.length === 0 && commands.length > 0, commands, errors };
}

/**
 * What actually goes to the board: the commands, an M400 after each move, and
 * G91 at the end. See the header for why both.
 */
function scenarioProgram(commands) {
  const out = [];
  for (const c of commands) {
    out.push({ cmd: c, step: true });
    if (SCENARIO_MOTION.test(c)) out.push({ cmd: 'M400', step: false });
  }
  out.push({ cmd: 'G91', step: false });
  return out;
}

// ── the helper on /plc: a distance in millimetres → the G-code line ────

/**
 * Wheel millimetres → axis millimetres on the board.
 *
 * The board counts in its own mm, which are "mm per motor revolution" (from
 * M92) — nothing to do with how far a wheel rolls. One wheel revolution is
 * `circumference` mm on the floor and `mmPerRev` mm on the board, so the
 * factor is their ratio.
 */
function scenarioAxisMm(wheelMm, geom) {
  const circ = Number(geom && geom.circumference);
  const perRev = Number(geom && geom.mmPerRev);
  if (!(circ > 0) || !(perRev > 0)) return null;
  return (Number(wheelMm) || 0) * perRev / circ;
}

const scenarioFmt = (v) => (Math.round(v * 100) / 100).toFixed(2);

/**
 * One line for a helper button, in the board's own directions.
 *
 * The signs are DIRECTIONS in marlin.js: forward is X- Y+, a right pivot is
 * X- Y-. `invert` is the /gcode page's per-axis direction swap, applied here
 * because a scenario is raw G-code and does not go through the jogger that
 * would otherwise apply it.
 *
 * @param {'forward'|'back'|'right'|'left'|'lift'|'wait'} kind
 * @param {number} amount  mm, degrees, mm of fork, or seconds
 * @param {object} geom    {circumference, track, mmPerRev, feed, liftFeed, invert:{X,Y}, liftInvert}
 * @returns {string|null} the line, or null when a measurement is missing
 */
function scenarioLine(kind, amount, geom = {}) {
  const n = Number(amount) || 0;
  const feed = Math.max(1, Math.round(Number(geom.feed) || 3000));
  const sx = geom.invert && geom.invert.X ? -1 : 1;
  const sy = geom.invert && geom.invert.Y ? -1 : 1;
  const move = (wx, wy) => {
    const ax = scenarioAxisMm(Math.abs(n), geom);
    if (ax == null) return null;
    return `G1 X${scenarioFmt(wx * ax * sx)} Y${scenarioFmt(wy * ax * sy)} F${feed}`;
  };
  switch (kind) {
    case 'forward': return move(-1, +1);
    case 'back': return move(+1, -1);
    case 'right':
    case 'left': {
      const track = Number(geom.track);
      if (!(track > 0)) return null;
      // Pivoting on the spot, each wheel rolls an arc of the circle whose
      // diameter is the track: angle/360 of π × track.
      const wheel = (Math.abs(n) / 360) * Math.PI * track;
      const ax = scenarioAxisMm(wheel, geom);
      if (ax == null) return null;
      const d = kind === 'right' ? -1 : +1;
      return `G1 X${scenarioFmt(d * ax * sx)} Y${scenarioFmt(d * ax * sy)} F${feed}`;
    }
    case 'lift': {
      const z = n * (geom.liftInvert ? -1 : 1);
      return `G1 Z${scenarioFmt(z)} F${Math.max(1, Math.round(Number(geom.liftFeed) || 240))}`;
    }
    case 'wait':
      return `G4 P${Math.max(0, Math.round(n * 1000))}`;
    default:
      return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SCENARIO_SLOTS, SCENARIO_MAX_LINES, SCENARIO_REFUSED, scenarioSlot,
                     scenarioParse, scenarioProgram, scenarioAxisMm, scenarioLine };
}
