/**
 * The reversing buzzer, on two of the Pi's pins.
 *
 * A forklift that backs up without a sound is the one hazard on this robot
 * that has nothing to do with software going wrong: everything else it does is
 * in front of it and visible, and reversing is neither. So the rule is as
 * simple as it can be — the wheels are going backwards, the buzzer sounds —
 * and it is enforced here, from the same demand the motors are given, rather
 * than from a page that might not be open.
 *
 * ── Two pins ────────────────────────────────────────────────────────
 *
 * Both are driven together, high while the buzzer should sound. Two because
 * that is what the board on this robot takes; they are configured, not
 * hard-coded, and the second one may be left out. `invert` is there for a
 * module that sounds on LOW, which most cheap relay and buzzer boards do.
 *
 * ── Beeping, not droning ────────────────────────────────────────────
 *
 * The pattern is the familiar beep-pause-beep. A continuous tone is worse in
 * two ways: it is harder to place in a noisy hall, and a stuck output sounds
 * exactly like a working one. With beeps, a buzzer that will not stop is
 * obviously broken. `mode: 'steady'` is there for a module that makes its own
 * beeps from a steady input.
 *
 * Nothing here talks to the pins directly — see gpio.js, which knows the three
 * ways a Pi might let it.
 */

export const BUZZER_DEFAULTS = {
  enabled: false,       // off until someone says which pins are wired
  pins: [17, 27],       // BCM numbering
  mode: 'beep',         // 'beep' | 'steady'
  beepMs: 400,
  gapMs: 400,
  invert: false,        // true for a module that sounds when the pin is LOW
};

/** How often the pattern is stepped. Well under the shortest beep. */
const TICK_MS = 50;

export class Buzzer {
  /**
   * @param {object} opts
   * @param {import('./gpio.js').Gpio} opts.gpio
   */
  constructor({ gpio, cfg = {} } = {}) {
    this.gpio = gpio;
    this.cfg = { ...BUZZER_DEFAULTS };
    this.setCfg(cfg);

    this.reversing = false;
    this.since = 0;          // when reversing started, for the pattern
    this.sounding = false;   // what the pins are being told right now
    this.beeps = 0;
    this.lastAt = 0;
    this._timer = setInterval(() => this.tick(), TICK_MS);
    this._timer.unref?.();
  }

  setCfg(cfg = {}) {
    const c = cfg.buzzer || cfg;
    if (typeof c.enabled === 'boolean') this.cfg.enabled = c.enabled;
    if (typeof c.invert === 'boolean') this.cfg.invert = c.invert;
    if (c.mode === 'beep' || c.mode === 'steady') this.cfg.mode = c.mode;
    if (Array.isArray(c.pins)) {
      const pins = c.pins.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 27);
      this.cfg.pins = [...new Set(pins)].slice(0, 4);
    }
    for (const k of ['beepMs', 'gapMs']) {
      const n = Number(c[k]);
      if (Number.isFinite(n)) this.cfg[k] = Math.max(50, Math.min(5000, Math.round(n)));
    }
    return this.cfg;
  }

  /**
   * The wheels are going backwards, or they are not.
   *
   * Called from the same place the demand is resolved, at whatever rate that
   * runs. Only the change matters here; the pattern has its own clock.
   */
  setReversing(on, now = Date.now()) {
    const want = !!on;
    if (want === this.reversing) return;
    this.reversing = want;
    this.since = want ? now : 0;
    this.tick(now);
  }

  /** What the buzzer should be doing at this instant. */
  wants(now = Date.now()) {
    if (!this.cfg.enabled || !this.reversing) return false;
    if (this.cfg.mode === 'steady') return true;
    const period = this.cfg.beepMs + this.cfg.gapMs;
    return ((now - this.since) % period) < this.cfg.beepMs;
  }

  tick(now = Date.now()) {
    const want = this.wants(now);
    if (want === this.sounding) return;
    this.sounding = want;
    if (want) { this.beeps++; this.lastAt = now; }
    const level = this.cfg.invert ? !want : want;
    for (const pin of this.cfg.pins) this.gpio.set(pin, level);
  }

  /** Sound for a moment, whatever the wheels are doing — the page's test. */
  test(ms = 600, now = Date.now()) {
    const was = this.reversing;
    this.setReversing(true, now);
    clearTimeout(this._testOff);
    this._testOff = setTimeout(() => this.setReversing(was), ms);
    this._testOff.unref?.();
  }

  status() {
    return {
      ...this.cfg,
      reversing: this.reversing,
      sounding: this.sounding,
      beeps: this.beeps,
      gpio: this.gpio.status(),
    };
  }

  close() {
    clearInterval(this._timer);
    clearTimeout(this._testOff);
    this.reversing = false;
    this.sounding = false;
    for (const pin of this.cfg.pins) this.gpio.set(pin, this.cfg.invert);
  }
}
