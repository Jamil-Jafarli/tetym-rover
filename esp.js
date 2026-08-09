// Wire format for the RPi/PC -> ESP32 throttle link.
// Direct port of rpi/esp.py — keep the two in sync, and both in sync with
// esp32/throttle_dac_2ch/throttle_dac_2ch.ino.

export const BAUD = 115200;

// Opening the port asserts DTR/RTS, which resets the board through the CP210x.
// We drop both lines immediately, but the ESP32 still needs its boot time
// before it will listen — packets sent during that window are lost.
export const BOOT_WAIT_MS = 1500;

export const V_IDLE = 1.0;   // zero throttle; never send below this
export const V_MIN = 1.0;
export const V_MAX = 3.3;
export const V_REF = 3.3;    // DAC full scale (= VDD)

export const FRAME_1CH = 0xa5;   // legacy: one value, applied to both wheels
export const FRAME_2CH = 0xa6;   // left + right
export const CSUM_SEED = 0x5a;

export const SEND_PERIOD_MS = 50;   // 20 Hz, inside the ESP32's 300 ms watchdog

export function clamp(v, lo = V_MIN, hi = V_MAX) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function csum(payload) {
  let c = CSUM_SEED;
  for (const b of payload) c ^= b;
  return c;
}

/** Legacy single-channel packet. Returns { frame, v }. */
export function pack(voltage) {
  const v = clamp(voltage);
  const payload = Buffer.alloc(4);
  payload.writeFloatLE(v, 0);
  return { frame: Buffer.concat([Buffer.from([FRAME_1CH]), payload,
                                 Buffer.from([csum(payload)])]), v };
}

/** Dual-channel packet. Returns { frame, vl, vr }. */
export function pack2(vLeft, vRight) {
  const vl = clamp(vLeft);
  const vr = clamp(vRight);
  const payload = Buffer.alloc(8);
  payload.writeFloatLE(vl, 0);
  payload.writeFloatLE(vr, 4);
  return { frame: Buffer.concat([Buffer.from([FRAME_2CH]), payload,
                                 Buffer.from([csum(payload)])]), vl, vr };
}

/**
 * Percent -> volts. 0% is idle (zero throttle), 100% is the ceiling you set
 * with --v-max. This is the only unit the UI speaks; volts are what actually
 * goes on the wire, because that is what the motor controller reads.
 */
export function pctToVolts(pct, vMax = V_MAX) {
  const top = clamp(vMax);
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return V_IDLE + (p / 100) * (top - V_IDLE);
}

export function voltsToPct(v, vMax = V_MAX) {
  const top = clamp(vMax);
  if (top <= V_IDLE) return 0;
  return Math.max(0, Math.min(100, ((clamp(v) - V_IDLE) / (top - V_IDLE)) * 100));
}

/** Same rounding the firmware uses — used by the board mirrors, not the UI. */
export function dacFor(v) {
  return Math.max(0, Math.min(255, Math.round(clamp(v) / V_REF * 255)));
}

// "v=2.00 dac=155 rx=282 pkt=47 bad=0 vL=2.00 vR=1.60 dacL=155 dacR=124"
const REPORT_RE = /v=([\d.]+)\s+dac=(\d+)\s+rx=(\d+)\s+pkt=(\d+)\s+bad=(\d+)/;
const REPORT2_RE = /vL=([\d.]+)\s+vR=([\d.]+)\s+dacL=(\d+)\s+dacR=(\d+)/;

/** Parse one ESP32 log line. Returns null if it is not a report. */
export function parseReport(line) {
  const m = REPORT_RE.exec(line);
  if (!m) return null;
  const rep = {
    v: parseFloat(m[1]), dac: parseInt(m[2], 10),
    rx: parseInt(m[3], 10), pkt: parseInt(m[4], 10), bad: parseInt(m[5], 10),
  };
  const m2 = REPORT2_RE.exec(line);
  if (m2) {
    rep.vL = parseFloat(m2[1]); rep.vR = parseFloat(m2[2]);
    rep.dacL = parseInt(m2[3], 10); rep.dacR = parseInt(m2[4], 10);
  } else {
    // Single-channel firmware still flashed.
    rep.vL = rep.v; rep.vR = rep.v; rep.dacL = rep.dac; rep.dacR = rep.dac;
  }
  return rep;
}
