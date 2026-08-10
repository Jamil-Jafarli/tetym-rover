/**
 * The webcam, on the Raspberry Pi.
 *
 * The camera used to be the browser's — `getUserMedia` on a phone propped on
 * the robot. That is gone. The Pi is now on the robot, between the powerbank
 * and the ESP32, and the webcam is plugged into the Pi:
 *
 *     powerbank → Raspberry Pi → ESP32 → ESC → motor
 *                      └── USB webcam
 *
 * Which removes the whole class of problem the README used to have a section
 * about: no HTTPS to arrange, no camera permission to grant, no phone to keep
 * charged, and the robot still sees when nobody has a browser open at all.
 * A page no longer *is* the camera; it *watches* one.
 *
 * One ffmpeg, one device open, two outputs:
 *
 *   stdout  the camera's own MJPEG, copied through without re-encoding, which
 *           is what /camera/stream.mjpg serves and what every page draws.
 *           `-c:v copy` means the Pi spends no CPU on it at all.
 *   fd 3    a small grey rawvideo at a few frames a second — the QR reader's
 *           input, and nothing else's. Decoding QR from the same JPEGs would
 *           mean decoding JPEGs in Node; asking ffmpeg for exactly the pixels
 *           we want costs less than that and stays out of the video path.
 *
 * A second consumer never opens the device twice: v4l2 would refuse, and the
 * failure would land on whoever asked second rather than on whoever was wrong.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

// The webcam's own MJPEG is copied through, so this is the size and rate the
// sensor is asked for, not a transcode target. 640x480 at 15 is a road-facing
// robot camera: enough to find a road, small enough that a phone on the far
// side of the wifi keeps up.
export const CAMERA_DEFAULTS = {
  device: '/dev/video0',
  width: 640,
  height: 480,
  fps: 15,
  qrWidth: 320,      // the QR tap: quarter-area grey, which is plenty for a
  qrHeight: 240,     // code held up in front of the robot
  qrFps: 3,
};

// ffmpeg died: wait before trying again. A camera that was unplugged should not
// turn into a spawn loop that pins a core while nobody is looking.
const RESTART_MS = 2000;

// A JPEG we have not finished receiving is held in memory. A frame from this
// camera is ~80 kB; anything past this is not a frame, it is a stream that has
// lost sync, and the right answer is to drop it rather than grow forever.
const MAX_PARTIAL = 4 << 20;

const SOI = Buffer.from([0xff, 0xd8]);   // start of image
const EOI = Buffer.from([0xff, 0xd9]);   // end of image

/**
 * The picture shown when there is no picture.
 *
 * A camera that is unplugged, still starting, or switched off with --no-camera
 * used to make this endpoint answer 503. That is defensible HTTP and poor
 * behaviour: every page that has an <img> pointed here then shows a broken-image
 * icon and logs a console error, on a robot whose camera is simply not plugged
 * in yet. So the endpoint always answers with a frame, and when there is no
 * camera the frame says so — 320x240, the same dark grey as the pages, with
 * "kamera yoxdur" across the middle.
 *
 * The pages print the actual reason next to it, from `cam.err` in the status.
 * This is the "no signal" screen, not the explanation.
 */
export const PLACEHOLDER_JPEG = Buffer.from(
    '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'
  + 'AAAAA//Z',
  'base64');

export class Camera {
  constructor(opts = {}) {
    this.cfg = { ...CAMERA_DEFAULTS, ...opts };
    this.enabled = opts.enabled !== false;

    this.proc = null;
    this.frame = null;          // the most recent complete JPEG
    this.frameAt = 0;
    this.frames = 0;            // since start, for "is it actually running"
    this.err = this.enabled ? 'başlamadı' : 'kapalı';
    this.startedAt = 0;

    this._buf = Buffer.alloc(0);
    this._gray = Buffer.alloc(0);
    this._subs = new Set();     // MJPEG viewers
    this._grayCb = null;
    this._retry = null;
    this._closed = false;

    // Frames in the last second, measured rather than assumed: the number that
    // says whether the camera is delivering is the one nobody configured.
    this._marks = [];
    this._fps = 0;
  }

  /** Frames actually delivered in the last second. */
  get fps() {
    const now = Date.now();
    while (this._marks.length && now - this._marks[0] > 1000) this._marks.shift();
    return this._marks.length;
  }

  /** True when a frame arrived recently enough to draw. */
  get live() { return this.frame !== null && Date.now() - this.frameAt < 2000; }

  start() {
    if (!this.enabled || this.proc || this._closed) return;

    // Say "there is no camera at /dev/video0" rather than letting ffmpeg say it
    // in its own words two seconds later, on a page that is already black.
    if (!fs.existsSync(this.cfg.device)) {
      this.err = `kamera yok: ${this.cfg.device}`;
      this._later();
      return;
    }

    const { device, width, height, fps, qrWidth, qrHeight, qrFps } = this.cfg;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'v4l2', '-input_format', 'mjpeg',
      '-video_size', `${width}x${height}`, '-framerate', String(fps),
      '-i', device,
      // the stream everybody watches — the camera's own JPEGs, untouched
      '-map', '0:v', '-c:v', 'copy', '-f', 'mjpeg', 'pipe:1',
      // the QR tap — small, grey, slow, and on its own pipe
      '-map', '0:v', '-vf', `scale=${qrWidth}:${qrHeight},format=gray`,
      '-r', String(qrFps), '-f', 'rawvideo', 'pipe:3',
    ];

    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.err = `ffmpeg başlatılamadı: ${e.message}`;
      this._later();
      return;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    this._buf = Buffer.alloc(0);
    this._gray = Buffer.alloc(0);

    proc.stdout.on('data', (d) => this._onJpegData(d));
    proc.stdio[3].on('data', (d) => this._onGrayData(d));

    // ffmpeg writes its complaints to stderr and then usually keeps going, so
    // the last line is the useful one: "device busy", "no such format", the
    // reason a black page is black.
    proc.stderr.on('data', (d) => {
      const line = String(d).trim().split('\n').pop();
      if (line) this.err = line.slice(0, 160);
    });

    proc.on('error', (e) => {
      this.err = /ENOENT/.test(String(e))
        ? 'ffmpeg kurulu değil (sudo apt install ffmpeg)'
        : String(e.message || e);
      this.proc = null;
      this._later();
    });
    proc.on('exit', (code, sig) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.frame = null;
      if (!this._closed) {
        this.err = this.err && this.frames === 0
          ? this.err
          : `ffmpeg durdu (${sig || code}) — yeniden bağlanıyor`;
        this._later();
      }
    });
  }

  _later() {
    if (this._closed || this._retry) return;
    this._retry = setTimeout(() => { this._retry = null; this.start(); }, RESTART_MS);
  }

  /**
   * Cut the byte stream back into whole JPEGs.
   *
   * ffmpeg hands us a stream, not frames, and a viewer needs frames: a
   * multipart part with half a JPEG in it is a broken image in every browser.
   * So we find the SOI/EOI markers ourselves and only ever publish a complete
   * one — which is also what makes "the latest frame" a thing that can be
   * served to a page that asked for a still.
   */
  _onJpegData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const a = this._buf.indexOf(SOI);
      if (a < 0) break;
      const b = this._buf.indexOf(EOI, a + 2);
      if (b < 0) {
        if (a > 0) this._buf = this._buf.subarray(a);
        break;
      }
      this._publish(this._buf.subarray(a, b + 2));
      this._buf = this._buf.subarray(b + 2);
    }
    // Lost sync — better to drop what we have than to hold it forever.
    if (this._buf.length > MAX_PARTIAL) this._buf = Buffer.alloc(0);
  }

  _publish(jpeg) {
    this.frame = Buffer.from(jpeg);
    this.frameAt = Date.now();
    this.frames++;
    this._marks.push(this.frameAt);
    if (this.frames > 2) this.err = null;       // it is delivering; whatever
                                                // ffmpeg grumbled about is old
    for (const sub of this._subs) sub(this.frame);
  }

  /**
   * The grey tap, reassembled into whole frames.
   *
   * Fixed size, so this is arithmetic rather than parsing: every
   * qrWidth × qrHeight bytes is one frame, and a partial one waits.
   */
  _onGrayData(chunk) {
    if (!this._grayCb) return;                  // nobody reading QR: drop it
    const need = this.cfg.qrWidth * this.cfg.qrHeight;
    this._gray = this._gray.length ? Buffer.concat([this._gray, chunk]) : chunk;
    while (this._gray.length >= need) {
      const f = this._gray.subarray(0, need);
      this._gray = this._gray.subarray(need);
      try {
        this._grayCb(f, this.cfg.qrWidth, this.cfg.qrHeight);
      } catch { /* a decoder that throws must not take the camera with it */ }
    }
  }

  /** Ask for the grey frames. One consumer — the QR reader. */
  onGray(cb) { this._grayCb = cb; }

  /**
   * Watch the stream.
   *
   * The callback is handed every complete frame until it unsubscribes. Slow
   * viewers are the caller's problem to solve by not writing — see the
   * `/camera/stream.mjpg` handler, which drops frames for a socket that has
   * not drained rather than queueing them. A live view that is thirty seconds
   * behind is worse than one that skipped thirty frames.
   */
  subscribe(fn) {
    this._subs.add(fn);
    if (this.frame) fn(this.frame);             // first paint immediately
    return () => this._subs.delete(fn);
  }

  status() {
    return {
      on: this.enabled && this.proc !== null,
      live: this.live,
      device: this.cfg.device,
      w: this.cfg.width,
      h: this.cfg.height,
      want_fps: this.cfg.fps,
      fps: this.fps,
      frames: this.frames,
      viewers: this._subs.size,
      err: this.err,
      up_s: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
    };
  }

  async close() {
    this._closed = true;
    if (this._retry) clearTimeout(this._retry);
    this._subs.clear();
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      p.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } r(); }, 700);
        p.on('exit', () => { clearTimeout(t); r(); });
      });
    }
  }
}
