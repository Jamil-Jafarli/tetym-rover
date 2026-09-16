/**
 * The Raspberry Pi's own output pins.
 *
 * The motors are the Ender board's and the sensors were the ESP32's; this is
 * for the few things that hang off the Pi itself, the reversing buzzer being
 * the first of them (buzzer.js).
 *
 * ── Why three ways of doing the same thing ──────────────────────────
 *
 * There is no one way to set a GPIO on a Pi any more, and which one works
 * depends on the OS image rather than on anything this code can see:
 *
 *   pinctrl   Raspberry Pi OS Bookworm ships it. `pinctrl set 17 op dh` sets
 *             the pin and exits, and the pin stays where it was put — which is
 *             exactly what a buzzer that beeps twice a second needs.
 *   sysfs     /sys/class/gpio, the old way. Deprecated, still present on many
 *             images, and the cheapest of the three: a file write, no process.
 *   none      not a Pi, or no permission. Then nothing is driven and the page
 *             says so, with the reason — a buzzer that is quiet because the
 *             library is missing must not look like a buzzer that is quiet
 *             because the robot is going forwards.
 *
 * pinctrl first. It takes the BCM number printed on the pinout, it is what the
 * lift already drives GPIO10/22 with on this robot, and it works the same on
 * every Pi OS kernel. sysfs only when there is no pinctrl — and then with the
 * GPIO chip's base added: since kernel 6.6 the sysfs numbers are not the BCM
 * numbers any more (GPIO17 is 529 on a Pi 4 and 588 on a Pi 5), so writing
 * "17" to /sys/class/gpio/export is refused, every time, while the directory
 * looks perfectly writable. That was this file's first version: sysfs chosen,
 * 0 writes, every one failed. Probed once, on the first write, and the result
 * is what `status().backend` reports.
 *
 * Nothing here reads a pin. Inputs on the Pi would need a library and an
 * interrupt; the sonar and the switches are the board's job.
 */

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';

const SYSFS = '/sys/class/gpio';

/**
 * The base of the chip the 40-pin header is on, from /sys/class/gpio/gpiochip*:
 * pinctrl-bcm2835 (Pi 1–3, Zero), pinctrl-bcm2711 (Pi 4), pinctrl-rp1 (Pi 5).
 * 0 when there is no such chip — an old kernel numbering from zero.
 */
export function sysfsBase(root = SYSFS) {
  let chips = [];
  try { chips = fs.readdirSync(root).filter((d) => /^gpiochip\d+$/.test(d)); } catch { return 0; }
  const read = (d, f) => { try { return fs.readFileSync(`${root}/${d}/${f}`, 'utf8').trim(); } catch { return ''; } };
  const header = chips
    .map((d) => ({ label: read(d, 'label'), base: Number(read(d, 'base')), ngpio: Number(read(d, 'ngpio')) }))
    .filter((c) => /^pinctrl-(rp1|bcm2711|bcm2835|bcm2712)/.test(c.label) && Number.isFinite(c.base) && c.ngpio >= 28)
    .sort((a, b) => a.base - b.base)[0];
  return header ? header.base : 0;
}

/** BCM numbering, the numbers printed on every Pi pinout diagram. */
export const GPIO_MIN = 0;
export const GPIO_MAX = 27;

/** The pins that are not free: power, ground, and the ones with a job here. */
export const GPIO_RESERVED = {
  14: 'UART TX (seri konsol)',
  15: 'UART RX (seri konsol)',
  2: 'I²C SDA',
  3: 'I²C SCL',
};

export function gpioValid(pin) {
  const n = Number(pin);
  return Number.isInteger(n) && n >= GPIO_MIN && n <= GPIO_MAX;
}

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 2000 }, (err) => resolve(err ? String(err.message || err) : null));
});

export class Gpio {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled]  false is dry: what was asked for is kept
   *   and shown, no pin is touched — for a laptop, and for the test suites,
   *   which run on the Pi itself (the same idea as --no-actuator)
   * @param {{add: Function}} [opts.log]  where failures are kept (pinlog.js)
   * @param {string} [opts.sysfs]      the sysfs GPIO directory — for the tests
   * @param {string} [opts.platform]   os.platform(), overridable for the tests
   * @param {Function} [opts.run]      (cmd, args) => Promise<error|null> — for the tests
   */
  constructor({ enabled = true, log = null, sysfs = SYSFS, platform = os.platform(), run: runner = run } = {}) {
    this.enabled = enabled;
    this.log = log || { add() {} };
    this.sysfs = sysfs;
    this.platform = platform;
    this.run = runner;
    this.base = 0;               // sysfs number of BCM GPIO0, when sysfs is used
    this.backend = null;         // 'sysfs' | 'pinctrl' | 'none'
    this.error = null;
    this.state = new Map();      // pin -> 0/1, what we last asked for
    this.writes = 0;
    this.failed = 0;
    this._exported = new Set();
    this._probe = null;
  }

  /** Which way of setting a pin this machine has. Probed once. */
  async _backendFor() {
    if (this.backend) return this.backend;
    if (this._probe) return this._probe;
    this._probe = (async () => {
      if (!this.enabled) {
        this.error = 'quru rejim (--no-gpio) — pinlere dokunulmuyor';
        this.backend = 'none';
        return this.backend;
      }
      if (this.platform !== 'linux') {
        this.error = `${this.platform} — Raspberry Pi değil, pinler sürülmüyor`;
        this.backend = 'none';
        return this.backend;
      }
      const err = await this.run('pinctrl', ['get', '17']);
      if (!err) { this.backend = 'pinctrl'; this.error = null; return this.backend; }
      if (fs.existsSync(`${this.sysfs}/export`)) {
        try {
          fs.accessSync(`${this.sysfs}/export`, fs.constants.W_OK);
          this.base = sysfsBase(this.sysfs);
          this.backend = 'sysfs';
          return this.backend;
        } catch { /* no permission either */ }
      }
      this.error = 'ne pinctrl çalışıyor ne de /sys/class/gpio yazılabiliyor '
                 + '(Raspberry Pi OS: sudo apt install raspi-utils — pinctrl; '
                 + 'ya da sunucuyu gpio grubundaki bir kullanıcıyla çalıştırın)';
      this.log.add({ source: 'pins', action: 'pin erişimi', message: `${this.error} — pinctrl: ${err}` });
      this.backend = 'none';
      return this.backend;
    })();
    return this._probe;
  }

  /**
   * Drive a pin high or low.
   * @returns {Promise<boolean>} whether it actually reached the hardware
   */
  async set(pin, value) {
    if (!gpioValid(pin)) return false;
    const n = Number(pin), v = value ? 1 : 0;
    this.state.set(n, v);
    const backend = await this._backendFor();
    if (backend === 'none') return false;

    if (backend === 'sysfs') {
      // BCM n is sysfs base + n: see the header.
      const s = this.base + n;
      try {
        if (!this._exported.has(n)) {
          if (!fs.existsSync(`${this.sysfs}/gpio${s}`)) fs.writeFileSync(`${this.sysfs}/export`, String(s));
          fs.writeFileSync(`${this.sysfs}/gpio${s}/direction`, 'out');
          this._exported.add(n);
        }
        fs.writeFileSync(`${this.sysfs}/gpio${s}/value`, String(v));
        this.writes++;
        return true;
      } catch (err) {
        this.failed++;
        this.error = `GPIO${n}: ${err.message || err}`;
        this.log.add({ source: 'pins', pin: n, action: `sysfs gpio${s} ${v ? 'HIGH' : 'LOW'}`,
                       message: String(err.message || err) });
        return false;
      }
    }

    const err = await this.run('pinctrl', ['set', String(n), 'op', v ? 'dh' : 'dl']);
    if (err) {
      this.failed++;
      this.error = `GPIO${n}: ${err}`;
      this.log.add({ source: 'pins', pin: n, action: `pinctrl ${v ? 'dh' : 'dl'}`, message: err });
      return false;
    }
    this.writes++;
    return true;
  }

  /** Everything the pages show about the pins, in one object. */
  status() {
    return {
      backend: this.backend,
      available: this.backend !== null && this.backend !== 'none',
      error: this.error,
      sysfs_base: this.backend === 'sysfs' ? this.base : null,
      writes: this.writes,
      failed: this.failed,
      pins: Object.fromEntries(this.state),
    };
  }

  /** Low, and released. Called on shutdown: a buzzer left on is a fire alarm. */
  async close() {
    for (const pin of [...this.state.keys()]) await this.set(pin, 0);
    if (this.backend === 'sysfs') {
      for (const n of this._exported) {
        try { fs.writeFileSync(`${this.sysfs}/unexport`, String(this.base + n)); } catch { /* going away anyway */ }
      }
      this._exported.clear();
    }
  }
}
