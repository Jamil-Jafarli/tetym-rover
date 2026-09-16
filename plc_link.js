/**
 * The UDP link to the factory automation system's PLC.
 *
 * One socket, one clock. PAKET_TX goes out every `periodMs` whether or not
 * anything changed, because the PLC's only way of knowing the robot is alive
 * is that the packets keep coming: a second without one and it records a
 * fault. So the timer is scheduled against the time the link started rather
 * than chained off the previous send — setTimeout(…, 1000) run a thousand
 * times drifts by the sum of every late wake-up, and the PLC measures exactly
 * that.
 *
 * What goes into the packet is not this file's business: it asks `getTx()` at
 * the moment of sending, so the byte on the wire is the robot's state then and
 * not whenever the state last changed. What comes back is decoded and handed
 * to `onRx`, tagged with the durum byte it was a reply to (see plc.js for why
 * that matters at the door).
 */

import dgram from 'node:dgram';

import { loadShared } from './shared.js';

const { PLC_HOST, PLC_PORT, PLC_PERIOD_MS, plcEncodeTx, plcDecodeRx, plcHex } =
  loadShared('plc.js', ['PLC_HOST', 'PLC_PORT', 'PLC_PERIOD_MS', 'plcEncodeTx',
                        'plcDecodeRx', 'plcHex']);

export const PLC_LINK_DEFAULTS = {
  host: PLC_HOST,
  port: PLC_PORT,
  bind: null,             // local address to send from, e.g. 192.168.100.10
  periodMs: PLC_PERIOD_MS,
  // No reply for this long and the link is shown as down. Longer than one
  // period, so a single lost datagram — UDP loses them — is not an alarm.
  staleMs: 3000,
  retryMs: 5000,          // after a socket error, try again this often
};

/** "host:port", "host", or ":port" → {host, port}. */
export function parsePlcAddr(s, dflt = PLC_LINK_DEFAULTS) {
  if (!s || s === true) return { host: dflt.host, port: dflt.port };
  const m = String(s).match(/^\[?([^\]]*?)\]?(?::(\d+))?$/);
  return { host: (m && m[1]) || dflt.host, port: m && m[2] ? Number(m[2]) : dflt.port };
}

export class PlcLink {
  /**
   * @param {object} opts   see PLC_LINK_DEFAULTS
   * @param {() => object} opts.getTx   the fields of the next PAKET_TX
   */
  constructor(opts = {}) {
    this.cfg = { ...PLC_LINK_DEFAULTS, ...opts };
    this.getTx = opts.getTx || (() => ({ code: 1 }));
    this._onRx = null;
    this.sock = null;
    this.timer = null;
    this.closed = false;

    this.bound = false;
    this.error = null;
    this.t0 = 0;
    this.k = 0;
    this.tx = null;           // {code, a, b, x, y, hex, at}
    this.txCount = 0;
    this.lastCode = null;     // durum byte of the last packet sent
    this.rx = null;           // decoded reply + {hex, at, replyTo, from}
    this.rxCount = 0;
    this.rxBad = 0;
    this.lateMs = 0;          // worst send delay since start
  }

  /** Called with each decoded PAKET_RX that is valid. */
  onRx(fn) { this._onRx = fn; return this; }

  start() {
    if (this.closed || this.sock) return this;
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('error', (err) => this._fail(err));
    sock.on('message', (buf, rinfo) => this._message(buf, rinfo));
    // The robot's own port. 0 lets the OS pick one — the PLC answers whatever
    // port a packet came from, so that is enough for it — but a fixed one
    // (--plc-local) is what a person testing by hand with nc can aim at.
    const opts = { port: Number(this.cfg.localPort) || 0 };
    if (this.cfg.bind) opts.address = this.cfg.bind;
    try {
      sock.bind(opts, () => {
        this.bound = true;
        this.error = null;
        this.t0 = Date.now();
        this.k = 0;
        this._send();
      });
    } catch (err) {
      this._fail(err);
    }
    return this;
  }

  _fail(err) {
    const why = err && err.code === 'EADDRNOTAVAIL'
      ? `${this.cfg.bind} bu makinede yok — robotun IP'si elle ${this.cfg.bind} yapılmalı`
      : String((err && err.message) || err);
    this.error = why;
    this.bound = false;
    clearTimeout(this.timer);
    try { this.sock && this.sock.close(); } catch { /* already closed */ }
    this.sock = null;
    if (!this.closed) {
      this.timer = setTimeout(() => this.start(), this.cfg.retryMs);
      this.timer.unref?.();
    }
  }

  _send() {
    if (this.closed || !this.sock) return;
    const now = Date.now();
    const due = this.t0 + this.k * this.cfg.periodMs;
    this.lateMs = Math.max(this.lateMs, now - due);

    let fields;
    try { fields = this.getTx() || { code: 7 }; } catch { fields = { code: 7 }; }
    const bytes = plcEncodeTx(fields);
    this.sock.send(bytes, this.cfg.port, this.cfg.host, (err) => {
      // ENETUNREACH and friends while the wifi is still coming up: say so,
      // keep the clock running. Closing the socket would lose the rhythm.
      this.error = err ? String(err.message || err) : null;
    });
    this.lastCode = bytes[0];
    this.tx = { ...fields, code: bytes[0], hex: plcHex(bytes), at: now };
    this.txCount++;

    // Next slot on the fixed grid. A wake-up later than a whole period skips
    // to the next slot in the future rather than sending a burst to catch up.
    this.k = Math.max(this.k + 1, Math.floor((Date.now() - this.t0) / this.cfg.periodMs) + 1);
    const wait = Math.max(0, this.t0 + this.k * this.cfg.periodMs - Date.now());
    this.timer = setTimeout(() => this._send(), wait);
  }

  _message(buf, rinfo) {
    // Only the PLC. Anything else on the port is not an instruction.
    if (this.cfg.host !== '0.0.0.0' && rinfo.address !== this.cfg.host
        && !(this.cfg.host === 'localhost' && rinfo.address === '127.0.0.1')) {
      return;
    }
    const bytes = new Uint8Array(buf);
    const dec = plcDecodeRx(bytes);
    const rx = { ...dec, hex: plcHex(bytes), at: Date.now(), replyTo: this.lastCode,
                 from: `${rinfo.address}:${rinfo.port}` };
    if (!dec.ok) { this.rxBad++; this.rxBadLast = rx; return; }
    this.rx = rx;
    this.rxCount++;
    if (this._onRx) this._onRx(rx);
  }

  get connected() {
    return !!(this.rx && Date.now() - this.rx.at < this.cfg.staleMs);
  }

  status() {
    const now = Date.now();
    return {
      enabled: true,
      host: this.cfg.host,
      port: this.cfg.port,
      bind: this.cfg.bind,
      period_ms: this.cfg.periodMs,
      bound: this.bound,
      // The port a PAKET_RX has to be sent to — random unless --plc-local fixed it.
      local_port: (() => { try { return this.sock && this.bound ? this.sock.address().port : null; } catch { return null; } })(),
      error: this.error,
      connected: this.connected,
      tx: this.tx,
      tx_count: this.txCount,
      late_ms: this.lateMs,
      rx: this.rx,
      rx_count: this.rxCount,
      rx_bad: this.rxBad,
      rx_bad_last: this.rxBadLast || null,
      rx_age_s: this.rx ? Math.round((now - this.rx.at) / 100) / 10 : null,
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    try { this.sock && this.sock.close(); } catch { /* already closed */ }
    this.sock = null;
  }
}
