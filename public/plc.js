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
 *
 * ── The door is timed ────────────────────────────────────────────────
 *
 * The robot reports durum 5 at the door and waits PLC_GATE_WAIT_MS — twenty
 * seconds — and then goes, whatever the PLC has said. A devam that arrives
 * inside that window is logged (the factory did open the door) but does not
 * shorten it: the wait is the robot's, not the PLC's. `gate_wait_s: 0` in the
 * settings gives the old behaviour back, where only a kontrol 2 in reply to a
 * durum-5 packet releases it.
 *
 * ── Which station the robot says it is at ────────────────────────────
 *
 * Bytes 1 and 2 are what the ROBOT has confirmed, not what it was told. They
 * stay 0 from the moment a task arrives until the camera reads that station's
 * code — ALIMx puts x in byte 1, BIRAKx puts x in byte 2 — so the packet says
 * "I am at A2" only once the robot has seen A2. `echo: true` reports the task
 * as soon as it is taken, for a factory that expects its own numbers back.
 */

const PLC_HOST = '192.168.100.100';
const PLC_PORT = 1515;
const PLC_ROBOT_IP = '192.168.100.10';
const PLC_LAPTOP_IP = '192.168.100.20';
const PLC_GATEWAY = '192.168.100.1';
const PLC_PERIOD_MS = 1000;
/** How long the robot stands at the door reporting durum 5. See the header. */
const PLC_GATE_WAIT_MS = 20000;
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

/** The phases a task is being driven in — where bekle / devam pause and resume. */
const PLC_DRIVING = new Set(['to_pick', 'to_drop', 'returning']);

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

/**
 * A fresh mission: no task, waiting for one.
 *
 * @param {{gateWaitMs?: number, echo?: boolean}} [o]
 *   gateWaitMs: the door's own wait, 0 to wait for the PLC alone.
 *   echo: report the task's stations in bytes 1 and 2 as soon as it is taken,
 *         rather than once the camera has confirmed each one.
 */
function plcMission(o = {}) {
  return {
    phase: 'ready',
    task: null,         // {a, b} while there is one
    alim: 0,            // byte 1: the pick station the ROBOT has confirmed
    birakma: 0,         // byte 2: the drop station, likewise
    loaded: false,      // the load is on the forks — durum is never 3 again
    resume: null,       // the phase to go back to once the door opens
    gateKey: null,      // which approach to the door has already been waited at
    gateUntil: 0,       // when the door's own wait runs out
    gateOpen: false,    // the PLC said devam while the robot stood there
    homing: false,      // BASLA has been read on the way back
    done: null,         // the task just finished — see plcMissionRx
    estop: false,
    wait: false,        // the PLC said bekle (kontrol 1) mid-task: hold until devam
    fault: null,
    since: 0,           // when the phase last changed
    pose: { x: 0, y: 0, known: false },   // the last position worth reporting
    events: [],         // [{at, text}] newest last
    gateWaitMs: Number.isFinite(Number(o.gateWaitMs)) && Number(o.gateWaitMs) >= 0
      ? Number(o.gateWaitMs) : PLC_GATE_WAIT_MS,
    echo: o.echo === true,
  };
}

/** The durum byte for where the mission is now. Faults outrank phases. */
function plcMissionCode(ms) {
  if (ms.estop) return 8;
  if (ms.fault) return 7;
  // Once the forks are under a pallet the robot is a loaded robot, and durum 3
  // — "görev alındı, yüksüz hareket" — is not something it may say again on
  // this task, whatever phase a retry or a re-plan puts it back into.
  if (ms.loaded && ms.phase === 'to_pick') return 4;
  return PLC_PHASE_CODE[ms.phase] || 7;
}

/** Why the robot may not move right now, or null. */
function plcMissionHold(ms) {
  if (ms.estop) return 'acil stop';
  if (ms.phase === 'accepted') return 'PLC başlat komutu bekleniyor';
  if (ms.phase === 'gate') {
    return ms.gateWaitMs > 0 ? 'kapı: bekleme süresi' : 'kapı: PLC devam komutu bekleniyor';
  }
  if (ms.wait) return 'PLC bekle dedi — devam komutu bekleniyor';
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

/**
 * Stand at the door: durum 5, and the clock the robot leaves on.
 *
 * `key` is which approach this is, so the same sign read twice — or a taught
 * leg ending where the camera already stopped the robot — does not start the
 * wait over.
 */
function plcGate(ms, key, now, text) {
  ms.gateKey = key;
  ms.resume = ms.phase;
  ms.gateUntil = ms.gateWaitMs > 0 ? now + ms.gateWaitMs : 0;
  ms.gateOpen = false;
  plcGo(ms, 'gate', now, text);
}

/** Leave the door and carry on with whatever the robot was doing. */
function plcLeaveGate(ms, now, text) {
  const back = ms.resume || 'to_drop';
  ms.resume = null;
  ms.gateUntil = 0;
  plcGo(ms, back, now, text);
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

  // Bekle / devam while a task is being driven. Kontrol 1 is taken at its word
  // — the robot stops where it is, a taught route pauses mid-way — and kontrol
  // 2 lets it carry on from there. (Before the start and at the door the
  // phases below already wait for kontrol 2; this is the same rule everywhere
  // else.)
  if (PLC_DRIVING.has(ms.phase)) {
    if (rx.control === 1 && !ms.wait) {
      ms.wait = true;
      plcLog(ms, now, 'PLC bekle dedi — robot duruyor');
    } else if (rx.control === 2 && ms.wait) {
      ms.wait = false;
      plcLog(ms, now, 'PLC devam dedi — kaldığı yerden devam');
    }
  }

  if (ms.phase === 'ready' && hasTask && !ms.done) {
    ms.task = { a: rx.a, b: rx.b };
    ms.alim = ms.echo ? rx.a : 0;
    ms.birakma = ms.echo ? rx.b : 0;
    ms.loaded = false;
    ms.gateKey = null;
    ms.gateUntil = 0;
    ms.homing = false;
    plcGo(ms, 'accepted', now, `görev alındı: A${rx.a} → B${rx.b}`);
    out.plan = plcTaskStops(ms.task);
    return out;
  }

  if (ms.phase === 'accepted') {
    // The PLC changed its mind before saying go: take the new task.
    if (hasTask && (rx.a !== ms.task.a || rx.b !== ms.task.b)) {
      ms.task = { a: rx.a, b: rx.b };
      if (ms.echo) { ms.alim = rx.a; ms.birakma = rx.b; }
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
    // The factory has opened the door. With a wait of its own the robot still
    // stands there until it runs out (see the header); without one, this is
    // what releases it.
    if (ms.gateWaitMs > 0) {
      if (!ms.gateOpen) {
        ms.gateOpen = true;
        plcLog(ms, now, 'PLC devam dedi — bekleme süresi dolunca geçilecek');
      }
    } else {
      plcLeaveGate(ms, now, 'PLC devam dedi — kapıdan geçiliyor');
    }
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

  // Bytes 1 and 2: the station the robot has SEEN. ALIMx is read on the leg
  // into A{a} — fix.to is the station it is heading for — and again on the way
  // out, when it is the one behind. Either read is the robot confirming it got
  // there, and it is the moment the packet starts naming the station.
  if (!ms.alim && (fix.to === A || fix.from === A)) {
    ms.alim = ms.task.a;
    plcLog(ms, now, `${fix.text || fix.qr} okundu — PAKET_TX byte1 = ${ms.alim}`);
  }
  if (!ms.birakma && (fix.to === B || fix.from === B)) {
    ms.birakma = ms.task.b;
    plcLog(ms, now, `${fix.text || fix.qr} okundu — PAKET_TX byte2 = ${ms.birakma}`);
  }

  if (ms.phase === 'to_pick' && fix.from === A) {
    ms.loaded = true;
    plcGo(ms, 'to_drop', now, `${A}'den yüklü çıkıldı`);
  } else if (ms.phase === 'to_drop' && fix.from === B) {
    ms.loaded = false;
    plcGo(ms, 'returning', now, `${B}'den yüksüz çıkıldı — başlangıca dönülüyor`);
  }

  // The door. The code before it, read heading for it, is the place to stop —
  // once per approach, so the same sign read again after the PLC has said
  // continue does not stop the robot a second time.
  // KAPI is the door's node on the rover's map (field.js); GATE was its name on
  // the older one, and is still accepted so a fix from either reads the same.
  if ((ms.phase === 'to_drop' || ms.phase === 'returning') && (fix.to === 'KAPI' || fix.to === 'GATE')) {
    const key = `${ms.phase}:${fix.from}`;
    if (ms.gateKey !== key) {
      plcGate(ms, key, now, `${fix.text || fix.qr} okundu — kapıda`
        + (ms.gateWaitMs > 0 ? ` ${Math.round(ms.gateWaitMs / 1000)} s bekleniyor`
                             : ' fabrika komutu bekleniyor'));
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
      ms.loaded = true;
      plcGo(ms, 'to_drop', now, 'yük alındı');
      return true;
    case 'dropped':
      if (ms.phase !== 'to_drop') return false;
      ms.loaded = false;
      plcGo(ms, 'returning', now, 'yük bırakıldı — başlangıca dönülüyor');
      return true;

    // At the station by a taught scenario, with no code read on the way in —
    // a QR the camera missed must not leave byte 1 or byte 2 at zero for the
    // whole lap. The station is the one the PLC named; the robot is standing
    // at it, which is the thing the byte is reporting.
    case 'at_pick':
      if (!ms.task || ms.alim) return false;
      ms.alim = ms.task.a;
      plcLog(ms, now, `A${ms.alim}'e varıldı — PAKET_TX byte1 = ${ms.alim}`);
      return true;
    case 'at_drop':
      if (!ms.task || ms.birakma) return false;
      ms.birakma = ms.task.b;
      plcLog(ms, now, `B${ms.birakma}'e varıldı — PAKET_TX byte2 = ${ms.birakma}`);
      return true;
    // At the door by a taught scenario rather than by reading KAPI1/KAPI2: the
    // same wait. Once per approach — a door already waited at on this approach
    // (the camera read its code on the way) is not waited at again.
    case 'gate': {
      if (ms.phase !== 'to_drop' && ms.phase !== 'returning') return false;
      if (ms.gateKey && ms.gateKey.startsWith(`${ms.phase}:`)) return false;
      plcGate(ms, `${ms.phase}:senaryo`, now, 'kapıya varıldı — '
        + (ms.gateWaitMs > 0 ? `${Math.round(ms.gateWaitMs / 1000)} s bekleniyor`
                             : 'fabrika komutu bekleniyor'));
      return true;
    }
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
      ms.task = null; ms.resume = null; ms.gateKey = null; ms.homing = false; ms.wait = false;
      ms.alim = 0; ms.birakma = 0; ms.loaded = false; ms.gateUntil = 0;
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
  ms.task = null; ms.resume = null; ms.gateKey = null; ms.homing = false; ms.wait = false;
  ms.alim = 0; ms.birakma = 0; ms.loaded = false; ms.gateUntil = 0;
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
  // The door. Twenty seconds of durum 5 and the robot goes, whether or not the
  // factory ever answered — see the header.
  if (ms.phase === 'gate' && ms.gateUntil && now >= ms.gateUntil) {
    plcLeaveGate(ms, now, ms.gateOpen
      ? 'bekleme süresi doldu — kapıdan geçiliyor (PLC devam demişti)'
      : 'bekleme süresi doldu — kapıdan geçiliyor');
  }
  // Back in the start area and stopped: the lap is over.
  if (ms.phase === 'returning' && ms.homing && robot.armed === false) plcFinish(ms, now);
}

/**
 * What goes into the next PAKET_TX.
 *
 * Bytes 1 and 2 are what the robot has confirmed, not what it was told — see
 * the header. `echo` puts the task's own numbers there from the moment it is
 * taken, for a factory that wants them back straight away.
 */
function plcTxFields(ms) {
  return {
    code: plcMissionCode(ms),
    a: ms.echo ? (ms.task ? ms.task.a : 0) : ms.alim,
    b: ms.echo ? (ms.task ? ms.task.b : 0) : ms.birakma,
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
    wait: ms.wait,
    task: ms.task,
    // What bytes 1 and 2 of the next packet will actually say.
    alim: ms.echo ? (ms.task ? ms.task.a : 0) : ms.alim,
    birakma: ms.echo ? (ms.task ? ms.task.b : 0) : ms.birakma,
    echo: ms.echo,
    loaded: ms.loaded,
    gate_wait_s: Math.round(ms.gateWaitMs / 100) / 10,
    gate_left_s: ms.phase === 'gate' && ms.gateUntil
      ? Math.max(0, Math.round((ms.gateUntil - now) / 100) / 10) : null,
    gate_open: ms.gateOpen,
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
    PLC_TX_LEN, PLC_RX_LEN, PLC_GATE_WAIT_MS, PLC_CODE_LABEL, PLC_CONTROL_LABEL,
    PLC_PHASE_CODE,
    plcCm, plcEncodeTx, plcDecodeTx, plcEncodeRx, plcDecodeRx, plcHex,
    plcMission, plcMissionCode, plcMissionHold, plcTaskStops, plcMissionRx,
    plcMissionFix, plcMissionEvent, plcMissionTick, plcTxFields, plcMissionStatus, plcLog,
  };
}
