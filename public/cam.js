/**
 * Where a page gets its pictures from.
 *
 * The camera is on the Pi and the Pi serves it as MJPEG, so a page's video
 * source is an `<img>` with a URL in it. That is the whole idea, and it is
 * worth being explicit about what it buys, because the code it replaces was
 * three times longer:
 *
 *   - it works over plain http, from any device, with no certificate. The
 *     README used to have a section about self-signed certificates existing
 *     purely so `getUserMedia` would talk to a phone. That section is gone.
 *   - there is no permission prompt, so nothing to grant on a robot that is
 *     running headless.
 *   - every viewer sees the same frames, because there is one camera.
 *   - and /follow's detector now runs against the same picture the robot's own
 *     QR reader is reading, rather than against whatever the laptop's built-in
 *     webcam happened to be pointing at.
 *
 * The browser camera is kept as a second mode rather than deleted: a laptop
 * webcam is still the quickest way to wave a track in front of the detector at
 * a desk, and the file picker is how you replay a recording. Both are now
 * fallbacks to the robot's own eye instead of the other way round.
 *
 * `drawImage` takes an <img> and a <video> identically, so the pages that draw
 * a frame do not care which of the three is live — they ask for `.el`.
 */

// Cache-busted so a reconnect gets a new stream rather than a browser deciding
// it already has this URL. MJPEG over an <img> is one long-lived response; a
// cached one is a frozen picture.
function camStreamUrl() { return `/camera/stream.mjpg?t=${Date.now()}`; }

/**
 * The 4:3 view the detector was tuned on, out of whatever the camera sends.
 *
 * The Pi's webcam now runs at 1920x1080, because the 50 mm QR code is
 * unreadable at 640x480 (see qr.js). Everything that finds the line was tuned
 * on 640x480, and drawing a 16:9 frame into the 480x360 canvas would squash
 * it sideways and move the line. So the pages cut the old framing back out.
 * The webcam's 640x480 mode turned out to be its 1080p frame's centre
 * 1440x1080, 20 px left of centre (best fit on 2026-09-15: zoom 1.00, shift
 * −9 px at 640 wide) — the same picture, just with more pixels.
 *
 * A 4:3 (or taller) source is drawn whole; the shift is for the Pi's own
 * webcam only — a laptop camera is not that lens.
 */
const CAM_RPI_SHIFT = -20 / 1920;
function camCrop(w, h, rpi) {
  if (!(w > 0 && h > 0) || w / h < 4 / 3 + 0.01) return [0, 0, w || 1, h || 1];
  const sw = Math.round((h * 4) / 3);
  const sx = Math.max(0, Math.min(w - sw, Math.round((w - sw) / 2 + (rpi ? CAM_RPI_SHIFT * w : 0))));
  return [sx, 0, sw, h];
}

// The stream ends when the server restarts or ffmpeg is restarting after the
// webcam was unplugged. Neither is fatal and both fix themselves, so reconnect
// rather than leaving a page showing the last frame it happened to receive.
const CAM_RETRY_MS = 1500;

/**
 * Start the stream *after* the page has finished loading.
 *
 * An MJPEG response never ends — that is what makes it a stream — so an image
 * loading one is an image that never finishes. Point an <img> at it during
 * parsing and the document's `load` event never fires: the tab spins forever,
 * anything waiting on `load` waits forever, and a page-load test simply times
 * out. Deferring by one event costs nothing and the picture arrives just the
 * same.
 */
function camAfterLoad(fn) {
  if (document.readyState === 'complete') fn();
  else addEventListener('load', fn, { once: true });
}

/**
 * @param {object} opts
 * @param {(state) => void} opts.onState  called whenever the source changes
 * @returns an object with `.el` (drawable or null), `.mode`, and the switches
 */
function camMount(opts = {}) {
  const onState = opts.onState || (() => {});

  const img = new Image();
  img.decoding = 'async';
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;

  const self = {
    mode: 'rpi',           // 'rpi' | 'browser' | 'file' | 'off'
    el: null,
    err: null,
    label: '—',
    stream: null,
    _retry: null,
  };

  const say = () => onState({ mode: self.mode, err: self.err, label: self.label,
                             live: self.ready() });

  /** True when there is a frame to draw. Asked every animation frame. */
  self.ready = () => {
    const el = self.el;
    if (!el) return false;
    return el.tagName === 'IMG'
      ? el.complete && el.naturalWidth > 0
      : el.readyState >= 2;
  };

  self.size = () => {
    const el = self.el;
    if (!el) return null;
    return el.tagName === 'IMG'
      ? { w: el.naturalWidth, h: el.naturalHeight }
      : { w: el.videoWidth, h: el.videoHeight };
  };

  /** The part of the frame to draw: [sx, sy, sw, sh] in source pixels. */
  self.crop = () => {
    const s = self.size();
    return s ? camCrop(s.w, s.h, self.mode === 'rpi') : [0, 0, 1, 1];
  };

  const dropStream = () => {
    if (self.stream) { self.stream.getTracks().forEach((t) => t.stop()); self.stream = null; }
  };
  const dropRetry = () => {
    if (self._retry) { clearTimeout(self._retry); self._retry = null; }
  };

  /** The robot's own webcam, over the server. The default everywhere. */
  self.useRpi = () => {
    dropStream();
    dropRetry();
    self.mode = 'rpi';
    self.err = null;
    self.label = 'RPi veb-kamera';
    img.onerror = () => {
      self.err = 'kamera akışı kesildi — yeniden bağlanıyor';
      say();
      dropRetry();
      self._retry = setTimeout(() => { if (self.mode === 'rpi') img.src = camStreamUrl(); },
                               CAM_RETRY_MS);
    };
    img.onload = () => { self.err = null; say(); };
    camAfterLoad(() => { if (self.mode === 'rpi') img.src = camStreamUrl(); });
    self.el = img;
    say();
    return self;
  };

  /**
   * This browser's own camera. Only useful at a desk, and only available on
   * localhost or https — which is exactly the restriction the RPi mode exists
   * to escape, so say so rather than showing a black rectangle.
   */
  self.useBrowser = async (deviceId) => {
    dropRetry();
    self.mode = 'browser';
    if (!navigator.mediaDevices?.getUserMedia) {
      self.err = 'Bu adreste tarayıcı kamerası yok (yalnızca localhost / https). '
               + 'RPi kamerasını kullan.';
      self.el = null;
      say();
      return self;
    }
    try {
      dropStream();
      self.stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } }
                        : { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = self.stream;
      video.loop = false;
      await video.play();
      self.el = video;
      self.err = null;
      self.label = 'tarayıcı kamerası';
    } catch (e) {
      self.err = 'Kamera açılmadı: ' + e.message;
      self.el = null;
    }
    say();
    return self;
  };

  /** A file — an image or a recording of the track. Works everywhere. */
  self.useFile = (file) => {
    dropStream();
    dropRetry();
    if (!file) return self;
    self.mode = 'file';
    self.err = null;
    self.label = 'fayl: ' + (file.name || '').slice(0, 28);
    const url = URL.createObjectURL(file);
    if ((file.type || '').startsWith('video')) {
      video.srcObject = null;
      video.src = url;
      video.loop = true;
      video.play();
      self.el = video;
    } else {
      const still = new Image();
      still.onload = () => { self.el = still; say(); };
      still.src = url;
    }
    say();
    return self;
  };

  self.stop = () => {
    dropStream();
    dropRetry();
    img.onerror = null;
    img.src = '';                 // ends the MJPEG response server-side too
    video.pause();
    self.mode = 'off';
    self.el = null;
    self.label = 'durdu';
    say();
    return self;
  };

  /** Cameras this browser can see, for the browser-camera picker. */
  self.devices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput');
    } catch { return []; }
  };

  return self;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { camMount, camStreamUrl, camAfterLoad };
}
