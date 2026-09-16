/**
 * The QR reader's heavy half, on its own thread.
 *
 * One look at a 1920x1080 frame — find the code-like patch, magnify it ×2,
 * straighten it, jsQR — is 40–200 ms on the Pi, and on the main thread that
 * is 40–200 ms in which the 20 Hz control stream to the board is not being
 * sent. So it runs here, and the main thread only ever sees the answer.
 *
 * Messages in:  { gray: ArrayBuffer (transferred), w, h, force, first }
 * Messages out: lookQr()'s result plus { w, h, ms }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { lookQr } from './qrwarp.js';

parentPort.on('message', (m) => {
  const t0 = Date.now();
  let r;
  try {
    r = lookQr(new Uint8Array(m.gray), m.w, m.h,
      { ...(workerData || {}), force: !!m.force, first: m.first || undefined });
  } catch (e) {
    r = { text: null, err: String(e.message || e) };
  }
  parentPort.postMessage({ ...r, w: m.w, h: m.h, ms: Date.now() - t0 });
});
