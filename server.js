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
 * The camera is this machine's — a USB webcam on the Raspberry Pi the robot
 * carries — not the browser's. See camera.js.
 *
 * The pages, one WebSocket:
 *     /        hub — live status and links
 *     /dashboard  everything at once: speed, volts, ESP32 + Pi, camera, QR, map
 *     /manual  type the two percentages by hand
 *     /drive   hold W / A / S / D, with an editable value table
 *     /vision  camera; finds the road and shows the steering error
 *     /follow  the same detector, driving the motors, recording the run
 *     /tune    drop a run log in, get numbers back out
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
 *
 * ── the other machine ──
 *
 * The same rover also exists as a differential drive on a Creality mainboard,
 * driven by G-code over USB instead of by two DAC pins. It is the same robot
 * and the same road-following code; only the thing at the far end of the wire
 * changes. --marlin picks it:
 *
 *     node server.js --marlin                 find the printer, open it, serve
 *     node server.js --marlin --port /dev/ttyUSB0
 *     node server.js --marlin --no-connect    serve the page, leave the port
 *
 *     /        hold W A S D, G-code goes out for as long as the key is down
 *     /vision /follow /tune   exactly as above — same detector, same logs
 *
 * X and Y are the left and right wheels, mounted mirror-image, so a direction
 * is a pair of wheel signs rather than one axis — see DIRECTIONS in marlin.js,
 * the single definition the page, the API and the tests all read.
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
import { Camera, CAMERA_DEFAULTS, PLACEHOLDER_JPEG } from './camera.js';
import { QrReader } from './qr.js';
import { RpiStats } from './rpi.js';
import { loadShared } from './shared.js';
import { MarlinLink, Jogger, bestPort, explainSerialError,
         DEFAULT_BAUD } from './marlin.js';
import { marlinApi } from './marlin_http.js';
import { Rover } from './rover.js';
import { LidarRelay, routeUpgrades } from './lidar_relay.js';
import { LidarSim } from './lidar_sim.js';
import { advertise } from './lidar_discovery.js';
import { startCompetition } from './plc_run.js';

// The competition field, straight out of the module the pages load — one copy
// of the graph, served to anything that asks for it. See public/field.js.
// FIELDS holds both: the competition field and the practice one (--field).
const { FIELDS, fieldState, fieldSee, fieldMission, fieldClearMission, fieldStatus } =
  loadShared('field.js', ['FIELDS', 'fieldState', 'fieldSee', 'fieldMission',
                          'fieldClearMission', 'fieldStatus']);

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
                 // --marlin swaps the ESP32 for a Creality mainboard: same
                 // rover, same pages, G-code over USB instead of two DACs.
                 marlin: false, port: null, baud: DEFAULT_BAUD,
                 connect: true, trace: false,
                 https: false, cert: null, key: null,
                 // The webcam is plugged into this machine, so it is a server
                 // setting like the serial port is — not something a page asks
                 // for permission to use.
                 camera: CAMERA_DEFAULTS.device,
                 camWidth: CAMERA_DEFAULTS.width,
                 camHeight: CAMERA_DEFAULTS.height,
                 camFps: CAMERA_DEFAULTS.fps,
                 qr: true,
                 // The LiDAR map. The scanner is a phone running webscan, and it
                 // finds this server the way it used to find the webscan relay.
                 lidarRoom: 'default', lidarSim: false, webscan: null,
                 // Announce the relay over mDNS so the phone app lists it
                 // without an address being typed.
                 advertise: true,
                 // The competition: which field, and the factory automation
                 // system's PLC (EK TEKNİK ŞARTNAME, bölüm 2). Off unless asked
                 // for, so a laptop on the office wifi does not spray UDP at
                 // 192.168.100.100.
                 field: 'yarisma', plc: null, plcBind: null, plcSim: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fake') args.fake = true;
    else if (a === '--list') args.list = true;
    else if (a === '--marlin' || a === '--rover') args.marlin = true;
    else if (a === '--baud') args.baud = parseInt(argv[++i], 10);
    else if (a === '--no-connect') args.connect = false;
    else if (a === '--trace') args.trace = true;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--http') args.http = parseInt(argv[++i], 10);
    else if (a === '--esp') args.esp = argv[++i];
    else if (a === '--serial') args.serial = argv[++i];
    else if (a === '--port') { args.port = argv[++i]; args.marlin = true; }
    else if (a === '--v-max') args.vMax = parseFloat(argv[++i]);
    else if (a === '--camera') args.camera = argv[++i];
    else if (a === '--no-camera') args.camera = null;
    else if (a === '--no-qr') args.qr = false;
    else if (a === '--cam-fps') args.camFps = parseInt(argv[++i], 10);
    else if (a === '--cam-size') {
      const [w, h] = String(argv[++i] || '').split(/[x×*]/);
      if (w && h) { args.camWidth = parseInt(w, 10); args.camHeight = parseInt(h, 10); }
    }
    else if (a === '--lidar-room') args.lidarRoom = argv[++i];
    else if (a === '--lidar-sim') args.lidarSim = true;
    else if (a === '--webscan') args.webscan = argv[++i];
    else if (a === '--no-advertise') args.advertise = false;
    else if (a === '--field') args.field = argv[++i];
    else if (a === '--plc') {
      const next = argv[i + 1];
      args.plc = next && !next.startsWith('--') ? argv[++i] : true;
    }
    else if (a === '--plc-bind') args.plcBind = argv[++i];
    else if (a === '--plc-sim') {
      args.plcSim = true;
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) args.plcSimPort = Number(argv[++i]);
    }
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
  --https           serve over TLS. The camera no longer needs it — it is the
                    Pi's and is served as MJPEG over plain http. Makes a
                    self-signed certificate in node/certs/ the first time.
  --cert <file>     use your own certificate instead (implies --https)
  --key <file>      ...and its private key
  --v-max <v>       what 100% means, in volts (default ${esp.V_MAX})

  --marlin          drive a Creality mainboard over USB with G-code instead of
                    an ESP32's DACs. The road-following pages are the same;
                    /  becomes the hold-WASD G-code page. On a Pi the board's
                    CH340 comes up as /dev/ttyUSB0, auto-detected.
  --port <path>     the printer's serial device (implies --marlin; default:
                    auto-detected — /dev/ttyUSB0 on a Pi)
  --baud <n>        serial speed in --marlin mode (default ${DEFAULT_BAUD})
  --no-connect      --marlin: serve the page without opening the port. Use it
                    when the printer is not plugged in yet — the page has a
                    Connect button and a port list of its own.
  --trace           --marlin: print every serial line, in and out, timestamped.
                    Hold a key for a few seconds with this on and the output is
                    the whole story: what went out and what came back.
  --camera <dev>    the webcam on this machine (default ${CAMERA_DEFAULTS.device})
  --cam-size <WxH>  capture size (default ${CAMERA_DEFAULTS.width}x${CAMERA_DEFAULTS.height})
  --cam-fps <n>     capture rate (default ${CAMERA_DEFAULTS.fps})
  --no-camera       do not open a camera at all
  --no-qr           camera on, QR reader off
  --lidar-room <r>  the LiDAR relay room the pages show (default "default").
                    A scanner connects to ws://<this machine>:<port>/ws with
                    any room name; this only picks which one /dashboard draws
  --lidar-sim       stream a simulated LiDAR into that room — no phone needed
  --no-advertise    do not announce the relay over mDNS (_webscan._tcp). With it
                    on, the webscan phone app finds this server by itself
  --webscan <dir>   also serve a built webscan web app (apps/web/dist), so its
                    browser scanner streams straight here. The phone's camera
                    needs --https for that page
  --field <name>    yarisma (default, 18 × 10 m) or deneme (10 × 7 m)
  --plc [host:port] talk to the factory automation PLC over UDP: PAKET_TX once
                    a second, PAKET_RX back. Default 192.168.100.100:1515
  --plc-bind <ip>   send from this address — the robot's, 192.168.100.10
  --plc-sim [port]  run a PLC simulator in this server on 127.0.0.1:1515 and
                    talk to it: the whole mission, no field needed. /plc
  --list            list serial ports and exit`);
      process.exit(0);
    }
  }
  // Which machine is at the other end. --esp, --serial and --fake are the
  // ESP32's flags, so naming one of them says so; --marlin and --port are the
  // printer's. With neither, it is the printer: the ESP32 path has never had a
  // default — it used to refuse to start without being told where the board is
  // — while the printer is simply found on USB.
  if (!args.marlin && args.esp === null && args.serial === null && !args.fake) {
    args.marlin = true;
  }
  if (!FIELDS[args.field]) {
    console.error(`--field must be one of: ${Object.keys(FIELDS).join(', ')}`);
    process.exit(2);
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
 * A certificate, for anyone who wants TLS.
 *
 * This used to be load-bearing: browsers only give a page the camera on
 * localhost or over HTTPS, so /vision and /follow were dead from a phone on
 * plain http however open the server was, and a self-signed certificate was the
 * way round it. The camera is the Pi's now and arrives as an ordinary MJPEG
 * response, so nothing needs this — it is here for its own sake.
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

/**
 * The webcam, as two URLs: a stream and a still.
 *
 * The camera is plugged into this machine, not into either board, so both
 * servers serve it from the same code — /vision and /follow are the same pages
 * on both, and they get their pictures the same way whichever board is driving.
 *
 * Answers the request and returns true, or returns false for a URL that is not
 * the camera's.
 */
function serveCamera(camera, req, res, url) {
  // ── the webcam ────────────────────────────────────────────────────
  //
  // An <img> pointed at this is all a page needs to have live video, over
  // plain http, from any device on the wifi. No getUserMedia, no permission
  // prompt, no certificate — which is the entire reason the camera moved off
  // the phone and onto the Pi.
  if (url === '/camera/stream.mjpg') {
    const BOUND = 'esp32frame';
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUND}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
    });

    // Drop frames for a viewer that is not keeping up, rather than queueing
    // them. A phone on bad wifi otherwise builds a backlog that is still
    // being drained a minute later — a live view that is a minute behind is
    // worse than one that skipped a second, and the backlog is memory on a
    // machine that also has to hit a 20 Hz deadline.
    let busy = false;
    const part = (jpeg) => {
      res.write(`--${BOUND}\r\nContent-Type: image/jpeg\r\n`
              + `Content-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      if (!res.write('\r\n')) {          // socket buffer full: skip, don't queue
        busy = true;
        res.once('drain', () => { busy = false; });
      }
    };
    // Nothing to show yet — the camera is off, unplugged, or still opening.
    // Send the "no signal" frame and stay connected: when frames start
    // arriving the viewer gets them without having to reconnect, which is
    // what makes plugging the webcam in mid-session just work.
    if (!camera.frame) part(PLACEHOLDER_JPEG);
    const stop = camera.subscribe((jpeg) => {
      if (busy || res.writableEnded) return;
      part(jpeg);
    });
    const done = () => { stop(); if (!res.writableEnded) res.end(); };
    req.on('close', done);
    req.on('error', done);
    res.on('error', done);
    return true;
  }

  // One frame, for anything that wants a still: a page that only refreshes
  // now and then, curl, or a browser that has given up on the stream.
  if (url === '/camera/frame.jpg') {
    const real = camera.frame;
    const f = real || PLACEHOLDER_JPEG;
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': f.length,
      'Cache-Control': 'no-store',
      // So a caller can tell "the robot is looking at a dark room" from
      // "there is no camera", which the picture alone cannot say.
      'X-Camera': real ? 'live' : `placeholder: ${camera.err || 'no frame yet'}`,
    });
    res.end(f);
    return true;
  }
  return false;
}

/**
 * The runs, so /tune can offer the last lap instead of making you find it in a
 * file dialog. Read-only, and the name is checked rather than joined blindly —
 * this server has no authentication and sits on a shared wifi.
 *
 * Both machines write the same logs through the same FollowLog, so they read
 * them back through the same handler.
 */
function serveLogs(res, url) {
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
}

const WEBSCAN_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

/**
 * The LiDAR map over HTTP.
 *
 * `GET /api/lidar` is every relay room: who is sending, how fast, how stale.
 *
 * With --webscan, the files of a built webscan web app too — its browser
 * scanner then comes from the same origin whose /ws it streams to, which is the
 * whole integration: nothing in webscan is edited. Tried only after the rover's
 * own pages, so `/` is still the hub rather than webscan's index.
 *
 * Streamed, not read whole: the depth model's wasm is tens of megabytes, and a
 * synchronous read that size is a stall in the 20 Hz stream to the motors.
 */
function serveLidar(lidar, dist, res, url) {
  if (url === '/api/lidar') {
    const b = Buffer.from(JSON.stringify(lidar.info()));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                         'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
    return true;
  }
  if (!dist || url === '/') return false;
  let file;
  try { file = path.resolve(dist, '.' + decodeURIComponent(url)); } catch { return false; }
  // No authentication and a shared wifi: the name is resolved and then checked
  // to still be inside the directory, never joined and trusted.
  if (!file.startsWith(path.resolve(dist) + path.sep)) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': WEBSCAN_TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    // webscan's own headers. The depth model runs multi-threaded wasm, which
    // only exists in a cross-origin-isolated document; `credentialless` still
    // lets it pull the model weights from a CDN.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Permissions-Policy': 'camera=(self), gyroscope=(self), accelerometer=(self)',
  });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}

/**
 * Where a scanner should point, for the startup banner.
 *
 * Every address, not the first one: the Pi is normally on the ESP32's access
 * point and on a router at once, and the first interface is the right answer
 * only for phones that happen to be on that network. With mDNS on, the app
 * does not need any of them.
 */
function lidarBanner(lidar, args, scheme) {
  const ws = scheme === 'https' ? 'wss' : 'ws';
  const nets = args.host === '0.0.0.0' ? localAddresses()
    : [{ name: 'bind', address: args.host }];
  console.log(`lidar: relay on /ws, room "${lidar.room}"`
    + (args.advertise ? ' — the webscan app finds it by itself (mDNS _webscan._tcp)' : ''));
  for (const n of nets.length ? nets : [{ name: 'local', address: 'localhost' }]) {
    console.log(`   app relay URL, if typed:  ${ws}://${n.address}:${args.http}`.padEnd(52)
      + `(${n.name})`);
  }
  if (args.lidarSim) console.log(`   simulated LiDAR streaming into room "${lidar.room}"`);
  if (!args.advertise) console.log('   mDNS announcement off (--no-advertise) — type the URL in the app');
  if (args.webscan) {
    console.log(`   webscan web app from ${args.webscan}  ->  `
      + `${scheme}://${host}:${args.http}/sender.html?room=${lidar.room}`);
    if (!fs.existsSync(path.join(args.webscan, 'sender.html'))) {
      console.log('   ...but there is no sender.html in it — build webscan first (pnpm build)');
    }
  }
}

/**
 * Start the mDNS announcement, once the port is actually listening — a phone
 * that finds the service before then dials a port that refuses it. Its name
 * goes on the relay, so the pages can say what the app will list.
 */
async function announceLidar(lidar, args) {
  if (!args.advertise) return null;
  const handle = await advertise({ port: args.http, tls: !!args.https, path: '/ws' });
  lidar.announced = handle.name;
  if (handle.name) console.log(`lidar: announced as "${handle.name}" (_webscan._tcp)`);
  else console.log(`lidar: mDNS announcement unavailable — ${handle.error}`);
  return handle;
}

/**
 * The other machine: a differential drive on a Creality mainboard.
 *
 * Same robot, same road-following pages, same run logs — the difference is
 * that a wheel command leaves as G-code down a USB serial port instead of as
 * two DAC percentages over a WebSocket. It gets its own function rather than
 * a set of `if`s through main() because almost nothing survives the swap: no
 * transport, no bench, no 20 Hz watchdog to feed, and a shutdown that has to
 * let the move already on the board finish.
 */
async function runMarlin(args) {
  const link = new MarlinLink();
  const jog = new Jogger(link);
  // held() is read per request, so the rover being declared further down is fine.
  const api = marlinApi({ link, jog, held: () => rover.holdReason });

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
  // The ESP32's hub, manual, drive and pins pages are about two DAC pins, so
  // they are not here; everything that is about the road is.
  const PAGES = {
    '/':       'gcode.html',   // hold WASD, G-code goes out
    '/gcode':  'gcode.html',
    '/vision': 'vision.html',  // camera -> line detection, look and tune
    '/follow': 'follow.html',  // the same detector, driving
    '/tune':   'tune.html',    // read a run back and say what to change
    // The LiDAR map is about the robot, not the board, so it is on both.
    // /viewer.html is where the webscan phone app tells you to look.
    '/lidar':  'lidar.html',
    '/viewer.html': 'lidar.html',
    // The competition: PLC link, mission, field. On both machines, because the
    // factory automation system talks to the robot, not to its motor board.
    '/plc':    'plc.html',
  };

  // The road pages are shared with the ESP32 half, so they load what those
  // pages load — cam.js included, which is how /vision and /follow get their
  // pictures. A missing entry here is a 404 in a <script> tag, which is a page
  // that renders and then does nothing.
  const SCRIPTS = { '/road.js': 'road.js', '/pilot.js': 'pilot.js',
                    '/analyse.js': 'analyse.js', '/wheels.js': 'wheels.js',
                    '/sonar.js': 'sonar.js', '/cam.js': 'cam.js',
                    '/lidar.js': 'lidar.js', '/lidarmap.js': 'lidarmap.js',
                    '/field.js': 'field.js', '/plc.js': 'plc.js' };

  const lidar = new LidarRelay({ room: args.lidarRoom });
  const lidarSim = args.lidarSim ? new LidarSim({ relay: lidar }).start() : null;

  let followCfg = loadFollowCfg();
  const runLog = new FollowLog();

  // The webcam is the Pi's, not the board's, so it is here for the same reason
  // it is on the ESP32 side: /vision and /follow are the same two pages, and
  // they read the picture off this machine over plain http.
  const camera = new Camera({
    device: args.camera, width: args.camWidth, height: args.camHeight,
    fps: args.camFps, enabled: args.camera !== null,
  });

  // The field and the QR codes on it. No dead reckoning on this machine (no
  // route.js), so between two codes the position is the last code's — which is
  // what the PLC gets told, and what the page says.
  const fieldMap = FIELDS[args.field];
  let fieldSt = fieldState();
  const qr = new QrReader();
  let competition = null;         // started once the rover exists, below
  const seeQr = (text, at, byHand = false) => {
    const fix = fieldSee(fieldSt, text, at, fieldMap, null);
    console.log(`qr${byHand ? ' (by hand)' : ''}: ${JSON.stringify(String(text)).slice(0, 60)}`
      + (fix.ok ? `  → ${fix.from}→${fix.to}, ${fix.x}, ${fix.y} m`
                  + (fix.turn ? `  ·  ${fix.turn.node}: ${fix.turn.label}` : '')
                : '  → not on the field map'));
    if (competition) competition.onFix(fix);
    return fix;
  };
  if (args.qr && qr.available) {
    camera.onGray((gray, w, h) => qr.feed(gray, w, h));
    qr.onRead((text, at) => { seeQr(text, at); });
  }
  camera.start();

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (serveCamera(camera, req, res, url)) return;

    // The saved trim, for pages with no socket of their own — /vision is the
    // one that matters. Read-only: the only writer is the follow_cfg command.
    if (url === '/api/wheels') {
      const b = Buffer.from(JSON.stringify(followCfg || {}));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                           'Content-Length': b.length, 'Cache-Control': 'no-store' });
      res.end(b);
      return;
    }

    if (url === '/logs' || url.startsWith('/logs/')) { serveLogs(res, url); return; }

    if (url === '/api/field' || url === '/api/plc') {
      const b = Buffer.from(JSON.stringify(url === '/api/field' ? fieldMap : competition.status()));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                           'Content-Length': b.length, 'Cache-Control': 'no-store' });
      res.end(b);
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
      if (serveLidar(lidar, args.webscan, res, url)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    let body;
    try {
      body = fs.readFileSync(path.join(HERE, 'public', page || script));
    } catch (err) {
      console.warn(`cannot serve ${url}: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('page missing on disk');
      return;
    }
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
  // the browser. `/ws` on the same port is the LiDAR relay — see lidar_relay.js.
  const rover = new Rover({ link, jog });
  rover.setCfg(followCfg);

  competition = startCompetition(args, {
    map: fieldMap,
    field: () => fieldSt,
    route: () => null,
    setMission: (stops) => fieldMission(fieldSt, stops, fieldMap, 'START'),
    hold: (reason, all) => rover.hold(reason, all),
    armed: () => rover.running,
    fault: () => (link.connected ? null : 'motor kartı bağlı değil'),
    estop: () => rover.stop('acil stop'),
  });
  const wss = new WebSocketServer({ noServer: true });
  routeUpgrades(server, { relay: lidar, wss });

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    rover.clientJoined();
    console.log(`browser connected: ${peer}`);

    const send = (extra = {}) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({
        type: 'status', ...extra, ...rover.snapshot(),
        machine: 'marlin',
        follow_cfg: followCfg,
        log: { active: runLog.active, file: runLog.file, rows: runLog.rows },
        cam: camera.status(),
        lidar: lidar.status(),
        qr: qr.status(),
        field: fieldStatus(fieldSt, null, fieldMap),
        plc: competition.status(),
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
          rover.setCfg(followCfg);
          break;

        // /follow by hand: W A S D and the fork, both repeated at 20 Hz while
        // held and let go by the rover's own 400 ms dead-man when they stop.
        case 'keys': {
          const had = rover.keys.join('');
          rover.setKeys(msg.keys, msg.pct, msg.swap === true);
          if (rover.keys.join('') !== had) {
            console.log(rover.keys.length ? `keys ${rover.keys.join('+').toUpperCase()}` : 'keys released');
          }
          break;
        }
        case 'lift': {
          const before = rover.lift;
          rover.setLift(msg.dir);
          if (rover.lift !== before) {
            console.log(rover.lift ? `fork ${rover.lift > 0 ? 'up' : 'down'} (Z, ${rover.liftFeed} mm/min)` : 'fork released');
          }
          break;
        }

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
        case 'lidar_reset':
          if (lidar.reset(msg.room || lidar.room)) console.log('lidar map cleared');
          break;

        // ── the field, as on the ESP32 side ──
        case 'field_mission': {
          if (!Array.isArray(msg.targets) || msg.targets.length === 0) {
            fieldClearMission(fieldSt);
            console.log('mission cleared');
            break;
          }
          const plan = fieldMission(fieldSt, msg.targets, fieldMap, msg.from || null);
          console.log(plan.ok ? `mission ${plan.stops.join(' → ')}: ${plan.nodes.join(' > ')}`
                              : `mission refused: ${plan.reason}`);
          break;
        }
        case 'field_qr':
          seeQr(msg.text, Date.now(), true);
          break;
        case 'route_reset': {
          const stops = fieldSt.stops;
          fieldSt = fieldState();
          if (stops && stops.length) fieldMission(fieldSt, stops, fieldMap, 'START');
          break;
        }
        default:
          if (!competition.command(msg)) return;
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
  console.log(`  lidar map:      ${base}/lidar`);
  console.log(`  plc / görev:    ${base}/plc`);
  console.log(`  field:          ${fieldMap.label} (${fieldMap.w} × ${fieldMap.h} m)`);
  competition.banner();
  if (camera.enabled && !args.qr) console.log('   qr reader: off (--no-qr)');
  else if (camera.enabled && !qr.available) console.log(`   qr reader: off — ${qr.error}`);
  lidarBanner(lidar, args, 'http');
  const lidarAd = await announceLidar(lidar, args);
  if (!camera.enabled) {
    console.log('camera: off (--no-camera)');
  } else {
    console.log(`camera: ${args.camera} @ ${args.camWidth}x${args.camHeight} `
      + `${args.camFps} fps  ->  ${base}/camera/stream.mjpg`);
  }
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
    competition.close();
    rover.close();
    jog.stop();
    rover.stop('shutting down');
    for (const c of wss.clients) c.close();
    if (lidarSim) lidarSim.stop();
    // Goodbye packets before the socket goes, so a phone browsing right now
    // does not latch onto a relay that is already gone.
    if (lidarAd) await lidarAd.stop();
    lidar.close();
    await camera.close();
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

  // The other machine. Nothing below this line applies to it — no DACs, no
  // watchdog, no camera on the Pi — so it runs its own server end to end.
  if (args.marlin) return runMarlin(args);

  const transport = await buildTransport(args);
  const bench = new Bench({ transport, vMax: args.vMax, field: FIELDS[args.field] });

  // The competition: the PLC mission holds the bench's wheels and hears about
  // every code the field recognises. See plc_run.js.
  const competition = startCompetition(args, {
    map: bench.fieldMap,
    field: () => bench.field,
    route: () => bench.routePose(),
    setMission: (stops) => bench.setMission(stops, 'START'),
    hold: (reason, all) => bench.hold(reason, all),
    armed: () => bench.running,
    fault: () => (bench.tx.fresh ? null : 'esp32 erişilemiyor'),
    estop: () => bench.stop(),
  });
  await bench.open();

  // The persisted tuning. Declared here rather than next to the socket because
  // the HTTP handler below closes over it too, and a `let` read before its own
  // declaration throws rather than reading undefined.
  let followCfg = loadFollowCfg();
  bench.setCfg(followCfg);          // obstacle thresholds, wheelbase, calibration

  // ── the webcam, the QR reader, and the Pi's own vitals ────────────
  //
  // All three belong to the machine, not to a page: the robot sees, reads and
  // reports whether or not a browser is open, and two browsers watching get
  // the same answer rather than each computing their own.
  const camera = new Camera({
    device: args.camera, width: args.camWidth, height: args.camHeight,
    fps: args.camFps, enabled: args.camera !== null,
  });
  const qr = new QrReader();
  const sys = new RpiStats();

  if (args.qr && qr.available) {
    camera.onGray((gray, w, h) => qr.feed(gray, w, h));
    // A code read is a thing that happened at a place — and on this field it
    // says *which* place, so it both goes on the map and fixes the position.
    qr.onRead((text, at, entry) => {
      const { mark, fix } = bench.seeQr(text, at);
      competition.onFix(fix);
      if (entry) entry.pos = { x: mark.x, y: mark.y };
      console.log(`qr: ${JSON.stringify(text).slice(0, 80)}  @ ${mark.x}, ${mark.y} m`
        + (fix.ok ? `  → ${fix.from}→${fix.to}, ${fix.x}, ${fix.y} m, ${fix.bearing}°`
                    + (fix.turn ? `  ·  ${fix.turn.node}: ${fix.turn.label}` : '')
                  : '  → not on the field map'));
    });
  }
  camera.start();

  // Sampled once, on its own clock, and shared by every connected browser.
  // /proc/stat is a delta: reading it once per client per frame would give
  // each of them a different and shorter window, and none of the answers would
  // be the CPU load.
  let sysSnap = sys.sample().status();
  const sysTimer = setInterval(() => { sysSnap = sys.sample().status(); }, 500);

  // ── static pages ──────────────────────────────────────────────────
  const PAGES = {
    '/':       'home.html',    // hub: status + links to everything
    '/manual': 'manual.html',  // type the two percentages by hand
    '/drive':  'drive.html',   // hold W / A / S / D
    '/vision': 'vision.html',  // camera -> road detection, look and tune
    '/follow': 'follow.html',  // the same detector, driving
    '/tune':   'tune.html',    // read a run back and say what to change
    '/obstacle': 'obstacle.html',  // the forward HC-SR04, as a stop
    '/pins':   'pins.html',    // the spare pins, by hand
    '/setup':  'setup.html',   // what to measure, in order, and where it goes
    '/dashboard': 'dashboard.html',  // everything at once, on one screen
    '/panel':  'panel.html',   // the same, plus driving, fixed at 1920 × 1080
    '/lidar':  'lidar.html',   // the LiDAR map, full screen
    '/viewer.html': 'lidar.html',    // where the webscan phone app says to look
    '/plc':    'plc.html',     // the factory automation PLC and the mission
  };

  // The two pages that see the road share their code rather than each keeping
  // a copy, so tuning on /vision is tuning what /follow drives with.
  //
  // wheels.js is the same idea one level down: the per-wheel trim is a property
  // of the robot, not of a page, so every page reads it from one file and shows
  // the same numbers.
  const SCRIPTS = { '/road.js': 'road.js', '/pilot.js': 'pilot.js',
                    '/analyse.js': 'analyse.js', '/sonar.js': 'sonar.js',
                    '/wheels.js': 'wheels.js', '/route.js': 'route.js',
                    '/cam.js': 'cam.js', '/field.js': 'field.js',
                    '/lift.js': 'lift.js', '/plc.js': 'plc.js',
                    '/lidar.js': 'lidar.js', '/lidarmap.js': 'lidarmap.js' };

  // The LiDAR relay: scanners stream to /ws, pages draw what they stream. The
  // map lives on the scanner and in the pages; the server only passes it on.
  const lidar = new LidarRelay({ room: args.lidarRoom });
  const lidarSim = args.lidarSim ? new LidarSim({ relay: lidar }).start() : null;

  const onRequest = (req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (serveCamera(camera, req, res, url)) return;

    // The whole path, once. The status frame carries only where the robot is
    // now — sending 1 500 points ten times a second to say the last one moved
    // 5 cm is how a dashboard becomes the reason the robot stutters. A page
    // fetches this on load and appends from the status stream afterwards.
    if (url === '/api/route') {
      const r = bench.route;
      const b = Buffer.from(JSON.stringify({
        path: r.path, marks: r.marks, seq: r.seq, since: r.since,
        x: r.x, y: r.y, dist: r.dist,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                           'Content-Length': b.length, 'Cache-Control': 'no-store' });
      res.end(b);
      return;
    }

    // The field graph: nodes, edges and where each QR stands. Static for a
    // whole competition, so it is fetched once and cached in the page rather
    // than repeated in a status frame ten times a second. A page could read
    // FIELD out of /field.js instead — this exists so anything that is not a
    // browser (a phone, curl, the firmware one day) can have the map too.
    if (url === '/api/field' || url === '/api/plc') {
      const b = Buffer.from(JSON.stringify(url === '/api/field' ? bench.fieldMap : competition.status()));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                           'Content-Length': b.length, 'Cache-Control': 'no-store' });
      res.end(b);
      return;
    }

    if (url === '/logs' || url.startsWith('/logs/')) { serveLogs(res, url); return; }

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
      if (serveLidar(lidar, args.webscan, res, url)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    // A page that is in the table but not on disk is a mistake in this file,
    // not a reason for the robot to lose its 20 Hz stream: an unhandled throw
    // in a request handler takes the whole process down, motors included.
    let body;
    try {
      body = fs.readFileSync(path.join(HERE, 'public', page || script));
    } catch (err) {
      console.warn(`cannot serve ${url}: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('page missing on disk');
      return;
    }
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
  // Every path but /ws, which is the LiDAR relay.
  const wss = new WebSocketServer({ noServer: true });
  routeUpgrades(server, { relay: lidar, wss });
  const runLog = new FollowLog();

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    bench.clientJoined();
    console.log(`browser connected: ${peer}`);

    const send = (extra = {}) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'status', ...extra, ...bench.snapshot(),
          machine: 'esp32',
          follow_cfg: followCfg,
          log: { active: runLog.active, file: runLog.file, rows: runLog.rows },
          // The three things that are the Pi's rather than the ESP32's.
          cam: camera.status(),
          qr: qr.status(),
          rpi: sysSnap,
          lidar: lidar.status(),
          plc: competition.status(),
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
        // The two fixed speeds. `gear` arrives at 20 Hz while one is engaged —
        // that is its dead-man — so only a change is worth a line of log.
        case 'gear': {
          const before = bench.gear;
          bench.setGear(msg.gear);
          if (bench.gear !== before) {
            console.log(bench.gear
              ? `gear ${bench.gear}: dac ${bench.gears[bench.gear].join(' / ')}`
              : 'gear released');
          }
          break;
        }
        case 'gears':
          bench.setGears(msg.gears);
          console.log('gears updated:', JSON.stringify(bench.gears));
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
        case 'pin':
          bench.setPin(msg.gpio, msg.val);
          break;

        // The lift, held. Arrives at 20 Hz while a button is down — that is its
        // dead-man — so only a change is worth a line of log, the same rule the
        // gears follow.
        case 'lift': {
          const before = bench.lift;
          bench.setLift(msg.dir);
          if (bench.lift !== before) {
            console.log(bench.lift
              ? `lift ${bench.lift > 0 ? 'up' : 'down'} (${bench.liftOut})`
              : 'lift released');
          }
          break;
        }
        case 'follow_cfg':
          followCfg = saveFollowCfg({ ...followCfg, ...(msg.cfg || {}) });
          // The obstacle thresholds and the wheelbase are the server's
          // business now, so a page editing them has to reach the brake and
          // the map, not just the file.
          bench.setCfg(followCfg);
          break;
        case 'route_reset':
          bench.resetRoute();
          console.log('route reset — map starts here');
          break;
        // Forget the LiDAR map — on the server and on every page drawing it.
        // The phone keeps its own copy; the next scans rebuild from here.
        case 'lidar_reset':
          if (lidar.reset(msg.room || lidar.room)) console.log('lidar map cleared');
          break;

        // ── the field ──
        // Where to go: a list of stops, in order, e.g. ['A2', 'B3']. The
        // planner works out the junctions in between and what to do at each.
        case 'field_mission': {
          const plan = bench.setMission(msg.targets, msg.from || null);
          console.log(plan.ok && plan.nodes.length
            ? `mission ${(plan.stops || []).join(' → ') || '(none)'}: ${plan.nodes.join(' > ')}`
            : `mission refused: ${plan.reason || 'boş'}`);
          break;
        }
        // A code, typed or clicked rather than seen. The camera is the real
        // source, but a field is walked before it is driven — and it is the
        // only way to rehearse the route with no camera and no printed codes.
        // Flagged in the log so a run is never read back as if it drove past a
        // sign that was never there.
        case 'field_qr': {
          const { fix } = bench.seeQr(msg.text, Date.now());
          competition.onFix(fix);
          console.log(`qr (by hand): ${JSON.stringify(String(msg.text || '')).slice(0, 40)}`
            + (fix.ok ? ` → ${fix.from}→${fix.to}` : ' → not recognised'));
          break;
        }
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
          if (!competition.command(msg)) return;
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
    console.log(`  dashboard:      ${base}/dashboard`);
    console.log(`  1920x1080 panel:${base}/panel`);
    console.log(`  manual page:    ${base}/manual`);
    console.log(`  keyboard drive: ${base}/drive`);
    console.log(`  camera / road:  ${base}/vision`);
    console.log(`  follow the road:${base}/follow`);
    console.log(`  read a run back:${base}/tune`);
    console.log(`  obstacle stop:  ${base}/obstacle`);
    console.log(`  spare pins:     ${base}/pins`);
    console.log(`  lidar map:      ${base}/lidar`);
    console.log(`  plc / görev:    ${base}/plc`);
    console.log(`  field:          ${bench.fieldMap.label} (${bench.fieldMap.w} × ${bench.fieldMap.h} m)`);
    competition.banner();

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

    // The camera is this machine's now, so its state belongs in this machine's
    // startup output rather than being discovered as a black rectangle.
    if (!camera.enabled) {
      console.log('camera: off (--no-camera)');
    } else {
      console.log(`camera: ${args.camera} @ ${args.camWidth}x${args.camHeight} `
        + `${args.camFps} fps  ->  ${base}/camera/stream.mjpg`);
      if (!args.qr) console.log('   qr reader: off (--no-qr)');
      else if (!qr.available) console.log(`   qr reader: off — ${qr.error}`);
    }
    console.log(`obstacle: stop under ${bench.obsCfg.stopCm} cm, clear over `
      + `${bench.obsCfg.clearCm} cm — enforced for every drive path`);
    lidarBanner(lidar, args, scheme);
    lidarAd = announceLidar(lidar, args);

    if (args.host === '0.0.0.0') {
      console.log('NOTE: reachable by anyone on this network, with no authentication.');
    }
  });
  let lidarAd = null;           // a promise of the mDNS handle, once listening

  // ── shutdown ──────────────────────────────────────────────────────
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nshutting down — outputs to idle');
    clearInterval(sysTimer);
    competition.close();
    for (const c of wss.clients) c.close();
    if (lidarSim) lidarSim.stop();
    // Goodbye packets first — see announceLidar.
    const ad = await lidarAd;
    if (ad) await ad.stop();
    lidar.close();
    await camera.close();
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
