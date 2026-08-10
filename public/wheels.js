/**
 * The wheel trim — one set of numbers, every page.
 *
 * The trim (dead band and gain, per pin) is not a property of the /follow page.
 * It is a property of the robot: the same two motors are driven from /manual,
 * /drive and /follow, and a number measured on one of them is true on all of
 * them. Keeping it in one place is the difference between "the robot pulls
 * left" being a fact you fix once and a fact you rediscover on every page.
 *
 * It lives in the server's follow_cfg, which is already persisted to disk and
 * already broadcast in every status frame — so a page does not fetch it, it
 * just receives it. Change it on /setup and the page you were about to open is
 * already right.
 *
 * This file is deliberately free of DOM at the bottom half and free of logic at
 * the top: `wheelsOf`, `wheelPin` and `wheelsSteps` are pure and tested in
 * test/test_wheels.mjs; `wheelsMount` is the only thing that touches a page.
 */

const WHEEL_KEYS = ['stall', 'stall25', 'stall26', 'gain25', 'gain26', 'swap',
                    'vmaxV', 'calib'];

const WHEELS_FALLBACK = {
  stall:   22,     // shared dead band, % of the ceiling
  stall25: null,   // per-pin override; null = use the shared one
  stall26: null,
  gain25:  1,
  gain26:  1,
  swap:    false,
};

const wclamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Number(null) is 0 and Number.isFinite(0) is true, so "not set" has to be
// tested for before the conversion, not after it. Getting this wrong turns an
// unmeasured dead band into a dead band of zero, which is silently worse than
// no compensation at all.
const wnum = (v, d) => (v === null || v === undefined || v === ''
  || !Number.isFinite(Number(v)) ? d : Number(v));

/**
 * Pull the wheel trim out of whatever the server sent.
 *
 * Accepts the whole follow_cfg, its `.pilot` half, or a bare trim object, so a
 * page can hand over the status frame without knowing the shape.
 */
function wheelsOf(cfg) {
  const src = (cfg && cfg.pilot) ? cfg.pilot : (cfg || {});
  const w = { ...WHEELS_FALLBACK };
  w.stall = wclamp(wnum(src.stall, WHEELS_FALLBACK.stall), 0, 99);
  // A per-pin threshold of 0 means "no override" everywhere in this project —
  // the sliders bottom out there — so it is stored as null, not as zero.
  const per = (v) => {
    const n = wnum(v, 0);
    return n > 0 ? wclamp(n, 0, 99) : null;
  };
  w.stall25 = per(src.stall25);
  w.stall26 = per(src.stall26);
  w.gain25 = wclamp(wnum(src.gain25, 1), 0.5, 1.5);
  w.gain26 = wclamp(wnum(src.gain26, 1), 0.5, 1.5);
  w.swap = !!src.swap;
  return w;
}

/** The dead band this pin actually uses, after the override. */
function wheelThreshold(pin, w) {
  const t = wheelsOf(w);
  const own = pin === 26 ? t.stall26 : t.stall25;
  return own === null ? t.stall : own;
}

/**
 * Demand → the percentage that reaches the pin, for ONE pin.
 *
 * The same mapping /follow drives with, so that typing 40 on /manual and
 * letting the pilot ask for 40 put the same voltage on the same wire. Without
 * this the manual page is measuring a different robot than the one that drives.
 */
function wheelPin(demand, pin, w) {
  const t = wheelsOf(w);
  const gain = pin === 26 ? t.gain26 : t.gain25;
  const d = wclamp(wnum(demand, 0) * gain, 0, 100);
  if (d <= 0) return 0;
  const s = wheelThreshold(pin, t);
  return Math.round((s + (d * (100 - s)) / 100) * 10) / 10;
}

/** Percentage of the ceiling → volts, for the readouts. */
function wheelVolts(pct, vmax) {
  const v = wnum(vmax, 3.3);
  return Math.round((wclamp(wnum(pct, 0), 0, 100) / 100) * v * 100) / 100;
}

/**
 * Is this trim measured, or is it still the factory guess?
 *
 * Worth distinguishing loudly: a default that happens to be close is the most
 * expensive kind of wrong, because it drives well enough that you stop
 * suspecting it and start blaming the steering gains.
 */
function wheelsMeasured(w) {
  const t = wheelsOf(w);
  return t.stall25 !== null && t.stall26 !== null;
}

/**
 * The checklist behind /setup.
 *
 * Ordered so that each step is only meaningful once the one above it is done —
 * a gain measured against a wrong dead band is not a measurement, it is a
 * number that happens to work at one speed.
 */
function wheelsSteps(w) {
  const t = wheelsOf(w);
  const both = t.stall25 !== null && t.stall26 !== null;
  const trimmed = t.gain25 !== 1 || t.gain26 !== 1;
  return [
    {
      id: 'dac',
      n: 1,
      title: 'İki pinin gerilimini eşitle',
      where: '/pins',
      done: null,          // only you can see a multimeter — see `manual`
      manual: true,
      what: 'GPIO25 ve GPIO26ya 255 ver, ikisini de multimetreyle ölç.',
      then: 'Fark 0.05 Vtan fazlaysa, ws_dac.inodaki DAC25_AT_255 ve '
          + 'DAC26_AT_255 sabitlerine kendi ölçtüğün sayıları yaz ve yeniden yükle.',
      why: 'Bu adım pinleri eşitler — tekerleri değil. Atlayabilirsin; '
         + 'düz gitmek için 3. adım yeterli.',
    },
    {
      id: 'stall25',
      n: 2,
      title: 'GPIO25 — teker yüzde kaçta dönmeye başlıyor',
      where: '/manual',
      done: t.stall25 !== null,
      value: t.stall25,
      unit: '%',
      what: 'Robotu kaldır. Yalnız GPIO25e yüzde ver, 0dan birer birer yükselt.',
      then: 'Tekerin ilk döndüğü sayıyı yaz.',
      why: 'Bunun altı «yavaş» değil, «durmuş»tur. Loglarda bir sürüşte '
         + 'komutların 91 %-i bu ölü bölgedeydi — hareket komutu verilir, teker dönmez.',
    },
    {
      id: 'stall26',
      n: 3,
      title: 'GPIO26 — teker yüzde kaçta dönmeye başlıyor',
      where: '/manual',
      done: t.stall26 !== null,
      value: t.stall26,
      unit: '%',
      what: 'Aynı şey, bu kez yalnız GPIO26.',
      then: 'İkinci sayıyı yaz. İki motorda 2–5 % fark normaldir.',
      why: 'İki motor hiçbir zaman aynı motor değildir. Ortak bir sayı ikisi için de '
         + 'yanlış olur — biri hâlâ duruyor, öteki çoktan hızlanıyor.',
    },
    {
      id: 'gain',
      n: 4,
      title: 'Düz gitme — güç düzeltmesi',
      where: '/manual',
      done: both ? trimmed : null,
      value: `${t.gain25.toFixed(2)} / ${t.gain26.toFixed(2)}`,
      blocked: !both,
      what: 'Robotu yere koy, iki pine de aynı yüzdeyi (40) ver, bırak.',
      then: 'Saptığı tarafın TERS tekeri hızlıdır. O tekerin gücünü '
          + '1.00dan 0.95e, sonra 0.90a indir — düz gidene kadar.',
      why: 'Yavaş tekeri yükseltme, hızlıyı azalt: yukarı çıkarsa tavana '
         + 'dayanır ve virajda düzeltmeye yer kalmaz.',
    },
    {
      id: 'metres',
      n: 5,
      title: 'Mesafe kalibrasyonu',
      where: '/follow',
      done: null,
      manual: true,
      what: 'Bilinen bir yüzdede (örneğin 40) bilinen bir mesafeyi (2 m) sür, saniyeyi tut.',
      then: '/follow → Kalibrasyon kartına yüzdeyi, metreyi ve saniyeyi yaz.',
      why: 'Bu olmadan loglar hızı yüzdeyle yazar, metreyle değil — «bu tur 11 m '
         + 'idi» diyemezsin.',
    },
    {
      id: 'closed',
      n: 6,
      title: 'Kapalı çevrim — hız gerilime bağlı olmasın',
      where: '/setup',
      done: null,
      manual: true,
      blocked: !both,
      what: 'Motorun hall sensör kablolarını ESP32ye bağla, sonra her tekeri '
          + '100 %-de sür ve darbe frekansını (Hz) yaz.',
      then: 'Bundan sonra sistem gerilimi kendi yükseltip indirir; batarya '
          + 'boşalsa da hız aynı kalır.',
      why: 'Yukarıdaki bütün düzeltmeler BUGÜNÜN bataryasına ve BU zemine '
         + 'aittir. Yalnızca ölçüm onları kalıcı yapar.',
    },
  ];
}

/** Short lines for the strip at the top of every page. */
function wheelsSummary(w) {
  const t = wheelsOf(w);
  const s = (v) => (v === null ? `${t.stall} %*` : `${v} %`);
  return [
    `GPIO25 · eşik ${s(t.stall25)} · güç ${t.gain25.toFixed(2)}`,
    `GPIO26 · eşik ${s(t.stall26)} · güç ${t.gain26.toFixed(2)}`,
  ];
}

/**
 * The explanations behind every ⓘ.
 *
 * Written as "what it is / how you get it / when to touch it", because the
 * question a slider actually raises is never "what does this mean" on its own —
 * it is "am I the person who should be moving this right now".
 */
const INFO = {
  stall: ['Dönme eşiği (genel)',
    'Tekerin dönmeye başladığı yüzde. Bunun altı yavaş değil, durmuş demektir.',
    'Ölç: /manualda yüzdeyi 0dan birer birer yükselt, ilk döndüğü anı yaz.',
    'Pin başına eşikler girilmişse bu kullanılmaz.'],
  stall25: ['GPIO25 — dönme eşiği',
    'Yalnız bu pinin kendi eşiği. 0 = genel eşiği kullan.',
    'Ölç: /manualda yalnız GPIO25e yüzde ver.',
    'İki motorda 2–5 % fark normaldir — düzeltilmezse düşük hızda robot sapar.'],
  stall26: ['GPIO26 — dönme eşiği',
    'Yalnız bu pinin kendi eşiği. 0 = genel eşiği kullan.',
    'Ölç: /manualda yalnız GPIO26ya yüzde ver.',
    'İki motorda 2–5 % fark normaldir.'],
  gain25: ['GPIO25 — güç düzeltmesi',
    'Bu tekere giden talebi çarpar. 1.00 = dokunma.',
    'Ölç: iki pine de aynı yüzdeyi ver, saptığı tarafın ters tekerini azalt.',
    'En son kullan — önce eşikleri düzelt. Hızlıyı azalt, yavaşı yükseltme.'],
  gain26: ['GPIO26 — güç düzeltmesi',
    'Bu tekere giden talebi çarpar. 1.00 = dokunma.',
    'Ölç: iki pine de aynı yüzdeyi ver, saptığı tarafın ters tekerini azalt.',
    'En son kullan. Hızlıyı azalt, yavaşı yükseltme.'],
  swap: ['Tarafları değiştir',
    'GPIO26 sol tekeri sürüyorsa devreye al.',
    'Dene: /drivede Aya bas — robot sola dönmeli.',
    'Robot virajı ters alıyorsa sebebi budur, kP değil.'],
  base:  ['Taban hız',
    'Düz yolda giden talep. Her şey bundan kesilir.',
    'Ölü bölgenin üstünde olmalı — yanındaki volt değerine bak.',
    'Robot ağır dönüyorsa önce bunu azalt, kPyi yükseltme.'],
  kP: ['Direksiyon gücü',
    'Hatadan direksiyona çevirme katsayısı.',
    'Yükselt: robot virajı geç alıyorsa. İndir: düz yolda salınıyorsa.',
    'Salınım varsa önce kDyi yükselt, sonra kPyi indir.'],
  kD: ['İleri bakış (saniye)',
    'Hatanın kaç saniye sonraki yerine göre sürmek.',
    'Salınımı söndürür.',
    'Çok yükseltirsen hareket kesik kesik olur — kamera gürültüsü büyütülür.'],
  curve: ['Virajda yavaşlama',
    'Viraj ne kadar keskinse hız o kadar kesilir.',
    '1.00 = tam virajda tam durma.',
    'Robot virajda yoldan çıkıyorsa bunu yükselt — kPyi değil.'],
  hard: ['Kurtarma eşiği',
    'Bu hatadan sonra ileri gitmek durumu kötüleştirir.',
    'Robot yerinde dönüp yola yönelir.',
    'Çok sık devreye giriyorsa basei azalt.'],
  gear: ['İki sabit hız',
    'NORMAL ve HIZLI — aynı anda yalnız biri. Seçilen hız pinlere doğrudan '
    + 'kendi DAC sayısını verir.',
    'Kullan: ARM, sonra hızı seç. W/A/S/D basmak hızı kapatır — el her zaman '
    + 'üstündür.',
    'Ham çıkış: dönme eşiği, güç düzeltmesi ve master level buna UYGULANMAZ '
    + '— yazdığın sayı pine giden sayıdır.'],
  gearDac: ['Hızın DAC sayısı',
    'Pinin aldığı 0-255 sayısı: dac = V / 3.3 × 255. 124 ≈ 1.60 V, 241 ≈ 3.12 V.',
    'Ölç: /manualda yüzdeyi yükselt, tekerin gittiği hızı beğendiğinde yanındaki '
    + 'DAC sayısını buraya yaz.',
    '77nin altı boşa gider — 1.00 V idledır, onun altına hiçbir zaman '
    + 'inmez. İki pinin sayısı 2-3 farklı olabilir: motorlar aynı değil.'],
  vmax: ['100 % ne demek',
    'Sunucunun --v-max değeri. 100 % = bu gerilim.',
    'ESP32 için 3.3 V.',
    'Bütün yüzdeler bu tavana göredir.'],
  closed: ['Kapalı çevrim',
    'Tekerin gerçek hızını ölçüp gerilimi ona göre düzeltir.',
    'Motorun hall sensörü gerekir.',
    'Devredeyse gain düzeltmeleri artık kritik değil — çevrim kendi tutar.'],
  dac: ['İki DAC kanalını eşitlemek',
    'ESP32nin GPIO25 ve GPIO26 kanalları aynı koda biraz farklı gerilim verir.',
    'Ölç: ikisine de 255 ver, multimetreyle oku, ws_dac.inodaki sabitlere yaz.',
    'Bu pinleri eşitler, tekerleri değil — düz gitmek için güç düzeltmesi gerekir.'],
  metres: ['Mesafe kalibrasyonu',
    'Yüzdeden metreye çevirme sabiti. Bu robotta enkoder yok, bu yüzden elle ölçülür.',
    'Ölç: bilinen bir yüzdede bilinen bir mesafeyi sür, saniyeyi tut.',
    'Yalnızca loglar için — navigasyon için değil.'],
  raw: ['Bu sayfa ham yüzde gönderir',
    'Aşağıdaki ayarlar burada UYGULANMAZ — ne yazarsan pine o gider.',
    'Bilerek böyle: dönme eşiği tam burada ölçülür.',
    'Ayarların uygulandığı yer /followdur.'],
  hzFull: ['Tam hızda frekans',
    '100 % talepte bu tekerin verdiği darbe/saniye.',
    'Ölç: tekeri 100 %-de sür, Hz okumasını yaz.',
    'Bu ölçülmemişse kapalı çevrim devreye girmez — sistem açık çevrimde kalır.'],
};

// ── page furniture ────────────────────────────────────────────────────
// Everything below needs a DOM. Guarded so the file can be require()d in tests.

const WHEELS_CSS = `
.wtrim{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:10px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.wtrim b{color:var(--ink);font-weight:600}
.wtrim .wsep{flex:1}
.wtrim a{color:var(--idle);text-decoration:none;font-family:inherit}
.wtrim.warn{border-color:var(--warn)}
.wtrim .wtag{font:11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.8px;
  text-transform:uppercase;color:var(--dim)}
.wtrim.warn .wtag{color:var(--warn)}
.i{display:inline-flex;align-items:center;justify-content:center;width:15px;
  height:15px;border-radius:50%;border:1px solid var(--line);color:var(--dim);
  font:600 10px/1 ui-sans-serif,system-ui,sans-serif;cursor:help;
  vertical-align:middle;margin-left:5px;flex:none;user-select:none}
.i:hover,.i:focus{border-color:var(--idle);color:var(--idle);outline:none}
.itip{position:fixed;z-index:50;max-width:290px;background:var(--panel);
  border:1px solid var(--line);border-radius:10px;padding:10px 12px;
  box-shadow:0 8px 26px rgba(0,0,0,.42);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;
  color:var(--ink)}
.itip h4{margin:0 0 6px;font-size:12px;letter-spacing:.7px;text-transform:uppercase;
  color:var(--dim);font-weight:600}
.itip p{margin:0 0 5px}
.itip p:last-child{margin:0;color:var(--dim)}
`;

/**
 * The trim, for a page with no websocket of its own (/vision, /tune).
 *
 * Opening a second socket just to read four numbers would be worse than an
 * HTTP call: the server counts connected clients and uses that count to decide
 * whether anyone is still holding the dead-man.
 */
function wheelsFetch() {
  return fetch('/api/wheels', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
}

/** `<span class="i">` for a key in INFO. Safe to inline into a template. */
function infoHtml(key) {
  return INFO[key] ? `<span class="i" tabindex="0" data-info="${key}">i</span>` : '';
}

/**
 * Put a ⓘ next to controls that already exist.
 *
 * Done at runtime rather than by editing every label because the alternative is
 * the same explanation copied into five pages, where four of them go stale the
 * first time the meaning of a slider changes.
 *
 * @param map  { inputElementId: INFO key }
 */
function wheelsAnnotate(map) {
  if (typeof document === 'undefined') return;
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (!el || !INFO[key]) continue;
    const box = el.closest('.sl, .field, .card, label') || el.parentElement;
    const label = box && (box.querySelector('.muted, label, .lbl') || box.firstElementChild);
    if (!label || label.querySelector('.i')) continue;
    label.insertAdjacentHTML('beforeend', infoHtml(key));
  }
}

function wheelsMount(opts = {}) {
  if (typeof document === 'undefined') return null;

  const style = document.createElement('style');
  style.textContent = WHEELS_CSS;
  document.head.appendChild(style);

  // ── the ⓘ tooltips, by delegation, so markup added later still works ──
  let tip = null, anchor = null;
  const hide = () => { if (tip) { tip.remove(); tip = null; anchor = null; } };

  // Fixed position, so it can escape a card without being clipped — which
  // means it has to be moved when the page scrolls rather than left behind.
  // The first version hid it on scroll instead; that read fine by hand and
  // failed every automated hover, because scrolling the icon into view is the
  // first thing a click or a hover does.
  const place = () => {
    if (!tip || !anchor) return;
    const r = anchor.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const pad = 8;
    const left = Math.min(r.left, window.innerWidth - t.width - pad);
    let top = r.bottom + 6;
    if (top + t.height > window.innerHeight - pad) top = Math.max(pad, r.top - t.height - 6);
    tip.style.left = Math.max(pad, left) + 'px';
    tip.style.top = top + 'px';
  };

  const show = (el) => {
    const info = INFO[el.dataset.info];
    if (!info) return;
    if (anchor === el) return;          // already open on this one
    hide();
    anchor = el;
    tip = document.createElement('div');
    tip.className = 'itip';
    const [title, ...lines] = info;
    tip.innerHTML = `<h4></h4>${lines.map(() => '<p></p>').join('')}`;
    tip.querySelector('h4').textContent = title;
    tip.querySelectorAll('p').forEach((p, i) => { p.textContent = lines[i]; });
    document.body.appendChild(tip);
    // Measured after insertion: until it is in the document it has no height,
    // and would be positioned against a box of zero size.
    place();
  };
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest && e.target.closest('.i');
    if (el) show(el); else if (!e.target.closest || !e.target.closest('.itip')) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('.i');
    if (el) show(el);
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('.i');
    if (el) { e.preventDefault(); show(el); } else hide();   // tap, on a phone
  });
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  // ── the trim strip ────────────────────────────────────────────────
  let bar = null;
  if (opts.strip !== false) {
    bar = document.createElement('div');
    bar.className = 'wtrim';
    const host = opts.into ? document.querySelector(opts.into) : document.querySelector('.wrap');
    if (host) host.insertBefore(bar, opts.before ? host.children[1] || null : host.firstChild);
  }

  let last = null;
  const paint = (cfg) => {
    last = cfg;
    if (!bar) return;
    const t = wheelsOf(cfg);
    const measured = wheelsMeasured(t);
    bar.classList.toggle('warn', !measured);
    const [a, b] = wheelsSummary(t);
    bar.innerHTML = '';
    const tag = document.createElement('span');
    tag.className = 'wtag';
    tag.textContent = !measured ? 'ölçülmedi'
      : opts.mode === 'raw' ? 'ham çıkış' : 'teker ayarı';
    const l1 = document.createElement('span'); l1.innerHTML = `<b>${a}</b>`;
    const l2 = document.createElement('span'); l2.innerHTML = `<b>${b}</b>`;
    const gap = document.createElement('span'); gap.className = 'wsep';
    const info = document.createElement('span');
    info.innerHTML = infoHtml(opts.mode === 'raw' ? 'raw' : measured ? 'gain25' : 'stall25');
    const link = document.createElement('a');
    link.href = '/setup';
    link.textContent = measured ? 'ayarlar →' : 'ölç →';
    bar.append(tag, l1, l2, gap, info, link);
  };
  paint(opts.cfg || {});

  return {
    paint,
    /** Feed it a status frame; it repaints only when the trim actually moved. */
    fromStatus(s) {
      if (!s || !s.follow_cfg) return wheelsOf(last);
      const next = wheelsOf(s.follow_cfg);
      if (JSON.stringify(next) !== JSON.stringify(wheelsOf(last))) paint(s.follow_cfg);
      last = s.follow_cfg;
      return next;
    },
    get trim() { return wheelsOf(last); },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WHEELS_FALLBACK, WHEEL_KEYS, wheelsOf, wheelThreshold, wheelPin,
                     wheelVolts, wheelsMeasured, wheelsSteps, wheelsSummary,
                     INFO, infoHtml, WHEELS_CSS };
}
