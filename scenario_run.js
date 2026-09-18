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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = loadShared('scenario.js', ['scenarioSlot', 'scenarioParse', 'scenarioProgram',
                                     'scenarioFromWire', 'scenarioLap']);

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
    // Why it must wait (the PLC's bekle, the door), or null. Kept across runs,
    // so a scenario started under bekle waits before its first command.
    this.holdWhy = null;
    // Told about every run that ends, however it ended — the lap driver's cue.
    this.onEnd = null;
  }

  get running() { return this.run !== null; }

  /**
   * Pause (a reason) or resume (null). The command in progress finishes —
   * each move is followed by an M400, so that is the move the robot is on —
   * and the next one is not sent until the hold is released. Nothing is
   * dropped, so it carries on from exactly the next line.
   */
  hold(why) { this.holdWhy = why || null; }

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
        while (this.holdWhy && token === this._token) await sleep(50);
        if (token !== this._token) return;
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
    if (this.onEnd) {
      try { this.onEnd(this.last); } catch (err) { console.warn('scenario onEnd:', err.message); }
    }
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
      running: this.run ? { ...this.run, paused: this.holdWhy,
                            seconds: Math.round((Date.now() - this.run.startedAt) / 100) / 10 } : null,
      last: this.last,
      refused: this.refused || null,
    };
  }
}

// ── teaching a scenario by driving it ────────────────────────────────

/**
 * Records what reaches the board while a person drives a leg — W A S D and
 * Q / E on /plc, or the keys on /gcode and /follow — and turns it into that
 * leg's scenario text (scenarioFromWire).
 *
 * The wire rather than the keys, for the same reason as routes.js's recorder:
 * a chunk a stop dropped before it was written never moved a wheel.
 */
export class ScenarioRecorder {
  constructor({ link }) {
    this.link = link;
    this.id = null;
    this.lines = [];
    this._off = null;
    this.startedAt = 0;
  }

  get active() { return this.id !== null; }

  start(id) {
    const slot = S.scenarioSlot(id);
    if (!slot) throw new Error(`bilinmeyen senaryo: ${id}`);
    if (this.active) throw new Error(`zaten öğretiliyor: ${S.scenarioSlot(this.id).label}`);
    this.id = id;
    this.lines = [];
    this.startedAt = Date.now();
    this._off = this.link.onWrite((cmd) => this.lines.push(String(cmd)));
  }

  /** Finish: {id, text, moves, skipped}. */
  stop() {
    if (!this.active) throw new Error('öğretme açık değil');
    const slot = S.scenarioSlot(this.id);
    const when = new Date().toLocaleString('tr-TR', { hour12: false });
    const out = { id: this.id, ...S.scenarioFromWire(this.lines, { title: `${slot.label} — sürülerek öğretildi, ${when}` }) };
    this.cancel();
    return out;
  }

  cancel() {
    if (this._off) this._off();
    this._off = null;
    this.id = null;
    this.lines = [];
  }

  status() {
    // `error`: why the last start or save did not happen, set by the server.
    if (!this.active) return { active: false, error: this.error || null };
    const w = S.scenarioFromWire(this.lines);
    return { active: true, error: this.error || null, id: this.id, label: S.scenarioSlot(this.id).label,
             moves: w.moves, skipped: w.skipped, text: w.text,
             secs: Math.round((Date.now() - this.startedAt) / 1000) };
  }
}

// ── the lap: a PLC task driven from the taught scenarios ─────────────

/**
 * When the PLC hands the robot a task and says start, drive it from the
 * scenarios: Başlangıç → A{a}, A{a} → kapı, the door, kapı → B{b}, and back if
 * the way back is taught (scenarioLap). Each leg that ends tells the mission
 * what happened — yük alındı, kapıda, yük bırakıldı, başlangıçta — so the durum
 * byte the PLC sees follows the robot.
 *
 * The two station legs do not end in their event. They end in the PALLET
 * MANOEUVRE (approach_run.js): the camera finds the line, squares the robot up
 * on it, drives it along, backs up, turns 180° and drives the forks in, and
 * then the actuator runs for fifteen seconds. Only when that has finished is
 * the load actually on the forks, so only then does the mission hear "yük
 * alındı" and the durum byte become 4. A manoeuvre that fails stops the lap
 * exactly as a failed leg does — the robot is at a station with no pallet on
 * it, and driving on from there is a person's decision.
 *
 * The door needs nothing special here. Arriving at it puts the mission in its
 * gate phase, the mission's hold pauses the runner, and the next leg — the door
 * itself — is started straight away and waits before its first command until
 * the PLC says continue. The PLC's bekle mid-leg is the same hold.
 *
 * A leg that fails or is stopped stops the lap where it is. It is not retried
 * by itself: the robot is somewhere between two taught places, and only a
 * person can say whether driving on from there is safe (retry()).
 *
 * A lap starts only on the change into to_pick — the PLC's start — with the
 * automatic mode on. Turning the mode on mid-task does not set a robot off on
 * a leg that begins somewhere it is not.
 */
export class LapDriver {
  /**
   * @param {object} o
   * @param {ScenarioRunner} o.runner
   * @param {() => object} o.texts          id → scenario text, as saved
   * @param {() => object} o.mission        plcMissionStatus()
   * @param {(name: string) => void} o.event  plcMissionEvent, with the hold applied
   * @param {(text: string) => void} o.log  a line in the mission's log
   * @param {() => boolean} o.enabled
   * @param {() => (string|null)} [o.busy]  why a leg may not start right now
   * @param {object} [o.approach]  an ApproachRunner — the pallet manoeuvre the
   *        two station legs end in. Without one those legs just end.
   */
  constructor({ runner, texts, mission, event, log, enabled, busy = () => null,
                approach = null }) {
    Object.assign(this, { runner, texts, mission, event, log, enabled, busy, approach });
    this.lap = null;
    this._seenStart = false;    // this task's to_pick has been looked at already
    this._ours = null;          // the leg id the runner is driving for the lap
    this._manoeuvre = null;     // the leg whose approach is running
    runner.onEnd = (last) => this._ended(last);
    if (approach) approach.onEnd = (last) => this._approachEnded(last);
  }

  tick() {
    const m = this.mission() || {};
    const lap = this.lap;
    const active = lap && (lap.state === 'driving' || lap.state === 'manoeuvre' || lap.state === 'failed');

    // The task is gone from under the lap: reset, e-stop reset, a new task.
    if (active && (!m.task || m.task.a !== lap.task.a || m.task.b !== lap.task.b
                   || m.phase === 'ready' || m.phase === 'accepted')) {
      this._halt('görev sıfırlandı');
    }

    if (!m.task || m.phase === 'ready' || m.phase === 'accepted') { this._seenStart = false; return; }
    if (m.phase !== 'to_pick' || this._seenStart) return;
    this._seenStart = true;
    if (!this.enabled()) return;

    const plan = S.scenarioLap(m.task, this.texts());
    this.lap = { task: { ...m.task }, legs: plan.legs, home: plan.home, i: 0,
                 state: 'driving', why: null, manoeuvre: null,
                 startedAt: Date.now(), endedAt: null };
    if (!plan.ok) {
      this._fail(`öğretilmemiş: ${plan.missing.join(', ')}`);
      return;
    }
    this.log(`otomatik: A${m.task.a} → B${m.task.b} senaryolarla sürülüyor`
      + (plan.home ? '' : ' (dönüş öğretilmemiş)'));
    this._startLeg();
  }

  _startLeg() {
    const lap = this.lap;
    const leg = lap.legs[lap.i];
    const busy = this.busy();
    if (busy) { this._fail(busy); return; }
    const res = this.runner.start(leg.id, (this.texts() || {})[leg.id] || '');
    if (!res.ok) { this._fail(`${leg.label}: ${res.why}`); return; }
    this._ours = leg.id;
    lap.state = 'driving';
    lap.why = null;
  }

  _ended(last) {
    const lap = this.lap;
    if (!lap || lap.state !== 'driving' || this._ours !== last.id) return;
    this._ours = null;
    const leg = lap.legs[lap.i];
    if (last.result !== 'bitti') {
      this._fail(`${leg.label}: ${last.why || last.result}`);
      return;
    }
    // A station leg is not over when its G-code is: the pallet is still in
    // front of the robot and the forks are still pointing the other way.
    if (leg.approach && this.approach) { this._startApproach(leg); return; }
    this._after(leg);
  }

  /** The pallet manoeuvre, between a station leg and the event it reports. */
  _startApproach(leg) {
    const lap = this.lap;
    // The robot is at the station whether or not the camera read its code on
    // the way in, and byte 1 / byte 2 of PAKET_TX say which station that is.
    this.event(leg.approach === 'pick' ? 'at_pick' : 'at_drop');
    const res = this.approach.start(leg.approach);
    if (!res.ok) { this._fail(`${leg.label}: ${res.why}`); return; }
    this._manoeuvre = leg.approach;
    lap.state = 'manoeuvre';
    lap.manoeuvre = leg.approach;
    lap.why = null;
  }

  _approachEnded(last) {
    const lap = this.lap;
    if (!lap || lap.state !== 'manoeuvre' || this._manoeuvre !== last.kind) return;
    this._manoeuvre = null;
    lap.manoeuvre = null;
    const leg = lap.legs[lap.i];
    if (last.result !== 'bitti') {
      this._fail(`${leg.label} manevrası: ${last.why || last.result}`);
      return;
    }
    lap.state = 'driving';
    this._after(leg);
  }

  /** The leg (and its manoeuvre) are done: report it, and start the next. */
  _after(leg) {
    const lap = this.lap;
    lap.i++;
    const done = lap.i >= lap.legs.length;
    if (done) {
      // The mission has left to_pick for good; the next task's start counts.
      this._seenStart = false;
      lap.state = 'done';
      lap.endedAt = Date.now();
      lap.why = lap.home ? null : 'dönüş öğretilmemiş — robotu elle başlangıca getirin';
    }
    // The mission first, so a door's hold is on the runner before the next
    // leg sends anything.
    if (leg.then) this.event(leg.then);
    if (done) {
      this.log(lap.home ? 'otomatik: tur tamamlandı' : `otomatik: yük bırakıldı — ${lap.why}`);
      return;
    }
    this._startLeg();
  }

  _fail(why) {
    this.lap.state = 'failed';
    this.lap.why = why;
    this._ours = null;
    this._manoeuvre = null;
    this.lap.manoeuvre = null;
    this.log(`otomatik sürüş durdu: ${why}`);
  }

  _halt(why) {
    if (this._ours && this.runner.running && this.runner.run.id === this._ours) {
      this._ours = null;
      this.runner.stop(why);
    }
    if (this._manoeuvre && this.approach && this.approach.running) {
      this._manoeuvre = null;
      this.approach.stop(why);
    }
    this._ours = null;
    this._manoeuvre = null;
    this.lap.state = 'stopped';
    this.lap.why = why;
    this.lap.endedAt = Date.now();
  }

  /** Drive the failed leg again, from wherever the robot is now. */
  retry() {
    const m = this.mission() || {};
    const lap = this.lap;
    if (!lap || lap.state !== 'failed') return { ok: false, why: 'yeniden denenecek etap yok' };
    if (!m.task || m.task.a !== lap.task.a || m.task.b !== lap.task.b) return { ok: false, why: 'görev değişmiş' };
    const plan = S.scenarioLap(lap.task, this.texts());
    if (!plan.ok) { lap.why = `öğretilmemiş: ${plan.missing.join(', ')}`; return { ok: false, why: lap.why }; }
    // Taught since it failed, perhaps: take the legs as they are now.
    const at = lap.legs[lap.i] ? lap.legs[lap.i].id : null;
    lap.legs = plan.legs;
    lap.home = plan.home;
    lap.i = Math.max(0, plan.legs.findIndex((l) => l.id === at));
    this.log(`otomatik: ${lap.legs[lap.i].label} yeniden deneniyor`);
    this._startLeg();
    return { ok: lap.state === 'driving', why: lap.why };
  }

  /** Let go of the lap; the leg in progress stops after its current move. */
  abandon(why = 'otomatik sürüş bırakıldı') {
    const lap = this.lap;
    if (!lap || (lap.state !== 'driving' && lap.state !== 'failed')) return false;
    this._halt(why);
    this.log(`otomatik: ${why}`);
    return true;
  }

  status() {
    const lap = this.lap;
    return {
      enabled: !!this.enabled(),
      lap: lap ? { ...lap, legs: lap.legs.map((l, i) => ({ ...l,
        state: i < lap.i ? 'bitti'
          : i === lap.i && lap.state === 'manoeuvre' ? 'manevra'
          : i === lap.i && lap.state === 'driving' ? 'sürülüyor'
          : i === lap.i && lap.state === 'failed' ? 'durdu' : 'sırada' })) } : null,
    };
  }
}
