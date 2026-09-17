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
  { id: 'BASLA_A1',  group: 'Başlangıçtan alıma',  label: 'Başlangıç → A1 · yük al' },
  { id: 'BASLA_A2',  group: 'Başlangıçtan alıma',  label: 'Başlangıç → A2 · yük al' },
  { id: 'BASLA_A3',  group: 'Başlangıçtan alıma',  label: 'Başlangıç → A3 · yük al' },
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

// ── teaching: what was driven → the text ────────────────────────────

/**
 * The G-code that reached the board while a person drove a leg, as a scenario.
 *
 * `lines` is what MarlinLink.onWrite() saw, in order — the wire, not the keys:
 * a held key's chunk that a stop dropped before it was written never moved a
 * wheel, and must not be driven when the leg is run again.
 *
 * Held keys go out as a stream of short chunks. Sent back one per line, every
 * one of them would get its own M400 (scenarioProgram) and the rover would stop
 * dead eight times a second. So consecutive chunks that point the same way —
 * X, Y and the fork's Z together — at the same speed are joined into one line.
 * A turn, a change of speed or a fork move on its own is a new line.
 *
 * Lines are kept as they were on the wire, signs included: a scenario is raw
 * G-code and goes out as written, so "/gcode's invert" applied while teaching
 * is already in the numbers. Absolute moves (after a G90) are positions, not
 * distances, and are left out and counted.
 *
 * @param {string[]} lines
 * @param {{title?: string}} [o]
 * @returns {{text: string, moves: number, skipped: number}}
 */
function scenarioFromWire(lines, o = {}) {
  const runs = [];
  let abs = false, feed = null, skipped = 0;
  for (const raw of lines || []) {
    const s = String(raw || '').trim().toUpperCase();
    if (/^G90(?!\d)/.test(s)) { abs = true; continue; }
    if (/^G91(?!\d)/.test(s)) { abs = false; continue; }
    if (!/^G[01](?!\d)/.test(s)) continue;
    const v = { X: 0, Y: 0, Z: 0 };
    for (const m of s.slice(2).matchAll(/([XYZF])\s*(-?\d+(?:\.\d+)?)/g)) {
      if (m[1] === 'F') feed = Number(m[2]); else v[m[1]] = Number(m[2]);
    }
    if (!v.X && !v.Y && !v.Z) continue;
    if (abs) { skipped++; continue; }
    const len = Math.hypot(v.X, v.Y, v.Z);
    const u = { X: v.X / len, Y: v.Y / len, Z: v.Z / len };
    const last = runs[runs.length - 1];
    const same = last && last.f === feed
      && Math.abs(last.u.X - u.X) < 1e-3 && Math.abs(last.u.Y - u.Y) < 1e-3 && Math.abs(last.u.Z - u.Z) < 1e-3;
    if (same) { last.X += v.X; last.Y += v.Y; last.Z += v.Z; }
    else runs.push({ u, f: feed, X: v.X, Y: v.Y, Z: v.Z });
  }
  const out = [`; ${o.title || 'sürülerek öğretildi'}`, 'G91'];
  for (const r of runs) {
    const parts = ['X', 'Y', 'Z'].filter((a) => Math.abs(r[a]) >= 0.005).map((a) => `${a}${scenarioFmt(r[a])}`);
    if (!parts.length) continue;
    out.push(`G1 ${parts.join(' ')}${r.f ? ` F${Math.round(r.f)}` : ''}`);
  }
  return { text: out.join('\n') + '\n', moves: out.length - 2, skipped };
}

// ── the lap: which scenarios a PLC task drives, in order ────────────────

/**
 * A task A{a} → B{b} as the scenarios that drive it, and what to tell the
 * mission when each one ends.
 *
 *   then: 'picked'   the load is on the fork        (durum 3 → 4)
 *         'gate'     at the door: wait for the PLC  (→ 5, until kontrol 2)
 *         'dropped'  the load is down               (4 → 6)
 *         'home'     back in the start area         (6 → 1)
 *
 * The way there must be taught whole — starting a task the robot can only
 * drive half of leaves it somewhere in the field with a load on the fork. The
 * way back is optional: without it the lap ends at the drop, and the robot is
 * brought home by hand.
 *
 * @param {{a:number, b:number}} task
 * @param {object} texts  follow.json's scenarios, id → text
 * @returns {{ok: boolean, legs: {id, label, then}[], missing: string[], home: boolean}}
 */
function scenarioLap(task, texts = {}) {
  const a = Number(task && task.a), b = Number(task && task.b);
  if (![1, 2, 3].includes(a) || ![1, 2, 3].includes(b)) {
    return { ok: false, legs: [], missing: ['görev geçersiz'], home: false };
  }
  const there = [[`BASLA_A${a}`, 'picked'], [`A${a}_KAPI`, 'gate'], ['KAPI_GIT', null], [`B${b}_BIRAK`, 'dropped']];
  const back = [[`B${b}_KAPI`, 'gate'], ['KAPI_DON', null], ['KAPI_BASLA', 'home']];
  const taught = (id) => scenarioParse((texts || {})[id]).ok;
  const leg = ([id, then]) => ({ id, label: scenarioSlot(id).label, then });
  const missing = there.filter(([id]) => !taught(id)).map(([id]) => scenarioSlot(id).label);
  const home = back.every(([id]) => taught(id));
  const legs = [...there, ...(home ? back : [])].map(leg);
  return { ok: missing.length === 0, legs, missing, home };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SCENARIO_SLOTS, SCENARIO_MAX_LINES, SCENARIO_REFUSED, scenarioSlot,
                     scenarioParse, scenarioProgram, scenarioAxisMm, scenarioLine,
                     scenarioFromWire, scenarioLap };
}
