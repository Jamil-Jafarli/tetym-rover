/**
 * Reads a run log and says what to change.
 *
 * What this is NOT: a simulator. Re-running the recorded errors through
 * pilot.js with a bigger kP tells you what the wheels would have been told for
 * the errors that actually happened — but a bigger kP would have changed where
 * the robot went, so the errors after the first correction would have been
 * different ones. Open-loop replay of a closed loop is a lie that looks like
 * evidence, so this file does not do it.
 *
 * What it does instead: measure things in the log that have one honest
 * interpretation each, and map them to one parameter each.
 *
 *   wobbling on a straight     → kP is too high
 *   steer pinned at the stop   → the corner is tighter than the speed allows
 *   losing the road in bends   → going in too fast
 *   never troubled at all      → there is speed left on the table
 *   corners entered late       → kD is too low
 *
 * Distance is the one thing that CAN be calibrated outright, because you can
 * measure it with a tape: given the real length of the lap, the constant falls
 * straight out of the speed profile that was recorded.
 *
 * Pure, no DOM: /tune loads it in the browser, test/test_analyse.mjs runs it in
 * node against synthetic runs.
 */

const around = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
const aclamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Below this, the road ahead counts as straight — the wobble test only means
// anything where the robot was not being asked to turn.
const STRAIGHT = 0.18;
// Above this, it was genuinely in a bend.
const BEND = 0.35;

// Where the wheels start turning, when the log does not say. 0 by default —
// steppers have no dead band, so a log with no `stall` field is read as not
// having one, not as having some unknown one. Only a log that explicitly
// carries `pilot.stall` (from the ESP32 era, when 22 % of a 3.3 V ceiling —
// 1.5 V — was this robot's measured threshold) is analysed for one at all.
const DEFAULT_STALL = 0;

/**
 * Split a run into what it was doing, moment to moment.
 *
 * Reported for its own sake — "eight straights, six right-handers, two of them
 * where it lost the road" is the sentence you actually want after a lap — and
 * used by the findings below.
 */
function segments(rows) {
  const kindOf = (r) => {
    // A corner is its own kind of thing, and it is tested before `lost`
    // because the chain going away IS the middle of a 90° turn — calling that
    // stretch "lost the road" would be reporting the manoeuvre as its own
    // failure. Older logs have no `turn` field and fall through unchanged.
    const turn = Number(r.turn) || 0;
    if (turn) return turn > 0 ? '90° sağa' : '90° sola';
    if (r.lost) return 'kayıp';
    const s = Number(r.steer) || 0;
    if (Math.abs(s) < 0.12) return 'düz';
    return s > 0 ? 'sağ viraj' : 'sol viraj';
  };
  const out = [];
  for (const r of rows) {
    const kind = kindOf(r);
    const t = Number(r.t) || 0;
    const last = out[out.length - 1];
    if (last && last.kind === kind) {
      last.end = t;
      last.n++;
      last.sumSpeed += Number(r.speed) || 0;
      last.peak = Math.max(last.peak, Math.abs(Number(r.steer) || 0));
      last.dist = r.dist == null ? last.dist : Number(r.dist);
    } else {
      out.push({ kind, t, end: t, n: 1, sumSpeed: Number(r.speed) || 0,
                 peak: Math.abs(Number(r.steer) || 0),
                 dist0: r.dist == null ? null : Number(r.dist),
                 dist: r.dist == null ? null : Number(r.dist) });
    }
  }
  // A single sample is not a manoeuvre, it is a sample. Fold the crumbs into
  // whatever came before them so the list reads like a lap — and then coalesce,
  // because swallowing a one-frame twitch usually leaves the straight either
  // side of it split in two.
  const eat = (p, s) => {
    p.end = s.end; p.n += s.n; p.sumSpeed += s.sumSpeed;
    p.peak = Math.max(p.peak, s.peak);
    p.dist = s.dist ?? p.dist;
  };
  const merged = [];
  for (const s of out) {
    const p = merged[merged.length - 1];
    if (p && (p.kind === s.kind || (s.n <= 2 && s.kind !== 'kayıp'))) { eat(p, s); continue; }
    merged.push({ ...s });
  }
  return merged.map((s) => ({
    kind: s.kind,
    t: s.t,
    dur_s: around((s.end - s.t) / 1000),
    avg_speed: around(s.sumSpeed / s.n, 1),
    peak_steer: around(s.peak),
    dist_m: s.dist == null || s.dist0 == null ? null : around(s.dist - s.dist0),
  }));
}

/** The raw measurements. Everything below is an opinion about these. */
function metrics(rows, stall = 0) {
  const t = (r) => Number(r.t) || 0;
  const dur = rows.length > 1 ? (t(rows[rows.length - 1]) - t(rows[0])) / 1000 : 0;

  let straightRows = 0, flips = 0, prevSign = 0;
  let sat = 0, bendRows = 0, lostRows = 0, lostRuns = 0, wasLost = false;
  let absErr = 0, worst = 0, sumSpeed = 0, peakSpeed = 0;
  let lateN = 0, lateSum = 0;
  // The dead band: a wheel commanded above zero but below the voltage at which
  // it turns is not going slowly, it is standing still while being asked to
  // move. Counting it is the difference between "the tuning is off" and "the
  // robot was never actually driving".
  let deadWheel = 0, deadBoth = 0, wheelN = 0;
  let recoverRows = 0, recoverRuns = 0, wasRecover = false;
  // The 90° corners the pilot actually committed to, and the ones it gave up
  // on: a turn that ends without the road coming back in front of the robot
  // is the one number that says the corner handling itself needs tuning.
  let turnRows = 0, turnRuns = 0, wasTurn = false, turnFails = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const err = Number(r.err) || 0;
    const far = r.far == null ? err : Number(r.far);
    const steer = Number(r.steer) || 0;
    const speed = Number(r.speed) || 0;

    sumSpeed += speed;
    if (speed > peakSpeed) peakSpeed = speed;
    absErr += Math.abs(err);
    if (Math.abs(err) > worst) worst = Math.abs(err);
    if (Math.abs(steer) >= 0.98) sat++;
    if (/çevrilir/.test(String(r.reason || ''))) {
      recoverRows++;
      if (!wasRecover) recoverRuns++;
      wasRecover = true;
    } else wasRecover = false;

    if (stall > 0 && r.p25 != null && r.p26 != null) {
      const a = Number(r.p25), b = Number(r.p26);
      wheelN += 2;
      if (a > 0 && a < stall) deadWheel++;
      if (b > 0 && b < stall) deadWheel++;
      if (Math.max(a, b) < stall) deadBoth++;
    }

    // A corner being driven is not the road being lost, however much the two
    // look alike from the outside: no chain, wheels differential, crawling.
    // Counted as its own thing, and kept out of the lost totals — otherwise
    // every corner on the lap argues for lowering the speed on the straights.
    const turn = Number(r.turn) || 0;
    if (turn) {
      turnRows++;
      if (!wasTurn) turnRuns++;
      wasTurn = true;
      wasLost = false;
      prevSign = 0;
      continue;
    }
    // The frame after a turn tells us how it went: road in front of the robot
    // means the corner was taken, still nothing means it was given up on.
    if (wasTurn && r.lost) turnFails++;
    wasTurn = false;

    if (r.lost) {
      lostRows++;
      if (!wasLost) lostRuns++;
      wasLost = true;
      prevSign = 0;
      continue;
    }
    wasLost = false;

    if (Math.abs(far) < STRAIGHT) {
      // Straight-line wobble: how often the error crosses the centre line.
      // Once or twice over a lap is the robot settling; several times a second
      // is a controller fighting itself.
      straightRows++;
      const sign = err > 0.03 ? 1 : err < -0.03 ? -1 : 0;
      if (sign !== 0) {
        if (prevSign !== 0 && sign !== prevSign) flips++;
        prevSign = sign;
      }
    } else if (Math.abs(far) >= BEND) {
      bendRows++;
      // Entering a bend: the road ahead has already moved, so how far has the
      // near end been allowed to drift by the time we get there? That is what
      // the look-ahead term is for.
      lateN++;
      lateSum += Math.abs(err);
    }
  }

  const dt = rows.length > 1 ? dur / (rows.length - 1) : 0.1;
  const straightSecs = straightRows * dt;
  return {
    rows: rows.length,
    duration_s: around(dur),
    dt_s: around(dt, 3),
    avg_speed: around(sumSpeed / Math.max(1, rows.length), 1),
    peak_speed: around(peakSpeed, 1),
    avg_abs_err: around(absErr / Math.max(1, rows.length)),
    worst_err: around(worst),
    straight_s: around(straightSecs),
    bend_s: around(bendRows * dt),
    // crossings per second of straight-line driving
    wobble: around(straightSecs > 0.5 ? flips / straightSecs : 0),
    sat_frac: around(sat / Math.max(1, rows.length)),
    lost_frames: lostRows,
    lost_events: lostRuns,
    lost_s: around(lostRows * dt),
    bend_entry_err: around(lateN ? lateSum / lateN : 0),
    stall,
    dead_frac: around(wheelN ? deadWheel / wheelN : 0),
    dead_both_frac: around(rows.length ? deadBoth / rows.length : 0),
    recover_events: recoverRuns,
    recover_s: around(recoverRows * dt),
    corner_events: turnRuns,
    corner_s: around(turnRows * dt),
    corner_failed: turnFails,
  };
}

/**
 * Distance calibration, from a lap you measured with a tape.
 *
 * The model in pilot.js is "speed is proportional to throttle", so one real
 * pair of (distance, time) pins the constant. Integrating the recorded speed
 * gives percent-seconds; the real length divided by that is metres per
 * percent-second, which is exactly what {pct, metres, seconds} encodes when
 * `pct` is the mean speed over the run.
 */
function calibrate(rows, realMetres, stall = 0) {
  const m = Number(realMetres);
  if (!(m > 0) || rows.length < 2) return null;
  // What reached the pin, not what was asked for: with a dead band those are
  // different numbers, and it is the pin the wheel responds to. Older logs have
  // no per-wheel columns, so fall back to the demand.
  const pctOf = (r) => (r.p25 != null && r.p26 != null
    ? ((Number(r.p25) || 0) + (Number(r.p26) || 0)) / 2
    : (Number(r.speed) || 0));
  let pctSeconds = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = ((Number(rows[i].t) || 0) - (Number(rows[i - 1].t) || 0)) / 1000;
    if (dt <= 0 || dt > 1) continue;                 // a gap, not a sample
    pctSeconds += (pctOf(rows[i]) + pctOf(rows[i - 1])) / 2 * dt;
  }
  if (pctSeconds <= 0) return null;                  // it never moved
  const seconds = ((Number(rows[rows.length - 1].t) || 0) - (Number(rows[0].t) || 0)) / 1000;
  const pct = pctSeconds / seconds;                  // mean throttle over the run
  return {
    pct: around(pct, 1),
    metres: around(m, 2),
    seconds: around(seconds, 2),
    dead: around(stall, 1),
    // What it works out to, for the person reading it.
    mps_at_100: around((m / seconds) * (100 / pct), 2),
  };
}

/**
 * The opinions. Each finding names one measurement, one interpretation and one
 * number to change — never a bundle, because a bundle cannot be falsified on
 * the next lap.
 */
function findings(m, pilot) {
  const p = { base: 18, kP: 0.85, kD: 0.12, curve: 0.75, max: 50, stall: 22,
              crawl: 10, hard: 0.6, ...(pilot || {}) };
  const out = [];
  const add = (level, title, detail, fix) => out.push({ level, title, detail, fix: fix || null });

  // Before anything else: was it electrically driving at all? Every other
  // reading is meaningless if the answer is no.
  if (m.dead_both_frac >= 0.2) {
    add('warn', 'Tekerler hiç dönmüyordu',
      `Karelerin ${Math.round(m.dead_both_frac * 100)} %-inde HER İKİ teker `
      + `dönme eşiğinin (${m.stall} % ≈ 1.5 V) altındaydı. Bu yavaş gitmek `
      + `değil — durmaktır. «Düz yolda hız»ı yükselt.`,
      { base: Math.round(aclamp(Math.max(p.base * 1.5, 15), 5, 100)) });
  } else if (m.dead_frac >= 0.25) {
    add('warn', 'İç teker ölü bölgede kalıyor',
      `Teker komutlarının ${Math.round(m.dead_frac * 100)} %-i 0 ile ${m.stall} % `
      + `arasında — yani «yavaşla» değil, «dur» demek. Viraj yumuşak değil, `
      + `açık-kapalı oluyor. Ölü bölge telafisi bunu düzeltir.`);
  }

  if (m.rows < 20) {
    add('info', 'Kayıt çok kısa',
      `Toplam ${m.rows} satır. Bir tur sür — 30 saniye yeter — sonra bak.`);
    return out;
  }

  // 1. Wobble on the straight → kP.
  if (m.straight_s < 2) {
    add('info', 'Düz yol az',
      `Toplam ${m.straight_s} s düz gitti, bu yüzden direksiyonun sertliği `
      + `hakkında bir şey diyemem. Uzun düz kısmı olan bir tur gerekli.`);
  } else if (m.wobble >= 1.5) {
    add('warn', 'Düz yolda salınıyor',
      `Saniyede ${m.wobble} kez merkezi kesiyor. Bu direksiyonun fazla sert `
      + `olmasıdır — robot düzeltmeyi düzeltiyor.`,
      { kP: around(aclamp(p.kP * 0.75, 0.1, 2.5)) });
  } else if (m.wobble <= 0.4 && m.avg_abs_err > 0.25) {
    add('warn', 'Yavaş düzeliyor',
      `Salınım yok (${m.wobble}/s), ama ortalama sapma ${m.avg_abs_err} — `
      + `yani yolun kenarında gidiyor ve kendini acele etmeden merkeze çekiyor.`,
      { kP: around(aclamp(p.kP * 1.25, 0.1, 2.5)) });
  } else {
    add('info', 'Düz yolda kararlı',
      `Saniyede ${m.wobble} kesişme, ortalama sapma ${m.avg_abs_err}. kP yerinde.`);
  }

  // 2. Steering saturation → the corner is tighter than the speed allows.
  if (m.sat_frac >= 0.12) {
    add('warn', 'Direksiyon dayanağa dayanıyor',
      `Karelerin ${Math.round(m.sat_frac * 100)} %-inde iç teker tam durmuş `
      + `(direksiyon ±1). Hız farkıyla bu virajı daha keskin dönmek mümkün değil — `
      + `viraja daha yavaş girmek gerekiyor.`,
      { curve: around(aclamp(p.curve + 0.1, 0, 1)) });
  }

  // 3. Losing the road → too fast into the bends.
  if (m.lost_events > 0) {
    const perMin = m.duration_s > 0 ? (m.lost_events / m.duration_s) * 60 : 0;
    add(m.lost_events >= 3 ? 'warn' : 'info', 'Yolu kaybediyor',
      `${m.lost_events} kez, toplam ${m.lost_s} s (dakikada ${around(perMin, 1)}). `
      + `Keskin virajda zincir kopuyor — düz yoldaki hızı azaltmak ya da `
      + `virajda daha çok yavaşlamak yardımcı olur.`,
      m.lost_events >= 3 ? { base: Math.round(aclamp(p.base * 0.85, 5, 100)) } : null);
  }

  // 4. Late corners → kD.
  if (m.bend_s >= 2 && m.bend_entry_err >= 0.45) {
    add('warn', 'Viraja geç tepki',
      `Viraja girerken ortalama sapma ${m.bend_entry_err} — yol ileride çoktan `
      + `dönmüştü, robot ise hâlâ düz gidiyordu.`,
      { kD: around(aclamp(p.kD + 0.05, 0, 0.6)) });
  }

  // 3b. The 90° corners. Reported whichever way they went, because "it took
  // six of them and gave up on none" is the sentence the corner handling is
  // there to earn — and a corner given up on is a different fault from a
  // corner never seen, which is why they are counted apart.
  if (m.corner_events > 0) {
    const took = m.corner_events - m.corner_failed;
    add(m.corner_failed > 0 ? 'warn' : 'info', '90° köşe',
      `${m.corner_events} köşeye girdi, ${took} tanesinde yol tekrar önüne geldi, `
      + `toplam ${m.corner_s} s döndü.`
      + (m.corner_failed > 0
          ? ` ${m.corner_failed} tanesinde gelmedi — robot köşeyi kesiyor ya da `
            + `geçiyor: «dönmeden önce düz gitme süresi»ni değiştir.`
          : ''));
  }

  // 4b. How much of the lap was spent recovering rather than following?
  if (m.recover_events > 0) {
    add(m.recover_s > m.duration_s * 0.25 ? 'warn' : 'info', 'Yoldan uzaklaşıyor',
      `${m.recover_events} kez, toplam ${m.recover_s} s yerinde dönmek zorunda kaldı `
      + `(sapma ${p.hard} değerini geçti). Bir-iki kez normaldir; çok olursa viraja `
      + `giriş hızı hâlâ yüksektir.`,
      m.recover_s > m.duration_s * 0.25
        ? { base: Math.round(aclamp(p.base * 0.8, 5, 100)) } : null);
  }

  // 5. Nothing troubled it → there is speed left.
  const calm = m.worst_err < 0.45 && m.lost_events === 0 && m.recover_events === 0
    && m.sat_frac < 0.02 && m.wobble < 1.2 && m.dead_frac < 0.1
    && !m.corner_failed;
  if (calm) {
    add('info', 'Hız payı var',
      `En kötü sapma ${m.worst_err}, hiç yol kaybolmadı, direksiyon hiç dayanmadı. `
      + `Düz yoldaki hızı bir kademe yükseltebilirsin.`,
      { base: Math.round(aclamp(p.base * 1.15, 5, 100)) });
  }

  return out;
}

/** Everything, for one run. `realMetres` is optional. */
function analyse(run, realMetres) {
  if (!run || !Array.isArray(run.rows)) {
    return { ok: false, error: 'Bu dosya bir sürüş kaydı değil — «rows» dizisi yok.' };
  }
  const rows = run.rows.filter((r) => r && typeof r === 'object');
  if (!rows.length) return { ok: false, error: 'Kayıt boş — hiçbir satır yok.' };

  const stall = Number(run.pilot && run.pilot.stall) || DEFAULT_STALL;
  const m = metrics(rows, stall);
  const found = findings(m, run.pilot);
  // One proposal, built from the individual fixes. Later findings win on the
  // same key, which is the order they are written in: the corrective ones come
  // before the "you have room" one, so a run that both wobbled and looked calm
  // does not get told to speed up.
  const suggest = {};
  for (const f of found) if (f.fix) Object.assign(suggest, f.fix);

  return {
    ok: true,
    started: run.started || null,
    note: run.note || '',
    vmax: run.vmax ?? null,
    pilot: run.pilot || null,
    metrics: m,
    segments: segments(rows),
    findings: found,
    suggest,
    calib: calibrate(rows, realMetres, stall),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { analyse, metrics, segments, calibrate, findings, DEFAULT_STALL };
}
