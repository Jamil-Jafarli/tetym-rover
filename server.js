#!/usr/bin/env node
/**
 * Differential-drive rover — Raspberry Pi -> Creality mainboard, over USB.
 *
 * One page, one serial port. Open it, hold W A S D, and G-code goes out for
 * as long as the key is down:
 *
 *     forward   G1 X-5 Y5 F6000            left   G1 X5 Y5 F6000
 *     back      G1 X5 Y-5 F6000            right  G1 X-5 Y-5 F6000
 *
 * X and Y are the left and right wheels of a differential drive, mounted
 * mirror-image, so a direction is a pair of wheel signs rather than one axis —
 * see DIRECTIONS in marlin.js, which is the single definition the page, the
 * API and the tests all read.
 *
 *     node server.js                   find the printer, open it, serve the page
 *     node server.js --port /dev/ttyUSB0
 *     node server.js --no-connect      serve the page, leave the port alone
 *     node server.js --list            list serial ports and exit
 *
 * On a Pi the Creality board's CH340 comes up as /dev/ttyUSB0. If opening it
 * is refused, the user is not in the `dialout` group:
 *
 *     sudo usermod -aG dialout $USER   # then log out and back in
 *
 * There is no authentication. It binds every interface by default so a phone
 * on the same wifi can drive the machine, and says so on startup.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MarlinLink, Jogger, bestPort, explainSerialError,
         DEFAULT_BAUD } from './marlin.js';
import { marlinApi } from './marlin_http.js';
import { FollowLog, LOG_DIR } from './follow_log.js';
import { Rover } from './rover.js';


const HERE = path.dirname(fileURLToPath(import.meta.url));

const FOLLOW_FILE = path.join(HERE, 'follow.json');

/**
 * The road-following sliders and the wheel trim, saved server-side.
 *
 * Numbers you found by driving the rover should not depend on which browser
 * you drove it from, and they should still be there after a reload in the
 * middle of a session. Every page reads them from here rather than keeping a
 * copy, so a value measured on one page is true on all of them.
 */
function loadFollowCfg() {
  try { return JSON.parse(fs.readFileSync(FOLLOW_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

function saveFollowCfg(cfg) {
  try { fs.writeFileSync(FOLLOW_FILE, JSON.stringify(cfg, null, 2)); }
  catch (err) { console.warn('could not save follow.json:', err.message); }
  return cfg;
}


function parseArgs(argv) {
  const args = { host: '0.0.0.0', http: 8090, port: null,
                 baud: DEFAULT_BAUD, connect: true, list: false, trace: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--no-connect') args.connect = false;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--http') args.http = parseInt(argv[++i], 10);
    else if (a === '--port' || a === '--serial' || a === '--marlin') args.port = argv[++i];
    else if (a === '--baud') args.baud = parseInt(argv[++i], 10);
    else if (a === '--trace') args.trace = true;
    else if (a === '--help' || a === '-h') {
      console.log(`usage: node server.js [options]

  --port <path>   the printer's serial device (default: auto-detected).
                  On a Raspberry Pi with the board on USB this is
                  /dev/ttyUSB0.
  --baud <n>      serial speed (default ${DEFAULT_BAUD})
  --no-connect    serve the page without opening the port. Use this when the
                  printer is not plugged in yet — the page has a Connect
                  button and a port list of its own.
  --http <n>      web port (default 8090)
  --host <addr>   bind address (default 0.0.0.0 — every interface)
  --trace         print every serial line, in and out, with a timestamp.
                  Hold a key for a few seconds with this on and the output is
                  the whole story: what went to the board and what came back.
  --list          list serial ports and exit`);
      process.exit(0);
    }
  }
  return args;
}

/**
 * Every address this machine can actually be reached on.
 *
 * Printed on startup because "0.0.0.0" is not something you can type into a
 * phone. Binding every interface is only useful if you know which one to use.
 */
function localAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const { SerialPort } = await import('serialport');
    const ports = await SerialPort.list();
    if (!ports.length) console.log('no serial ports found');
    for (const p of ports) {
      console.log(`${p.path.padEnd(16)} ${p.friendlyName || p.manufacturer || ''}`);
    }
    return;
  }

  const link = new MarlinLink();
  const jog = new Jogger(link);
  const api = marlinApi({ link, jog });

  // --trace mirrors the link's log to the console. The page shows the same
  // thing, but a terminal can be scrolled back, piped and pasted.
  if (args.trace) {
    const t0 = Date.now();
    let seen = 0;
    setInterval(() => {
      const { lines, seq } = link.logSince(seen);
      seen = seq;
      for (const e of lines) {
        const at = ((e.t * 1000 - t0) / 1000).toFixed(3).padStart(8);
        const arrow = { tx: '-->', rx: '<--', error: ' !!', sys: '  ·' }[e.kind] || '   ';
        console.log(`[${at}] ${arrow} ${e.text}`);
      }
    }, 50).unref();
  }

  // ── pages ─────────────────────────────────────────────────────────
  const PAGES = {
    '/':       'gcode.html',   // hold WASD, G-code goes out
    '/gcode':  'gcode.html',
    '/vision': 'vision.html',  // camera -> line detection, look and tune
    '/follow': 'follow.html',  // the same detector, driving
    '/tune':   'tune.html',    // read a run back and say what to change
  };

  // /vision and /follow share their detector rather than each keeping a copy,
  // so tuning on /vision is tuning what /follow drives with. wheels.js is the
  // same idea one level down: the per-wheel trim is a property of the rover,
  // not of a page.
  const SCRIPTS = { '/road.js': 'road.js', '/pilot.js': 'pilot.js',
                    '/analyse.js': 'analyse.js', '/wheels.js': 'wheels.js',
                    '/sonar.js': 'sonar.js' };

  let followCfg = loadFollowCfg();
  const runLog = new FollowLog();

  const json = (res, body) => {
    const b = Buffer.from(JSON.stringify(body));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                         'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  };

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    // The saved trim, for pages with no socket of their own — /vision is the
    // one that matters. Read-only: the only writer is the follow_cfg command,
    // so there is one code path that can change the rover and it is the one
    // that is already tested.
    if (url === '/api/wheels') { json(res, followCfg || {}); return; }

    // The runs, so /tune can offer the last lap instead of making you find it
    // in a file dialog. Read-only, and the name is checked rather than joined
    // blindly — this server has no authentication and sits on a shared wifi.
    if (url === '/logs' || url.startsWith('/logs/')) {
      const name = url === '/logs' ? '' : decodeURIComponent(url.slice(6));
      try {
        if (!name) {
          const files = fs.existsSync(LOG_DIR)
            ? fs.readdirSync(LOG_DIR).filter((f) => /^follow-[\w-]+\.json$/.test(f))
                .sort().reverse()
            : [];
          json(res, { files });
        } else if (!/^follow-[\w-]+\.json$/.test(name)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
        } else {
          const body = fs.readFileSync(path.join(LOG_DIR, name));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                               'Content-Length': body.length,
                               'Cache-Control': 'no-store' });
          res.end(body);
        }
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
      return;
    }

    if (url.startsWith('/api/marlin/')) {
      api(req, res, url).catch((err) => {
        if (res.headersSent) return;
        const body = Buffer.from(JSON.stringify({ error: String(err.message || err) }));
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8',
                             'Content-Length': body.length });
        res.end(body);
      });
      return;
    }

    const page = PAGES[url], script = SCRIPTS[url];
    if (!page && !script) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const body = fs.readFileSync(path.join(HERE, 'public', page || script));
    res.writeHead(200, {
      'Content-Type': page ? 'text/html; charset=utf-8'
                           : 'text/javascript; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  // ── the road-following pages' socket ──────────────────────────────
  // /vision needs nothing but the page and /api/wheels; /follow drives, so it
  // gets a socket. Same port as the page, so there is nothing to configure in
  // the browser.
  const rover = new Rover({ link, jog });
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    rover.clientJoined();
    console.log(`browser connected: ${peer}`);

    const send = (extra = {}) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({
        type: 'status', ...extra, ...rover.snapshot(),
        follow_cfg: followCfg,
        log: { active: runLog.active, file: runLog.file, rows: runLog.rows },
      }));
    };
    const pusher = setInterval(send, 100);
    send();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.cmd) {
        case 'start':
          rover.start();
          console.log('START — following');
          break;
        case 'stop':
        case 'idle':
          rover.stop(msg.cmd === 'idle' ? 'idle' : 'stopped');
          console.log('STOP');
          break;

        // One command per frame, carrying what the vision loop decided. The
        // server does not steer; it clamps, paces and stops.
        case 'follow':
          rover.setAuto(msg.p25, msg.p26, msg.reason);
          break;

        case 'follow_cfg':
          followCfg = saveFollowCfg({ ...followCfg, ...(msg.cfg || {}) });
          break;

        case 'log_start': {
          const file = runLog.start({ ...(msg.meta || {}),
                                      max_feed: rover.maxFeed,
                                      chunk_ms: rover.chunkMs });
          console.log(`recording: ${path.basename(file)}`);
          break;
        }
        case 'log':
          runLog.add(msg.rows);
          break;
        case 'log_stop': {
          const done = runLog.stop();
          if (done) {
            console.log(`saved: ${path.basename(done.file)}  `
              + `${done.summary.rows} rows, ${done.summary.duration_s} s`);
          }
          break;
        }
        default:
          return;
      }
      send({ ack: msg.cmd });
    });

    ws.on('close', () => {
      clearInterval(pusher);
      rover.clientLeft();
      if (rover.clients === 0 && runLog.active) {
        const done = runLog.stop();
        if (done) console.log(`saved on disconnect: ${path.basename(done.file)}`);
      }
      console.log(`browser gone: ${peer} -> stopped`);
    });
    ws.on('error', () => ws.close());
  });

  await new Promise((res) => server.listen(args.http, args.host, res));

  const shown = args.host === '0.0.0.0' ? 'localhost' : args.host;
  const base = `http://${shown}:${args.http}`;
  console.log(`\nRover control:  ${base}/`);
  console.log(`  drive by hand:  ${base}/`);
  console.log(`  camera / line:  ${base}/vision`);
  console.log(`  follow a line:  ${base}/follow`);
  console.log(`  read a run back:${base}/tune`);
  if (args.host === '0.0.0.0') {
    const nets = localAddresses();
    if (nets.length) {
      console.log('\nreachable from this network at:');
      for (const n of nets) {
        console.log(`  http://${n.address}:${args.http}/`.padEnd(34) + `(${n.name})`);
      }
      console.log('NOTE: reachable by anyone on this network, with no authentication.');
    } else {
      console.log('no network interface found — only localhost will work');
    }
  }

  // ── the printer ───────────────────────────────────────────────────
  // After listen(), so the URL is on screen while the board spends its two and
  // a half seconds rebooting from the DTR pulse that opening the port causes.
  if (args.connect) {
    const chosen = args.port || await bestPort();
    if (!chosen) {
      console.log('\nno USB serial device found — plug the printer in and press '
                + 'Connect on the page.\n  (--port names one explicitly, if the '
                + 'board is on the GPIO UART rather than USB.)');
    } else {
      try {
        await link.connect(chosen, args.baud);
        console.log(`\nprinter: ${link.path} @ ${link.baud}`
          + (link.firmware ? `\n         ${link.firmware.slice(0, 78)}` : ''));
        if (!link.sawRx) {
          console.log('         ...but the board has not said anything. Is the '
                    + 'printer switched on?');
        }
      } catch (err) {
        console.log(`\ncould not open ${chosen}: ${err.message || err}`);
        for (const line of explainSerialError(err, chosen)) console.log('  ' + line);
        console.log('\nThe page is still up — fix it, then press Connect.');
      }
    }
  } else {
    console.log('\nprinter: not opened (--no-connect) — press Connect on the page');
  }

  // ── shutdown ──────────────────────────────────────────────────────
  // Stop feeding the stream, drop anything queued, and give the one move that
  // is already on the board a moment to finish before the port closes. There
  // is nothing to cancel beyond that: a chunk is only ever sent once its
  // predecessor is done, so at most one move is outstanding.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nshutting down — letting the last move finish');
    jog.stop();
    rover.stop('shutting down');
    for (const c of wss.clients) c.close();
    if (link.connected) {
      link.drain();
      await link.whenDrained(3000);
      await link.disconnect();
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err.message || err);
  if (/cannot find module 'serialport'/i.test(String(err))) {
    console.error('run `npm install` first');
  }
  process.exit(1);
});
