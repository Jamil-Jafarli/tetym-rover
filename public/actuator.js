/**
 * The lift's buttons, and its two keys — for any page that wants them.
 *
 *     Q   start / stop            (toggle)
 *     E   the other direction     (through a stop, if it is running)
 *     Space                        stops it, along with everything else
 *
 * The pins are the server's (actuator.js): GPIO10 is ENABLE, active low, and
 * GPIO22 is the direction. A page never says "dh" or "dl" — it says what it
 * means, and the server owns which level that is.
 *
 * Latched, not held. W A S D are held because a wheel should stop the moment
 * a finger lifts; the lift is started and stopped with one press each, because
 * an actuator stroke takes seconds and holding a key down for all of it is how
 * the keyboard auto-repeat ends up sending forty toggles. What makes that safe
 * is on the server: a run is cut after `max_s`, and the last page closing
 * stops it.
 *
 * Q and E are read by physical key (event.code), so they are the same two keys
 * on an Azerbaijani, Turkish or US layout.
 */
function actMount(el) {
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">Aktuator — Q başlat/dayan · E istiqamət</h2>
      <span class="muted" data-a="state">–</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
      <button data-a="run" style="padding:16px">BAŞLAT <span class="mono">(Q)</span></button>
      <button data-a="flip" style="padding:16px">İSTİQAMƏT <span class="mono">(E)</span></button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
      <button data-a="up">▲ yuxarı</button>
      <button data-a="down">▼ aşağı</button>
    </div>
    <p class="muted" data-a="note" style="margin:10px 0 0;font-size:12.5px"></p>`;
  const q = (k) => el.querySelector(`[data-a="${k}"]`);
  let st = null;

  async function send(action, dir) {
    try {
      const r = await fetch('/api/actuator', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dir ? { action, dir } : { action }),
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
      const r = await fetch('/api/actuator');
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
    run.innerHTML = (st.running ? 'DAYANDIR' : 'BAŞLAT') + ' <span class="mono">(Q)</span>';
    run.style.background = st.running ? 'var(--stop)' : '';
    run.style.borderColor = st.running ? 'var(--stop)' : '';
    run.style.color = st.running ? '#fff' : '';
    for (const d of ['up', 'down']) {
      const b = q(d);
      const on = st.dir === d;
      b.style.background = on ? 'var(--idle)' : '';
      b.style.borderColor = on ? 'var(--idle)' : '';
      b.style.color = on ? '#04182e' : '';
    }
    const word = st.dir === 'up' ? 'yuxarı' : 'aşağı';
    q('state').textContent = st.err ? 'xəta'
      : st.running ? `işləyir · ${word} · ${st.run_s.toFixed(1)} s`
      : `dayanıb · ${word}`;
    q('state').style.color = st.err ? 'var(--stop)' : st.running ? 'var(--warn)' : '';
    q('note').textContent = st.err ? st.err
      : st.cut ? `Son işləmə ${st.max_s} s-dən sonra kəsildi — ya yolun sonudur, ya da ilişib.`
      : (st.dry ? 'Quru rejim (--no-actuator): pinlərə toxunulmur. ' : '')
        + `GPIO${st.pins.en} başlat/dayan, GPIO${st.pins.dir} istiqamət. `
        + (st.max_s > 0 ? `Bir işləmə ən çox ${st.max_s} s.` : '');
    q('note').style.color = st.err || st.cut ? 'var(--warn)' : '';
  }

  q('run').addEventListener('click', () => send('toggle'));
  q('flip').addEventListener('click', () => send('flip'));
  q('up').addEventListener('click', () => send('up'));
  q('down').addEventListener('click', () => send('down'));

  // A field being typed into keeps its Q and E, exactly as it keeps W A S D.
  const typing = () => {
    const a = document.activeElement;
    if (!a) return false;
    if (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') return true;
    return a.tagName === 'INPUT'
      && ['text', 'number', 'search', 'email', 'url', 'tel', 'password'].includes(a.type);
  };
  document.addEventListener('keydown', (e) => {
    if (typing() || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyQ') { e.preventDefault(); send('toggle'); }
    else if (e.code === 'KeyE') { e.preventDefault(); send('flip'); }
    // The panic key stops the lift too. A stop that leaves an actuator
    // driving into its end is not a stop.
    else if (e.code === 'Space' && st && st.running) send('stop');
  });

  poll();
  setInterval(poll, 500);
  return { send, status: () => st };
}
