/**
 * Reading QR codes off the webcam, on the Pi.
 *
 * Server-side on purpose. The obvious place to decode a QR is the page that is
 * already drawing the video — but then the robot only reads a code while
 * somebody happens to be looking at it, and "the last code we drove past" is a
 * fact about the robot's trip, not about a browser tab. It has to survive a
 * reload, a second viewer, and nobody watching at all.
 *
 * The input is camera.js's grey tap: 320x240, a few frames a second, already
 * the shape a decoder wants. jsQR needs RGBA, so the one conversion left is
 * grey → RGBA, into a buffer that is allocated once rather than per frame.
 *
 * The awkward part of QR is not decoding, it is counting. A code held in front
 * of the robot is in view for several seconds, which is thirty decodes of the
 * same string — and reporting "read 30 codes" when a person showed you one is
 * simply wrong. So a reading is only *new* when the text changes, or when the
 * same text comes back after the code has been out of sight for a while.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The decoder is optional. Without it every other part of the robot still
// works, the dashboard says why the QR panel is empty, and nothing throws at
// startup because one npm package is missing.
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
  // How many distinct readings to remember. They are what the map's markers
  // are drawn from, so this is a length of history, not a cache size.
  history: 40,
};

export class QrReader {
  constructor(cfg = {}) {
    this.cfg = { ...QR_DEFAULTS, ...cfg };
    this.available = jsQR !== null;
    this.error = qrLoadError && `jsqr yüklenmedi: ${qrLoadError}`;

    this.text = null;        // the last code read, held until another is read
    this.at = 0;             // when it was read (epoch ms)
    this.count = 0;          // distinct readings since boot
    this.seenAt = 0;         // when this text was last *seen*, new or not
    this.frames = 0;         // frames looked at
    this.decodes = 0;        // frames a code was found in
    this.ms = 0;             // how long the last decode took
    this.history = [];       // [{text, at, pos}] — newest last

    this._rgba = null;
    this._onRead = null;
  }

  /** Called with (text, at) each time a *new* code is read. */
  onRead(fn) { this._onRead = fn; }

  /**
   * One grey frame in; the code it contains, or null.
   *
   * @param {Buffer} gray  w*h bytes, one per pixel
   * @returns {{text: string, fresh: boolean}|null}
   */
  feed(gray, w, h, now = Date.now()) {
    if (!jsQR || !gray || gray.length < w * h) return null;
    this.frames++;

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
      found = jsQR(px, w, h, { inversionAttempts: 'dontInvert' });
    } catch { found = null; }
    this.ms = Date.now() - t0;

    if (!found || !found.data) return null;
    this.decodes++;

    const text = String(found.data);
    // New reading, or the same sign still in front of us?
    const fresh = text !== this.text || (now - this.seenAt) > this.cfg.regapMs;

    this.text = text;
    this.seenAt = now;
    if (fresh) {
      this.at = now;
      this.count++;
      this.history.push({ text, at: now, pos: null });
      while (this.history.length > this.cfg.history) this.history.shift();
      if (this._onRead) this._onRead(text, now, this.history[this.history.length - 1]);
    }
    return { text, fresh };
  }

  status() {
    return {
      available: this.available,
      text: this.text,
      at: this.at || null,
      // Seconds since it was read, so a page can say "12 s ago" without
      // needing the server's clock to agree with its own.
      age_s: this.at ? Math.round((Date.now() - this.at) / 100) / 10 : null,
      count: this.count,
      frames: this.frames,
      decodes: this.decodes,
      ms: this.ms,
      err: this.error || null,
      history: this.history.slice(-12),
    };
  }
}
