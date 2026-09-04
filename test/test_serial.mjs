/**
 * The whole stack against a board on a real serial device.
 *
 * test_marlin.mjs checks the G-code we would send; this checks what a board
 * actually receives, over a pty, with `ok` flow control and a planner that
 * only acknowledges a move when it has room for it. Everything here is a
 * regression: each assertion is a failure that happened on hardware.
 *
 *   · holding a key produced ONE move and then nothing, because the default
 *     chunk was a 141 mm diagonal that takes 8.5 s at F1000
 *   · releasing the key sent a quickstop every time, on firmware that reports
 *     EMERGENCY_PARSER:0 and does not want it — there is now no quickstop at
 *     all, and one of the checks below is that none ever appears on the wire
 *   · a command written past the queue was acknowledged too, and that `ok` was
 *     read as permission to send a queued command, so the host ran one command
 *     ahead of the board from then on
 *
 * The fixture is Python because Node has no openpty; it is skipped if python3
 * is missing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (spawnSync('python3', ['-c', 'import pty']).status !== 0) {
  console.log('\npython3 not available — skipping the serial test\n');
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };

// ── a board and a server pointed at it ───────────────────────────────
async function bringUp({ port, m400 = '1' }) {
  const board = spawn('python3', [path.join(HERE, 'fake_marlin.py')],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, M400_BLOCKS: m400 } });
  const log = { wire: '', boot: '' };
  board.stderr.on('data', (d) => { log.wire += d; });

  const devPath = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('fixture never named its pty')), 5000);
    board.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) { clearTimeout(timer); resolve(out.trim()); }
    });
  });

  const server = spawn('node',
    ['server.js', '--http', String(port), '--host', '127.0.0.1', '--port', devPath],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { log.boot += d; });
  server.stderr.on('data', (d) => { log.boot += d; });
  await sleep(7000);          // the 2.5 s DTR wait, the settings read, the probe

  return {
    devPath, log,
    post: async (route, body = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/marlin/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { code: r.status, body: await r.json() };
    },
    status: async () => (await fetch(`http://127.0.0.1:${port}/api/marlin/status`)).json(),
    kill: () => { server.kill(); board.kill(); },
  };
}

const rig = await bringUp({ port: 8192 });
let liar = null;
const { post, status } = rig;
const board = { kill: rig.kill };
const server = { kill: () => {} };
console.log(`\nfake Marlin on ${rig.devPath}`);

/** Everything the board logged between two markers, in order. */
const mark = (n) => post('gcode', { cmd: `M117 PHASE${n}` });
function slice(phase) {
  const lines = rig.log.wire.split('\n');
  const from = lines.findIndex((l) => l.includes(`--> M117 PHASE${phase}`));
  const to = lines.findIndex((l) => l.includes(`--> M117 PHASE${phase + 1}`));
  return from < 0 ? [] : lines.slice(from + 1, to < 0 ? undefined : to);
}
const received = (phase) => slice(phase)
  .filter((l) => l.includes('--> '))
  .map((l) => l.split('--> ')[1].trim());

/** Seconds between successive moves, as the board saw them arrive. */
function gaps(phase) {
  const at = slice(phase)
    .filter((l) => / --> G1 /.test(l))
    .map((l) => parseFloat(l.slice(1, 9)));
  return at.slice(1).map((t, i) => t - at[i]);
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

/** The deepest the board's planner ever got. One means nothing accumulated. */
function deepestPlanner(phase) {
  const depths = slice(phase).map((l) => /planner=(\d+)/.exec(l))
    .filter(Boolean).map((m) => +m[1]);
  return depths.length ? Math.max(...depths) : 0;
}

try {
  const before = await status();
  ok(before.connected === true, 'the server opened the pty');
  ok(/Marlin 1\.1\.6/.test(before.firmware), `it read the firmware back: ${before.firmware.slice(14, 30)}`);
  ok(before.emergency_parser === false,
     'this board reports EMERGENCY_PARSER:0, like a stock Creality one');
  ok(before.settings?.M92?.X === 80, 'and its steps/mm came from M503');
  ok(before.unsupported?.includes('M906'),
     'a code it answered "Unknown command" to is recorded as unsupported');

  // The barrier is measured, not assumed. G4 occupies the planner for a known
  // time and moves nothing, so the probe is safe on an unhomed machine.
  ok(before.m400_blocks === true,
     `M400 was checked and does block here (${before.barrier_ms} ms on a 300 ms dwell)`);
  ok(before.barrier_ms >= 250 && before.barrier_ms < 1500,
     'and the measurement is the dwell, not a guess');

  // ── 1. a held key must actually stream ────────────────────────────
  console.log('\nHolding a key streams moves');
  await mark(1);
  const run = await post('run', { axes: { X: -1, Y: 1 } });   // default speed
  ok(run.code === 200 && run.body.mode === 'stream', 'the hold starts');
  ok(run.body.chunk_seconds < 1,
     `one chunk is well under a second (${run.body.chunk_seconds?.toFixed(2)} s)`);
  await sleep(2000);
  await post('halt', {});                          // the key comes up
  await sleep(600);
  await mark(2);

  const held = received(1);
  const moves = held.filter((l) => l.startsWith('G1 '));
  ok(moves.length >= 4,
     `a two second hold sent ${moves.length} moves, not one`);
  ok(new Set(moves).size === 1, `every one of them identical: ${moves[0]}`);
  ok(/^G1 X-[\d.]+ Y[\d.]+ F6000$/.test(moves[0] || ''),
     'shaped the way the operator asked for, at the default speed');

  // ── nothing may accumulate ────────────────────────────────────────
  // The complaint this is here for: the rover kept moving after the key came
  // up, because chunks were sent at 0.8x the move time and the planner filled.
  console.log('\nNothing accumulates in the planner');
  const pairs = held.filter((l) => l.startsWith('G1 ') || l === 'M400');
  ok(pairs.length >= 8 && pairs.every((l, i) => (i % 2 === 0) === l.startsWith('G1 ')),
     `every move is followed by its own M400  (${pairs.length} lines, alternating)`);
  ok(deepestPlanner(1) === 1,
     `the board never held more than one move at a time (${deepestPlanner(1)})`);

  const spacing = gaps(1);
  const chunk = run.body.chunk_seconds;
  ok(Math.min(...spacing) >= chunk,
     `no move was sent before the previous had finished `
     + `(closest ${Math.min(...spacing).toFixed(3)}s vs a ${chunk.toFixed(3)}s move)`);
  ok(mean(spacing) < chunk * 1.6,
     `...and not so much later that the machine stutters (mean ${mean(spacing).toFixed(3)}s)`);

  // ── 2. the release ────────────────────────────────────────────────
  console.log('\nReleasing the key stops the stream');
  ok(held.includes('M114'), 'the position is re-read afterwards');
  await sleep(300);
  ok((await status()).jogging === false, 'and the jogger is idle');

  // ── 3. the speed sets the gap between commands ────────────────────
  console.log('\nThe speed decides how often a line goes out');

  /** Hold at this speed and chunk, and report what the board actually saw. */
  async function holdAt(phase, feedrate, step, ms) {
    const r = await post('run', { axes: { X: -1, Y: 1 }, feedrate, step });
    await sleep(ms);
    await post('halt', {});
    await sleep(400);
    await mark(phase + 1);
    return { predicted: r.body.chunk_seconds, measured: mean(gaps(phase)),
             deepest: deepestPlanner(phase) };
  }

  const slow = await holdAt(2, 1500, 20, 4000);     // phase 2, marks 3
  const fast = await holdAt(3, 12000, 20, 3000);    // phase 3, marks 4

  ok(slow.measured > fast.measured * 2,
     `raising the speed shortens the gap: F1500 every ${slow.measured.toFixed(3)}s, `
     + `F12000 every ${fast.measured.toFixed(3)}s`);

  // The gap has to track the move, not merely differ. Both sides of that are
  // worth pinning: the pacing follows the speed, and it follows it accurately.
  for (const [name, r] of [['F1500', slow], ['F12000', fast]]) {
    ok(Math.abs(r.measured - r.predicted) < r.predicted * 0.3,
       `${name}: a ${r.predicted.toFixed(3)}s move went out every `
       + `${r.measured.toFixed(3)}s — the gap is the move`);
  }
  ok(slow.deepest === 1 && fast.deepest === 1,
     'and neither speed lets a move pile up');

  // Above a point the feed rate stops mattering, because a short chunk never
  // reaches it — the move is acceleration-limited and the trapezoid collapses
  // to a triangle. Worth knowing before wondering why F30000 feels no faster.
  const tiny = await holdAt(4, 30000, 2, 1500);     // phase 4, marks 5
  ok(tiny.measured < 0.2 && Math.abs(tiny.measured - tiny.predicted) < 0.1,
     `a 2 mm chunk at F30000 is acceleration-limited: `
     + `${tiny.predicted.toFixed(3)}s predicted, ${tiny.measured.toFixed(3)}s seen`);

  // ── 4. there is exactly one kind of stop ──────────────────────────
  console.log('\nThere is no quickstop, by design');
  await post('run', { axes: { X: -1, Y: 1 } });
  await sleep(800);
  const stopped = await post('halt', { hard: true });   // even when asked for one
  ok(stopped.code === 200, 'the STOP button stops');
  ok(stopped.body.hard === undefined,
     'and there is no longer a second, harder kind to ask for');
  await sleep(600);
  await mark(6);
  ok(!received(5).includes('M410'),
     'M410 is not sent even when a caller explicitly asks to be hard about it');

  // "One long move" was the only thing that needed a quickstop, so it is gone
  // too: a 2000 mm move with nothing able to cancel it is not a hold mode, it
  // is a hazard.
  const long = await post('run', { axes: { X: -1, Y: 1 }, mode: 'continuous', span: 2000 });
  ok(long.body.mode === 'stream', 'asking for the old long-move mode gets a stream');
  await sleep(500);
  await post('halt', {});
  await sleep(600);
  await mark(7);
  const everything = received(6);
  ok(!everything.some((l) => /X-?2000|Y-?2000/.test(l)),
     'and no 2000 mm move goes out under any name');

  ok(!rig.log.wire.includes('M410'),
     'M410 appears nowhere in the entire session');

  // ── 4. flow control must stay one-for-one ─────────────────────────
  console.log('\nThe host never runs ahead of the board');
  let outstanding = 0, worst = 0;
  for (const line of rig.log.wire.split('\n')) {
    if (line.includes('--> ')) worst = Math.max(worst, ++outstanding);
    else if (/<-- ok\b/.test(line)) outstanding = Math.max(0, outstanding - 1);
  }
  ok(worst <= 1,
     `at most one command was ever awaiting its ok (worst: ${worst})`);
  ok((await status()).in_flight <= 1, 'and the link agrees');

  // The specific desync: a command written past the queue is acknowledged too,
  // and that ok belongs to it — not to the next thing in the queue.
  await mark(8);
  await post('gcode', { cmd: 'M114' });
  await sleep(500);
  const tail = rig.log.wire.split('\n').filter((l) => /--> |<-- ok/.test(l)).slice(-40);
  let bad = 0, live = 0;
  for (const line of tail) {
    if (line.includes('--> ')) { if (live > 0) bad++; live++; }
    else live = Math.max(0, live - 1);
  }
  ok(bad === 0, 'after all of that, still no command sent before its turn');
  // ── 6. a board whose M400 is a lie ────────────────────────────────
  // The failure this exists for: everything above passes on firmware that
  // blocks, and none of it holds on firmware that does not. A board with no
  // M400 answers "Unknown command" and an ok in the same millisecond, which
  // from the host's side is indistinguishable from a move that finished
  // instantly — so the stream free-runs and the planner fills. The clock is
  // the brake that has to hold on its own here.
  console.log('\nA board that answers M400 without waiting');
  liar = await bringUp({ port: 8193, m400: '0' });
  const seen = await liar.status();
  ok(seen.connected === true, 'it connects');
  ok(seen.m400_blocks === false,
     `the probe caught it: ${seen.barrier_ms} ms for a 300 ms dwell`);
  const said = (await (await fetch('http://127.0.0.1:8193/api/marlin/log?since=0')).json())
    .lines.map((l) => l.text).join(' ');
  ok(/M400 does not wait on this firmware/.test(said),
     'and the page log says so rather than leaving it a mystery');
  ok(/paced|pacing each chunk by its own run time/.test(said),
     '...along with what it is doing instead');

  const lied = await liar.post('run', { axes: { X: -1, Y: 1 } });
  await sleep(2500);
  await liar.post('halt', {});
  await sleep(500);

  const wire = liar.log.wire.split('\n');
  const depths = wire.map((l) => /planner=(\d+)/.exec(l)).filter(Boolean).map((m) => +m[1]);
  const at = wire.filter((l) => / --> G1 /.test(l)).map((l) => parseFloat(l.slice(1, 9)));
  const spans = at.slice(1).map((t, i) => t - at[i]);

  ok(at.length >= 4, `the hold still streams (${at.length} moves)`);
  ok(Math.max(...depths) === 1,
     `and STILL nothing accumulates (deepest planner ${Math.max(...depths)})`);
  ok(Math.min(...spans) >= lied.body.chunk_seconds,
     `every gap covers the whole move (closest ${Math.min(...spans).toFixed(3)}s `
     + `vs ${lied.body.chunk_seconds.toFixed(3)}s)`);
  ok(mean(spans) < lied.body.chunk_seconds * 1.6,
     `without being needlessly slow about it (mean ${mean(spans).toFixed(3)}s)`);
} finally {
  rig.kill();
  if (liar) liar.kill();
}

if (fail) console.log('\nserver:\n' + rig.log.boot + '\n\nwire:\n' + rig.log.wire);
console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
