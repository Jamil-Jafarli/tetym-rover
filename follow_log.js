// Run recorder for the follow page.
//
// The point of this file is the next session: you drive a lap, hand over the
// JSON, and the speeds get retuned against what actually happened rather than
// against a memory of it. So it records the *inputs* to every decision as well
// as the outputs — error, band count, track mode, threshold — which is enough
// to replay a run through pilot.js offline with different numbers and see what
// would have changed.
//
// Written server-side rather than downloaded from the browser because a run
// that ends badly is exactly the run worth having, and that is also the run
// where the tab gets closed in a hurry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOG_DIR = path.join(HERE, 'logs');

// Rows arrive at ~10 Hz and are held in memory, so the file is always valid
// JSON rather than a half-written array. Flushing every second bounds what a
// pulled power cable costs to one second of a lap.
const FLUSH_MS = 1000;

// A lap is a couple of minutes; this is about ten. Past it the run is not a
// run any more, and an unattended page should not fill a disk.
const MAX_ROWS = 12000;

/**
 * public/analyse.js is a plain browser script; evaluate it and take the one
 * function we need. Doing it this way rather than duplicating the logic means
 * "sağ viraj" means the same thing in the file as it does on the page.
 */
function loadSegments() {
  try {
    const src = fs.readFileSync(path.join(HERE, 'public', 'analyse.js'), 'utf8');
    return new Function(`${src}\nreturn segments;`)();
  } catch (err) {
    console.warn('could not load analyse.js — runs will have no segments:', err.message);
    return () => [];
  }
}

// The manoeuvre split lives in public/analyse.js, because /tune needs it in the
// browser and the summary needs it here. One definition of "that was a corner".
const segments = loadSegments();

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
  .replace('T', '-');

export class FollowLog {
  constructor(dir = LOG_DIR) {
    this.dir = dir;
    this.run = null;
  }

  get active() { return this.run !== null; }
  get file() { return this.run ? path.basename(this.run.file) : null; }
  get rows() { return this.run ? this.run.data.rows.length : 0; }

  /**
   * Begin a run. `meta` is whatever the page knows and the log cannot work
   * out for itself: the pilot config, the calibration, a note you typed.
   */
  start(meta = {}) {
    this.stop();                                   // never two at once
    const now = new Date();
    const file = path.join(this.dir, `follow-${stamp(now)}.json`);
    this.run = {
      file,
      t0: Date.now(),
      dirty: true,
      dropped: 0,
      data: {
        started: now.toISOString(),
        note: typeof meta.note === 'string' ? meta.note.slice(0, 400) : '',
        vmax: meta.vmax ?? null,
        level: meta.level ?? null,
        pilot: meta.pilot ?? null,       // the sliders this run was flown with
        vision: meta.vision ?? null,     // ROI, threshold bias, band count…
        calib: meta.calib ?? null,       // % ↔ m/s, measured by hand
        // Field notes for whoever reads this file cold — including me, later.
        units: {
          t: 'sürüş başladığından beri ms',
          err: 'direksiyon hatası, -1 (yol tam solda) … +1 (yol tam sağda)',
          far: 'aynısı, zincirin üst yarısının ortalaması',
          bands: 'istenen şeritlerden kaçı yol buldu',
          speed: 'komut edilen hız, %',
          p25: 'sol teker, %',
          p26: 'sağ teker, %',
          dist: 'metre, `calib` üzerinden `speed`ten integre — modellendi, ölçülmedi',
        },
        summary: null,
        rows: [],
      },
    };
    fs.mkdirSync(this.dir, { recursive: true });
    this._write();
    return file;
  }

  /** Append a batch of sample rows. Silently caps rather than growing forever. */
  add(rows) {
    if (!this.run || !Array.isArray(rows)) return;
    const data = this.run.data;
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      if (data.rows.length >= MAX_ROWS) { this.run.dropped++; continue; }
      data.rows.push(r);
    }
    this.run.dirty = true;
    const now = Date.now();
    if (!this._flushAt || now - this._flushAt >= FLUSH_MS) {
      this._flushAt = now;
      this._write();
    }
  }

  /** Close the run: compute the summary, write once more, return the path. */
  stop() {
    if (!this.run) return null;
    const { data } = this.run;
    data.ended = new Date().toISOString();
    data.summary = summarise(data.rows, this.run.dropped);
    // What the lap was actually made of — straights, left-handers,
    // right-handers, and where it lost the road. The thing you want to read
    // first, and the thing a percentage-per-frame table cannot tell you.
    data.segments = segments(data.rows);
    const file = this.run.file;
    this._write();
    this.run = null;
    this._flushAt = 0;
    return { file, summary: data.summary };
  }

  _write() {
    if (!this.run) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.run.file, JSON.stringify(this.run.data, null, 1));
      this.run.dirty = false;
    } catch (err) {
      console.warn('could not write the run log:', err.message);
    }
  }
}

/**
 * What the run looked like, in the handful of numbers worth reading first.
 *
 * `dist` is the integrated model distance, so it is only as honest as the
 * calibration behind it — which is why it is reported next to the raw time and
 * the average percentage rather than instead of them.
 */
export function summarise(rows, dropped = 0) {
  if (!rows.length) return { rows: 0, duration_s: 0 };
  const t = (r) => Number(r.t) || 0;
  const dur = (t(rows[rows.length - 1]) - t(rows[0])) / 1000;

  let sum = 0, peak = 0, lostRows = 0, lostRuns = 0, wasLost = false;
  let absErr = 0, worstErr = 0;
  for (const r of rows) {
    const s = Number(r.speed) || 0;
    sum += s;
    if (s > peak) peak = s;
    const e = Math.abs(Number(r.err) || 0);
    absErr += e;
    if (e > worstErr) worstErr = e;
    if (r.lost) {
      lostRows++;
      if (!wasLost) lostRuns++;
      wasLost = true;
    } else wasLost = false;
  }

  const last = rows[rows.length - 1];
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    rows: rows.length,
    dropped: dropped || 0,
    duration_s: r2(dur),
    distance_m: last.dist == null ? null : r2(Number(last.dist)),
    avg_speed_pct: r2(sum / rows.length),
    peak_speed_pct: r2(peak),
    avg_abs_err: r2(absErr / rows.length),
    worst_err: r2(worstErr),
    lost_frames: lostRows,
    lost_events: lostRuns,
    lost_time_s: r2(dur * (lostRows / rows.length)),
  };
}
