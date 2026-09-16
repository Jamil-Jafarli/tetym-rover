/**
 * The JSON API in front of marlin.js.
 *
 * Kept out of server.js because that file already does page-serving and the
 * road-following WebSocket; folding the printer's request/response API in
 * with both made all three harder to read. Everything here lives under
 * /api/marlin/, and `handle()` returns false for anything else so the caller
 * can carry on with its own routes.
 *
 * There is no authentication, exactly as with the rest of this server — see
 * the note it prints on startup.
 */
import { SETTABLE, DIRECTIONS, DEFAULT_STEP_MM, DEFAULT_FEED, SELF_REPORTING,
         listPorts, bestPort, isSpin, TURN_SCALE, settingWrite } from './marlin.js';

/**
 * The per-axis settings "Match Y to X" copies. The right wheel is on the Y
 * socket, and a differential drive wants both wheels configured alike — see
 * checkWheelAxes() in marlin.js for what a mismatched Y does to the rover.
 */
const MATCH_CODES = ['M92', 'M201', 'M203', 'M205', 'M350', 'M906'];

const JSON_HEAD = { 'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store' };

/** Everything `post()` below answers to. Named here so a GET at one of them
 *  can say "wrong verb" rather than "no such thing", which is the difference
 *  between a typo in a curl and a route that was never wired up. */
const POST_ROUTES = new Set([
  'connect', 'disconnect', 'gcode', 'jog', 'run', 'halt', 'estop', 'steppers',
  'endstops', 'home', 'zero', 'setting', 'match', 'invert', 'refresh', 'eeprom',
]);

// Exported for the other small JSON APIs on this server (actuator.js,
// routes.js), so there is one body parser with one size limit rather than three.
export function reply(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { ...JSON_HEAD, 'Content-Length': buf.length });
  res.end(buf);
}

export function readBody(req, limit = 64 * 1024) {
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
 * The axis letters a manual-control request (jog/home/zero) means.
 *
 * An explicit `axis` acts on just that one wheel — the per-axis buttons on the
 * drive page. Omitting it is a request about the rover as a whole, so it has
 * to reach both wheels: defaulting quietly to X alone would jog, home or zero
 * only the left one and leave the right wherever it was.
 */
const axesOf = (data) => {
  if (data.axis === undefined || data.axis === null || data.axis === '') {
    return ['X', 'Y'];
  }
  const axis = axisOf(data.axis);
  return axis ? [axis] : null;
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

/**
 * @param onManual  called before every hand-driven move and every halt — the
 *   server uses it to cancel a taught route being replayed (routes.js). A key
 *   pressed under a replay would otherwise stream its chunks between the
 *   replay's, and Space would stop the key but leave the replay driving.
 * @param held  the PLC mission's reason the wheels must not turn, or null —
 *   read per request. While it says something, jog and run answer 423.
 */
export function marlinApi({ link, jog, onManual = () => {}, held = () => null }) {
  /**
   * Ask the board what a settings write actually left behind.
   *
   * M92/M350/M906/M907 answer their own bare query. M201/M203/M204/M205 only
   * ever appear inside an M503 dump — without it the write reaches the board
   * but nothing ever reads it back, so a value the firmware capped would sit
   * in the cache as though it had stuck.
   */
  function readBack(codes) {
    let dump = false;
    for (const code of codes) {
      if (SELF_REPORTING.has(code)) link.send(code);
      else dump = true;
    }
    if (dump) link.send('M503');
  }

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

      case 'gcode': {
        const lines = String(data.cmd ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        for (const line of lines) link.send(line);
        // A setting typed into the console is read back like one from the
        // settings table, so the page shows what stuck, not what was typed.
        readBack(new Set(lines.map((l) => settingWrite(l)?.code).filter(Boolean)));
        return [200, { ok: true }];
      }

      case 'jog': {
        const axes = axesOf(data);
        if (!axes) return [400, { error: 'bad axis' }];
        const dist = Number(data.distance) || 0;
        const feed = Math.max(1, Number(data.feedrate) || DEFAULT_FEED);
        const parts = axes.map((a) => `${a}${(dist * link.sign(a)).toFixed(4)}`);
        onManual();
        link.send('G91');
        link.send(`G1 ${parts.join(' ')} F${Math.round(feed)}`);
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
        const vec = resolveVector(data);
        const spin = isSpin(vec);
        // A spin covers the same wheel distance as a straight chunk but
        // spends it turning on the spot, which reads as a much sharper turn
        // than the equivalent forward chunk reads as a move — see TURN_SCALE.
        // `turnScale` and `turnFeedrate` are how the page makes that
        // adjustable rather than fixed, independently of forward/back's `step`
        // and `feedrate`. Both default to the straight-line value when the
        // caller does not send one, so an old caller that only ever knew
        // about `feedrate`/`step` still gets exactly the behaviour it always
        // did. `turnScale` is clamped to 0 so a stray negative value cannot
        // flip a spin's direction; `turnFeedrate` is clamped like `feedrate`
        // itself, for the same reason a feed rate is never allowed to be 0 or
        // negative — Marlin would either reject it or move at no speed at all.
        const rawStep = Math.max(0.01, Number(data.step) || DEFAULT_STEP_MM);
        const turnScale = Math.max(0, Number(data.turnScale) || TURN_SCALE);
        const turnFeed = Math.max(1, Number(data.turnFeedrate) || feed);
        const step = spin ? rawStep * turnScale : rawStep;
        const effFeed = spin ? turnFeed : feed;

        onManual();
        link.send('G91');
        link.steppersOn = true;
        jog.start(vec, effFeed, step);

        // How often a chunk goes out once the stream is rolling: its cruise
        // time, because a blended chunk never ramps (see HOLD_MARGIN_S).
        const chunk = { X: Math.sign(vec.X || 0) * step, Y: Math.sign(vec.Y || 0) * step };
        return [200, { ok: true, mode: 'stream', axes: vec,
                       gcode: jog.gcode(vec, effFeed, step),
                       turn_scale: turnScale,
                       turn_feedrate: turnFeed,
                       chunk_seconds: jog.holdSeconds(chunk, effFeed) }];
      }

      case 'halt': {
        // The only stop there is: stop feeding chunks, drop the moves queued
        // but not yet sent, and let whatever is already in the planner
        // finish. Only the moves — a settings write or an M500 queued behind
        // them still goes out; dropping the whole queue here is how "Save to
        // EEPROM" used to vanish whenever a key came up (see dropMotion()). That used to be exactly one move, because a chunk was only
        // sent once its predecessor was confirmed done. It no longer is: the
        // Jogger keeps the next chunk planned before the current one starts
        // (HOLD_MARGIN_S), so the machine can be executing one chunk with two
        // queued behind it — this stops within about two chunks, which is the
        // deliberate trade for a held key not moving in slices (see
        // marlin.js; the page's #stopHint quotes the number). It still asks
        // nothing of the firmware, and leaves the planner and the reported
        // position consistent.
        //
        // There is deliberately no quickstop. M410 aborts a move mid-flight
        // and leaves Marlin's idea of where it is wrong until the next M114;
        // on firmware without the emergency parser it is not even prompt,
        // because it waits its turn behind the very move it is cancelling.
        // Shortening the stop by one chunk was never worth that.
        onManual();
        jog.stop();
        link.dropMotion();
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
        const axes = axesOf(data);
        if (!axes) return [400, { error: 'bad axis' }];
        link.send(`G28 ${axes.join(' ')}`);
        link.send('M114');
        link.steppersOn = true;
        return [200, { ok: true }];
      }

      case 'zero': {
        const axes = axesOf(data);
        if (!axes) return [400, { error: 'bad axis' }];
        link.send(`G92 ${axes.map((a) => `${a}0`).join(' ')}`);
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
        readBack([code]);
        return [200, { ok: true }];
      }

      case 'match': {
        // Y := X for every per-axis setting the board has reported. Not
        // clamped against SETTABLE: each value is one the board already
        // accepted on X, so the typo guard has nothing to guard — and the
        // guard is what used to make this impossible from the page whenever X
        // sat outside it. A value may still come back capped by the firmware;
        // the read-back reports that (MarlinLink.rejected).
        if (!link.connected) throw new Error('not connected');
        if (!link.settings.M92) {
          return [409, { error: 'the board has not reported its settings yet — press Re-read' }];
        }
        const writes = [];
        for (const code of MATCH_CODES) {
          if (link.unsupported.has(code)) continue;
          const { X: x, Y: y } = link.settings[code] || {};
          if (x === undefined || x === y) continue;
          writes.push({ code, params: { Y: +x.toFixed(3) } });
        }
        for (const w of writes) link.send(`${w.code} Y${w.params.Y}`);
        if (writes.length) readBack(new Set(writes.map((w) => w.code)));
        link.log(writes.length
          ? `Matching Y to X: ${writes.map((w) => `${w.code} Y${w.params.Y}`).join(', ')}`
          : 'Y already matches X.', 'sys');
        return [200, { ok: true, writes }];
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
          rejected: link.rejected,
          unsaved: link.unsaved,
          save_pending: link.savePending,
          autosave_ms: link.autosaveMs,
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
