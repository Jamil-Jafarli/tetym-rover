/**
 * The JSON API in front of marlin.js.
 *
 * Kept out of server.js because the ESP32 half of this server speaks
 * WebSocket and the printer half speaks request/response, and mixing the two
 * in one handler made both harder to read. Everything here lives under
 * /api/marlin/, and `handle()` returns false for anything else so the caller
 * can carry on with its own routes.
 *
 * There is no authentication, exactly as with the rest of this server — see
 * the note it prints on startup.
 */
import { SETTABLE, DIRECTIONS, DEFAULT_STEP_MM, DEFAULT_FEED,
         listPorts, bestPort } from './marlin.js';

const JSON_HEAD = { 'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store' };

/** Everything `post()` below answers to. Named here so a GET at one of them
 *  can say "wrong verb" rather than "no such thing", which is the difference
 *  between a typo in a curl and a route that was never wired up. */
const POST_ROUTES = new Set([
  'connect', 'disconnect', 'gcode', 'jog', 'run', 'halt', 'estop', 'steppers',
  'endstops', 'home', 'zero', 'setting', 'invert', 'refresh', 'eeprom',
]);

function reply(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { ...JSON_HEAD, 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`bad json: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

/** An axis letter this board understands, or null. */
const axisOf = (v) => {
  const a = String(v ?? '').toUpperCase().slice(0, 1);
  return 'XYZE'.includes(a) ? a : null;
};

/**
 * Whatever the caller meant by "this way", as motor signs.
 *
 * Three accepted spellings, all landing on the same {X, Y}:
 *   { dir: "forward" }            the named CoreXY direction
 *   { axes: { X: -1, Y: 1 } }     an explicit vector — how WASD sends diagonals
 *   { axis: "X", direction: -1 }  one axis, which is what a hold button is
 */
export function resolveVector(data) {
  if (data.dir !== undefined) {
    const named = DIRECTIONS[String(data.dir).toLowerCase()];
    if (!named) {
      throw new Error(`unknown direction ${JSON.stringify(data.dir)} — try `
                    + Object.keys(DIRECTIONS).join(', '));
    }
    return { ...named };
  }

  const out = {};
  if (data.axes && typeof data.axes === 'object' && Object.keys(data.axes).length) {
    for (const [name, value] of Object.entries(data.axes)) {
      const axis = axisOf(name);
      if (!axis) throw new Error(`bad axis ${JSON.stringify(name)}`);
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${axis}: not a number`);
      if (n) out[axis] = Math.sign(n);
    }
  } else {
    const axis = axisOf(data.axis ?? 'X');
    if (!axis) throw new Error('bad axis');
    out[axis] = (Number(data.direction ?? 1) < 0) ? -1 : 1;
  }

  if (!Object.keys(out).length) throw new Error('no direction given');
  return out;
}

export function marlinApi({ link, jog, held = () => null }) {
  /** POST bodies, by route. Throwing here turns into a 4xx below. */
  async function post(path, data) {
    // The PLC mission's brake covers the keyboard too: a robot waiting at the
    // door, or on emergency stop, does not creep forward because a key is down.
    const hold = (path === 'jog' || path === 'run') ? held() : null;
    if (hold) return [423, { error: `bekleniyor: ${hold}` }];
    switch (path) {
      case 'connect': {
        const port = data.port || await bestPort() || (await listPorts())[0];
        if (!port) return [400, { error: 'no serial port available' }];
        await link.connect(port, parseInt(data.baud, 10) || 115200);
        return [200, { ok: true, port }];
      }

      case 'disconnect':
        await link.disconnect();
        return [200, { ok: true }];

      case 'gcode':
        for (const line of String(data.cmd ?? '').split('\n')) {
          if (line.trim()) link.send(line.trim());
        }
        return [200, { ok: true }];

      case 'jog': {
        const axis = axisOf(data.axis ?? 'X');
        if (!axis) return [400, { error: 'bad axis' }];
        const dist = Number(data.distance) || 0;
        const feed = Math.max(1, Number(data.feedrate) || DEFAULT_FEED);
        link.send('G91');
        link.send(`G1 ${axis}${(dist * link.sign(axis)).toFixed(4)} F${Math.round(feed)}`);
        link.send('M114');
        link.steppersOn = true;
        return [200, { ok: true }];
      }

      case 'run': {
        // Press-and-hold: one short move, streamed for as long as the key is
        // down. There is deliberately only one mode. The alternative — a
        // single very long move, cancelled on release — cannot be stopped
        // without M410, and M410 is not in this codebase.
        const feed = Math.max(1, Number(data.feedrate) || DEFAULT_FEED);
        const step = Math.max(0.01, Number(data.step) || DEFAULT_STEP_MM);
        const vec = resolveVector(data);

        link.send('G91');
        link.steppersOn = true;
        jog.start(vec, feed, step);

        const axes = Object.values(vec).filter(Boolean).length;
        return [200, { ok: true, mode: 'stream', axes: vec,
                       gcode: jog.gcode(vec, feed, step),
                       chunk_seconds: jog.chunkSeconds(step * Math.sqrt(axes), feed) }];
      }

      case 'halt': {
        // The only stop there is: stop feeding chunks, drop anything queued
        // but not yet sent, and let the one move already in the planner
        // finish. Because a chunk is only sent once its predecessor is
        // confirmed done, there is never more than that one move — so this
        // stops within a chunk, asks nothing of the firmware, and leaves the
        // planner and the reported position consistent.
        //
        // There is deliberately no quickstop. M410 aborts a move mid-flight
        // and leaves Marlin's idea of where it is wrong until the next M114;
        // on firmware without the emergency parser it is not even prompt,
        // because it waits its turn behind the very move it is cancelling.
        // Shortening the stop by one chunk was never worth that.
        jog.stop();
        link.drain();
        link.send('M114');
        return [200, { ok: true }];
      }

      case 'estop':
        // The one command the board never answers: it stops dead mid-line and
        // has to be reset afterwards. Not a stop button — a last resort.
        link.sendNow('M112', false);
        return [200, { ok: true, note: 'board halted; reconnect to clear' }];

      case 'steppers': {
        const on = data.on !== false;
        link.send(on ? 'M17' : 'M18');
        link.steppersOn = on;
        return [200, { ok: true }];
      }

      case 'endstops': {
        const on = data.on !== false;
        link.send(on ? 'M211 S1' : 'M211 S0');
        link.softEndstops = on;
        return [200, { ok: true, soft_endstops: on }];
      }

      case 'home': {
        const axis = axisOf(data.axis ?? 'X');
        if (!axis) return [400, { error: 'bad axis' }];
        link.send(`G28 ${axis}`);
        link.send('M114');
        link.steppersOn = true;
        return [200, { ok: true }];
      }

      case 'zero': {
        const axis = axisOf(data.axis ?? 'X');
        if (!axis) return [400, { error: 'bad axis' }];
        link.send(`G92 ${axis}0`);
        link.send('M114');
        return [200, { ok: true }];
      }

      case 'setting': {
        // { code: "M906", params: { X: 580 } } -> "M906 X580"
        const code = String(data.code ?? '').toUpperCase().trim();
        const spec = SETTABLE[code];
        if (!spec) return [400, { error: `${JSON.stringify(code)} is not a settable code` }];
        if (link.unsupported.has(code)) {
          return [409, { error: `the firmware does not support ${code}` }];
        }
        const params = data.params;
        if (!params || typeof params !== 'object' || !Object.keys(params).length) {
          return [400, { error: 'no parameters given' }];
        }

        const parts = [];
        for (const [rawLetter, raw] of Object.entries(params)) {
          const letter = String(rawLetter).toUpperCase().slice(0, 1);
          if (!spec.letters.includes(letter)) {
            return [400, { error: `${code} does not take ${letter}` }];
          }
          const value = Number(raw);
          if (!Number.isFinite(value)) return [400, { error: `${letter}: not a number` }];
          if (value < spec.min || value > spec.max) {
            return [400, { error: `${code} ${letter}=${value} is outside the `
                                + `allowed ${spec.min}..${spec.max}` }];
          }
          parts.push(letter + (spec.int ? Math.round(value) : value));
        }

        link.send(`${code} ${parts.sort().join(' ')}`);
        if (['M92', 'M350', 'M906', 'M907'].includes(code)) {
          link.send(code);          // cheap confirmation of what actually stuck
        }
        return [200, { ok: true }];
      }

      case 'invert': {
        const axis = axisOf(data.axis);
        if (axis !== 'X' && axis !== 'Y') return [400, { error: 'axis must be X or Y' }];
        link.invert[axis] = data.on === true;
        link.log(`${axis} direction: ${link.invert[axis] ? 'inverted' : 'normal'}`, 'sys');
        return [200, { ok: true, invert: link.invert }];
      }

      case 'refresh':
        link.readSettings();
        link.send('M114');
        return [200, { ok: true }];

      case 'eeprom': {
        const action = String(data.action ?? '').toLowerCase();
        const code = { save: 'M500', load: 'M501', reset: 'M502' }[action];
        if (!code) return [400, { error: 'action must be save/load/reset' }];
        link.send(code);
        if (action === 'load' || action === 'reset') link.readSettings();
        return [200, { ok: true, sent: code }];
      }

      default:
        return [404, { error: 'not found' }];
    }
  }

  /**
   * @returns {Promise<boolean>} true if this request was ours.
   */
  return async function handle(req, res, url) {
    if (!url.startsWith('/api/marlin/')) return false;
    const path = url.slice('/api/marlin/'.length);

    if (req.method === 'GET') {
      if (path === 'status') {
        reply(res, 200, {
          connected: link.connected,
          responsive: link.sawRx,
          port: link.path,
          baud: link.baud,
          firmware: link.firmware,
          position: link.position,
          queue: link.queueDepth(),
          in_flight: link.inFlight(),
          default_step: DEFAULT_STEP_MM,
          default_feed: DEFAULT_FEED,
          steppers_on: link.steppersOn,
          soft_endstops: link.softEndstops,
          invert: link.invert,
          emergency_parser: link.emergencyParser,
          m400_blocks: link.m400Blocks,
          barrier_ms: link.barrierMs,
          jogging: jog.active,
          steps_per_mm: link.stepsPerMm,
          mm_per_rev: link.mmPerRev(),
          settings: link.settings,
          unsupported: [...link.unsupported].sort(),
          directions: DIRECTIONS,
          ports: await listPorts(),
        });
        return true;
      }
      if (path.startsWith('log')) {
        const since = parseInt(new URL(req.url, 'http://x').searchParams.get('since'), 10) || 0;
        reply(res, 200, link.logSince(since));
        return true;
      }
      reply(res, POST_ROUTES.has(path) ? 405 : 404,
            { error: POST_ROUTES.has(path) ? `POST ${path}, do not GET it` : 'not found' });
      return true;
    }

    if (req.method !== 'POST') {
      reply(res, 405, { error: 'use POST' });
      return true;
    }

    let data;
    try {
      data = await readBody(req);
    } catch (err) {
      reply(res, 400, { error: err.message });
      return true;
    }

    try {
      const [code, body] = await post(path, data);
      reply(res, code, body);
    } catch (err) {
      // "not connected" and friends are the caller's problem, not a crash.
      const msg = String(err.message || err);
      reply(res, /not connected|link is down|already connecting/.test(msg) ? 409 : 400,
            { error: msg });
    }
    return true;
  };
}
