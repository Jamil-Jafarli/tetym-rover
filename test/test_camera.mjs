/**
 * The Pi's own three: the camera, the QR reader and the machine stats.
 *
 * No hardware and no ffmpeg. What is tested is the part of camera.js that
 * would be hardest to debug on a robot — cutting a byte stream back into whole
 * JPEGs — plus the QR reader's counting, which is the piece with the real bug
 * potential in it, and the /proc arithmetic behind the dashboard's numbers.
 *
 * The QR check is a genuine decode: a real "ROBOT-A1" code, as its 21x21
 * module matrix, painted into a grey buffer the same shape ffmpeg produces.
 * The matrix is embedded rather than generated so the test needs no encoder,
 * and it is a real code rather than a mock so a broken decoder cannot pass.
 *
 *   node test/test_camera.mjs
 */
import { Camera } from '../camera.js';
import { QrReader } from '../qr.js';
import { RpiStats } from '../rpi.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };

// A JPEG, as far as the framer is concerned: starts FFD8, ends FFD9.
const jpeg = (n, fill = 0x41) => Buffer.concat([
  Buffer.from([0xff, 0xd8]), Buffer.alloc(n, fill), Buffer.from([0xff, 0xd9]),
]);

// enabled:false so nothing spawns; the framer is fed by hand.
const mk = () => new Camera({ enabled: false });

console.log('\nCutting a byte stream back into whole JPEGs');
{
  const c = mk();
  const seen = [];
  c.subscribe((f) => seen.push(f));

  c._onJpegData(jpeg(10));
  ok(c.frames === 1 && seen.length === 1, 'one frame in, one frame out');
  ok(seen[0][0] === 0xff && seen[0][1] === 0xd8
     && seen[0][seen[0].length - 1] === 0xd9,
     'the frame handed on is a whole JPEG, markers and all');

  // The realistic case: ffmpeg writes 64 kB chunks that have nothing to do
  // with where frames begin and end.
  const c2 = mk();
  const got = [];
  c2.subscribe((f) => got.push(f.length));
  const two = Buffer.concat([jpeg(20, 1), jpeg(30, 2)]);
  c2._onJpegData(two.subarray(0, 15));
  ok(got.length === 0, 'half a JPEG publishes nothing');
  c2._onJpegData(two.subarray(15, 40));
  c2._onJpegData(two.subarray(40));
  ok(got.length === 2 && got[0] === 24 && got[1] === 34,
     `both frames come out at their real lengths (${got.join(', ')})`);

  // Two whole frames arriving in one chunk must not be published as one.
  const c3 = mk();
  const n3 = [];
  c3.subscribe((f) => n3.push(f.length));
  c3._onJpegData(Buffer.concat([jpeg(5), jpeg(7), jpeg(9)]));
  ok(n3.length === 3, `three frames in one chunk stay three (${n3.length})`);

  // Junk before the first marker: ffmpeg's own preamble, or a stream joined
  // half way through.
  const c4 = mk();
  let last4 = null;
  c4.subscribe((f) => { last4 = f; });
  c4._onJpegData(Buffer.concat([Buffer.from('rubbish'), jpeg(8, 9)]));
  ok(last4 && last4.length === 12, 'leading junk is discarded, not prepended');

  // A stream that has lost sync must not grow forever.
  const c5 = mk();
  c5._onJpegData(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(5 << 20)]));
  ok(c5._buf.length === 0, 'a partial frame past the cap is dropped, not held');
  ok(c5.frames === 0, '...and nothing was published from it');
}

console.log('\nThe latest frame, and who is watching');
{
  const c = mk();
  ok(c.frame === null && c.live === false, 'no camera, no frame, and it says so');
  c._onJpegData(jpeg(4));
  ok(c.frame !== null && c.live === true, 'a fresh frame is live');
  c.frameAt = Date.now() - 5000;
  ok(c.live === false, 'a frame from five seconds ago is not');

  const seen = [];
  const stop = c.subscribe((f) => seen.push(f));
  ok(seen.length === 1, 'a new viewer gets the current frame immediately');
  c._onJpegData(jpeg(4));
  ok(seen.length === 2, '...and the ones after it');
  stop();
  c._onJpegData(jpeg(4));
  ok(seen.length === 2, 'unsubscribing actually stops it');
  ok(c.status().viewers === 0, 'and the count in the status follows');
}

console.log('\nThe grey tap is fixed-size frames, not a stream');
{
  const c = new Camera({ enabled: false, qrWidth: 4, qrHeight: 3 });
  const sizes = [];
  c.onGray((f, w, h) => sizes.push([f.length, w, h]));
  c._onGrayData(Buffer.alloc(30, 7));            // 2.5 frames of 12 bytes
  ok(sizes.length === 2, `12-byte frames out of 30 bytes: two whole ones (${sizes.length})`);
  ok(sizes.every(([n, w, h]) => n === 12 && w === 4 && h === 3),
     'each one is exactly one frame, with its dimensions');
  c._onGrayData(Buffer.alloc(6, 7));             // completes the third
  ok(sizes.length === 3, 'the remainder is carried, not dropped');

  const c2 = new Camera({ enabled: false, qrWidth: 4, qrHeight: 3 });
  c2._onGrayData(Buffer.alloc(120));
  ok(c2._gray.length === 0, 'with nobody reading QR the grey frames are dropped');
}

console.log('\nReading a real QR code');
{
  // "ROBOT-A1", version 1, error correction M. A real code: if the decoder is
  // wrong, or the grey->RGBA conversion is, this cannot pass.
  const M = ['#######...#...#######', '#.....#.#.#.#.#.....#', '#.###.#..#....#.###.#',
             '#.###.#..##...#.###.#', '#.###.#.#####.#.###.#', '#.....#..###..#.....#',
             '#######.#.#.#.#######', '.........#...........', '#.#.#.#.....#...#..#.',
             '####...###.#.#..#.##.', '.##..####..#.##.##.##', '...#.#..##.###.....##',
             '...#.##.####..#.#.#.#', '........#.#...##.#...', '#######...#.#..##..##',
             '#.....#..#....#....#.', '#.###.#.#.#.#.##..#..', '#.###.#....#.#.##.##.',
             '#.###.#.#.##.##.##..#', '#.....#..#.###.#...#.', '#######.#..#.########'];

  /** Paint the matrix into a grey buffer, scaled up, with a quiet zone. */
  const render = (scale, W = 320, H = 240, dark = 0, light = 255) => {
    const g = Buffer.alloc(W * H, light);
    const n = M.length, size = n * scale;
    const x0 = Math.floor((W - size) / 2), y0 = Math.floor((H - size) / 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (M[r][c] !== '#') continue;
        for (let dy = 0; dy < scale; dy++) {
          const row = (y0 + r * scale + dy) * W + x0 + c * scale;
          g.fill(dark, row, row + scale);
        }
      }
    }
    return g;
  };

  const q = new QrReader();
  if (!q.available) {
    console.log(`  [SKIP] jsqr not installed — ${q.error}`);
  } else {
    const frame = render(8);
    const r = q.feed(frame, 320, 240, 1000);
    ok(r && r.text === 'ROBOT-A1', `the code is read: ${r && JSON.stringify(r.text)}`);
    ok(r && r.fresh === true, 'the first sighting is a new reading');
    ok(q.count === 1 && q.text === 'ROBOT-A1', 'and it is counted once');

    // The case that gets counting wrong: a sign held in front of the robot is
    // in view for seconds, which is dozens of decodes of one code.
    for (let t = 1100; t <= 3000; t += 100) q.feed(frame, 320, 240, t);
    ok(q.count === 1, `twenty frames of the same sign is still one reading (${q.count})`);
    ok(q.decodes === 21, `...though every frame did decode (${q.decodes})`);

    // Out of sight past the gap, then back: that is driving past it twice.
    const later = 3000 + q.cfg.regapMs + 500;
    q.feed(frame, 320, 240, later);
    ok(q.count === 2, `the same code after a real gap is a second reading (${q.count})`);
    ok(q.history.length === 2, 'both are in the history');
    ok(q.history[1].at === later, 'stamped when it was read');

    // Nothing there.
    const before = q.count;
    const noise = Buffer.alloc(320 * 240);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) % 256;
    ok(q.feed(noise, 320, 240, later + 10000) === null, 'noise is not a QR code');
    ok(q.count === before, '...and does not count as one');
    ok(q.text === 'ROBOT-A1',
       'the last code read is held rather than cleared by the next blank frame');

    // A frame smaller than it claims must not read past the end of the buffer.
    ok(q.feed(Buffer.alloc(100), 320, 240, later + 20000) === null,
       'a short buffer is refused rather than read off the end');

    const st = q.status();
    ok(st.available === true && st.count === 2 && typeof st.ms === 'number',
       'the status carries what the dashboard shows');
    ok(st.age_s !== null && st.history.length === 2, 'including how long ago, and the list');
  }
}

console.log('\nThe Pi\'s own numbers');
{
  const s = new RpiStats();
  const a = s.sample(Date.now()).status();
  ok(typeof a.mem.total === 'number' && a.mem.total > 0, `total memory (${a.mem.total})`);
  ok(a.mem.used > 0 && a.mem.used < a.mem.total, 'used is inside total');
  ok(a.mem.pct >= 0 && a.mem.pct <= 100, `memory percentage is a percentage (${a.mem.pct})`);
  ok(Array.isArray(a.load) && a.load.length === 3, 'load average, all three');
  ok(a.ncpu >= 1, `core count (${a.ncpu})`);
  ok(typeof a.uptime_s === 'number' && a.uptime_s > 0, 'uptime');
  ok(a.proc && a.proc.rss > 0 && a.proc.pid === process.pid, 'and this process, separately');

  // CPU is a delta between two samples, so a single sample cannot report one —
  // and must not invent an average since boot instead.
  const fresh = new RpiStats();
  ok(fresh.busy === null, 'one sample is not enough to know the CPU load');

  // Burn a little CPU between two samples so there is something to measure.
  const t0 = Date.now();
  while (Date.now() - t0 < 220) Math.sqrt(Math.random());
  const b = s.sample(Date.now()).status();
  ok(b.cpu === null || (b.cpu >= 0 && b.cpu <= 100), `CPU busy is a percentage (${b.cpu})`);
  ok(b.proc.cpu === null || b.proc.cpu >= 0, `this process's own CPU (${b.proc.cpu})`);
  if (b.temp_c !== null) {
    ok(b.temp_c > 0 && b.temp_c < 120, `CPU temperature looks like one (${b.temp_c} °C)`);
  } else {
    console.log('  [SKIP] no thermal zone on this machine');
  }
  ok(Array.isArray(b.cores), `per-core busy (${b.cores.length} cores)`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
