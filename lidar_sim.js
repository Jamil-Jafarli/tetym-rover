/**
 * A simulated LiDAR — what `--lidar-sim` streams when there is no phone.
 *
 * The esp32ws_sim.js of the map: a sensor carried round a loop in a made-up
 * room, ray-cast against its walls, encoded as real SCN1 frames and pushed into
 * the relay as a sender like any other. The dashboard, /lidar and the tests
 * therefore exercise the same decode, grid and drawing a phone would.
 *
 * It is NOT the robot. The room is invented and the sensor's path has nothing
 * to do with the wheels, and it says so in its label and its sender-state note
 * rather than letting a simulated map pass for a measured one.
 */

import { loadShared } from './shared.js';

const { lidarEncode, LIDAR_FLAG_MATCHED } =
  loadShared('lidar.js', ['lidarEncode', 'LIDAR_FLAG_MATCHED']);

/** Walls as [x1, z1, x2, z2] in metres: a 10 × 6 m room with some furniture. */
export const SIM_ROOM = (() => {
  const box = (cx, cz, w, d) => {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    return [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
  };
  return [
    // the outer wall, with a 1 m doorway in the top
    [-5, -3, -1, -3], [0, -3, 5, -3], [5, -3, 5, 3], [5, 3, -5, 3], [-5, 3, -5, -3],
    // a stub of partition wall
    [1.5, 3, 1.5, 2.2],
    ...box(0, 0, 0.8, 0.8),          // a pillar in the middle
    ...box(-3.9, 2.2, 1.24, 1.0),    // two crates the size of a field box
    ...box(3.9, -2.2, 1.24, 1.0),
  ];
})();

/** Small, seeded, so a test run sees the same noise every time. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance along a ray to the nearest wall, or Infinity. */
export function castRay(ox, oz, dx, dz, walls = SIM_ROOM) {
  let best = Infinity;
  for (const [x1, z1, x2, z2] of walls) {
    const ex = x2 - x1, ez = z2 - z1;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((x1 - ox) * ez - (z1 - oz) * ex) / den;   // along the ray
    const u = ((x1 - ox) * dz - (z1 - oz) * dx) / den;   // along the wall
    if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}

/** Where the sensor is at time `t` seconds: an ellipse round the pillar. */
export function simPose(t, speed = 0.45) {
  const a = 3.1, b = 1.6;
  const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const th = (t * speed / perimeter) * 2 * Math.PI;
  const x = a * Math.cos(th), z = b * Math.sin(th);
  // Heading along the tangent. Yaw 0 looks along -Z; +yaw turns towards +X.
  const vx = -a * Math.sin(th), vz = b * Math.cos(th);
  return { x, z, yaw: Math.atan2(vx, -vz) };
}

export class LidarSim {
  constructor({ relay, room, hz = 10, bins = 256, fovDeg = 100, maxRange = 6,
                noise = 0.01, dropout = 0.03, seed = 7 } = {}) {
    this.relay = relay;                 // may be null when only scan() is wanted
    this.room = room || (relay && relay.room);
    this.hz = hz;
    this.bins = bins;
    this.fov = fovDeg * Math.PI / 180;
    this.maxRange = maxRange;
    this.noise = noise;
    this.dropout = dropout;
    this.rand = rng(seed);
    this.seq = 0;
    this.timer = null;
    this.ranges = new Float32Array(bins);
  }

  /** One scan at time `t`, as the bytes a phone would send. */
  scan(t, tMs = Date.now()) {
    const p = simPose(t);
    for (let i = 0; i < this.bins; i++) {
      const b = ((i + 0.5) / this.bins - 0.5) * this.fov + p.yaw;
      let r = castRay(p.x, p.z, Math.sin(b), -Math.cos(b));
      // A real sensor misses now and then and is never exactly right. A miss
      // is 0 — "no return" — never the maximum range.
      if (r > this.maxRange || this.rand() < this.dropout) r = 0;
      else r += (this.rand() * 2 - 1) * this.noise;
      this.ranges[i] = r;
    }
    return lidarEncode({
      seq: this.seq++, tMs, flags: LIDAR_FLAG_MATCHED, x: p.x, z: p.z, yaw: p.yaw,
      fovRad: this.fov, matchScore: 1, cameraHeightM: 0.3,
      ranges: this.ranges, binCount: this.bins,
    });
  }

  start() {
    if (this.timer) return this;
    this.sender = this.relay.localSender(this.room, 'SIMULATED lidar');
    this.sender.state({ active: true, calibrated: true, note: 'simulated — not the robot' });
    const t0 = Date.now();
    this.timer = setInterval(() => this.sender.send(this.scan((Date.now() - t0) / 1000)),
                             1000 / this.hz);
    this.timer.unref();
    return this;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.sender.close();
  }
}
