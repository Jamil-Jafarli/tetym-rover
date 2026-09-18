/**
 * The webcam, on the Raspberry Pi.
 *
 * The camera used to be the browser's — `getUserMedia` on a phone propped on
 * the robot. That is gone. The Pi is now on the robot, between the power
 * supply and the Creality mainboard, and the webcam is plugged into the Pi:
 *
 *     power supply → Raspberry Pi → Creality mainboard → steppers
 *                          └── USB webcam
 *
 * Which removes the whole class of problem the README used to have a section
 * about: no HTTPS to arrange, no camera permission to grant, no phone to keep
 * charged, and the robot still sees when nobody has a browser open at all.
 * A page no longer *is* the camera; it *watches* one.
 *
 * One ffmpeg, one device open, one output: the camera's own MJPEG on stdout,
 * copied through without re-encoding (`-c:v copy`, so the Pi spends almost no
 * CPU on it), which is what /camera/stream.mjpg serves and every page draws.
 *
 * The QR reader's pixels come from the same JPEGs. It used to be a second
 * ffmpeg output — 320x240 grey — but a 50 mm code seen by a camera leaning
 * forward is ~30x22 px even at 640x480, and it never read (0 in 1571 frames,
 * 2026-09-15). At 1920x1080 it reads. A second ffmpeg output at 1080p would
 * decode *every* frame (27 ms each, ~0.8 of a core at 30 fps) to use five of
 * them, so instead, a few times a second, one of the JPEGs already here is
 * handed to jpeg_gray.py, which sends back full-resolution grey. Five
 * decodes a second, not thirty.
 *
 * A second consumer never opens the device twice: v4l2 would refuse, and the
 * failure would land on whoever asked second rather than on whoever was wrong.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The webcam's own MJPEG is copied through, so this is the size and rate the
// sensor is asked for, not a transcode target. 1920x1080 because the QR code
// needs the pixels; the pages cut the old 640x480 framing back out of it
// (camCrop in public/cam.js), and a 1080p frame from this webcam is 60–85 kB,
// no bigger than its 640x480 ones were — the wifi does not notice.
export const CAMERA_DEFAULTS = {
  device: '/dev/video0',
  width: 1920,
  height: 1080,
  fps: 15,
  // Five looks a second, not three: the code is read while the rover moves
  // (mission.js's cargo run), and a code going by at a crawl is in shot for
  // a second or two. Each look is a JPEG decode (~30 ms, jpeg_gray.py) plus a
  // locate-and-read on the QR worker thread; a look still running when the
  // next is due means that one is skipped, not queued.
  qrFps: 5,
  // The line detector's frames: colour, small, and decoded only while
  // something is actually reading them (road_eye.js). 480x360 is road.js's
  // working resolution — the size both pages draw their canvas at — so the
  // server sees exactly the picture /vision was tuned against. Eight a second
  // is a steering loop; the pilot corrects on the band in front of the wheels,
  // and a chunk of driving is 150 ms (rover.js).
  roadFps: 8,
  roadWidth: 480,
  roadHeight: 360,
};

const DECODER = fileURLToPath(new URL('./jpeg_gray.py', import.meta.url));

/**
 * One decoder channel: a jpeg_gray.py of its own, the framing of what comes
 * back, and the single reader it belongs to.
 *
 * Two of them, because the two readers want different pixels — the QR reader
 * every one the sensor has, in grey; the line detector a small colour frame —
 * and neither wants the other's. A channel nobody reads never spawns anything,
 * so a server started with --no-qr and no line following costs no python at
 * all.
 *
 * `px` is bytes per pixel: what the header's width × height has to be
 * multiplied by to know when a frame is whole.
 */
function decodeChannel(name, args, px) {
  return { name, args, px, cb: null, proc: null, spawn: null,
           busy: false,             // one JPEG in flight at a time
           at: 0,                   // when one was last handed over
           retryAt: 0, err: null,
           hdr: Buffer.alloc(8), hdrN: 0, frame: null, w: 0, h: 0, n: 0 };
}

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
    this._subs = new Set();     // MJPEG viewers
    this._retry = null;
    this._closed = false;

    // The two decoders. `spawn` is a method rather than the channel's own
    // function so a test can put a stand-in in its place.
    const { roadWidth, roadHeight } = this.cfg;
    this._gray = decodeChannel('gray', [], 1);
    this._gray.spawn = (now) => this._decoder(now);
    this._rgb = decodeChannel('rgb', ['--rgb', `${roadWidth}x${roadHeight}`], 3);
    this._rgb.spawn = (now) => this._rgbDecoder(now);

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

    const { device, width, height, fps } = this.cfg;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'v4l2', '-input_format', 'mjpeg',
      '-video_size', `${width}x${height}`, '-framerate', String(fps),
      '-i', device,
      // the stream everybody watches — the camera's own JPEGs, untouched
      '-map', '0:v', '-c:v', 'copy', '-f', 'mjpeg', 'pipe:1',
    ];

    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.err = `ffmpeg başlatılamadı: ${e.message}`;
      this._later();
      return;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    this._buf = Buffer.alloc(0);

    proc.stdout.on('data', (d) => this._onJpegData(d));

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
    this._maybeQr(this.frame);
    this._maybeRgb(this.frame);
  }

  /**
   * Every 1/qrFps seconds, one of the frames goes to the grey decoder — if
   * somebody is reading QR, and the last one has come back. A frame due while
   * one is still in flight is simply not sent: the next will be.
   */
  _maybeQr(jpeg, now = Date.now()) {
    this._offer(this._gray, this.cfg.qrFps, jpeg, now);
  }

  /** The same, at roadFps, for the colour frames the line detector reads. */
  _maybeRgb(jpeg, now = Date.now()) {
    this._offer(this._rgb, this.cfg.roadFps, jpeg, now);
  }

  _offer(ch, fps, jpeg, now) {
    if (!ch.cb || !(fps > 0) || ch.busy) return;
    if (now - ch.at < 1000 / fps) return;
    const dec = ch.spawn(now);
    if (!dec) return;
    ch.at = now;
    ch.busy = true;
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(jpeg.length);
    dec.stdin.write(hdr);
    dec.stdin.write(jpeg);
  }

  /** jpeg_gray.py, started on first use and again if it dies. */
  _decoder(now = Date.now()) { return this._start(this._gray, now); }

  /** The same program, asked for small colour frames. */
  _rgbDecoder(now = Date.now()) { return this._start(this._rgb, now); }

  _start(ch, now = Date.now()) {
    if (ch.proc) return ch.proc;
    if (this._closed || now < ch.retryAt) return null;
    let dec;
    try {
      dec = spawn('python3', [DECODER, ...ch.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      ch.err = `jpeg_gray.py başlamadı: ${e.message}`;
      ch.retryAt = now + RESTART_MS;
      return null;
    }
    ch.proc = dec;
    ch.hdrN = 0;
    ch.n = 0;
    dec.stdout.on('data', (d) => this._onDecoded(ch, d));
    dec.stderr.on('data', (d) => {
      const line = String(d).trim().split('\n').pop();
      if (line) ch.err = line.slice(0, 160);
    });
    dec.stdin.on('error', () => { /* it died mid-write; 'exit' says so */ });
    const gone = (why) => {
      if (ch.proc !== dec) return;
      ch.proc = null;
      ch.busy = false;
      ch.retryAt = Date.now() + RESTART_MS;
      if (!this._closed) ch.err = ch.err || `jpeg_gray.py durdu (${why})`;
    };
    dec.on('error', (e) => gone(/ENOENT/.test(String(e)) ? 'python3 yoxdur' : e.message));
    dec.on('exit', (code, sig) => gone(sig || code));
    return dec;
  }

  /**
   * A decoder's answers, reassembled into whole frames.
   *
   * Each is an 8-byte header (width, height) and then width × height × px
   * bytes. A 1080p grey frame is 2 MB and arrives in 64 kB pieces, so it is
   * copied into one buffer as it comes rather than concatenated piece by piece
   * (that would be ~30 copies of a growing buffer per frame). The buffer is
   * reused for the next frame of the same size — the reader copies what it
   * keeps. 0x0 means "that JPEG did not decode": nothing is delivered, the
   * decoder is free again.
   */
  _onDecoded(ch, chunk) {
    let off = 0;
    while (off < chunk.length) {
      if (ch.hdrN < 8) {
        const n = Math.min(8 - ch.hdrN, chunk.length - off);
        chunk.copy(ch.hdr, ch.hdrN, off, off + n);
        ch.hdrN += n;
        off += n;
        if (ch.hdrN < 8) break;
        ch.w = ch.hdr.readUInt32BE(0);
        ch.h = ch.hdr.readUInt32BE(4);
        ch.n = 0;
        const need = ch.w * ch.h * ch.px;
        if (need === 0) { ch.hdrN = 0; ch.busy = false; continue; }
        if (!ch.frame || ch.frame.length !== need) ch.frame = Buffer.alloc(need);
        continue;
      }
      const need = ch.w * ch.h * ch.px;
      const n = Math.min(need - ch.n, chunk.length - off);
      chunk.copy(ch.frame, ch.n, off, off + n);
      ch.n += n;
      off += n;
      if (ch.n === need) {
        ch.hdrN = 0;
        ch.busy = false;
        if (ch.cb) {
          try {
            ch.cb(ch.frame, ch.w, ch.h);
          } catch { /* a reader that throws must not take the camera with it */ }
        }
      }
    }
  }

  /** The grey channel's framing, under the name the tests know it by. */
  _onGrayData(chunk) { this._onDecoded(this._gray, chunk); }

  /** Ask for the grey frames. One consumer — the QR reader. */
  onGray(cb) { this._gray.cb = cb; }

  /** Ask for the small colour frames. One consumer — the line detector. */
  onRgb(cb) { this._rgb.cb = cb; }

  // What the tests and the status call the grey channel's two fields.
  get _qrBusy() { return this._gray.busy; }
  set _qrBusy(v) { this._gray.busy = !!v; }
  get qrErr() { return this._gray.err; }
  set qrErr(v) { this._gray.err = v; }
  get roadErr() { return this._rgb.err; }

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
      qr_err: this.qrErr,
      road_err: this.roadErr,
      road: { fps: this.cfg.roadFps, w: this.cfg.roadWidth, h: this.cfg.roadHeight,
              on: this._rgb.cb !== null },
      up_s: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
    };
  }

  async close() {
    this._closed = true;
    if (this._retry) clearTimeout(this._retry);
    this._subs.clear();
    for (const ch of [this._gray, this._rgb]) {
      if (!ch.proc) continue;
      try { ch.proc.kill('SIGTERM'); } catch { /* gone */ }
      ch.proc = null;
    }
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
