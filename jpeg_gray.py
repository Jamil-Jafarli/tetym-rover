#!/usr/bin/env python3
"""
The camera's JPEG decoder: camera.js hands it a JPEG, it hands back pixels.

Two readers want pixels and they want different ones, so the same program runs
twice with different arguments:

    python3 jpeg_gray.py                    grey, full resolution — the QR reader
    python3 jpeg_gray.py --rgb 480x360      colour, small — the line detector

The QR code needs every pixel the sensor has (a 50 mm code at 320x240 does not
decode; at 1920x1080 it does) and does not care about colour. The line detector
needs colour — the competition line is blue | orange | blue, and road.js tells
them apart by hue — and works at 480x360, the resolution the pages draw into.
Asking for the small size is not just a resize afterwards: draft() lets
libjpeg scale in the DCT domain, so a 1080p frame is decoded at a fraction of
the cost of a full one.

Why a Python process and not ffmpeg: ffmpeg reading JPEGs from a pipe holds
its output until the pipe closes (measured 2026-09-15 on the Pi — three JPEGs
written 1.5 s apart all came out together, at EOF, with jpeg_pipe or mjpeg,
threads 1 or not). A reader that sees frames seconds late is no reader. And
there is no JPEG decoder in node_modules. PIL is already on the Pi, uses
libjpeg-turbo, and decodes luma only when asked: 31 ms for a 1920x1080 frame
while the Pi was throttled to 600 MHz.

It only ever sees the few frames a second its reader asks for (camera.js
qrFps / roadFps) — the video itself is never decoded on the Pi.

Protocol on stdin/stdout, big-endian:
  in:   u32 length, then that many bytes of JPEG
  out:  u32 width, u32 height, then width*height bytes of grey — or, in --rgb,
        width*height*3 bytes, R G B per pixel
        (0, 0 and nothing else: that JPEG did not decode — the reason is on
        stderr — so the caller can stop waiting for it)
"""
import io
import struct
import sys

from PIL import Image


def parse_size(s):
    w, _, h = s.lower().partition('x')
    return int(w), int(h)


def main(argv):
    rgb = '--rgb' in argv
    size = None
    for i, a in enumerate(argv):
        if a == '--rgb' and i + 1 < len(argv) and not argv[i + 1].startswith('-'):
            size = parse_size(argv[i + 1])
        elif a == '--size' and i + 1 < len(argv):
            size = parse_size(argv[i + 1])
    mode = 'RGB' if rgb else 'L'

    rd, wr = sys.stdin.buffer, sys.stdout.buffer
    while True:
        hdr = rd.read(4)
        if len(hdr) < 4:
            return
        (n,) = struct.unpack('>I', hdr)
        data = rd.read(n)
        if len(data) < n:
            return
        try:
            im = Image.open(io.BytesIO(data))
            # draft() is the whole reason the small size is cheap: it asks
            # libjpeg for the largest DCT reduction that is still at least the
            # size wanted, so most of the frame is never reconstructed at all.
            im.draft(mode, size or im.size)
            im = im.convert(mode)
            if size and im.size != size:
                im = im.resize(size)
            wr.write(struct.pack('>II', im.width, im.height))
            wr.write(im.tobytes())
        except Exception as e:              # a torn frame must not end the reader
            sys.stderr.write(f'jpeg: {e}\n')
            sys.stderr.flush()
            wr.write(struct.pack('>II', 0, 0))
        wr.flush()


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (BrokenPipeError, KeyboardInterrupt):
        pass
