/**
 * The lift, as two buttons.
 *
 * One DC actuator on an L298N — see PIN_LIFT_* in esp32/ws_dac/ws_dac.ino — and
 * the only two things anybody wants to do with it: raise the load and lower it.
 *
 * Shared rather than written twice, for the same reason wheels.js is: the two
 * pages that can drive the robot both need it, and a second copy is a second
 * set of edge cases to get right. /dashboard is where a run is watched from and
 * /drive is where it is driven from, so both get the buttons.
 *
 * ── Held, not latched ────────────────────────────────────────────────
 *
 * There is no "up" that stays up. While a button is down the page repeats the
 * command at 20 Hz; the moment it stops — released, pointer dragged off,
 * window blurred, tab hidden, page closed — the repeat stops, and three
 * separate things notice:
 *
 *   1. this page sends one explicit stop as the button comes up
 *   2. the server's `liftOut` falls back to 0 after 400 ms of silence
 *   3. the board's own 300 ms watchdog idles everything, lift included
 *
 * Any one of them is enough. All three exist because an actuator that keeps
 * extending after the browser died is the failure that breaks the mechanism,
 * and unlike a wheel it does not simply coast to a stop — it drives into its
 * own end stop and stays there.
 *
 * The firmware caps a single continuous run and reports `cut` when it does.
 * That is not an error to hide: it means the actuator has been pushing against
 * something for eight seconds, which is either the end of its travel or a jam.
 */

const LIFT_REPEAT_MS = 50;      // 20 Hz, the same rate the gears are held at

const LIFT_CSS = `
.lift{display:flex;gap:10px}
.lift button{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;
  padding:18px 8px;line-height:1;font:600 15px/1 inherit;letter-spacing:.6px;
  color:var(--ink);background:transparent;border:1px solid var(--line);
  border-radius:11px;cursor:pointer;touch-action:none;-webkit-user-select:none;
  user-select:none}
.lift button span{font:11px/1.3 ui-monospace,Menlo,monospace;color:var(--dim)}
.lift button.live{background:var(--warn);border-color:var(--warn);color:#231a02}
.lift button.live span{color:#231a02;opacity:.8}
.lift button:disabled{opacity:.45;cursor:not-allowed}
.liftnote{margin-top:10px;font-size:13px;color:var(--dim)}
.liftnote.warnc{color:var(--warn)}
`;

/**
 * Put the two buttons somewhere and wire them up.
 *
 * @param {object} opts
 * @param {(msg: object) => void} opts.send   how this page talks to the server
 * @param {string} opts.into    CSS selector for the container to fill
 * @returns {{fromStatus: (s: object) => void, release: () => void}}
 */
function liftMount(opts) {
  const host = document.querySelector(opts.into);
  if (!host) return { fromStatus() {}, release() {} };

  if (!document.getElementById('lift-css')) {
    const st = document.createElement('style');
    st.id = 'lift-css';
    st.textContent = LIFT_CSS;
    document.head.appendChild(st);
  }

  const row = document.createElement('div');
  row.className = 'lift';
  row.innerHTML = `
    <button type="button" data-dir="1">KALDIR<span>basılı tut</span></button>
    <button type="button" data-dir="-1">İNDİR<span>basılı tut</span></button>`;
  const note = document.createElement('div');
  note.className = 'liftnote';
  note.textContent = 'Basılı tuttuğun sürece hareket eder — bırakınca durur.';
  host.append(row, note);

  const btns = [...row.querySelectorAll('button')];
  let held = 0, timer = null;

  const tick = () => opts.send({ cmd: 'lift', dir: held });

  const release = () => {
    if (!held) return;
    held = 0;
    clearInterval(timer);
    timer = null;
    for (const b of btns) b.classList.remove('live');
    // One explicit stop, rather than trusting the silence. The two watchdogs
    // behind it are the safety net, not the mechanism.
    opts.send({ cmd: 'lift', dir: 0 });
  };

  const grab = (dir, btn) => (e) => {
    e.preventDefault();
    if (held === dir) return;
    release();
    held = dir;
    btn.classList.add('live');
    tick();
    timer = setInterval(tick, LIFT_REPEAT_MS);
  };

  for (const b of btns) {
    const dir = Number(b.dataset.dir);
    b.addEventListener('pointerdown', grab(dir, b));
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    b.addEventListener('pointerleave', release);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  // A window that loses focus is a window whose pointerup you will never see.
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  return {
    release,
    /**
     * Say what the actuator is actually doing, which is not always what was
     * asked. The run limit is the interesting case: the button is still down,
     * the bridge is off, and without this the page would sit there looking like
     * it was lifting.
     */
    fromStatus(s) {
      const l = (s && s.lift) || {};
      const espOk = s && s.esp_fresh && !s.serial_error;
      for (const b of btns) b.disabled = !espOk;
      if (!espOk) {
        note.className = 'liftnote warnc';
        note.textContent = 'ESP32 erişilemiyor — kaldırma çalışmaz.';
        return;
      }
      if (l.cut) {
        note.className = 'liftnote warnc';
        note.textContent = 'Çalışma sınırına ulaşıldı — sürücü kesildi. '
          + 'Düğmeyi bırak, sonra yeniden bas. Aktüatör muhtemelen sonuna dayandı.';
        return;
      }
      note.className = 'liftnote';
      note.textContent = l.dir
        ? `${l.dir > 0 ? 'Kalkıyor' : 'İniyor'} · ${Math.abs(l.out)}/255`
          + (l.at != null && l.at !== l.out ? `  (köprü ${l.at})` : '')
        : `Basılı tuttuğun sürece hareket eder — bırakınca durur. Güç ${l.pct ?? '–'} %.`;
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LIFT_CSS, LIFT_REPEAT_MS, liftMount };
}
