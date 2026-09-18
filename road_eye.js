/**
 * The line, seen by the server.
 *
 * /vision and /follow have always done this in the browser: draw the camera
 * into a 480×360 canvas, hand the pixels to road.js, steer on what comes back.
 * That is the right place for a person tuning the detector and the wrong place
 * for a competition run — the robot would only see the line while somebody
 * happened to have a tab open on it, and the lap the PLC hands out is driven
 * with nobody watching.
 *
 * So the same detector runs here, on the same size picture, off the same
 * camera: camera.js decodes a small colour frame a few times a second
 * (jpeg_gray.py --rgb), this feeds it to road.js's detect() and keeps the last
 * answer. Not a port of the detector — the actual file the pages load, through
 * shared.js, so a change on /vision is a change to what the robot follows.
 *
 * What it does NOT do is steer. It answers three questions and stops:
 *
 *   near   how wrong the robot is right now, -1 (line hard left) … +1
 *   far    where the line is going, the same units
 *   bands  how much of the line was found at all — 0 is "no line here"
 *
 * approach_run.js is what turns those into wheels, through the same pilot.js
 * /follow flies.
 */

import { loadShared } from './shared.js';

const R = loadShared('road.js', ['detect', 'roadError', 'cfg', 'roadSetMode', 'roadLockAuto']);

/** Older than this and the answer is not about where the robot is now. */
const STALE_MS = 700;

/** The detector's own settings a page may have tuned and saved. */
const VISION_KEYS = ['mode', 'roi', 'bias', 'sat', 'minw', 'bands', 'side', 'jump',
                     'contrast', 'edge', 'arm', 'chroma', 'hueTol', 'fill'];

export class RoadEye {
  /**
   * @param {object} o
   * @param {import('./camera.js').Camera} [o.camera]  subscribed to, if given
   */
  constructor({ camera = null, on = true } = {}) {
    this.last = null;         // the last frame read: see see()
    this.frames = 0;
    this.err = null;
    this.ms = 0;              // how long the last detect() took
    this.wanted = false;
    this._camera = camera;
    this._rgba = null;        // RGBA scratch, reused between frames
    this._w = 0;
    this._h = 0;
    this.want(on);
  }

  /**
   * Ask the camera for colour frames, or stop asking.
   *
   * Off by default costs nothing: camera.js decodes a frame only when somebody
   * is listening, so a server whose pallet manoeuvre is turned off never
   * spawns the second decoder. Turning it on from /plc has to start the frames
   * without a restart, which is why this is a method and not a constructor
   * argument.
   */
  want(on) {
    const yes = !!on;
    if (!this._camera || yes === this.wanted) return this;
    this.wanted = yes;
    this._camera.onRgb(yes ? (buf, w, h) => this.see(buf, w, h) : null);
    return this;
  }

  /** follow.json's `vision` block — the sliders /vision saves. */
  setCfg(cfg = {}) {
    const v = (cfg && cfg.vision) || {};
    for (const k of VISION_KEYS) {
      if (v[k] === undefined || v[k] === null) continue;
      if (k === 'mode') { if (v.mode !== R.cfg.mode) R.roadSetMode(String(v.mode)); continue; }
      const n = Number(v[k]);
      if (Number.isFinite(n)) R.cfg[k] = n;
    }
  }

  /**
   * Freeze the automatic track type for the length of a run, exactly as
   * /follow does on ARM: half a manoeuvre in, the only things that can still
   * argue for the other reading are a shadow or somebody's shoe.
   */
  lock(on) { R.roadLockAuto(!!on); }

  /**
   * One colour frame, as jpeg_gray.py --rgb sends it: R G B per pixel.
   *
   * road.js reads RGBA because a browser canvas gives it RGBA, so the three
   * bytes are spread into four here. One allocation, reused: at 480×360 this
   * runs several times a second for the whole run.
   */
  see(rgb, w, h, now = Date.now()) {
    if (!rgb || !(w > 0) || !(h > 0)) return null;
    // road.js's buffers are allocated once at its own W×H and never resized,
    // so a frame of another size is not something it can read.
    if (w !== 480 || h !== 360) {
      this.err = `hat dedektörü 480x360 bekliyor, ${w}x${h} geldi`;
      return null;
    }
    if (!this._rgba || this._w !== w || this._h !== h) {
      this._rgba = new Uint8ClampedArray(w * h * 4);
      this._w = w; this._h = h;
    }
    const out = this._rgba;
    for (let p = 0, i = 0, j = 0; p < w * h; p++, i += 3, j += 4) {
      out[j] = rgb[i]; out[j + 1] = rgb[i + 1]; out[j + 2] = rgb[i + 2]; out[j + 3] = 255;
    }
    const t0 = Date.now();
    let res;
    try {
      res = R.detect(out);
    } catch (e) {
      this.err = String(e.message || e);
      return null;
    }
    this.ms = Date.now() - t0;
    this.err = null;
    this.frames++;
    const e = R.roadError(res);
    this.last = { at: now, near: e.near, far: e.far, bands: e.bands,
                  corner: e.corner, end: e.end, junction: e.junction,
                  mode: res.mode, thr: res.thr, contrast: res.contrast };
    return this.last;
  }

  /**
   * How many bands the detector was asked for — the pilot's `want`, which is
   * what it measures a short, uncertain chain against.
   */
  get bandsWanted() { return Number(R.cfg.bands) || 8; }

  /** The last answer, or null if it is too old to act on. */
  fresh(now = Date.now()) {
    return this.last && now - this.last.at <= STALE_MS ? this.last : null;
  }

  /** Is the line in front of the robot right now? */
  seeing(now = Date.now()) {
    const f = this.fresh(now);
    return !!(f && f.near !== null && f.bands >= 2);
  }

  status(now = Date.now()) {
    const f = this.last;
    const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
    return {
      on: this.wanted,
      reading: this.frames > 0,
      frames: this.frames,
      ms: this.ms,
      err: this.err,
      age_s: f ? Math.round((now - f.at) / 100) / 10 : null,
      seeing: this.seeing(now),
      near: f ? r3(f.near) : null,
      far: f ? r3(f.far) : null,
      bands: f ? f.bands : 0,
      mode: f ? f.mode : R.cfg.mode,
      contrast: f ? f.contrast : null,
      junction: f ? f.junction : null,
      end: f ? f.end : null,
    };
  }
}
