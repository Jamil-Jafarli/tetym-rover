#!/usr/bin/env python3
"""
The QR reader's JPEG decoder: camera.js hands it a JPEG, it hands back grey.

Why a Python process and not ffmpeg: ffmpeg reading JPEGs from a pipe holds
its output until the pipe closes (measured 2026-09-15 on the Pi — three JPEGs
written 1.5 s apart all came out together, at EOF, with jpeg_pipe or mjpeg,
threads 1 or not). A reader that sees frames seconds late is no reader. And
there is no JPEG decoder in node_modules. PIL is already on the Pi, uses
libjpeg-turbo, and decodes luma only when asked: 31 ms for a 1920x1080 frame
while the Pi was throttled to 600 MHz.

It only ever sees the few frames a second the QR reader asks for (camera.js
qrFps) — the video itself is never decoded on the Pi.

Protocol on stdin/stdout, big-endian:
  in:   u32 length, then that many bytes of JPEG
  out:  u32 width, u32 height, then width*height grey bytes, one per pixel
        (0, 0 and nothing else: that JPEG did not decode — the reason is on
        stderr — so the caller can stop waiting for it)
"""
import io
import struct
import sys

from PIL import Image


def main():
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
            im.draft('L', im.size)          # decode the luma plane only
            im = im.convert('L')
            wr.write(struct.pack('>II', im.width, im.height))
            wr.write(im.tobytes())
        except Exception as e:              # a torn frame must not end the reader
            sys.stderr.write(f'jpeg: {e}\n')
            sys.stderr.flush()
            wr.write(struct.pack('>II', 0, 0))
        wr.flush()


if __name__ == '__main__':
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
