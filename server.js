#!/usr/bin/env node
/**
 * A differential-drive rover on a Creality mainboard, driven by G-code over
 * USB serial: X and Y are the left and right stepper drivers, mounted
 * mirror-image, so a direction is a pair of wheel signs rather than one axis
 * — see DIRECTIONS in marlin.js, the single definition the page, the API and
 * the tests all read.
 *
 * The pages, one WebSocket:
 *     /        hub — live status and a tile to every page below
 *     /gcode   hold W / A / S / D, G-code goes out for as long as the key is down;
 *              the lift (Q / E), and teaching the routes to the loads
 *     /vision  camera; finds the road, shows the steering error and the QR code
 *     /follow  the same detector, driving the motors, recording the run;
 *              F to follow, W A S D by hand, Q / E for the fork
 *     /tune    drop a run log in, get numbers back out
 *     /lidar   the iPhone LiDAR map (the relay is on /ws, same port)
 *     /plc     the factory automation PLC, the mission and the field
 *     /pins    the Pi's own pins: the reversing buzzer, what is wired where
 *
 *     node server.js                    find the printer, open it, serve the page
 *     node server.js --port /dev/ttyUSB0
 *     node server.js --no-connect       serve the page, leave the port alone —
 *                                        useful when the printer is not plugged
 *                                        in yet; the page has a Connect button
 *                                        and a port list of its own
 *     node server.js --trace            print every serial line, in and out,
 *                                        timestamped
 *
 * The page and its WebSocket share one port, so there is nothing to configure
 * in the browser — open the URL this prints.
 */

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { FollowLog, LOG_DIR } from './follow_log.js';
import { Camera, CAMERA_DEFAULTS, PLACEHOLDER_JPEG } from './camera.js';
import { MarlinLink, Jogger, listPorts, bestPort, explainSerialError,
         DEFAULT_BAUD } from './marlin.js';
import { marlinApi, reply } from './marlin_http.js';
import { Rover } from './rover.js';
import { QrReader, QrLooker } from './qr.js';
import { Actuator, ACTUATOR_DEFAULTS, actuatorApi, actuatorCommand } from './actuator.js';
import { Lidar, LIDAR_DEFAULTS, lidarApi } from './lidar.js';
import { Radar, RADAR_DEFAULTS, radarApi } from './radar.js';
import { RouteBook, RouteRecorder, Replayer, routesApi, ROUTE_LEGS } from './routes.js';
import { Nav, FIELD, navQrs } from './nav.js';
import { RpiStats } from './rpi.js';
import { LidarRelay, routeUpgrades } from './lidar_relay.js';
import { LidarSim } from './lidar_sim.js';
import { advertise } from './lidar_discovery.js';
import { startCompetition } from './plc_run.js';
import { Gpio } from './gpio.js';
import { Buzzer } from './buzzer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Where the saved tuning lives. TETYM_FOLLOW_FILE moves it, which is how the
// tests write settings without touching the robot's own follow.json.
const FOLLOW_FILE = process.env.TETYM_FOLLOW_FILE || path.join(HERE, 'follow.json');
// The taught routes — see routes.js. Saved, unlike the mission target: they
// are an afternoon of driving, not a choice about this run.
const ROUTES_FILE = path.join(HERE, 'routes.json');

/**
 * The follow page's sliders and calibration, saved server-side.
 *
 * Numbers you found by driving the robot should not depend on which browser
 * or which laptop you drove it from, and they should still be there after a
 * reload in the middle of a session.
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
  const args = { host: '0.0.0.0', http: 8090, list: false,
                 port: null, baud: DEFAULT_BAUD, connect: true, trace: false,
                 // The webcam is plugged into this machine, so it is a server
                 // setting like the serial port is — not something a page asks
                 // for permission to use.
                 camera: CAMERA_DEFAULTS.device,
                 camWidth: CAMERA_DEFAULTS.width,
                 camHeight: CAMERA_DEFAULTS.height,
                 camFps: CAMERA_DEFAULTS.fps,
                 qrFps: CAMERA_DEFAULTS.qrFps,
                 qr: true,
                 // The lift's two GPIO pins. Off means dry: the page and the
                 // cargo run behave the same, no pin is touched — for a laptop,
                 // and for the test suites, which run on the Pi itself.
                 actuator: true,
                 actMaxS: ACTUATOR_DEFAULTS.maxRunMs / 1000,
                 // The lidar motor on its L298N. Off means dry, for the same
                 // reasons as the lift.
                 lidar: true,
                 lidarV: LIDAR_DEFAULTS.volts,
                 lidarSupply: LIDAR_DEFAULTS.supplyV,
                 lidarDrop: LIDAR_DEFAULTS.dropV,
                 // What the lidar sends to this Pi — see radar.js. Off means
                 // the port is never opened.
                 radar: true,
                 radarPort: RADAR_DEFAULTS.port,
                 radarOffset: RADAR_DEFAULTS.offset,
                 radarCcw: RADAR_DEFAULTS.ccw,
                 radarUnit: RADAR_DEFAULTS.unit,
                 radarFov: RADAR_DEFAULTS.fov,
                 routes: ROUTES_FILE,
                 // The LiDAR map. The scanner is a phone running webscan, and it
                 // finds this server the way it used to find the webscan relay.
                 // Not the lidar motor above: that spins, this draws.
                 lidarRoom: 'default', lidarSim: false, webscan: null,
                 // Announce the relay over mDNS so the phone app lists it
                 // without an address being typed.
                 advertise: true,
                 // The factory automation system's PLC (EK TEKNİK ŞARTNAME,
                 // bölüm 2). Off unless asked for, so a laptop on the office
                 // wifi does not spray UDP at 192.168.100.100.
                 plc: null, plcBind: null, plcSim: false,
                 // The Pi's own pins (the buzzer, /pins). Off means dry.
                 gpio: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--baud') args.baud = parseInt(argv[++i], 10);
    else if (a === '--no-connect') args.connect = false;
    else if (a === '--trace') args.trace = true;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--http') args.http = parseInt(argv[++i], 10);
    else if (a === '--port') args.port = argv[++i];
    else if (a === '--camera') args.camera = argv[++i];
    else if (a === '--no-camera') args.camera = null;
    else if (a === '--cam-fps') args.camFps = parseInt(argv[++i], 10);
    else if (a === '--qr-fps') args.qrFps = Math.max(0.5, parseFloat(argv[++i]) || CAMERA_DEFAULTS.qrFps);
    else if (a === '--no-qr') args.qr = false;
    else if (a === '--no-actuator') args.actuator = false;
    else if (a === '--act-max-s') args.actMaxS = Number(argv[++i]);
    else if (a === '--no-lidar') args.lidar = false;
    else if (a === '--lidar-v') args.lidarV = Number(argv[++i]);
    else if (a === '--lidar-supply') args.lidarSupply = Number(argv[++i]);
    else if (a === '--lidar-drop') args.lidarDrop = Number(argv[++i]);
    else if (a === '--no-radar') args.radar = false;
    else if (a === '--radar-port') args.radarPort = parseInt(argv[++i], 10);
    else if (a === '--radar-offset') args.radarOffset = Number(argv[++i]) || 0;
    else if (a === '--radar-ccw') args.radarCcw = true;
    else if (a === '--radar-unit') args.radarUnit = argv[++i];
    else if (a === '--radar-fov') args.radarFov = Number(argv[++i]) || RADAR_DEFAULTS.fov;
    else if (a === '--routes') args.routes = argv[++i];
    else if (a === '--no-gpio') args.gpio = false;
    else if (a === '--lidar-room') args.lidarRoom = argv[++i];
    else if (a === '--lidar-sim') args.lidarSim = true;
    else if (a === '--webscan') args.webscan = argv[++i];
    else if (a === '--no-advertise') args.advertise = false;
    else if (a === '--plc') {
      const next = argv[i + 1];
      args.plc = next && !next.startsWith('--') ? argv[++i] : true;
    }
    else if (a === '--plc-bind') args.plcBind = argv[++i];
    else if (a === '--plc-local') args.plcLocal = parseInt(argv[++i], 10) || 0;
    else if (a === '--plc-sim') {
      args.plcSim = true;
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) args.plcSimPort = Number(argv[++i]);
    }
    else if (a === '--cam-size') {
      const [w, h] = String(argv[++i] || '').split(/[x×*]/);
      if (w && h) { args.camWidth = parseInt(w, 10); args.camHeight = parseInt(h, 10); }
    }
    else if (a === '--help' || a === '-h') {
      console.log(`usage: node server.js [options]

  --http <n>        web port (default 8090)
  --host <addr>     bind address (default 0.0.0.0 — every interface)
  --port <path>     the printer's serial device (default: auto-detected —
                    /dev/ttyUSB0 on a Pi)
  --baud <n>        serial speed (default ${DEFAULT_BAUD})
  --no-connect      serve the page without opening the port. Use it when the
                    printer is not plugged in yet — the page has a Connect
                    button and a port list of its own.
  --trace           print every serial line, in and out, timestamped. Hold a
                    key for a few seconds with this on and the output is the
                    whole story: what went out and what came back.
  --camera <dev>    the webcam on this machine (default ${CAMERA_DEFAULTS.device})
  --cam-size <WxH>  capture size (default ${CAMERA_DEFAULTS.width}x${CAMERA_DEFAULTS.height})
  --cam-fps <n>     capture rate (default ${CAMERA_DEFAULTS.fps})
  --qr-fps <n>      QR reader's looks per second (default ${CAMERA_DEFAULTS.qrFps})
  --no-camera       do not open a camera at all
  --no-qr           camera on, QR reader off
  --no-actuator     the lift is dry: state kept, GPIO10/GPIO22 never touched
  --act-max-s <n>   cut a single lift run after this many seconds
                    (default ${ACTUATOR_DEFAULTS.maxRunMs / 1000}; 0 = never)
  --no-lidar        the lidar motor is dry: state kept, GPIO${LIDAR_DEFAULTS.pwmPin}/${LIDAR_DEFAULTS.in1Pin}/${LIDAR_DEFAULTS.in2Pin} never touched
  --lidar-v <n>     the lidar motor's starting voltage (default ${LIDAR_DEFAULTS.volts})
  --lidar-supply <n> what the L298N is fed (default ${LIDAR_DEFAULTS.supplyV} V)
  --lidar-drop <n>  the L298N's own loss (default ${LIDAR_DEFAULTS.dropV} V) — duty is
                    volts / (supply − drop)
  --radar-port <n>  where the lidar's data arrives: UDP, TCP, HTTP, WebSocket,
                    TLS (default ${RADAR_DEFAULTS.port})
  --no-radar        do not open the radar port at all
  --radar-offset <n> degrees added to every lidar angle — the card sets it too
  --radar-ccw       the lidar counts anticlockwise
  --radar-unit <u>  mm | cm | m for distances that do not say (default auto)
  --radar-fov <n>   the iPhone's depth map width, degrees (default ${RADAR_DEFAULTS.fov})
  --routes <file>   where the taught routes are kept (default routes.json
                    next to server.js) — the tests point this elsewhere so
                    they never touch the real ones
  --lidar-room <r>  the LiDAR relay room the pages show (default "default").
                    A scanner connects to ws://<this machine>:<port>/ws with
                    any room name; this only picks which one /lidar draws
  --lidar-sim       stream a simulated LiDAR into that room — no phone needed
  --no-advertise    do not announce the relay over mDNS (_webscan._tcp). With it
                    on, the webscan phone app finds this server by itself
  --webscan <dir>   also serve a built webscan web app (apps/web/dist), so its
                    browser scanner streams straight here
  --plc [host:port] talk to the factory automation PLC over UDP: PAKET_TX once
                    a second, PAKET_RX back. Default 192.168.100.100:1515
  --plc-bind <ip>   send from this address — the robot's, 192.168.100.10
  --plc-local <n>   the robot's own UDP port for the PLC link (default: any free
                    one, chosen at start). Fix it to test by hand with nc
  --no-gpio         the buzzer and /pins are dry: state kept, no Pi pin touched
  --plc-sim [port]  run a PLC simulator in this server on 127.0.0.1:1515 and
                    talk to it: the whole mission, no field needed. /plc
  --list            list serial ports and exit`);
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

/**
 * The webcam, as two URLs: a stream and a still.
 *
 * Answers the request and returns true, or returns false for a URL that is
 * not the camera's.
 */
function serveCamera(camera, req, res, url) {
  // ── the webcam ────────────────────────────────────────────────────
  //
  // An <img> pointed at this is all a page needs to have live video, over
  // plain http, from any device on the wifi. No getUserMedia, no permission
  // prompt, no certificate — which is the entire reason the camera lives on
  // the Pi rather than the phone.
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
 * (The lidar *motor* is /api/lidar-motor.)
 *
 * With --webscan, the files of a built webscan web app too — its browser
 * scanner then comes from the same origin whose /ws it streams to, which is the
 * whole integration: nothing in webscan is edited. Tried only after the rover's
 * own pages, so `/` is still the hub rather than webscan's index.
 *
 * Streamed, not read whole: the depth model's wasm is tens of megabytes, and a
 * synchronous read that size is a stall in the stream to the motors.
 */
function serveLidar(lidar, dist, res, url) {
  if (url === '/api/lidar') {
    reply(res, 200, lidar.info());
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
 * Every address, not the first one: the Pi is often on two networks at once,
 * and the first interface is the right answer only for phones that happen to
 * be on that one. With mDNS on, the app does not need any of them.
 */
function lidarBanner(lidar, args) {
  const nets = args.host === '0.0.0.0' ? localAddresses()
    : [{ name: 'bind', address: args.host }];
  console.log(`lidar map: relay on /ws, room "${lidar.room}"`
    + (args.advertise ? ' — the webscan app finds it by itself (mDNS _webscan._tcp)' : ''));
  for (const n of nets.length ? nets : [{ name: 'local', address: 'localhost' }]) {
    console.log(`   app relay URL, if typed:  ws://${n.address}:${args.http}`.padEnd(52)
      + `(${n.name})`);
  }
  if (args.lidarSim) console.log(`   simulated LiDAR streaming into room "${lidar.room}"`);
  if (!args.advertise) console.log('   mDNS announcement off (--no-advertise) — type the URL in the app');
  if (args.webscan) {
    const shown = args.host === '0.0.0.0' ? 'localhost' : args.host;
    console.log(`   webscan web app from ${args.webscan}  ->  `
      + `http://${shown}:${args.http}/sender.html?room=${lidar.room}`);
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
  const handle = await advertise({ port: args.http, tls: false, path: '/ws' });
  lidar.announced = handle.name;
  if (handle.name) console.log(`lidar map: announced as "${handle.name}" (_webscan._tcp)`);
  else console.log(`lidar map: mDNS announcement unavailable — ${handle.error}`);
  return handle;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const ports = await listPorts();
    if (!ports.length) console.log('no serial ports found');
    for (const p of ports) console.log(p);
    return;
  }

  const link = new MarlinLink();
  const jog = new Jogger(link);
  // A key or a halt on /gcode takes the wheels back from a taught route being
  // replayed (routes.js) — `replayer` is created further down, before any
  // request can arrive.
  // held() is read per request, so the rover being declared further down is
  // fine: the PLC mission's brake covers the keyboard too.
  const api = marlinApi({ link, jog, onManual: () => replayer.cancel('əl ilə sürüldü'),
                          held: () => rover.holdReason });

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
    // One page to start from: status, then a tile to everything served here.
    '/':       'home.html',
    '/gcode':  'gcode.html',   // hold WASD, G-code goes out
    '/vision': 'vision.html',  // camera -> line detection, look and tune
    '/follow': 'follow.html',  // the same detector, driving
    '/tune':   'tune.html',    // read a run back and say what to change
    '/map':    'map.html',     // the competition field: pick a station, watch it go
    '/dashboard': 'dashboard.html',  // everything at once: camera, QR, where it is, the Pi
    '/lidar':  'lidar.html',   // the iPhone LiDAR map, full screen
    '/viewer.html': 'lidar.html',    // where the webscan phone app says to look
    // The competition: PLC link, mission, field. The factory automation
    // system talks to the robot, not to its motor board.
    '/plc':    'plc.html',
    '/pins':   'pins_pi.html', // the Pi's own pins: the reversing buzzer, what is wired where
  };

  // A missing entry here is a 404 in a <script> tag, which is a page that
  // renders and then does nothing.
  const SCRIPTS = { '/road.js': 'road.js', '/pilot.js': 'pilot.js',
                    '/analyse.js': 'analyse.js', '/sonar.js': 'sonar.js',
                    '/cam.js': 'cam.js', '/field.js': 'field.js',
                    '/mission.js': 'mission.js', '/actuator.js': 'actuator.js',
                    '/teach.js': 'teach.js', '/qrview.js': 'qrview.js',
                    '/lidarmotor.js': 'lidarmotor.js', '/qrnav.js': 'qrnav.js',
                    '/radar.js': 'radar.js', '/plc.js': 'plc.js',
                    // The LiDAR map's decoder and drawing, for /lidar and /dashboard.
                    '/lidar.js': 'lidar.js', '/lidarmap.js': 'lidarmap.js' };

  // The LiDAR relay: scanners stream to /ws, pages draw what they stream. The
  // map lives on the scanner and in the pages; the server only passes it on.
  const lidarMap = new LidarRelay({ room: args.lidarRoom });
  const lidarSim = args.lidarSim ? new LidarSim({ relay: lidarMap }).start() : null;

  let followCfg = loadFollowCfg();
  const runLog = new FollowLog();

  // Where the rover is: an odometer fed off the wire, and the QR codes on top
  // of it. It hears every G1 that reaches the board, so it keeps count
  // whichever page — or none — is driving. See nav.js and public/qrnav.js.
  const nav = new Nav({ link });
  nav.setCfg(followCfg);
  let competition = null;         // started once the rover exists, below

  /**
   * The run, as every open page sees it.
   *
   * Deliberately a relay and nothing more. /follow owns the mission — it has
   * the camera, so it is the only page that can see a junction — and /map owns
   * the choosing, because a person picking a station should not have to be
   * standing over the robot's camera feed to do it. This is the two-line
   * server in between: it holds the last target somebody asked for and the
   * last status the driver reported, and puts both in the status message that
   * already goes out ten times a second.
   *
   * Not saved to disk, unlike followCfg. A target is about this run; surviving
   * a restart would mean a rover that starts driving somewhere because of
   * something asked for yesterday.
   */
  let mission = null;      // what /follow last reported
  let wanted = null;       // the station somebody last picked
  // …or the cargo run somebody last asked for: {slot, id}. The two are one
  // choice — picking a station clears this and asking for a cargo run clears
  // that — because /follow can only be doing one of them. `id` is so /follow
  // can tell a new request for slot 2 from the old one it already acted on.
  let cargoWant = null;
  const askCargo = (slot, id) => {
    cargoWant = slot ? { slot, id: id || Date.now() } : null;
    wanted = null;
    mission = null;
    console.log(cargoWant ? `cargo run: yuva ${slot}` : 'cargo run cleared');
  };

  const camera = new Camera({
    device: args.camera, width: args.camWidth, height: args.camHeight,
    fps: args.camFps, qrFps: args.qrFps, enabled: args.camera !== null,
  });
  camera.start();

  // The Pi's own vitals, for /dashboard. Sampled once, on their own clock, and
  // shared by every browser: /proc/stat is a delta, and sampling it per client
  // would give each one a different, shorter window — none of them the load.
  const sys = new RpiStats();
  let sysSnap = sys.sample().status();
  const sysTimer = setInterval(() => { sysSnap = sys.sample().status(); }, 500);
  sysTimer.unref();

  // ── the QR reader ─────────────────────────────────────────────────
  // Fed from the camera's full-resolution grey frames (camera.js), so it reads
  // whether or not a page is open. /vision shows it; /follow's cargo run acts
  // on it. Each look — locate, straighten, decode — runs on a worker thread
  // (qr_worker.js), never on the thread that streams to the board.
  const qr = new QrReader();
  if (args.qr) {
    const looker = new QrLooker(qr);
    camera.onGray((gray, w, h) => looker.offer(gray, w, h));
    // A code read is a thing that happened at a place — and on this field it
    // says *which* place, so it both goes on the trail and fixes the position.
    qr.onRead((text, at) => {
      const { fix } = nav.seeQr(text, at);
      if (competition) competition.onFix(fix);
      console.log(`QR: ${text}` + (fix.ok
        ? `  → ${fix.from}→${fix.to}, ${fix.x}, ${fix.y} m, ${fix.bearing}°`
          + (fix.turn ? `  ·  ${fix.turn.node}: ${fix.turn.label}` : '')
        : '  → not on the field map'));
    });
  } else {
    qr.available = false;
    qr.error = 'QR oxuma söndürülüb (--no-qr)';
  }

  // ── the lift ──────────────────────────────────────────────────────
  const act = new Actuator({ enabled: args.actuator,
                             maxRunMs: Math.max(0, args.actMaxS || 0) * 1000 });
  act.init();
  const actApi = actuatorApi(act);

  // ── the lidar motor ───────────────────────────────────────────────
  // Nothing is spawned until the first START; until then the Pi's own
  // pull-downs hold all three pins low. See lidar.js. (The LiDAR *map*, from
  // the phone, is lidarMap above.)
  const lidar = new Lidar({ enabled: args.lidar, volts: args.lidarV,
                            supplyV: args.lidarSupply, dropV: args.lidarDrop });
  const lidarHttp = lidarApi(lidar);

  // ── the radar ─────────────────────────────────────────────────────
  // What the lidar sees, sent here by whatever reads it. Opened after the
  // page's own port, below; a port somebody else holds is a line on the card,
  // not a server that will not start.
  const radar = new Radar({ enabled: args.radar, port: args.radarPort, host: args.host,
                            offset: args.radarOffset, ccw: args.radarCcw,
                            unit: args.radarUnit, fov: args.radarFov });
  const radarHttp = radarApi(radar);

  // ── taught routes ─────────────────────────────────────────────────
  const book = new RouteBook(args.routes);
  const recorder = new RouteRecorder({ link, jog });
  const replayer = new Replayer({ link, jog });
  const cargoApi = routesApi({ book, recorder, replayer,
                               want: () => cargoWant, run: (slot) => askCargo(slot),
                               armed: () => rover.running });

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

    // What this machine serves, for the hub to build its tiles from — a page
    // that is not served is not offered — and the Pi's pin notes.
    if (url === '/api/pages') { reply(res, 200, { machine: 'marlin', pages: Object.keys(PAGES) }); return; }
    if (url === '/api/pins') { reply(res, 200, { pins: followCfg.pins || [], buzzer: buzzer.status() }); return; }
    if (url === '/api/plc') { reply(res, 200, competition.status()); return; }

    // The whole trail, once. The status frame carries only where the rover is
    // now; a page fetches this on load and appends from the stream after.
    if (url === '/api/route') { reply(res, 200, nav.routeJson()); return; }

    // The field graph and where each code stands. Static for a whole
    // competition, so it is fetched once rather than sent ten times a second —
    // and it is here for anything that is not a browser, too.
    if (url === '/api/field') { reply(res, 200, { ...FIELD, qrs: navQrs() }); return; }

    // The last code read. /vision polls this rather than opening a socket,
    // for the same reason it reads /api/wheels: it is a page that looks, and
    // a socket is what the pages that drive are counted by.
    if (url === '/api/qr') { reply(res, 200, qr.status()); return; }

    const failed = (err) => {
      if (res.headersSent) return;
      reply(res, 500, { error: String(err.message || err) });
    };
    if (url === '/api/actuator') { actApi(req, res).catch(failed); return; }
    if (url === '/api/lidar-motor') { lidarHttp(req, res).catch(failed); return; }
    if (url === '/api/radar') { radarHttp(req, res).catch(failed); return; }
    // The last 30 messages whole, base64 — for reading a sender's format.
    if (url === '/api/radar/frames') { reply(res, 200, { frames: radar.frames }); return; }
    // The room map, built up turn by turn: [ix, iy, hits, …] in 5 cm cells.
    if (url === '/api/radar/map') { reply(res, 200, radar.mapJson()); return; }
    if (url === '/api/cargo') { cargoApi(req, res).catch(failed); return; }

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
      if (serveLidar(lidarMap, args.webscan, res, url)) return;
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
  // the browser.
  const rover = new Rover({ link, jog, replayer });
  rover.setCfg(followCfg);

  // The Pi's own pins: the reversing buzzer first of all. Driven from the
  // demand rather than from a page, so it sounds with no browser open.
  const gpio = new Gpio({ enabled: args.gpio });
  const buzzer = new Buzzer({ gpio, cfg: followCfg });
  const buzzerTimer = setInterval(() => buzzer.setReversing(rover.reversing), 100);
  buzzerTimer.unref?.();

  // The competition: the PLC mission holds the rover's wheels, plans the task's
  // stops on the field, and hears about every code the QR reader places.
  competition = startCompetition(args, {
    map: FIELD,
    pose: () => nav.status().field.pose,
    setMission: (stops) => nav.setMission(stops, 'START'),
    hold: (reason, all) => rover.hold(reason, all),
    armed: () => rover.running,
    fault: () => (link.connected ? null : 'motor kartı bağlı değil'),
    estop: () => rover.stop('acil stop'),
  });

  // Every path but /ws, which is the LiDAR relay — see lidar_relay.js.
  const wss = new WebSocketServer({ noServer: true });
  routeUpgrades(server, { relay: lidarMap, wss });

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    rover.clientJoined();
    console.log(`browser connected: ${peer}`);

    const send = (extra = {}) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({
        type: 'status', ...extra, ...rover.snapshot(),
        follow_cfg: followCfg,
        mission, want: wanted,
        log: { active: runLog.active, file: runLog.file, rows: runLog.rows },
        cam: camera.status(),
        qr: qr.status(),
        act: act.status(),
        cargo: { want: cargoWant, routes: book.summary(), rec: recorder.status() },
        // Where the rover is — `route` (the odometer) and `field` (the QR
        // localisation, the plan and the next turn) — and the Pi's vitals.
        ...nav.status(),
        rpi: sysSnap,
        machine: 'marlin',
        lidar_motor: lidar.status(),
        lidar: lidarMap.status(),
        radar: radar.status(),
        plc: competition.status(),
        buzzer: buzzer.status(),
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
          nav.setCfg(followCfg);          // route.track, if a page sets it
          rover.setCfg(followCfg);        // the fork's speed and direction
          buzzer.setCfg(followCfg);
          break;

        // The buzzer, sounded on purpose: the only way to check the wiring
        // without pushing the robot backwards.
        case 'buzzer_test':
          buzzer.test(Number(msg.ms) || 600);
          console.log('buzzer test');
          break;

        // A pin set by hand from /pins. Only pins written down there as
        // outputs: driving a number somebody typed in could be the serial
        // console, the I²C bus, or the lift's enable line.
        case 'pi_pin': {
          const note = (followCfg.pins || []).find((p) => Number(p.pin) === Number(msg.pin));
          if (!note || note.dir !== 'out') {
            console.log(`pin refused: GPIO${msg.pin} is not a written-down output`);
            break;
          }
          const on = msg.value ? 1 : 0;
          gpio.set(note.pin, on).then((done) => {
            console.log(`GPIO${note.pin} = ${on}`
              + (done ? '' : ` (not driven: ${gpio.status().error || 'no backend'})`));
          });
          break;
        }

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

        // Forget the LiDAR map — on the server and on every page drawing it.
        // The phone keeps its own copy; the next scans rebuild from here.
        case 'lidar_reset':
          if (lidarMap.reset(msg.room || lidarMap.room)) console.log('lidar map cleared');
          break;

        // ── the dashboard's map ──
        case 'route_reset':
          nav.reset();
          console.log('route reset — the trail starts here');
          break;
        // The stops to call at, in order — ['A2', 'B3'] — planned against the
        // QR localisation. /follow's own map run is `mission`, above; this
        // one steers nothing, it tells a person which way the next turn is.
        case 'field_mission': {
          const plan = nav.setMission(msg.targets, msg.from || null);
          console.log(plan.ok && plan.nodes.length
            ? `field plan ${(plan.stops || []).join(' → ')}: ${plan.nodes.join(' > ')}`
            : plan.ok ? 'field plan cleared' : `field plan refused: ${plan.reason}`);
          break;
        }
        // A code tapped on the map rather than seen. The camera is the real
        // reader; this is how a route is rehearsed with no printed codes.
        case 'field_qr': {
          const { fix } = nav.seeQr(msg.text, Date.now());
          competition.onFix(fix);
          console.log(`qr (by hand): ${JSON.stringify(String(msg.text || '')).slice(0, 40)}`
            + (fix.ok ? ` → ${fix.from}→${fix.to}` : ' → not recognised'));
          break;
        }

        // /map picked a station. Stored and broadcast; /follow is what acts
        // on it, and it may not even be open.
        case 'mission':
          wanted = msg.target || null;
          mission = null;
          cargoWant = null;
          console.log(wanted ? `mission: ${wanted}` : 'mission cleared');
          break;

        // A cargo run — /follow's own buttons, or /gcode's via /api/cargo.
        case 'cargo':
          askCargo(Number(msg.slot) || null, msg.id);
          break;

        // /follow's cargo run reached a taught leg: drive it from memory.
        // Answered through `replay` in the status, under the page's own id.
        case 'replay': {
          const route = `yuva ${msg.slot}, ${ROUTE_LEGS[msg.leg] || msg.leg}`;
          let segs = null;
          // A recording on /gcode listens to the wire; this replay would end
          // up taught back into it.
          if (recorder.active) { replayer.fail(msg.id, '/gcode-da yazılır — əvvəl bitir', route); break; }
          try { segs = book.get(msg.slot, msg.leg); }
          catch (e) { replayer.fail(msg.id, e.message, route); break; }
          rover.replay(msg.id, segs, route);
          console.log(`replay: ${route}`);
          break;
        }

        // The lift, from /follow's cargo run.
        case 'actuator':
          try { actuatorCommand(act, msg.action, msg.dir); }
          catch (e) { console.warn('actuator:', e.message); }
          break;

        // /follow reporting where the run has got to, for /map to draw.
        case 'mission_state':
          mission = msg.state || null;
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
          if (!competition.command(msg)) return;
      }
      send({ ack: msg.cmd });
    });

    ws.on('close', () => {
      clearInterval(pusher);
      rover.clientLeft();
      // The last page gone is a released dead-man for the lift too: nothing
      // is left that could show it running, or stop it.
      if (rover.clients === 0 && act.running) act.stop();
      if (rover.clients === 0 && runLog.active) {
        const done = runLog.stop();
        if (done) console.log(`saved on disconnect: ${path.basename(done.file)}`);
      }
      console.log(`browser gone: ${peer} -> stopped`);
    });
    ws.on('error', () => ws.close());
  });

  await new Promise((res) => server.listen(args.http, args.host, res));
  await radar.start();

  const shown = args.host === '0.0.0.0' ? 'localhost' : args.host;
  const base = `http://${shown}:${args.http}`;
  console.log(`\nRover control:  ${base}/`);
  console.log(`  drive by hand:  ${base}/gcode`);
  console.log(`  camera / line:  ${base}/vision`);
  console.log(`  follow a line:  ${base}/follow`);
  console.log(`  the field map:  ${base}/map`);
  console.log(`  dashboard:      ${base}/dashboard`);
  console.log(`  read a run back:${base}/tune`);
  console.log(`  lidar map:      ${base}/lidar`);
  console.log(`  plc / görev:    ${base}/plc`);
  console.log(`  pi pinleri:     ${base}/pins`);
  competition.banner();
  if (!camera.enabled) {
    console.log('camera: off (--no-camera)');
  } else {
    console.log(`camera: ${args.camera} @ ${args.camWidth}x${args.camHeight} `
      + `${args.camFps} fps  ->  ${base}/camera/stream.mjpg`);
  }
  console.log(!args.qr ? 'qr: off (--no-qr)'
    : qr.available ? 'qr: reading from the camera' : `qr: ${qr.error}`);
  console.log(`lift: GPIO${act.cfg.enPin} enable, GPIO${act.cfg.dirPin} direction`
    + (act.enabled ? '' : '  (dry — --no-actuator)'));
  console.log(`lidar: GPIO${lidar.cfg.pwmPin} ENA (PWM), GPIO${lidar.cfg.in1Pin} IN1, `
    + `GPIO${lidar.cfg.in2Pin} IN2 — ${lidar.volts} V = ${lidar.duty()} % of `
    + `${lidar.cfg.supplyV} V less ${lidar.cfg.dropV} V drop`
    + (lidar.enabled ? '' : '  (dry — --no-lidar)'));
  console.log(!radar.enabled ? 'radar: off (--no-radar)'
    : radar.err ? `radar: ${radar.err}`
    : `radar: lidar data on :${args.radarPort} — UDP, TCP, HTTP POST, WebSocket, TLS; `
      + 'LD06, JSON or "angle,distance" lines');
  lidarBanner(lidarMap, args);
  const lidarAd = await announceLidar(lidarMap, args);
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
  // Stop feeding the stream, drop anything queued, and give the machine a
  // moment to finish before the port closes.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nshutting down — letting the last move finish');
    competition.close();
    rover.close();
    clearInterval(buzzerTimer);
    buzzer.close();
    await gpio.close();
    jog.stop();
    rover.stop('shutting down');
    recorder.cancel();
    clearInterval(sysTimer);
    nav.close();
    act.stop();
    await act.settled();
    await lidar.close();
    await radar.close();
    for (const c of wss.clients) c.close();
    if (lidarSim) lidarSim.stop();
    // Goodbye packets before the socket goes, so a phone browsing right now
    // does not latch onto a relay that is already gone.
    if (lidarAd) await lidarAd.stop();
    lidarMap.close();
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

main().catch((err) => {
  console.error('fatal:', err.message || err);
  if (/cannot find module 'serialport'/i.test(String(err))) {
    console.error('run `npm install` first');
  }
  process.exit(1);
});
