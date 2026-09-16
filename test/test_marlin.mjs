/**
 * The Ender-3 half: direction table, the line that actually goes out, the
 * pacing, and the HTTP surface — none of which needs a printer plugged in.
 *
 * The one thing worth being pedantic about is DIRECTIONS. This gantry is
 * CoreXY, so "forward" is not an axis, it is a pair of motor signs, and
 * getting one of them backwards gives you a machine that drives diagonally
 * and looks like a wiring fault. It is asserted here, literally, against the
 * G-code the operator asked for: forward is `G1 X-100 Y100 F1000`.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DIRECTIONS, Jogger, MarlinLink, parseParams, SETTABLE,
         DEFAULT_FEED, DEFAULT_STEP_MM, explainSerialError } from '../marlin.js';
import { resolveVector } from '../marlin_http.js';
import { Rover, keysDemand, HELD_STALE_MS, LIFT_FEED } from '../rover.js';
import WebSocket from 'ws';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
                           `${m}  (${JSON.stringify(a)})`);

/**
 * Enough of a MarlinLink for the Jogger, including the part that matters:
 * M400 is not answered until the move it follows has "finished".
 */
function stubLink({ invert = {}, moveMs = 60 } = {}) {
  return {
    connected: true,
    settings: {},
    sent: [],
    _busyUntil: 0,
    sign(axis) { return invert[axis] ? -1 : 1; },
    send(cmd) {
      this.sent.push(cmd);
      if (cmd === 'M400') this._busyUntil = Date.now() + moveMs;
    },
    async whenDrained() {
      while (Date.now() < this._busyUntil) await sleep(5);
      return true;
    },
  };
}

console.log('\nThere is no quickstop in the codebase');
{
  // Not a style rule. M410 aborts a move mid-flight and leaves Marlin's idea
  // of the position wrong until the next M114; without the emergency parser it
  // waits its turn behind the move it is cancelling, so it is not even prompt.
  // Everything that used to reach for it now waits out the one move that can
  // be outstanding. This check exists so it cannot quietly come back.
  const shipped = ['marlin.js', 'marlin_http.js', 'server.js', 'public/gcode.html'];
  for (const file of shipped) {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    const code = src.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // prose may explain why
      .join('\n');
    ok(!/M410/.test(code), `${file} contains no M410 outside comments`);
  }

  // ...and nothing offers the mode that needed one.
  const api = readFileSync(path.join(ROOT, 'marlin_http.js'), 'utf8');
  ok(!/'continuous'/.test(api), 'the one-long-move hold mode is gone with it');
}

console.log('\nThe defaults a held key uses');
{
  eq(DEFAULT_FEED, 6000, 'the speed, in mm/min');
  eq(DEFAULT_STEP_MM, 5, 'and the chunk, in mm per axis');

  // The two together are a stopping distance, which is the only thing the
  // chunk is really choosing. 5 mm on each axis is a 7 mm diagonal.
  const jog = new Jogger(stubLink());
  const secs = jog.chunkSeconds(DEFAULT_STEP_MM * Math.SQRT2, DEFAULT_FEED);
  ok(secs < 0.3, `one chunk at the defaults runs ${secs.toFixed(3)} s`);
  eq(jog.gcode(DIRECTIONS.forward), 'G1 X-5.00 Y5.00 F6000',
     'and a jogger with no arguments sends exactly that');
  jog.stop();
}

console.log('\nCoreXY direction table');
{
  eq(DIRECTIONS.forward, { X: -1, Y: 1 }, 'forward is X− Y+');
  eq(DIRECTIONS.left,    { X: 1, Y: 1 },  'left is X+ Y+');
  eq(DIRECTIONS.back,    { X: 1, Y: -1 }, 'back is the opposite of forward');
  eq(DIRECTIONS.right,   { X: -1, Y: -1 },'right is the opposite of left');

  // Opposites, checked as arithmetic rather than by eye: pressing W and S at
  // once must cancel, and so must A and D.
  for (const [a, b] of [['forward', 'back'], ['left', 'right']]) {
    ok(DIRECTIONS[a].X === -DIRECTIONS[b].X && DIRECTIONS[a].Y === -DIRECTIONS[b].Y,
       `${a} and ${b} cancel each other`);
  }
}

console.log('\nThe line that goes on the wire');
{
  const link = stubLink();
  const jog = new Jogger(link);
  eq(jog.gcode(DIRECTIONS.forward, 1000, 100), 'G1 X-100.00 Y100.00 F1000',
     'forward at F1000, 100 mm chunks');
  eq(jog.gcode(DIRECTIONS.left, 1000, 100), 'G1 X100.00 Y100.00 F1000', 'left');
  eq(jog.gcode(DIRECTIONS.back, 1000, 100), 'G1 X100.00 Y-100.00 F1000', 'back');
  eq(jog.gcode(DIRECTIONS.right, 1000, 100), 'G1 X-100.00 Y-100.00 F1000', 'right');
  eq(jog.gcode({ X: 0, Y: 1 }, 600, 25), 'G1 Y25.00 F600',
     'a single-motor diagonal drops the axis that is not moving');
  eq(jog.gcode({ X: 0, Y: 0 }, 1000, 100), null, 'no direction produces no move');
  jog.stop();

  const flipped = new Jogger(stubLink({ invert: { X: true } }));
  eq(flipped.gcode(DIRECTIONS.forward, 1000, 100), 'G1 X100.00 Y100.00 F1000',
     'a backwards-wired X motor flips only X');
  flipped.stop();
}

console.log('\nHeld key -> repeated move');
{
  const link = stubLink();
  const jog = new Jogger(link);

  jog.start(DIRECTIONS.forward, 6000, 1);
  await sleep(600);
  const moves = link.sent.filter((l) => l.startsWith('G1 '));
  ok(moves.length >= 3, `the key being held streams the move over and over (${moves.length})`);
  ok(moves.every((l) => l === 'G1 X-1.00 Y1.00 F6000'), 'every repeat is the same line');
  ok(jog.active, 'the jogger says it is running');

  // The barrier. Marlin acks a move when it is buffered, so without asking it
  // to confirm the move has actually run, chunks accumulate in the planner and
  // the machine carries on after the key is released.
  ok(link.sent.every((l, i) => (i % 2 === 0) === l.startsWith('G1 ')),
     'each move is followed by its own M400, and nothing is sent between them');
  ok(link.sent.length === moves.length * 2, 'one M400 per move, no more');

  jog.stop();
  await sleep(250);
  const afterStop = link.sent.length;
  await sleep(250);
  ok(link.sent.length === afterStop, 'releasing the key stops the stream');
  ok(!jog.active, 'the jogger says it is idle');

  // Pacing must track the real move time, not the feedrate alone, or the
  // planner fills up and the gantry coasts for seconds after release.
  ok(jog.chunkSeconds(100, 1000) > jog.chunkSeconds(10, 1000),
     'a longer chunk is given longer to run');
  ok(jog.chunkSeconds(100, 6000) < jog.chunkSeconds(100, 600),
     'a faster feedrate is given less time');
  link.settings.M204 = { T: 3000 };
  ok(jog.chunkSeconds(1, 6000) < 0.1, 'a stiffer acceleration shortens the ramp');
}

console.log('\nWhat /api/marlin/run accepts');
{
  eq(resolveVector({ dir: 'forward' }), { X: -1, Y: 1 }, 'by name');
  eq(resolveVector({ axes: { X: -1, Y: 1 } }), { X: -1, Y: 1 }, 'by vector');
  eq(resolveVector({ axis: 'Y', direction: -1 }), { Y: -1 }, 'by single axis');
  eq(resolveVector({ axis: 'X' }), { X: 1 }, 'a bare axis means forwards');
  eq(resolveVector({ axes: { X: 0, Y: 4 } }), { Y: 1 },
     'magnitude is ignored — only the sign of each motor matters');

  // W + A summed and signed: on this gantry the diagonal turns one motor.
  const sum = { X: DIRECTIONS.forward.X + DIRECTIONS.left.X,
                Y: DIRECTIONS.forward.Y + DIRECTIONS.left.Y };
  eq(resolveVector({ axes: sum }), { Y: 1 }, 'W+A is one motor, not two moves');

  for (const bad of [{ dir: 'sideways' }, { axes: { Q: 1 } }, { axes: { X: 'fast' } },
                     { axes: { X: 0, Y: 0 } }, { axis: 'Q' }]) {
    let threw = false;
    try { resolveVector(bad); } catch { threw = true; }
    ok(threw, `rejected: ${JSON.stringify(bad)}`);
  }
}

console.log('\nOne ok per command, including the ones that skip the queue');
{
  // Reaches into the link because this is a statement about its internals:
  // exactly which write each `ok` authorises. A fake board cannot show it —
  // one that answers instantly never lets the host get ahead, and a real one
  // only reveals it when its planner is full, which is the worst possible
  // moment to find out.
  const written = [];
  const link = new MarlinLink();
  link.port = {
    isOpen: true,
    write: (data, cb) => { written.push(String(data).trim()); cb && cb(null); },
    drain: (cb) => cb && cb(),
  };
  link._stop = false;
  link._pending = 0;
  link._idle.set();
  link._pump = link._pumpLoop();
  const ack = () => link._onData(Buffer.from('ok\n'));
  const settle = () => sleep(60);

  link.send('FIRST');
  link.send('SECOND');
  await settle();
  eq(written, ['FIRST'], 'the second command waits for the first to be acknowledged');

  ack();
  await settle();
  eq(written, ['FIRST', 'SECOND'], 'the ok releases exactly one more');

  ack();
  await settle();
  ok(link.inFlight() === 0, 'and the link knows nothing is outstanding');

  // The bug: a command written past the queue is acknowledged like anything
  // else. Left uncounted, its ok is spent on the next queued command, and the
  // host runs one ahead of the board from then until the port closes.
  link.sendNow('M108');
  link.send('THIRD');
  await settle();
  eq(written, ['FIRST', 'SECOND', 'M108'],
     'a queued command does not ride out on the out-of-band write before it');

  ack();                                    // this one is M108's
  await settle();
  eq(written, ['FIRST', 'SECOND', 'M108', 'THIRD'], 'and then THIRD goes');

  // M112 is the exception: the board halts mid-sentence and never answers.
  ack();
  link.sendNow('M112', false);
  link.send('FOURTH');
  await settle();
  eq(written, ['FIRST', 'SECOND', 'M108', 'THIRD', 'M112', 'FOURTH'],
     'nothing waits on an ok from M112, which is never coming');

  // An unsolicited ok — a boot banner, a reply we did not count — must not
  // bank a free write for later.
  ack(); ack(); ack(); ack();
  await settle();
  ok(link.inFlight() === 0, 'stray oks do not go negative');
  link.send('FIFTH');
  link.send('SIXTH');
  await settle();
  eq(written.slice(-1), ['FIFTH'], '...and do not let two commands out at once');

  link._stop = true;
  link._idle.set();
  link._work.set();
  link.port = null;
}

console.log('\nSaying what a serial failure actually was');
{
  // These four fail in completely different places, and the whole point of
  // the message is to send you to the right one. The EIO case is the one that
  // cost an afternoon: the adapter enumerates, the port sometimes even opens,
  // and the only honest reading is "no bytes are crossing the USB link".
  const advice = (msg) => explainSerialError(new Error(msg), '/dev/ttyUSB0').join(' ');

  ok(/dialout/.test(advice('Permission denied, cannot open /dev/ttyUSB0')),
     'permission denied names the group to join');
  ok(/--list|not there/.test(advice('No such file or directory, cannot open /dev/ttyUSB0')),
     'a missing device says it is missing');
  ok(/ModemManager/.test(advice('Resource temporarily unavailable, cannot lock port')),
     'a busy port names the thing most likely holding it');

  const eio = advice('Input/output error, cannot open /dev/ttyUSB0');
  ok(/USB adapter is not answering/.test(eio), 'an I/O error blames the USB link');
  ok(/control message/.test(eio), '...and says which kernel message confirms it');
  ok(!/powered on|power switch/i.test(eio),
     'and does NOT send you to the printer power switch, which is not the fault');
  ok(/USB adapter is not answering/.test(
       advice('Error: Input/output error setting custom baud rate of 115200')),
     'a refused baud rate is the same fault, and gets the same answer');

  eq(explainSerialError(new Error('something nobody has seen before')), [],
     'an error with no known cause invents no advice');
}

console.log('\nPicking the port');
{
  // The bug this is here for: /dev/ttyS0 sorts before /dev/ttyUSB0, so
  // "the first serial device" opens an 8250 placeholder on a PC and the GPIO
  // mini-UART on a Pi. Both fail, and neither is the printer.
  const { SerialPort } = await import('serialport');
  const real = SerialPort.list;
  const fake = (list) => { SerialPort.list = async () => list; };

  const pi = [
    { path: '/dev/ttyS0' }, { path: '/dev/ttyAMA0' },
    // Some kernels report the bare vendor id rather than a name, which is what
    // this machine's CH340 does: manufacturer "1a86", not "QinHeng".
    { path: '/dev/ttyUSB0', manufacturer: '1a86' },
  ];
  fake(pi);
  const { listPorts, bestPort } = await import('../marlin.js');
  eq(await bestPort(), '/dev/ttyUSB0', 'the CH340 wins over the on-board UARTs');
  eq((await listPorts())[0], '/dev/ttyUSB0', 'and it is first in the dropdown');
  ok(!(await listPorts()).includes('/dev/ttyS0'),
     'the 8250 placeholder is not offered while a real board is there');
  ok((await listPorts()).includes('/dev/ttyAMA0'),
     "...but the Pi's own UART still is, for a board wired to the header");

  fake([{ path: '/dev/ttyUSB1' }, { path: '/dev/ttyUSB0' }]);
  eq(await bestPort(), '/dev/ttyUSB0',
     'with nothing identifying itself, plain USB serial is still preferred');

  fake([{ path: '/dev/ttyS0' }, { path: '/dev/ttyS10' }, { path: '/dev/ttyS2' }]);
  eq(await bestPort(), null, 'nothing that looks like a board means no autoconnect');
  eq(await listPorts(), ['/dev/ttyS0', '/dev/ttyS2', '/dev/ttyS10'],
     'they are still listed though, in a human order, so RS-232 is pickable');

  fake([]);
  eq(await listPorts(), [], 'no ports at all is not an error');
  eq(await bestPort(), null, '...and nothing is opened');

  SerialPort.list = real;
}

console.log('\nReading the board back');
{
  eq(parseParams('echo:  M92 X80.00 Y80.00 Z400.00 E93.00', 'M92'),
     { X: 80, Y: 80, Z: 400, E: 93 }, 'M503 echo is parsed');
  eq(parseParams('echo:  M204 P500.00 R1000.00 T1000.00', 'M204'),
     { P: 500, R: 1000, T: 1000 }, 'travel acceleration is picked up');
  eq(parseParams('ok', 'M92'), null, 'an unrelated line yields nothing');
  ok(SETTABLE.M906.max === 1200, 'motor current is clamped well under a hot coil');
}

// ── /follow by hand: W A S D and the fork on Z ───────────────────────
console.log('\nW A S D → the two wheels');
{
  eq(keysDemand(['w'], 50), [50, 50], 'W: both wheels forward');
  eq(keysDemand(['s'], 50), [-50, -50], 'S: both wheels back');
  eq(keysDemand(['w', 'd'], 50), [50, 20], 'W+D: an arc right, the right wheel slower');
  eq(keysDemand(['w', 'a'], 50), [20, 50], 'W+A: an arc left');
  eq(keysDemand(['d'], 50), [30, -30], 'D alone: pivot right on the spot');
  eq(keysDemand(['a'], 50), [-30, 30], 'A alone: pivot left');
  eq(keysDemand(['w', 's'], 50), [0, 0], 'W+S cancel — standing still, not the last one pressed');
  eq(keysDemand(['W'], 500), [100, 100], 'upper case, and the speed is capped at 100 %');
  eq(keysDemand(['x', 'q'], 50), [0, 0], 'anything else is ignored');
}

/** A Jogger stand-in that records what it was asked for. */
function stubJog() {
  return {
    calls: [],
    startWheels(l, r, feed, lift = 0) { this.calls.push({ l, r, feed, lift }); },
    stop() { this.calls.push('stop'); },
    get last() { return this.calls[this.calls.length - 1]; },
  };
}

console.log('\nThe fork rides on Z, in the same G1 as the wheels');
{
  const link = stubLink();
  const jog = new Jogger(link);
  eq(jog.lineFor({ X: -1, Y: 1, Z: 0.6 }, 2000), 'G1 X-1.00 Y1.00 Z0.60 F2000',
     'Z joins X and Y in one line');
  eq(jog.lineFor({ X: 0, Y: 0, Z: -0.6 }, 240), 'G1 Z-0.60 F240', 'the fork alone is a Z-only line');
  eq(jog.lineFor({ X: -1, Y: 1 }, 2000), 'G1 X-1.00 Y1.00 F2000', 'no Z, no Z word — the wheels are unchanged');
  ok(jog.chunkSeconds(Math.hypot(3, 4, 12), 600) > jog.chunkSeconds(5, 600),
     'the pacing counts the Z distance too');

  const stub = stubJog();
  const rover = new Rover({ link: { connected: true }, jog: stub, maxFeed: 6000 });
  rover.setLift(1);
  const up = stub.last;
  ok(up !== 'stop' && up.l === 0 && up.r === 0 && up.lift > 0,
     `E with the rover not armed: the fork moves, the wheels do not  (Z ${up.lift.toFixed(3)} mm)`);
  ok(Math.abs(up.lift - LIFT_FEED * rover.chunkMs / 60000) < 1e-9 && up.feed === LIFT_FEED,
     `one chunk of fork is ${LIFT_FEED} mm/min × ${rover.chunkMs} ms, at ${LIFT_FEED} mm/min`);
  ok(LIFT_FEED <= 300, 'the fork speed stays under the Ender 3 Pro Z limit (5 mm/s), so driving is not slowed');

  rover.setKeys(['w'], 40);
  ok(stub.last.lift > 0 && stub.last.l === 0, 'W while not armed does not drive — START comes first');
  rover.start();
  rover.setKeys(['w'], 40);
  const both = stub.last;
  ok(both.l > 0 && both.r > 0 && both.lift > 0, 'armed: W and E together are one chunk');
  ok(Math.abs(both.feed - Math.hypot(0.4 * 6000, 0.4 * 6000, LIFT_FEED)) < 1e-6,
     'the feed is the three speeds combined, so the chunk still takes its 150 ms');

  rover.setKeys(['w', 'd'], 50);
  ok(rover.demand[0] > rover.demand[1], 'W+D: the left wheel faster — the pilot turns right the same way');
  rover.setKeys(['w', 'd'], 50, true);
  ok(rover.demand[0] < rover.demand[1], 'with /follow\'s wheel swap on, the keys swap too');

  rover.hold('kapı: PLC devam komutu bekleniyor');
  rover.setKeys(['w'], 40);
  ok(stub.last !== 'stop' && stub.last.l === 0 && stub.last.lift > 0,
     'a PLC hold stops the wheels, not the fork');
  rover.hold('acil stop', true);
  rover.setLift(1);
  ok(rover.lift === 0 && (stub.last === 'stop' || stub.last.lift === 0),
     'an emergency stop holds the fork as well — E held does nothing');
  rover.hold(null);

  rover.setLift(-1);
  ok(stub.last.lift < 0, 'Q: the fork goes down');
  rover.setCfg({ lift: { invert: true, feed: 120 } });
  rover.setLift(-1);
  ok(stub.last.lift > 0 && rover.liftFeed === 120, 'inverted in follow.json: Q drives Z the other way, at the saved speed');
  rover.setCfg({ lift: { feed: 99999 } });
  ok(rover.liftFeed === 600, 'a fork speed out of range is clamped');

  rover.stop('DUR');
  ok(stub.last === 'stop' && rover.lift === 0 && rover.keys.length === 0, 'STOP lets go of the fork and the keys too');

  // The dead-man: nothing repeated for longer than HELD_STALE_MS is let go.
  rover.start();
  rover.setKeys(['w'], 40);
  rover.setLift(1);
  rover._expire(Date.now() + HELD_STALE_MS + 1);
  ok(stub.last === 'stop' && rover.lift === 0 && rover.keys.length === 0,
     `keys and fork not repeated for ${HELD_STALE_MS} ms stop by themselves`);

  rover.setAuto(30, 30, 'takip');
  rover.setLift(1);
  // (still inverted from above, so E is negative Z here)
  ok(stub.last.l > 0 && stub.last.lift !== 0, 'the fork works while the pilot is driving');
  rover.close();
}

// ── the HTTP surface, against the real server ────────────────────────
console.log('\n/api/marlin over HTTP, with no printer attached');
const server = spawn('node',
  ['server.js', '--http', '8198', '--host', '127.0.0.1', '--no-connect'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let boot = '';
server.stdout.on('data', (d) => { boot += d; });
server.stderr.on('data', (d) => { boot += d; });
await sleep(1500);

const BASE = 'http://127.0.0.1:8198';
const post = async (p, body) => {
  const r = await fetch(`${BASE}/api/marlin/${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { code: r.status, body: await r.json() };
};

try {
  const s = await (await fetch(`${BASE}/api/marlin/status`)).json();
  ok(s.connected === false, 'status says no printer');
  eq(s.directions, DIRECTIONS, 'the page is handed the same direction table');
  ok(Array.isArray(s.ports), 'status lists the serial ports it could open');
  ok(typeof s.mm_per_rev?.X === 'number', `mm per revolution is reported (${s.mm_per_rev?.X})`);

  const log = await (await fetch(`${BASE}/api/marlin/log?since=0`)).json();
  ok(Array.isArray(log.lines) && typeof log.seq === 'number', 'the log is readable');

  // / is the hub for both machines now; the hold-WASD page moved to /gcode.
  const hub = await fetch(`${BASE}/`);
  ok(hub.ok && /Robot kontrol/.test(await hub.text()), 'the hub is served at /');
  const page = await fetch(`${BASE}/gcode`);
  const html = await page.text();
  ok(page.ok && /Hold W A S D/.test(html), 'the hold-WASD page is served at /gcode');
  ok(/G1 X-100 Y100 F1000/.test(html), 'the page states the forward line it sends');
  ok((await fetch(`${BASE}/gcode`)).ok, '...and at /gcode, as it was before the merge');

  // Everything that needs a board must say so rather than queueing silently.
  for (const [p, body] of [['run', { dir: 'forward' }], ['gcode', { cmd: 'M114' }],
                           ['jog', { axis: 'X', distance: 1 }], ['home', { axis: 'X' }],
                           ['halt', {}], ['refresh', {}]]) {
    const r = await post(p, body);
    ok(r.code === 409, `${p} without a board -> 409 ${JSON.stringify(r.body.error)}`);
  }

  // ...and everything that is just wrong must be rejected before it gets there.
  const badDir = await post('run', { dir: 'sideways' });
  ok(badDir.code === 400 && /sideways/.test(badDir.body.error),
     `an unknown direction -> 400 ${JSON.stringify(badDir.body.error)}`);

  const hot = await post('setting', { code: 'M906', params: { X: 5000 } });
  ok(hot.code === 400 && /outside the allowed/.test(hot.body.error),
     `5000 mA is refused before the wire: ${JSON.stringify(hot.body.error)}`);

  const notSettable = await post('setting', { code: 'M104', params: { S: 200 } });
  ok(notSettable.code === 400, 'a code this page does not own is refused');

  const wrongLetter = await post('setting', { code: 'M906', params: { Z: 500 } });
  ok(wrongLetter.code === 400 && /does not take Z/.test(wrongLetter.body.error),
     'a letter the code does not take is refused');

  const badEeprom = await post('eeprom', { action: 'melt' });
  ok(badEeprom.code === 400, 'only save/load/reset are accepted');

  const invert = await post('invert', { axis: 'X', on: true });
  ok(invert.code === 200 && invert.body.invert.X === true,
     'a backwards motor can be corrected with no board attached');
  await post('invert', { axis: 'X', on: false });

  const nowhere = await post('connect', { port: '/dev/tty-not-a-real-port' });
  ok(nowhere.code >= 400, `opening a port that is not there fails: ${nowhere.code}`);

  const missing = await fetch(`${BASE}/api/marlin/nonsense`, { method: 'POST' });
  ok(missing.status === 404, 'an unknown route is a 404, not a crash');

  const wrongVerb = await fetch(`${BASE}/api/marlin/run`);
  ok(wrongVerb.status === 405, 'a GET where a POST belongs is a 405');

  // ...and the page is still served after all of that.
  ok((await fetch(`${BASE}/gcode`)).ok, 'the page still serves');

  // /follow's keys and fork over the socket, and the server's own dead-man.
  const ws = new WebSocket('ws://127.0.0.1:8198/');
  let st = null;
  ws.on('message', (d) => { try { const m = JSON.parse(d); if (m.type === 'status') st = m; } catch { /* */ } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ cmd: 'lift', dir: 1 }));
  ws.send(JSON.stringify({ cmd: 'start' }));
  ws.send(JSON.stringify({ cmd: 'keys', keys: ['w', 'd'], pct: 50 }));
  await sleep(250);
  ok(st && st.machine === 'marlin', 'the status says which machine this is');
  ok(st && st.lift && st.lift.dir === 1, 'the fork command reached the rover  (E held)');
  eq(st && st.keys, ['w', 'd'], 'the keys reached the rover');
  eq(st && st.set, [50, 20], '...as the two wheel demands');
  await sleep(HELD_STALE_MS + 300);
  ok(st && st.lift.dir === 0 && st.keys.length === 0,
     'no repeats from the page: the server lets go of both within half a second');
  ws.close();
  const follow = await (await fetch(`${BASE}/follow`)).text();
  ok(/KeyF/.test(follow) && /KeyQ/.test(follow) && /cmd: 'lift'/.test(follow),
     '/follow has the F, W A S D and Q / E shortcuts');
} finally {
  server.kill();
}

if (fail) console.log('\nserver output:\n' + boot);
console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
