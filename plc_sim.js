/**
 * A stand-in for the competition's PLC simulator.
 *
 * The real one is on the field's own wifi and only on the day. This speaks the
 * same UDP protocol from the other side, so the whole mission — task, start,
 * the door, the lap back — can be driven on a desk with no field at all:
 *
 *     node server.js --fake --plc-sim           in the server, on 127.0.0.1
 *     node plc_sim.js --task 2,3                on its own, e.g. on the laptop
 *                                               at 192.168.100.100 for a rehearsal
 *
 * It does what the specification says the PLC does, and one thing more:
 *
 *   · checks every PAKET_TX is 7 bytes with a durum between 1 and 8,
 *   · answers each with PAKET_RX,
 *   · records a timeout when a second passes with no packet — plus a small
 *     grace, because a desk laptop's scheduler is not the thing under test,
 *   · and, in auto mode, plays the factory: hands out the task, says start,
 *     keeps the door shut for `gateWaitMs` and then says continue. After a
 *     finished lap (durum 6 then 1) it moves on to the next task in the list.
 *
 * It is a simulator for rehearsal. What the organisers' PLC does at the door,
 * and when, is theirs to decide — so `manual` mode answers with whatever a
 * person sets on /plc instead of playing a script.
 */

import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';

import { loadShared } from './shared.js';

const { PLC_PORT, plcDecodeTx, plcEncodeRx, plcHex } =
  loadShared('plc.js', ['PLC_PORT', 'plcDecodeTx', 'plcEncodeRx', 'plcHex']);

export const PLC_SIM_DEFAULTS = {
  host: '0.0.0.0',
  port: PLC_PORT,
  timeoutMs: 1000,
  graceMs: 300,
  gateWaitMs: 3000,
  tasks: [{ a: 1, b: 1 }, { a: 2, b: 3 }, { a: 3, b: 2 }],
  auto: true,
};

export class PlcSim {
  constructor(opts = {}) {
    this.cfg = { ...PLC_SIM_DEFAULTS, ...opts };
    this.sock = null;
    this.timer = null;
    this.bound = false;
    this.error = null;

    this.auto = this.cfg.auto;
    this.taskIdx = 0;
    this.control = 1;          // manual mode's answer
    this.manualTask = { ...this.cfg.tasks[0] };

    this.robot = null;         // rinfo of the last sender
    this.last = null;          // last decoded PAKET_TX
    this.lastAt = 0;
    this.count = 0;
    this.bad = 0;
    this.timeouts = 0;
    this.lost = false;
    this.maxGapMs = 0;
    this.gateSince = null;
    this.prevCode = null;
    this.reply = null;
    this.log = [];
    this.seq = 0;
  }

  get task() { return this.auto ? this.cfg.tasks[this.taskIdx % this.cfg.tasks.length] : this.manualTask; }

  start() {
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('error', (err) => { this.error = String(err.message || err); });
    sock.on('message', (buf, rinfo) => this._message(buf, rinfo));
    sock.bind(this.cfg.port, this.cfg.host, () => { this.bound = true; });
    // The PLC's watchdog: on its own clock, so silence is noticed even when
    // no packet arrives to notice it with.
    this.timer = setInterval(() => this._watch(), 100);
    this.timer.unref?.();
    return this;
  }

  _note(text) {
    this.log.push({ at: Date.now(), seq: ++this.seq, text });
    while (this.log.length > 30) this.log.shift();
  }

  _watch() {
    if (!this.lastAt || this.lost) return;
    if (Date.now() - this.lastAt > this.cfg.timeoutMs + this.cfg.graceMs) {
      this.lost = true;
      this.timeouts++;
      this._note('zaman aşımı — robottan 1 s içinde paket gelmedi, bağlantı koptu');
    }
  }

  _message(buf, rinfo) {
    const now = Date.now();
    const bytes = new Uint8Array(buf);
    const tx = plcDecodeTx(bytes);
    if (!tx || !tx.ok) {
      this.bad++;
      this._note(`hatalı paket (${bytes.length} bayt: ${plcHex(bytes)})`);
      return;
    }
    if (this.lastAt) this.maxGapMs = Math.max(this.maxGapMs, now - this.lastAt);
    if (this.lost) { this.lost = false; this._note('robot yeniden bağlandı'); }
    this.robot = rinfo;
    this.last = { ...tx, hex: plcHex(bytes), at: now };
    this.lastAt = now;
    this.count++;

    if (tx.code !== this.prevCode) this._note(`robot durumu ${this.prevCode ?? '–'} → ${tx.code}`);
    // A lap is over when the robot reports ready straight after returning.
    if (this.auto && this.prevCode === 6 && tx.code === 1) this.taskIdx++;
    this.prevCode = tx.code;

    const out = this._answer(tx, now);
    this.reply = { ...out, at: now };
    this.sock.send(plcEncodeRx(out), rinfo.port, rinfo.address);
  }

  _answer(tx, now) {
    const t = this.task;
    if (!this.auto) return { a: t.a, b: t.b, control: this.control };
    if (tx.code === 5) {
      if (this.gateSince == null) { this.gateSince = now; this._note('kapı açılıyor…'); }
      const open = now - this.gateSince >= this.cfg.gateWaitMs;
      return { a: t.a, b: t.b, control: open ? 2 : 1 };
    }
    this.gateSince = null;
    // Task and "start" at the start line; bekle everywhere else, as a PLC
    // with nothing to say would.
    return { a: t.a, b: t.b, control: tx.code === 1 || tx.code === 2 ? 2 : 1 };
  }

  /** From /plc in manual mode. */
  set({ auto, a, b, control } = {}) {
    if (typeof auto === 'boolean') this.auto = auto;
    const n = (v) => Math.max(0, Math.min(3, Math.trunc(Number(v))));
    if (a != null) this.manualTask.a = n(a);
    if (b != null) this.manualTask.b = n(b);
    if (control === 1 || control === 2) this.control = control;
  }

  status() {
    return {
      bound: this.bound,
      error: this.error,
      port: this.cfg.port,
      auto: this.auto,
      task: this.task,
      control: this.auto ? null : this.control,
      robot: this.robot ? `${this.robot.address}:${this.robot.port}` : null,
      last: this.last,
      reply: this.reply,
      count: this.count,
      bad: this.bad,
      timeouts: this.timeouts,
      lost: this.lost,
      max_gap_ms: this.maxGapMs,
      gate_wait_ms: this.cfg.gateWaitMs,
      log: this.log.slice(-12),
    };
  }

  close() {
    clearInterval(this.timer);
    try { this.sock && this.sock.close(); } catch { /* already closed */ }
  }
}

// ── on its own ───────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--gate-wait') opts.gateWaitMs = Number(argv[++i]);
    else if (a === '--manual') opts.auto = false;
    else if (a === '--task') {
      opts.tasks = argv[++i].split(';').map((t) => {
        const [x, y] = t.split(',').map(Number);
        return { a: x, b: y };
      });
    } else if (a === '--help' || a === '-h') {
      console.log(`usage: node plc_sim.js [--port 1515] [--host 0.0.0.0]
                        [--task 2,3;1,1] [--gate-wait 3000] [--manual]`);
      process.exit(0);
    }
  }
  const sim = new PlcSim(opts).start();
  console.log(`PLC simulator on udp ${sim.cfg.host}:${sim.cfg.port} — tasks `
    + sim.cfg.tasks.map((t) => `A${t.a}→B${t.b}`).join(', '));
  let seen = 0;
  setInterval(() => {
    for (const e of sim.log) if (e.seq > seen) console.log(`plc-sim: ${e.text}`);
    seen = sim.seq;
  }, 250);
}
