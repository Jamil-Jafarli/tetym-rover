# Depth-loop benchmark

The scan extractor's inner loop, in C, in two forms: the straightforward
per-pixel unprojection and the table + early-reject form that ships in
`ScanExtractor.swift`. Same algorithm, same structure, so the numbers are
indicative of what the Swift does — not identical to it.

```bash
cc -O2 -march=native -o bench scan_loop_bench.c -lm && ./bench
```

It checks correctness first and speed second: the optimised version reassociates
the arithmetic, so the last ulp moves and bit-equality is the wrong bar. What
matters is whether any difference survives the 1 mm quantisation on the wire.

Measured (x86-64, -O2), 256×192 depth map, five camera poses:

```
  v1 naive           0.218 ms/frame
  v2 tables+reject   0.110 ms/frame
  speedup            1.98x
  max difference     4.8e-07 m   (0.48 µm — invisible after quantisation)
```

**Read the absolute number, not the ratio.** 0.11 ms per frame at 10 Hz is about
0.1% of one core. This loop was never the bottleneck, and making it twice as
fast changes no battery life you can feel. It ships because it is also simpler
and allocation-free, not because it rescued anything.

The costs that actually matter on device are the ARKit session itself (camera +
LiDAR + VIO), the preview renderer, and the radio — which is why the
optimisation work went there. See the "What actually costs" section in
`../README.md`.
