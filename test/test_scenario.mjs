/**
 * Scenarios: the text, the lines the helper writes, and the runner.
 *
 * The runner is what moves the robot on its own, so the checks that matter
 * are the ones about stopping and refusing: a stop has to stop feeding and put
 * the board back in relative mode, a scenario with a typo must not half-run,
 * and nothing may start while another is running or the robot is on e-stop.
 *
 *   node test/test_scenario.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { loadShared } from '../shared.js';
import { ScenarioRunner } from '../scenario_run.js';

const S = loadShared('scenario.js', ['SCENARIO_SLOTS', 'scenarioSlot', 'scenarioParse',
                                     'scenarioProgram', 'scenarioAxisMm', 'scenarioLine']);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };

console.log('\nSenaryo yerleri');
{
  const ids = S.SCENARIO_SLOTS.map((s) => s.id);
  for (const id of ['A1_KAPI', 'A2_KAPI', 'A3_KAPI', 'KAPI_GIT', 'B1_BIRAK', 'B2_BIRAK', 'B3_BIRAK']) {
    ok(ids.includes(id), `${id} var`);
  }
  ok(['B1_KAPI', 'B2_KAPI', 'B3_KAPI', 'KAPI_DON', 'KAPI_BASLA'].every((id) => ids.includes(id)),
     'dönüş yolu da var: B → kapı, kapıdan geri geçiş, kapı → başlangıç');
  ok(new Set(ids).size === ids.length && ids.length === 12, '12 yer, hepsi farklı');
}

console.log('\nMetin → komutlar');
{
  const p = S.scenarioParse('; A2 kapıya\nG91\n g1 x-120 y120 f3000 ; ileri\n\n(yorum) G4 P500\nM400');
  ok(p.ok && p.commands.join(' | ') === 'G91 | G1 X-120 Y120 F3000 | G4 P500 | M400',
     `yorumlar ve boş satırlar atılıyor, harfler büyütülüyor  (${p.commands.join(' | ')})`);
  const bad = S.scenarioParse('G91\nileri git 100\nG1 X10');
  ok(!bad.ok && bad.errors.length === 1 && bad.errors[0].line === 2,
     'G-code olmayan satır numarasıyla bildiriliyor');
  const refused = S.scenarioParse('G1 X1\nM112\nM500\nM0502');
  ok(refused.errors.map((e) => e.line).join(',') === '2,3,4',
     'M112 (kart kilitlenir) ve EEPROM komutları senaryoda reddediliyor — M0502 yazılışı da');
  ok(S.scenarioParse('  ; sadece yorum').ok === false, 'yalnız yorumdan oluşan senaryo çalıştırılacak bir şey değil');
}

console.log('\nKarta giden program');
{
  const prog = S.scenarioProgram(['G91', 'G1 X-10 Y10 F3000', 'G4 P200', 'G0 Z5', 'G28 Z']);
  const cmds = prog.map((p) => p.cmd);
  ok(cmds.join(' | ') === 'G91 | G1 X-10 Y10 F3000 | M400 | G4 P200 | G0 Z5 | M400 | G28 Z | M400 | G91',
     `her hareketten sonra M400, sonda G91  (${cmds.join(' | ')})`);
  ok(prog.filter((p) => p.step).length === 5, 'ilerleme yazılan komutları sayar, eklenenleri değil');
}

console.log('\nSatır hesaplayıcı');
{
  const g = { circumference: 200, track: 300, mmPerRev: 40, feed: 3000 };
  ok(S.scenarioAxisMm(500, g) === 100, '500 mm yolda: teker 2.5 tur, kartta 2.5 × 40 = 100 mm');
  ok(S.scenarioLine('forward', 500, g) === 'G1 X-100.00 Y100.00 F3000', 'ileri: X- Y+ (DIRECTIONS.forward)');
  ok(S.scenarioLine('back', 500, g) === 'G1 X100.00 Y-100.00 F3000', 'geri: X+ Y-');
  // 90° on the spot: each wheel rolls a quarter of π × 300 = 235.62 mm → 47.12 axis mm.
  ok(S.scenarioLine('right', 90, g) === 'G1 X-47.12 Y-47.12 F3000', 'sağa 90°: X- Y- (DIRECTIONS.right)');
  ok(S.scenarioLine('left', 90, g) === 'G1 X47.12 Y47.12 F3000', 'sola 90°: X+ Y+');
  ok(S.scenarioLine('forward', 500, { ...g, invert: { X: true } }) === 'G1 X100.00 Y100.00 F3000',
     "/gcode'daki X yön ters çevirmesi satıra işleniyor");
  ok(S.scenarioLine('forward', 500, { mmPerRev: 40 }) === null, 'teker çevresi yoksa satır uydurulmuyor');
  ok(S.scenarioLine('right', 90, { circumference: 200, mmPerRev: 40 }) === null, 'dönüş için tekerler arası gerekli');
  ok(S.scenarioLine('lift', 60, { liftFeed: 240 }) === 'G1 Z60.00 F240', 'fork yukarı 60 mm');
  ok(S.scenarioLine('lift', 60, { liftInvert: true }) === 'G1 Z-60.00 F240', 'fork yönü ters ayarlıysa işaret dönüyor');
  ok(S.scenarioLine('wait', 1.5, {}) === 'G4 P1500', 'bekle 1.5 s');
}

/** A link that answers each command after a short "move". */
function stubLink({ connected = true, moveMs = 15 } = {}) {
  return {
    connected, sent: [], drained: 0, _busy: false,
    send(cmd) { if (!this.connected) throw new Error('not connected'); this.sent.push(cmd); this._busy = true; },
    drain() { this.drained++; },
    async whenDrained() { await sleep(moveMs); this._busy = false; return this.connected; },
  };
}
const stubJog = () => ({ stops: 0, stop() { this.stops++; } });

console.log('\nÇalıştırıcı');
{
  const link = stubLink();
  const jog = stubJog();
  const run = new ScenarioRunner({ link, jog });
  const res = run.start('A2_KAPI', 'G91\nG1 X-10 Y10 F3000\nG4 P100');
  ok(res.ok && run.running, 'başladı');
  ok(jog.stops === 1, 'başlamadan önce elle sürüş akışı durduruldu');
  ok(run.start('B3_BIRAK', 'G1 X1').ok === false && /zaten çalışıyor/.test(run.refused.why),
     'bir senaryo çalışırken ikincisi başlamıyor, sebebi yazılıyor');
  await sleep(200);
  ok(!run.running && run.last.result === 'bitti', 'bitti');
  ok(link.sent.join(' | ') === 'G91 | G1 X-10 Y10 F3000 | M400 | G4 P100 | G91',
     `karta sırayla, her komut cevaplanınca gitti  (${link.sent.join(' | ')})`);
  ok(run.last.step === 3 && run.last.total === 3, '3/3 komut');

  const slow = stubLink({ moveMs: 60 });
  const r2 = new ScenarioRunner({ link: slow, jog: stubJog() });
  r2.start('KAPI_GIT', 'G1 X-10 Y10\nG1 X-10 Y10\nG1 X-10 Y10\nG1 X-10 Y10');
  await sleep(90);
  const at = r2.status().running.step;
  ok(r2.stop('DUR düğmesi') && !r2.running, `yolda durduruldu (${at}. komutta)`);
  const sentAtStop = slow.sent.length;
  await sleep(300);
  ok(slow.sent.length === sentAtStop, 'durduktan sonra karta başka hareket gitmedi');
  ok(slow.drained === 1 && slow.sent[slow.sent.length - 1] === 'G91',
     'kuyruk boşaltıldı ve G91 ile göreli moda dönüldü');
  ok(r2.last.result === 'durduruldu' && r2.last.why === 'DUR düğmesi', 'nasıl bittiği kayıtlı');

  const r3 = new ScenarioRunner({ link: stubLink({ connected: false }), jog: stubJog() });
  ok(r3.start('A1_KAPI', 'G1 X1').why === 'Ender kartı bağlı değil', 'kart bağlı değilse başlamıyor');
  const r4 = new ScenarioRunner({ link: stubLink(), jog: stubJog(), blocked: () => 'acil stop basılı' });
  ok(r4.start('A1_KAPI', 'G1 X1').why === 'acil stop basılı', 'acil stopta başlamıyor');
  const r5link = stubLink();
  const r5 = new ScenarioRunner({ link: r5link, jog: stubJog() });
  const typo = r5.start('A1_KAPI', 'G1 X1\nileri\nG1 X2');
  ok(!typo.ok && typo.errors.length === 1 && r5link.sent.length === 0,
     'yazım hatası olan senaryonun hiçbir satırı gitmiyor — yarım çalışmaz');
  ok(r5.start('YOK', 'G1 X1').ok === false && r5.start('A1_KAPI', '').why === 'senaryo boş',
     'bilinmeyen yer ve boş senaryo reddediliyor');
}

console.log('\nSunucuda: kaydediliyor, kart yokken sebebiyle reddediliyor');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'tetym-scn-'));
  const proc = spawn('node', ['server.js', '--marlin', '--no-connect', '--http', '18207',
                              '--host', '127.0.0.1', '--no-camera', '--no-advertise'],
                     { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
                       env: { ...process.env, TETYM_FOLLOW_FILE: path.join(dir, 'follow.json') } });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  await sleep(1600);
  try {
    const ws = new WebSocket('ws://127.0.0.1:18207/');
    let st = null;
    ws.on('message', (d) => { try { const m = JSON.parse(d); if (m.type === 'status') st = m; } catch { /* */ } });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ cmd: 'follow_cfg', cfg: { scenarios: { A2_KAPI: 'G91\nG1 X-100 Y100 F3000' } } }));
    await sleep(250);
    ok(st && st.follow_cfg.scenarios.A2_KAPI.includes('G1 X-100'), 'senaryo kaydedildi');
    ok(st.scenario && st.scenario.supported === true, 'Ender tarafında senaryo destekleniyor');
    ws.send(JSON.stringify({ cmd: 'scenario_run', id: 'A2_KAPI' }));
    await sleep(250);
    ok(st.scenario.refused && st.scenario.refused.why === 'Ender kartı bağlı değil',
       `kart yokken çalışmıyor ve sayfa sebebini görüyor  (${st.scenario.refused && st.scenario.refused.why})`);
    ok(/scenario A2_KAPI: refused/.test(out), 'konsola da yazıldı');
    ws.close();
    const plc = await (await fetch('http://127.0.0.1:18207/plc')).text();
    ok(/id="scCard"/.test(plc) && /scenario_run/.test(plc), '/plc sayfasında senaryo kartı var');
    ok((await fetch('http://127.0.0.1:18207/scenario.js')).ok, '/scenario.js sunuluyor');
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
