/**
 * What the Raspberry Pi is doing to itself.
 *
 * The Pi is on the robot now, running the camera, the QR reader and the 20 Hz
 * stream to the ESP32 off a powerbank. That makes its own state part of the
 * robot's state: a Pi at 80 °C has already dropped its clock, a Pi swapping is
 * about to miss frames, and a powerbank sagging under the motors shows up here
 * as an undervoltage flag before it shows up as anything else.
 *
 * Everything is read from /proc and /sys — no dependencies, no sampling thread.
 * Two of the numbers are deltas rather than instants, and that is the whole
 * design of this file:
 *
 *   CPU busy is meaningless as an instant. /proc/stat counts jiffies since
 *   boot, so "12 % busy" is only a sentence if you say since when. We keep the
 *   previous sample and report the difference — which also means the first call
 *   after boot has nothing to compare against and honestly reports null rather
 *   than an average over the last four minutes.
 *
 *   The same for this process's own CPU: process.cpuUsage() is cumulative.
 *
 * vcgencmd is the one thing here that is a subprocess, so it is run rarely and
 * asynchronously, and its absence is not an error — the code runs on laptops
 * too, and a missing throttle flag is a missing throttle flag, not a crash.
 */

import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/** The one-line files under /sys, as a number. */
function readNum(p, scale = 1) {
  const t = read(p);
  if (t === null) return null;
  const n = Number(t.trim());
  return Number.isFinite(n) ? n / scale : null;
}

/** /proc/stat's cpu lines as {name, total, idle}. */
function cpuTimes() {
  const txt = read('/proc/stat');
  if (!txt) return [];
  const out = [];
  for (const line of txt.split('\n')) {
    if (!/^cpu/.test(line)) break;                 // the cpu lines come first
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    const n = parts.slice(1).map(Number);
    if (n.some((v) => !Number.isFinite(v))) continue;
    // user nice system idle iowait irq softirq steal …
    // iowait counts as idle: the core was not doing work, and calling a Pi
    // "busy" because it is waiting on the SD card is how you end up blaming
    // the wrong thing for a dropped frame.
    const idle = (n[3] || 0) + (n[4] || 0);
    const total = n.reduce((a, b) => a + b, 0);
    out.push({ name, total, idle });
  }
  return out;
}

/** MemTotal / MemAvailable in bytes — the two numbers worth having. */
function memInfo() {
  const txt = read('/proc/meminfo');
  if (!txt) {
    return { total: os.totalmem(), avail: os.freemem(), swapUsed: null };
  }
  const kb = (k) => {
    const m = txt.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree');
  return {
    total: kb('MemTotal') ?? os.totalmem(),
    // MemAvailable, not MemFree: cache is free memory that happens to be
    // useful, and reporting a Pi with a 1 GB page cache as "out of RAM" is the
    // classic way to read this file wrong.
    avail: kb('MemAvailable') ?? os.freemem(),
    swapUsed: swapTotal != null && swapFree != null ? swapTotal - swapFree : null,
  };
}

/**
 * The firmware's throttle word.
 *
 * Bits 0-3 are happening now, bits 16-19 have happened since boot. The one
 * that matters on a robot is undervoltage: a powerbank that cannot hold 5 V
 * under the motors throttles the Pi, and the symptom is "the camera got
 * choppy", which nobody attributes to the battery.
 */
function decodeThrottled(word) {
  if (word == null) return null;
  const bit = (n) => ((word >> n) & 1) === 1;
  return {
    raw: '0x' + word.toString(16),
    under_voltage: bit(0),
    capped: bit(1),
    throttled: bit(2),
    soft_temp_limit: bit(3),
    ever_under_voltage: bit(16),
    ever_throttled: bit(18),
    ok: (word & 0xf) === 0,
  };
}

const round = (v, n = 1) => (v == null ? null : Math.round(v * 10 ** n) / 10 ** n);

export class RpiStats {
  constructor() {
    this._cpu = cpuTimes();
    this._cpuAt = Date.now();
    this._proc = process.cpuUsage();
    this._procAt = Date.now();

    this.busy = null;          // % of all cores, since the last sample
    this.cores = [];           // ...and per core
    this.procBusy = null;      // this Node process, % of one core

    this.throttled = null;
    this._vcAt = 0;
    this._vcBusy = false;
    this.hasVcgencmd = true;   // until proven otherwise
  }

  /**
   * Take a sample. Call it at whatever rate the status goes out — the numbers
   * are all "since the previous call", so the interval is a property of the
   * caller and not of this file.
   */
  sample(now = Date.now()) {
    const cur = cpuTimes();
    const prev = this._cpu;
    const dt = now - this._cpuAt;

    if (prev.length && cur.length && dt > 50) {
      const pct = (a, b) => {
        const dTotal = b.total - a.total;
        const dIdle = b.idle - a.idle;
        if (dTotal <= 0) return null;
        return round(((dTotal - dIdle) / dTotal) * 100);
      };
      const byName = new Map(prev.map((c) => [c.name, c]));
      const all = cur.find((c) => c.name === 'cpu');
      this.busy = all && byName.has('cpu') ? pct(byName.get('cpu'), all) : null;
      this.cores = cur.filter((c) => c.name !== 'cpu')
        .map((c) => (byName.has(c.name) ? pct(byName.get(c.name), c) : null));
      this._cpu = cur;
      this._cpuAt = now;
    }

    const pu = process.cpuUsage();
    const pdt = now - this._procAt;
    if (pdt > 50) {
      const used = (pu.user - this._proc.user) + (pu.system - this._proc.system);
      this.procBusy = round((used / 1000 / pdt) * 100);   // µs -> ms -> %
      this._proc = pu;
      this._procAt = now;
    }

    // Once every five seconds, and never twice at once. It is a subprocess;
    // the rest of this file is a file read.
    if (this.hasVcgencmd && !this._vcBusy && now - this._vcAt > 5000) {
      this._vcBusy = true;
      this._vcAt = now;
      execFile('vcgencmd', ['get_throttled'], { timeout: 2000 }, (err, out) => {
        this._vcBusy = false;
        if (err) { this.hasVcgencmd = false; this.throttled = null; return; }
        const m = String(out).match(/throttled=0x([0-9a-f]+)/i);
        this.throttled = m ? decodeThrottled(parseInt(m[1], 16)) : null;
      });
    }
    return this;
  }

  /** Everything the dashboard shows about the Pi, in one object. */
  status() {
    const mem = memInfo();
    const rss = process.memoryUsage().rss;
    const disk = (() => {
      try {
        const s = fs.statfsSync('/');
        return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
      } catch { return null; }
    })();

    return {
      model: (read('/proc/device-tree/model') || os.hostname())
        .replace(/\0/g, '').trim(),
      host: os.hostname(),
      // The two headline numbers.
      cpu: this.busy,
      cores: this.cores,
      temp_c: round(readNum('/sys/class/thermal/thermal_zone0/temp', 1000)),
      mhz: round(readNum('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 1000), 0),
      load: os.loadavg().map((v) => round(v, 2)),
      ncpu: os.cpus().length,
      mem: {
        total: mem.total,
        used: mem.total - mem.avail,
        pct: round(((mem.total - mem.avail) / mem.total) * 100),
        swap_used: mem.swapUsed,
      },
      disk: disk && {
        total: disk.total, free: disk.free,
        pct: round(((disk.total - disk.free) / disk.total) * 100),
      },
      uptime_s: Math.round(os.uptime()),
      // This process, separately: the robot's own cost, as opposed to the Pi's.
      proc: {
        cpu: this.procBusy,
        rss,
        // How long the server has been up, which is not how long the Pi has.
        up_s: Math.round(process.uptime()),
        pid: process.pid,
        node: process.version,
      },
      throttled: this.throttled,
    };
  }
}
