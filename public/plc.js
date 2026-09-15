/**
 * The factory automation system — the competition's PLC simulator — and the
 * mission it hands out.
 *
 * Pure, like field.js: no sockets, no clock of its own. The server owns the
 * UDP link (plc_link.js) and feeds this module what came in; /plc draws what it
 * says; test/test_plc.mjs plays whole runs through it with no network at all.
 *
 * ── The protocol (EK TEKNİK ŞARTNAME, bölüm 2) ─────────────────────
 *
 * UDP on a closed wifi. The PLC is 192.168.100.100:1515, the robot is set by
 * hand to 192.168.100.10 and the team's laptop to 192.168.100.20, gateway
 * 192.168.100.1 for both. Access is by MAC filter, so the Pi's wifi MAC is the
 * one to hand in.
 *
 * Once a second the robot sends PAKET_TX, 7 bytes:
 *
 *     byte 0   durum     1 hazır · 2 görev alındı · 3 yüksüz · 4 yüklü
 *                        5 fabrika komutu bekleniyor · 6 dönüş · 7 hata · 8 acil stop
 *     byte 1   alım      1..3 = A1..A3
 *     byte 2   bırakma   1..3 = B1..B3
 *     byte 3-4 X         int16, little endian (LSB first), integer(x * 100), metres
 *     byte 5-6 Y         int16, little endian, integer(y * 100)
 *
 * and the PLC answers each one with PAKET_RX, 3 bytes:
 *
 *     byte 0   alım      1..3
 *     byte 1   bırakma   1..3
 *     byte 2   kontrol   1 bekle · 2 göreve başla / devam et
 *
 * (The table calls the last one "Byte3"; the packet is 3 bytes long, so it is
 * byte 2.) The PLC times the packets: no packet for a second and it declares
 * the link broken. So the robot sends on a fixed clock and never skips a beat
 * because it is busy — which is why the link, not the mission, owns the timer.
 *
 * Two things the specification does not say, decided here and written down
 * so they can be changed in one place if the organisers say otherwise:
 *
 *   · A byte 1 / byte 2 of 0 in PAKET_TX means "no task". The table only lists
 *     1..3, and a robot waiting for its first task has none to report.
 *   · The origin of X / Y is the field's bottom-left corner (see field.js).
 *
 * ── The mission ─────────────────────────────────────────────────────
 *
 *     ready ──task──▶ accepted ──kontrol 2──▶ to_pick ──yük alındı──▶ to_drop
 *       ▲              (hold)                   (3)                     (4)
 *       │                                                                │ KAPI1
 *       │                                                                ▼
 *       │                                                             gate (5, hold)
 *       │                                                                │ kontrol 2
 *       │                                                                ▼
 *     home ◀── returning (6) ◀── KAPI2 → gate (5) ◀── returning ◀── yük bırakıldı
 *
 * The robot stops — holds — in exactly two places: after a task arrives and
 * until the PLC says start, and at the door until the PLC says continue. A
 * "bekle" that arrives while the robot is driving anywhere else is not a stop
 * order: the PLC answers every packet, and most answers are about a door the
 * robot is nowhere near.
 *
 * A kontrol 2 only counts as the answer to a question the robot actually asked:
 * the reply to a packet that said 2 (for "start") or 5 (for "the door"). A PLC
 * that was already saying 2 before the robot reached the door has not opened
 * it for the robot; it was still answering the previous question.
 */

const PLC_HOST = '192.168.100.100';
const PLC_PORT = 1515;
const PLC_ROBOT_IP = '192.168.100.10';
const PLC_LAPTOP_IP = '192.168.100.20';
const PLC_GATEWAY = '192.168.100.1';
const PLC_PERIOD_MS = 1000;
const PLC_TX_LEN = 7;
const PLC_RX_LEN = 3;

/** PAKET_TX byte 0, as the specification words it. */
const PLC_CODE_LABEL = {
  1: 'Göreve hazır bekleme durumu',
  2: 'Görev alındı, işleniyor',
  3: 'Görev alındı, yüksüz hareket',
  4: 'Görev alındı, yüklü hareket',
  5: 'Fabrika otomasyon sistemi komutu bekleniyor',
  6: 'Görev tamamlandı, başlangıç noktasına hareket',
  7: 'Hata durumu',
  8: 'Acil stop durumu',
};

/** PAKET_RX byte 2. */
const PLC_CONTROL_LABEL = { 1: 'Bekle', 2: 'Göreve başla / devam et' };

/** Mission phase → the durum byte it is reported as. */
const PLC_PHASE_CODE = {
  ready: 1, accepted: 2, to_pick: 3, to_drop: 4, gate: 5, returning: 6,
};

// ── the packets ──────────────────────────────────────────────────────

/**
 * A value in metres as the packet's int16 of centimetres, clamped to fit.
 *
 * integer() truncates, as the specification writes it — but in floating point
 * 0.29 * 100 is 28.999999999999996, and truncating that reports a robot a
 * centimetre short of where it is. So the product is cleaned to a micrometre
 * first and truncated after.
 */
function plcCm(v) {
  const n = Math.trunc(Number(((Number(v) || 0) * 100).toFixed(6)));
  return n > 32767 ? 32767 : n < -32768 ? -32768 : n;
}

/**
 * PAKET_TX.
 * @param {{code:number, a?:number, b?:number, x?:number, y?:number}} p  x, y in metres
 * @returns {Uint8Array} 7 bytes
 */
function plcEncodeTx(p) {
  const out = new Uint8Array(PLC_TX_LEN);
  const byte = (v) => Math.max(0, Math.min(255, Math.trunc(Number(v) || 0)));
  out[0] = byte(p.code);
  out[1] = byte(p.a);
  out[2] = byte(p.b);
  const x = plcCm(p.x) & 0xffff, y = plcCm(p.y) & 0xffff;
  out[3] = x & 0xff; out[4] = x >> 8;
  out[5] = y & 0xff; out[6] = y >> 8;
  return out;
}

/** PAKET_TX, read back — what the PLC side sees. Null if it is not 7 bytes. */
function plcDecodeTx(bytes) {
  if (!bytes || bytes.length !== PLC_TX_LEN) return null;
  const s16 = (lo, hi) => { const v = lo | (hi << 8); return v & 0x8000 ? v - 0x10000 : v; };
  const x = s16(bytes[3], bytes[4]), y = s16(bytes[5], bytes[6]);
  const code = bytes[0];
  return {
    code, a: bytes[1], b: bytes[2], xRaw: x, yRaw: y, x: x / 100, y: y / 100,
    ok: code >= 1 && code <= 8 && bytes[1] <= 3 && bytes[2] <= 3,
  };
}

/** PAKET_RX — what the simulator sends. */
function plcEncodeRx(p) {
  const byte = (v) => Math.max(0, Math.min(255, Math.trunc(Number(v) || 0)));
  return Uint8Array.from([byte(p.a), byte(p.b), byte(p.control)]);
}

/**
 * PAKET_RX, read. A packet of the wrong length or with a value outside the
 * table is reported and not acted on: a PLC saying "go to A7" is a fault
 * somewhere, and guessing which station it meant is not the robot's job.
 * A station byte of 0 is accepted as "no task yet".
 */
function plcDecodeRx(bytes) {
  if (!bytes || bytes.length !== PLC_RX_LEN) {
    return { ok: false, reason: `${bytes ? bytes.length : 0} bayt geldi, ${PLC_RX_LEN} bekleniyordu` };
  }
  const [a, b, control] = bytes;
  if (a > 3 || b > 3) return { ok: false, reason: `istasyon aralık dışında (A${a}, B${b})` };
  if (control !== 1 && control !== 2) return { ok: false, reason: `kontrol ${control} tanımsız` };
  return { ok: true, a: a || null, b: b || null, control };
}

/** Bytes as "01 02 03" — how a packet is shown and logged. */
function plcHex(bytes) {
  return Array.from(bytes || [], (v) => v.toString(16).padStart(2, '0')).join(' ');
}

// ── the mission ──────────────────────────────────────────────────────

/** A fresh mission: no task, waiting for one. */
function plcMission() {
  return {
    phase: 'ready',
    task: null,         // {a, b} while there is one
    resume: null,       // the phase to go back to once the door opens
    gateKey: null,      // which approach to the door has already been waited at
    homing: false,      // BASLA has been read on the way back
    done: null,         // the task just finished — see plcMissionRx
    estop: false,
    fault: null,
    since: 0,           // when the phase last changed
    pose: { x: 0, y: 0, known: false },   // the last position worth reporting
    events: [],         // [{at, text}] newest last
  };
}

/** The durum byte for where the mission is now. Faults outrank phases. */
function plcMissionCode(ms) {
  if (ms.estop) return 8;
  if (ms.fault) return 7;
  return PLC_PHASE_CODE[ms.phase] || 7;
}

/** Why the robot may not move right now, or null. */
function plcMissionHold(ms) {
  if (ms.estop) return 'acil stop';
  if (ms.phase === 'accepted') return 'PLC başlat komutu bekleniyor';
  if (ms.phase === 'gate') return 'kapı: PLC devam komutu bekleniyor';
  return null;
}

function plcLog(ms, now, text) {
  ms.events.push({ at: now, text });
  while (ms.events.length > 30) ms.events.shift();
}

function plcGo(ms, phase, now, text) {
  ms.phase = phase;
  ms.since = now;
  if (text) plcLog(ms, now, text);
}

/** The stops a task means, in order, for fieldMission(). */
function plcTaskStops(task) {
  return task ? [`A${task.a}`, `B${task.b}`, 'START'] : [];
}

/**
 * A PAKET_RX arrived.
 *
 * `rx` is plcDecodeRx()'s result plus `replyTo`: the durum byte of the last
 * packet the robot had sent when this one came in.
 *
 * @returns {{plan: string[]|null}} a new list of stops to plan, when a task
 *          was taken
 */
function plcMissionRx(ms, rx, now = 0) {
  const out = { plan: null };
  if (!rx || !rx.ok) return out;
  const hasTask = rx.a != null && rx.b != null;

  // A task that has just been finished is still what the PLC is saying, and
  // will be until it notices. Taking it again would drive the same lap twice.
  // It is released when the PLC says bekle, or names a different task.
  if (ms.done && (rx.control === 1 || !hasTask || rx.a !== ms.done.a || rx.b !== ms.done.b)) {
    ms.done = null;
  }

  if (ms.estop) return out;

  if (ms.phase === 'ready' && hasTask && !ms.done) {
    ms.task = { a: rx.a, b: rx.b };
    ms.gateKey = null;
    ms.homing = false;
    plcGo(ms, 'accepted', now, `görev alındı: A${rx.a} → B${rx.b}`);
    out.plan = plcTaskStops(ms.task);
    return out;
  }

  if (ms.phase === 'accepted') {
    // The PLC changed its mind before saying go: take the new task.
    if (hasTask && (rx.a !== ms.task.a || rx.b !== ms.task.b)) {
      ms.task = { a: rx.a, b: rx.b };
      plcLog(ms, now, `görev değişti: A${rx.a} → B${rx.b}`);
      out.plan = plcTaskStops(ms.task);
      return out;
    }
    if (rx.control === 2 && rx.replyTo === 2) {
      plcGo(ms, 'to_pick', now, `PLC başlat dedi — A${ms.task.a}'e yüksüz gidiliyor`);
    }
    return out;
  }

  if (ms.phase === 'gate' && rx.control === 2 && rx.replyTo === 5) {
    const back = ms.resume || 'to_drop';
    ms.resume = null;
    plcGo(ms, back, now, 'PLC devam dedi — kapıdan geçiliyor');
  }
  return out;
}

/**
 * A QR was read and the field worked out where that is (fieldSee's result).
 *
 * The station legs decide loading: a robot that reads ALIMn *leaving* An has
 * been to the station, and one leaving Bn has been to the drop. That covers a
 * lift nobody pressed "yük alındı" for; the buttons are still there for a
 * station the robot never drives back out past a code from.
 */
function plcMissionFix(ms, fix, now = 0) {
  if (!fix || !fix.ok || !ms.task) return;
  const A = `A${ms.task.a}`, B = `B${ms.task.b}`;

  if (ms.phase === 'to_pick' && fix.from === A) {
    plcGo(ms, 'to_drop', now, `${A}'den yüklü çıkıldı`);
  } else if (ms.phase === 'to_drop' && fix.from === B) {
    plcGo(ms, 'returning', now, `${B}'den yüksüz çıkıldı — başlangıca dönülüyor`);
  }

  // The door. The code before it, read heading for it, is the place to stop —
  // once per approach, so the same sign read again after the PLC has said
  // continue does not stop the robot a second time.
  if ((ms.phase === 'to_drop' || ms.phase === 'returning') && fix.to === 'GATE') {
    const key = `${ms.phase}:${fix.from}`;
    if (ms.gateKey !== key) {
      ms.gateKey = key;
      ms.resume = ms.phase;
      plcGo(ms, 'gate', now, `${fix.text || fix.qr} okundu — kapıda fabrika komutu bekleniyor`);
    }
  }

  if (ms.phase === 'returning' && fix.to === 'START' && !ms.homing) {
    ms.homing = true;
    plcLog(ms, now, 'BASLA okundu — başlangıç alanına giriliyor');
  }
}

/**
 * Something the operator or the robot reported, by name.
 * @returns {boolean} whether it changed anything
 */
function plcMissionEvent(ms, ev, now = 0) {
  switch (ev) {
    case 'picked':
      if (ms.phase !== 'to_pick') return false;
      plcGo(ms, 'to_drop', now, 'yük alındı');
      return true;
    case 'dropped':
      if (ms.phase !== 'to_drop') return false;
      plcGo(ms, 'returning', now, 'yük bırakıldı — başlangıca dönülüyor');
      return true;
    case 'home':
      if (ms.phase !== 'returning') return false;
      plcFinish(ms, now);
      return true;
    case 'estop':
      if (ms.estop) return false;
      ms.estop = true;
      plcLog(ms, now, 'ACİL STOP');
      return true;
    case 'release':
      if (!ms.estop) return false;
      ms.estop = false;
      plcLog(ms, now, 'acil stop kaldırıldı');
      return true;
    case 'reset': {
      // Abandon the task. Remember it as done, so a PLC still naming it does
      // not hand it straight back before anyone has looked at why.
      if (ms.task) ms.done = ms.task;
      ms.task = null; ms.resume = null; ms.gateKey = null; ms.homing = false;
      plcGo(ms, 'ready', now, 'görev sıfırlandı');
      return true;
    }
    default:
      return false;
  }
}

function plcFinish(ms, now) {
  ms.done = ms.task;
  const t = ms.task;
  ms.task = null; ms.resume = null; ms.gateKey = null; ms.homing = false;
  plcGo(ms, 'ready', now, t ? `görev tamamlandı: A${t.a} → B${t.b}` : 'başlangıçta');
}

/**
 * Housekeeping, on the server's clock.
 *
 * @param {{armed?: boolean, fault?: string|null, pose?: object}} robot
 *   armed: the pages' START is on. fault: why the robot cannot drive, or null.
 *   pose: fieldPose(), for the coordinates in the next packet.
 */
function plcMissionTick(ms, robot = {}, now = 0) {
  const fault = robot.fault || null;
  if (fault !== ms.fault) {
    plcLog(ms, now, fault ? `hata: ${fault}` : 'hata giderildi');
    ms.fault = fault;
  }
  const p = robot.pose;
  if (p && p.known) ms.pose = { x: p.x, y: p.y, known: true };
  // Back in the start area and stopped: the lap is over.
  if (ms.phase === 'returning' && ms.homing && robot.armed === false) plcFinish(ms, now);
}

/** What goes into the next PAKET_TX. */
function plcTxFields(ms) {
  return {
    code: plcMissionCode(ms),
    a: ms.task ? ms.task.a : 0,
    b: ms.task ? ms.task.b : 0,
    x: ms.pose.x,
    y: ms.pose.y,
  };
}

/** Everything a page shows about the mission, in one object. */
function plcMissionStatus(ms, now = 0) {
  const code = plcMissionCode(ms);
  return {
    phase: ms.phase,
    code,
    label: PLC_CODE_LABEL[code],
    hold: plcMissionHold(ms),
    task: ms.task,
    stops: plcTaskStops(ms.task),
    estop: ms.estop,
    fault: ms.fault,
    homing: ms.homing,
    done: ms.done,
    pose: ms.pose,
    phase_s: ms.since ? Math.round((now - ms.since) / 100) / 10 : null,
    events: ms.events.slice(-12),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PLC_HOST, PLC_PORT, PLC_ROBOT_IP, PLC_LAPTOP_IP, PLC_GATEWAY, PLC_PERIOD_MS,
    PLC_TX_LEN, PLC_RX_LEN, PLC_CODE_LABEL, PLC_CONTROL_LABEL, PLC_PHASE_CODE,
    plcCm, plcEncodeTx, plcDecodeTx, plcEncodeRx, plcDecodeRx, plcHex,
    plcMission, plcMissionCode, plcMissionHold, plcTaskStops, plcMissionRx,
    plcMissionFix, plcMissionEvent, plcMissionTick, plcTxFields, plcMissionStatus,
  };
}
