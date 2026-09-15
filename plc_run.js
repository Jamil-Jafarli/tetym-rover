/**
 * The competition, wired into a running server: PLC link, mission, field.
 *
 * Both machines use it — the ESP32 bench and the Marlin rover — because the
 * factory automation protocol is about the robot, not about which board turns
 * its wheels. What differs between them is behind `robot`:
 *
 *   robot.map                   the field itself (FIELDS.yarisma / FIELDS.deneme)
 *   robot.field()               the field state (public/field.js) to read the pose from
 *   robot.route()               dead reckoning for fieldPose(), or null
 *   robot.setMission(stops)     plan a list of stops from START
 *   robot.hold(reason|null)     stop the wheels and keep them stopped, or release
 *   robot.armed()               the pages' START is on
 *   robot.fault()               why the robot cannot drive right now, or null
 *
 * The mission (public/plc.js) is pure; this file is its clock and its I/O.
 */

import { PlcLink, parsePlcAddr } from './plc_link.js';
import { PlcSim } from './plc_sim.js';
import { loadShared } from './shared.js';

const P = loadShared('plc.js', ['plcMission', 'plcMissionRx', 'plcMissionFix',
  'plcMissionEvent', 'plcMissionTick', 'plcMissionHold', 'plcMissionCode',
  'plcTxFields', 'plcMissionStatus', 'PLC_CODE_LABEL', 'PLC_ROBOT_IP']);
const { fieldPose } = loadShared('field.js', ['fieldPose']);

const SIM_PORT = 1515;

/**
 * @param {object} args   parsed server arguments: plc, plcBind, plcSim, plcSimPort
 * @param {object} robot  see the header
 */
export function startCompetition(args, robot) {
  const ms = P.plcMission();
  // Until the first QR the robot has no measured position, but PAKET_TX has no
  // way to say "unknown" — so it reports the start area, where a run begins,
  // and /plc marks the number as an assumption rather than a measurement.
  const start = robot.map && robot.map.nodes.find((n) => n.id === 'START');
  if (start) ms.pose = { x: start.x, y: start.y, known: false };
  let sim = null;
  let link = null;
  let lastHold;

  const say = (text) => console.log(`plc: ${text}`);
  // Mission events go to the console once each, in order.
  const flushLog = () => {
    for (const e of ms.events) if (!e.logged) { e.logged = true; say(e.text); }
  };

  const pose = () => {
    try { return fieldPose(robot.field(), robot.route()); } catch { return null; }
  };

  const apply = (out) => {
    if (out && out.plan) {
      const plan = robot.setMission(out.plan);
      if (!plan || !plan.ok) say(`rota planlanamadı: ${(plan && plan.reason) || '?'}`);
      else say(`rota: ${plan.nodes.join(' > ')}`);
    }
    const hold = P.plcMissionHold(ms);
    if (hold !== lastHold) {
      lastHold = hold;
      robot.hold(hold);
    }
    flushLog();
  };

  if (args.plcSim) {
    sim = new PlcSim({ host: '127.0.0.1', port: args.plcSimPort || SIM_PORT }).start();
  }
  if (args.plc || sim) {
    const addr = args.plc ? parsePlcAddr(args.plc)
      : { host: '127.0.0.1', port: sim.cfg.port };
    link = new PlcLink({
      host: addr.host, port: addr.port, bind: args.plcBind || null,
      getTx: () => P.plcTxFields(ms),
    }).onRx((rx) => apply(P.plcMissionRx(ms, rx, rx.at)));
    link.start();
  }

  // The mission's clock: fault and pose on the way into the next packet, and
  // the end of a lap once the robot is parked.
  const timer = setInterval(() => {
    P.plcMissionTick(ms, { armed: robot.armed(), fault: robot.fault(), pose: pose() }, Date.now());
    apply(null);
  }, 200);
  timer.unref?.();
  apply(null);

  return {
    /** fieldSee()'s result for a code that was just read. */
    onFix(fix) {
      P.plcMissionFix(ms, fix, Date.now());
      apply(null);
    },

    /** A {cmd: 'plc', ...} message from a page. Returns true if it was one. */
    command(msg) {
      if (!msg || msg.cmd !== 'plc') return false;
      if (msg.event) {
        P.plcMissionEvent(ms, msg.event, Date.now());
        if (msg.event === 'estop') robot.estop?.();
      }
      if (msg.sim && sim) sim.set(msg.sim);
      apply(null);
      return true;
    },

    status() {
      const now = Date.now();
      return {
        mission: P.plcMissionStatus(ms, now),
        link: link ? link.status() : { enabled: false },
        sim: sim ? sim.status() : null,
        robot_ip: P.PLC_ROBOT_IP,
      };
    },

    banner() {
      if (!link) {
        console.log('  plc:            kapalı — yarışmada --plc ile açılır (192.168.100.100:1515)');
        return;
      }
      console.log(`  plc:            udp ${link.cfg.host}:${link.cfg.port}, `
        + `saniyede bir PAKET_TX${link.cfg.bind ? `, ${link.cfg.bind} adresinden` : ''}`
        + (sim ? ` — SİMÜLATÖR (127.0.0.1:${sim.cfg.port})` : ''));
    },

    close() {
      clearInterval(timer);
      if (link) link.close();
      if (sim) sim.close();
    },
  };
}
