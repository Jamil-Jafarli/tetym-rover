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
import { readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DIRECTIONS, Jogger, MarlinLink, parseParams, settingWrite, SETTABLE,
         DEFAULT_FEED, DEFAULT_STEP_MM, explainSerialError,
         isSpin, TURN_SCALE, Pacer, HOLD_MARGIN_S } from '../marlin.js';
import { resolveVector, marlinApi } from '../marlin_http.js';
import { Rover, keysDemand, HELD_STALE_MS, LIFT_FEED } from '../rover.js';
import WebSocket from 'ws';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
                           `${m}  (${JSON.stringify(a)})`);

/** Enough of a MarlinLink for the Jogger: connected, and a place to record
 *  every line it sends. */
function stubLink({ invert = {} } = {}) {
  return {
    connected: true,
    settings: {},
    sent: [],
    sign(axis) { return invert[axis] ? -1 : 1; },
    send(cmd) { this.sent.push(cmd); },
    // What the pacing reads to tell whether the board is keeping up.
    queued() { return 0; },
    inFlight() { return 0; },
  };
}

/** The two motor distances out of a `G1 X… Y… F…` line. */
function axesOf(line) {
  const num = (a) => {
    const m = new RegExp(`${a}(-?[\\d.]+)`).exec(line || '');
    return m ? Number(m[1]) : 0;
  };
  return { X: num('X'), Y: num('Y') };
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
  eq(DEFAULT_STEP_MM, 80, 'and the chunk, in mm per axis');

  // The two together are a stopping distance, which is the only thing the
  // chunk is really choosing. 80 mm on each axis is a 113.1 mm diagonal.
  const jog = new Jogger(stubLink());
  const secs = jog.chunkSeconds(DEFAULT_STEP_MM * Math.SQRT2, DEFAULT_FEED);
  ok(secs < 1.5, `one chunk at the defaults runs ${secs.toFixed(3)} s`);
  eq(jog.gcode(DIRECTIONS.forward), 'G1 X-80.00 Y80.00 F6000',
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
  const times = [];
  const realSend = link.send.bind(link);
  link.send = (cmd) => { times.push(Date.now()); realSend(cmd); };

  jog.start(DIRECTIONS.forward, 6000, 10);
  await sleep(800);
  const moves = link.sent.filter((l) => l.startsWith('G1 '));
  ok(moves.length >= 6, `the key being held streams the move over and over (${moves.length})`);
  eq(moves.slice(0, 2), ['G1 X-5.00 Y5.00 F6000', 'G1 X-5.00 Y5.00 F6000'],
     'from standstill: two half chunks, so a quick tap still moves one chunk');
  ok(moves.slice(2).every((l) => l === 'G1 X-10.00 Y10.00 F6000'),
     'then every repeat is the same full chunk');
  ok(jog.active, 'the jogger says it is running');

  // The first design paired every G1 with an M400 and waited for the planner
  // to drain — a full stop at the end of every chunk. The second sent the next
  // chunk 75 % of the way through the current one — which had started alone
  // by then, and Marlin never re-plans a move it is executing, so it braked to
  // zero anyway: still slices. The next chunk now goes out HOLD_MARGIN_S
  // before the one ahead of it STARTS.
  ok(!link.sent.includes('M400'), 'chunks are no longer paired with M400');
  const chunkMs = jog.holdSeconds({ X: -10, Y: 10 }, 6000) * 1000;
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  ok(gaps[0] < 15,
     `the two halves go out back to back, so the second is planned before the first `
   + `starts (gap: ${gaps[0].toFixed(1)} ms)`);
  // After the start-up, the schedule must come back to one chunk's CRUISE time
  // per send: shorter and the queue grows without bound (the bug an early
  // version of this pacing had), longer — the trapezoid — and the planner is
  // starved and the slices come back through the clock.
  const steady = gaps.slice(3);
  ok(steady.length >= 2 && steady.every((g) => Math.abs(g - chunkMs) < chunkMs * 0.25),
     `then every gap is one blended chunk (${chunkMs.toFixed(1)} ms, not the `
   + `${(jog.chunkSeconds(Math.hypot(10, 10), 6000) * 1000).toFixed(1)} ms trapezoid; gaps: `
   + `${steady.map((g) => g.toFixed(1)).join(', ')})`);

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

console.log('\nThe Pacer keeps the next chunk on the board before the one ahead starts');
{
  // On a made-up clock, so this is exact rather than at the mercy of timers.
  const jog = new Jogger(stubLink());
  jog.stop();
  const p = new Pacer(jog);
  const ax = { X: -80, Y: 80 };                       // 113.1 mm at F6000
  const cruise = (Math.hypot(80, 80) / 100) * 1000;   // 1131 ms at 100 mm/s
  const ramp = (100 / (2 * jog.accel())) * 1000;      // 100 ms at T500
  ok(p.idle(0) && p.waitMs(0) === 0, 'idle: the first chunk goes now');
  p.sent(ax, 6000, 0);
  ok(Math.abs(p.endAt - (cruise + ramp)) < 0.5,
     `from standstill a chunk costs its ramp as well (${p.endAt.toFixed(0)} ms)`);
  ok(p.waitMs(0) < 0, 'and the second goes straight after it, before the first starts');
  p.sent(ax, 6000, 0);

  let t = 0;
  const sends = [], leads = [];
  for (let i = 0; i < 6; i++) {
    t += Math.max(0, p.waitMs(t));
    leads.push(p.endAt - p.lastMs - t);               // how long before the last one starts
    sends.push(t);
    p.sent(ax, 6000, t);
  }
  ok(leads.every((l) => Math.abs(l - HOLD_MARGIN_S * 1000) < 0.5),
     `every chunk is sent ${HOLD_MARGIN_S * 1000} ms before the one ahead of it starts`);
  const g = sends.slice(1).map((s, i) => s - sends[i]);
  ok(g.every((x) => Math.abs(x - cruise) < 0.5),
     `steady state: one send per cruise time — a bounded lookahead (${g.map((x) => x.toFixed(0))})`);

  // A turn: the chunk before it brakes into it, and the new one ramps out.
  const before = p.endAt;
  p.sent({ X: -40, Y: -40 }, 6000, t);
  const spinMs = (Math.hypot(40, 40) / 100) * 1000;
  ok(Math.abs(p.endAt - before - (ramp + spinMs + ramp)) < 0.5,
     'a turn costs the braking into it and the ramp out of it');
  const e = p.endAt;
  p.release(t);
  p.release(t);
  ok(Math.abs(p.endAt - e - ramp) < 0.5, 'and letting go adds the last braking ramp, once');
}

console.log('\nThe pilot steers in the camera frame, not the chassis frame');
{
  // The camera is bolted to the end DIRECTIONS calls the back, so autonomous
  // driving runs the chassis backwards on purpose. That is a 180° turn, and a
  // 180° turn swaps the wheels as well as reversing them: the pilot's "left
  // wheel" is the wheel on the left of the picture, which is physically the
  // chassis's right one — the Y motor. Reversing without swapping drives the
  // right way and steers exactly backwards, which is what this pins down.
  const link = stubLink();
  const jog = new Jogger(link);
  const rover = new Rover({ link, jog });
  rover.start();

  rover.setAuto(60, 20);                     // pilot's left wheel faster
  await sleep(250);
  const l = axesOf(link.sent.at(-1));
  ok(Math.abs(l.Y) > Math.abs(l.X),
     `more on the pilot's left wheel moves the Y motor further  (${link.sent.at(-1)})`);
  ok(l.X > 0 && l.Y < 0,
     'and both motors still drive the way the camera looks (DIRECTIONS.back)');

  rover.setAuto(20, 60);                     // and the mirror image
  await sleep(250);
  const r = axesOf(link.sent.at(-1));
  ok(Math.abs(r.X) > Math.abs(r.Y),
     `more on the pilot's right wheel moves the X motor further  (${link.sent.at(-1)})`);

  rover.setAuto(40, 40);                     // straight on
  await sleep(250);
  const c = axesOf(link.sent.at(-1));
  ok(Math.abs(Math.abs(c.X) - Math.abs(c.Y)) < 1e-6,
     'equal demands move both motors equally — no phantom turn');

  rover.stop();
  jog.stop();
}

console.log('\nThe steering stream keeps the planner fed');
{
  // Marlin never re-plans the move it is already running, so a chunk that was
  // alone in the buffer when it started stops at its own end whatever arrives
  // afterwards. The stream therefore has to lead by more than one whole chunk
  // (STREAM_LEAD) and pace itself by the blended run time, or the rover moves
  // in 150 ms hops — the "choppy" drive this pacing exists to remove.
  const link = stubLink();
  const jog = new Jogger(link);
  const times = [];
  const realSend = link.send.bind(link);
  link.send = (cmd) => { times.push(Date.now()); realSend(cmd); };

  const dist = Math.hypot(5, 5);
  const cruiseMs = jog.cruiseSeconds(dist, 6000) * 1000;
  const rampedMs = jog.chunkSeconds(dist, 6000) * 1000;
  ok(cruiseMs < rampedMs * 0.5,
     `a blended chunk runs in ${cruiseMs.toFixed(0)} ms, a start-and-stop one in `
   + `${rampedMs.toFixed(0)} ms — the pacing has to know which it is`);

  jog.startWheels(5, 5, 6000);
  await sleep(500);
  ok(times.length >= 2 && times[1] - times[0] < cruiseMs * 0.6,
     'the first two chunks go out back to back, so the second is planned before '
   + 'the first starts');
  const gaps = times.slice(2).map((t, i) => t - times[i + 1]);
  ok(gaps.length >= 3 && gaps.every((g) => Math.abs(g - cruiseMs) < cruiseMs * 0.6),
     `then every gap tracks the blended chunk time (${cruiseMs.toFixed(0)} ms, gaps: `
   + `${gaps.slice(0, 5).map((g) => g.toFixed(0)).join(', ')})`);

  // Leading by more than a chunk is only safe while the board keeps up. When
  // it stops acking, the useful thing is to skip a chunk and steer with the
  // next camera frame rather than post a correction that is already old.
  link.queued = () => 99;
  const held = link.sent.length;
  await sleep(250);
  ok(link.sent.length === held,
     'a board that has fallen behind gets no more chunks piled on it');
  link.queued = () => 0;
  await sleep(250);
  ok(link.sent.length > held, 'and the stream resumes when it catches up');

  jog.stop();
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

console.log('\nA spin gets a tenth of the step of forward/back (see TURN_SCALE)');
{
  eq(isSpin(DIRECTIONS.forward), false, 'forward translates, it does not spin');
  eq(isSpin(DIRECTIONS.back), false, 'neither does back');
  eq(isSpin(DIRECTIONS.left), true, 'left spins on the spot');
  eq(isSpin(DIRECTIONS.right), true, 'and so does right');
  eq(isSpin({ X: 1, Y: 0 }), false, 'a one-wheel diagonal is neither — only one motor moves');
  eq(TURN_SCALE, 0.1, 'a spin is scaled to a tenth of the nominal step');

  // The route itself: /run has to actually apply the scale, not just have it
  // sit unused in marlin.js. A stub jog records exactly what start() was given.
  function fakeLinkForRun() {
    return { connected: true, sent: [], invert: { X: false, Y: false }, steppersOn: false,
             sign(axis) { return this.invert[axis] ? -1 : 1; },
             send(cmd) { this.sent.push(cmd); } };
  }
  function fakeReqFor(body) {
    const raw = JSON.stringify(body);
    return { method: 'POST',
             on(ev, cb) { if (ev === 'data') queueMicrotask(() => cb(raw));
                          if (ev === 'end') queueMicrotask(() => cb()); } };
  }
  function fakeResFor() {
    const out = { code: null, body: null };
    return { out, writeHead(code) { out.code = code; },
             end(buf) { out.body = JSON.parse(buf.toString()); } };
  }

  const link = fakeLinkForRun();
  const starts = [];
  const jog = {
    start(vec, feed, step) { starts.push({ vec, feed, step }); },
    gcode() { return null; },
    chunkSeconds() { return 0; },
    holdSeconds() { return 0; },
  };
  const handle = marlinApi({ link, jog });
  const call = async (body) => {
    const req = fakeReqFor(body); const res = fakeResFor();
    await handle(req, res, '/api/marlin/run');
    return res.out;
  };

  await call({ dir: 'forward', step: 80 });
  await call({ dir: 'left', step: 80 });
  await call({ dir: 'back', step: 80 });
  await call({ dir: 'right', step: 80 });

  eq(starts.map((s) => s.step), [80, 8, 80, 8],
     'forward/back keep the nominal step; left/right get a tenth of it, by default');

  // The default is only a default: a caller asking for a different turnScale
  // gets exactly that instead, not TURN_SCALE ignored or added on top of it.
  starts.length = 0;
  await call({ dir: 'left', step: 80, turnScale: 0.25 });
  await call({ dir: 'forward', step: 80, turnScale: 0.25 });
  eq(starts.map((s) => s.step), [20, 80],
     'a spin honours a caller-supplied turnScale; a translation ignores it entirely');

  starts.length = 0;
  const noSpin = await call({ dir: 'left', step: 80, turnScale: -1 });
  eq(noSpin.body.turn_scale, 0,
     'a negative turnScale is clamped to 0, not let through to flip a spin\'s direction');
  eq(starts[0].step, 0, 'so the spin gets zero step rather than a reversed one');

  starts.length = 0;
  const zeroScale = await call({ dir: 'left', step: 80, turnScale: 0 });
  eq(zeroScale.body.turn_scale, TURN_SCALE,
     'an explicit 0 is falsy, so it falls back to the default like an omitted step/feedrate would');
}

console.log('\nA spin gets its own F, independent of forward/back (turnFeedrate)');
{
  function fakeLinkForRun() {
    return { connected: true, sent: [], invert: { X: false, Y: false }, steppersOn: false,
             sign(axis) { return this.invert[axis] ? -1 : 1; },
             send(cmd) { this.sent.push(cmd); } };
  }
  function fakeReqFor(body) {
    const raw = JSON.stringify(body);
    return { method: 'POST',
             on(ev, cb) { if (ev === 'data') queueMicrotask(() => cb(raw));
                          if (ev === 'end') queueMicrotask(() => cb()); } };
  }
  function fakeResFor() {
    const out = { code: null, body: null };
    return { out, writeHead(code) { out.code = code; },
             end(buf) { out.body = JSON.parse(buf.toString()); } };
  }

  const link = fakeLinkForRun();
  const starts = [];
  const jog = {
    start(vec, feed, step) { starts.push({ vec, feed, step }); },
    gcode() { return null; },
    chunkSeconds() { return 0; },
    holdSeconds() { return 0; },
  };
  const handle = marlinApi({ link, jog });
  const call = async (body) => {
    const req = fakeReqFor(body); const res = fakeResFor();
    await handle(req, res, '/api/marlin/run');
    return res.out;
  };

  // Omitted entirely: a spin gets exactly the forward/back feed, same as
  // before turnFeedrate existed — old callers see no change in behaviour.
  const same = await call({ dir: 'left', feedrate: 3000 });
  eq(same.body.turn_feedrate, 3000, 'omitted turnFeedrate defaults to feedrate, not DEFAULT_FEED');
  eq(starts[0].feed, 3000, 'and that default is what the spin actually runs at');

  // Given explicitly: a spin uses it, forward/back never sees it at all.
  starts.length = 0;
  await call({ dir: 'left', feedrate: 3000, turnFeedrate: 9000 });
  await call({ dir: 'forward', feedrate: 3000, turnFeedrate: 9000 });
  eq(starts.map((s) => s.feed), [9000, 3000],
     'a spin honours its own feed; forward/back keeps using feedrate');

  // Clamped the same way feedrate always has been — 0 or negative cannot
  // leave the board with no speed at all, or a spin running backwards.
  starts.length = 0;
  const bad = await call({ dir: 'right', turnFeedrate: -500 });
  ok(bad.body.turn_feedrate >= 1, `a bad turnFeedrate is clamped, not passed through (${bad.body.turn_feedrate})`);
}

console.log('\nManual control (jog/home/zero) reaches both wheels by default');
{
  // A minimal stand-in for MarlinLink: connected, and just enough surface for
  // marlinApi to write G-code and read it back.
  function fakeLink() {
    return {
      connected: true, sent: [], invert: { X: false, Y: false }, steppersOn: false,
      sign(axis) { return this.invert[axis] ? -1 : 1; },
      send(cmd) { this.sent.push(cmd); },
    };
  }

  // Enough of node:http's req/res for marlinApi's handle() to run against,
  // without a real server: a JSON body in, a status + JSON body out.
  function fakeReq(body) {
    const raw = JSON.stringify(body);
    return {
      method: 'POST',
      on(ev, cb) {
        if (ev === 'data') queueMicrotask(() => cb(raw));
        if (ev === 'end') queueMicrotask(() => cb());
      },
    };
  }
  function fakeRes() {
    const out = { code: null, body: null };
    return { out, writeHead(code) { out.code = code; },
             end(buf) { out.body = JSON.parse(buf.toString()); } };
  }

  const link = fakeLink();
  const handle = marlinApi({ link, jog: {} });
  const call = async (action, body) => {
    const req = fakeReq(body);
    const res = fakeRes();
    await handle(req, res, `/api/marlin/${action}`);
    return res.out;
  };

  const jogged = await call('jog', { distance: 5, feedrate: 1000 });
  ok(jogged.code === 200, 'an axis-less jog is accepted');
  ok(link.sent.includes('G1 X5.0000 Y5.0000 F1000'),
     `it moves both wheels, not just X: ${JSON.stringify(link.sent)}`);

  link.sent.length = 0;
  await call('home', {});
  ok(link.sent.includes('G28 X Y'),
     `an axis-less home homes both wheels: ${JSON.stringify(link.sent)}`);

  link.sent.length = 0;
  await call('zero', {});
  ok(link.sent.includes('G92 X0 Y0'),
     `an axis-less zero re-zeros both wheels: ${JSON.stringify(link.sent)}`);

  // An explicit axis is still exactly what it asks for — the per-axis buttons
  // on the drive page must not start moving the other wheel too.
  link.sent.length = 0;
  await call('jog', { axis: 'Y', distance: 3, feedrate: 500 });
  eq(link.sent, ['G91', 'G1 Y3.0000 F500', 'M114'],
     'an explicit axis still jogs just that one wheel');

  link.sent.length = 0;
  await call('home', { axis: 'X' });
  ok(link.sent.includes('G28 X'), 'and an explicit home stays single-axis');

  link.sent.length = 0;
  await call('zero', { axis: 'X' });
  ok(link.sent.includes('G92 X0'), 'and an explicit zero stays single-axis');
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
  // startWheels gets (-right, -left): the camera is on the chassis's back, and
  // W is the camera's forward, the way the pilot drives (see rover.js).
  ok(both.l < 0 && both.r < 0 && both.lift > 0, 'armed: W and E together are one chunk');
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
  ok(stub.last.l < 0 && stub.last.lift !== 0, 'the fork works while the pilot is driving');

  // A taught route owns the jogger: nothing from the keys or the fork reaches
  // it underneath a replay.
  const replayer = { active: true, cancelled: null, held: null,
                     cancel(why) { this.cancelled = why; this.active = false; },
                     hold(why) { this.held = why; }, status: () => ({}) };
  const r2 = new Rover({ link: { connected: true }, jog: stubJog(), maxFeed: 6000, replayer });
  r2.start();
  r2.setKeys(['w'], 40);
  r2.setLift(1);
  eq(r2.jog.calls, [], 'keys and fork are ignored while a taught route is replaying');
  r2.hold('kapı: PLC devam komutu bekleniyor');
  ok(replayer.held === 'kapı: PLC devam komutu bekleniyor' && replayer.cancelled === null,
     'a PLC hold pauses the replay, it does not cancel it');
  r2.hold(null);
  ok(replayer.held === null, 'and releasing the hold resumes it');
  r2.hold('acil stop', true);
  ok(replayer.cancelled === 'acil stop', 'an emergency stop ends it');
  r2.close();
  rover.close();
}

console.log('\nA Y driver not configured like X is called out');
{
  // The right wheel is on the Y socket. Stock Y matches X, but a Y carrying
  // lead-screw values — 400 steps/mm and 5 mm/s, what Z has — turns that wheel
  // five times as far and caps every move, so connect has to say so rather
  // than let it drive. Z is not a wheel any more and is not looked at.
  const link = new MarlinLink();
  link.settings = { M92: { X: 80, Y: 400, Z: 400 }, M203: { X: 500, Y: 5, Z: 5 },
                    M201: { X: 500, Y: 100 }, M205: { X: 10, Y: 0.3 } };
  eq(link.checkWheelAxes(), ['M92 Y80', 'M203 Y500', 'M201 Y500', 'M205 Y10'],
     'every mismatch is flagged, with the value that fixes it');
  ok(link.logSince(0).lines.some((l) => /does not match X/.test(l.text)), 'and the log says so');

  const stock = new MarlinLink();
  stock.settings = { M92: { X: 80, Y: 80, Z: 400 }, M203: { X: 500, Y: 500, Z: 5 } };
  eq(stock.checkWheelAxes(), [], 'a stock board — Y like X, Z a lead screw — is fine');

  const tuned = new MarlinLink();
  tuned.settings = { M92: { X: 80, Y: 83.5 }, M203: { X: 500, Y: 600 } };
  eq(tuned.checkWheelAxes(), [], 'a calibrated pair a few percent apart is left alone');
}

console.log('\nA stop drops the moves, not the settings');
{
  // The bug this is here for: halt emptied the whole queue, so an M500 or an
  // M203 queued behind a held key's chunks vanished when the key came up.
  const link = new MarlinLink();
  link._q = ['G91', 'G1 X-80.00 Y-80.00 F6000', 'M203 Y500', 'G1 X-80.00 Y-80.00 F6000',
             'M503', 'G28 X', 'M500', 'M114'];
  link.dropMotion();
  eq(link._q, ['G91', 'M203 Y500', 'M503', 'M500', 'M114'],
     'moves and homes are gone; the setting, its read-back and the save are not');
}

console.log('\nA settings write is tracked until the board confirms it');
{
  eq(settingWrite('M203 Y500'), { code: 'M203', params: { Y: 500 } }, 'a write is recognised');
  eq(settingWrite('m205 y6'), { code: 'M205', params: { Y: 6 } },
     'including lower case typed into the console');
  eq(settingWrite('M203'), null, 'a bare query is not a write');
  eq(settingWrite('G1 X5 Y5'), null, 'and a move is not either');

  const link = new MarlinLink();
  link.autosaveMs = 0;                       // no timers here; see below
  link.settings = { M205: { X: 6, Y: 0.6 }, M203: { X: 500, Y: 5 } };
  link._wrote('M205 Y6');
  eq(link.settings.M205.Y, 6,
     'the cache shows the new value at once, so the page does not snap back');
  ok(link.unsaved, 'and the board is now ahead of its EEPROM');
  link._handleLine('echo:  M205 B20000.00 S0.00 T0.00 X6.00 Y0.60 Z0.30 E5.00');
  eq(link.settings.M205.Y, 0.6, 'the read-back has the last word');
  eq(link.rejected, { M205: { Y: { asked: 6, kept: 0.6 } } },
     'and a value the firmware capped is reported, not hidden');
  ok(link.logSince(0).lines.some((l) => /did not stick/.test(l.text)), 'the log says so');

  link._wrote('M203 Y500');
  link._handleLine('echo:  M203 X500.00 Y500.00 Z5.00 E25.00');
  ok(!link.rejected.M203, 'a value that stuck is not flagged');

  link.port = { isOpen: true }; link._stop = false;   // enough for send()
  link.send('M205 Y0.5');
  ok(!link.rejected.M205, 'asking again clears the old verdict as soon as it is queued');
  link.port = null;

  link._handleLine('echo:Settings Stored (671 bytes; crc 22969)');
  ok(!link.unsaved, '"Settings Stored" means saved');
  link._handleLine('echo:Hardcoded Default Settings Loaded');
  ok(link.unsaved, 'a factory reset is unsaved until it is saved');
  link._handleLine('echo:V81 stored settings retrieved (671 bytes; crc 22969)');
  ok(!link.unsaved, 'and loading the EEPROM back is saved by definition');
}

console.log('\nSettings save themselves once the rover is still');
{
  const link = new MarlinLink();
  link.port = { isOpen: true }; link._stop = false;
  link.autosaveMs = 60;
  link._wrote('M203 Y500');
  await sleep(35);
  link._wrote('G1 X-80.00 Y-80.00 F6000');   // still driving: the save waits
  await sleep(40);
  ok(!link._q.includes('M500'), 'no M500 while moves are still going out');
  ok(link.savePending, '...but one is counting down');
  await sleep(50);
  eq(link._q, ['M500'], 'and it is sent once nothing has moved for the delay');
  link._handleLine('echo:Settings Stored (671 bytes; crc 1)');
  link._wrote('G1 X-80.00 Y-80.00 F6000');
  ok(!link.savePending, 'a move with nothing unsaved starts no save');
  link._cancelSave(); link.port = null;
}

console.log('\nNeither wheel starts inverted');
{
  // The right wheel ran backwards on the Z socket only because stock firmware
  // inverts Z opposite to X. Y shares X's direction, so a fresh link flips
  // nothing and the wire carries the direction table as written.
  const link = new MarlinLink();
  eq(link.invert, { X: false, Y: false }, 'no axis is inverted by default');
  const jog = new Jogger(link);
  eq(jog.gcode(DIRECTIONS.forward, 1000, 100), 'G1 X-100.00 Y100.00 F1000',
     'so forward goes out exactly as DIRECTIONS says');
  jog.stop();
}

// ── the HTTP surface, against the real server ────────────────────────
console.log('\n/api/marlin over HTTP, with no printer attached');
// --no-actuator / --routes: this suite runs on the Pi itself, and must neither
// drive the real lift pins nor read or write the routes somebody taught.
const ROUTES = path.join(os.tmpdir(), `routes-marlin-${process.pid}.json`);
const server = spawn('node',
  ['server.js', '--http', '8198', '--host', '127.0.0.1', '--no-connect',
   '--no-camera', '--no-actuator', '--no-lidar', '--no-advertise', '--routes', ROUTES],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let boot = '';
server.stdout.on('data', (d) => { boot += d; });
server.stderr.on('data', (d) => { boot += d; });

const BASE = 'http://127.0.0.1:8198';
// Poll for the port rather than sleeping a fixed 1.5 s — on the Pi that was
// sometimes not enough, and the first fetch died with ECONNREFUSED.
for (let i = 0; i < 100; i++) {
  try { await fetch(`${BASE}/api/marlin/status`); break; } catch { await sleep(100); }
}
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
                           ['halt', {}], ['refresh', {}], ['match', {}]]) {
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

  const wrongLetter = await post('setting', { code: 'M906', params: { Y: 500 } });
  ok(wrongLetter.code === 400 && /does not take Y/.test(wrongLetter.body.error),
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
  try { unlinkSync(ROUTES); } catch { /* never written */ }
}

if (fail) console.log('\nserver output:\n' + boot);
console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
