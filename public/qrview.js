/**
 * The QR reader's answer, on /vision.
 *
 * The page does not decode anything. The reader lives on the server (qr.js),
 * fed by the Pi's camera, because "the code in front of the rover" has to be
 * known with no page open at all — /follow's cargo run acts on it. This polls
 * /api/qr and shows what the robot has read: the text, how long ago, and where
 * in the picture it was, drawn over the video.
 *
 * Which also means it only means something while /vision is showing the Pi's
 * camera. A browser camera or a file is a different picture from the one the
 * reader is looking at, so the box is not drawn on it — a box on the wrong
 * picture would be a claim about a code nobody decoded.
 */
let qrLast = null;           // the newest /api/qr answer

function qrViewMount() {
  const el = (id) => document.getElementById(id);
  const set = (id, text) => { const e = el(id); if (e) e.textContent = text; };

  function paint(s) {
    if (!s) { set('qrState', 'sunucu cavab vermir'); return; }
    if (!s.available) {
      set('qrState', 'oxuyucu yoxdur');
      set('qrText', '–');
      set('qrMeta', s.err || 'QR oxuyucu işləmir');
      return;
    }
    const now = s.seen_age_s != null && s.seen_age_s < 1.5;
    set('qrState', now ? 'GÖRÜR' : s.text ? 'görünmür' : 'gözləyir');
    const st = el('qrState');
    if (st) st.style.color = now ? 'var(--accent)' : '';
    set('qrText', s.text || '–');
    const t = el('qrText');
    if (t) t.style.opacity = now || !s.text ? '1' : '.55';
    set('qrMeta', s.text
      ? `${s.age_s} s əvvəl oxundu · son dəfə ${s.seen_age_s} s əvvəl göründü · `
        + `${s.count} oxunuş · ${s.decodes}/${s.frames} kadr · ${s.ms} ms`
      : `${s.frames} kadra baxıldı, hələ kod yoxdur — 50 mm kodu kameraya yaxın tut`);
    const h = el('qrHist');
    if (h) {
      h.innerHTML = '';
      for (const r of (s.history || []).slice().reverse()) {
        const li = document.createElement('li');
        li.textContent = `${r.text} — ${new Date(r.at).toLocaleTimeString()}`;
        h.appendChild(li);
      }
    }
  }

  async function poll() {
    try {
      const r = await fetch('/api/qr');
      if (!r.ok) throw new Error(r.status);
      qrLast = await r.json();
    } catch {
      qrLast = null;
    }
    paint(qrLast);
  }
  poll();
  setInterval(() => { if (!document.hidden) poll(); }, 300);
}

/**
 * The code's outline on the video, if it is in shot right now.
 *
 * The corners come from the server as fractions of the whole camera frame.
 * The page draws only part of that frame (the 4:3 cut of a 1080p picture,
 * `o.crop` = src.crop() and `o.size` = src.size()), so they are mapped into
 * the cut first; mirror and 180° are the page's own transforms of the picture
 * and have to be applied to the box the same way.
 *
 * A patch the reader thought looked like a code, but could not read, is
 * drawn dashed: "the code is in shot but unreadable" is a different problem
 * from "the code is not in shot".
 */
function qrViewDraw(ctx, w, h, o = {}) {
  const s = qrLast;
  if (!o.show || !s) return;
  const [cx, cy, cw, ch] = o.crop && o.size
    ? [o.crop[0] / o.size.w, o.crop[1] / o.size.h, o.crop[2] / o.size.w, o.crop[3] / o.size.h]
    : [0, 0, 1, 1];
  const map = ([x, y]) => {
    const u = (x - cx) / cw, v = (y - cy) / ch;
    return [(o.mirrored ? 1 - u : u) * w, (o.flipped ? 1 - v : v) * h];
  };
  const readNow = s.loc && s.seen_age_s != null && s.seen_age_s <= 1;
  if (!readNow && s.cand && s.cand.age_s <= 1) {
    const [bx, by, bw, bh] = s.cand.box;
    const pts = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]].map(map);
    ctx.save();
    ctx.strokeStyle = '#d2a8ff';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  if (!readNow) return;
  const pts = s.loc.map(map);
  ctx.save();
  ctx.strokeStyle = '#d2a8ff';
  ctx.fillStyle = 'rgba(210,168,255,.18)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const top = pts.reduce((a, p) => (p[1] < a[1] ? p : a), pts[0]);
  ctx.fillStyle = '#d2a8ff';
  ctx.font = '600 13px ui-monospace,Menlo,monospace';
  ctx.fillText(`QR · ${s.text}`, Math.max(4, Math.min(w - 120, top[0])), Math.max(14, top[1] - 8));
  ctx.restore();
}
