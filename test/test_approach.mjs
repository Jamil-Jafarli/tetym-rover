/**
 * The pallet manoeuvre: the plan, the line the server sees, and the run.
 *
 * The plan first, because it is the part that is silently wrong: a manoeuvre
 * written in the chassis' frame instead of the camera's reverses into the
 * pallet it was meant to drive away from, and nothing on the robot notices
 * until it does it. Then road_eye.js against a painted frame, because "the
 * server can see the line" is the whole premise. Then a whole manoeuvre
 * through ApproachRunner with stubs for the board and the camera — find,
 * align, drive, measure, back up by what was measured, turn, drive in, lift —
 * and last the lap, where a station leg is not over until that has happened.
 *
 *   node test/test_approach.mjs
 */
import { loadShared } from '../shared.js';
import { RoadEye } from '../road_eye.js';
import { ApproachRunner } from '../approach_run.js';
import { ScenarioRunner, LapDriver } from '../scenario_run.js';
import { Actuator } from '../actuator.js';

const A = loadShared(['scenario.js', 'approach.js'],
                     ['APPROACH_DEFAULTS', 'approachMm', 'approachGcode', 'approachPlan',
                      'approachPilot', 'scenarioLine']);
const P = loadShared('plc.js', ['plcMission', 'plcMissionRx', 'plcMissionEvent',
                                'plcMissionHold', 'plcMissionStatus', 'plcMissionCode',
                                'plcTxFields', 'plcLog']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };

/** The wheel and the board, as /plc's boxes would have them measured. */
const GEOM = { circumference: 200, track: 300, mmPerRev: 40, feed: 3000, invert: {} };

// ══ the plan ═════════════════════════════════════════════════════════
console.log('\nManevra planı: yeddi addım, kameranın çərçivəsində');
{
  const plan = A.approachPlan('pick', {}, GEOM);
  ok(plan.ok && plan.steps.length === 7, `yeddi addım  (${plan.steps.length})`);
  ok(plan.steps.map((s) => s.kind).join(' ') === 'find align line move move move lift',
     `sıra: ${plan.steps.map((s) => s.kind).join(' ')}`);
  ok(plan.mm.along === 1300 && plan.mm.back === 1300 && plan.mm.in === 1300,
     'ölçülmemişse üç mesafe de robot boyu (130 cm)');
  ok(plan.mm.turn === 180, 'dönüş 180°');
  ok(plan.steps[6].dir === 'up' && plan.steps[6].ms === 15000, 'aktuator yukarı, 15 saniye');
  ok(A.approachPlan('drop', {}, GEOM).steps[6].dir === 'down', 'bırakmada aşağı');

  // The camera is on the chassis' back (rover.js), so a metre "forward" for
  // the line follower is scenarioLine's 'back' — and the other way round.
  ok(plan.steps[3].cmd === A.scenarioLine('forward', 1300, GEOM),
     `geri adım kartın «forward»u  (${plan.steps[3].cmd})`);
  ok(plan.steps[5].cmd === A.scenarioLine('back', 1300, GEOM),
     `çəngəllərlə irəli kartın «back»i  (${plan.steps[5].cmd})`);
  ok(plan.steps[3].cmd !== plan.steps[5].cmd, 'geri ile ileri zıt işaretli');
  const front = A.approachPlan('pick', {}, { ...GEOM, camFront: true });
  ok(front.steps[5].cmd === A.scenarioLine('forward', 1300, GEOM),
     'kamera ön taraftaysa çevirme yok');

  const tuned = A.approachPlan('pick', { along_mm: 900, back_mm: 400, in_mm: 1500,
                                         turn_deg: 175, lift_s: 8 }, GEOM);
  ok(tuned.mm.along === 900 && tuned.mm.back === 400 && tuned.mm.in === 1500,
     'ölçülen mesafeler ayrı ayrı verilebiliyor');
  ok(tuned.steps[6].ms === 8000, 'aktuator süresi de ayarlanabiliyor');
  ok(/47\.12/.test(A.approachPlan('pick', { turn_deg: 90 }, GEOM).steps[4].cmd),
     '90°lik dönüş tekerler arası mesafeden hesaplanıyor');

  const noGeom = A.approachPlan('pick', {}, { mmPerRev: 40 });
  ok(!noGeom.ok && /çevre|iz/.test(noGeom.why),
     `ölçü yoksa manevra kurulmuyor, sebebi yazılı  (${noGeom.why})`);
  ok(A.approachMm({ rover_mm: 800 }).along === 800, 'robot boyu değişince mesafeler onu izliyor');
}

// ══ the line, server-side ════════════════════════════════════════════
console.log('\nSunucunun gördüğü xətt: RGB kare → sapma');
{
  const W = 480, H = 360;
  /** A frame with the competition line — blue | orange | blue — at `cx`. */
  const painted = (cx) => {
    const rgb = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        let r = 120, g = 120, b = 120;
        const d = x - cx;
        if (d >= -30 && d < -10) { r = 52; g = 101; b = 164; }
        else if (d >= -10 && d < 10) { r = 255; g = 128; b = 0; }
        else if (d >= 10 && d < 30) { r = 52; g = 101; b = 164; }
        rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
      }
    }
    return rgb;
  };

  const eye = new RoadEye();
  eye.setCfg({ vision: { mode: 'line' } });
  const mid = eye.see(painted(240), W, H, 1000);
  ok(mid && mid.bands >= 4, `ortadaki xətt görünür  (${mid && mid.bands} şerit)`);
  ok(Math.abs(mid.near) < 0.08, `sapma sıfıra yakın  (${mid.near.toFixed(3)})`);
  const right = eye.see(painted(360), W, H, 1100);
  ok(right.near > 0.3, `sağdaki xətt müsbət sapma  (${right.near.toFixed(3)})`);
  const left = eye.see(painted(120), W, H, 1200);
  ok(left.near < -0.3, `soldakı xətt mənfi sapma  (${left.near.toFixed(3)})`);

  ok(eye.seeing(1200) === true, 'taze kare: xətt görünür');
  ok(eye.seeing(4000) === false, 'bayat kare xətt sayılmıyor');
  ok(eye.fresh(4000) === null, 'bayat cevap verilmiyor');
  ok(eye.see(Buffer.alloc(300), 10, 10, 1300) === null && /480x360/.test(eye.err),
     `başka boyut reddediliyor, sebebi yazılı  (${eye.err})`);
  ok(eye.status(1200).frames === 3 && eye.status(1200).mode === 'line',
     'durum: okunan kare sayısı ve mod');

  // Nothing painted at all: no line, and that is an answer, not an error.
  const blank = eye.see(Buffer.alloc(W * H * 3, 120), W, H, 1400);
  ok(blank && (blank.near === null || blank.bands < 2), 'boş karede xətt yoxdur');
  ok(eye.err === null, 'boş kare hata değil');
}

// ══ a whole manoeuvre ════════════════════════════════════════════════
/** A board that answers instantly and remembers every line. */
function stubLink() {
  return {
    connected: true, sent: [],
    send(cmd) { this.sent.push(String(cmd)); },
    async whenDrained() { return true; },
    drain() {}, sign: () => 1, invert: {}, mmPerRev: () => ({ X: 40, Y: 40 }),
  };
}

/** The rover, as far as the manoeuvre can tell: demand in, metres out. */
function stubRover() {
  return {
    running: false, demand: [0, 0], armedTimes: 0, metres: 0,
    start() { this.running = true; this.armedTimes++; },
    stop() { this.running = false; },
    setAuto(l, r) {
      this.demand = [l, r];
      // Both wheels forward is ground covered; a pivot is not.
      this.metres += Math.max(0, Math.min(l, r)) / 100 * 0.02;
    },
  };
}

/**
 * The camera, told what to say.
 *
 * Each answer carries `at`, and the stamp only moves every FRAME_MS: the
 * runner will not act twice on one frame, so an eye that stamped every call
 * would let it step the pilot — and count "square for five frames" — as fast
 * as its own loop runs.
 */
function stubEye(obs) {
  const FRAME_MS = 60;                       // a camera at about 16 a second
  const eye = {
    locked: false, obs,
    lock(on) { eye.locked = on; },
    fresh: () => (eye.obs
      ? { ...eye.obs, at: Math.floor(Date.now() / FRAME_MS) * FRAME_MS }
      : null),
    seeing: () => !!(eye.obs && eye.obs.near !== null && eye.obs.bands >= 2),
    status: () => ({ err: null }),
    bandsWanted: 8,
  };
  return eye;
}

console.log('\nManevra sürülüyor: tap, nizamla, get, gəldiyi qədər qayıt');
{
  const link = stubLink();
  const jog = { stop() {} };
  const rover = stubRover();
  const eye = stubEye(null);                        // no line yet
  const act = new Actuator({ enabled: false, maxRunMs: 0 });
  const logged = [];
  const runner = new ApproachRunner({
    link, jog, rover, eye, act,
    metres: () => rover.metres,
    cfg: () => ({ along_mm: 300, lift_s: 0.3, find_s: 5, align_s: 5, line_s: 10,
                  speed: 40, square: 2 }),
    geom: () => GEOM,
    log: (t) => logged.push(t),
  });

  ok(runner.start('pick').ok, 'manevra başladı');
  await sleep(120);
  ok(runner.running && runner.status().running.step === 1, 'xətt yoxdur: birinci addımda bekliyor');
  ok(rover.armedTimes === 1 && rover.running, 'manevra roveri kendisi silahlandırdı');
  ok(eye.locked === true, 'dedektörün modu manevra boyunca dondurulmuş');
  ok(rover.demand[0] === 0 && rover.demand[1] === 0, 'xətt görünmədən tekerler dönmüyor');

  // The line turns up, well off to one side, and then straightens.
  eye.obs = { near: 0.5, far: 0.5, bands: 6, corner: null, end: null, junction: null };
  await sleep(150);
  ok(runner.status().running.step >= 2, 'xətt göründü → nizamlanmağa keçdi');
  eye.obs = { near: 0.01, far: 0.0, bands: 6, corner: null, end: null, junction: null };
  ok(await until(() => runner.status().running && runner.status().running.step >= 3, 3000),
     'xəttə nizamlandı → xətt üzrə sürür');
  ok(await until(() => !runner.running, 6000), 'manevra bitti');

  const last = runner.last;
  ok(last.result === 'bitti', `sonuç: ${last.result}${last.why ? ` — ${last.why}` : ''}`);
  ok(last.drove_mm >= 300, `xətt üzrə en az istenen kadar gidildi  (${Math.round(last.drove_mm)} mm)`);

  // The three G1s, in order, and the one that goes back is built from the
  // distance actually driven rather than from a number in the settings.
  const moves = link.sent.filter((c) => c.startsWith('G1'));
  ok(moves.length === 3, `üç G1 gitti  (${moves.length})`);
  ok(moves[0] === A.approachGcode('back', Math.round(last.drove_mm), GEOM),
     `geri adım gəldiyi qədər: ${moves[0]}`);
  ok(moves[1] === A.approachGcode('right', 180, GEOM), `180° dönüş: ${moves[1]}`);
  ok(moves[2] === A.approachGcode('forward', Math.round(last.drove_mm), GEOM),
     `çəngəllərlə geri gəldiyi qədər: ${moves[2]}`);
  ok(link.sent.filter((c) => c === 'M400').length === 3, 'her hareketin arkasında M400');
  ok(link.sent[link.sent.length - 1] === 'G91', 'sonda G91 — el sürüşü yine göreli');
  ok(last.note && /gəldiyi qədər/.test(last.note), `ölçü yazılı: ${last.note}`);

  // The actuator ran the right way for its time, and is off at the end.
  const w = act.status().writes.join(' ');
  ok(/GPIO22=dh/.test(w), 'aktuator yukarı yönde sürüldü');
  ok(act.status().running === false && /GPIO10=dh$/.test(w), 'sonunda durduruldu');
  ok(rover.running === false, 'manevra roveri bulduğu gibi bıraktı');
}

console.log('\nManevra: tutulma, DUR, ölçü yoxdursa reddediliyor');
{
  const link = stubLink();
  const rover = stubRover();
  const eye = stubEye({ near: 0, far: 0, bands: 6, corner: null, end: null, junction: null });
  const act = new Actuator({ enabled: false, maxRunMs: 0 });
  const runner = new ApproachRunner({
    link, jog: { stop() {} }, rover, eye, act,
    metres: () => rover.metres,
    cfg: () => ({ along_mm: 5000, lift_s: 0.2, square: 1 }),
    geom: () => GEOM,
  });
  runner.hold('PLC bekle dedi');
  ok(runner.start('pick').ok, 'tutulurken de başlatılabiliyor');
  await sleep(150);
  ok(rover.demand[0] === 0 && rover.metres === 0, 'tutulurken tek milimetre gitmiyor');
  ok(runner.status().running.paused === 'PLC bekle dedi',
     `durum niçin beklediğini söylüyor  («${runner.status().running.paused}»)`);
  runner.hold(null);
  ok(await until(() => rover.metres > 0.05, 2000), 'bırakılınca kaldığı yerden sürüyor');
  ok(runner.stop('DUR düğmesi'), 'DUR durduruyor');
  ok(!runner.running && runner.last.result === 'durduruldu', 'durdurulan manevra öyle yazılıyor');
  ok(link.sent[link.sent.length - 1] === 'G91', 'durdurulunca da G91');

  const bad = new ApproachRunner({
    link, jog: { stop() {} }, rover, eye, act, metres: () => 0,
    cfg: () => ({}), geom: () => ({}),
  });
  const res = bad.start('pick');
  ok(!res.ok && /ölç/.test(res.why), `ölçüsüz manevra reddediliyor  (${res.why})`);
  ok(bad.status().refused.why === res.why, 'reddedilme sebebi durumda duruyor');

  const off = new ApproachRunner({
    link: { ...stubLink(), connected: false }, jog: { stop() {} }, rover, eye, act,
    metres: () => 0, cfg: () => ({}), geom: () => GEOM,
  });
  ok(!off.start('pick').ok, 'kart bağlı değilken manevra yok');
}

// ══ the lap: a station leg is not over until the pallet is on ════════
console.log('\nTurda: istasyon etabı manevra bitene kadar bitmiyor');
{
  const texts = {};
  for (const id of ['BASLA_A1', 'A1_KAPI', 'KAPI_GIT', 'B2_BIRAK']) texts[id] = 'G1 X-10 Y10';
  const link = stubLink();
  const runner = new ScenarioRunner({ link, jog: { stop() {} } });
  const ms = P.plcMission({ gateWaitMs: 40 });
  // A manoeuvre that does nothing but take a moment and then say it worked.
  const done = [];
  // The durum byte at the moment each event landed: a lap that carries straight
  // on to the next leg would otherwise be read at whatever it got to next.
  const codeAt = {};
  const approach = {
    running: false, onEnd: null, kinds: [],
    start(kind) {
      this.running = true;
      this.kinds.push(kind);
      setTimeout(() => {
        this.running = false;
        this.onEnd({ kind, result: this.fails ? 'hata' : 'bitti', why: this.fails || null });
      }, 30);
      return { ok: true };
    },
    stop() { this.running = false; return true; },
    hold() {},
  };
  const lap = new LapDriver({
    runner, texts: () => texts, mission: () => P.plcMissionStatus(ms, Date.now()),
    event: (e) => {
      P.plcMissionEvent(ms, e, Date.now());
      done.push(e);
      codeAt[e] = P.plcMissionCode(ms);
      runner.hold(P.plcMissionHold(ms));
    },
    log: () => {}, enabled: () => true, approach,
  });
  const rx = (a, b, control, replyTo) => {
    P.plcMissionRx(ms, { ok: true, a, b, control, replyTo }, Date.now());
    runner.hold(P.plcMissionHold(ms));
  };
  const spin = async (fn, n = 400) => {
    for (let i = 0; i < n && !fn(); i++) {
      loadShared('plc.js', ['plcMissionTick']).plcMissionTick(ms, {}, Date.now());
      runner.hold(P.plcMissionHold(ms));
      lap.tick();
      await sleep(5);
    }
    return fn();
  };

  rx(1, 2, 2, 1); rx(1, 2, 2, 2);
  lap.tick();
  ok(runner.running && runner.run.id === 'BASLA_A1', 'Başlangıç → A1 sürülüyor');
  ok(await spin(() => lap.status().lap.state === 'manoeuvre'),
     'etap bitti → önce palet manevrası, «yük alındı» henüz yok');
  ok(!done.includes('picked') && P.plcMissionCode(ms) === 3, 'manevra biterken durum hâlâ 3');
  ok(approach.kinds[0] === 'pick', 'alım manevrası istendi');
  ok(done.includes('at_pick') && P.plcTxFields(ms).a === 1,
     'istasyona varıldı: PAKET_TX byte1 = 1 (QR okunmasa da)');
  ok(await spin(() => done.includes('picked')), 'manevra bitince «yük alındı»');
  ok(codeAt.picked === 4, `ve durum o anda 4 — yüklü  (${codeAt.picked})`);
  ok(await spin(() => approach.kinds.length === 2 && approach.kinds[1] === 'drop', 600),
     'B2 etabından sonra bırakma manevrası');
  ok(await spin(() => done.includes('dropped')), 'o da bitince «yük bırakıldı»');
  ok(P.plcTxFields(ms).b === 2, 'PAKET_TX byte2 = 2');
}

console.log('\nTurda: manevra durursa tur da durur');
{
  const texts = {};
  for (const id of ['BASLA_A1', 'A1_KAPI', 'KAPI_GIT', 'B2_BIRAK']) texts[id] = 'G1 X-10 Y10';
  const link = stubLink();
  const runner = new ScenarioRunner({ link, jog: { stop() {} } });
  const ms = P.plcMission();
  const approach = {
    running: false, onEnd: null,
    start(kind) {
      this.running = true;
      setTimeout(() => { this.running = false; this.onEnd({ kind, result: 'hata', why: 'xətt görünmədi' }); }, 20);
      return { ok: true };
    },
    stop() { this.running = false; return true; }, hold() {},
  };
  const lap = new LapDriver({
    runner, texts: () => texts, mission: () => P.plcMissionStatus(ms, Date.now()),
    event: (e) => P.plcMissionEvent(ms, e, Date.now()),
    log: () => {}, enabled: () => true, approach,
  });
  P.plcMissionRx(ms, { ok: true, a: 1, b: 2, control: 2, replyTo: 1 }, 0);
  P.plcMissionRx(ms, { ok: true, a: 1, b: 2, control: 2, replyTo: 2 }, 0);
  lap.tick();
  const stopped = await until(() => lap.status().lap.state === 'failed', 2000, () => lap.tick());
  ok(stopped, 'manevra hata verince tur durdu');
  ok(/manevra/.test(lap.status().lap.why) && P.plcMissionCode(ms) === 3,
     `sebebi yazılı, durum hâlâ 3  (${lap.status().lap.why})`);
}

async function until(fn, ms = 2000, each = null) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    if (each) each();
    await sleep(5);
  }
  return fn();
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail\n` : `\nALL CHECKS PASSED — ${pass} ok, 0 fail\n`);
process.exit(fail ? 1 : 0);
