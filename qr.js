/**
 * Reading QR codes off the webcam, on the Pi.
 *
 * Server-side on purpose. The obvious place to decode a QR is the page that is
 * already drawing the video — but then the robot only reads a code while
 * somebody happens to be looking at it, and "the code in front of the rover
 * right now" is a fact about the robot, not about a browser tab. /vision shows
 * it and /follow's cargo run acts on it, and both are reading the same answer.
 * It has to survive a reload, a second viewer, and nobody watching at all.
 *
 * The input used to be camera.js's 320x240 grey tap, and it never read the
 * field's code: a 50 mm code seen from a camera leaning forward is ~30x22 px
 * even at 640x480, squashed top-to-bottom (0 reads in 1571 frames on
 * 2026-09-15). Now the camera runs at 1920x1080 and a few frames a second are
 * decoded to full-resolution grey. One look (qrwarp.js lookQr) finds the
 * code-like patch, cuts it tight, magnifies it ×2 and straightens it before
 * jsQR sees it. That is 40–200 ms, so it runs on a worker thread (QrLooker,
 * qr_worker.js) and a frame that arrives while a look is under way is skipped
 * rather than queued.
 *
 * The awkward part of QR is not decoding, it is counting. A code held in front
 * of the robot is in view for several seconds, which is thirty decodes of the
 * same string — and reporting "read 30 codes" when a person showed you one is
 * simply wrong. So a reading is only *new* when the text changes, or when the
 * same text comes back after the code has been out of sight for a while.
 *
 * Two ages come out of it, and they answer different questions:
 *
 *   age_s       since the code was READ — "when did we first see ALIM2"
 *   seen_age_s  since it was last SEEN, new or not — "is it in front of us now"
 *
 * The cargo run needs the second. A code that came into view while the rover
 * was still sweeping for the line is not read again when the sweep ends — it
 * is the same sign, still in shot — so asking "has a new code been read since
 * this step began" would wait for ever in front of the very code it wants.
 */

import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);

// The decoder is optional. Without it every other part of the robot still
// works, /vision says why the QR panel is empty, and nothing throws at startup
// because one npm package is missing.
let jsQR = null;
let qrLoadError = null;
try {
  const mod = require('jsqr');
  jsQR = mod && (mod.default || mod);
} catch (e) {
  qrLoadError = e.message || String(e);
}

export const QR_DEFAULTS = {
  // The same code again, after this long out of sight, is a second reading —
  // you drove past the sign twice. Sooner than this and it is still the one
  // sign, seen in consecutive frames.
  regapMs: 4000,
  // How many distinct readings to remember, for the list on /vision.
  history: 40,
};

/**
 * The text a code is compared by.
 *
 * The şartname prints ALIM1..3, KAPI1..2, BIRAK1..3 — but a code printed as
 * "Alım 2" or "ALIM-2" is the same sign to a person, and the rover refusing a
 * load because of a dotted capital I is not a safety feature. So case, spaces,
 * dashes, underscores and the Turkish I-with-or-without-a-dot are all folded
 * away before two texts are compared. Nothing else is: ALIM2 is still not
 * ALIM3, which is the one mistake this check exists to catch.
 */
export function qrKey(text) {
  return String(text ?? '')
    .replace(/[İIıi]/g, 'I')
    .toUpperCase()
    .replace(/[\s_\-.]+/g, '');
}

const CORNERS = ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner'];
const frac = (v, n) => Math.round((v / n) * 1000) / 1000;

export class QrReader {
  /**
   * @param {object} [cfg]  QR_DEFAULTS overrides, plus `decode` — a stand-in
   *                        for jsQR, so the counting can be tested without a
   *                        picture of a QR code.
   */
  constructor(cfg = {}) {
    this.cfg = { ...QR_DEFAULTS, ...cfg };
    this._decode = cfg.decode || jsQR;
    this.available = this._decode !== null;
    this.error = !this.available && qrLoadError ? `jsqr yüklənmədi: ${qrLoadError}` : null;

    this.text = null;        // the last code read, held until another is read
    this.at = 0;             // when it was read (epoch ms)
    this.count = 0;          // distinct readings since boot
    this.seenAt = 0;         // when this text was last *seen*, new or not
    this.loc = null;         // its corners, 0..1 of the frame, when last seen
    this.warp = null;        // which straightening read it (qrwarp.js), if any
    this.cand = null;        // the best code-like patch of the last look
    this.frames = 0;         // frames looked at
    this.decodes = 0;        // frames a code was found in
    this.ms = 0;             // how long the last look took
    this.history = [];       // [{text, at}] — newest last

    this._rgba = null;
    this._onRead = null;
  }

  /** Called with (text, at) each time a *new* code is read. */
  onRead(fn) { this._onRead = fn; }

  /**
   * One grey frame in, decoded here and now, whole — no locating, no warp.
   * Kept for small frames and for the tests; the server's 1080p frames go
   * through QrLooker instead.
   *
   * @param {Buffer} gray  w*h bytes, one per pixel
   * @returns {{text: string, fresh: boolean}|null}
   */
  feed(gray, w, h, now = Date.now()) {
    if (!this._decode || !gray || gray.length < w * h) return null;

    const need = w * h * 4;
    if (!this._rgba || this._rgba.length !== need) {
      this._rgba = new Uint8ClampedArray(need);
    }
    const px = this._rgba;
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const v = gray[i];
      px[j] = v; px[j + 1] = v; px[j + 2] = v; px[j + 3] = 255;
    }

    const t0 = Date.now();
    let found = null;
    try {
      // dontInvert: printed codes are dark on light, and asking for both costs
      // twice the work on a Pi for a case this robot does not have.
      found = this._decode(px, w, h, { inversionAttempts: 'dontInvert' });
    } catch { found = null; }
    this.ms = Date.now() - t0;
    const L = found && found.location;
    return this.found(found && found.data
      ? { text: found.data, corners: L ? CORNERS.map((k) => [L[k].x, L[k].y]) : null }
      : null, w, h, now);
  }

  /**
   * The result of one look, from wherever it was taken — feed() above, or the
   * worker. Everything about counting lives here, so both paths count alike.
   *
   * @param {{text, corners?, warp?, box?}|null} r  corners/box in frame px
   */
  found(r, w, h, now = Date.now()) {
    this.frames++;
    if (r && r.box) {
      const b = r.box;
      this.cand = { box: [frac(b.x, w), frac(b.y, h), frac(b.w, w), frac(b.h, h)], v: b.v, at: now };
    }
    if (!r || !r.text) return null;
    this.decodes++;

    const text = String(r.text);
    // New reading, or the same sign still in front of us?
    const fresh = text !== this.text || (now - this.seenAt) > this.cfg.regapMs;

    this.text = text;
    this.seenAt = now;
    this.warp = r.warp || null;
    // Where it is in the picture, as fractions of the frame rather than
    // pixels: /vision draws on a canvas of a different size, and the camera's
    // resolution is a server setting the page should not have to know.
    this.loc = r.corners && r.corners.every(Boolean)
      ? r.corners.map(([x, y]) => [frac(x, w), frac(y, h)])
      : null;
    if (fresh) {
      this.at = now;
      this.count++;
      this.history.push({ text, at: now });
      while (this.history.length > this.cfg.history) this.history.shift();
      if (this._onRead) this._onRead(text, now);
    }
    return { text, fresh };
  }

  status(now = Date.now()) {
    return {
      available: this.available,
      text: this.text,
      // The folded form, so a page comparing against "the code this slot
      // should have" does not need its own copy of qrKey() — a second copy of
      // the folding rules is how ALIM2 ends up matching on one page and not
      // on another.
      key: this.text === null ? null : qrKey(this.text),
      at: this.at || null,
      // Seconds, so a page can say "12 s ago" without needing the server's
      // clock to agree with its own.
      age_s: this.at ? Math.round((now - this.at) / 100) / 10 : null,
      seen_age_s: this.seenAt ? Math.round((now - this.seenAt) / 100) / 10 : null,
      loc: this.loc,
      warp: this.warp,
      // "Something code-like is there" even when it did not read: the page
      // draws it dashed, which is the difference between "the code is not in
      // shot" and "the code is in shot and too small/blurred to read".
      cand: this.cand
        ? { box: this.cand.box, v: this.cand.v, age_s: Math.round((now - this.cand.at) / 100) / 10 }
        : null,
      count: this.count,
      frames: this.frames,
      decodes: this.decodes,
      ms: this.ms,
      err: this.error || null,
      history: this.history.slice(-12),
    };
  }
}

/**
 * The worker thread that takes the looks, and the rule for feeding it.
 *
 * One look at a time. A frame offered while the worker is busy is dropped:
 * a backlog of 2 MB frames is memory, and a code read from a frame two
 * seconds old tells the cargo run where the rover *was*. Every `forceEvery`-th
 * look also tries the best patch even below the locator's threshold, so a
 * threshold that is wrong for tonight's lighting slows reading down but does
 * not stop it.
 */
export class QrLooker {
  constructor(reader, opts = {}) {
    this.reader = reader;
    this.opts = { forceEvery: 4, ...opts };
    this.busy = false;
    this.looks = 0;
    this.dropped = 0;
    this.lastWarp = null;   // qrwarp.js warp id that read last, e.g. 'tilt30'
    this._closed = false;
    this._start();
  }

  _start() {
    if (this._closed) return;
    const { forceEvery, ...workerData } = this.opts;
    const wk = new Worker(new URL('./qr_worker.js', import.meta.url), { workerData });
    wk.unref();                       // never the reason the server cannot exit
    wk.on('message', (m) => {
      this.busy = false;
      this.reader.ms = m.ms;
      // Try this straightening first next time: the code has not changed
      // slant in a fifth of a second (one decode a look instead of two).
      if (m.warpId) this.lastWarp = m.warpId;
      if (m.err) this.reader.error = `QR: ${m.err}`;
      this.reader.found(m, m.w, m.h);
    });
    // A worker that dies (out of memory, a bug in a look) is restarted; the
    // reader says why in the meantime rather than going quietly blank.
    wk.on('error', (e) => { this.reader.error = `QR işçisi: ${e.message || e}`; });
    wk.on('exit', () => {
      this.busy = false;
      if (this.worker === wk && !this._closed) setTimeout(() => this._start(), 1000);
    });
    this.worker = wk;
  }

  /** A grey frame from the camera. Returns false when it was dropped. */
  offer(gray, w, h) {
    if (!this.reader.available || this.busy || !this.worker) { this.dropped++; return false; }
    this.busy = true;
    this.looks++;
    // The camera's buffer is reused for the next frame, so the worker gets a
    // copy it owns (transferred, not copied again).
    const buf = new Uint8Array(w * h);
    buf.set(gray.subarray(0, w * h));
    this.worker.postMessage({
      gray: buf.buffer, w, h, force: this.looks % this.opts.forceEvery === 0, first: this.lastWarp,
    }, [buf.buffer]);
    return true;
  }

  async close() {
    this._closed = true;
    if (this.worker) await this.worker.terminate();
  }
}
