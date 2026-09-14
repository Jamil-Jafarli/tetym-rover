/**
 * The LiDAR map: the wire format, the occupancy grid, and the motion gate.
 *
 * Ported from webscan (packages/protocol + apps/web/src/shared/grid.ts), and
 * kept byte-compatible with it on purpose: the iPhone ARKit sender and the
 * browser depth-model sender both speak SCN1, and they connect to this server
 * exactly as they connect to the webscan relay — `/ws?room=…&role=sender`. So
 * nothing on the phone changes; only the address it is pointed at.
 *
 * Pure — no DOM, no clock. The server loads it through shared.js to inspect
 * and encode frames, the tests load it to check the arithmetic, and the pages
 * load it with a <script> tag to build the map. One copy of the bytes.
 *
 * ── SCN1, little-endian ──
 *
 *   offset size  field
 *        0   4   magic          uint32   'SCN1'
 *        4   1   version        uint8    1
 *        5   1   flags          uint8
 *        6   2   binCount       uint16
 *        8   4   seq            uint32
 *       12   4   x              float32  world metres
 *       16   4   z              float32  world metres
 *       20   4   yaw            float32  radians about +Y, 0 = -Z
 *       24   8   tMs            float64  capture time, epoch ms
 *       32   4   fovRad         float32  angular span of the bins
 *       36   4   matchScore     float32  0..1
 *       40   4   cameraHeightM  float32
 *       44   4   reserved
 *       48   …   binCount × uint16 millimetres, 0 = no return
 *
 * A planar scan, not a point cloud: one range per bearing, which is what a 2D
 * LiDAR reports and ~560 bytes a frame. The 3D 'PCF1' frames webscan also
 * defines are recognised so the relay can pass them through, and ignored by
 * the map.
 *
 * ── coordinates ──
 *
 * The sender's world, not the field's: +X right, -Z forward, yaw about +Y, so
 * heading `yaw` points along (sin yaw, -cos yaw). ARKit puts the origin where
 * the phone was when the session started. It is deliberately NOT rotated onto
 * the competition field — nothing measures how the phone was mounted, and a
 * map shifted by a guessed offset is a confident lie.
 */

const LIDAR_SCAN_MAGIC = 0x314e4353;     // 'S','C','N','1' read as LE uint32
const LIDAR_POINT_MAGIC = 0x31464350;    // 'P','C','F','1' — webscan's 3D frames
const LIDAR_VERSION = 1;
const LIDAR_HEADER = 48;

/** The scale is metric: the ARKit app always, the browser scanner once calibrated. */
const LIDAR_FLAG_CALIBRATED = 1 << 1;
/**
 * The pose is trustworthy. The browser scanner sets it when its scan matcher
 * locked on; the ARKit app sets it while ARKit reports tracking "normal".
 */
const LIDAR_FLAG_MATCHED = 1 << 2;
/**
 * The pose is NOT trustworthy. The browser matcher rejected its own answer, or
 * ARKit's tracking is limited — too fast, too dark, a blank wall — so this scan
 * was taken from wherever ARKit guessed the phone was.
 */
const LIDAR_FLAG_LOST = 1 << 3;

/** Normalise a Node Buffer or any typed-array view into its own ArrayBuffer. */
function lidarBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  // `ws` hands out Buffers that are views into a shared pool, so reading
  // `.buffer` directly reads a neighbouring message's bytes too.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return copy.buffer;
}

/** Encode one scan. `ranges` in metres; 0 or non-finite is "no return". */
function lidarEncode(s) {
  const n = s.binCount;
  const buf = new ArrayBuffer(LIDAR_HEADER + n * 2);
  const dv = new DataView(buf);
  dv.setUint32(0, LIDAR_SCAN_MAGIC, true);
  dv.setUint8(4, LIDAR_VERSION);
  dv.setUint8(5, (s.flags || 0) & 0xff);
  dv.setUint16(6, n, true);
  dv.setUint32(8, (s.seq || 0) >>> 0, true);
  dv.setFloat32(12, s.x, true);
  dv.setFloat32(16, s.z, true);
  dv.setFloat32(20, s.yaw, true);
  dv.setFloat64(24, s.tMs, true);
  dv.setFloat32(32, s.fovRad, true);
  dv.setFloat32(36, s.matchScore || 0, true);
  dv.setFloat32(40, s.cameraHeightM || 0, true);
  dv.setUint32(44, 0, true);
  const out = new Uint16Array(buf, LIDAR_HEADER, n);
  for (let i = 0; i < n; i++) {
    const m = s.ranges[i];
    if (!Number.isFinite(m) || m <= 0) { out[i] = 0; continue; }
    const mm = Math.round(m * 1000);
    out[i] = mm > 65535 ? 65535 : mm;
  }
  return buf;
}

/** The 48-byte header, or null for anything that is not a well-formed SCN1. */
function lidarHeader(buf) {
  if (!buf || buf.byteLength < LIDAR_HEADER) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== LIDAR_SCAN_MAGIC) return null;
  if (dv.getUint8(4) !== LIDAR_VERSION) return null;
  const binCount = dv.getUint16(6, true);
  if (buf.byteLength !== LIDAR_HEADER + binCount * 2) return null;
  return {
    flags: dv.getUint8(5),
    binCount,
    seq: dv.getUint32(8, true),
    x: dv.getFloat32(12, true),
    z: dv.getFloat32(16, true),
    yaw: dv.getFloat32(20, true),
    tMs: dv.getFloat64(24, true),
    fovRad: dv.getFloat32(32, true),
    matchScore: dv.getFloat32(36, true),
    cameraHeightM: dv.getFloat32(40, true),
  };
}

/**
 * Header plus ranges in metres. `out` is reused when it is big enough, so a
 * page decoding ten scans a second does not allocate ten arrays a second.
 */
function lidarDecode(buf, out) {
  const header = lidarHeader(buf);
  if (!header) return null;
  const n = header.binCount;
  const src = new Uint16Array(buf, LIDAR_HEADER, n);
  const ranges = out && out.length >= n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) ranges[i] = src[i] * 0.001;
  return { header, ranges };
}

/**
 * What kind of frame this is, without decoding it — what the relay needs to
 * validate and count a frame it is only passing through.
 */
function lidarInspect(buf) {
  if (!buf || buf.byteLength < 16) return null;
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic === LIDAR_SCAN_MAGIC) {
    const h = lidarHeader(buf);
    return h ? { kind: 'scan', seq: h.seq, tMs: h.tMs, samples: h.binCount, flags: h.flags } : null;
  }
  if (magic === LIDAR_POINT_MAGIC) {
    // 72-byte header, then 9 bytes a point. Checked for size only: the map
    // does not draw these, it just must not be fooled by a truncated one.
    if (buf.byteLength < 72 || dv.getUint8(4) !== LIDAR_VERSION) return null;
    const count = dv.getUint32(12, true);
    if (buf.byteLength !== 72 + count * 9) return null;
    return { kind: 'points', seq: dv.getUint32(8, true), tMs: dv.getFloat64(16, true),
             samples: count };
  }
  return null;
}

/** Bearing of bin `i` in the sensor frame. 0 rad = straight ahead. */
function lidarBinBearing(i, binCount, fovRad) {
  return ((i + 0.5) / binCount - 0.5) * fovRad;
}

// ── the occupancy grid ──────────────────────────────────────────────────

const LIDAR_GRID = {
  size: 640,         // cells per side: 640 × 4 cm is a 25.6 m square
  res: 0.04,         // metres per cell — resolves a doorway, and a corridor edge
  hitDelta: 14,      // log-odds added where a beam ends
  missDelta: 3,      // ...and taken from every cell it passed through
  maxOdds: 110,      // clamps, so a cell can still be corrected later
  minOdds: -45,
  minRange: 0.3,     // closer than this is the robot seeing itself
  maxRange: 8.0,
};

/**
 * Log-odds occupancy grid, the same structure a ROS gmapping node builds.
 *
 * Each cell is an Int8: positive probably occupied, negative probably free,
 * zero never observed. That last distinction is the reason it is a grid and
 * not a point accumulator — a pile of points cannot say "I looked here and it
 * was empty", so it can never show you the doorway.
 */
class LidarGrid {
  constructor(size = LIDAR_GRID.size, res = LIDAR_GRID.res) {
    this.size = size;
    this.res = res;
    this.half = size / 2;
    this.cells = new Int8Array(size * size);
    this.revision = 0;       // bumped on every change, so a renderer knows
  }

  clear() {
    this.cells.fill(0);
    this.revision++;
  }

  cellX(x) { return Math.floor(x / this.res) + this.half; }
  cellZ(z) { return Math.floor(z / this.res) + this.half; }

  at(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) return 0;
    return this.cells[cz * this.size + cx];
  }

  bump(cx, cz, delta) {
    if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) return;
    const i = cz * this.size + cx;
    let v = this.cells[i] + delta;
    if (v > LIDAR_GRID.maxOdds) v = LIDAR_GRID.maxOdds;
    else if (v < LIDAR_GRID.minOdds) v = LIDAR_GRID.minOdds;
    this.cells[i] = v;
  }

  /** Bresenham along the beam, every cell but the last marked free. */
  castFree(x0, z0, x1, z1) {
    let cx = x0, cz = z0;
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;
    // Capped so one wild reading cannot spend milliseconds.
    for (let guard = 0; guard < 4096; guard++) {
      if (cx === x1 && cz === z1) return;
      this.bump(cx, cz, -LIDAR_GRID.missDelta);
      const e2 = err * 2;
      if (e2 > -dz) { err -= dz; cx += sx; }
      if (e2 < dx) { err += dx; cz += sz; }
    }
  }

  /**
   * One planar scan from pose (x, z, yaw). `ranges` in metres, 0 = no return.
   *
   * A zero bin is NO MEASUREMENT, not "nothing out there". Casting free space
   * along it punches a hole through whatever wall is behind — in the picture,
   * a long radial streak past the room boundary for every dropped bin — so an
   * empty bin casts nothing at all.
   */
  insertScan(x, z, yaw, ranges, binCount, fovRad,
             minRange = LIDAR_GRID.minRange, maxRange = LIDAR_GRID.maxRange) {
    const ox = this.cellX(x), oz = this.cellZ(z);
    for (let i = 0; i < binCount; i++) {
      const r = ranges[i];
      if (!(r > 0) || r < minRange) continue;
      const bearing = ((i + 0.5) / binCount - 0.5) * fovRad + yaw;
      const capped = r > maxRange;
      const useR = capped ? maxRange : r;
      const ex = this.cellX(x + useR * Math.sin(bearing));
      const ez = this.cellZ(z - useR * Math.cos(bearing));
      this.castFree(ox, oz, ex, ez);
      if (!capped) this.bump(ex, ez, LIDAR_GRID.hitDelta);
    }
    this.revision++;
  }

  /** Cells ever observed, as square metres — how much of the room is mapped. */
  exploredM2() {
    let n = 0;
    const c = this.cells;
    for (let i = 0; i < c.length; i++) if (c[i] !== 0) n++;
    return n * this.res * this.res;
  }

  /** Cells currently believed occupied. */
  occupiedCells() {
    let n = 0;
    const c = this.cells;
    for (let i = 0; i < c.length; i++) if (c[i] > 0) n++;
    return n;
  }
}

/** RGB for each kind of cell, dark and light. */
const LIDAR_COLORS = {
  dark:  { unknown: [10, 13, 18], free: [17, 28, 40], freeStrong: [24, 42, 60],
           occupied: [56, 189, 248], occupiedStrong: [186, 245, 255] },
  light: { unknown: [247, 249, 252], free: [226, 234, 243], freeStrong: [204, 219, 235],
           occupied: [31, 111, 180], occupiedStrong: [12, 44, 84] },
};

/** Paint the whole grid into an RGBA byte array of size × size × 4. */
function lidarRenderGrid(grid, data, theme = 'dark') {
  const pal = LIDAR_COLORS[theme] || LIDAR_COLORS.dark;
  const cells = grid.cells;
  const put = (a, b, t, o) => {
    data[o] = a[0] + (b[0] - a[0]) * t;
    data[o + 1] = a[1] + (b[1] - a[1]) * t;
    data[o + 2] = a[2] + (b[2] - a[2]) * t;
    data[o + 3] = 255;
  };
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i], o = i * 4;
    if (v === 0) put(pal.unknown, pal.unknown, 0, o);
    else if (v < 0) put(pal.free, pal.freeStrong, Math.min(1, v / LIDAR_GRID.minOdds), o);
    else put(pal.occupied, pal.occupiedStrong, Math.min(1, v / LIDAR_GRID.maxOdds), o);
  }
}

/**
 * Only insert a scan once the sensor has moved.
 *
 * Standing still and inserting every frame stamps dozens of copies of one
 * observation at wherever the estimate happens to be, and the map reinforces
 * its own error. The phone runs the identical gate, so both ends build the
 * same map from the same stream without any extra signalling.
 */
class LidarMotion {
  constructor(minTranslationM = 0.04, minRotationRad = 2 * Math.PI / 180, maxIntervalMs = 700) {
    this.minT = minTranslationM;
    this.minR = minRotationRad;
    this.maxMs = maxIntervalMs;
    this.has = false;
    this.x = 0; this.z = 0; this.yaw = 0; this.t = 0;
  }

  reset() { this.has = false; }

  accept(x, z, yaw, tMs) {
    if (this.has) {
      const moved = Math.hypot(x - this.x, z - this.z);
      let dYaw = Math.abs(yaw - this.yaw);
      while (dYaw > Math.PI) dYaw = Math.abs(dYaw - 2 * Math.PI);
      const stale = tMs - this.t > this.maxMs;
      if (moved < this.minT && dYaw < this.minR && !stale) return false;
    }
    this.has = true;
    this.x = x; this.z = z; this.yaw = yaw; this.t = tMs;
    return true;
  }
}

/** Room names as the relay accepts them; anything else is the default room. */
function lidarRoom(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return /^[a-z0-9-]{1,32}$/.test(s) ? s : 'default';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LIDAR_SCAN_MAGIC, LIDAR_POINT_MAGIC, LIDAR_VERSION, LIDAR_HEADER,
    LIDAR_FLAG_CALIBRATED, LIDAR_FLAG_MATCHED, LIDAR_FLAG_LOST, LIDAR_GRID, LIDAR_COLORS,
    lidarBuffer, lidarEncode, lidarHeader, lidarDecode, lidarInspect,
    lidarBinBearing, lidarRenderGrid, lidarRoom, LidarGrid, LidarMotion,
  };
}
