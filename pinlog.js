/**
 * What went wrong with the Pi's pins, kept long enough to look at.
 *
 * The pin modules each held one error — the last — and cleared it on the next
 * write that worked. That is right for a status light and useless for finding
 * out what happened: a pinctrl that failed twice a minute showed a clean page
 * every time somebody looked. So every failure is also written here, by the
 * module it happened in, and /pins shows the list.
 *
 *   source   'pins'  the buzzer and the pins noted on /pins (gpio.js)
 *            'lift'  the actuator on GPIO10 / GPIO22 (actuator.js)
 *            'lidar' the lidar motor's L298N (lidar.js)
 *
 * The same failure again and again is ONE entry with a count, not a page of
 * copies — a beeping buzzer with a broken pin fails four times a second, and a
 * list of thousands of identical lines hides the one different line that
 * matters. "Again" is the same source, pin and message within `repeatMs` of
 * the last time it was seen.
 *
 * Entries also go to logs/pins.log, one JSON line each, so what happened
 * before a restart — the kind of failure that makes you restart — is still
 * there afterwards. Only new entries are written, not repeats.
 */

import fs from 'node:fs';
import path from 'node:path';

export const PIN_SOURCES = {
  pins: 'Pinler / buzzer',
  lift: 'Lift (aktuatör)',
  lidar: 'LiDAR motoru',
};

export class PinLog {
  /**
   * @param {object} [opts]
   * @param {number} [opts.max]       entries kept in memory
   * @param {number} [opts.repeatMs]  the same failure within this is a repeat
   * @param {string|null} [opts.file] where to append, or null for memory only
   */
  constructor({ max = 200, repeatMs = 10000, file = null } = {}) {
    this.max = max;
    this.repeatMs = repeatMs;
    this.file = file;
    this.entries = [];       // oldest first
    this.total = 0;          // failures since start, repeats included
    this.seq = 0;
    this.since = Date.now();
    this.fileErr = null;
  }

  /**
   * One failure.
   * @param {{source: string, pin?: number|null, action?: string|null,
   *          message: string, level?: 'error'|'warn'}} e
   */
  add(e, now = Date.now()) {
    const source = PIN_SOURCES[e.source] ? e.source : 'pins';
    const pin = e.pin == null || e.pin === '' ? null : Number(e.pin);
    const message = String(e.message ?? '').trim().slice(0, 400) || 'bilinmeyen hata';
    const level = e.level === 'warn' ? 'warn' : 'error';
    this.total++;

    const last = [...this.entries].reverse()
      .find((x) => x.source === source && x.pin === pin && x.message === message);
    if (last && now - last.lastAt <= this.repeatMs) {
      last.count++;
      last.lastAt = now;
      if (e.action) last.action = String(e.action).slice(0, 60);
      return last;
    }

    const entry = { id: ++this.seq, at: now, lastAt: now, source, pin,
                    action: e.action ? String(e.action).slice(0, 60) : null,
                    message, level, count: 1 };
    this.entries.push(entry);
    while (this.entries.length > this.max) this.entries.shift();
    this._write(entry);
    return entry;
  }

  _write(entry) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ ...entry, time: new Date(entry.at).toISOString() }) + '\n');
      this.fileErr = null;
    } catch (err) {
      // Not logged to itself: a log that cannot be written is said once, on
      // the page, not turned into a loop of failures about failures.
      this.fileErr = String(err.message || err);
    }
  }

  clear(now = Date.now()) {
    this.entries = [];
    this.total = 0;
    this.since = now;
  }

  /** For /pins: newest first, and how many per source. */
  status(limit = 100) {
    const counts = Object.fromEntries(Object.keys(PIN_SOURCES).map((k) => [k, 0]));
    for (const e of this.entries) counts[e.source] += e.count;
    return {
      entries: this.entries.slice(-limit).reverse(),
      counts,
      total: this.total,
      since: this.since,
      file: this.file,
      file_err: this.fileErr,
      sources: PIN_SOURCES,
    };
  }
}

/** A log that keeps nothing — what a module gets when nobody passed one. */
export const NO_PIN_LOG = { add() { return null; } };
