#!/usr/bin/env node
/**
 * ESP32 DAC bench — Node.js.
 *
 * Type two percentages in the browser, press START, and they stream to the
 * ESP32's DACs at 20 Hz until you press STOP.
 *
 *     GPIO25 (DAC1)  and  GPIO26 (DAC2)   analog, 0% = idle, 100% = --v-max
 *     GPIO23                              digital ENABLE: 0 at rest, 1 on START
 *
 * Five pages, one WebSocket:
 *     /        hub — live status and links
 *     /manual  type the two percentages by hand
 *     /drive   hold W / A / S / D, with an editable value table
 *     /vision  camera; finds the road and shows the steering error
 *     /follow  the same detector, driving the motors, recording the run
 *     /tune    drop a run log in, get numbers back out
 *     /sonar   spin the HC-SR04 and map the room
 *     /obstacle  the forward HC-SR04: stop, wait, carry on
 *     /pins    every spare pin, 0-255 by hand
 *
 * Two ways to reach the board:
 *
 *     node server.js --esp 192.168.1.42     wifi  (flash esp32/ws_dac)
 *     node server.js --serial COM5          USB   (flash esp32/throttle_dac_2ch)
 *     node server.js --esp sim --fake       neither: simulated board
 *
 * The page and its WebSocket share one port, so there is nothing to configure
 * in the browser — open the URL this prints.
 *
 * Why go through Node at all instead of talking to the ESP32 from the page?
 * Because the board's 300 ms watchdog needs a steady 20 Hz stream, and a
 * browser tab that is backgrounded, throttled or reloading will not deliver
 * one. Node holds that stream, clamps every value, and drops to idle the
 * moment the browser goes away.
 */

import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import * as esp from './esp.js';
import { Bench } from './bench.js';
import { WsTransport, SerialTransport } from './transports.js';
import { Esp32WsSim } from './esp32ws_sim.js';
import { FollowLog, LOG_DIR } from './follow_log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOLLOW_FILE = path.join(HERE, 'follow.json');

/**
 * The follow page's sliders and calibration, saved server-side.
 *
 * Same reasoning as presets.json: numbers you found by driving the robot
 * should not depend on which browser or which laptop you drove it from, and
 * they should still be there after a reload in the middle of a session.
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
  // 0.0.0.0 by default: every interface, so a phone on the same wifi can reach
  // it without anything being configured. There is no authentication, which is
  // why it says so on startup.
  const args = { host: '0.0.0.0', http: 8090, esp: null, serial: null,
                 vMax: esp.V_MAX, fake: false, list: false,
                 https: false, cert: null, key: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fake') args.fake = true;
    else if (a === '--list') args.list = true;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--http') args.http = parseInt(argv[++i], 10);
    else if (a === '--esp') args.esp = argv[++i];
    else if (a === '--serial' || a === '--port') args.serial = argv[++i];
    else if (a === '--v-max') args.vMax = parseFloat(argv[++i]);
    else if (a === '--https') args.https = true;
    else if (a === '--cert') { args.cert = argv[++i]; args.https = true; }
    else if (a === '--key') { args.key = argv[++i]; args.https = true; }
    else if (a === '--help' || a === '-h') {
      console.log(`usage: node server.js [options]

  --esp <host>      ESP32 over wifi: IP, hostname, or a full ws:// URL.
                    Default port 81.  e.g. --esp 192.168.1.42
                                           --esp esp32-dac.local
  --serial <path>   ESP32 over USB instead (COM5, /dev/ttyUSB0).
                    Auto-detected if you pass --serial with no value.
  --fake            simulated board, no hardware. Pairs with --esp or --serial.
  --http <n>        web port (default 8090)
  --host <addr>     bind address (default 0.0.0.0 — every interface)
  --https           serve over TLS, so the camera works from other devices.
                    Makes a self-signed certificate in node/certs/ the first
                    time, then reuses it.
  --cert <file>     use your own certificate instead (implies --https)
  --key <file>      ...and its private key
  --v-max <v>       what 100% means, in volts (default ${esp.V_MAX})
  --list            list serial ports and exit`);
      process.exit(0);
    }
  }
  return args;
}

/** "192.168.1.42" | "esp32-dac.local" | "ws://host:81/" -> ws URL */
function espUrl(hostArg) {
  if (/^wss?:\/\//i.test(hostArg)) return hostArg;
  const [host, port] = hostArg.split(':');
  return `ws://${host}:${port || 81}/`;
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

/**
 * A certificate, so `getUserMedia` will talk to us.
 *
 * Browsers only give a page the camera on localhost or over HTTPS, which means
 * /vision and /follow are dead from a phone on plain http however open the
 * server is. A self-signed certificate fixes that — the browser will warn once
 * about it not being trusted, which is correct: it is not.
 *
 * Generated with openssl because writing an X.509 encoder to avoid a one-line
 * shell call would be a strange way to spend an afternoon. If openssl is not
 * there, say so and how to fix it rather than failing obscurely.
 */
function loadTls(args) {
  const dir = path.join(HERE, 'certs');
  const certFile = args.cert || path.join(dir, 'cert.pem');
  const keyFile = args.key || path.join(dir, 'key.pem');

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  }
  if (args.cert || args.key) {
    throw new Error(`certificate not found: ${args.cert || args.key}`);
  }

  // Name every address we have, so the certificate matches whichever one you
  // type in rather than adding a second warning about the hostname.
  const alt = ['DNS:localhost', 'IP:127.0.0.1',
               ...localAddresses().map((a) => `IP:${a.address}`)].join(',');
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-subj', '/CN=esp32-bench', '-addext', `subjectAltName=${alt}`,
      '-keyout', keyFile, '-out', certFile,
    ], { stdio: 'ignore' });
  } catch {
    throw new Error('--https needs a certificate and openssl could not make one.\n'
      + `  Make one yourself and put it in ${dir}:\n`
      + `    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \\\n`
      + `      -subj "/CN=esp32-bench" -keyout key.pem -out cert.pem\n`
      + '  ...or pass --cert and --key.');
  }
  console.log(`made a self-signed certificate in ${dir}`);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

async function listPorts() {
  const { SerialPort } = await import('serialport');
  return SerialPort.list();
}

async function pickPort() {
  const ports = await listPorts();
  if (ports.length === 0) throw new Error('no serial ports found');
  // Prefer the usual USB-UART bridges: CP210x, CH340, FTDI.
  const usb = ports.filter((p) => /wch|silicon|ftdi|prolific|cp210|ch34/i.test(
    `${p.manufacturer || ''} ${p.friendlyName || ''}`));
  const chosen = (usb[0] || ports[0]).path;
  console.log(`serial port auto-detected: ${chosen}`);
  if (ports.length > 1) {
    console.log('   others:', ports.map((p) => p.path)
      .filter((p) => p !== chosen).join(', '));
    console.log('   use --serial <path> to pick a different one');
  }
  return chosen;
}

async function buildTransport(args) {
  // Serial only when explicitly asked for; wifi is the default.
  if (args.serial !== null) {
    if (args.fake) return new SerialTransport('fake', true);
    const p = args.serial || await pickPort();
    return new SerialTransport(p, false);
  }

  if (args.fake) {
    const sim = new Esp32WsSim({ port: 8181, host: '127.0.0.1', vMax: args.vMax });
    await sim.ready;
    console.log(`simulated ESP32 listening on ${sim.url} — nothing is driven`);
    const tx = new WsTransport(sim.url);
    tx.label = 'SIMULATED esp32 (wifi)';
    tx._sim = sim;
    return tx;
  }

  if (!args.esp) {
    throw new Error('tell me where the board is: --esp <ip>, --serial <path>, '
                  + 'or --fake to try it with no hardware');
  }
  return new WsTransport(espUrl(args.esp));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const ports = await listPorts();
    if (!ports.length) console.log('no serial ports found');
    for (const p of ports) {
      console.log(`${p.path.padEnd(16)} ${p.friendlyName || p.manufacturer || ''}`);
    }
    return;
  }

  const transport = await buildTransport(args);
  const bench = new Bench({ transport, vMax: args.vMax });
  await bench.open();

  // The persisted tuning. Declared here rather than next to the socket because
  // the HTTP handler below closes over it too, and a `let` read before its own
  // declaration throws rather than reading undefined.
  let followCfg = loadFollowCfg();

  // ── static pages ──────────────────────────────────────────────────
  const PAGES = {
    '/':       'home.html',    // hub: status + links to everything
    '/manual': 'manual.html',  // type the two percentages by hand
    '/drive':  'drive.html',   // hold W / A / S / D
    '/vision': 'vision.html',  // camera -> road detection, look and tune
    '/follow': 'follow.html',  // the same detector, driving
    '/tune':   'tune.html',    // read a run back and say what to change
    '/sonar':  'sonar.html',   // the spinning HC-SR04, as a map
    '/obstacle': 'obstacle.html',  // the forward HC-SR04, as a stop
    '/pins':   'pins.html',    // the spare pins, by hand
    '/setup':  'setup.html',   // what to measure, in order, and where it goes
  };

  // The two pages that see the road share their code rather than each keeping
  // a copy, so tuning on /vision is tuning what /follow drives with.
  //
  // wheels.js is the same idea one level down: the per-wheel trim is a property
  // of the robot, not of a page, so every page reads it from one file and shows
  // the same numbers.
  const SCRIPTS = { '/road.js': 'road.js', '/pilot.js': 'pilot.js',
                    '/analyse.js': 'analyse.js', '/sonar.js': 'sonar.js',
                    '/wheels.js': 'wheels.js' };

  const onRequest = (req, res) => {
    const url = (req.url || '/').split('?')[0];

    // The runs, so /tune can offer the last lap instead of making you find it
    // in a file dialog. Read-only, and the name is checked rather than joined
    // blindly — this server has no authentication and sits on a shared wifi.
    if (url === '/logs' || url.startsWith('/logs/')) {
      const name = url === '/logs' ? '' : decodeURIComponent(url.slice(6));
      const json = (body) => {
        const b = Buffer.from(JSON.stringify(body));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                             'Content-Length': b.length, 'Cache-Control': 'no-store' });
        res.end(b);
      };
      try {
        if (!name) {
          const files = fs.existsSync(LOG_DIR)
            ? fs.readdirSync(LOG_DIR).filter((f) => /^follow-[\w-]+\.json$/.test(f))
              .sort().reverse()
            : [];
          json({ files });
        } else if (!/^follow-[\w-]+\.json$/.test(name)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
        } else {
          const body = fs.readFileSync(path.join(LOG_DIR, name));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                               'Content-Length': body.length, 'Cache-Control': 'no-store' });
          res.end(body);
        }
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
      return;
    }

    // The wheel trim, for the two pages that have no socket. Read-only: the
    // only writer is the follow_cfg command, so there is one code path that
    // can change the robot and it is the one that is already tested.
    if (url === '/api/wheels') {
      const b = Buffer.from(JSON.stringify(followCfg || {}));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                           'Content-Length': b.length, 'Cache-Control': 'no-store' });
      res.end(b);
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
  };

  const server = args.https
    ? https.createServer(loadTls(args), onRequest)
    : http.createServer(onRequest);

  // ── browser websocket, same port ──────────────────────────────────
  const wss = new WebSocketServer({ server });
  const runLog = new FollowLog();

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    bench.clientJoined();
    console.log(`browser connected: ${peer}`);

    const send = (extra = {}) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'status', ...extra, ...bench.snapshot(),
          follow_cfg: followCfg,
          log: { active: runLog.active, file: runLog.file, rows: runLog.rows },
        }));
      }
    };
    const pusher = setInterval(send, 100);
    send();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.cmd) {
        case 'set':
          bench.setValues(msg.p25, msg.p26);
          break;
        case 'keys':
          bench.setKeys(msg.keys);
          break;
        case 'presets':
          bench.setPresets(msg.presets);
          console.log('presets updated:', JSON.stringify(bench.presets));
          break;
        case 'level':
          bench.setLevel(msg.level);
          console.log(`level ${bench.level} %`);
          break;
        case 'start':
          if ('p25' in msg || 'p26' in msg) bench.setValues(msg.p25, msg.p26);
          bench.start();
          console.log(`START  25=${bench.p25}%  26=${bench.p26}%  enable=1`);
          break;
        case 'stop':
          bench.stop();
          console.log('STOP  enable=0');
          break;
        case 'idle':
          bench.idle();
          break;

        // ── follow page ──
        // One command per frame, carrying what the vision loop decided. The
        // server does not steer; it clamps, streams and times out.
        case 'follow':
          bench.setAuto(msg.p25, msg.p26, msg.reason);
          break;
        case 'scan':
          bench.setScan(msg.spin);
          break;
        case 'pin':
          bench.setPin(msg.gpio, msg.val);
          break;
        case 'follow_cfg':
          followCfg = saveFollowCfg({ ...followCfg, ...(msg.cfg || {}) });
          break;
        case 'log_start': {
          const file = runLog.start({ ...(msg.meta || {}), vmax: bench.vMax,
                                      level: bench.level });
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
              + `${done.summary.rows} rows, ${done.summary.duration_s} s, `
              + `${done.summary.lost_events} lost`);
          }
          break;
        }
        default:
          return;
      }
      // `ack` marks this status as the direct answer to that command, so a
      // client can tell it apart from the 10 Hz background push.
      send({ ack: msg.cmd });
    });

    ws.on('close', () => {
      clearInterval(pusher);
      bench.clientLeft();
      // A closed tab is the end of the run whether or not anyone pressed the
      // button, and a run that ends by the laptop being shut is exactly the
      // one worth keeping.
      if (bench.clients === 0 && runLog.active) {
        const done = runLog.stop();
        if (done) console.log(`saved on disconnect: ${path.basename(done.file)}`);
      }
      console.log(`browser gone: ${peer} -> idle`);
    });
    ws.on('error', () => ws.close());
  });

  server.listen(args.http, args.host, () => {
    const scheme = args.https ? 'https' : 'http';
    const shown = args.host === '0.0.0.0' ? 'localhost' : args.host;
    const base = `${scheme}://${shown}:${args.http}`;
    console.log(`\nESP32 DAC bench:  ${base}/`);
    console.log(`  manual page:    ${base}/manual`);
    console.log(`  keyboard drive: ${base}/drive`);
    console.log(`  camera / road:  ${base}/vision`);
    console.log(`  follow the road:${base}/follow`);
    console.log(`  read a run back:${base}/tune`);
    console.log(`  360° sonar map: ${base}/sonar`);
    console.log(`  obstacle stop:  ${base}/obstacle`);
    console.log(`  spare pins:     ${base}/pins`);

    // "0.0.0.0" is not something anyone can type into a phone, so print what
    // they can. Every interface, every address, ready to copy.
    if (args.host === '0.0.0.0') {
      const nets = localAddresses();
      if (nets.length) {
        console.log('\nreachable from this network at:');
        for (const n of nets) {
          console.log(`  ${scheme}://${n.address}:${args.http}/`.padEnd(38) + `(${n.name})`);
        }
      } else {
        console.log('\nno network interface found — only localhost will work');
      }
    }

    console.log(`\nboard: ${transport.label}`);
    console.log(`0% = ${esp.V_IDLE} V (idle)   100% = ${args.vMax} V   enable pin: GPIO23`);
    if (args.host === '0.0.0.0') {
      console.log('NOTE: reachable by anyone on this network, with no authentication.');
    }
    if (!args.https) {
      // The single most common "it does not work on my phone" — and it is not
      // a networking problem, so no amount of opening ports will fix it.
      console.log('NOTE: browsers only give the camera to localhost or https, so '
        + '/vision and\n      /follow have no camera from another device. '
        + 'Restart with --https for that.');
    }
  });

  // ── shutdown ──────────────────────────────────────────────────────
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nshutting down — outputs to idle');
    for (const c of wss.clients) c.close();
    await bench.close();
    if (transport._sim) await transport._sim.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err.message || err);
  if (/cannot find module 'serialport'/i.test(String(err))) {
    console.error('run `npm install` first, or use --fake to try the UI without hardware');
  }
  process.exit(1);
});
