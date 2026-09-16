/**
 * The radar card: what the lidar sees, drawn round the rover.
 *
 * radar.js on the server listens on port 8443 and keeps one distance per
 * degree; the status frame carries it (`radar`) ten times a second. This file
 * only draws: the rover in the middle with its nose up, rings every so many
 * metres, and each degree's return as a wedge out to whatever it hit. Near is
 * red, close is amber, the rest is green — the dashboard's own three colours.
 *
 * The offset and the direction are the server's (POST /api/radar), because
 * the nearest-obstacle figure and anything else that reads the scan should
 * agree with the picture.
 */
const RADAR_RANGES = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 25, 40];    // metres
const RADAR_NEAR = 300, RADAR_MID = 800;                              // mm
const RADAR_COLOURS = ['#f85149', '#d29922', '#3fb950'];

function radarMount(el) {
  el.innerHTML = `
    <div class="row" style="flex-wrap:wrap">
      <h2 style="margin:0">Radar — lidar</h2>
      <span class="muted" data-r="state">–</span>
    </div>
    <canvas data-r="cv" width="720" height="720"
      style="width:100%;max-width:560px;display:block;margin:12px auto 0;aspect-ratio:1;
             border-radius:12px;background:#0b0e13"></canvas>
    <div class="maptools" style="margin-top:10px">
      <label>Menzil
        <select data-r="range">
          <option value="auto">otomatik</option>
          ${RADAR_RANGES.map((m) => `<option value="${m}">${m} m</option>`).join('')}
        </select>
      </label>
      <label>Açı kaydırma
        <input type="number" data-r="offset" step="1" value="0"
          style="width:5.5em;font:13px inherit;color:var(--ink);background:var(--panel);
                 border:1px solid var(--line);border-radius:9px;padding:7px 8px"> °
      </label>
      <label><input type="checkbox" data-r="ccw"> ters yön</label>
      <label title="iPhone taramasının genişliği: 330°–30° = 60°">FOV
        <input type="number" data-r="fov" min="5" max="170" step="1" value="60"
          style="width:4.8em;font:13px inherit;color:var(--ink);background:var(--panel);
                 border:1px solid var(--line);border-radius:9px;padding:7px 8px"> °
      </label>
      <button data-r="zero" title="Telefon rover'ın önüne bakarken bas">Bu yön = ön</button>
    </div>
    <div class="kv" style="margin-top:12px">
      <div><span class="lbl">Kaynak</span><b data-r="src" class="sm">–</b></div>
      <div><span class="lbl">Biçim</span><b data-r="fmt" class="sm">–</b></div>
      <div><span class="lbl">Nokta / sn</span><b data-r="rate" class="sm">–</b></div>
      <div><span class="lbl">Tur</span><b data-r="hz" class="sm">–</b></div>
      <div><span class="lbl">En yakın</span><b data-r="near" class="sm">–</b></div>
      <div><span class="lbl">Paket</span><b data-r="pk" class="sm">–</b></div>
    </div>
    <div class="muted" data-r="note" style="margin-top:10px;font-size:12.5px">–</div>
    <details data-r="rawBox" style="margin-top:8px">
      <summary class="muted" style="cursor:pointer;font-size:12.5px">Gelen ham veri</summary>
      <pre data-r="raw" class="mono" style="font-size:11.5px;white-space:pre-wrap;word-break:break-all;
        margin:8px 0 0;max-height:170px;overflow:auto">–</pre>
    </details>`;
  const q = (k) => el.querySelector(`[data-r="${k}"]`);
  let st = null;
  let range = 'auto';
  try { range = localStorage.getItem('radarRange') || 'auto'; } catch { /* a private window */ }
  if (![...q('range').options].some((o) => o.value === range)) range = 'auto';
  q('range').value = range;

  q('range').addEventListener('change', (e) => {
    range = e.target.value;
    try { localStorage.setItem('radarRange', range); } catch { /* per-viewer only */ }
    radarDraw(q('cv'), st, range);
  });

  async function send(body) {
    try {
      const r = await fetch('/api/radar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status);
      paint(j);
    } catch (e) {
      q('state').textContent = 'xəta: ' + e.message;
    }
  }
  q('offset').addEventListener('change', (e) => send({ offset: Number(e.target.value) || 0 }));
  q('ccw').addEventListener('change', (e) => send({ ccw: e.target.checked }));
  q('fov').addEventListener('change', (e) => send({ fov: Number(e.target.value) }));
  q('zero').addEventListener('click', () => send({ zero: true }));

  const fmt = (v, n = 1) => (v == null || !Number.isFinite(Number(v)) ? '–' : Number(v).toFixed(n));
  const FMT = { ld06: 'LD06 ikili', scn1: 'iPhone SCN1', json: 'JSON', text: 'metin',
                'binary?': 'tanınmadı' };

  function paint(s) {
    st = s;
    radarDraw(q('cv'), s, range);
    if (!s) { q('state').textContent = 'sunucu radar göndermiyor'; return; }

    const live = s.age_s != null && s.age_s <= 2;
    q('state').textContent = !s.on ? 'kapalı (--no-radar)'
      : !s.udp && !s.tcp ? 'port açılamadı'
      : s.age_s == null ? `:${s.port} dinleniyor — veri yok`
      : !live ? `veri kesildi · ${fmt(s.age_s, 0)} sn önce`
      : `canlı · ${s.fresh}° dolu`;
    q('state').style.color = !s.on || (!s.udp && !s.tcp) ? 'var(--stop)'
      : live ? 'var(--accent)' : s.age_s != null ? 'var(--warn)' : '';

    q('src').textContent = s.from ? `${s.via} ${s.from}` : '–';
    q('fmt').textContent = s.fmt ? `${FMT[s.fmt] || s.fmt}${s.unit ? ' · ' + s.unit : ''}` : '–';
    q('rate').textContent = live ? String(s.pts_s) : '–';
    q('hz').textContent = s.scan_hz != null && live
      ? `${fmt(s.scan_hz, s.scan_hz < 2 ? 2 : 1)} tur/sn` : '–';
    q('near').textContent = s.near ? `${fmt(s.near.d / 1000, 2)} m · ${fmt(s.near.a, 0)}°` : '–';
    q('near').className = 'sm ' + (s.near && s.near.d < RADAR_NEAR ? 'bad'
      : s.near && s.near.d < RADAR_MID ? 'warnc' : '');
    q('pk').textContent = `${s.packets} · ${(s.bytes / 1024).toFixed(0)} KB`;

    const o = q('offset');
    if (document.activeElement !== o) o.value = s.offset;
    q('ccw').checked = !!s.ccw;
    const fv = q('fov');
    if (s.fov != null && document.activeElement !== fv) fv.value = s.fov;

    // An iPhone frame with nothing in it is still a frame read right.
    const unknown = s.packets > 0 && (s.fmt === 'binary?' || (s.points === 0 && s.fmt !== 'scn1'));
    const bits = [];
    if (s.err) bits.push(s.err + '.');
    if (s.tls_err) bits.push(s.tls_err + '.');
    if (unknown) bits.push('Veri geliyor ama biçimi tanınmadı — aşağıdaki ham baytlara bak.');
    const weak = s.fmt === 'scn1' && s.pose && s.pose.quality != null && s.pose.quality < 0.9;
    if (weak) bits.unshift(`ARKit izleme zayıf (${fmt(s.pose.quality, 1)}) — telefon çok hızlı dönüyor, `
      + 'dilimler yanlış yere düşebilir: lidar motorunun gerilimini düşür.');
    if (s.fmt === 'scn1') bits.push(`iPhone bir anda ${s.fov}° görür; motor döndükçe her dilim telefonun `
      + 'o anki yönüne yerleşir, tam tur 360°\'yi doldurur. "Bu yön = ön": telefon rover\'ın önüne '
      + 'bakarken bas.');
    bits.push(`Cihaz Pi'ye ${s.port} portuna göndermeli: UDP, TCP, HTTP POST, WebSocket `
      + `(TLS ile de); JSON, "açı,mesafe" satırları ya da LD06/LD19 paketleri. `
      + 'Açı rover\'ın önünden saat yönünde; lidar döndürülmüş takılıysa açıyı kaydır.');
    q('note').textContent = bits.join(' ');
    q('note').style.color = s.err || unknown || weak ? 'var(--warn)' : '';

    q('raw').textContent = (s.raw || []).length
      ? s.raw.slice().reverse().map((r) => `${new Date(r.at).toLocaleTimeString()}  ${r.via} ${r.from}  `
          + `${r.len} B → ${r.pts} nokta\n${r.hex}\n${r.text}`).join('\n\n')
      : 'henüz hiçbir şey gelmedi';
    if (unknown && !q('rawBox').dataset.opened) {
      q('rawBox').open = true;
      q('rawBox').dataset.opened = '1';
    }
  }

  return { paint, status: () => st };
}

/**
 * One frame. `sel` is the range in metres, or 'auto': the smallest step that
 * holds 95 % of the returns, so one far wall does not shrink the rest.
 */
function radarDraw(cv, s, sel) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 36;
  const scan = (s && s.scan) || [];
  const n = scan.length || 360;
  const rad = (deg) => (deg - 90) * Math.PI / 180;      // nose up, clockwise

  let maxM = Number(sel);
  if (!(maxM > 0)) {
    const ds = scan.filter((d) => d > 0).sort((a, b) => a - b);
    const want = ds.length ? ds[Math.floor((ds.length - 1) * 0.95)] / 1000 * 1.1 : 4;
    maxM = RADAR_RANGES.find((m) => m >= want) || RADAR_RANGES[RADAR_RANGES.length - 1];
  }
  const px = R / (maxM * 1000);                         // pixels per mm

  g.clearRect(0, 0, W, H);
  g.fillStyle = '#0b0e13';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#0f1720';
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();

  // ── rings and spokes ──
  const ring = [0.1, 0.25, 0.5, 1, 2, 5, 10].find((v) => v >= maxM / 5) || 10;
  g.strokeStyle = '#243040'; g.lineWidth = 1.5;
  g.font = '600 15px ui-monospace, Menlo, monospace';
  g.fillStyle = '#6e7b8a'; g.textAlign = 'left'; g.textBaseline = 'bottom';
  for (let m = ring; m <= maxM + 1e-9; m += ring) {
    const r = m * 1000 * px;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    g.fillText(`${+m.toFixed(2)} m`, cx + r * 0.71 + 4, cy - r * 0.71 - 2);
  }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 30) {
    const a = rad(d);
    g.strokeStyle = d === 0 ? '#3a4a5c' : '#1d2733';
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
    g.fillStyle = d === 0 ? '#ffa657' : '#6e7b8a';
    g.fillText(d === 0 ? 'ön' : `${d}°`, cx + Math.cos(a) * (R + 20), cy + Math.sin(a) * (R + 20));
  }

  // ── the returns: a wedge per degree, a dot where it hit ──
  const fills = [new Path2D(), new Path2D(), new Path2D()];
  const dots = [new Path2D(), new Path2D(), new Path2D()];
  let any = false;
  for (let i = 0; i < n; i++) {
    const d = scan[i];
    if (!d) continue;
    any = true;
    const c = d < RADAR_NEAR ? 0 : d < RADAR_MID ? 1 : 2;
    const r = Math.min(d * px, R);
    const a0 = rad(i * 360 / n), a1 = rad((i + 1) * 360 / n);
    fills[c].moveTo(cx, cy); fills[c].arc(cx, cy, r, a0, a1); fills[c].closePath();
    if (d * px <= R) {
      const am = (a0 + a1) / 2, x = cx + Math.cos(am) * r, y = cy + Math.sin(am) * r;
      dots[c].moveTo(x + 3.2, y); dots[c].arc(x, y, 3.2, 0, Math.PI * 2);
    }
  }
  g.globalAlpha = 0.17;
  fills.forEach((p, k) => { g.fillStyle = RADAR_COLOURS[k]; g.fill(p); });
  g.globalAlpha = 1;
  dots.forEach((p, k) => { g.fillStyle = RADAR_COLOURS[k]; g.fill(p); });

  // ── the sweep: where the last return came from ──
  const live = s && s.age_s != null && s.age_s <= 2;
  if (live && s.last_a != null) {
    const a = rad(s.last_a);
    const grad = g.createLinearGradient(cx, cy, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    grad.addColorStop(0, 'rgba(63,185,80,0)');
    grad.addColorStop(1, 'rgba(63,185,80,.85)');
    g.strokeStyle = grad; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
  }

  // ── the nearest thing ──
  if (s && s.near && s.near.d * px <= R) {
    const a = rad(s.near.a), r = s.near.d * px;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    g.strokeStyle = '#ffffff'; g.lineWidth = 2;
    g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#ffffff'; g.font = '600 15px ui-monospace, Menlo, monospace';
    g.textAlign = x > cx ? 'right' : 'left'; g.textBaseline = 'middle';
    g.fillText(`${(s.near.d / 1000).toFixed(2)} m`, x + (x > cx ? -16 : 16), y);
  }

  // ── the rover, nose up ──
  g.fillStyle = '#ffa657';
  g.beginPath();
  g.moveTo(cx, cy - 15); g.lineTo(cx + 10, cy + 11); g.lineTo(cx, cy + 6); g.lineTo(cx - 10, cy + 11);
  g.closePath(); g.fill();

  g.font = '600 15px ui-monospace, Menlo, monospace';
  g.fillStyle = '#8b949e'; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillText(`menzil ${maxM} m`, 14, 12);
  if (!any) {
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.font = '600 18px ui-sans-serif, system-ui, sans-serif';
    g.fillText(!s ? 'radar verisi yok'
      : s.age_s == null ? `veri bekleniyor — :${s.port}` : 'son taramada nokta yok',
      cx, H - 10);
  }
}

/**
 * The room map's card: every return the radar has had, in 5 cm cells round
 * the phone, drawn by how often each was hit. The radar forgets in seconds;
 * this keeps. A wall is hit turn after turn and a hand going past once, so the
 * room is what is left when cells hit only once or twice are not drawn.
 */
function roomMount(el) {
  el.innerHTML = `
    <div class="row" style="flex-wrap:wrap">
      <h2 style="margin:0">Oda haritası — iPhone LiDAR</h2>
      <span class="muted" data-m="state">–</span>
    </div>
    <canvas data-m="cv" width="720" height="720"
      style="width:100%;max-width:560px;display:block;margin:12px auto 0;aspect-ratio:1;
             border-radius:12px;background:#0b0e13"></canvas>
    <div class="maptools" style="margin-top:10px">
      <label>En az
        <select data-m="min">
          ${[1, 2, 3, 5, 10].map((n) => `<option value="${n}">${n} isabet</option>`).join('')}
        </select>
      </label>
      <button data-m="clear">Temizle</button>
    </div>
    <div class="kv" style="margin-top:12px">
      <div><span class="lbl">Nokta</span><b data-m="pts" class="sm">–</b></div>
      <div><span class="lbl">Hücre</span><b data-m="cells" class="sm">–</b></div>
      <div><span class="lbl">Toplanıyor</span><b data-m="since" class="sm">–</b></div>
    </div>
    <p class="muted" style="margin:10px 0 0;font-size:12.5px">Telefon motorla döndükçe her dönüşün
      noktaları buraya eklenir, silinmez: duvarlar her turda yeniden vurulur, geçen bir el bir kez.
      "En az" o kadar vurulmamış hücreleri gizler. Telefonun yeri pakette yok — harita telefonun
      bir yerde döndüğünü varsayar; rover hareket ederse Temizle.</p>`;
  const q = (k) => el.querySelector(`[data-m="${k}"]`);
  let map = null, minHits = 3;
  try { minHits = Number(localStorage.getItem('roomMin')) || 3; } catch { /* per-viewer only */ }
  q('min').value = String(minHits);
  q('min').addEventListener('change', (e) => {
    minHits = Number(e.target.value) || 1;
    try { localStorage.setItem('roomMin', String(minHits)); } catch { /* per-viewer only */ }
    paint();
  });
  q('clear').addEventListener('click', async () => {
    try {
      await fetch('/api/radar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ clear: true }) });
    } catch { /* the next poll says whether it worked */ }
    poll();
  });

  async function poll() {
    try {
      const r = await fetch('/api/radar/map', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      map = await r.json();
      paint();
    } catch {
      q('state').textContent = 'sunucu cevap vermiyor';
    }
  }

  function paint() {
    const shown = roomDraw(q('cv'), map, minHits);
    if (!map) return;
    const total = map.cells.length / 3;
    q('state').textContent = map.pts ? `${shown} hücre çiziliyor` : 'boş';
    q('pts').textContent = String(map.pts);
    q('cells').textContent = `${shown} / ${total}`;
    const s = Math.max(0, Math.round((Date.now() - map.since) / 1000));
    q('since').textContent = s < 120 ? `${s} sn` : `${Math.round(s / 60)} dk`;
  }

  poll();
  setInterval(poll, 1000);
  return { poll };
}

/** The room, top-down, nose up. Returns how many cells were drawn. */
function roomDraw(cv, m, minHits) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 24;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#0b0e13';
  g.fillRect(0, 0, W, H);

  const c = (m && m.cells) || [];
  const pick = [];
  for (let i = 0; i < c.length; i += 3) {
    if (c[i + 2] < minHits) continue;
    pick.push((c[i] - m.half + 0.5) * m.cell, (c[i + 1] - m.half + 0.5) * m.cell, c[i + 2]);
  }
  const ext = [];
  for (let i = 0; i < pick.length; i += 3) ext.push(Math.max(Math.abs(pick[i]), Math.abs(pick[i + 1])));
  ext.sort((a, b) => a - b);
  const want = ext.length ? ext[Math.floor((ext.length - 1) * 0.98)] / 1000 * 1.1 : 4;
  const maxM = RADAR_RANGES.find((v) => v >= want) || RADAR_RANGES[RADAR_RANGES.length - 1];
  const px = R / (maxM * 1000);

  // ── squares, so a wall's length can be read off ──
  const step = [0.25, 0.5, 1, 2, 5].find((v) => v >= maxM / 6) || 5;
  g.strokeStyle = '#1d2733'; g.lineWidth = 1;
  for (let v = -Math.floor(maxM / step) * step; v <= maxM + 1e-9; v += step) {
    const o = v * 1000 * px;
    g.beginPath();
    g.moveTo(cx + o, cy - R); g.lineTo(cx + o, cy + R);
    g.moveTo(cx - R, cy - o); g.lineTo(cx + R, cy - o);
    g.stroke();
  }

  // ── the cells: brighter for more hits ──
  const COL = ['#1f6f3a', '#2f9a4f', '#3fb950', '#9be9a8'];
  const lv = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  const sz = Math.max(2, m ? m.cell * px : 2);
  const top = Math.log(Math.max(2, (m && m.max) || 2));
  let shown = 0;
  for (let i = 0; i < pick.length; i += 3) {
    const x = cx + pick[i] * px, y = cy - pick[i + 1] * px;
    if (Math.abs(x - cx) > R || Math.abs(y - cy) > R) continue;
    const k = Math.min(3, Math.floor(Math.log(pick[i + 2]) / top * 4));
    lv[k].rect(x - sz / 2, y - sz / 2, sz, sz);
    shown++;
  }
  lv.forEach((p, k) => { g.fillStyle = COL[k]; g.fill(p); });

  // ── the phone, where it turns ──
  g.fillStyle = '#ffa657';
  g.beginPath();
  g.moveTo(cx, cy - 13); g.lineTo(cx + 9, cy + 10); g.lineTo(cx, cy + 5); g.lineTo(cx - 9, cy + 10);
  g.closePath(); g.fill();

  g.font = '600 15px ui-monospace, Menlo, monospace';
  g.fillStyle = '#8b949e'; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillText(`1 kare = ${step} m`, 12, 10);
  g.textAlign = 'center';
  g.fillStyle = '#ffa657';
  g.fillText('ön', cx, 10);
  if (!shown) {
    g.fillStyle = '#8b949e'; g.textBaseline = 'bottom';
    g.font = '600 18px ui-sans-serif, system-ui, sans-serif';
    g.fillText(!m ? 'harita verisi yok'
      : m.pts ? `en az ${minHits} isabet alan hücre yok henüz` : 'boş — iPhone ve lidar motoru çalışınca dolar',
      cx, H - 10);
  }
  return shown;
}
