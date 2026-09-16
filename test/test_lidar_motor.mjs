/**
 * The lidar motor: volts → duty, the commands that would reach lidar_pwm.py,
 * and the real server's /api/lidar-motor.
 *
 * No GPIO. The Lidar is given a stand-in for its helper process, and the
 * server is started with --no-lidar — this suite runs on the Pi, and a test
 * that spins a real motor is not a test.
 *
 *   node test/test_lidar.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { Lidar, LIDAR_DEFAULTS, lidarCommand } from '../lidar.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (${JSON.stringify(a)})`);

console.log('\nLidar — GPIO18 ENA (PWM), GPIO23 IN1, GPIO24 IN2');
{
  eq([LIDAR_DEFAULTS.pwmPin, LIDAR_DEFAULTS.in1Pin, LIDAR_DEFAULTS.in2Pin], [18, 23, 24],
     'pinlər: GPIO18, GPIO23, GPIO24');
  const log = [];
  const l = new Lidar({ send: (line) => log.push(line) });
  eq(l.status().volts, 1.6, 'susmaya görə 1.6 V');
  eq(l.duty(), 44.4, '1.6 / (5 − 1.4) → ENA 44.4 %');
  eq(log, [], 'START-a qədər heç nə göndərilmir');

  l.start();
  eq(log, ['on 44.4'], 'START → on 44.4');
  l.setVolts(1.8);
  eq(log.at(-1), 'on 50', 'işləyərkən 1.8 V → dərhal on 50');
  l.stop();
  eq(log.at(-1), 'off', 'STOP → off');
  l.stop();
  eq(log.at(-1), 'off', 'artıq dayanıbsa da off yenə göndərilir');
  const n = log.length;
  l.setVolts(1.2);
  eq(log.length, n, 'dayanıqlıkən gərginlik: heç nə göndərilmir');
  l.toggle();
  eq(log.at(-1), 'on 33.3', 'toggle → on 33.3 (1.2 V)');
  l.toggle();
  ok(!l.running && log.at(-1) === 'off', 'toggle yenə → off');

  l.setVolts(9);
  eq(l.volts, 3.6, 'qidadan çox istənən → 3.6 V-da kəsilir');
  eq(l.duty(), 100, 'yəni ENA 100 %');
  l.setVolts(-1);
  eq(l.volts, 0, 'mənfi → 0');

  const ideal = new Lidar({ send: () => {}, dropV: 0 });
  eq(ideal.duty(), 32, '--lidar-drop 0: 1.6 / 5 → 32 %');
}

console.log('\nlidarCommand');
{
  const log = [];
  const l = new Lidar({ send: (line) => log.push(line) });
  let threw = false;
  try { lidarCommand(l, 'spin'); } catch { threw = true; }
  ok(threw, 'naməlum əmr atılır');
  threw = false;
  try { lidarCommand(l, 'volts', 'abc'); } catch { threw = true; }
  ok(threw, 'rəqəm olmayan gərginlik atılır');
  const s = lidarCommand(l, 'volts', 2);
  ok(s.volts === 2 && !s.running, 'volts 2 → saxlanılır, işə salmır');
  ok(lidarCommand(l, 'start').running && log.at(-1) === 'on 55.6', 'start → on 55.6');
  ok(!lidarCommand(l, 'stop').running && log.at(-1) === 'off', 'stop → off');

  const dry = new Lidar({ enabled: false });
  dry.start();
  const d = dry.status();
  ok(d.dry && d.running && d.writes.join() === 'on 44.4', '--no-lidar: vəziyyət saxlanılır, proses yoxdur');
}

console.log('\nSunucu — /api/lidar-motor');
{
  const PORT = 8194;
  const proc = spawn('node', ['server.js', '--http', String(PORT), '--host', '127.0.0.1',
                              '--no-connect', '--no-camera', '--no-actuator', '--no-lidar', '--no-advertise',
                              '--routes', path.join(os.tmpdir(), `routes-lidar-${process.pid}.json`)],
                     { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = '';
  proc.stdout.on('data', (d) => { boot += d; });
  proc.stderr.on('data', (d) => { boot += d; });
  const B = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 80; i++) {
    try { await fetch(B + '/api/lidar-motor'); break; } catch { await sleep(100); }
  }
  const get = async (u) => (await fetch(B + u)).json();
  const post = async (u, body) => {
    const r = await fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                   body: JSON.stringify(body) });
    return { code: r.status, body: await r.json() };
  };
  try {
    let s = await get('/api/lidar-motor');
    ok(s.dry && !s.running && s.volts === 1.6 && s.pins.pwm === 18,
       '/api/lidar-motor: quru rejim, 1.6 V, GPIO18');
    s = (await post('/api/lidar-motor', { action: 'toggle' })).body;
    ok(s.running, 'toggle → fırlanır');
    s = (await post('/api/lidar-motor', { action: 'volts', v: 2 })).body;
    ok(s.running && s.volts === 2 && s.writes.at(-1) === 'on 55.6', 'volts 2 → on 55.6');
    s = (await post('/api/lidar-motor', { action: 'toggle' })).body;
    ok(!s.running, 'toggle yenə → dayandı');
    ok((await post('/api/lidar-motor', { action: 'fly' })).code === 400, 'naməlum əmr → 400');
    ok((await fetch(B + '/lidarmotor.js')).ok, '/lidarmotor.js verilir');
  } finally {
    proc.kill();
  }
  if (fail) console.log('\nserver output:\n' + boot);
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
