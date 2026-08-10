// Two ways to reach the ESP32. Both expose the same surface, so bench.js
// neither knows nor cares which one it is driving.
//
//   WsTransport      wifi — the board runs a WebSocket server (ws_dac.ino)
//   SerialTransport  USB  — framed binary over the cable (throttle_dac_2ch.ino)
//
// Contract:
//   await open()
//   send(v25, v26, en, dir, lift)  dir is [rev25, rev26], lift is -255..255;
//                                  called at 20 Hz
//   pin(gpio, value)    put 0-255 on a spare pin, for /pins. Wifi only.
//   readback()          what the board says it actually did, or null
//   get fresh()         have we heard from the board recently
//   get error()         human-readable problem, or null
//   await close()

import WebSocket from 'ws';

import * as esp from './esp.js';
import { FakeSerial } from './esp32sim.js';

const STALE_MS = 1000;

// ── wifi ─────────────────────────────────────────────────────────────
export class WsTransport {
  /** @param {string} url e.g. "ws://192.168.1.42:81/" */
  constructor(url) {
    this.url = url;
    this.label = url;
    this.ws = null;
    this._status = null;
    this._at = 0;
    this._error = 'connecting';
    this._closed = false;
    this._retry = null;
  }

  async open() {
    this._connect();
    // Give it a moment so the first UI paint is not "connecting", but do not
    // block startup on a board that is switched off.
    for (let i = 0; i < 30 && !this.fresh; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  _connect() {
    if (this._closed) return;
    this.ws = new WebSocket(this.url, { handshakeTimeout: 4000 });

    this.ws.on('open', () => {
      this._error = null;
      console.log(`esp32 connected: ${this.url}`);
    });
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'status') return;
      this._status = msg;
      this._at = Date.now();
    });
    this.ws.on('error', (err) => { this._error = String(err.message || err); });
    this.ws.on('close', () => {
      if (this._closed) return;
      this._error = this._error || 'esp32 disconnected';
      this._status = null;
      this._retry = setTimeout(() => this._connect(), 1000);
    });
  }

  send(v25, v26, en = false, dir = [false, false], lift = 0) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      // The lift rides in the drive packet on purpose. It is movement, so it
      // belongs to the 300 ms watchdog: stop sending and the actuator stops,
      // the same way the wheels do.
      this.ws.send(JSON.stringify({
        cmd: 'set', v25, v26, en, r25: dir[0] === true, r26: dir[1] === true,
        lift: Math.max(-255, Math.min(255, Math.round(Number(lift) || 0))),
      }));
    } catch (err) {
      this._error = String(err.message || err);
    }
  }

  /** Put a raw 0-255 on one of the spare pins. The board decides which exist. */
  pin(gpio, value) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        cmd: 'pin', gpio: Math.round(Number(gpio)), val: Math.round(Number(value) || 0),
      }));
    } catch (err) {
      this._error = String(err.message || err);
    }
  }

  readback() {
    const s = this._status;
    if (!s) return null;
    return {
      vL: s.v25, vR: s.v26,
      // The board's own DAC codes. Volts are derived and rounded twice on the
      // way here; the code is the number the pin was actually handed, which is
      // the only way to prove a gear landed where it was set.
      dacL: s.dac25, dacR: s.dac26,
      son: s.son || null,
      pins: s.pins || null,
      en: s.en === true, en_pin: s.en_pin,
      rev: Array.isArray(s.rev) ? [s.rev[0] === true, s.rev[1] === true] : null,
      rev_pin: s.rev_pin, rev_wait: s.rev_wait === true, dir: s.dir,
      // The lift, as the board reports it: what the bridge is doing, what was
      // asked for, whether the run limit has cut it, and which pins it is on.
      lift: Number.isFinite(s.lift) ? s.lift : null,
      lift_set: Number.isFinite(s.lift_set) ? s.lift_set : null,
      lift_cut: s.lift_cut === true,
      lift_pin: s.lift_pin || null,
      pkt: s.pkt, bad: s.bad,
      rssi: s.rssi, uptime: s.uptime, ap: s.ap, sim: s.sim === true,
      board_vmax: s.vmax,
    };
  }

  get fresh() { return Date.now() - this._at < STALE_MS; }
  get error() { return this.fresh ? null : this._error; }

  async close() {
    this._closed = true;
    if (this._retry) clearTimeout(this._retry);
    if (this.ws) {
      try { this.ws.send(JSON.stringify({ cmd: 'stop' })); } catch { /* going away */ }
      await new Promise((r) => setTimeout(r, 40));
      this.ws.close();
    }
  }
}

// ── USB ──────────────────────────────────────────────────────────────
export class SerialTransport {
  /** @param {string} path  @param {boolean} fake */
  constructor(path, fake = false) {
    this.path = path;
    this.fake = fake;
    this.label = fake ? 'FAKE serial' : path;
    this.port = null;
    this._report = null;
    this._at = 0;
    this._error = null;
    this._buf = '';
  }

  async open() {
    if (this.fake) {
      this.port = new FakeSerial((line) => this._onLine(line));
      return;
    }
    const { SerialPort } = await import('serialport');
    this.port = new SerialPort({ path: this.path, baudRate: esp.BAUD, autoOpen: false });
    await new Promise((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
    // Opening asserts DTR/RTS, which reboots the board via the CP210x.
    await new Promise((res) => this.port.set({ dtr: false, rts: false }, () => res()));
    this.port.on('data', (chunk) => this._onData(chunk));
    this.port.on('error', (err) => { this._error = String(err.message || err); });
    this.port.on('close', () => { this._error = 'port closed'; });
    console.log(`serial: ${this.path} @ ${esp.BAUD} — waiting out the reset`);
    await new Promise((r) => setTimeout(r, esp.BOOT_WAIT_MS));
  }

  // The USB firmware has neither an enable line, direction relays nor the
  // lift's L298N, so `en`, `dir` and `lift` are accepted and ignored here.
  // Use the wifi board (ws_dac.ino) for any of them.
  /** The USB board has no sonar and no spare-pin support. */
  pin() { /* not available over the serial firmware */ }

  send(v25, v26, _en = false, _dir = [false, false], _lift = 0) {
    try {
      const { frame } = esp.pack2(v25, v26);
      this.port.write(frame, (err) => {
        this._error = err ? String(err.message || err) : null;
      });
    } catch (err) {
      this._error = String(err.message || err);   // unplugged mid-run, etc.
    }
  }

  readback() { return this._report; }
  get fresh() { return Date.now() - this._at < 2000; }
  get error() { return this._error; }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (line) this._onLine(line);
    }
    if (this._buf.length > 4096) this._buf = '';     // never grow unbounded
  }

  _onLine(line) {
    const rep = esp.parseReport(line);
    if (!rep) return;
    this._report = rep;
    this._at = Date.now();
  }

  async close() {
    if (this.port && this.port.isOpen !== false) {
      await new Promise((res) => this.port.close(() => res()));
    }
  }
}
