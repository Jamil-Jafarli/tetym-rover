/**
 * The LiDAR map on a page: a viewer socket and a top-down radar.
 *
 * Ported from webscan's viewer (apps/web/src/viewer2d). The page rebuilds the
 * SAME occupancy grid the phone built, from the same scans at the same poses,
 * behind the same motion gate — nothing is re-derived here, so what is drawn is
 * the map the scanner holds, not an approximation of it.
 *
 * Two layers on one canvas:
 *   1. the grid, painted into an offscreen canvas at one pixel per cell and
 *      rebuilt only when it changes, so panning stays smooth at any map size
 *   2. overlays in world metres: range rings, the live scan wedge, the path
 *      the sensor took, the sensor itself
 *
 * Needs public/lidar.js loaded first.
 */

const LIDAR_TRAIL_MAX = 4000;
const LIDAR_STALE_MS = 2500;
/** Longer than this between two scans: the phone is standing still (see frame()). */
const LIDAR_STILL_GAP_MS = 450;

class LidarRadar {
  constructor(canvas, grid) {
    this.canvas = canvas;
    this.grid = grid;
    this.ctx = canvas.getContext('2d');
    this.view = { cx: 0, cz: 0, zoom: 34 };     // world centre, pixels per metre
    this.follow = true;
    this.showRings = true;
    this.gridCanvas = document.createElement('canvas');
    this.gridCanvas.width = this.gridCanvas.height = grid.size;
    this.gridCtx = this.gridCanvas.getContext('2d');
    this.gridImage = this.gridCtx.createImageData(grid.size, grid.size);
    this.drawn = { revision: -1, theme: '' };
    this.trail = new Float32Array(LIDAR_TRAIL_MAX * 2);
    this.trailCount = 0;
    this.attachInput();
  }

  get w() { return this.canvas.clientWidth; }
  get h() { return this.canvas.clientHeight; }

  /** Keep the backing store at the displayed size, so lines stay one pixel. */
  fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(this.w * dpr), H = Math.round(this.h * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clearTrail() { this.trailCount = 0; }

  pushTrail(x, z) {
    if (this.trailCount > 0) {
      const o = (this.trailCount - 1) * 2;
      const dx = this.trail[o] - x, dz = this.trail[o + 1] - z;
      if (dx * dx + dz * dz < 0.0009) return;             // under 3 cm
    }
    if (this.trailCount >= LIDAR_TRAIL_MAX) {
      this.trail.copyWithin(0, 2);
      this.trailCount--;
    }
    const o = this.trailCount * 2;
    this.trail[o] = x; this.trail[o + 1] = z;
    this.trailCount++;
  }

  invalidate() { this.drawn.revision = -1; }

  sx(x) { return this.w / 2 + (x - this.view.cx) * this.view.zoom; }
  sy(z) { return this.h / 2 + (z - this.view.cz) * this.view.zoom; }

  draw(sensor, dark) {
    this.fit();
    const g = this.ctx, w = this.w, h = this.h;
    const theme = dark ? 'dark' : 'light';
    if (this.follow && sensor) { this.view.cx = sensor.x; this.view.cz = sensor.z; }

    const pal = LIDAR_COLORS[theme].unknown;
    g.fillStyle = `rgb(${pal[0]},${pal[1]},${pal[2]})`;
    g.fillRect(0, 0, w, h);

    if (this.grid.revision !== this.drawn.revision || this.drawn.theme !== theme) {
      lidarRenderGrid(this.grid, this.gridImage.data, theme);
      this.gridCtx.putImageData(this.gridImage, 0, 0);
      this.drawn.revision = this.grid.revision;
      this.drawn.theme = theme;
    }
    const cellPx = this.grid.res * this.view.zoom;
    const edge = -(this.grid.size / 2) * this.grid.res;
    g.imageSmoothingEnabled = cellPx < 3;                  // crisp cells up close
    g.drawImage(this.gridCanvas, this.sx(edge), this.sy(edge),
                this.grid.size * cellPx, this.grid.size * cellPx);
    g.imageSmoothingEnabled = true;

    if (sensor) {
      if (this.showRings) this.drawRings(sensor, dark);
      if (sensor.ranges) this.drawScan(sensor);
      this.drawTrail();
      this.drawSensor(sensor);
    }
    this.drawScale(dark);
  }

  drawRings(s, dark) {
    const g = this.ctx, x = this.sx(s.x), y = this.sy(s.z);
    const far = Math.hypot(this.w, this.h);
    g.save();
    g.strokeStyle = dark ? 'rgba(56,189,248,0.16)' : 'rgba(31,111,180,0.22)';
    g.lineWidth = 1;
    g.setLineDash([3, 5]);
    for (let r = 1; r <= 10; r++) {
      const px = r * this.view.zoom;
      if (px < 22) continue;
      if (px > far) break;
      g.beginPath(); g.arc(x, y, px, 0, Math.PI * 2); g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = dark ? 'rgba(56,189,248,0.10)' : 'rgba(31,111,180,0.12)';
    for (let a = 0; a < 360; a += 30) {
      const rad = a * Math.PI / 180;
      g.beginPath(); g.moveTo(x, y);
      g.lineTo(x + Math.sin(rad) * far / 2, y - Math.cos(rad) * far / 2);
      g.stroke();
    }
    g.restore();
  }

  /** What the sensor can see right now: a filled wedge, returns on its edge. */
  drawScan(s) {
    const g = this.ctx, r = s.ranges;
    const pts = [];
    for (let i = 0; i < s.binCount; i++) {
      if (!(r[i] > 0)) continue;
      const b = lidarBinBearing(i, s.binCount, s.fovRad) + s.yaw;
      pts.push(this.sx(s.x + r[i] * Math.sin(b)), this.sy(s.z - r[i] * Math.cos(b)));
    }
    if (!pts.length) return;
    g.save();
    g.beginPath();
    g.moveTo(this.sx(s.x), this.sy(s.z));
    for (let i = 0; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath();
    g.fillStyle = 'rgba(74,222,128,0.12)';
    g.fill();
    g.fillStyle = '#3fb950';
    for (let i = 0; i < pts.length; i += 2) g.fillRect(pts[i] - 1, pts[i + 1] - 1, 2.5, 2.5);
    g.restore();
  }

  drawTrail() {
    if (this.trailCount < 2) return;
    const g = this.ctx;
    g.save();
    g.strokeStyle = 'rgba(88,166,255,0.8)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(this.sx(this.trail[0]), this.sy(this.trail[1]));
    for (let i = 1; i < this.trailCount; i++) {
      g.lineTo(this.sx(this.trail[i * 2]), this.sy(this.trail[i * 2 + 1]));
    }
    g.stroke();
    g.restore();
  }

  /**
   * Green when the pose is trusted (a scan match, or ARKit tracking normal),
   * red when the sender says it is lost, amber when it says neither, grey when
   * nothing has arrived for a while.
   */
  drawSensor(s) {
    const g = this.ctx, x = this.sx(s.x), y = this.sy(s.z);
    const c = s.stale ? '#8b949e' : s.lost ? '#f85149' : s.locked ? '#3fb950' : '#d29922';
    g.save();
    g.strokeStyle = c; g.fillStyle = c; g.lineWidth = 2;
    g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(x, y);
    g.lineTo(x + Math.sin(s.yaw) * 22, y - Math.cos(s.yaw) * 22); g.stroke();
    g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  drawScale(dark) {
    const g = this.ctx;
    let m = 50;
    for (const c of [0.5, 1, 2, 5, 10, 20, 50]) { if (c * this.view.zoom >= 60) { m = c; break; } }
    const px = m * this.view.zoom, x = 16, y = this.h - 20;
    g.save();
    g.strokeStyle = g.fillStyle = dark ? '#8b949e' : '#5a6570';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x, y - 5); g.lineTo(x, y + 5);
    g.moveTo(x, y); g.lineTo(x + px, y);
    g.moveTo(x + px, y - 5); g.lineTo(x + px, y + 5);
    g.stroke();
    g.font = '600 12px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle';
    g.fillText(`${m} m`, x + px + 8, y);
    g.restore();
  }

  zoomAt(px, py, factor) {
    const bx = this.view.cx + (px - this.w / 2) / this.view.zoom;
    const bz = this.view.cz + (py - this.h / 2) / this.view.zoom;
    this.view.zoom = Math.max(4, Math.min(400, this.view.zoom * factor));
    this.view.cx = bx - (px - this.w / 2) / this.view.zoom;
    this.view.cz = bz - (py - this.h / 2) / this.view.zoom;
  }

  /** Drag to pan, wheel or pinch to zoom. Dragging turns follow off. */
  attachInput() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    // Every finger currently down, so two of them can be a pinch.
    const down = new Map();
    const spread = () => {
      const [a, b] = [...down.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    c.addEventListener('pointerdown', (e) => {
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { c.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    });
    // Screen pixels per canvas pixel. 1 normally; not 1 on a page that scales
    // itself to fit, like /panel, where a drag would otherwise run ahead of
    // the finger.
    const k = () => (c.getBoundingClientRect().width / c.clientWidth) || 1;
    c.addEventListener('pointermove', (e) => {
      const last = down.get(e.pointerId);
      if (!last) return;
      if (down.size === 2) {
        const before = spread();
        last.x = e.clientX; last.y = e.clientY;
        const after = spread();
        if (before.d > 0) {
          const r = c.getBoundingClientRect();
          this.zoomAt((after.mx - r.left) / k(), (after.my - r.top) / k(), after.d / before.d);
        }
        return;
      }
      this.view.cx -= (e.clientX - last.x) / k() / this.view.zoom;
      this.view.cz -= (e.clientY - last.y) / k() / this.view.zoom;
      last.x = e.clientX; last.y = e.clientY;
      this.follow = false;
    });
    const up = (e) => {
      down.delete(e.pointerId);
      try { c.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  /** One image pixel per grid cell, so a wall can be measured in an editor. */
  exportPng(dark) {
    lidarRenderGrid(this.grid, this.gridImage.data, dark ? 'dark' : 'light');
    this.gridCtx.putImageData(this.gridImage, 0, 0);
    this.drawn.revision = -1;
    return new Promise((resolve) => this.gridCanvas.toBlob(resolve, 'image/png'));
  }
}

// ── the words, the same on every page ──────────────────────────────────
//
// `st` is lidarMount's stats, `srv` the server's view of the room (status
// frame `lidar`, or a row of GET /api/lidar), `live` whether scans are arriving.

/** What the scanner is doing, in one line. */
function lidarStateText(st, srv, live) {
  if (st.link !== 'open') return 'röle bağlantısı yok';
  if (live && st.tracking === 'lost') return 'ARKit takibi kayboldu — poz tahmini';
  if (live && st.still) return `sabit · telefon hareketsiz · oda ${st.room}`;
  if (live) return `canlı · oda ${st.room}`;
  if (srv && srv.senders) return 'tarayıcı bağlı ama veri yok';
  if (st.scans) {
    return 'durdu' + (srv && srv.age_s != null ? ` — son veri ${Math.round(srv.age_s)} sn önce` : '');
  }
  return `tarayıcı yok · oda ${st.room}`;
}

/** The status dot: green live, amber when something is off, red with no relay. */
function lidarDotClass(st, srv, live) {
  if (live) return st.tracking === 'lost' ? 'go' : 'ok';
  if (srv && srv.senders) return 'go';
  return st.link === 'open' ? '' : 'bad';
}

/**
 * Scans a second — except while the phone is still, when the ARKit app sends a
 * heartbeat every 700 ms on purpose and "1.4" would read as a failing link.
 */
function lidarRateText(st, live) {
  if (!live) return '0';
  return st.still ? 'sabit' : st.rate.toFixed(1);
}

/** How much of the session had a trusted pose — or that it has none right now. */
function lidarPoseText(st, live) {
  if (!st.scans) return '–';
  if (live && st.tracking === 'lost') return 'takip yok';
  return `${Math.round(st.locked / st.scans * 100)} % eşleşti`;
}

/**
 * How to get a scanner streaming here. With the mDNS announcement on, the app
 * lists this server by itself and there is nothing to type; the address is
 * only the fallback for a network that drops multicast.
 *
 * `openParam` names the query parameter this page takes a room in, so the
 * "a scanner is in another room" note can link straight to it.
 */
function lidarHowHtml(st, srv, esc, openParam) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  const other = ((srv && srv.elsewhere) || [])[0];
  let h = '';
  if (other) {
    h += `Bir tarayıcı <code>${esc(other.id)}</code> odasına gönderiyor, bu sayfa `
      + `<code>${esc(st.room)}</code> odasını gösteriyor`
      + (openParam ? ` — <a href="?${openParam}=${encodeURIComponent(other.id)}" `
        + 'style="pointer-events:auto">o odayı aç</a>' : '') + '. ';
  }
  if (srv && srv.announced) {
    h += `iPhone'da webscan uygulamasını aç: bu sunucuyu kendisi bulur `
      + `(<code>${esc(srv.announced)}</code>). Oda <code>${esc(st.room)}</code>, sonra Start. `
      + `Listede yoksa elle: <code>${esc(url)}</code>.`;
  } else {
    h += `webscan uygulamasında relay URL <code>${esc(url)}</code>, `
      + `oda <code>${esc(st.room)}</code>, sonra Start.`;
  }
  return h;
}

/**
 * A viewer on the relay, drawing into `canvas`.
 *
 *   const L = lidarMount({ canvas: el, room: 'default', onChange: paint });
 *   L.stats      scans, locked, rate, bytes, latency, link, sender state…
 *   L.setRoom()  switch rooms: throws the map away and replays the new one
 *   L.clear()    forget the map on this page only
 *
 * The relay replays the whole session to a viewer that joins late — a scan is
 * ~560 bytes, so an hour of them is a few megabytes — which is why reloading
 * the page gives you the map back rather than an empty room.
 */
function lidarMount({ canvas, room = 'default', onChange = null }) {
  const grid = new LidarGrid();
  const radar = new LidarRadar(canvas, grid);
  const motion = new LidarMotion();
  const dark = () => !matchMedia('(prefers-color-scheme: light)').matches;

  const stats = {
    room: lidarRoom(room), link: 'connecting', scans: 0, locked: 0, lost: 0, rate: 0,
    tracking: null, still: false, gapMs: null,
    bytes: 0, latencyMs: null, lastAt: 0, senders: 0, viewers: 0,
    active: false, calibrated: false, note: null,
    x: null, z: null, yawDeg: null, score: null, heightM: null, area: 0,
  };
  let sensor = null;
  let ws = null, retry = null, closed = false;
  let scratch = new Float32Array(0);
  const stamps = [];

  const forget = () => {
    grid.clear(); motion.reset(); radar.clearTrail(); radar.invalidate();
    stats.scans = 0; stats.locked = 0; stats.lost = 0; stats.area = 0;
    stats.tracking = null; stats.gapMs = null; stats.still = false;
    stats.x = stats.z = stats.yawDeg = stats.score = stats.heightM = null;
    sensor = null;
  };

  function onScan(buf) {
    const bins = Math.max(0, (buf.byteLength - LIDAR_HEADER) >> 1);
    if (scratch.length < bins) scratch = new Float32Array(bins);
    const scan = lidarDecode(buf, scratch);
    if (!scan) return;                    // a 3D point frame in this room: not ours
    const h = scan.header;
    const now = performance.now();
    stamps.push(now);
    while (stamps.length && now - stamps[0] > 2000) stamps.shift();

    stats.scans++;
    stats.bytes += buf.byteLength;
    stats.gapMs = stats.lastAt ? now - stats.lastAt : null;
    stats.lastAt = now;
    stats.latencyMs = Math.max(0, Date.now() - h.tMs);
    const locked = (h.flags & LIDAR_FLAG_MATCHED) !== 0;
    const lost = (h.flags & LIDAR_FLAG_LOST) !== 0;
    if (locked) stats.locked++;
    if (lost) stats.lost++;
    stats.tracking = lost ? 'lost' : locked ? 'ok' : 'unknown';
    // The frame says whether its scale is metric; the sender-state message only
    // says what the sender last announced, and a replayed session has none.
    stats.calibrated = (h.flags & LIDAR_FLAG_CALIBRATED) !== 0;

    if (motion.accept(h.x, h.z, h.yaw, h.tMs)) {
      grid.insertScan(h.x, h.z, h.yaw, scan.ranges, h.binCount, h.fovRad);
    }
    radar.pushTrail(h.x, h.z);

    // `scratch` is reused by the next frame, so the overlay keeps a copy.
    const ranges = sensor && sensor.ranges.length === h.binCount
      ? sensor.ranges : new Float32Array(h.binCount);
    ranges.set(scan.ranges.subarray(0, h.binCount));
    sensor = { x: h.x, z: h.z, yaw: h.yaw, fovRad: h.fovRad, ranges,
               binCount: h.binCount, locked, lost, stale: false };

    stats.x = h.x; stats.z = h.z;
    stats.yawDeg = ((h.yaw * 180 / Math.PI) % 360 + 360) % 360;
    stats.score = h.matchScore;
    stats.heightM = h.cameraHeightM > 0 ? h.cameraHeightM : null;
  }

  function connect() {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    stats.link = 'connecting';
    ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(stats.room)}`
                       + '&role=viewer&label=rover-page');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { stats.link = 'open'; };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { onScan(ev.data); return; }
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'welcome' || m.type === 'peers') {
        stats.senders = m.counts.senders; stats.viewers = m.counts.viewers;
      } else if (m.type === 'sender-state') {
        stats.active = !!m.active; stats.note = m.note || null;
        // Only until a scan says otherwise — see onScan.
        if (!stats.scans) stats.calibrated = !!m.calibrated;
      } else if (m.type === 'reset') {
        forget();
      }
    };
    const down = () => {
      if (ws === null) return;
      ws = null;
      stats.link = 'closed';
      if (!closed && retry === null) retry = setTimeout(() => { retry = null; connect(); }, 1500);
    };
    ws.onclose = down;
    ws.onerror = () => { try { ws && ws.close(); } catch { /* closing */ } };
  }

  function frame() {
    if (closed) return;
    const now = performance.now();
    if (sensor) sensor.stale = now - stats.lastAt > LIDAR_STALE_MS;
    // The ARKit app does not transmit while the phone is still — it sends one
    // heartbeat every 700 ms instead of ten scans a second. So a slow, steady
    // stream is a phone standing still, not a failing link, and it is shown
    // that way. A gap this long between two scans only happens in that mode.
    stats.still = stats.gapMs != null && stats.gapMs >= LIDAR_STILL_GAP_MS
      && now - stats.lastAt < LIDAR_STALE_MS;
    stats.rate = stamps.length > 1 && now - stamps[stamps.length - 1] < LIDAR_STALE_MS
      ? (stamps.length - 1) / ((stamps[stamps.length - 1] - stamps[0]) / 1000 || 1) : 0;
    if (canvas.clientWidth > 0) radar.draw(sensor, dark());
    if (onChange) onChange(stats);
    requestAnimationFrame(frame);
  }

  // The explored area walks every cell, so once a second rather than per frame.
  const areaTimer = setInterval(() => { stats.area = grid.exploredM2(); }, 1000);

  connect();
  requestAnimationFrame(frame);

  return {
    grid, radar, stats,
    get live() { return stats.lastAt > 0 && performance.now() - stats.lastAt < LIDAR_STALE_MS; },
    clear: forget,
    setRoom(next) {
      const r = lidarRoom(next);
      if (r === stats.room) return;
      stats.room = r;
      forget();
      stats.senders = stats.viewers = 0; stats.active = false;
      if (ws) { const old = ws; ws = null; old.close(); }
      if (retry !== null) { clearTimeout(retry); retry = null; }
      connect();
    },
    zoom(f) { radar.zoomAt(radar.w / 2, radar.h / 2, f); },
    exportPng() { return radar.exportPng(dark()); },
    close() {
      closed = true;
      clearInterval(areaTimer);
      if (retry !== null) clearTimeout(retry);
      if (ws) { const old = ws; ws = null; old.close(); }
    },
  };
}
