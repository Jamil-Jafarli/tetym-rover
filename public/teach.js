/**
 * Ssenarilər — teaching the rover the way to each load, the card on /gcode.
 *
 * It sits on the drive page because teaching IS driving: press «+ Addım
 * öyrət», drive a piece of the way with W A S D exactly as you would anyway,
 * press Bitir. What the server keeps is the G-code that reached the board
 * while the recording was on (routes.js), so there is nothing to do
 * differently while teaching and nothing a key press has to know about it.
 *
 * One scenario per pickup point — A1, A2, A3 (yuva 1, 2, 3) — and each is the
 * rule "to see this slot's line, come here", taught one step at a time:
 *
 *   A2   1  W 480          out of the start area
 *        2  D 120          turn towards the slot
 *        3  W 900          until the camera sees the line
 *
 * A step can be driven alone (▶), taught again (↻), moved or deleted without
 * driving the rest again — or typed in («W 400 mm») instead of driven. The
 * steps joined are the leg /follow's cargo run drives from memory.
 *
 * A step can also be F — «follow the line until this QR is read», the F that
 * starts following on /follow — put wherever the way there has a line on it:
 *
 *   A2   1  W 480
 *        2  F → KAPI1      the line, until KAPI1 is under the camera
 *        3  D 120
 *
 * The server has no camera, so an F step is not driven from this page: /follow
 * follows the line there, between the taught parts (routes.js's parts()).
 *
 * Leg 2 — the start of the line → the door — is still one recording. The part
 * in between is not taught, it is SEEN: /follow finds the line, reads the
 * slot's QR, follows the paint to the load, turns round, lifts, and follows it
 * back — see missionCargo() in mission.js. Which is why leg 2 is taught from
 * where that leaves the rover: at the start of the line, turned round, with
 * the load behind it.
 */
function teachMount(el) {
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">Ssenarilər — yük götürmə nöqtəsinə yol</h2>
      <span class="muted" data-t="state">–</span>
    </div>
    <div class="seg" data-t="slots" style="margin-top:12px">
      <button data-slot="1">A1 · yuva 1</button>
      <button data-slot="2">A2 · yuva 2</button>
      <button data-slot="3">A3 · yuva 3</button>
    </div>
    <div style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="flex:1;min-width:180px" data-t="scTitle"></b>
        <button class="sm" data-t="clearAll">Hamısını sil</button>
      </div>
      <div class="muted mono" data-t="scSum" style="font-size:12px;margin-top:4px"></div>
      <ol data-t="steps" style="margin:10px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px"></ol>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <button class="sm" data-t="recStep">+ Addım öyrət — W A S D ilə sür</button>
        <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select data-t="key" style="width:auto">
            <option>W</option><option>S</option><option>A</option><option>D</option>
          </select>
          <input type="number" data-t="mm" min="1" max="5000" step="10" value="300" style="width:92px">
          <span class="muted">mm</span>
          <button class="sm" data-t="addStep">+ Yazılı addım</button>
        </span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px">
        <kbd style="font:600 12px ui-monospace,Menlo,monospace;border:1px solid var(--line);border-bottom-width:2px;border-radius:6px;padding:2px 7px">F</kbd>
        <span class="muted">xətti izlə, bu QR oxunana qədər:</span>
        <input type="text" data-t="fqr" placeholder="məs. KAPI1" autocomplete="off" spellcheck="false" style="width:130px">
        <button class="sm" data-t="addFollow">+ F addımı</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        <button data-t="test">▶ Ssenarini sına</button>
        <button data-t="stop">■ Dayandır</button>
      </div>
    </div>
    <div class="field" style="margin-top:14px">
      <label>Bu yuvanın QR mətni</label>
      <input type="text" data-t="qr" autocomplete="off" spellcheck="false">
    </div>
    <div data-leg="out" style="margin-top:12px"></div>
    <div data-t="rec" hidden style="margin-top:12px;border:1px solid var(--stop);border-radius:10px;padding:11px 12px">
      <div style="color:var(--stop);font-weight:600" data-t="recText"></div>
      <div class="muted mono" data-t="recList" style="margin-top:6px;font-size:12px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        <button data-t="save" class="pri">Bitir və saxla</button>
        <button data-t="cancel">Ləğv et</button>
      </div>
    </div>
    <button data-t="run" style="width:100%;margin-top:14px;padding:16px">–</button>
    <p class="muted" data-t="msg" style="margin:8px 0 0;font-size:12.5px"></p>
    <p class="muted" style="margin:10px 0 0;font-size:12.5px;line-height:1.55">
      <b>Necə:</b> hər yük götürmə nöqtəsinin öz ssenarisi var — «bu yuvanın xəttini
      görmək üçün bura gəl». Roveri başlanğıc sahəsinə qoy, <b>+ Addım öyrət</b>-ə
      bas, W A S D ilə bir parça sür (məs. düz irəli) və <b>Bitir və saxla</b>.
      Sonra növbəti addım — dönmə, yenə irəli — kamera yuvanın xəttini görənə qədər.
      <b>F addımı</b> — /follow-dakı F kimi: rover xətti izləyir və yazdığın QR
      oxunanda dayanıb növbəti addıma keçir. Onu kamera sürür, ona görə yalnız
      /follow-da işləyir; ssenarinin qalan addımları yenə yaddaşdan gedir.
      <b>▶</b> bir addımı tək sürür (rover o addımın başladığı yerdə olmalıdır),
      <b>↻</b> onu yenidən öyrədir. Addımı yazmaq da olar: <b>W 400 mm</b>; A/D üçün
      mm hər təkərin yoludur, dərəcə deyil. <b>▶ Ssenarini sına</b> yalnız sürür —
      QR yox, xətt yox; Space və ya istənilən klaviş onu dayandırır.
      <b>GET</b> /follow-a gedir — orada <b>SÜRMƏYƏ BAŞLA</b>: ssenari, sonra xətt,
      QR, yük. Qapı yolunu (2) xəttin başından, <b>kamera yuvanın əksinə</b>
      duranda öyrət.
      <b>Bir ssenari bəsdir:</b> üç xətt paraleldir və QR-ları bir sıradadır —
      ssenarisi olmayan yuvaya rover ən yaxın öyrədilmiş yuvanın xəttinə gedib
      QR sırası ilə keçir. 90° dönmələr QR sırasında olur, yükdən 1.5 m aralı:
      1.20 m-lik rover orada fırlananda yükə dəymir.</p>`;
  const q = (k) => el.querySelector(`[data-t="${k}"]`);
  // A QR text is typed by a person and drawn into the step list: escaped.
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const NAME = { 1: 'A1', 2: 'A2', 3: 'A3' };
  const LEGS = { to: '1 · Başlanğıc → yuva', out: '2 · Yuva → qapı' };
  let slot = 1, st = null, msg = '', drawn = { steps: null, out: null };

  async function call(body) {
    // A button keeps the focus after a click, and Space — the stop key — would
    // then press it again: «+ Addım öyrət» twice, or a second test drive.
    const f = document.activeElement;
    if (f && f.tagName === 'BUTTON' && el.contains(f)) f.blur();
    try {
      const r = await fetch('/api/cargo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (j.routes) st = j;
      msg = r.ok ? '' : (j.error || String(r.status));
    } catch (e) {
      msg = e.message;
    }
    paint();
  }

  async function poll() {
    try {
      const r = await fetch('/api/cargo');
      if (!r.ok) throw new Error(r.status);
      st = await r.json();
    } catch {
      st = null;
    }
    paint();
  }

  /** A test drive this card started, and not long ago — its news is worth showing. */
  function testNews(rp) {
    if (!rp || !String(rp.id || '').startsWith('test:')) return null;
    if (rp.active) return rp;
    return Date.now() - Number(String(rp.id).slice(5)) < 20000 ? rp : null;
  }

  // Rebuilt only when what they show changes: the card polls every 700 ms, and
  // a button replaced between mousedown and mouseup is a click that never lands.
  function paintSteps(r, busy) {
    const steps = (r.to && r.to.steps) || [];
    const sig = JSON.stringify([slot, steps, busy]);
    if (drawn.steps === sig) return;
    drawn.steps = sig;
    const off = busy ? 'disabled' : '';
    q('steps').innerHTML = steps.map((s, i) => {
      const f = s.how === 'follow';
      return `
      <li style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;border:1px solid ${f ? 'var(--idle, #0969da)' : 'var(--line)'};border-radius:10px;padding:7px 9px">
        <b style="min-width:22px">${i + 1}.</b>
        <span class="mono" style="flex:1;min-width:130px;font-size:12.5px">${f
          ? `F — xətti izlə → <b>${esc(s.qr)}</b>` : s.list.join(', ')}</span>
        <span class="muted" style="font-size:11px">${f ? 'xətt izləmə' : s.how === 'typed' ? 'yazılıb' : 'sürülüb'}</span>
        <button class="sm" data-do="test" data-i="${i}" ${f
          ? 'title="F addımını kamera sürür — /follow-da «YÜKÜNƏ GET» ilə sına" disabled'
          : `title="yalnız bu addımı sür" ${off}`}>▶</button>
        <button class="sm" data-do="rec" data-i="${i}" title="bu addımı yenidən öyrət" ${off}>↻</button>
        <button class="sm" data-do="up" data-i="${i}" title="yuxarı" ${busy || i === 0 ? 'disabled' : ''}>↑</button>
        <button class="sm" data-do="down" data-i="${i}" title="aşağı" ${busy || i === steps.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="sm" data-do="del" data-i="${i}" title="sil" ${off}>✕</button>
      </li>`;
    }).join('')
      || '<li class="muted" style="font-size:12.5px">Heç bir addım yoxdur — ssenari öyrədilməyib.</li>';
  }

  function paintOut(r, busy) {
    const info = r.out;
    const sig = JSON.stringify([slot, info, busy]);
    if (drawn.out === sig) return;
    drawn.out = sig;
    const box = el.querySelector('[data-leg="out"]');
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="flex:1;min-width:150px">${LEGS.out.replace('yuva', 'yuva ' + slot)}</b>
        <button class="sm" data-do="rec" ${busy ? 'disabled' : ''}>${info ? 'Yenidən öyrət' : 'Öyrət'}</button>
        <button class="sm" data-do="del" ${info && !busy ? '' : 'disabled'}>Sil</button>
      </div>
      <div class="muted mono" style="font-size:12px;margin-top:4px">${info
        ? `${info.moves} hərəkət · ${(info.mm / 1000).toFixed(2)} m təkər · ${info.list.join(', ')}`
        : 'öyrədilməyib'}</div>`;
    box.querySelector('[data-do="rec"]').onclick = () => call({ action: 'record', slot, leg: 'out' });
    box.querySelector('[data-do="del"]').onclick = () => {
      if (confirm(`${NAME[slot]}: «${LEGS.out}» silinsin?`)) call({ action: 'clear', slot, leg: 'out' });
    };
  }

  function paint() {
    for (const b of el.querySelectorAll('[data-slot]')) {
      b.classList.toggle('sel', Number(b.dataset.slot) === slot);
    }
    if (!st) {
      q('state').textContent = 'sunucu cavab vermir';
      return;
    }
    const r = st.routes[slot];
    const rec = st.rec && st.rec.active ? st.rec : null;
    const rp = st.replay;
    const driving = !!(rp && rp.active);
    const test = testNews(rp);
    const busy = !!rec || driving;

    if (document.activeElement !== q('qr')) q('qr').value = r.qr;
    const steps = (r.to && r.to.steps) || [];
    q('scTitle').textContent = `${NAME[slot]} ssenarisi — başlanğıcdan yuva ${slot}-in xəttinə`;
    // What the rover will actually drive: same-direction moves joined into
    // one (routes.js's aggregate()), so it does not stop between them.
    const plan = r.to && r.to.plan ? r.to.plan : [];
    q('scSum').textContent = r.to
      ? `${steps.length} addım · ${(r.to.mm / 1000).toFixed(2)} m təkər · sürüləcək: `
        + `${plan.join(' → ')}`
        + (plan.length < r.to.moves ? ` (${r.to.moves} hərəkət ${plan.length}-ə birləşdi)` : '')
      : 'öyrədilməyib';
    paintSteps(r, busy);
    paintOut(r, busy);
    q('recStep').disabled = busy;
    q('addStep').disabled = busy;
    q('addFollow').disabled = busy;
    q('clearAll').disabled = busy || !r.to;
    // With an F step the whole scenario needs the camera: /follow drives it.
    q('test').disabled = busy || !r.to || !!(r.to && r.to.follow);
    // A slot with no scenario of its own has nothing to test here — its way
    // there is a neighbour's scenario plus the QR row, which only /follow can
    // drive. Said on the button, because a greyed-out ▶ read as "broken".
    q('test').title = !r.to && r.via != null
      ? `${NAME[slot]}-in öz ssenarisi yoxdur — «${NAME[slot]} YÜKÜNƏ GET» ${NAME[r.via]} ssenarisini, sonra QR sırasını sürür`
      : r.to && r.to.follow ? 'Ssenaridə F addımı var — bütövünü /follow-da «YÜKÜNƏ GET» ilə sına; tək addımları ▶ ilə'
      : '';
    q('stop').disabled = !driving;

    q('rec').hidden = !rec;
    if (rec) {
      const n = ((st.routes[rec.slot].to || {}).steps || []).length;
      const what = rec.leg === 'out' ? LEGS.out
        : rec.step == null ? `addım ${n + 1} (yeni)` : `addım ${rec.step + 1} (yenidən)`;
      q('recText').textContent = `● YAZILIR — ${NAME[rec.slot]}, ${what} · `
        + `${rec.moves} hərəkət · ${rec.secs} s`;
      q('recList').textContent = (rec.list.join(', ') || 'W A S D ilə sür…')
        + (rec.skipped ? ` (${rec.skipped} mütləq G1 atıldı)` : '');
    }
    q('state').textContent = rec ? 'yazılır'
      : driving ? (test ? 'sınaq sürülür' : 'yaddaşdan sürülür')
      : st.want ? `göndərildi: ${NAME[st.want.slot] || st.want.slot}` : 'hazır';
    q('state').style.color = rec || driving ? 'var(--stop)' : '';

    // A slot with no scenario of its own still has a way there: the nearest
    // one's scenario, then along the QR row (routes.js's via()).
    const hop = r.via != null && r.via !== slot;
    const run = q('run');
    run.textContent = `${NAME[slot]} YÜKÜNƏ GET →` + (hop ? ` ${NAME[r.via]} ssenarisi + QR sırası` : '');
    run.disabled = r.via == null || !!rec;
    run.className = r.via != null ? 'pri' : '';
    const news = !test ? ''
      : test.active ? `sınaq: ${test.route} · ${test.seg}/${test.of}`
      : test.err ? `sınaq alınmadı: ${test.err}`
      : test.aborted ? `sınaq dayandı: ${test.why || 'dayandırıldı'}`
      : test.done ? `sınaq bitdi: ${test.route}` : '';
    q('msg').textContent = msg || news
      || (hop ? `${NAME[slot]}-in öz ssenarisi yoxdur — ${NAME[r.via]} ssenarisi ilə onun xəttinə `
        + `gedəcək, sonra QR sırası ilə ${NAME[slot]}-in QR-ı altına çıxıb xəttə dönəcək.`
        : !r.to ? `Əvvəlcə bir ssenari öyrət — məs. ${NAME[slot]}, başlanğıc sahəsindən, addım-addım. `
        + 'Xətlər paraleldir: bir yuvanınkı üçünə də bəsdir.'
        : !r.out ? 'Qapı yolu öyrədilməyib — daşıma yükü götürüb xəttin başında bitəcək.'
        : driving && rp.paused ? `FASİLƏ (${rp.held}): ${rp.route} · ${rp.seg}/${rp.of} — devam gələndə qaldığı yerdən`
        : driving ? `yaddaşdan gedir: ${rp.route} · ${rp.seg}/${rp.of}`
        : '');
    q('msg').style.color = msg || (test && test.err) ? 'var(--stop)' : '';
  }

  q('steps').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-do]');
    if (!b) return;
    const i = Number(b.dataset.i);
    switch (b.dataset.do) {
      case 'test': call({ action: 'test', slot, step: i }); break;
      case 'rec': call({ action: 'record', slot, leg: 'to', step: i }); break;
      case 'up': call({ action: 'step_move', slot, step: i, by: -1 }); break;
      case 'down': call({ action: 'step_move', slot, step: i, by: 1 }); break;
      case 'del':
        if (confirm(`${NAME[slot]}: addım ${i + 1} silinsin?`)) call({ action: 'step_del', slot, step: i });
        break;
    }
  });
  for (const b of el.querySelectorAll('[data-slot]')) {
    b.onclick = () => { slot = Number(b.dataset.slot); msg = ''; paint(); };
  }
  q('recStep').onclick = () => call({ action: 'record', slot, leg: 'to' });
  q('addStep').onclick = () => {
    const key = q('key').value;
    // The speed the page drives at, so a typed step moves like a driven one —
    // the turn speed for A and D, as a held key would.
    const spin = key === 'A' || key === 'D';
    const feed = spin ? (typeof turnFeedValue === 'function' ? turnFeedValue() : undefined)
                      : (typeof feedrate === 'function' ? feedrate() : undefined);
    call({ action: 'step_add', slot, key, mm: Number(q('mm').value), feed });
  };
  q('addFollow').onclick = () => {
    const text = q('fqr').value.trim();
    if (!text) { msg = 'F addımı üçün QR mətni yaz — məs. KAPI1'; paint(); q('fqr').focus(); return; }
    call({ action: 'step_add', slot, key: 'F', qr: text });
  };
  q('fqr').addEventListener('keydown', (e) => { if (e.key === 'Enter') q('addFollow').click(); });
  q('clearAll').onclick = () => {
    if (confirm(`${NAME[slot]} ssenarisinin bütün addımları silinsin?`)) call({ action: 'clear', slot, leg: 'to' });
  };
  q('test').onclick = () => call({ action: 'test', slot });
  q('stop').onclick = () => call({ action: 'test_stop' });
  const saveQr = () => call({ action: 'qr', slot, text: q('qr').value });
  q('qr').addEventListener('change', saveQr);
  q('qr').addEventListener('keydown', (e) => { if (e.key === 'Enter') q('qr').blur(); });
  q('save').onclick = () => call({ action: 'save' });
  q('cancel').onclick = () => call({ action: 'cancel' });
  q('run').onclick = () => call({ action: 'run', slot });

  poll();
  setInterval(poll, 700);
  return { status: () => st };
}
