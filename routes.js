/**
 * Teaching the rover the way to each load, and driving it back from memory.
 *
 * The field has three pickup slots (yük yuvası) and, from each of them, a way
 * to the door. Getting from the start area to a slot's line is not something
 * the camera can do — there is no paint between the two — so it is TAUGHT:
 * a person drives it once with W A S D on /gcode while this records, and from
 * then on the rover drives it again by itself.
 *
 *     slot n, leg "to"    start area → the start of slot n's line
 *     slot n, leg "out"   back at the start of that line → the door
 *
 * ── Scenarios ────────────────────────────────────────────────────────
 *
 * Leg "to" is a SCENARIO: the rule "to see A2's line, come here", taught one
 * step at a time rather than in one breath. Each step is its own recording —
 * or a typed one, "W 400 mm" — and can be driven on its own, taught again,
 * moved or deleted without touching the others. One long recording had none
 * of that: a single wrong turn near the end meant driving the whole way again
 * from the start area, and there was no way to try the first half alone.
 *
 * To the rest of the system a scenario is still one leg. get(n, 'to') joins
 * the steps, and the Replayer aggregates what it is given (aggregate(), below),
 * so "W 400" in step 1 and "W 300" in step 2 are driven as one continuous
 * W 700 — the cargo run in mission.js asks for leg "to" exactly as it did
 * before steps existed.
 *
 * Everything in between — finding the line, reading the slot's QR, following
 * the paint to the load, the 180°, the lift, the way back — is /follow's
 * cargo run in mission.js, because that part needs the camera.
 *
 * One scenario is enough. The three pickup lines are parallel and start on one
 * row, each with its QR code, so a slot with no scenario of its own is reached
 * through the nearest one that has — its line, then along the row reading the
 * codes (RouteBook.via() picks it; missionCargo() drives it).
 *
 * ── What is recorded ─────────────────────────────────────────────────
 *
 * The G-code that reached the board, via MarlinLink.onWrite(). Not the keys,
 * and not the requests: a key press is a request for a stream of chunks, and
 * how many of them went out depends on how long it was held and on what a
 * halt dropped before it was written. The wire is the only place where "what
 * the wheels were told" is a fact rather than an estimate. Replaying it is
 * then replaying the same G1 lines, at the same feed — the rover repeats the
 * moves it was shown, not an approximation of them in percent.
 *
 * The lines are kept in the motor frame, un-signed by link.sign(), and signed
 * again by Jogger.lineFor() on the way out. So a route taught before somebody
 * ticks "invert left" still drives the same physical way afterwards.
 *
 * ── How it is replayed ───────────────────────────────────────────────
 *
 * First aggregated: consecutive moves in the same direction at the same speed
 * become one move (aggregate()). A person teaching taps W four times, or
 * teaches "W 400" and "W 300" as two scenario steps; the rover should not stop
 * three times on a straight line because of it.
 *
 * Then paced exactly like a held key, by a Pacer (marlin.js): the next chunk is
 * on the board before the current one starts, on a schedule anchored to the
 * predicted timeline rather than to "now". So a move is one continuous run,
 * and the junction between two different moves is Marlin's to take — it slows
 * for a turn as far as the turn needs, and no further. The replay used to wait
 * for every move to run out and then settle for 300 ms, and paced its chunks
 * 75 % of the way through the one before; both made autonomous driving as
 * sliced as the manual driving it was recorded from.
 *
 * "One move" is still sent as chunks, not as one long G1 — that is what keeps
 * the DAYAN button honest. A single G1 for a whole straight would be as smooth
 * and would put metres of travel in Marlin's planner, and this codebase has no
 * quickstop to take them back out (see halt() in marlin_http.js). Chunk by
 * chunk, a stop is link.dropMotion() plus what is already on the board — the
 * same stopping distance as releasing a key.
 */

import fs from 'node:fs';
import { DIRECTIONS, DEFAULT_FEED, DEFAULT_STEP_MM, Pacer } from './marlin.js';
import { reply, readBody } from './marlin_http.js';
import { qrKey } from './qr.js';

export const ROUTE_SLOTS = [1, 2, 3];
export const ROUTE_LEGS = { to: 'başlanğıc → yuva', out: 'yuva → qapı' };
// The şartname's names for the three pickup points (field.js: A1..A3, whose
// QR codes are ALIM1..ALIM3). Not "A, B, C": B1..B3 are the drop-off points.
export const SLOT_NAMES = { 1: 'A1', 2: 'A2', 3: 'A3' };
/** The longest typed step: past a few metres a blind move is not worth trusting. */
export const TYPED_MAX_MM = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A G0/G1 line as numbers: {x, y, f}, each undefined when absent. */
export function parseMove(line) {
  const s = String(line || '').trim().toUpperCase();
  if (!/^G[01](?!\d)/.test(s)) return null;
  const out = {};
  for (const m of s.slice(2).matchAll(/([XYF])\s*(-?\d+(?:\.\d+)?)/g)) {
    out[m[1].toLowerCase()] = Number(m[2]);
  }
  return out;
}

/**
 * Which key a recorded move was, as the person teaching it pressed it.
 *
 * /gcode swaps W and S (the camera is on the chassis end DIRECTIONS calls the
 * back — see manualVec() there), so a W press is DIRECTIONS.forward negated.
 * Built from DIRECTIONS rather than written out, so the labels cannot drift
 * from the table the keys themselves are built from.
 */
const neg = (v) => ({ X: -v.X, Y: -v.Y });
const KEY_SIGNS = [
  ['W', neg(DIRECTIONS.forward)], ['S', neg(DIRECTIONS.back)],
  ['A', DIRECTIONS.left], ['D', DIRECTIONS.right],
];
export function moveName(x, y) {
  const sx = Math.sign(x), sy = Math.sign(y);
  for (const [k, v] of KEY_SIGNS) {
    if (Math.sign(v.X) === sx && Math.sign(v.Y) === sy) return k;
  }
  return 'qövs';      // one wheel only: W+A and friends
}

/**
 * A step typed rather than driven: `key` held for `mm` of wheel travel.
 *
 * The same unit legSummary() prints, so "W 400" typed and "W 400" read off a
 * recording are the same move. For A and D that is millimetres of each wheel
 * turning the rover on the spot, not degrees: turning one into the other
 * needs the track width and the 27 % scale (mission.js), and a step that
 * silently depended on those would be wrong whenever they are.
 *
 * Cut into equal chunks no longer than a held key's, so it replays paced like
 * one — and so DAYAN stops it within the same distance.
 */
export function typedStep(key, mm, feed = DEFAULT_FEED) {
  const k = String(key || '').trim().toUpperCase();
  const pair = KEY_SIGNS.find(([name]) => name === k);
  if (!pair) throw new Error(`klaviş ${JSON.stringify(key)} yoxdur — W, A, S və ya D`);
  const d = Number(mm);
  if (!(d >= 1 && d <= TYPED_MAX_MM)) throw new Error(`məsafə 1–${TYPED_MAX_MM} mm olmalıdır`);
  const n = Math.ceil(d / DEFAULT_STEP_MM);
  const c = Math.round((d / n) * 100) / 100;
  const f = Math.round(Math.min(20000, Math.max(60, Number(feed) || DEFAULT_FEED)));
  const v = pair[1];
  return [{ x: v.X * c, y: v.Y * c, f, n }];
}

function checkSlot(slot) {
  const n = Number(slot);
  if (!ROUTE_SLOTS.includes(n)) throw new Error(`yuva ${JSON.stringify(slot)} yoxdur — 1, 2 və ya 3`);
  return n;
}
function checkLeg(leg) {
  if (!(leg in ROUTE_LEGS)) throw new Error(`yol ${JSON.stringify(leg)} yoxdur — "to" və ya "out"`);
  return leg;
}

// ── recording ────────────────────────────────────────────────────────

export class RouteRecorder {
  /**
   * @param {object} o
   * @param {import('./marlin.js').MarlinLink} o.link
   * @param {import('./marlin.js').Jogger} o.jog   for its chunk-time estimate
   * @param {number} [o.gapMs]  how much later than predicted a repeat of the
   *   same line may arrive and still be the same held key. Longer than that,
   *   the key was let go, and the replay should stop there too.
   */
  constructor({ link, jog, gapMs = 400 }) {
    this.link = link;
    this.jog = jog;
    this.gapMs = gapMs;
    this.slot = null;
    this.leg = null;
    this.segs = [];
    this.skipped = 0;
    this._off = null;
  }

  get active() { return this.slot !== null; }

  /**
   * @param step  leg "to" only: which scenario step this recording replaces,
   *   or null to add it as a new last step. Leg "out" is still one recording.
   */
  start(slot, leg, step = null) {
    if (this.active) throw new Error(`artıq yazılır: yuva ${this.slot}, ${ROUTE_LEGS[this.leg]}`);
    const s = checkSlot(slot);
    const l = checkLeg(leg);
    if (step != null && (l !== 'to' || !(Number.isInteger(Number(step)) && Number(step) >= 0))) {
      throw new Error(`addım ${JSON.stringify(step)} olmaz`);
    }
    this.slot = s;
    this.leg = l;
    this.step = step == null ? null : Number(step);
    this.segs = [];
    this.skipped = 0;
    // Relative until told otherwise: MarlinLink sends G91 on connect and every
    // run/jog sends it again, so a recording that begins mid-session is in
    // relative mode in every case this project produces.
    this._abs = false;
    this._f = DEFAULT_FEED;
    this._lastAt = 0;
    this._lastMs = 0;
    this.startedAt = Date.now();
    this._off = this.link.onWrite((cmd) => this._line(cmd));
  }

  /** One line off the wire. Exposed for the tests, which have no serial port. */
  _line(cmd, now = Date.now()) {
    const s = String(cmd).trim().toUpperCase();
    if (/^G90(?!\d)/.test(s)) { this._abs = true; return; }
    if (/^G91(?!\d)/.test(s)) { this._abs = false; return; }
    const m = parseMove(s);
    if (!m) return;
    if (m.f) this._f = m.f;
    // An absolute move typed into the console is a position, not a distance,
    // and cannot be replayed from somewhere else. Counted so the page can say
    // it happened rather than silently leaving a hole in the route.
    if (this._abs) { this.skipped += 1; return; }
    const x = (m.x || 0) * this.link.sign('X');
    const y = (m.y || 0) * this.link.sign('Y');
    if (!x && !y) return;
    const f = this._f;
    const last = this.segs[this.segs.length - 1];
    const held = last && last.x === x && last.y === y && last.f === f
      && now - this._lastAt <= this._lastMs + this.gapMs;
    if (held) last.n += 1;
    else this.segs.push({ x, y, f, n: 1 });
    this._lastAt = now;
    this._lastMs = this.jog.chunkSeconds(Math.hypot(x, y), f) * 1000;
  }

  /** Finish, and hand back what was recorded. */
  stop() {
    const out = { slot: this.slot, leg: this.leg, step: this.step,
                  segs: this.segs, skipped: this.skipped };
    this.cancel();
    return out;
  }

  cancel() {
    if (this._off) this._off();
    this._off = null;
    this.slot = null;
    this.leg = null;
    this.step = null;
  }

  status() {
    return this.active
      ? { active: true, slot: this.slot, leg: this.leg, step: this.step, ...legSummary(this.segs),
          skipped: this.skipped, secs: Math.round((Date.now() - this.startedAt) / 1000) }
      : { active: false };
  }
}

/**
 * The aggregator: consecutive moves that point the same way at the same speed,
 * joined into one.
 *
 * "The same way" is the direction of the (x, y) vector, not the line: a held
 * key's 80 mm chunks, the two 40 mm halves a key press starts with, and a
 * typed step's 57.14 mm chunks are all one W. The joined move is cut again
 * into equal chunks no longer than the longest it was made of — the same
 * length Marlin already coped with, the same stopping distance, and the total
 * distance kept to the hundredth of a millimetre the wire carries.
 *
 * A different speed is not joined — it is the same direction, but not the
 * same move — and nor is anything that turns. Neither stops the rover any
 * more: the Replayer keeps the planner fed across every junction, and Marlin
 * slows for a real turn by as much as the turn needs.
 */
export function aggregate(segs) {
  const runs = [];
  for (const s of segs || []) {
    const len = Math.hypot(s.x, s.y);
    if (!(len > 0) || !(s.n > 0)) continue;
    const ux = s.x / len, uy = s.y / len;
    const last = runs[runs.length - 1];
    if (last && last.f === s.f && Math.abs(last.ux * uy - last.uy * ux) < 1e-4
        && last.ux * ux + last.uy * uy > 0) {
      last.total += len * s.n;
      last.chunk = Math.max(last.chunk, len);
    } else {
      runs.push({ ux, uy, f: s.f, total: len * s.n, chunk: len });
    }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  return runs.map((m) => {
    const n = Math.max(1, Math.ceil(m.total / m.chunk - 1e-6));
    const c = m.total / n;
    return { x: r2(m.ux * c), y: r2(m.uy * c), f: m.f, n };
  });
}

/** A leg, as a person reads it: how many moves, how far, and which keys. */
export function legSummary(segs) {
  const list = (segs || []).map((s) => {
    const mm = s.n * Math.max(Math.abs(s.x), Math.abs(s.y));
    return { key: moveName(s.x, s.y), mm: Math.round(mm) };
  });
  return {
    moves: list.length,
    chunks: (segs || []).reduce((a, s) => a + s.n, 0),
    mm: list.reduce((a, l) => a + l.mm, 0),
    list: list.map((l) => `${l.key} ${l.mm}`),
  };
}

// ── keeping them ─────────────────────────────────────────────────────

/**
 * The taught routes, on disk.
 *
 * Unlike the mission target, which is deliberately forgotten on restart, these
 * are the whole point of teaching: an afternoon of driving the rover to three
 * slots and a door is not something to lose to a reboot.
 *
 *   { "2": { "qr": "ALIM2",
 *            "to":  { "at": "...", "steps": [{ "at", "how": "drive"|"typed", "segs": [...] }, …] },
 *            "out": { "at": "...", "segs": [...] } } }
 *
 * A "to" written before scenarios existed is `{ at, segs }` — one recording.
 * It is read as a scenario of one step, and rewritten in the new shape the
 * next time that scenario changes; nothing taught before is lost.
 */
export class RouteBook {
  constructor(file = null) {
    this.file = file;
    this.data = {};
    if (file) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
      catch { this.data = {}; }
    }
  }

  _slot(slot) {
    const k = String(checkSlot(slot));
    this.data[k] ||= {};
    return this.data[k];
  }

  /** A slot's scenario steps, oldest shape included. Never null. */
  steps(slot) {
    const to = (this.data[String(checkSlot(slot))] || {}).to;
    if (!to) return [];
    if (Array.isArray(to.steps)) return to.steps.filter((s) => s && Array.isArray(s.segs) && s.segs.length);
    return Array.isArray(to.segs) && to.segs.length ? [{ at: to.at, how: 'drive', segs: to.segs }] : [];
  }

  _setSteps(slot, steps) {
    const s = this._slot(slot);
    if (steps.length) s.to = { at: new Date().toISOString(), steps };
    else delete s.to;
    this.save();
  }

  _checkStep(slot, i) {
    const n = Number(i);
    const len = this.steps(slot).length;
    if (!(Number.isInteger(n) && n >= 0 && n < len)) {
      throw new Error(`${SLOT_NAMES[checkSlot(slot)]}: addım ${n + 1} yoxdur (${len} addım var)`);
    }
    return n;
  }

  /** Leg "to" is every step, joined; leg "out" is its one recording. */
  get(slot, leg) {
    if (checkLeg(leg) === 'to') {
      const all = this.steps(slot).flatMap((s) => s.segs);
      return all.length ? all : null;
    }
    const l = (this.data[String(checkSlot(slot))] || {}).out;
    return l && Array.isArray(l.segs) && l.segs.length ? l.segs : null;
  }

  /** One step's moves, to drive it on its own. */
  stepSegs(slot, i) { return this.steps(slot)[this._checkStep(slot, i)].segs; }

  /** Leg "to" set whole is a scenario of one step. */
  set(slot, leg, segs) {
    if (checkLeg(leg) === 'to') { this._setSteps(slot, [{ at: new Date().toISOString(), how: 'drive', segs }]); return; }
    this._slot(slot).out = { at: new Date().toISOString(), segs };
    this.save();
  }

  /** Replace step `i`, or add a new last step when `i` is null or past the end. */
  setStep(slot, i, segs, how = 'drive') {
    const steps = this.steps(slot);
    const step = { at: new Date().toISOString(), how, segs };
    if (i == null || Number(i) >= steps.length) steps.push(step);
    else steps[this._checkStep(slot, i)] = step;
    this._setSteps(slot, steps);
  }

  removeStep(slot, i) {
    const steps = this.steps(slot);
    steps.splice(this._checkStep(slot, i), 1);
    this._setSteps(slot, steps);
  }

  /** Move step `i` by `by` places (-1 up, +1 down); off either end is a no-op. */
  moveStep(slot, i, by) {
    const steps = this.steps(slot);
    const a = this._checkStep(slot, i), b = a + Math.sign(Number(by) || 0);
    if (b < 0 || b >= steps.length || a === b) return;
    [steps[a], steps[b]] = [steps[b], steps[a]];
    this._setSteps(slot, steps);
  }

  clear(slot, leg) {
    delete this._slot(slot)[checkLeg(leg)];
    this.save();
  }

  /**
   * Whose scenario a run to `slot` drives: its own, or — when it has none —
   * the nearest slot that has one (the lower number, when two are as near).
   * null when no slot has one.
   *
   * The pickup lines are parallel and start on one row with a QR code each,
   * so the cargo run can reach a slot from a neighbour's line along that row
   * (missionCargo() in mission.js). One scenario is then enough for all
   * three; teaching a slot its own still wins, because a taught way straight
   * to the line is two 90° turns and a blind row shorter.
   */
  via(slot) {
    const n = checkSlot(slot);
    if (this.steps(n).length) return n;
    const taught = ROUTE_SLOTS.filter((k) => this.steps(k).length);
    taught.sort((a, b) => Math.abs(a - n) - Math.abs(b - n) || a - b);
    return taught.length ? taught[0] : null;
  }

  /** The text on the slot's QR. ALIMn is the şartname's; a mock-up can differ. */
  qr(slot) { return this._slot(slot).qr || `ALIM${checkSlot(slot)}`; }

  setQr(slot, text) {
    const t = String(text ?? '').trim().slice(0, 64);
    if (t) this._slot(slot).qr = t; else delete this._slot(slot).qr;
    this.save();
  }

  summary() {
    const out = {};
    for (const n of ROUTE_SLOTS) {
      const s = this.data[String(n)] || {};
      const qr = s.qr || `ALIM${n}`;
      out[n] = { name: SLOT_NAMES[n], qr, qr_key: qrKey(qr), via: this.via(n) };
      for (const leg of Object.keys(ROUTE_LEGS)) {
        const segs = this.get(n, leg);
        // `plan`: what the Replayer will actually drive, after aggregate().
        out[n][leg] = segs ? { ...legSummary(segs), at: s[leg].at,
                               plan: legSummary(aggregate(segs)).list } : null;
      }
      if (out[n].to) {
        out[n].to.steps = this.steps(n).map((st) => ({ ...legSummary(st.segs), how: st.how || 'drive', at: st.at }));
      }
    }
    return out;
  }

  save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
    catch (e) { console.warn('could not save routes:', e.message); }
  }
}

// ── driving them again ───────────────────────────────────────────────

export class Replayer {
  constructor({ link, jog }) {
    this.link = link;
    this.jog = jog;
    this.st = { id: null, route: null, active: false, done: false,
                aborted: false, err: null, seg: 0, of: 0 };
    this._token = null;
    // Why the replay must wait (the PLC's bekle), or null. Kept across runs:
    // a route asked for while the PLC says wait starts paused, not driving.
    this.holdWhy = null;
    this._dropped = 0;     // chunks taken back off the queue by the last pause
  }

  get active() { return this.st.active; }

  status() { return { ...this.st, paused: this.st.active && !!this.holdWhy, held: this.holdWhy }; }

  /**
   * Pause (a reason) or resume (null) — the PLC's bekle / devam.
   *
   * A pause is not a cancel: the route stays where it got to and carries on
   * from there. What has not been written to the board yet is taken back off
   * the queue, and the loop rewinds by exactly that many chunks, so nothing
   * is skipped and nothing driven twice. The chunk or two already on the board
   * still run out — Marlin has no way to take a planned move back that keeps
   * the position — so the rover stops within about a chunk of the command.
   */
  hold(why) {
    this.holdWhy = why || null;
    if (!this.holdWhy || !this.st.active) return;
    try { this._dropped += this.link.dropMotion() || 0; } catch { /* not connected */ }
  }

  /**
   * Drive a recorded leg. `id` is the caller's name for this run, echoed in
   * status() — /follow waits for ITS replay to finish, and a "done" left over
   * from the previous one must not look like an answer.
   */
  run(id, segs, route = null) {
    if (this.st.active) this.cancel('yenisi başladı');
    const token = {};
    this._token = token;
    this._dropped = 0;
    const plan = aggregate(segs);
    this.st = { id, route, active: true, done: false, aborted: false, err: null,
                seg: 0, of: plan.length };
    this._loop(plan, token).catch((e) => {
      if (this._token !== token) return;
      this._token = null;
      this.st.active = false;
      this.st.err = String(e.message || e);
    });
    return this.status();
  }

  /** Report a replay that could not even start, under the caller's id. */
  fail(id, err, route = null) {
    this.st = { id, route, active: false, done: false, aborted: false, err, seg: 0, of: 0 };
    return this.status();
  }

  /** Stop feeding, and take back what has not been written yet. */
  cancel(why = 'dayandırıldı') {
    if (!this.st.active) return;
    this._token = null;
    this.st.active = false;
    this.st.aborted = true;
    this.st.why = why;
    try { this.link.dropMotion(); } catch { /* not connected: nothing queued */ }
  }

  async _loop(segs, token) {
    const alive = () => this._token === token;
    if (!segs.length) throw new Error('yol boşdur — əvvəlcə öyrət');
    if (!this.link.connected) throw new Error('kart bağlı deyil');
    this.jog.stop();
    this.link.send('G91');
    this.link.steppersOn = true;

    // The held key's clock: every chunk is on the board before the one ahead
    // of it starts, across move boundaries too — no waiting for a move to run
    // out before the next begins. Anchored to its own prediction, never to now.
    const clock = new Pacer(this.jog);
    // (i, k): segment i, chunks of it already sent. One position rather than
    // two nested loops, because a pause has to be able to step it BACK.
    let i = 0, k = 0;
    const back = (n) => {
      for (; n > 0; n--) {
        if (k > 0) k--;
        else if (i > 0) { i--; k = segs[i].n - 1; }
      }
    };
    const going = () => alive() && !this.holdWhy;
    for (;;) {
      while (i < segs.length) {
        if (this._dropped) { back(this._dropped); this._dropped = 0; }
        if (this.holdWhy) {
          this.st.seg = i + 1;
          while (alive() && this.holdWhy) await sleep(25);
          if (!alive()) return;
          // The board ran out while waiting: the next chunk starts from rest.
          clock.reset();
          continue;
        }
        const s = segs[i];
        this.st.seg = i + 1;
        const axis = { X: s.x, Y: s.y };
        await this._until(Date.now() + clock.waitMs(), going);
        if (!alive()) return;
        if (this.holdWhy) continue;
        this.link.send(this.jog.lineFor(axis, s.f));
        clock.sent(axis, s.f);
        if (++k >= s.n) { i++; k = 0; }
      }
      // Done when the board is predicted to have stopped, not when the last
      // line went out — /follow's next step must not start under a moving rover.
      clock.release();
      await this._until(clock.endAt, () => alive() && !this._dropped);
      if (!alive()) return;
      // Paused while the last chunks were still queued: they were taken back,
      // so they are owed — rewind and go round again (the pause waits up top).
      if (this._dropped) { back(this._dropped); this._dropped = 0; continue; }
      break;
    }
    this._token = null;
    this.st.active = false;
    this.st.done = true;
  }

  async _until(t, alive) {
    while (alive() && Date.now() < t) await sleep(Math.min(25, Math.max(1, t - Date.now())));
  }
}

// ── the API ──────────────────────────────────────────────────────────

/**
 * /api/cargo — teaching from /gcode, which has no socket of its own.
 *
 *   GET                                        routes, recording, replay, the run asked for
 *   POST {action:"record", slot, leg, step?}   start recording (then drive with WASD);
 *                                              leg "to": step i is re-taught, none adds one
 *   POST {action:"save"}                       stop recording and keep it
 *   POST {action:"cancel"}                     stop recording and throw it away
 *   POST {action:"clear", slot, leg}           forget a taught leg (or a whole scenario)
 *   POST {action:"step_add", slot, key, mm, feed?}   a typed scenario step
 *   POST {action:"step_del", slot, step}       forget one scenario step
 *   POST {action:"step_move", slot, step, by}  reorder: by -1 up, +1 down
 *   POST {action:"test", slot, step?}          drive one step, or the whole scenario,
 *                                              from here — no camera, no QR
 *   POST {action:"test_stop"}                  stop that
 *   POST {action:"qr", slot, text}             the text on that slot's QR code
 *   POST {action:"run", slot}                  ask /follow to do the cargo run
 *
 * @param armed  whether /follow has the rover armed. A test drive is refused
 *   then: /follow's own run would be cancelled underneath it, and two pages
 *   driving one rover is how neither of them is in charge.
 */
export function routesApi({ book, recorder, replayer, want, run, armed = () => false }) {
  const state = () => ({ routes: book.summary(), rec: recorder.status(),
                         replay: replayer.status(), want: want() });
  return async function handle(req, res) {
    if (req.method === 'GET') { reply(res, 200, state()); return; }
    if (req.method !== 'POST') { reply(res, 405, { error: 'use GET or POST' }); return; }
    try {
      const d = await readBody(req);
      switch (d.action) {
        case 'record':
          // The recorder listens to the wire, and a replay writes to it: a
          // recording made under one would teach the replay back to itself.
          if (replayer.active) throw new Error('rover yaddaşdan sürülür — əvvəl dayandır');
          recorder.start(d.slot, d.leg, d.leg === 'to' ? (d.step ?? null) : null);
          break;
        case 'save': {
          if (!recorder.active) throw new Error('heç nə yazılmır');
          const r = recorder.stop();
          if (!r.segs.length) throw new Error('heç bir hərəkət yazılmadı — yol saxlanmadı');
          if (r.leg === 'to') book.setStep(r.slot, r.step, r.segs, 'drive');
          else book.set(r.slot, r.leg, r.segs);
          break;
        }
        case 'step_add':
          book.setStep(d.slot, null, typedStep(d.key, d.mm, d.feed), 'typed');
          break;
        case 'step_del':
          book.removeStep(d.slot, d.step);
          break;
        case 'step_move':
          book.moveStep(d.slot, d.step, d.by);
          break;
        case 'test': {
          if (recorder.active) throw new Error('yazılır — əvvəl bitir və ya ləğv et');
          if (armed()) throw new Error('/follow roveri sürür — orada DAYAN, sonra sına');
          const n = checkSlot(d.slot);
          const one = d.step != null;
          const segs = one ? book.stepSegs(n, d.step) : book.get(n, 'to');
          if (!segs) throw new Error(`${SLOT_NAMES[n]} ssenarisi öyrədilməyib`);
          const route = `${SLOT_NAMES[n]} ssenarisi` + (one ? `, addım ${Number(d.step) + 1}` : '');
          replayer.run(`test:${Date.now()}`, segs, route);
          break;
        }
        case 'test_stop':
          replayer.cancel('dayandırıldı');
          break;
        case 'cancel':
          recorder.cancel();
          break;
        case 'clear':
          book.clear(d.slot, d.leg);
          break;
        case 'qr':
          book.setQr(d.slot, d.text);
          break;
        case 'run':
          run(d.slot == null ? null : checkSlot(d.slot));
          break;
        default:
          throw new Error(`unknown action ${JSON.stringify(d.action)}`);
      }
      reply(res, 200, state());
    } catch (e) {
      reply(res, 400, { error: String(e.message || e), ...state() });
    }
  };
}
