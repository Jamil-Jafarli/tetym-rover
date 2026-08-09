// End-to-end tests, no hardware.
//
// Section 3 drives the real server over a real browser WebSocket, against a
// real simulated ESP32 WebSocket server (esp32ws_sim.js — the mirror of
// ws_dac.ino). So the whole chain is exercised:
//
//     browser WS -> server.js -> Bench -> WsTransport -> ESP32 -> DAC pins
//
//     npm test

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import fs from 'node:fs';

import * as esp from '../esp.js';
import { resolveKeys, DEFAULT_PRESETS } from '../bench.js';
import { summarise } from '../follow_log.js';
import { Esp32 } from '../esp32sim.js';
import { Esp32WsSim, dacFor } from '../esp32ws_sim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 8794;

let pass = true;
const check = (name, ok, detail = '') => {
  pass = pass && ok;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. the wifi board's own behaviour ────────────────────────────────
async function firmwareChecks() {
  console.log('\n1. ESP32 wifi firmware behaviour (ws_dac mirror)');
  const sim = new Esp32WsSim({ port: 8188, vMax: 3.3 });
  await sim.ready;
  try {
    check('idle on boot', sim.current25 === 1.0 && sim.current26 === 1.0);
    check('ENABLE pin is 0 on boot', sim.enableOut === false);
    check('both direction relays are 0 on boot',
      sim.revOut[0] === false && sim.revOut[1] === false);

    const ws = new WebSocket(sim.url);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    await sleep(60);
    check('a client that has not commanded yet leaves pins at idle',
      sim.current25 === 1.0 && sim.enableOut === false, `${sim.current25} V`);

    // Stream like the real client does, so the watchdog stays fed.
    let streaming = { v25: 2.0, v26: 1.4, en: true, r25: false, r26: false };
    const pump = setInterval(
      () => ws.send(JSON.stringify({ cmd: 'set', ...streaming })), 50);

    await sleep(400);
    check('volts land on both pins',
      Math.abs(sim.current25 - 2.0) < 0.02 && Math.abs(sim.current26 - 1.4) < 0.02,
      `25=${sim.current25.toFixed(2)} 26=${sim.current26.toFixed(2)}`);
    check('DAC codes use the firmware rounding',
      sim.status().dac25 === dacFor(2.0), `${sim.status().dac25}`);
    check('ENABLE pin is 1 while commanding en:true', sim.enableOut === true);

    streaming = { v25: 2.0, v26: 1.4, en: false, r25: false, r26: false };
    await sleep(200);
    check('en:false lowers ENABLE without touching the DACs',
      sim.enableOut === false && Math.abs(sim.current25 - 2.0) < 0.02,
      `en=${sim.enableOut ? 1 : 0} v25=${sim.current25.toFixed(2)}`);

    streaming = { v25: 2.0, v26: 1.4 };
    await sleep(200);
    check('a packet with no "en" field means 0, never 1', sim.enableOut === false);

    streaming = { v25: 9.9, v26: 0.1, en: true, r25: false, r26: false };
    await sleep(400);
    check('above V_MAX clamps', Math.abs(sim.current25 - 3.3) < 0.02,
      `${sim.current25.toFixed(2)} V`);
    check('below idle clamps to 1.00 V', Math.abs(sim.current26 - 1.0) < 1e-3,
      `${sim.current26.toFixed(2)} V`);

    const badBefore = sim.bad;
    ws.send('{not json');
    ws.send(JSON.stringify({ cmd: 'nonsense' }));
    await sleep(120);
    check('malformed messages are counted, not applied', sim.bad === badBefore + 2,
      `bad=${sim.bad}`);

    // Stop the stream: the 300 ms watchdog has to cut the output.
    streaming = { v25: 2.4, v26: 2.4, en: true, r25: false, r26: false };
    await sleep(300);
    check('driving again before the watchdog test',
      Math.abs(sim.current25 - 2.4) < 0.02, `${sim.current25.toFixed(2)} V`);
    clearInterval(pump);
    await sleep(200);
    check('still driving 200 ms after the last packet', !sim.atIdle);
    await sleep(300);
    check('watchdog cuts to idle after 300 ms',
      sim.atIdle && sim.current25 === 1.0 && sim.current26 === 1.0,
      `${sim.current25.toFixed(2)} V`);
    check('watchdog also drops ENABLE to 0', sim.enableOut === false);

    // Explicit stop, then disconnect.
    const pump2 = setInterval(
      () => ws.send(JSON.stringify({ cmd: 'set', v25: 2.0, v26: 2.0, en: true })), 50);
    await sleep(300);
    clearInterval(pump2);
    ws.send(JSON.stringify({ cmd: 'stop' }));
    await sleep(120);
    check('explicit stop idles both channels and ENABLE',
      sim.current25 === 1.0 && sim.current26 === 1.0 && sim.enableOut === false);

    const pump3 = setInterval(
      () => ws.send(JSON.stringify({ cmd: 'set', v25: 2.0, v26: 2.0, en: true })), 50);
    await sleep(300);
    clearInterval(pump3);
    ws.close();
    await sleep(200);
    check('client disconnect idles the pins immediately',
      sim.clients === 0 && sim.current25 === 1.0, `${sim.current25.toFixed(2)} V`);
    check('client disconnect drops ENABLE to 0', sim.enableOut === false);
    check('idle DAC code is never 0', dacFor(1.0) === 77, `${dacFor(1.0)}`);

    console.log('\n1b. direction relay interlock (the part that saves the MOSFETs)');
    const ws2 = new WebSocket(sim.url);
    await new Promise((res, rej) => { ws2.once('open', res); ws2.once('error', rej); });
    let drive = { v25: 2.4, v26: 2.4, en: true, r25: false, r26: false };
    const pumpD = setInterval(
      () => ws2.send(JSON.stringify({ cmd: 'set', ...drive })), 50);

    await sleep(450);
    check('driving forward before the request',
      sim.current25 > 2.0 && sim.revOut[0] === false, `${sim.current25.toFixed(2)} V`);

    // Ask for reverse WHILE the motor is at full throttle.
    drive = { ...drive, r25: true, r26: true };
    await sleep(120);
    check('relays do NOT move while the wheel is still turning',
      sim.revOut[0] === false && sim.revBlocked === true,
      `rev=${sim.revOut} blocked=${sim.revBlocked}`);
    check('outputs are forced to idle so the wheel can stop',
      sim.target25 === 1.0, `${sim.target25.toFixed(2)} V`);

    // Not yet — the settle timer has to elapse after reaching idle.
    await sleep(500);
    check('still blocked before the settle time is up', sim.revOut[0] === false);

    await sleep(900);
    check('both relays flip once stopped and settled',
      sim.revOut[0] === true && sim.revOut[1] === true);
    check('no longer blocked', sim.revBlocked === false);

    await sleep(400);
    check('throttle is released again after the flip',
      sim.current25 > 2.0, `${sim.current25.toFixed(2)} V`);

    // And back to forward, same rules.
    // A pivot moves only one relay — same interlock applies.
    drive = { ...drive, r25: true, r26: false };
    await sleep(150);
    check('a one-wheel pivot is interlocked too', sim.revBlocked === true);
    await sleep(1500);
    check('pivot: only GPIO25 reversed',
      sim.revOut[0] === true && sim.revOut[1] === false, `${sim.revOut}`);

    drive = { ...drive, r25: false, r26: false };
    await sleep(1500);
    check('returns to forward after settling',
      sim.revOut[0] === false && sim.revOut[1] === false);

    clearInterval(pumpD);
    ws2.close();
    await sleep(150);
  } finally {
    await sim.close();
  }
}

// ── 2. USB wire format ───────────────────────────────────────────────
function serialProtocolChecks() {
  console.log('\n2. USB wire format (throttle_dac_2ch mirror)');
  const dev = new Esp32();

  const { frame } = esp.pack2(1.8, 1.45);
  check('dual-channel frame is 10 bytes', frame.length === 10, `${frame.length}`);
  dev.feed(frame, 1000);
  check('decodes to the right volts',
    Math.abs(dev.vl - 1.8) < 1e-3 && Math.abs(dev.vr - 1.45) < 1e-3,
    `L=${dev.vl.toFixed(2)} R=${dev.vr.toFixed(2)}`);

  dev.feed(esp.pack(2.2).frame, 1010);
  check('legacy 0xA5 frame drives both channels',
    Math.abs(dev.vl - 2.2) < 1e-3 && Math.abs(dev.vr - 2.2) < 1e-3);

  const good = dev.good;
  const bad = Buffer.from(frame);
  bad[3] ^= 0xff;
  dev.feed(bad, 1020);
  check('corrupted frame rejected by the checksum',
    dev.good === good && dev.bad === 1);

  // A false header byte in garbage eats the next frame; the one after re-locks.
  dev.feed(Buffer.from([0x11, 0x22, 0x33, 0xa5, 0xa5]), 1030);
  dev.feed(esp.pack2(1.5, 1.5).frame, 1040);
  dev.feed(esp.pack2(1.5, 1.5).frame, 1050);
  check('parser re-locks within 2 frames after garbage',
    Math.abs(dev.vl - 1.5) < 1e-3, `L=${dev.vl.toFixed(2)}`);

  dev.tick(1050 + 200);
  check('still driving 200 ms after the last packet', !dev.atIdle);
  dev.tick(1050 + 400);
  check('watchdog drops to idle after 300 ms',
    dev.atIdle && dev.vl === esp.V_IDLE && dev.vr === esp.V_IDLE);

  check('above V_MAX clamps', esp.pack2(9.9, 9.9).vl === esp.V_MAX);
  check('below idle clamps', esp.pack2(0.1, 0.1).vl === esp.V_MIN);
  check('NaN falls back to the floor', esp.clamp(NaN) === esp.V_MIN);
  check('dacFor is the firmware rounding', esp.dacFor(1.0) === 77, `${esp.dacFor(1.0)}`);

  console.log('\n2b. percent <-> volts');
  check('0 % is idle', esp.pctToVolts(0, 2.6) === 1.0);
  check('100 % is the ceiling', esp.pctToVolts(100, 2.6) === 2.6);
  check('50 % is halfway', Math.abs(esp.pctToVolts(50, 2.6) - 1.8) < 1e-9,
    `${esp.pctToVolts(50, 2.6)}`);
  check('over 100 % clamps', esp.pctToVolts(500, 2.6) === 2.6);
  check('negative clamps to idle', esp.pctToVolts(-20, 2.6) === 1.0);
  check('garbage clamps to idle', esp.pctToVolts('abc', 2.6) === 1.0);
  check('round-trips back to percent',
    Math.abs(esp.voltsToPct(esp.pctToVolts(37, 2.6), 2.6) - 37) < 1e-9);
  check('report parser reads both channels', (() => {
    const r = esp.parseReport('v=2.00 dac=155 rx=282 pkt=47 bad=0 '
      + 'vL=2.00 vR=1.60 dacL=155 dacR=124');
    return r && r.vR === 1.6 && r.dacR === 124 && r.pkt === 47;
  })());
  check('single-channel log line still parses', (() => {
    const r = esp.parseReport('v=2.00 dac=155 rx=282 pkt=47 bad=0');
    return r && r.vR === 2.0 && r.dacR === 155;
  })());
}

// ── 2c. key -> percent resolution ────────────────────────────────────
function keyChecks() {
  console.log('\n2c. keyboard mapping');
  const P = DEFAULT_PRESETS;
  const dirOf = (keys) => resolveKeys(keys, P)[2];
  const pctOf = (keys) => resolveKeys(keys, P).slice(0, 2);
  const comboOf = (keys) => resolveKeys(keys, P)[3];

  check('W is forward: both wheels equal, neither reversed',
    pctOf(['w'])[0] === pctOf(['w'])[1]
    && JSON.stringify(dirOf(['w'])) === '[false,false]');

  check('A reverses exactly one wheel — that is the pivot',
    JSON.stringify(dirOf(['a'])) === '[true,false]', JSON.stringify(dirOf(['a'])));
  check('D reverses the other one',
    JSON.stringify(dirOf(['d'])) === '[false,true]', JSON.stringify(dirOf(['d'])));
  check('A and D are mirror images', JSON.stringify(dirOf(['a']).slice().reverse())
    === JSON.stringify(dirOf(['d'])));
  check('a pivot drives BOTH wheels — the turn comes from direction, not speed',
    pctOf(['a'])[0] > 0 && pctOf(['a'])[1] > 0, `${pctOf(['a'])}`);

  check('S reverses both wheels — straight back',
    JSON.stringify(dirOf(['s'])) === '[true,true]', JSON.stringify(dirOf(['s'])));
  check('S drives both wheels equally', pctOf(['s'])[0] === pctOf(['s'])[1]);

  check('W+A keeps both wheels forward — safe to use while moving',
    JSON.stringify(dirOf(['w', 'a'])) === '[false,false]');
  check('W+D too', JSON.stringify(dirOf(['w', 'd'])) === '[false,false]');
  check('W+A turns by speed instead', pctOf(['w', 'a'])[0] !== pctOf(['w', 'a'])[1]);
  check('W+A and W+D are mirror images',
    pctOf(['w', 'a'])[0] === pctOf(['w', 'd'])[1]
    && pctOf(['w', 'a'])[1] === pctOf(['w', 'd'])[0]);

  check('W+A uses the wa row, not w', comboOf(['w', 'a']) === 'wa', `${comboOf(['w','a'])}`);
  check('W+D uses the wd row', comboOf(['d', 'w']) === 'wd');
  check('no keys means zero and forward',
    JSON.stringify(pctOf([])) === '[0,0]' && JSON.stringify(dirOf([])) === '[false,false]');
  check('unknown keys are ignored', JSON.stringify(pctOf(['q', 'z'])) === '[0,0]');
  check('key order does not matter', comboOf(['a', 'w']) === comboOf(['w', 'a']));
}

// ── 3. the whole stack, browser to pins ──────────────────────────────
async function serverChecks() {
  console.log('\n3. full stack: browser -> server -> wifi -> ESP32');
  const srv = spawn(process.execPath,
    [path.join(HERE, '..', 'server.js'), '--fake', '--esp', 'sim',
      '--http', String(HTTP_PORT), '--host', '127.0.0.1', '--v-max', '2.6'],
    { stdio: ['ignore', 'pipe', 'pipe'] });

  let log = '';
  srv.stdout.on('data', (d) => { log += d.toString(); });
  srv.stderr.on('data', (d) => { log += d.toString(); });

  try {
    for (let i = 0; i < 80 && !log.includes('ESP32 DAC bench'); i++) await sleep(100);
    check('server started', log.includes('ESP32 DAC bench'));
    check('connected to the board', log.includes('esp32 connected'));

    const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));

    const waitAck = async (ack, timeout = 2000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const i = inbox.findIndex((m) => m.type === 'status' && m.ack === ack);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await sleep(20);
      }
      throw new Error(`no ack for "${ack}"`);
    };
    // Board status is pushed at 10 Hz and the value ramps, so give the whole
    // loop a few cycles before asserting on what the pins actually did.
    const settled = async () => { inbox.length = 0; await sleep(500);
      return inbox[inbox.length - 1]; };

    // --v-max 2.6, so 0 % = 1.00 V and 100 % = 2.60 V.
    const vAt = (pct) => 1.0 + (pct / 100) * (2.6 - 1.0);

    ws.send(JSON.stringify({ cmd: 'set', p25: 60, p26: 25 }));
    let s = await waitAck('set');
    check('percent setpoint stored', s.set[0] === 60 && s.set[1] === 25,
      JSON.stringify(s.set));
    s = await settled();
    check('nothing reaches the pins until START',
      s.esp.vL === 1.0 && s.esp.vR === 1.0, `25=${s.esp.vL} 26=${s.esp.vR}`);
    check('ENABLE is 0 before START', s.esp.en === false);

    ws.send(JSON.stringify({ cmd: 'start' }));
    await waitAck('start');
    s = await settled();
    check('START drives the ENABLE pin to 1', s.esp.en === true);
    check('ENABLE pin is reported as GPIO23', s.esp.en_pin === 23, `${s.esp.en_pin}`);
    check('GPIO25 lands at 60 %', Math.abs(s.esp.vL - vAt(60)) < 0.03,
      `${s.esp.vL} V, want ${vAt(60).toFixed(2)}`);
    check('GPIO26 lands at 25 %', Math.abs(s.esp.vR - vAt(25)) < 0.03,
      `${s.esp.vR} V, want ${vAt(25).toFixed(2)}`);
    check('percent is echoed back from the board reading',
      Math.abs(s.esp.pL - 60) < 2 && Math.abs(s.esp.pR - 25) < 2,
      `${s.esp.pL}% / ${s.esp.pR}%`);

    ws.send(JSON.stringify({ cmd: 'set', p25: 100, p26: 0 }));
    await waitAck('set');
    s = await settled();
    check('100 % is the ceiling', Math.abs(s.esp.vL - 2.6) < 0.03, `${s.esp.vL} V`);
    check('0 % is idle volts', Math.abs(s.esp.vR - 1.0) < 1e-3, `${s.esp.vR} V`);
    check('0 % does NOT drop ENABLE — that is what STOP is for',
      s.esp.en === true);

    ws.send(JSON.stringify({ cmd: 'set', p25: 500, p26: -40 }));
    await waitAck('set');
    s = await settled();
    check('out-of-range percent is clamped, not rejected',
      Math.abs(s.esp.vL - 2.6) < 0.03 && Math.abs(s.esp.vR - 1.0) < 1e-3,
      `25=${s.esp.vL} 26=${s.esp.vR}`);

    ws.send(JSON.stringify({ cmd: 'stop' }));
    await waitAck('stop');
    s = await settled();
    check('STOP idles both pins', s.esp.vL === 1.0 && s.esp.vR === 1.0);
    check('STOP drops ENABLE back to 0', s.esp.en === false);
    check('board telemetry reaches the page', s.esp.pkt > 0 && s.esp_fresh,
      `pkt=${s.esp.pkt}`);
    check('no malformed packets over the whole run', s.esp.bad === 0,
      `bad=${s.esp.bad}`);

    console.log('\n4. the browser tab closes while running');
    ws.send(JSON.stringify({ cmd: 'start', p25: 75, p26: 75 }));
    await waitAck('start');
    s = await settled();
    check('running before the drop', Math.abs(s.esp.vL - vAt(75)) < 0.03,
      `${s.esp.vL} V`);
    check('ENABLE is 1 before the drop', s.esp.en === true);

    ws.close();
    await sleep(500);
    check('server logged the drop to idle', log.includes('-> idle'));

    const ws2 = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/`);
    await new Promise((res, rej) => { ws2.once('open', res); ws2.once('error', rej); });
    const seen = [];
    ws2.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
    await sleep(500);
    const s2 = seen[seen.length - 1];
    check('reconnect comes back stopped, not running', s2.running === false);
    check('pins are at idle after the disconnect', s2.esp.vL === 1.0, `${s2.esp.vL} V`);
    check('ENABLE is back to 0 after the disconnect', s2.esp.en === false);
    ws2.close();
  } finally {
    srv.kill('SIGINT');
    await sleep(500);
    srv.kill('SIGKILL');
  }
}

// ── 5. the drive page, end to end ────────────────────────────────────
async function driveChecks() {
  console.log('\n5. keyboard drive page: browser -> server -> ESP32');
  const port = HTTP_PORT + 1;
  const srv = spawn(process.execPath,
    [path.join(HERE, '..', 'server.js'), '--fake', '--esp', 'sim',
      '--http', String(port), '--host', '127.0.0.1', '--v-max', '2.6'],
    { stdio: ['ignore', 'pipe', 'pipe'] });

  let log = '';
  srv.stdout.on('data', (d) => { log += d.toString(); });
  srv.stderr.on('data', (d) => { log += d.toString(); });

  try {
    for (let i = 0; i < 80 && !log.includes('ESP32 DAC bench'); i++) await sleep(100);
    check('drive page is routed', log.includes('/drive'));

    const page = await fetch(`http://127.0.0.1:${port}/drive`);
    const html = await page.text();
    check('GET /drive serves the page', page.status === 200 && html.includes('Keyboard Drive'));

    // Every route the hub links to must actually exist, or the nav is a lie.
    for (const [route, needle] of [['/', 'Robot idarəetmə'],
                                   ['/manual', 'ESP32 actual'],
                                   ['/vision', 'Trek növü'],
                                   ['/follow', 'Yolu təqib et'],
                                   ['/tune', 'Qeydi oxu'],
                                   ['/sonar', '360° xəritə'],
                                   ['/obstacle', 'Maneədə dayan']]) {
      const r = await fetch(`http://127.0.0.1:${port}${route}`);
      const t = await r.text();
      check(`GET ${route} serves its page`, r.status === 200 && t.includes(needle),
        `${r.status}`);
    }
    const miss = await fetch(`http://127.0.0.1:${port}/nope`);
    check('unknown route still 404s', miss.status === 404, `${miss.status}`);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));

    const waitAck = async (ack, timeout = 2000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const i = inbox.findIndex((m) => m.type === 'status' && m.ack === ack);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await sleep(20);
      }
      throw new Error(`no ack for "${ack}"`);
    };
    const settled = async () => { inbox.length = 0; await sleep(500);
      return inbox[inbox.length - 1]; };

    const vAt = (pct) => 1.0 + (pct / 100) * (2.6 - 1.0);
    // The drive page reports key state at 20 Hz — that is the dead-man.
    let holding = [];
    const pump = setInterval(
      () => ws.send(JSON.stringify({ cmd: 'keys', keys: holding })), 50);

    ws.send(JSON.stringify({ cmd: 'start' }));
    await waitAck('start');

    holding = ['w'];
    let s = await settled();
    check('W drives both wheels forward',
      Math.abs(s.esp.vL - vAt(DEFAULT_PRESETS.w.p[0])) < 0.03
      && Math.abs(s.esp.vR - vAt(DEFAULT_PRESETS.w.p[1])) < 0.03,
      `${s.esp.vL} / ${s.esp.vR} V`);
    check('server reports the resolved combo', s.combo === 'w', `${s.combo}`);
    check('ENABLE is 1 while driving', s.esp.en === true);

    // A is a pivot now: it moves a direction relay, so the robot must stop
    // first. Section 6 follows that through; here we only check it pauses.
    holding = ['a'];
    await sleep(300);
    s = inbox[inbox.length - 1];
    check('A asks for a pivot and holds the wheels at zero first',
      JSON.stringify(s.dir_want) === '[true,false]' && s.out[0] === 0,
      `${JSON.stringify(s.dir_want)} out=${s.out}`);

    holding = ['w'];
    await sleep(2000);

    holding = ['w', 'a'];
    s = await settled();
    check('W+A picks the wa row', s.combo === 'wa', `${s.combo}`);
    check('W+A turns by speed alone — no pause, no relay',
      s.esp.vL > 1.0 && s.esp.vR > 1.0 && s.esp.vL > s.esp.vR
      && s.dir_settling === false,
      `${s.esp.vL} / ${s.esp.vR} V`);

    holding = [];
    s = await settled();
    check('releasing every key coasts to 0 %',
      s.esp.vL === 1.0 && s.esp.vR === 1.0, `${s.esp.vL} / ${s.esp.vR} V`);
    check('but stays enabled, ready for the next key', s.esp.en === true);

    // Retune mid-drive.
    ws.send(JSON.stringify({ cmd: 'presets', presets: { w: { p: [90, 20] } } }));
    await waitAck('presets');
    holding = ['w'];
    s = await settled();
    check('edited preset applies immediately',
      Math.abs(s.esp.vL - vAt(90)) < 0.03 && Math.abs(s.esp.vR - vAt(20)) < 0.03,
      `${s.esp.vL} / ${s.esp.vR} V`);
    check('edited preset is echoed in the status',
      JSON.stringify(s.presets.w.p) === '[90,20]', JSON.stringify(s.presets.w.p));
    check('editing percent leaves the direction alone',
      JSON.stringify(s.presets.w.r) === '[false,false]');
    check('other rows are untouched',
      JSON.stringify(s.presets.a) === JSON.stringify(DEFAULT_PRESETS.a));

    ws.send(JSON.stringify({ cmd: 'presets', presets: { d: { p: [500, -30] } } }));
    await waitAck('presets');
    s = await settled();
    check('out-of-range preset values are clamped',
      JSON.stringify(s.presets.d.p) === '[100,0]', JSON.stringify(s.presets.d.p));

    // ── master level ───────────────────────────────────────────────
    console.log('\n6. master level');
    ws.send(JSON.stringify({ cmd: 'presets', presets: { w: { p: [80, 80] } } }));
    await waitAck('presets');
    holding = ['w'];
    s = await settled();
    check('level starts at 100 %', s.level === 100, `${s.level}`);
    check('at 100 % the preset goes out unscaled',
      Math.abs(s.esp.vL - vAt(80)) < 0.03, `${s.esp.vL} V`);

    ws.send(JSON.stringify({ cmd: 'level', level: 50 }));
    await waitAck('level');
    s = await settled();
    check('level 50 % halves the output',
      Math.abs(s.esp.vL - vAt(40)) < 0.03, `${s.esp.vL} V, want ${vAt(40).toFixed(2)}`);
    check('the raw preset is untouched',
      JSON.stringify(s.presets.w.p) === '[80,80]', JSON.stringify(s.presets.w.p));
    check('out reports the scaled percent, set reports the raw',
      s.out[0] === 40 && s.set[0] === 80, `out=${s.out[0]} set=${s.set[0]}`);

    ws.send(JSON.stringify({ cmd: 'level', level: 0 }));
    await waitAck('level');
    s = await settled();
    check('level 0 % means nothing moves',
      s.esp.vL === 1.0 && s.esp.vR === 1.0, `${s.esp.vL} V`);
    check('but the driver stays enabled at level 0', s.esp.en === true);
    check('reason explains it', s.reason === 'level 0 %', s.reason);

    ws.send(JSON.stringify({ cmd: 'level', level: 500 }));
    await waitAck('level');
    s = await settled();
    check('level clamps to 100 %', s.level === 100, `${s.level}`);

    ws.send(JSON.stringify({ cmd: 'level', level: 25 }));
    await waitAck('level');
    holding = ['wa'.split('')[0], 'a'];   // W+A: a speed turn, no relay pause
    s = await settled();
    check('level scales a turn preset too, keeping the ratio',
      Math.abs(s.esp.vL - vAt(0.25 * s.presets.wa.p[0])) < 0.03
      && Math.abs(s.esp.vR - vAt(0.25 * s.presets.wa.p[1])) < 0.03,
      `${s.esp.vL} / ${s.esp.vR} V`);
    ws.send(JSON.stringify({ cmd: 'level', level: 100 }));
    await waitAck('level');
    holding = ['w'];

    // The dead-man: stop reporting entirely while a key is still "down".
    holding = ['w'];
    await settled();
    clearInterval(pump);
    await sleep(900);
    s = inbox[inbox.length - 1];
    check('page goes quiet -> coasts to 0 % without waiting for a keyup',
      s.esp.vL === 1.0 && s.esp.vR === 1.0, `${s.esp.vL} V`);
    check('reason says so', s.reason === 'no keys held', s.reason);

    console.log('\n6. direction through the whole stack (A / D / S)');
    // The dead-man test above stopped the key pump; bring it back.
    const pump2 = setInterval(
      () => ws.send(JSON.stringify({ cmd: 'keys', keys: holding })), 50);
    ws.send(JSON.stringify({ cmd: 'presets', presets: { w: { p: [55, 55] } } }));
    await waitAck('presets');
    holding = ['w'];
    await settled();

    // ── S: both wheels backwards ──────────────────────────────────
    holding = ['s'];
    await sleep(300);
    s = inbox[inbox.length - 1];
    check('S asks for both wheels reversed',
      JSON.stringify(s.dir_want) === '[true,true]', JSON.stringify(s.dir_want));
    check('while settling the output is held at zero',
      s.out[0] === 0 && s.out[1] === 0, `${s.out}`);
    check('reason tells the user why it paused', /back/i.test(s.reason), s.reason);
    check('the driver stays enabled through the change', s.esp.en === true);

    await sleep(1600);
    s = inbox[inbox.length - 1];
    check('both relays flipped after the settle',
      JSON.stringify(s.esp.rev) === '[true,true]', JSON.stringify(s.esp.rev));
    check('direction pins reported as GPIO19 / GPIO18',
      JSON.stringify(s.esp.rev_pin) === '[19,18]', JSON.stringify(s.esp.rev_pin));
    await sleep(600);
    s = inbox[inbox.length - 1];
    check('then it actually drives backwards',
      s.esp.vL > 1.0 && s.esp.vR > 1.0, `${s.esp.vL} / ${s.esp.vR} V`);

    // ── A: pivot, one wheel only ──────────────────────────────────
    holding = ['a'];
    await sleep(2400);
    s = inbox[inbox.length - 1];
    check('A leaves exactly one relay pulled in',
      JSON.stringify(s.esp.rev) === '[true,false]', JSON.stringify(s.esp.rev));
    await sleep(600);
    s = inbox[inbox.length - 1];
    check('both wheels still driven during a pivot',
      s.esp.vL > 1.0 && s.esp.vR > 1.0, `${s.esp.vL} / ${s.esp.vR} V`);

    // ── D: the mirror image ───────────────────────────────────────
    holding = ['d'];
    await sleep(2400);
    s = inbox[inbox.length - 1];
    check('D pivots the other way',
      JSON.stringify(s.esp.rev) === '[false,true]', JSON.stringify(s.esp.rev));

    // ── W+A: a rolling turn must NOT touch the relays ─────────────
    holding = ['w'];
    await sleep(2400);
    const before = JSON.stringify(s.esp.rev);
    holding = ['w', 'a'];
    await sleep(600);
    s = inbox[inbox.length - 1];
    check('W+A never moves a relay — usable while rolling',
      JSON.stringify(s.esp.rev) === '[false,false]' && s.dir_settling === false,
      JSON.stringify(s.esp.rev));
    check('and it keeps driving, no pause',
      s.out[0] > 0 && s.out[1] > 0 && s.out[0] !== s.out[1], `${s.out}`);

    holding = [];
    clearInterval(pump2);
    ws.send(JSON.stringify({ cmd: 'idle' }));
    await waitAck('idle');
    s = await settled();
    check('STOP drops ENABLE to 0', s.esp.en === false);
    check('STOP also asks for forward',
      JSON.stringify(s.dir_want) === '[false,false]', JSON.stringify(s.dir_want));
    ws.close();
  } finally {
    srv.kill('SIGINT');
    await sleep(500);
    srv.kill('SIGKILL');
  }
}


// ── 6. the follow page: vision drives the motors ─────────────────────
// The page itself is checked in test_vision / test_pilot; what is checked here
// is the part that can actually run a robot into a wall — the command path and
// the dead-man behind it.
async function followChecks() {
  console.log('\n6. follow page: vision -> server -> ESP32, and the run log');
  const port = HTTP_PORT + 2;
  const logDir = path.join(HERE, '..', 'logs');
  const before = new Set(fs.existsSync(logDir) ? fs.readdirSync(logDir) : []);
  const cfgFile = path.join(HERE, '..', 'follow.json');
  const hadCfg = fs.existsSync(cfgFile)
    ? fs.readFileSync(cfgFile, 'utf8') : null;

  const srv = spawn(process.execPath,
    [path.join(HERE, '..', 'server.js'), '--fake', '--esp', 'sim',
      '--http', String(port), '--host', '127.0.0.1', '--v-max', '2.6'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d.toString(); });
  srv.stderr.on('data', (d) => { log += d.toString(); });

  try {
    for (let i = 0; i < 80 && !log.includes('ESP32 DAC bench'); i++) await sleep(100);

    // The two pages share their detector, so the script has to be reachable.
    for (const [route, needle] of [['/road.js', 'function detect'],
                                   ['/pilot.js', 'function pilotStep'],
                                   ['/analyse.js', 'function analyse'],
                                   ['/sonar.js', 'function obstacleStep']]) {
      const r = await fetch(`http://127.0.0.1:${port}${route}`);
      const t = await r.text();
      check(`GET ${route} serves the shared script`,
        r.status === 200 && t.includes(needle)
        && /javascript/.test(r.headers.get('content-type') || ''),
        `${r.status} ${r.headers.get('content-type')}`);
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
    const last = () => inbox[inbox.length - 1];

    ws.send(JSON.stringify({ cmd: 'level', level: 100 }));
    ws.send(JSON.stringify({ cmd: 'start' }));
    await sleep(200);

    // A steady stream, the way the page sends it.
    let cmd = { p25: 40, p26: 20 };
    const pump = setInterval(
      () => ws.send(JSON.stringify({ cmd: 'follow', ...cmd, reason: 'düz yol' })), 50);
    await sleep(500);

    let s = last();
    check('follow percentages reach the board',
      Math.abs(s.out[0] - 40) < 0.5 && Math.abs(s.out[1] - 20) < 0.5, `${s.out}`);
    check('the board is actually driven',
      s.esp.vL > 1.0 && s.esp.vR > 1.0 && s.esp.vL > s.esp.vR,
      `${s.esp.vL} / ${s.esp.vR} V`);
    check('ENABLE is up while following', s.esp.en === true);
    check('following never moves a direction relay',
      JSON.stringify(s.esp.rev) === '[false,false]' && s.dir_settling === false,
      JSON.stringify(s.esp.rev));
    check('status says which page is driving and why',
      s.follow === true && s.reason.startsWith('follow:'), s.reason);

    // The master level belongs to the drive page. On /follow the pilot's own
    // ceiling is the limit, so 100 % means --v-max and nothing silently halves
    // the number you tuned.
    ws.send(JSON.stringify({ cmd: 'level', level: 50 }));
    await sleep(300);
    s = last();
    check('the master level does NOT scale the pilot',
      Math.abs(s.out[0] - 40) < 0.5, `${s.out[0]} %`);
    ws.send(JSON.stringify({ cmd: 'level', level: 0 }));
    await sleep(300);
    s = last();
    check('...not even at level 0 — one limit per path',
      Math.abs(s.out[0] - 40) < 0.5 && s.esp.vL > 1.0, `${s.out[0]} % / ${s.esp.vL} V`);
    ws.send(JSON.stringify({ cmd: 'level', level: 100 }));

    // 100 % has to be the real ceiling, or "max speed" is a number that means
    // nothing. --v-max is 2.6 in this run.
    cmd = { p25: 100, p26: 100 };
    await sleep(400);
    s = last();
    check('100 % is --v-max on the pin, not a fraction of it',
      Math.abs(s.esp.vL - 2.6) < 0.02 && Math.abs(s.out_v[0] - 2.6) < 0.02,
      `${s.esp.vL} V`);
    cmd = { p25: 40, p26: 20 };
    await sleep(200);

    // ── the dead-man: a frozen camera is a stopped robot ──────────
    clearInterval(pump);
    await sleep(700);
    s = last();
    check('no frames for 400 ms coasts to 0 %', s.out[0] === 0 && s.out[1] === 0,
      `${s.out}`);
    check('...and says so', s.reason === 'kadr gəlmir', s.reason);
    check('...but ENABLE stays up, so a dropped frame costs no relay cycle',
      s.enable === true);
    check('the board really is back at idle',
      Math.abs(s.esp.vL - 1.0) < 0.02, `${s.esp.vL} V`);

    // ── a hand on the keyboard beats the pilot ────────────────────
    ws.send(JSON.stringify({ cmd: 'keys', keys: ['w'] }));
    await sleep(200);
    s = last();
    check('pressing a key takes the robot off the pilot', s.follow === false);

    // ── the run log ───────────────────────────────────────────────
    ws.send(JSON.stringify({ cmd: 'log_start', meta: {
      note: 'test lap', pilot: { base: 34 }, calib: { pct: 50, metres: 3, seconds: 4 },
    } }));
    await sleep(200);
    s = last();
    check('recording starts and is reported back',
      s.log.active === true && /^follow-.*\.json$/.test(s.log.file), s.log.file);

    ws.send(JSON.stringify({ cmd: 'log', rows: [
      { t: 0,   err: 0,    speed: 20, lost: false, dist: 0 },
      { t: 100, err: 0.4,  speed: 18, lost: false, dist: 0.3 },
      { t: 200, err: null, speed: 9,  lost: true,  dist: 0.4 },
      { t: 300, err: 0.1,  speed: 22, lost: false, dist: 0.6 },
    ] }));
    await sleep(300);
    check('rows are counted while the run is live', last().log.rows === 4,
      `${last().log.rows}`);

    ws.send(JSON.stringify({ cmd: 'log_stop' }));
    await sleep(400);
    check('recording stops', last().log.active === false);

    const made = fs.readdirSync(logDir).filter((f) => !before.has(f));
    check('a run file was written', made.length === 1, made.join(','));
    const run = JSON.parse(fs.readFileSync(path.join(logDir, made[0]), 'utf8'));
    check('the file is valid JSON with every row in it', run.rows.length === 4);
    check('it records what the run was flown with',
      run.pilot.base === 34 && run.note === 'test lap' && run.vmax === 2.6,
      `${run.vmax}`);
    check('it records the calibration behind the distance',
      run.calib.metres === 3, JSON.stringify(run.calib));
    check('and a summary you can read without a script',
      run.summary.rows === 4 && run.summary.duration_s === 0.3
      && run.summary.lost_events === 1 && run.summary.distance_m === 0.6,
      JSON.stringify(run.summary));
    // ── /tune has to be able to find the run it just recorded ─────
    {
      const list = await (await fetch(`http://127.0.0.1:${port}/logs`)).json();
      check('GET /logs lists the runs, newest first',
        Array.isArray(list.files) && list.files.includes(made[0]),
        `${list.files.length} file(s)`);
      const one = await fetch(`http://127.0.0.1:${port}/logs/${made[0]}`);
      const body = await one.json();
      check('GET /logs/<name> serves the run itself',
        one.status === 200 && body.rows.length === 4
        && /json/.test(one.headers.get('content-type') || ''), `${one.status}`);
      // No authentication on this server, so the name is validated rather than
      // pasted into a path.
      for (const bad of ['..%2F..%2Fserver.js', 'follow-x.json%00', 'presets.json',
                         '..%2Fpackage.json']) {
        const r = await fetch(`http://127.0.0.1:${port}/logs/${bad}`);
        check(`/logs/${bad} is refused`, r.status === 404, `${r.status}`);
      }
    }

    // ── the run records what it was made of ───────────────────────
    check('the run file says what the lap was made of',
      Array.isArray(run.segments) && run.segments.length > 0
      && run.segments.every((g) => typeof g.kind === 'string'),
      JSON.stringify(run.segments?.map((g) => g.kind)));

    // ── the sliders survive a reload ──────────────────────────────
    ws.send(JSON.stringify({ cmd: 'follow_cfg',
      cfg: { pilot: { base: 41, kP: 1.1 }, calib: { pct: 60 } } }));
    await sleep(300);
    check('follow settings come back in the status',
      last().follow_cfg.pilot.base === 41, JSON.stringify(last().follow_cfg.pilot));
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    check('...and are on disk, so a reload keeps them',
      saved.pilot.kP === 1.1 && saved.calib.pct === 60, JSON.stringify(saved));

    ws.send(JSON.stringify({ cmd: 'stop' }));
    await sleep(200);
    check('STOP drops ENABLE', last().esp.en === false);
    ws.close();
    // Tidy up after ourselves, but never fail the suite over housekeeping.
    try { fs.unlinkSync(path.join(logDir, made[0])); } catch { /* leave it */ }
  } finally {
    srv.kill('SIGINT');
    await sleep(500);
    srv.kill('SIGKILL');
    try {
      if (hadCfg === null) fs.unlinkSync(cfgFile);
      else fs.writeFileSync(cfgFile, hadCfg);
    } catch { /* housekeeping only */ }
  }
}

// ── 6b. the two HC-SR04s ─────────────────────────────────────────────
// The sensors themselves cannot be tested without hardware; what can be, and
// what matters, is that a reading gets from the board to the page unmangled and
// that spinning the servo is not mistaken for driving.
async function sonarChecks() {
  console.log('\n6b. sonar: two HC-SR04s and the servo that spins one');
  const sim = new Esp32WsSim({ port: 8189, vMax: 3.3 });
  await sim.ready;
  try {
    // A room: a wall 80 cm ahead, something close on the left, and a window
    // straight behind that swallows the ping entirely.
    sim.world = (ang) => {
      if (ang > 160 && ang < 200) return null;      // no echo comes back
      if (ang > 250 && ang < 290) return 22;        // the near thing
      return 80;
    };

    const ws = new WebSocket(sim.url);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const seen = [];
    ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
    const last = () => seen[seen.length - 1];

    // Keep the drive watchdog fed so the board stays alive while we scan.
    const pump = setInterval(
      () => ws.send(JSON.stringify({ cmd: 'set', v25: 1.0, v26: 1.0 })), 50);
    await sleep(250);

    let s = last();
    check('the board reports its sonar pins', s.son && s.son.pin.servo === 13
      && s.son.pin.trig_f === 14, JSON.stringify(s.son && s.son.pin));
    check('the forward sensor reads without being asked', s.son.fwd_cm === 80,
      `${s.son.fwd_cm} cm`);
    check('the scan servo is stopped until told otherwise', s.son.spin === 0);

    // ── spinning ──
    ws.send(JSON.stringify({ cmd: 'scan', spin: 100 }));
    await sleep(120);
    check('scan is its own command, not a drive packet', last().son.spin === 100,
      `${last().son.spin}`);
    check('...and it does not disturb the outputs',
      Math.abs(sim.current25 - 1.0) < 0.02 && sim.enableOut === false);

    // Let it go round twice and collect what the page would collect.
    const grabbed = [];
    let lastT = -1;
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      const son = last().son;
      if (son.scan_t !== lastT) { lastT = son.scan_t; grabbed.push(son); }
    }
    check('readings arrive stamped with the rotation behind them',
      grabbed.length > 20 && grabbed.every((g) => Number.isFinite(g.scan_t)),
      `${grabbed.length} readings`);
    check('the stamp only ever moves forward',
      grabbed.every((g, i) => i === 0 || g.scan_t >= grabbed[i - 1].scan_t));
    check('a direction with no echo comes back as null, not as zero',
      grabbed.some((g) => g.scan_cm === null),
      `${grabbed.filter((g) => g.scan_cm === null).length} silent`);
    check('the near object is seen at all', grabbed.some((g) => g.scan_cm === 22));

    // ── stopping ──
    ws.send(JSON.stringify({ cmd: 'scan', spin: 0 }));
    await sleep(120);
    const frozen = last().son.scan_t;
    await sleep(300);
    check('stopping the servo freezes the angle rather than resetting it',
      last().son.scan_t === frozen && frozen > 0, `${last().son.scan_t}`);

    // Restarting must carry on from where it stopped: zeroing here would rotate
    // the whole map by however long the pause was.
    ws.send(JSON.stringify({ cmd: 'scan', spin: 100 }));
    await sleep(200);
    check('restarting carries on from the same angle', last().son.scan_t > frozen,
      `${frozen} → ${last().son.scan_t}`);

    ws.send(JSON.stringify({ cmd: 'scan', spin: 0 }));
    clearInterval(pump);
    ws.close();
  } finally {
    await sim.close();
  }
}

// ── 6c. reachable from the network ───────────────────────────────────
// Every other test binds to 127.0.0.1 on purpose, so this is the one place the
// default is exercised: no --host, which means every interface, which is what
// lets a phone on the same wifi open the pages at all.
async function networkChecks() {
  console.log('\n6c. reachable from other machines');
  const port = HTTP_PORT + 3;
  const srv = spawn(process.execPath,
    [path.join(HERE, '..', 'server.js'), '--fake', '--esp', 'sim',
      '--http', String(port), '--v-max', '2.6'],   // no --host: take the default
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d.toString(); });
  srv.stderr.on('data', (d) => { log += d.toString(); });

  try {
    for (let i = 0; i < 80 && !log.includes('board:'); i++) await sleep(100);

    // "0.0.0.0" is not something anyone can type into a phone, so the banner
    // has to name the addresses — or say plainly that there are none.
    check('the banner names the addresses, not just the bind',
      /reachable from this network at|no network interface found/.test(log),
      log.split('\n').filter((l) => /reachable|interface/.test(l)).join(' | '));
    check('it warns that there is no authentication',
      /no authentication/.test(log));
    // The reason "it does not work on my phone" is usually not the network.
    check('it warns that the camera needs https from another device',
      /https/.test(log) && /camera/.test(log));

    // And it really is serving on the loopback while bound to everything.
    const r = await fetch(`http://127.0.0.1:${port}/`);
    check('the pages are served while bound to every interface', r.status === 200,
      `${r.status}`);

    // Named addresses have to be addresses, not interface names or "0.0.0.0".
    const listed = [...log.matchAll(/http:\/\/(\d+\.\d+\.\d+\.\d+):/g)]
      .map((m) => m[1]).filter((a) => a !== '127.0.0.1');
    check('every address it prints is a real IPv4 one',
      listed.every((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a) && a !== '0.0.0.0'),
      listed.join(', ') || 'none on this machine');
  } finally {
    srv.kill('SIGINT');
    await sleep(400);
    srv.kill('SIGKILL');
  }
}

// ── 7. the run summary, on its own ───────────────────────────────────
function summaryChecks() {
  console.log('\n7. run summary');
  check('an empty run summarises to nothing rather than NaN',
    summarise([]).rows === 0);
  const rows = [
    { t: 0,    speed: 10, err: 0,    lost: false, dist: 0 },
    { t: 500,  speed: 30, err: -0.5, lost: false, dist: 1 },
    { t: 1000, speed: 0,  err: 0.2,  lost: true,  dist: 1.2 },
    { t: 1500, speed: 0,  err: 0.2,  lost: true,  dist: 1.2 },
    { t: 2000, speed: 20, err: 0.1,  lost: false, dist: 1.8 },
  ];
  const s = summarise(rows);
  check('duration comes from the row stamps', s.duration_s === 2, `${s.duration_s}`);
  check('distance is the last integrated value', s.distance_m === 1.8, `${s.distance_m}`);
  check('average and peak speed', s.avg_speed_pct === 12 && s.peak_speed_pct === 30,
    `${s.avg_speed_pct} / ${s.peak_speed_pct}`);
  check('worst error is by magnitude, not by sign', s.worst_err === 0.5, `${s.worst_err}`);
  check('two lost frames in a row are one lost event',
    s.lost_frames === 2 && s.lost_events === 1, `${s.lost_frames}/${s.lost_events}`);
  check('lost time is reported in seconds', s.lost_time_s === 0.8, `${s.lost_time_s}`);
}

await firmwareChecks();
serialProtocolChecks();
keyChecks();
await serverChecks();
await driveChecks();
await followChecks();
await sonarChecks();
await networkChecks();
summaryChecks();
console.log('\n' + (pass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED') + '\n');
process.exit(pass ? 0 : 1);
