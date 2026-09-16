/**
 * The lift: one linear actuator, two GPIO lines on the Raspberry Pi.
 *
 *     GPIO10  ENABLE     dh = dayan (stop)      dl = başla (run)
 *     GPIO22  DIRECTION  dh = yuxarı (up)       dl = aşağı (down)
 *
 * Set with `pinctrl`, exactly the commands that were tried by hand on the Pi:
 *
 *     pinctrl set GPIO10 op dh      stop
 *     pinctrl set GPIO22 op dl      down
 *
 * The enable line is ACTIVE LOW — a high pin is the stopped one. That is the
 * fact the rest of this file is arranged around: a Pi that boots with the pin
 * floating, or a server that crashes, must not leave the actuator driving. So
 * the very first thing init() does is drive ENABLE high, before it touches the
 * direction, and shutdown does the same thing last.
 *
 * `pinctrl` rather than a GPIO library: it is already on every Raspberry Pi OS
 * image, it is what was used to find out which level means what, and a new
 * native npm dependency for two pins that change a few times a minute is not
 * a trade worth making. Each call is a ~10 ms process spawn, which is nothing
 * at the rate a person presses Q.
 *
 * Every pin write goes through one promise chain. Q-E-Q pressed fast is three
 * spawns in flight, and without the chain nothing says they land in order — a
 * stop that overtakes a start is a start that happens last.
 */

import { execFile } from 'node:child_process';
import { reply, readBody } from './marlin_http.js';

export const ACTUATOR_DEFAULTS = {
  enPin: 10,
  dirPin: 22,
  // A single continuous run is cut after this long. A linear actuator against
  // its own end stop is a stalled motor drawing locked-rotor current, and a
  // cheap one has no limit switch to save it — twenty seconds is longer than
  // any stroke this robot has, so reaching it means the thing is pushing at an
  // end or a jam, not moving a load. 0 turns the cut off.
  maxRunMs: 20000,
  // Reversing a motor that is still turning throws the winding's stored
  // energy back through the driver. So E while running stops, waits this long,
  // and only then starts the other way.
  reversePauseMs: 250,
};

/** The pin levels, by meaning. Written down once so no caller spells `dh`. */
const LEVEL = { run: 'dl', stop: 'dh', up: 'dh', down: 'dl' };

function pinctrl(pin, level) {
  return new Promise((resolve, reject) => {
    execFile('pinctrl', ['set', `GPIO${pin}`, 'op', level], { timeout: 3000 },
      (err, _out, stderr) => {
        if (!err) return resolve();
        reject(new Error(err.code === 'ENOENT'
          ? 'pinctrl tapılmadı — bu Raspberry Pi deyil?'
          : (String(stderr || '').trim() || err.message)));
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Actuator {
  /**
   * @param {object} [cfg]  ACTUATOR_DEFAULTS overrides, plus:
   *   enabled  false = dry run: the state is kept and reported, no pin is
   *            touched. What `--no-actuator` and the tests use — a test suite
   *            that toggles real GPIO on the machine it runs on is not a test.
   *   set      (pin, level) => Promise — a stand-in for pinctrl
   */
  constructor(cfg = {}) {
    this.cfg = { ...ACTUATOR_DEFAULTS, ...cfg };
    this.enabled = cfg.enabled !== false;
    this._set = cfg.set || pinctrl;

    this.running = false;
    this.dir = 'up';
    this.since = 0;              // when the current run started
    this.cut = false;            // the last run was ended by maxRunMs
    this.err = null;
    this.writes = [];            // the last few pin writes, newest last

    this._chain = Promise.resolve();
    this._timer = null;
  }

  /** Queue pin writes behind whatever is already on its way. */
  _pins(...ops) {
    const run = async () => {
      for (const op of ops) {
        if (op === 'pause') { await sleep(this.cfg.reversePauseMs); continue; }
        const [pin, level] = op;
        this.writes.push(`GPIO${pin}=${level}`);
        if (this.writes.length > 8) this.writes.shift();
        if (!this.enabled) continue;
        try {
          await this._set(pin, level);
          this.err = null;
        } catch (e) {
          this.err = String(e.message || e);
        }
      }
    };
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  /** Stopped, pointing up. Called once at startup, before anything else. */
  init() {
    return this._pins([this.cfg.enPin, LEVEL.stop], [this.cfg.dirPin, LEVEL[this.dir]]);
  }

  start(dir) {
    if (dir === 'up' || dir === 'down') {
      if (this.running && dir !== this.dir) return this.setDir(dir);
      this.dir = dir;
    }
    this.running = true;
    this.cut = false;
    this.since = Date.now();
    this._arm();
    // Direction first, then enable: the actuator never starts, even for one
    // spawn's worth of milliseconds, the way it was last going.
    return this._pins([this.cfg.dirPin, LEVEL[this.dir]], [this.cfg.enPin, LEVEL.run]);
  }

  stop(reason = null) {
    this.running = false;
    clearTimeout(this._timer);
    this._timer = null;
    if (reason === 'cut') this.cut = true;
    // Written even when already stopped. A stop is the one command that must
    // never be skipped because the software *thought* it was not needed.
    return this._pins([this.cfg.enPin, LEVEL.stop]);
  }

  toggle() { return this.running ? this.stop() : this.start(); }

  setDir(dir) {
    if (dir !== 'up' && dir !== 'down') throw new Error('dir must be up or down');
    if (dir === this.dir) return this._chain;
    this.dir = dir;
    if (!this.running) return this._pins([this.cfg.dirPin, LEVEL[dir]]);
    // Running: stop, let it spin down, turn round, go. See reversePauseMs.
    this.since = Date.now();
    this._arm();
    return this._pins([this.cfg.enPin, LEVEL.stop], 'pause',
                      [this.cfg.dirPin, LEVEL[dir]], [this.cfg.enPin, LEVEL.run]);
  }

  flip() { return this.setDir(this.dir === 'up' ? 'down' : 'up'); }

  _arm() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!(this.cfg.maxRunMs > 0)) return;
    this._timer = setTimeout(() => { this._timer = null; this.stop('cut'); },
                             this.cfg.maxRunMs);
    this._timer.unref?.();
  }

  /** Resolves once every pin write asked for so far has landed. */
  settled() { return this._chain; }

  status(now = Date.now()) {
    return {
      running: this.running,
      dir: this.dir,
      run_s: this.running ? Math.round((now - this.since) / 100) / 10 : 0,
      max_s: this.cfg.maxRunMs / 1000,
      cut: this.cut,
      dry: !this.enabled,
      pins: { en: this.cfg.enPin, dir: this.cfg.dirPin },
      err: this.err,
      writes: this.writes.slice(),
    };
  }
}

/**
 * One command, by name. Shared by the HTTP route and the WebSocket so a
 * button, a key and /follow's lift step all mean the same thing.
 *
 *   start [dir]   run — optionally in a given direction
 *   stop          stop
 *   toggle        Q: start if stopped, stop if running
 *   flip          E: the other direction (through a stop, if running)
 *   up | down     set the direction; running or not
 */
export function actuatorCommand(act, action, dir) {
  switch (String(action || '')) {
    case 'start':  act.start(dir); break;
    case 'stop':   act.stop(); break;
    case 'toggle': act.toggle(); break;
    case 'flip':   act.flip(); break;
    case 'up':     act.setDir('up'); break;
    case 'down':   act.setDir('down'); break;
    default: throw new Error(`unknown action ${JSON.stringify(action)} — `
                           + 'try start, stop, toggle, flip, up, down');
  }
  return act.status();
}

/** GET /api/actuator → status; POST {action, dir} → the command, then status. */
export function actuatorApi(act) {
  return async function handle(req, res) {
    if (req.method === 'GET') { reply(res, 200, act.status()); return; }
    if (req.method !== 'POST') { reply(res, 405, { error: 'use GET or POST' }); return; }
    try {
      const data = await readBody(req);
      reply(res, 200, actuatorCommand(act, data.action, data.dir));
    } catch (e) {
      reply(res, 400, { error: String(e.message || e) });
    }
  };
}
