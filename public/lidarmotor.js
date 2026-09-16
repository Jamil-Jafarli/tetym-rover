/**
 * The lidar's card: one START/STOP button and the voltage.
 *
 * The motor is a DC motor on an L298N (lidar.js on the server): GPIO18 pulses
 * ENA, GPIO23/GPIO24 are IN1/IN2. The page says volts; the server owns how
 * many percent of duty that is, because only it knows the supply and the
 * bridge's drop.
 *
 * No key, and Space does not stop it: the lidar is meant to keep spinning
 * through a run while the wheels are stopped and started around it.
 */
function lidarMotorMount(el) {
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">Lidar</h2>
      <span class="muted" data-l="state">–</span>
    </div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-top:12px;align-items:stretch">
      <button data-l="run" style="padding:16px">START</button>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px" class="muted">
        Gərginlik, V
        <input type="number" data-l="volts" min="0" step="0.1" value="1.6" style="width:100%">
      </label>
    </div>
    <p class="muted" data-l="note" style="margin:10px 0 0;font-size:12.5px"></p>`;
  const q = (k) => el.querySelector(`[data-l="${k}"]`);
  let st = null;

  async function send(body) {
    try {
      const r = await fetch('/api/lidar-motor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status);
      st = j;
      paint();
    } catch (e) {
      q('state').textContent = 'xəta: ' + e.message;
    }
  }

  async function poll() {
    try {
      const r = await fetch('/api/lidar-motor');
      if (!r.ok) throw new Error(r.status);
      st = await r.json();
      paint();
    } catch {
      q('state').textContent = 'sunucu cavab vermir';
    }
  }

  function paint() {
    if (!st) return;
    const run = q('run');
    run.textContent = st.running ? 'STOP' : 'START';
    run.style.background = st.running ? 'var(--stop)' : '';
    run.style.borderColor = st.running ? 'var(--stop)' : '';
    run.style.color = st.running ? '#fff' : '';
    const v = q('volts');
    v.max = st.max_v;
    // Never overwrite what is being typed.
    if (document.activeElement !== v) v.value = st.volts;
    q('state').textContent = st.err ? 'xəta'
      : st.running ? `fırlanır · ${st.volts} V · ${st.run_s.toFixed(0)} s`
      : 'dayanıb';
    q('state').style.color = st.err ? 'var(--stop)' : st.running ? 'var(--warn)' : '';
    q('note').textContent = st.err ? st.err
      : (st.dry ? 'Quru rejim (--no-lidar): pinlərə toxunulmur. ' : '')
        + `${st.volts} V ≈ ENA ${st.duty}% (${st.supply_v} V qida − L298N ${st.drop_v} V itki, `
        + `ən çox ${st.max_v} V). GPIO${st.pins.pwm} ENA, GPIO${st.pins.in1} IN1, `
        + `GPIO${st.pins.in2} IN2. Multimetrlə OUT1–OUT2 ölç, fərqlidirsə gərginliyi düzəlt.`;
    q('note').style.color = st.err ? 'var(--warn)' : '';
  }

  q('run').addEventListener('click', () => send({ action: 'toggle' }));
  q('volts').addEventListener('change', (e) => send({ action: 'volts', v: Number(e.target.value) }));

  poll();
  setInterval(poll, 1000);
  return { send, status: () => st };
}
