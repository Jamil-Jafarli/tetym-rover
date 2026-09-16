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
 * sysfs first, because writing a file beats spawning a process; pinctrl when
 * sysfs is not there. Both are probed once, on the first write, and the result
 * is what `status().backend` reports.
 *
 * Nothing here reads a pin. Inputs on the Pi would need a library and an
 * interrupt; the sonar and the switches are the board's job.
 */

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';

const SYSFS = '/sys/class/gpio';

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
  constructor() {
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
      if (os.platform() !== 'linux') {
        this.error = `${os.platform()} — Raspberry Pi değil, pinler sürülmüyor`;
        this.backend = 'none';
        return this.backend;
      }
      if (fs.existsSync(`${SYSFS}/export`)) {
        try {
          fs.accessSync(`${SYSFS}/export`, fs.constants.W_OK);
          this.backend = 'sysfs';
          return this.backend;
        } catch { /* no permission; try the next one */ }
      }
      const err = await run('pinctrl', ['get', '0']);
      if (!err) { this.backend = 'pinctrl'; return this.backend; }
      this.error = 'ne /sys/class/gpio yazılabiliyor ne de pinctrl var '
                 + '(Raspberry Pi OS Bookworm: sudo apt install raspi-gpio, '
                 + 'ya da sunucuyu gpio grubundaki bir kullanıcıyla çalıştırın)';
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
      try {
        if (!this._exported.has(n)) {
          if (!fs.existsSync(`${SYSFS}/gpio${n}`)) fs.writeFileSync(`${SYSFS}/export`, String(n));
          fs.writeFileSync(`${SYSFS}/gpio${n}/direction`, 'out');
          this._exported.add(n);
        }
        fs.writeFileSync(`${SYSFS}/gpio${n}/value`, String(v));
        this.writes++;
        return true;
      } catch (err) {
        this.failed++;
        this.error = `GPIO${n}: ${err.message || err}`;
        return false;
      }
    }

    const err = await run('pinctrl', ['set', String(n), 'op', v ? 'dh' : 'dl']);
    if (err) { this.failed++; this.error = `GPIO${n}: ${err}`; return false; }
    this.writes++;
    return true;
  }

  /** Everything the pages show about the pins, in one object. */
  status() {
    return {
      backend: this.backend,
      available: this.backend !== null && this.backend !== 'none',
      error: this.error,
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
        try { fs.writeFileSync(`${SYSFS}/unexport`, String(n)); } catch { /* going away anyway */ }
      }
      this._exported.clear();
    }
  }
}
