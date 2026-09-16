#!/usr/bin/env node
/**
 * A lidar that is not there: a small room swept ten times a second and sent
 * to the radar's port the way a real one might be — for watching the
 * dashboard's radar move with no hardware on the desk.
 *
 *   node test/fake_lidar.mjs                        UDP, JSON, to 127.0.0.1:8443
 *   node test/fake_lidar.mjs --via tcp --fmt ld06   the LD06's own packets, over TCP
 *   node test/fake_lidar.mjs --via ws --fmt json
 *   node test/fake_lidar.mjs --via http --fmt text --host 192.168.123.27
 *
 *   --via   udp | tcp | tls | ws | wss | http
 *   --fmt   json | text | ld06
 *   --hz    sweeps per second (default 10)
 */
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import WebSocket from 'ws';
import { ld06Encode } from '../radar.js';

const args = { host: '127.0.0.1', port: 8443, via: 'udp', fmt: 'json', hz: 10 };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  if (!(k in args)) { console.error(`unknown option ${process.argv[i]}`); process.exit(2); }
  args[k] = typeof args[k] === 'number' ? Number(process.argv[++i]) : process.argv[++i];
}

// The room, in metres, with the rover at the origin facing +y: four walls,
// and a round post that drifts from side to side in front of it.
const WALL = { x0: -1.2, x1: 2.0, y0: -0.8, y1: 2.5 };
function rangeMm(deg, t) {
  const a = deg * Math.PI / 180, dx = Math.sin(a), dy = Math.cos(a);
  let best = Infinity;
  if (dx > 1e-9) best = Math.min(best, WALL.x1 / dx);
  if (dx < -1e-9) best = Math.min(best, WALL.x0 / dx);
  if (dy > 1e-9) best = Math.min(best, WALL.y1 / dy);
  if (dy < -1e-9) best = Math.min(best, WALL.y0 / dy);
  const bx = 0.45 * Math.sin(t / 1.5), by = 0.7, br = 0.16;
  const b = dx * bx + dy * by, disc = b * b - (bx * bx + by * by - br * br);
  if (disc >= 0 && b - Math.sqrt(disc) > 0) best = Math.min(best, b - Math.sqrt(disc));
  return best * 1000 * (1 + (Math.random() - 0.5) * 0.01);
}

const TICK = 50;          // ms
const STEP = 0.8;         // degrees between returns, as an LD06
const t0 = Date.now();
let angle = 0;

/** The returns since the last tick, a multiple of twelve (one LD06 packet). */
function sweep() {
  const t = (Date.now() - t0) / 1000;
  const n = Math.max(12, Math.round(args.hz * 360 * TICK / 1000 / STEP / 12) * 12);
  const pts = [];
  for (let k = 0; k < n; k++) {
    pts.push([angle, rangeMm(angle, t)]);
    angle = (angle + STEP) % 360;
  }
  return pts;
}

function encode(pts) {
  if (args.fmt === 'ld06') {
    const parts = [];
    for (let i = 0; i < pts.length; i += 12) {
      const c = pts.slice(i, i + 12);
      parts.push(ld06Encode(c[0][0], c[c.length - 1][0], c.map((p) => p[1]),
                            args.hz * 360, Date.now()));
    }
    return Buffer.concat(parts);
  }
  if (args.fmt === 'text') {
    return Buffer.from(pts.map(([a, d]) => `${a.toFixed(1)},${Math.round(d)}`).join('\n') + '\n');
  }
  return Buffer.from(JSON.stringify({ points: pts.map(([a, d]) => [+a.toFixed(1), Math.round(d)]) }));
}

// ── the transport ───────────────────────────────────────────────────
let send = () => false;
const where = `${args.via}://${args.host}:${args.port}`;

if (args.via === 'udp') {
  const s = dgram.createSocket('udp4');
  send = (buf) => { s.send(buf, args.port, args.host); return true; };
} else if (args.via === 'tcp' || args.via === 'tls') {
  let sock = null;
  const open = () => {
    const s = args.via === 'tls'
      ? tls.connect({ host: args.host, port: args.port, rejectUnauthorized: false })
      : net.connect(args.port, args.host);
    s.on(args.via === 'tls' ? 'secureConnect' : 'connect', () => { sock = s; console.log(`connected ${where}`); });
    s.on('error', (e) => console.log(`${where}: ${e.message}`));
    s.on('close', () => { sock = null; setTimeout(open, 1000); });
  };
  open();
  send = (buf) => !!(sock && sock.write(buf) !== undefined);
} else if (args.via === 'ws' || args.via === 'wss') {
  let ws = null;
  const open = () => {
    const w = new WebSocket(`${where}/`, { rejectUnauthorized: false });
    w.on('open', () => { ws = w; console.log(`connected ${where}`); });
    w.on('error', (e) => console.log(`${where}: ${e.message}`));
    w.on('close', () => { ws = null; setTimeout(open, 1000); });
  };
  open();
  send = (buf) => { if (!ws) return false; ws.send(buf); return true; };
} else if (args.via === 'http') {
  send = (buf) => {
    fetch(`http://${args.host}:${args.port}/scan`, { method: 'POST', body: buf })
      .catch((e) => console.log(`${where}: ${e.message}`));
    return true;
  };
} else {
  console.error(`--via: udp, tcp, tls, ws, wss or http — not ${args.via}`);
  process.exit(2);
}

let sent = 0, bytes = 0;
setInterval(() => {
  const buf = encode(sweep());
  if (send(buf)) { sent++; bytes += buf.length; }
}, TICK);
setInterval(() => {
  console.log(`${where} ${args.fmt}: ${sent} messages, ${(bytes / 1024).toFixed(0)} KB`);
}, 2000);
console.log(`fake lidar → ${where} as ${args.fmt}, ${args.hz} sweeps/s — Ctrl+C to stop`);
