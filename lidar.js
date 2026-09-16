/**
 * The "lidar": a DC motor standing in for one, on an L298N, spun slowly.
 *
 *     GPIO18  ENA   PWM — the voltage     (take the ENA jumper off)
 *     GPIO23  IN1   high while running
 *     GPIO24  IN2   always low
 *
 * The bridge is fed 5 V and the motor wants 1.6 V, so ENA is pulsed. What the
 * motor sees is not duty × 5 V, though: the L298N is a bipolar bridge and
 * loses about 1.4 V across its two transistors at the small current a motor
 * like this draws. So the duty is worked out against what is left:
 *
 *     duty = volts / (supplyV − dropV)       1.6 / (5 − 1.4) ≈ 44 %
 *
 * The drop is a typical figure, not a measured one. Put a multimeter across
 * OUT1/OUT2 while it runs; if it does not read 1.6, change the volts on the
 * card (or `--lidar-drop`) until it does.
 *
 * The PWM itself is held by lidar_pwm.py, a small lgpio process started on the
 * first START and kept alive — `pinctrl` can set a level but cannot hold a
 * duty cycle. If that process dies, or the server does, the pins go low: the
 * helper does it on its way out, and this file does it again with `pinctrl`
 * as a backstop.
 *
 * Unlike the lift, the lidar does NOT stop when the last page closes or on
 * Space. It is meant to spin through a whole run, and a slow motor with
 * nothing to push against has no end stop to stall on. START/STOP on the card
 * and the server shutting down are what stop it.
 */

import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { reply, readBody } from './marlin_http.js';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lidar_pwm.py');

export const LIDAR_DEFAULTS = {
  pwmPin: 18,
  in1Pin: 23,
  in2Pin: 24,
  volts: 1.6,
  supplyV: 5,
  // The L298N's saturation loss, both transistors together, at a few hundred
  // mA. The datasheet gives ~1.8 V at 1 A; less current, less drop.
  dropV: 1.4,
  // Software PWM in lgpio's thread. 1 kHz is well inside what it holds
  // steadily and what the L298N switches cleanly; it whines, which is fine.
  hz: 1000,
};

export class Lidar {
  /**
   * @param {object} [cfg]  LIDAR_DEFAULTS overrides, plus:
   *   enabled  false = dry run: state kept and reported, nothing spawned.
   *            What `--no-lidar` and the tests use.
   *   send     (line) => void — a stand-in for the helper process
   *   log      where failures are kept (pinlog.js)
   */
  constructor(cfg = {}) {
    this.cfg = { ...LIDAR_DEFAULTS, ...cfg };
    this.log = cfg.log || { add() {} };
    this.enabled = cfg.enabled !== false;
    this._stub = cfg.send || null;
    this.volts = this._clamp(this.cfg.volts);
    this.running = false;
    this.since = 0;
    this.err = null;
    this.writes = [];            // the last few commands, newest last
    this._proc = null;
    this._closing = false;
  }

  /** The most the bridge can put across the motor from this supply. */
  maxVolts() { return Math.max(0, this.cfg.supplyV - this.cfg.dropV); }

  _clamp(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('volts must be a number');
    return Math.round(Math.min(this.maxVolts(), Math.max(0, n)) * 100) / 100;
  }

  /** The ENA duty cycle for the current volts, in percent. */
  duty() {
    const max = this.maxVolts();
    return max > 0 ? Math.round((this.volts / max) * 1000) / 10 : 0;
  }

  _send(line) {
    this.writes.push(line);
    if (this.writes.length > 8) this.writes.shift();
    if (!this.enabled) return;
    if (this._stub) { this._stub(line); return; }
    const p = this._helper();
    if (p) p.stdin.write(line + '\n');
  }

  /** The lgpio process, started the first time it is needed. */
  _helper() {
    if (this._proc) return this._proc;
    const { pwmPin, in1Pin, in2Pin, hz } = this.cfg;
    let p;
    try {
      p = nodeSpawn('python3', [HELPER, pwmPin, in1Pin, in2Pin, hz].map(String),
                    { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.err = String(e.message || e);
      this.log.add({ source: 'lidar', pin: pwmPin, action: 'lidar_pwm.py başlat', message: this.err });
      return null;
    }
    this._proc = p;
    let tail = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('err ')) {
          this.err = line.slice(4);
          this.log.add({ source: 'lidar', pin: pwmPin, action: this.writes[this.writes.length - 1] || null,
                         message: this.err });
        } else if (line.startsWith('ok')) this.err = null;
      }
    });
    p.stderr.on('data', (d) => { tail = (tail + d).slice(-400); });
    p.stdin.on('error', () => { /* the exit handler says what happened */ });
    p.on('error', (e) => {
      this.err = e.code === 'ENOENT' ? 'python3 tapılmadı' : String(e.message || e);
      this.log.add({ source: 'lidar', pin: pwmPin, action: 'lidar_pwm.py başlat', message: this.err });
    });
    p.on('exit', (code) => {
      if (this._proc === p) this._proc = null;
      this._backstop();
      if (this._closing) return;
      if (this.running) this.running = false;
      if (code) {
        const why = tail.trim().split('\n').pop();
        const died = `lidar_pwm.py dayandı (${code})${why ? ': ' + why : ''}`;
        this.log.add({ source: 'lidar', pin: pwmPin, action: 'lidar_pwm.py', message: died });
        this.err = this.err || died;
      }
    });
    return p;
  }

  /** ENA low with pinctrl — whatever state the helper left the pin in. */
  _backstop() {
    if (!this.enabled || this._stub) return;
    execFile('pinctrl', ['set', `GPIO${this.cfg.pwmPin}`, 'op', 'dl'],
             { timeout: 3000 }, () => { /* best effort */ });
  }

  start() {
    this.running = true;
    this.since = Date.now();
    this._send(`on ${this.duty()}`);
  }

  stop() {
    this.running = false;
    // Sent even when already stopped: a stop is never skipped because the
    // software *thought* it was not needed.
    this._send('off');
  }

  toggle() { return this.running ? this.stop() : this.start(); }

  setVolts(v) {
    this.volts = this._clamp(v);
    if (this.running) this._send(`on ${this.duty()}`);
  }

  /** Off, and the helper gone. For shutdown. */
  async close() {
    this._closing = true;
    this.running = false;
    const p = this._proc;
    if (!p) return;
    this._send('off');
    p.stdin.end('quit\n');
    await new Promise((resolve) => {
      const t = setTimeout(() => { p.kill('SIGTERM'); resolve(); }, 1500);
      p.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  status(now = Date.now()) {
    return {
      running: this.running,
      volts: this.volts,
      duty: this.duty(),
      max_v: Math.round(this.maxVolts() * 100) / 100,
      supply_v: this.cfg.supplyV,
      drop_v: this.cfg.dropV,
      hz: this.cfg.hz,
      run_s: this.running ? Math.round((now - this.since) / 100) / 10 : 0,
      dry: !this.enabled,
      pins: { pwm: this.cfg.pwmPin, in1: this.cfg.in1Pin, in2: this.cfg.in2Pin },
      err: this.err,
      writes: this.writes.slice(),
    };
  }
}

/**
 * One command, by name — the HTTP route's.
 *
 *   start | stop | toggle
 *   volts {v}      set the voltage; applied at once if running
 */
export function lidarCommand(lidar, action, v) {
  switch (String(action || '')) {
    case 'start':  lidar.start(); break;
    case 'stop':   lidar.stop(); break;
    case 'toggle': lidar.toggle(); break;
    case 'volts':  lidar.setVolts(v); break;
    default: throw new Error(`unknown action ${JSON.stringify(action)} — `
                           + 'try start, stop, toggle, volts');
  }
  return lidar.status();
}

/** GET /api/lidar → status; POST {action, v} → the command, then status. */
export function lidarApi(lidar) {
  return async function handle(req, res) {
    if (req.method === 'GET') { reply(res, 200, lidar.status()); return; }
    if (req.method !== 'POST') { reply(res, 405, { error: 'use GET or POST' }); return; }
    try {
      const data = await readBody(req);
      reply(res, 200, lidarCommand(lidar, data.action, data.v));
    } catch (e) {
      reply(res, 400, { error: String(e.message || e) });
    }
  };
}
