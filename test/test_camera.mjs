/**
 * The Pi's camera. No hardware and no ffmpeg needed: what is tested is the
 * part of camera.js that would be hardest to debug on a robot — cutting a
 * byte stream back into whole JPEGs.
 *
 *   node test/test_camera.mjs
 */
import { Camera } from '../camera.js';

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

console.log('\nThe QR decoder\'s answers: a header, then whole frames');
{
  // jpeg_gray.py's protocol: u32 width, u32 height, then width*height bytes.
  const frame = (w, h, fill) => {
    const b = Buffer.alloc(8 + w * h, fill);
    b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4);
    return b;
  };
  const c = new Camera({ enabled: false });
  const got = [];
  c.onGray((f, w, h) => got.push([f.length, w, h, f[0]]));
  c._qrBusy = true;
  const two = Buffer.concat([frame(4, 3, 7), frame(4, 3, 9)]);
  c._onGrayData(two.subarray(0, 5));             // not even a whole header
  c._onGrayData(two.subarray(5, 15));
  ok(got.length === 0 && c._qrBusy, 'half a frame delivers nothing, and the decoder is still busy');
  c._onGrayData(two.subarray(15));
  ok(got.length === 2 && got.every(([n, w, h]) => n === 12 && w === 4 && h === 3),
     `split and joined pieces come out as two whole 4x3 frames (${got.length})`);
  ok(got[0][3] === 7 && got[1][3] === 9, 'in order, each with its own pixels');
  ok(!c._qrBusy, 'a delivered frame frees the decoder for the next JPEG');

  c._qrBusy = true;
  c._onGrayData(frame(0, 0, 0));
  ok(got.length === 2 && !c._qrBusy, 'a 0x0 answer (JPEG did not decode) delivers nothing and frees it');
  c._onGrayData(frame(2, 2, 5));
  ok(got.length === 3 && got[2][1] === 2, 'and the next frame, of another size, still comes through');
}

console.log('\nOnly a few JPEGs a second go to the decoder');
{
  // A stand-in decoder, so nothing is spawned: it records what it was sent.
  const c = new Camera({ enabled: false, qrFps: 5 });
  const sent = [];
  c._decoder = () => ({ stdin: { write: (b) => sent.push(b.length) } });
  c._maybeQr(jpeg(10), 1000);
  ok(sent.length === 0, 'nobody reading QR: no JPEG is sent');
  c.onGray(() => {});
  c._maybeQr(jpeg(10), 1000);
  ok(sent.length === 2 && sent[0] === 4 && sent[1] === 14, 'a length header, then the JPEG');
  c._qrBusy = false;
  c._maybeQr(jpeg(10), 1100);
  ok(sent.length === 2, 'the next one 100 ms later is not sent (5 a second = every 200 ms)');
  c._maybeQr(jpeg(10), 1250);
  ok(sent.length === 4, '...250 ms later it is');
  c._maybeQr(jpeg(10), 1600);
  ok(sent.length === 4, 'and nothing more is sent while that one is still being decoded');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
