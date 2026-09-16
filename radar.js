/**
 * The radar: whatever the lidar sends to this Pi on port 8443, turned into
 * one picture — a distance for every degree round the rover.
 *
 * The sender is not this program's, and what it speaks was not written down,
 * so the port answers every way a small board is likely to push data:
 *
 *     UDP              one datagram at a time
 *     TCP              a raw stream
 *     HTTP POST        the body, to any path
 *     WebSocket        ws:// — each message
 *     TLS              any of the TCP ones wrapped in it (https://, wss://),
 *                      against a self-signed certificate made on first start
 *
 * and inside those, three kinds of payload:
 *
 *     LD06 / LD19      the 47-byte binary packet (0x54 0x2C …, CRC-checked)
 *     SCN1             the iPhone's ARKit app, turning on the lidar motor:
 *                      its angles and 256 distances in mm across 60°
 *     JSON            {angle, distance}, [[a, d], …], {points: […]},
 *                      ROS LaserScan {angle_min, angle_increment, ranges}, …
 *     text             one "angle,distance[,quality]" per line
 *
 * Anything else is kept as a hex sample, so the dashboard can show what did
 * arrive rather than an empty radar and no reason.
 *
 * Angles are degrees clockwise from the rover's nose — the field map's
 * bearing convention. A lidar mounted turned, or one that counts the other
 * way, is fixed with the offset and ccw settings (the card has both). A
 * distance is millimetres unless its key or its numbers say otherwise.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import fs from 'node:fs';
import { Duplex } from 'node:stream';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { reply, readBody } from './marlin_http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RADAR_DEFAULTS = {
  port: 8443,
  host: '0.0.0.0',
  bins: 360,            // one degree each
  // A return older than this is gone from the picture. The iPhone takes a
  // good second to go round on the motor and half its frames come back
  // empty, so a degree is refreshed every turn or two, not every frame.
  keepMs: 3000,
  maxMm: 40000,
  offset: 0,            // degrees added to every angle
  ccw: false,           // the lidar counts anticlockwise
  unit: 'auto',         // mm | cm | m | auto — for distances that do not say
  // SCN1: how wide the 256 columns reach, degrees, centred on where the
  // phone looks. The app takes 330°–30° of its own view.
  fov: 60,
  certDir: path.join(HERE, 'certs'),
};

const UNITS = { mm: 1, cm: 10, m: 1000 };

// ── LD06 / LD19 ─────────────────────────────────────────────────────
//
//   0     0x54 header          42–43  end angle, 0.01°
//   1     0x2C 12 points       44–45  timestamp, ms
//   2–3   speed, °/s           46     CRC-8 (poly 0x4D) of bytes 0–45
//   4–5   start angle, 0.01°
//   6–41  12 × (distance mm u16, intensity u8)
const LD_LEN = 47;
const LD_HEAD = Buffer.from([0x54, 0x2c]);

const CRC_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x4d) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

export function crc8(buf, start = 0, len = buf.length - start) {
  let c = 0;
  for (let i = start; i < start + len; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff];
  return c;
}

/** The LD06 packet at `i` → {speed, points}, or null if there is none there. */
export function ld06Packet(buf, i = 0) {
  if (buf.length - i < LD_LEN || buf[i] !== 0x54 || buf[i + 1] !== 0x2c) return null;
  if (crc8(buf, i, LD_LEN - 1) !== buf[i + LD_LEN - 1]) return null;
  const a0 = buf.readUInt16LE(i + 4) / 100;
  const a1 = buf.readUInt16LE(i + 42) / 100;
  const step = ((a1 - a0 + 360) % 360) / 11;
  const points = [];
  for (let k = 0; k < 12; k++) {
    const o = i + 6 + k * 3;
    points.push({ a: (a0 + step * k) % 360, d: buf.readUInt16LE(o), q: buf[o + 2], u: 'mm' });
  }
  return { speed: buf.readUInt16LE(i + 2), points };
}

/** The other way round — for the tests and test/fake_lidar.mjs. */
export function ld06Encode(startDeg, endDeg, dists, speed = 3600, stamp = 0) {
  const b = Buffer.alloc(LD_LEN);
  b[0] = 0x54; b[1] = 0x2c;
  b.writeUInt16LE(speed & 0xffff, 2);
  b.writeUInt16LE(Math.round(startDeg * 100) % 36000, 4);
  for (let k = 0; k < 12; k++) {
    b.writeUInt16LE(Math.max(0, Math.min(0xffff, Math.round(dists[k] || 0))), 6 + k * 3);
    b[8 + k * 3] = 200;
  }
  b.writeUInt16LE(Math.round(endDeg * 100) % 36000, 42);
  b.writeUInt16LE(stamp & 0xffff, 44);
  b[46] = crc8(b, 0, 46);
  return b;
}

// ── SCN1: the iPhone's ARKit app ────────────────────────────────────
//
// Read off the app's own packets — nothing was written down:
//
//   0–3    "SCN1"                24–31  f64 time, ms since 1970
//   4      version (1)           32–35  f32 (≈1.63, does not move — not known)
//   5      type (6)              36–39  f32 ARKit tracking: 1, or 0.3 when limited
//   6–7    u16 N, columns (256)  40–47  two f32 (1, 0 — not known)
//   8–11   u32 frame number      48–    N × u16 distance, mm; 0 = no reading
//   12–23  three f32 angles, rad — the third is the phone's turn on the motor
//
// Worked out with the motor running (0.84 turns/s, 642 frames): the third
// angle goes round at the motor's speed, and the distances repeat once per
// turn of it — 0.8 m one way, 3–4.5 m of wall the others — not every half
// turn, so it sweeps the room rather than spinning the picture. There is no
// position in the packet: the phone is taken to turn in one place.
//
// The columns span 60°, evenly, and run right to left: column k is at
// -(turn + its angle) clockwise. That and its mirror (the card's "ters yön")
// are the two ways round that put the same wall in the same place turn after
// turn; the other two smear it.
const SCN_HEAD = Buffer.from('SCN1', 'latin1');
const SCN_HDR = 48;

/** The SCN1 frame at `i` → its fields; {need} if it has not all arrived. */
export function scn1Frame(buf, i = 0) {
  if (buf.length - i < SCN_HDR) return { need: SCN_HDR };
  const n = buf.readUInt16LE(i + 6);
  const len = SCN_HDR + 2 * n;
  if (buf.length - i < len) return { need: len };
  const d = new Array(n);
  for (let k = 0; k < n; k++) d[k] = buf.readUInt16LE(i + SCN_HDR + 2 * k);
  const a = [buf.readFloatLE(i + 12), buf.readFloatLE(i + 16), buf.readFloatLE(i + 20)];
  return {
    len, n, d, ver: buf[i + 4], type: buf[i + 5],
    seq: buf.readUInt32LE(i + 8),
    a, rot: a[2],
    t: buf.readDoubleLE(i + 24),
    h32: buf.readFloatLE(i + 32),
    quality: buf.readFloatLE(i + 36),
  };
}

/** The other way round — for the tests. */
export function scn1Encode(dists, { seq = 0, ang = [0, 0, 0], t = 0, h32 = 0, quality = 1 } = {}) {
  const n = dists.length, b = Buffer.alloc(SCN_HDR + 2 * n);
  SCN_HEAD.copy(b, 0);
  b[4] = 1; b[5] = 6;
  b.writeUInt16LE(n, 6);
  b.writeUInt32LE(seq >>> 0, 8);
  ang.forEach((v, k) => b.writeFloatLE(v, 12 + 4 * k));
  b.writeDoubleLE(t, 24);
  b.writeFloatLE(h32, 32);
  b.writeFloatLE(quality, 36); b.writeFloatLE(1, 40);
  dists.forEach((d, k) => b.writeUInt16LE(Math.max(0, Math.min(0xffff, Math.round(d))), SCN_HDR + 2 * k));
  return b;
}

/** A row of distances → points: right to left across the sector, at the phone's turn. */
function spreadColumns(d, fov, turn, out) {
  const n = d.length;
  for (let k = 0; k < n; k++) {
    if (d[k]) out.push({ a: -(turn + ((k + 0.5) / n - 0.5) * fov), d: d[k], u: 'mm', ar: false });
  }
}

// ── text and JSON ───────────────────────────────────────────────────

function looksText(buf) {
  const n = Math.min(buf.length, 512);
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) ok++;
  }
  return n > 0 && ok / n >= 0.95;
}

const A_KEYS = ['angle', 'a', 'ang', 'deg', 'degree', 'degrees', 'theta', 'bearing',
                'azimuth', 'heading', 'angle_deg', 'angle_rad', 'rad'];
const D_KEYS = ['distance', 'dist', 'd', 'r', 'range', 'len', 'value', 'mm', 'cm', 'm',
                'distance_mm', 'distance_cm', 'distance_m', 'dist_mm', 'dist_cm', 'dist_m',
                'range_mm', 'range_cm', 'range_m'];
const RANGE_KEYS = ['ranges', 'distances', 'dists', 'dist', 'values', 'data'];
const LIST_KEYS = ['points', 'pts', 'scan', 'data', 'samples', 'lidar', 'measurements',
                   'readings', 'nodes', 'p'];

const unitOfKey = (k) => (/(^|_)mm$/.test(k) ? 'mm' : /(^|_)cm$/.test(k) ? 'cm'
  : /(^|_)m$/.test(k) ? 'm' : undefined);
const unitWord = (w) => (typeof w === 'string' && UNITS[w.toLowerCase()] ? w.toLowerCase() : undefined);
const isNumList = (v) => Array.isArray(v) && v.length > 0
  && v.every((x) => x === null || typeof x === 'number');

function numOf(o, keys) {
  for (const k of keys) if (typeof o[k] === 'number') return o[k];
  return null;
}

/** Evenly spaced distances: `ar` true means a0 and step are radians. */
function spread(list, a0, step, ar, u, out) {
  list.forEach((d, i) => { if (typeof d === 'number') out.push({ a: a0 + step * i, d, u, ar }); });
}

/**
 * Points out of one parsed JSON value, into `out` as {a, d, q, u, ar}. `u` is
 * the distance's unit when something said it; `ar` is true for radians,
 * false for degrees, undefined when nothing said.
 */
function fromJson(v, out, ctx = {}, depth = 0) {
  if (v == null || depth > 5) return;
  if (Array.isArray(v)) {
    if (isNumList(v)) {
      // [a, d] or [a, d, q] is one point; anything longer is a distance per
      // step, round the whole circle.
      if (v.length <= 3) {
        if (v[0] != null && v[1] != null) out.push({ a: v[0], d: v[1], q: v[2], u: ctx.u, ar: ctx.ar });
      } else {
        spread(v, 0, 360 / v.length, false, ctx.u, out);
      }
      return;
    }
    for (const x of v) fromJson(x, out, ctx, depth + 1);
    return;
  }
  if (typeof v !== 'object') return;

  const o = {};
  for (const [k, x] of Object.entries(v)) o[k.toLowerCase()] = x;
  const c = {
    u: unitWord(o.unit) || unitWord(o.units) || ctx.u,
    ar: ctx.ar ?? (typeof o.angle_unit === 'string' ? /rad/i.test(o.angle_unit) : undefined),
  };

  // A scan as a list of distances: ROS's LaserScan (radians, metres), or
  // anything with a start and a step or an end.
  const rk = RANGE_KEYS.find((k) => isNumList(o[k]) && o[k].length > 3);
  if (rk) {
    const list = o[rk];
    const ros = 'angle_increment' in o || 'angle_min' in o;
    const ar = ros || c.ar === true;
    const full = ar ? 2 * Math.PI : 360;
    const a0 = numOf(o, ['angle_min', 'start_angle', 'angle_start', 'start', 'a0']) ?? 0;
    const a1 = numOf(o, ['angle_max', 'end_angle', 'angle_end', 'end', 'a1']);
    let step = numOf(o, ['angle_increment', 'angle_step', 'step', 'increment']);
    if (step == null) {
      step = a1 != null ? (((a1 - a0 + full) % full) || full) / (list.length - 1) : full / list.length;
    }
    spread(list, a0, step, ar, unitOfKey(rk) || c.u || (ros ? 'm' : undefined), out);
    return;
  }

  const ak = A_KEYS.find((k) => typeof o[k] === 'number');
  const dk = D_KEYS.find((k) => typeof o[k] === 'number');
  if (ak && dk) {
    const q = [o.q, o.quality, o.intensity, o.strength].find((x) => typeof x === 'number');
    out.push({ a: o[ak], d: o[dk], q, u: unitOfKey(dk) || c.u,
               ar: /rad/.test(ak) ? true : c.ar });
    return;
  }

  for (const k of LIST_KEYS) {
    if (o[k] && typeof o[k] === 'object') fromJson(o[k], out, c, depth + 1);
  }
}

/** Every JSON value in `t`: one, or several run together — or null. */
function jsonValues(t) {
  if (t[0] !== '{' && t[0] !== '[') return null;
  try { return [JSON.parse(t)]; } catch { /* maybe several */ }
  const parts = t.replace(/\}\s*\{/g, '} {').split(' ');
  if (parts.length < 2) return null;
  try { return parts.map((p) => JSON.parse(p)); } catch { return null; }
}

const NUM = /-?\d+(?:\.\d+)?(?:e-?\d+)?/gi;

/** One line of text → points in `out`. Returns 'json', 'text' or null. */
function fromLine(line, out) {
  const s = line.trim();
  if (!s) return null;
  const vals = jsonValues(s);
  if (vals) { for (const v of vals) fromJson(v, out); return 'json'; }
  const u = /\dmm\b|\bmm\b/i.test(s) ? 'mm' : /\dcm\b|\bcm\b/i.test(s) ? 'cm'
    : /\d\s?m\b/i.test(s) ? 'm' : undefined;
  let got = false;
  for (const seg of s.split(/[;|]/)) {
    const n = seg.match(NUM);
    if (n && n.length >= 2) {
      out.push({ a: +n[0], d: +n[1], q: n[2] != null ? +n[2] : undefined, u });
      got = true;
    }
  }
  return got ? 'text' : null;
}

/**
 * One sender's bytes → points. A stream's leftovers — half a line, half a
 * packet — belong to the stream they came from, so there is one of these
 * per sender.
 */
export class ScanDecoder {
  constructor() {
    this.rest = null;
    this.fmt = null;        // 'ld06' | 'scn1' | 'json' | 'text' | 'binary?'
    this.unit = 'mm';       // the guess for distances that do not say
    this.rad = false;       // the guess for angles that do not say
    this.speed = null;      // LD06: degrees per second
    this.lastA = null;      // the last raw angle, for counting sweeps
    this.pose = null;       // SCN1: the phone's last angles
    this.restarts = 0;      // SCN1: times the frame number went back — a new ARKit session
    this.turns = [];        // SCN1: [phone time, unwrapped turn] over the last 3 s
    this._rot = null;
    this._u = 0;
  }

  /** The phone's turn, unwrapped, for how fast the motor is going round. */
  _turn(rad, t) {
    if (this._rot == null) this._u = 0;
    else this._u += ((rad - this._rot + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    this._rot = rad;
    this.turns.push([t, this._u]);
    while (this.turns.length > 2 && t - this.turns[0][0] > 3000) this.turns.shift();
  }

  /** Turns per second over the last few seconds, or null. */
  turnHz() {
    const T = this.turns;
    if (T.length < 2) return null;
    const s = (T[T.length - 1][0] - T[0][0]) / 1000;
    return s >= 0.3 ? Math.abs(T[T.length - 1][1] - T[0][1]) / (2 * Math.PI) / s : null;
  }

  /**
   * @param {Buffer} chunk
   * @param {boolean} whole  a datagram, a message or a body: text that ends
   *                         with it is complete. A TCP stream never is.
   * @param {string} unit    'auto', or the unit for distances that do not say
   * @param {number} fov     SCN1: the depth map's width, degrees
   * @returns {Array<{a: number, d: number, q?: number}>}  degrees, mm
   */
  decode(chunk, whole = false, unit = 'auto', fov = RADAR_DEFAULTS.fov) {
    // A whole message of text starts clean: what was left over was half a
    // binary packet, and text is not its other half.
    if (this.rest && whole && looksText(chunk)) this.rest = null;
    const buf = this.rest ? Buffer.concat([this.rest, chunk]) : chunk;
    this.rest = null;
    if (!buf.length) return [];
    const out = [];

    // SCN1 says its own length, so a stream of them can be cut anywhere.
    const scn = buf.indexOf(SCN_HEAD);
    if (scn === 0 || (scn > 0 && !whole && this.fmt === 'scn1')) {
      let i = scn;
      while (i >= 0) {
        const f = scn1Frame(buf, i);
        if (f.need) break;
        if (this.pose && f.seq < this.pose.seq) {
          this.restarts++;
          this.turns = [];
          this._rot = null;
        }
        const turn = f.rot * 180 / Math.PI;
        spreadColumns(f.d, fov, turn, out);
        this.pose = { seq: f.seq, angles: f.a, rot_deg: turn, quality: f.quality, t: f.t, n: f.n };
        this._turn(f.rot, f.t);
        this.fmt = 'scn1';
        i = buf.indexOf(SCN_HEAD, i + f.len);
      }
      if (i >= 0 && !whole) this.rest = Buffer.from(buf.subarray(i));
      return this.normalise(out, unit);
    }

    const text = looksText(buf);
    if (this.fmt === 'ld06' || (!text && buf.includes(LD_HEAD))) {
      let i = 0, got = false;
      for (;;) {
        i = buf.indexOf(0x54, i);
        if (i < 0 || buf.length - i < LD_LEN) break;
        const p = ld06Packet(buf, i);
        if (p) {
          for (const pt of p.points) out.push(pt);
          this.speed = p.speed;
          got = true;
          i += LD_LEN;
        } else {
          i++;
        }
      }
      if (got) this.fmt = 'ld06';
      else if (this.fmt !== 'ld06' && buf.length >= 2 * LD_LEN) this.fmt = 'binary?';
      // A packet the network cut in two waits here for its other half.
      if (i >= 0) this.rest = Buffer.from(buf.subarray(i));
      return this.normalise(out, unit);
    }

    if (!text) {
      this.fmt = 'binary?';
      // Kept in case an LD06 header was cut across the boundary.
      this.rest = Buffer.from(buf.subarray(Math.max(0, buf.length - (LD_LEN - 1))));
      return [];
    }

    const s = buf.toString('utf8');
    if (whole) {
      const vals = jsonValues(s.trim());
      if (vals) {
        for (const v of vals) fromJson(v, out);
        // A message with no points in it — the iPhone app's {"type":"ping"}
        // — says nothing about what the points come as.
        if (out.length || !this.fmt) this.fmt = 'json';
        return this.normalise(out, unit);
      }
    }
    const lines = s.split('\n');
    let tail = whole ? '' : lines.pop();
    for (const line of lines) {
      const before = out.length;
      const kind = fromLine(line, out);
      if (kind && (out.length > before || !this.fmt)) this.fmt = kind;
    }
    if (tail) {
      // A stream that sends one JSON object per write and no newline.
      const t = tail.trim();
      if ((t.endsWith('}') || t.endsWith(']')) && jsonValues(t)) {
        this.fmt = fromLine(t, out) || this.fmt;
        tail = '';
      }
      if (tail.length > 256 * 1024) tail = '';        // not a line; not ours to keep
      if (tail) this.rest = Buffer.from(tail);
    }
    return this.normalise(out, unit);
  }

  /** Raw points → degrees and millimetres, settling what nothing said. */
  normalise(pts, unit = 'auto') {
    const free = pts.filter((p) => !p.u);
    if (free.length) {
      if (UNITS[unit]) {
        for (const p of free) p.u = unit;
      } else {
        // Millimetres, unless every number is small and some have a decimal
        // point: then metres. Nothing a lidar sees is 40 mm away.
        let max = 0, frac = false;
        for (const p of free) { max = Math.max(max, p.d); if (!Number.isInteger(p.d)) frac = true; }
        if (max > 40) this.unit = 'mm'; else if (frac) this.unit = 'm';
        for (const p of free) p.u = this.unit;
      }
    }
    const loose = pts.filter((p) => p.ar === undefined);
    if (loose.length >= 8) {
      let max = 0, frac = false;
      for (const p of loose) { max = Math.max(max, Math.abs(p.a)); if (!Number.isInteger(p.a)) frac = true; }
      this.rad = max <= 6.3 && frac;
    }
    const out = [];
    for (const p of pts) {
      const a = (p.ar ?? this.rad) ? p.a * 180 / Math.PI : p.a;
      const d = p.d * UNITS[p.u || 'mm'];
      if (Number.isFinite(a) && Number.isFinite(d) && d > 0) {
        out.push({ a: ((a % 360) + 360) % 360, d, q: p.q });
      }
    }
    return out;
  }
}

// ── the port ────────────────────────────────────────────────────────

function explain(e, port) {
  if (e.code === 'EADDRINUSE') return `${port} portu artıq məşğuldur — başqa proses dinləyir`;
  if (e.code === 'EACCES') return `${port} portuna icazə yoxdur`;
  return String(e.message || e);
}

export class Radar {
  /**
   * @param {object} [cfg]  RADAR_DEFAULTS overrides, plus:
   *   enabled  false = nothing is opened; the status says so. `--no-radar`.
   */
  constructor(cfg = {}) {
    this.cfg = { ...RADAR_DEFAULTS, ...cfg };
    this.enabled = cfg.enabled !== false;
    this.dist = new Uint16Array(this.cfg.bins);
    this.at = new Float64Array(this.cfg.bins);
    this.decoders = new Map();
    this.listening = { udp: false, tcp: false };
    this.errs = {};
    this.tlsErr = null;
    this._tlsCtx = null;
    this.packets = 0; this.bytes = 0; this.points = 0;
    this.lastAt = 0; this.from = null; this.via = null;
    this.fmt = null; this.unit = null; this.speed = null; this.pose = null;
    this.lastA = null;          // the last angle drawn, after offset and direction
    this._own = { lastA: null };  // add()'s sweep counting, when no decoder is given
    this.wraps = [];            // when each sweep ended, for the rotation rate
    this.raw = [];              // the last few arrivals, as they came
    this._rawAt = 0;
    // The last few messages whole, for /api/radar/frames: a format nobody
    // wrote down is read off real bytes, and 48 of them is only the header.
    this.frames = [];
    // The room: every return that has landed, counted per 5 cm cell round the
    // phone, ±8 m. Unlike the radar's bins nothing here goes stale — a wall is
    // hit turn after turn, a hand going past once — so it is drawn by count.
    this.cell = 50;
    this.half = 160;
    this.grid = new Uint16Array((2 * this.half) ** 2);
    this.mapPts = 0;
    this.mapSince = Date.now();
    this._dec = null;
    this._rate = { t: Date.now(), n: 0, v: 0 };
    this._socks = new Set();
  }

  get err() {
    return Object.entries(this.errs).map(([k, v]) => `${k}: ${v}`).join(' · ') || null;
  }

  async start() {
    if (!this.enabled) return;
    const { port, host } = this.cfg;
    this._ensureCert();

    this._http = http.createServer((req, res) => this._request(req, res));
    this._wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    this._http.on('upgrade', (req, sock, head) => {
      this._wss.handleUpgrade(req, sock, head, (ws) => {
        const from = sock._radarPeer || `${sock.remoteAddress}:${sock.remotePort}`;
        const via = sock.encrypted ? 'wss' : 'ws';
        ws.on('message', (d) => this.ingest(Buffer.isBuffer(d) ? d : Buffer.from(d), via, from, true));
        ws.on('error', () => ws.terminate());
      });
    });

    this._udp = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    this._udp.on('message', (msg, r) => this.ingest(msg, 'udp', `${r.address}:${r.port}`, true));
    this._tcp = net.createServer((s) => this._sniff(s, 'tcp'));

    const bind = (what, srv, go) => new Promise((resolve) => {
      srv.on('error', (e) => { this.errs[what] = explain(e, port); resolve(); });
      go(() => { this.listening[what] = true; delete this.errs[what]; resolve(); });
    });
    await Promise.all([
      bind('udp', this._udp, (ok) => this._udp.bind(port, host, ok)),
      bind('tcp', this._tcp, (ok) => this._tcp.listen(port, host, ok)),
    ]);
  }

  /**
   * One TCP connection: its first bytes say what it is. A TLS hello is
   * unwrapped and looked at again; an HTTP request goes to the little server
   * (a POST body, or a WebSocket upgrade); anything else is a raw stream.
   */
  _sniff(sock, via, peer = `${sock.remoteAddress}:${sock.remotePort}`) {
    this._socks.add(sock);
    sock._radarPeer = peer;
    sock.on('close', () => this._socks.delete(sock));
    sock.on('error', () => sock.destroy());
    sock.setTimeout(60000, () => sock.destroy());
    sock.once('data', (first) => {
      sock.pause();
      if (via === 'tcp' && first[0] === 0x16 && first[1] === 0x03) {
        this._tls(sock, first, peer);
        return;
      }
      if (/^(GET|POST|PUT|HEAD|OPTIONS) /.test(first.toString('latin1', 0, 8))) {
        sock.unshift(first);
        this._http.emit('connection', sock);
        sock.resume();
        return;
      }
      this.ingest(first, via, peer, false);
      sock.on('data', (d) => this.ingest(d, via, peer, false));
      sock.resume();
    });
  }

  _tls(sock, first, peer) {
    if (!this._tlsCtx) {
      this.tlsErr = this.tlsErr || 'TLS gəldi, amma sertifikat hələ hazır deyil';
      sock.destroy();
      return;
    }
    // A TLSSocket reads a net.Socket's handle directly, past anything already
    // taken out of it — the hello, here. Handed a plain stream instead, it
    // reads through the stream, so the hello goes first.
    const pipe = new Duplex({
      read() { sock.resume(); },
      write(chunk, enc, cb) { sock.write(chunk, cb); },
      final(cb) { sock.end(); cb(); },
      destroy(err, cb) { sock.destroy(); cb(err); },
    });
    pipe.on('error', () => { /* the socket's own handler says what happened */ });
    pipe.push(first);
    sock.on('data', (d) => { if (!pipe.push(d)) sock.pause(); });
    sock.on('end', () => pipe.push(null));
    sock.on('close', () => pipe.destroy());
    const t = new tls.TLSSocket(pipe, { isServer: true, secureContext: this._tlsCtx });
    t.on('error', (e) => { this.tlsErr = `TLS: ${e.message}`; });
    t.on('secure', () => { this.tlsErr = null; });
    this._sniff(t, 'tls', peer);
    sock.resume();
  }

  /** A self-signed certificate in certs/, made once with openssl. */
  _ensureCert() {
    const dir = this.cfg.certDir;
    const key = path.join(dir, 'radar-key.pem'), crt = path.join(dir, 'radar-cert.pem');
    const load = () => {
      try {
        this._tlsCtx = tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) });
      } catch (e) {
        this.tlsErr = `sertifikat oxunmadı: ${e.message}`;
      }
    };
    if (fs.existsSync(key) && fs.existsSync(crt)) { load(); return; }
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* openssl says so below */ }
    execFile('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                         '-nodes', '-keyout', key, '-out', crt, '-days', '3650',
                         '-subj', '/CN=rover-radar'],
             { timeout: 20000 }, (err) => {
      if (err) this.tlsErr = `openssl: ${String(err.message).split('\n')[0]}`;
      else load();
    });
  }

  /** The port's HTTP side: a POST is data; anything else gets the status. */
  _request(req, res) {
    const from = req.socket._radarPeer || `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    if (req.method !== 'POST' && req.method !== 'PUT') { reply(res, 200, this.status()); return; }
    const parts = [];
    let n = 0, over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > 1 << 20) { over = true; reply(res, 413, { error: 'body too large' }); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const got = this.ingest(Buffer.concat(parts), req.socket.encrypted ? 'https' : 'http', from, true);
      reply(res, 200, { ok: true, points: got });
    });
  }

  /**
   * Bytes from a sender → the picture. Returns how many points they held.
   * A whole message is keyed by the sender's address alone: each HTTP POST
   * comes from a new port, and the unit guess should outlive it.
   */
  ingest(buf, via, from, whole = false, now = Date.now()) {
    const key = whole ? `${via}|${String(from).replace(/:\d+$/, '')}` : `${via}|${from}`;
    let dec = this.decoders.get(key);
    if (!dec) {
      dec = new ScanDecoder();
      this.decoders.set(key, dec);
      if (this.decoders.size > 32) this.decoders.delete(this.decoders.keys().next().value);
    }
    this.packets++;
    this.bytes += buf.length;
    this.lastAt = now; this.from = from; this.via = via;
    const restarts = dec.restarts;
    const pts = dec.decode(buf, whole, this.cfg.unit, this.cfg.fov);
    this._dec = dec;
    this.fmt = dec.fmt;
    this.unit = dec.fmt === 'ld06' || dec.fmt === 'scn1' ? 'mm'
      : UNITS[this.cfg.unit] ? this.cfg.unit : dec.unit;
    this.speed = dec.speed;
    if (dec.pose) this.pose = dec.pose;
    // The app started again: its angles are counted from a new zero, so
    // nothing drawn so far lines up with what comes next.
    if (dec.restarts !== restarts) {
      this.dist.fill(0);
      this.clearMap();
    }
    this._sample(buf, via, from, pts.length, now);
    if (buf.length <= 64 * 1024) {
      this.frames.push({ at: now, via, from, len: buf.length, pts: pts.length, b64: buf.toString('base64') });
      if (this.frames.length > 30) this.frames.shift();
    }
    this.add(pts, now, dec);
    return pts.length;
  }

  _sample(buf, via, from, pts, now) {
    if (this.raw.length && now - this._rawAt < 300) return;
    this._rawAt = now;
    const head = buf.subarray(0, 48);
    this.raw.push({
      at: now, via, from, len: buf.length, pts,
      hex: head.toString('hex').replace(/(..)/g, '$1 ').trim(),
      text: head.toString('latin1').replace(/[^\x20-\x7e]/g, '·'),
    });
    if (this.raw.length > 3) this.raw.shift();
  }

  /** Points in degrees and mm, as the sender counts them → the bins. */
  add(points, now = Date.now(), src = this._own) {
    const { bins, offset, ccw, maxMm } = this.cfg;
    for (const p of points) {
      if (p.d > maxMm) continue;
      // A sweep ends where the angle jumps back round the circle. An SCN1
      // frame crosses 0° in its middle and is counted a sweep by itself.
      if (src.fmt !== 'scn1' && src.lastA != null && Math.abs(p.a - src.lastA) > 180) {
        this.wraps.push(now);
        if (this.wraps.length > 12) this.wraps.shift();
      }
      src.lastA = p.a;
      const a = ((((ccw ? -p.a : p.a) + offset) % 360) + 360) % 360;
      const b = Math.floor(a * bins / 360) % bins;
      this.dist[b] = Math.round(p.d);
      this.at[b] = now;
      this.lastA = a;
      const r = a * Math.PI / 180, w = 2 * this.half;
      const ix = Math.floor(p.d * Math.sin(r) / this.cell) + this.half;
      const iy = Math.floor(p.d * Math.cos(r) / this.cell) + this.half;
      if (ix >= 0 && iy >= 0 && ix < w && iy < w) {
        const g = iy * w + ix;
        if (this.grid[g] < 0xffff) this.grid[g]++;
        this.mapPts++;
      }
    }
    this.points += points.length;
  }

  /** The room map, sparse: [ix, iy, hits, …] for every cell hit at least once. */
  mapJson() {
    const { grid, cell, half } = this, w = 2 * half, cells = [];
    let max = 0;
    for (let i = 0; i < grid.length; i++) {
      const n = grid[i];
      if (!n) continue;
      cells.push(i % w, Math.floor(i / w), n);
      if (n > max) max = n;
    }
    return { cell, half, pts: this.mapPts, since: this.mapSince, max, cells, pose: this.pose };
  }

  clearMap() {
    this.grid.fill(0);
    this.mapPts = 0;
    this.mapSince = Date.now();
  }

  /**
   * The offset, the direction, the unit and the FOV, from the card; `zero`
   * makes the way the phone looks now the rover's nose; `clear` only clears.
   * Any of them clears the picture and the map — they move every point.
   */
  setCfg({ offset, ccw, unit, fov, zero } = {}) {
    if (zero) {
      if (!this.pose || this.pose.rot_deg == null) throw new Error('hələ iPhone-dan bucaq gəlməyib');
      // The middle column is at -turn; after the direction, that is to be 0°.
      const raw = -this.pose.rot_deg;
      offset = (ccw ?? this.cfg.ccw) ? raw : -raw;
    }
    if (fov !== undefined) {
      const n = Number(fov);
      if (!(n >= 5 && n <= 170)) throw new Error('fov: 5–170°');
      this.cfg.fov = n;
    }
    if (offset !== undefined) {
      const n = Number(offset);
      if (!Number.isFinite(n)) throw new Error('offset must be a number');
      this.cfg.offset = ((n % 360) + 360) % 360;
    }
    if (ccw !== undefined) this.cfg.ccw = !!ccw;
    if (unit !== undefined) {
      if (unit !== 'auto' && !UNITS[unit]) throw new Error('unit: auto, mm, cm or m');
      this.cfg.unit = unit;
    }
    this.dist.fill(0);
    this.at.fill(0);
    this.clearMap();
    return this.status();
  }

  /** Sweeps per second: the LD06 says so itself; anything else is counted. */
  scanHz(now) {
    if (this.fmt === 'ld06' && this.speed) return Math.round(this.speed / 36) / 10;
    if (this.fmt === 'scn1') {
      const h = this._dec && this._dec.turnHz();
      return h == null || now - this.lastAt > 3000 ? null : Math.round(h * 100) / 100;
    }
    const w = this.wraps;
    if (w.length < 3 || now - w[w.length - 1] > 3000) return null;
    const span = (w[w.length - 1] - w[0]) / 1000;
    return span > 0 ? Math.round((w.length - 1) / span * 10) / 10 : null;
  }

  async close() {
    for (const s of this._socks) s.destroy();
    if (this._wss) for (const c of this._wss.clients) c.terminate();
    await Promise.all([
      new Promise((r) => (this.listening.udp ? this._udp.close(() => r()) : r())),
      new Promise((r) => (this.listening.tcp ? this._tcp.close(() => r()) : r())),
    ]);
    this.listening = { udp: false, tcp: false };
  }

  status(now = Date.now()) {
    const { bins, keepMs } = this.cfg;
    const scan = new Array(bins);
    let near = null, fresh = 0;
    for (let i = 0; i < bins; i++) {
      const live = this.dist[i] > 0 && now - this.at[i] <= keepMs;
      scan[i] = live ? this.dist[i] : 0;
      if (live) {
        fresh++;
        if (!near || this.dist[i] < near.d) near = { a: (i + 0.5) * 360 / bins, d: this.dist[i] };
      }
    }
    const r = this._rate;
    if (now - r.t >= 1000) {
      r.v = (this.points - r.n) * 1000 / (now - r.t);
      r.t = now; r.n = this.points;
    }
    return {
      on: this.enabled,
      port: this.cfg.port,
      udp: this.listening.udp,
      tcp: this.listening.tcp,
      tls: !!this._tlsCtx,
      tls_err: this.tlsErr,
      err: this.err,
      fmt: this.fmt,
      unit: this.unit,
      from: this.from,
      via: this.via,
      packets: this.packets,
      bytes: this.bytes,
      points: this.points,
      pts_s: Math.round(r.v),
      scan_hz: this.scanHz(now),
      age_s: this.lastAt ? Math.round((now - this.lastAt) / 100) / 10 : null,
      fresh,
      near,
      last_a: this.lastA,
      offset: this.cfg.offset,
      ccw: this.cfg.ccw,
      unit_cfg: this.cfg.unit,
      fov: this.cfg.fov,
      pose: this.pose,
      map_pts: this.mapPts,
      keep_ms: keepMs,
      bins,
      scan,
      raw: this.raw.slice(),
    };
  }
}

/** GET /api/radar → status; POST {offset, ccw, unit} → set, then status. */
export function radarApi(radar) {
  return async function handle(req, res) {
    if (req.method === 'GET') { reply(res, 200, radar.status()); return; }
    if (req.method !== 'POST') { reply(res, 405, { error: 'use GET or POST' }); return; }
    try {
      reply(res, 200, radar.setCfg(await readBody(req)));
    } catch (e) {
      reply(res, 400, { error: String(e.message || e) });
    }
  };
}
