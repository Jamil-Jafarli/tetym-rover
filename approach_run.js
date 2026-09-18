/**
 * Driving the pallet manoeuvre (public/approach.js) against a real line.
 *
 * The taught scenarios bring the robot to a station; this is the last two
 * metres, and they cannot be taught, because where the pallet is is not where
 * it was in practice. So the manoeuvre is measured rather than remembered: the
 * camera finds the line, the pilot squares the robot up on it and drives it
 * forward, and the odometer counts how far that was — and THAT is the distance
 * the robot then reverses, turns round, and drives back in, forks first.
 *
 * "gəldiyi qədər" — as far as it came. The number is not in the settings. It
 * is what the robot just drove.
 *
 * ── Who owns the wheels ──────────────────────────────────────────────
 *
 * Three different things drive during one manoeuvre:
 *
 *   find / align / line   the pilot, through rover.setAuto() — the same path
 *                         /follow's 20 Hz stream takes, so the PLC's hold, the
 *                         emergency stop and the reversing buzzer all apply
 *                         without this file knowing about any of them
 *   back / turn / in      one G1 each, with an M400 after it, through the link
 *                         — a distance the planner runs out exactly, the way a
 *                         scenario's lines do
 *   lift                  the actuator, for its fifteen seconds
 *
 * The rover has to be armed for the first of those to reach the board, and on
 * a PLC lap nobody has pressed anything. So the manoeuvre arms it while it
 * runs and puts it back as it found it — which also means DAYAN, a closed tab
 * and an emergency stop end the manoeuvre through the paths they already had.
 */

import { loadShared } from './shared.js';

const A = loadShared(['scenario.js', 'approach.js'],
                     ['approachPlan', 'approachGcode', 'approachNum', 'approachPilot',
                      'APPROACH_DEFAULTS']);
const P = loadShared('pilot.js', ['PILOT_DEFAULTS', 'pilotState', 'pilotStep']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How often the camera steps are stepped, ms. The camera runs at roadFps. */
const TICK_MS = 50;

/** Longest one G1 may take before the manoeuvre is called stuck. */
const MOVE_TIMEOUT_MS = 120000;

export class ApproachRunner {
  /**
   * @param {object} o
   * @param {import('./marlin.js').MarlinLink} o.link
   * @param {import('./marlin.js').Jogger} o.jog
   * @param {import('./rover.js').Rover} o.rover
   * @param {import('./road_eye.js').RoadEye} o.eye
   * @param {object} o.act        the Actuator
   * @param {() => number} o.metres   the odometer, in metres driven so far
   * @param {() => object} o.cfg      follow.json's `approach` block
   * @param {() => object} o.geom     scenarioLine()'s geometry
   * @param {() => object} [o.pilot]  follow.json's pilot sliders
   * @param {() => (string|null)} [o.blocked]  why nothing may run right now
   * @param {(text: string) => void} [o.log]
   */
  constructor({ link, jog, rover, eye, act, metres, cfg, geom,
                pilot = () => ({}), blocked = () => null, log = () => {} }) {
    Object.assign(this, { link, jog, rover, eye, act, metres, cfg, geom, pilot, blocked, log });
    this.run = null;        // the manoeuvre in progress
    this.last = null;       // the one that ended, and how
    this.refused = null;    // why the last start did not happen
    this._token = 0;
    this.holdWhy = null;
    this.onEnd = null;      // told about every run that ends, however it ended
  }

  get running() { return this.run !== null; }

  /** Pause (a reason) or resume (null) — the PLC's bekle, the door. */
  hold(why) {
    this.holdWhy = why || null;
    // A camera step is a control loop, so pausing it means zero demand now
    // rather than at the end of the current something.
    if (this.holdWhy && this.run) this.rover.setAuto(0, 0, `fasilə: ${this.holdWhy}`);
  }

  /**
   * Start one.
   * @param {'pick'|'drop'} kind
   * @returns {{ok: boolean, why?: string}}
   */
  start(kind) {
    const res = this._start(kind);
    this.refused = res.ok ? null : { kind, why: res.why, at: Date.now() };
    return res;
  }

  _start(kind) {
    if (kind !== 'pick' && kind !== 'drop') return { ok: false, why: `bilinmeyen manevra: ${kind}` };
    if (this.run) return { ok: false, why: `${this.run.label} zaten çalışıyor` };
    if (!this.link.connected) return { ok: false, why: 'Ender kartı bağlı değil' };
    const block = this.blocked();
    if (block) return { ok: false, why: block };
    const plan = A.approachPlan(kind, this.cfg() || {}, this.geom() || {});
    if (!plan.ok) return { ok: false, why: plan.why };

    const token = ++this._token;
    this.run = {
      kind, label: kind === 'pick' ? 'yük alma manevrası' : 'yük bırakma manevrası',
      steps: plan.steps.map((s) => ({ n: s.n, kind: s.kind, label: s.label })),
      mm: plan.mm, i: 0, step: plan.steps[0], drove_mm: 0, note: null,
      mark: this.metres(), lift_ms: 0, wasArmed: this.rover.running,
      startedAt: Date.now(),
    };
    this._go(plan, token);
    return { ok: true };
  }

  async _go(plan, token) {
    const r = this.run;
    let why = null;
    // The pilot's own memory, and the detector's mode frozen for the length of
    // the manoeuvre — see roadLockAuto: half way through, the only things left
    // arguing for another reading of the frame are shadows.
    const pst = P.pilotState(Date.now());
    const pcfg = { ...P.PILOT_DEFAULTS, ...(this.pilot() || {}) };
    const cfg = this.cfg() || {};
    this.eye.lock(true);
    if (!r.wasArmed) this.rover.start();
    try {
      for (const step of plan.steps) {
        if (token !== this._token) return;
        r.i = step.n - 1;
        r.step = step;
        this.log(`manevra ${step.n}/${plan.steps.length}: ${step.label}`);
        // eslint-disable-next-line no-await-in-loop
        why = await this._step(step, { plan, pst, pcfg, cfg, token });
        if (why || token !== this._token) break;
      }
    } catch (err) {
      why = String(err.message || err);
    }
    this._park(r.wasArmed);
    if (token !== this._token) return;
    this._end(why ? 'hata' : 'bitti', why);
  }

  /** Wheels and fork let go, the board back in relative mode. */
  _park(armed) {
    try {
      this.rover.setAuto(0, 0, 'manevra bitti');
      this.jog.stop();
      this.act.stop();
      this.eye.lock(false);
      if (this.link.connected) this.link.send('G91');
      if (!armed) this.rover.stop('manevra bitti');
    } catch { /* the link went down mid-park: nothing left to restore */ }
  }

  /** One step. Returns null when it worked, or why it did not. */
  async _step(step, ctx) {
    switch (step.kind) {
      case 'find': return this._find(step, ctx);
      case 'align': return this._follow(step, ctx, 'align');
      case 'line': return this._follow(step, ctx, 'line');
      case 'move': return this._move(step, ctx);
      case 'lift': return this._lift(step, ctx);
      default: return `bilinmeyen adım: ${step.kind}`;
    }
  }

  /** Wait until the line is in front of the camera. Nothing moves. */
  async _find(step, { token }) {
    const until = Date.now() + step.ms;
    for (;;) {
      if (token !== this._token) return null;
      if (!this.holdWhy && this.eye.seeing()) return null;
      if (!this.holdWhy && Date.now() > until) {
        return this.eye.status().err || `xətt ${Math.round(step.ms / 1000)} s ərzində görünmədi`;
      }
      this.rover.setAuto(0, 0, 'xətt axtarılır');
      await sleep(TICK_MS);
    }
  }

  /**
   * Follow the line with the pilot, until it is square (align) or until the
   * robot has come far enough (line).
   *
   * Both count the same odometer, and the count starts at `align` — the
   * distance the robot travelled squaring up is distance it travelled along
   * the line, and the reverse leg has to give all of it back. `drove_mm` is
   * what the G-code for steps 4 and 6 is built from.
   */
  async _follow(step, { pst, pcfg, cfg, token }, mode) {
    const r = this.run;
    const tol = A.approachNum(cfg, 'tol');
    const want = Math.max(1, Math.round(A.approachNum(cfg, 'square')));
    const fly = A.approachPilot(cfg, pcfg);
    if (mode === 'align') r.mark = this.metres();
    const until = Date.now() + step.ms;
    // The camera answers a few times a second and this loop runs at 20 Hz, so
    // most turns round it are looking at a picture they have already acted on.
    // Stepping the pilot on those would age its clocks against frames that
    // never arrived, and counting them as "square for five frames" would make
    // five frames a quarter of a second of one.
    let seenAt = 0, square = 0, blind = 0;
    for (;;) {
      if (token !== this._token) return null;
      if (this.holdWhy) { this.rover.setAuto(0, 0, `fasilə: ${this.holdWhy}`); await sleep(TICK_MS); continue; }

      const now = Date.now();
      r.drove_mm = Math.max(0, (this.metres() - r.mark) * 1000);
      if (mode === 'line' && r.drove_mm >= step.mm) return null;
      if (now > until) {
        return mode === 'align'
          ? `xəttə nizamlanmadı (sapma ${square ? 'oynayır' : 'böyük'}, ${Math.round(step.ms / 1000)} s)`
          : `xətt üzrə ${Math.round(step.mm)} mm ${Math.round(step.ms / 1000)} s ərzində gedilmədi`;
      }

      const e = this.eye.fresh(now);
      if (!e) {
        // The camera stopped answering — not the line being lost, the picture
        // being gone. Coasting on a stale error is how a robot drives into a
        // wall with a frozen frame on the screen.
        if (++blind * TICK_MS > 1500) return this.eye.status().err || 'kameradan görüntü gəlmir';
        this.rover.setAuto(0, 0, 'kamera susdu');
        await sleep(TICK_MS);
        continue;
      }
      blind = 0;
      if (e.at === seenAt) { await sleep(TICK_MS); continue; }
      seenAt = e.at;

      const out = P.pilotStep(pst, { ...e, want: this.eye.bandsWanted || 8 }, fly, now);
      if (mode === 'align') {
        // On the line AND along it. Near alone is a robot sitting on the line
        // pointing off it; far alone is one pointing along it from beside it.
        const near = e.near == null ? 1 : Math.abs(e.near);
        const far = e.far == null ? 1 : Math.abs(e.far);
        const on = e.bands >= 2 && near <= tol && far <= tol;
        square = on ? square + 1 : 0;
        if (square >= want) return null;
      }
      this.rover.setAuto(out.p25, out.p26, `manevra: ${step.label}`);
      await sleep(TICK_MS);
    }
  }

  /**
   * One G1, run out by the planner.
   *
   * The two distance steps are rebuilt here rather than taken from the plan:
   * the plan was made before the robot drove, and how far it drove is the
   * whole point. A distance written down in the settings still wins, for a
   * field where the measured one turns out not to be what is wanted.
   */
  async _move(step, { cfg, token }) {
    const r = this.run;
    let cmd = step.cmd;
    const drove = Math.round(r.drove_mm);
    if (step.measured && drove > 0 && !(Number(cfg[step.key]) > 0)) {
      cmd = A.approachGcode(step.dir, drove, this.geom() || {});
      r.note = `gəldiyi qədər: ${(drove / 1000).toFixed(2)} m`;
    }
    if (!cmd) return 'ölçü yox — G-kodu qurula bilmədi';
    while (this.holdWhy && token === this._token) await sleep(TICK_MS);
    if (token !== this._token) return null;
    // Hand the planner back: the pilot's last chunk is still cruising, and a
    // streamed chunk landing behind this G1 would add itself to the distance
    // the manoeuvre just measured out.
    this.rover.setAuto(0, 0, `manevra: ${step.label}`);
    this.jog.stop();
    this.link.send(cmd);
    this.link.send('M400');
    const done = await this.link.whenDrained(MOVE_TIMEOUT_MS);
    if (token !== this._token) return null;
    if (!done) {
      return this.link.connected
        ? `"${cmd}" ${MOVE_TIMEOUT_MS / 1000} s içinde bitmedi` : 'kart bağlantısı koptu';
    }
    return null;
  }

  /**
   * The actuator, one way, for its fifteen seconds.
   *
   * The clock only runs while the manoeuvre is not held: a fork paused at a
   * door for a minute has not been lifting for a minute. The actuator itself
   * is stopped for the length of the pause, because a linear actuator held
   * against its stop is a stalled motor (actuator.js).
   */
  async _lift(step, { token }) {
    const r = this.run;
    let left = step.ms;
    r.lift_ms = 0;
    try {
      for (;;) {
        if (token !== this._token) { this.act.stop(); return null; }
        if (this.holdWhy) {
          if (this.act.running) this.act.stop();
          await sleep(TICK_MS);
          continue;
        }
        if (left <= 0) break;
        if (!this.act.running) this.act.start(step.dir);
        const slice = Math.min(TICK_MS, left);
        await sleep(slice);
        left -= slice;
        r.lift_ms = step.ms - left;
        if (this.act.cut) return 'aktuator kendini kesti (uç noktaya dayandı ya da sıkıştı)';
      }
    } finally {
      this.act.stop();
    }
    return null;
  }

  _end(result, why = null) {
    const r = this.run;
    if (!r) return;
    this.last = { ...r, result, why, endedAt: Date.now(),
                  seconds: Math.round((Date.now() - r.startedAt) / 100) / 10 };
    this.run = null;
    if (this.onEnd) {
      try { this.onEnd(this.last); } catch (err) { console.warn('approach onEnd:', err.message); }
    }
  }

  /** Stop it where it is. The G1 in the planner runs out; nothing else goes. */
  stop(why = 'durduruldu') {
    if (!this.run) return false;
    this._token++;
    // However it ends, the rover is left armed or disarmed as it was found: a
    // manoeuvre that armed it and then aborted must not leave a robot that
    // /follow's stream can drive without anybody pressing anything.
    this._park(this.run.wasArmed);
    this._end('durduruldu', why);
    return true;
  }

  /**
   * Backing up right now — what sounds the reversing buzzer.
   *
   * The three straight steps go out as G-code rather than through the wheel
   * demand, so rover.reversing cannot see them; server.js ORs this in. A
   * forklift backing up silently is the one hazard here that is not a
   * software fault.
   */
  get reversing() {
    const r = this.run;
    return !!(r && !this.holdWhy && r.step && r.step.kind === 'move' && r.step.mm < 0);
  }

  status() {
    const r = this.run;
    return {
      running: r ? {
        kind: r.kind, label: r.label, step: r.i + 1, total: r.steps.length,
        current: r.step ? r.step.label : null, steps: r.steps,
        drove_mm: Math.round(r.drove_mm), note: r.note,
        lift_s: r.lift_ms ? Math.round(r.lift_ms / 100) / 10 : 0,
        paused: this.holdWhy,
        seconds: Math.round((Date.now() - r.startedAt) / 100) / 10,
      } : null,
      last: this.last,
      refused: this.refused,
    };
  }
}
