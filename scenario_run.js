/**
 * Running a scenario on the Ender board: one command at a time, stoppable.
 *
 * The text and its checks are public/scenario.js; this is the part with a
 * clock and a serial port. A scenario goes out a command at a time, and the
 * next one is sent only once the board has answered the last — which, with
 * the M400 scenarioProgram() puts after every move, means once the robot has
 * actually finished moving. So `step` on /plc is the line the robot is on, and
 * STOP stops after the move in progress rather than after everything already
 * queued in the planner.
 *
 * While a scenario runs, nothing else drives: the rover is stopped before it
 * starts, and a key or the pilot arriving mid-scenario stops the scenario
 * rather than mixing two sources of moves into one planner.
 */

import { loadShared } from './shared.js';

const S = loadShared('scenario.js', ['scenarioSlot', 'scenarioParse', 'scenarioProgram']);

/** Longest a single command may take before the scenario is called stuck. */
const STEP_TIMEOUT_MS = 120000;

export class ScenarioRunner {
  /**
   * @param {object} opts
   * @param {import('./marlin.js').MarlinLink} opts.link
   * @param {import('./marlin.js').Jogger} opts.jog
   * @param {() => (string|null)} [opts.blocked]  why nothing may run right now
   */
  constructor({ link, jog, blocked = () => null }) {
    this.link = link;
    this.jog = jog;
    this.blocked = blocked;
    this.run = null;       // the one in progress
    this.last = null;      // the last one that ended, and how
    this._token = 0;
  }

  get running() { return this.run !== null; }

  /**
   * Start one. Refuses — with a reason — rather than queueing behind another.
   * @returns {{ok: boolean, why?: string, errors?: object[]}}
   */
  start(id, text) {
    const res = this._start(id, text);
    // A refusal is shown on /plc until the next attempt: a button that does
    // nothing and says nothing is the worst kind of broken.
    this.refused = res.ok ? null : { id, why: res.why, errors: res.errors || [], at: Date.now() };
    return res;
  }

  _start(id, text) {
    const slot = S.scenarioSlot(id);
    if (!slot) return { ok: false, why: `bilinmeyen senaryo: ${id}` };
    if (this.run) return { ok: false, why: `${this.run.label} zaten çalışıyor` };
    if (!this.link.connected) return { ok: false, why: 'Ender kartı bağlı değil' };
    const block = this.blocked();
    if (block) return { ok: false, why: block };
    const parsed = S.scenarioParse(text);
    if (!parsed.commands.length && !parsed.errors.length) return { ok: false, why: 'senaryo boş' };
    if (!parsed.ok) return { ok: false, why: 'senaryoda hata var', errors: parsed.errors };

    this.jog.stop();
    const program = S.scenarioProgram(parsed.commands);
    const token = ++this._token;
    this.run = {
      id, label: slot.label, total: parsed.commands.length, step: 0,
      current: null, startedAt: Date.now(),
    };
    this._go(program, token);
    return { ok: true };
  }

  async _go(program, token) {
    const r = this.run;
    let why = null;
    try {
      for (const { cmd, step } of program) {
        if (token !== this._token) return;            // stopped: the stopper reports
        if (step) { r.step++; r.current = cmd; }
        this.link.send(cmd);
        const done = await this.link.whenDrained(STEP_TIMEOUT_MS);
        if (token !== this._token) return;
        if (!done) {
          why = this.link.connected ? `"${cmd}" ${STEP_TIMEOUT_MS / 1000} s içinde bitmedi` : 'kart bağlantısı koptu';
          break;
        }
      }
    } catch (err) {
      why = String(err.message || err);
    }
    if (token !== this._token) return;
    this._end(why ? 'hata' : 'bitti', why);
  }

  _end(result, why = null) {
    const r = this.run;
    if (!r) return;
    this.last = { ...r, result, why, endedAt: Date.now(),
                  seconds: Math.round((Date.now() - r.startedAt) / 100) / 10 };
    this.run = null;
  }

  /**
   * Stop feeding it. The move in progress finishes — see the halt route in
   * marlin_http.js for why there is no quickstop — and everything not yet
   * sent is dropped. G91 goes out so the next hand drive is relative again.
   */
  stop(why = 'durduruldu') {
    if (!this.run) return false;
    this._token++;
    this.jog.stop();
    try {
      this.link.drain();
      if (this.link.connected) this.link.send('G91');
    } catch { /* link already down: nothing to restore */ }
    this._end('durduruldu', why);
    return true;
  }

  status() {
    return {
      supported: true,
      running: this.run ? { ...this.run, seconds: Math.round((Date.now() - this.run.startedAt) / 100) / 10 } : null,
      last: this.last,
      refused: this.refused || null,
    };
  }
}
