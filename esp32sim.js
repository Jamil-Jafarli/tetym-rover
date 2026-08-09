// Byte-for-byte mirror of the ESP32 receive path in throttle_dac_2ch.ino.
//
// Powers `--fake` mode (try the whole UI with no hardware plugged in) and the
// test suite. If you change the .ino parser, change this too.

import { FRAME_1CH, FRAME_2CH, CSUM_SEED, V_IDLE, V_MIN, V_MAX, V_REF }
  from './esp.js';

const WAIT_HEADER = 0, READ_PAYLOAD = 1, READ_CSUM = 2;
export const LINK_TIMEOUT_MS = 300;

export class Esp32 {
  constructor() {
    this.state = WAIT_HEADER;
    this.payload = [];
    this.want = 0;
    this.kind = 0;
    this.vl = V_IDLE;
    this.vr = V_IDLE;
    this.atIdle = true;
    this.lastPacketMs = 0;
    this.rx = 0;
    this.good = 0;
    this.bad = 0;
  }

  feed(data, nowMs = 0) {
    for (const b of data) {
      this.rx++;
      if (this.state === WAIT_HEADER) {
        if (b === FRAME_1CH || b === FRAME_2CH) {
          this.kind = b;
          this.want = b === FRAME_2CH ? 8 : 4;
          this.payload = [];
          this.state = READ_PAYLOAD;
        }
      } else if (this.state === READ_PAYLOAD) {
        this.payload.push(b);
        if (this.payload.length === this.want) this.state = READ_CSUM;
      } else {
        let want = CSUM_SEED;
        for (const p of this.payload) want ^= p;
        if (b === want) this._apply(nowMs);
        else this.bad++;
        this.state = WAIT_HEADER;   // resync either way
      }
    }
  }

  _apply(nowMs) {
    const buf = Buffer.from(this.payload);
    let vl, vr;
    if (this.kind === FRAME_2CH) {
      vl = buf.readFloatLE(0);
      vr = buf.readFloatLE(4);
    } else {
      vl = buf.readFloatLE(0);
      vr = vl;
    }
    if (!Number.isFinite(vl) || !Number.isFinite(vr)) return;
    this.vl = Math.max(V_MIN, Math.min(V_MAX, vl));
    this.vr = Math.max(V_MIN, Math.min(V_MAX, vr));
    this.atIdle = false;
    this.lastPacketMs = nowMs;
    this.good++;
  }

  /** Watchdog, same condition as the firmware's loop(). */
  tick(nowMs) {
    if (!this.atIdle && nowMs - this.lastPacketMs > LINK_TIMEOUT_MS) {
      this.vl = this.vr = V_IDLE;
      this.atIdle = true;
    }
  }

  get dacs() {
    const d = (v) => Math.max(0, Math.min(255, Math.round(v / V_REF * 255)));
    return [d(this.vl), d(this.vr)];
  }

  /** The 2 Hz log line the firmware prints. */
  logLine() {
    const [dl, dr] = this.dacs;
    return `v=${this.vl.toFixed(2)} dac=${dl} rx=${this.rx} pkt=${this.good} `
         + `bad=${this.bad} vL=${this.vl.toFixed(2)} vR=${this.vr.toFixed(2)} `
         + `dacL=${dl} dacR=${dr}${this.atIdle ? ' (idle)' : ''}`;
  }
}

/**
 * Stand-in for a SerialPort: swallows written frames into a simulated ESP32
 * and emits its log lines back on the same cadence the real board would.
 */
export class FakeSerial {
  constructor(onLine) {
    this.dev = new Esp32();
    this.t0 = Date.now();
    this.onLine = onLine;
    this.isOpen = true;
    this._timer = setInterval(() => {
      this.dev.tick(this.nowMs());
      if (this.onLine) this.onLine(this.dev.logLine());
    }, 500);
    this._wd = setInterval(() => this.dev.tick(this.nowMs()), 20);
  }

  nowMs() { return Date.now() - this.t0; }

  write(buf, cb) {
    this.dev.feed(buf, this.nowMs());
    if (cb) cb(null);
    return true;
  }

  close(cb) {
    clearInterval(this._timer);
    clearInterval(this._wd);
    this.isOpen = false;
    if (cb) cb(null);
  }
}
