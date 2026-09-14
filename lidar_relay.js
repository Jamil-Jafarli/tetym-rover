/**
 * The LiDAR relay — webscan's scan relay, living inside the rover's server.
 *
 * A scanner (the webscan iPhone ARKit app, or the browser depth-model sender)
 * connects to `/ws?room=<name>&role=sender` and streams SCN1 frames; anything
 * that wants the map connects to the same path as `role=viewer` and receives
 * them, the whole session first and then live. That is the webscan relay's
 * contract to the byte, so the phone app needs no change at all. It finds this
 * server by itself over mDNS (lidar_discovery.js), or takes `ws://<pi>:8090`
 * typed in where multicast is blocked.
 *
 * Why here and not a second server on the Pi: the map is a fact about the
 * robot, like the camera and the sonar, so it belongs on the one port every
 * page already talks to. /dashboard draws it next to everything else, and the
 * status frame says whether a scanner is actually streaming — a map that stopped
 * updating five minutes ago looks exactly like a map of a room nobody is in.
 *
 * The relay never decodes a scan. It checks the header far enough to reject
 * garbage and to count, then passes the bytes through untouched.
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { loadShared } from './shared.js';

const { lidarInspect, lidarBuffer, lidarRoom } =
  loadShared('lidar.js', ['lidarInspect', 'lidarBuffer', 'lidarRoom']);

export const RELAY_DEFAULTS = {
  /** Frames kept per room and replayed to a late viewer: ~1 MB of scans. */
  historyFrames: 2000,
  /** A room nobody is in is forgotten after this long. */
  roomTtlMs: 10 * 60_000,
  maxFrameBytes: 1_500_000,
  /** A viewer this far behind has frames dropped rather than queued. */
  viewerBackpressureBytes: 4 * 1024 * 1024,
  /** A sender faster than this has the excess dropped — a runaway client. */
  maxSenderFps: 30,
  /** A room with no frame for this long is not "streaming", whatever it says. */
  staleMs: 2500,
};

class Room {
  constructor(id, cfg) {
    this.id = id;
    this.cfg = cfg;
    this.clients = new Map();
    this.history = [];
    this.head = 0;
    this.emptySince = Date.now();
    this.senderState = { active: false, mode: 'map2d', calibrated: false };
    this.stats = { frames: 0, samples: 0, bytes: 0, lastAt: 0, kind: 'scan', flags: null, lost: 0 };
    this.window = [];
  }

  counts() {
    let senders = 0, viewers = 0;
    for (const c of this.clients.values()) (c.role === 'sender' ? senders++ : viewers++);
    return { senders, viewers };
  }

  add(c) { this.clients.set(c.id, c); this.emptySince = null; }

  remove(id) {
    this.clients.delete(id);
    if (this.clients.size === 0) this.emptySince = Date.now();
  }

  /** Frames in the order they arrived. */
  snapshot() {
    if (this.history.length < this.cfg.historyFrames) return this.history.slice();
    return [...this.history.slice(this.head), ...this.history.slice(0, this.head)];
  }

  clear() {
    this.history = [];
    this.head = 0;
    this.window = [];
    this.stats = { frames: 0, samples: 0, bytes: 0, lastAt: 0, kind: this.stats.kind, flags: null, lost: 0 };
  }

  fps(now = Date.now()) {
    while (this.window.length && now - this.window[0] > 2000) this.window.shift();
    return this.window.length / 2;
  }

  ingest(from, ab) {
    if (ab.byteLength > this.cfg.maxFrameBytes) return 'frame too large';
    const info = lidarInspect(ab);
    if (!info) return 'malformed frame';

    const now = Date.now();
    this.stats.frames++;
    this.stats.samples += info.samples;
    this.stats.bytes += ab.byteLength;
    this.stats.lastAt = now;
    this.stats.kind = info.kind;
    if (info.kind === 'scan') {
      // One byte of the header, so the rover can say when the phone has lost
      // track of itself without decoding anything.
      this.stats.flags = info.flags;
      if (info.flags & 8) this.stats.lost++;
    }
    this.window.push(now);
    from.frames++;
    from.bytes += ab.byteLength;

    if (this.history.length < this.cfg.historyFrames) this.history.push(ab);
    else {
      this.history[this.head] = ab;
      this.head = (this.head + 1) % this.history.length;
    }

    const payload = Buffer.from(ab);
    for (const c of this.clients.values()) {
      if (c.role !== 'viewer' || !c.socket || c.socket.readyState !== c.socket.OPEN) continue;
      // The map is cumulative, so a dropped frame is a patch that fills in a
      // moment later — while a queue behind a slow phone is memory on a Pi that
      // also has a 20 Hz deadline to hit.
      if (c.socket.bufferedAmount > this.cfg.viewerBackpressureBytes) continue;
      c.socket.send(payload, { binary: true });
    }
    return null;
  }

  broadcast(obj, exceptId = null) {
    const json = JSON.stringify(obj);
    for (const c of this.clients.values()) {
      if (c.id === exceptId || !c.socket || c.socket.readyState !== c.socket.OPEN) continue;
      c.socket.send(json);
    }
  }
}

export class LidarRelay {
  /**
   * @param {object} opts
   * @param {string} [opts.room]  the room the rover's own pages show by default
   */
  constructor({ room = 'default', ...cfg } = {}) {
    this.cfg = { ...RELAY_DEFAULTS, ...cfg };
    this.room = lidarRoom(room);
    this.rooms = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.cfg.maxFrameBytes + 1024 });
    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  get(id) {
    let r = this.rooms.get(id);
    if (!r) { r = new Room(id, this.cfg); this.rooms.set(id, r); }
    return r;
  }

  sweep() {
    const now = Date.now();
    for (const [id, r] of this.rooms) {
      if (r.clients.size === 0 && r.emptySince !== null && now - r.emptySince > this.cfg.roomTtlMs) {
        this.rooms.delete(id);
      }
    }
  }

  /** Hand an HTTP upgrade for /ws to the relay. */
  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  onConnection(socket, req) {
    const url = new URL(req.url || '/ws', 'http://localhost');
    const room = this.get(lidarRoom(url.searchParams.get('room')));
    const role = url.searchParams.get('role') === 'sender' ? 'sender' : 'viewer';
    const client = {
      id: randomUUID(), role, socket,
      label: String(url.searchParams.get('label') || role).slice(0, 40),
      peer: req.socket.remoteAddress, joinedAt: Date.now(), frames: 0, bytes: 0,
    };
    room.add(client);
    if (role === 'sender') console.log(`lidar: sender "${client.label}" joined room ${room.id} from ${client.peer}`);

    const send = (obj) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj)); };
    const history = role === 'viewer' ? room.snapshot() : [];
    send({ type: 'welcome', role, room: room.id, counts: room.counts(),
           serverTime: Date.now(), historyFrames: history.length });

    if (role === 'viewer') {
      // The session so far, in chunks, so a thousand scans do not land in the
      // socket buffer in one tick.
      let i = 0;
      const pump = () => {
        if (socket.readyState !== socket.OPEN) return;
        for (let budget = 40; i < history.length && budget > 0; budget--) {
          socket.send(Buffer.from(history[i++]), { binary: true });
        }
        if (i < history.length) setTimeout(pump, 16);
      };
      pump();
      send({ type: 'sender-state', ...room.senderState });
    }
    room.broadcast({ type: 'peers', counts: room.counts() });

    const minGap = 1000 / this.cfg.maxSenderFps;
    let lastFrame = 0;
    let alive = true;
    socket.on('pong', () => { alive = true; });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        if (role !== 'sender') return;
        const now = Date.now();
        if (now - lastFrame < minGap) return;       // the sender self-paces; drop silently
        lastFrame = now;
        const buf = Array.isArray(data) ? Buffer.concat(data) : data;
        const why = room.ingest(client, lidarBuffer(buf));
        if (why) send({ type: 'error', message: why });
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'ping':
          send({ type: 'pong', t: msg.t, serverTime: Date.now() });
          break;
        case 'sender-state':
          if (role !== 'sender') return;
          room.senderState = {
            active: !!msg.active,
            mode: msg.mode === '6dof' || msg.mode === '3dof' ? msg.mode : 'map2d',
            calibrated: !!msg.calibrated,
            note: typeof msg.note === 'string' ? msg.note.slice(0, 120) : undefined,
          };
          room.broadcast({ type: 'sender-state', ...room.senderState }, client.id);
          break;
        case 'reset':
          if (role !== 'sender') return;
          room.clear();
          room.broadcast({ type: 'reset' }, client.id);
          break;
        case 'hello':
          client.label = String(msg.label || client.label).slice(0, 40);
          break;
      }
    });

    const hb = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      try { socket.ping(); } catch { /* closing */ }
    }, 15_000);

    let gone = false;
    const closeUp = () => {
      if (gone) return;
      gone = true;
      clearInterval(hb);
      room.remove(client.id);
      if (role === 'sender') {
        console.log(`lidar: sender "${client.label}" left room ${room.id} (${client.frames} frames)`);
        room.senderState = { ...room.senderState, active: false };
        room.broadcast({ type: 'sender-state', ...room.senderState });
      }
      room.broadcast({ type: 'peers', counts: room.counts() });
    };
    socket.on('close', closeUp);
    socket.on('error', closeUp);
  }

  /**
   * A sender inside this process — the simulator. It is a client like any
   * other as far as the room is concerned, so viewers cannot tell it from a
   * phone except by the label, which says SIMULATED.
   */
  localSender(roomId = this.room, label = 'local') {
    const room = this.get(lidarRoom(roomId));
    const client = { id: randomUUID(), role: 'sender', socket: null, label,
                     peer: 'local', joinedAt: Date.now(), frames: 0, bytes: 0 };
    room.add(client);
    room.broadcast({ type: 'peers', counts: room.counts() });
    return {
      send: (ab) => room.ingest(client, ab),
      state: (s) => {
        room.senderState = { mode: 'map2d', ...s };
        room.broadcast({ type: 'sender-state', ...room.senderState });
      },
      close: () => {
        room.remove(client.id);
        room.senderState = { ...room.senderState, active: false };
        room.broadcast({ type: 'sender-state', ...room.senderState });
        room.broadcast({ type: 'peers', counts: room.counts() });
      },
    };
  }

  /** Forget a room's map, and tell every viewer to forget theirs. */
  reset(roomId = this.room) {
    const room = this.rooms.get(lidarRoom(roomId));
    if (!room) return false;
    room.clear();
    room.broadcast({ type: 'reset' });
    return true;
  }

  roomInfo(r, now = Date.now()) {
    const counts = r.counts();
    const age = r.stats.lastAt ? now - r.stats.lastAt : null;
    const sender = [...r.clients.values()].find((c) => c.role === 'sender');
    return {
      id: r.id, ...counts,
      // Streaming means frames arriving, not a sender that says it is active.
      live: age !== null && age < this.cfg.staleMs,
      active: r.senderState.active, calibrated: r.senderState.calibrated,
      note: r.senderState.note || null,
      label: sender ? sender.label : null,
      fps: r.fps(now), frames: r.stats.frames, bytes: r.stats.bytes,
      // From the newest scan: 'ok' while the pose is trusted, 'lost' while ARKit
      // (or the browser matcher) says it is guessing, null before any scan.
      tracking: r.stats.flags == null ? null : (r.stats.flags & 8) ? 'lost'
        : (r.stats.flags & 4) ? 'ok' : 'unknown',
      lost: r.stats.lost,
      kind: r.stats.kind, history: r.history.length,
      age_s: age === null ? null : Math.round(age / 100) / 10,
    };
  }

  /** For the rover's status frame: the default room, and who else is streaming. */
  status() {
    const now = Date.now();
    const main = this.roomInfo(this.get(this.room), now);
    const elsewhere = [...this.rooms.values()]
      .filter((r) => r.id !== this.room && r.counts().senders > 0)
      .map((r) => ({ id: r.id, senders: r.counts().senders, fps: r.fps(now) }));
    return { room: this.room, path: '/ws', announced: this.announced || null, ...main, elsewhere };
  }

  /** GET /api/lidar */
  info() {
    const now = Date.now();
    return { room: this.room, path: '/ws', announced: this.announced || null, limits: {
               historyFrames: this.cfg.historyFrames, maxFrameBytes: this.cfg.maxFrameBytes,
               maxSenderFps: this.cfg.maxSenderFps },
             rooms: [...this.rooms.values()].map((r) => this.roomInfo(r, now)) };
  }

  close() {
    clearInterval(this.sweeper);
    for (const c of this.wss.clients) c.close();
    this.wss.close();
  }
}

/**
 * One port, two sockets: `/ws` is the relay, every other path is the rover's
 * own status-and-command socket, exactly as it was before the relay existed.
 *
 * Two WebSocketServers attached to one HTTP server with `{ server }` do not
 * share: the first to see an upgrade it does not want answers 400 and the
 * second never gets a look. So both are `noServer` and this decides.
 */
export function routeUpgrades(server, { relay, wss }) {
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/ws') relay.handleUpgrade(req, socket, head);
    else wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}
