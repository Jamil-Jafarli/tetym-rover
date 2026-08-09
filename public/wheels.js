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
      title: 'İki pinin gərginliyini tutuşdur',
      where: '/pins',
      done: null,          // only you can see a multimeter — see `manual`
      manual: true,
      what: 'GPIO25 və GPIO26-ya 255 ver, hər ikisini multimetrlə ölç.',
      then: 'Fərq 0.05 V-dan çoxdursa, ws_dac.ino-da DAC25_AT_255 və '
          + 'DAC26_AT_255 sabitlərinə öz ölçdüyün rəqəmləri yaz və yenidən yüklə.',
      why: 'Bu addım pinləri bərabərləşdirir — təkərləri yox. Atlaya bilərsən; '
         + 'düz getmək üçün 3-cü addım kifayətdir.',
    },
    {
      id: 'stall25',
      n: 2,
      title: 'GPIO25 — təkər neçə faizdə dönməyə başlayır',
      where: '/manual',
      done: t.stall25 !== null,
      value: t.stall25,
      unit: '%',
      what: 'Robotu qaldır. Yalnız GPIO25-ə faiz ver, 0-dan bir-bir qaldır.',
      then: 'Təkərin ilk döndüyü rəqəmi yaz.',
      why: 'Bundan aşağısı «yavaş» deyil, «dayanmış»dır. Loglarda bir sürüşdə '
         + 'əmrlərin 91 %-i bu ölü zonada idi — hərəkət əmri verilir, təkər dönmür.',
    },
    {
      id: 'stall26',
      n: 3,
      title: 'GPIO26 — təkər neçə faizdə dönməyə başlayır',
      where: '/manual',
      done: t.stall26 !== null,
      value: t.stall26,
      unit: '%',
      what: 'Eyni şey, bu dəfə yalnız GPIO26.',
      then: 'İkinci rəqəmi yaz. İki motorda 2–5 % fərq normaldır.',
      why: 'İki motor heç vaxt eyni motor deyil. Ortaq bir rəqəm hər ikisi üçün '
         + 'səhv olur — biri hələ dayanır, digəri artıq sürətlənir.',
    },
    {
      id: 'gain',
      n: 4,
      title: 'Düz getmə — güc düzəlişi',
      where: '/manual',
      done: both ? trimmed : null,
      value: `${t.gain25.toFixed(2)} / ${t.gain26.toFixed(2)}`,
      blocked: !both,
      what: 'Robotu yerə qoy, hər iki pinə eyni faiz (40) ver, burax.',
      then: 'Əyildiyi tərəfin ƏKS təkəri sürətlidir. Həmin təkərin gücünü '
          + '1.00-dan 0.95-ə, sonra 0.90-a endir — düz gedənə qədər.',
      why: 'Yavaş təkəri qaldırma, sürətlini azalt: yuxarı qalxsa tavana '
         + 'dirənir və döngədə düzəliş üçün yer qalmır.',
    },
    {
      id: 'metres',
      n: 5,
      title: 'Məsafə kalibrasiyası',
      where: '/follow',
      done: null,
      manual: true,
      what: 'Məlum faizdə (məsələn 40) məlum məsafəni (2 m) sür, saniyəni tut.',
      then: '/follow → Kalibrasiya kartına faiz, metr və saniyəni yaz.',
      why: 'Bu olmadan loglar sürəti faizlə yazır, metrlə yox — «bu dövrə 11 m '
         + 'idi» deyə bilmirsən.',
    },
    {
      id: 'closed',
      n: 6,
      title: 'Qapalı dövrə — sürət voltajdan asılı olmasın',
      where: '/setup',
      done: null,
      manual: true,
      blocked: !both,
      what: 'Motorun hall sensor naqillərini ESP32-yə bağla, sonra hər təkəri '
          + '100 %-də sür və impuls tezliyini (Hz) yaz.',
      then: 'Bundan sonra sistem voltajı özü qaldırıb-endirir; batareya '
          + 'boşalsa da sürət eyni qalır.',
      why: 'Yuxarıdakı bütün düzəlişlər BU GÜNÜN batareyasına və BU döşəməyə '
         + 'aiddir. Yalnız ölçmə onları həmişəlik edir.',
    },
  ];
}

/** Short lines for the strip at the top of every page. */
function wheelsSummary(w) {
  const t = wheelsOf(w);
  const s = (v) => (v === null ? `${t.stall} %*` : `${v} %`);
  return [
    `GPIO25 · hədd ${s(t.stall25)} · güc ${t.gain25.toFixed(2)}`,
    `GPIO26 · hədd ${s(t.stall26)} · güc ${t.gain26.toFixed(2)}`,
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
  stall: ['Dönmə həddi (ümumi)',
    'Təkərin dönməyə başladığı faiz. Bundan aşağısı yavaş deyil, dayanmışdır.',
    'Ölç: /manual-da faizi 0-dan bir-bir qaldır, ilk dönən anı yaz.',
    'Per-pin həddlər qoyulubsa bu işlənmir.'],
  stall25: ['GPIO25 — dönmə həddi',
    'Yalnız bu pinin öz həddi. 0 = ümumi həddi işlət.',
    'Ölç: /manual-da yalnız GPIO25-ə faiz ver.',
    'İki motorda 2–5 % fərq normaldır — düzəldilməsə yavaş sürətdə robot əyilir.'],
  stall26: ['GPIO26 — dönmə həddi',
    'Yalnız bu pinin öz həddi. 0 = ümumi həddi işlət.',
    'Ölç: /manual-da yalnız GPIO26-ya faiz ver.',
    'İki motorda 2–5 % fərq normaldır.'],
  gain25: ['GPIO25 — güc düzəlişi',
    'Bu təkərə gedən tələbi vurur. 1.00 = toxunma.',
    'Ölç: hər iki pinə eyni faiz ver, əyildiyi tərəfin əks təkərini azalt.',
    'Ən axırda işlət — əvvəlcə həddləri düzəlt. Sürətlini azalt, yavaşı qaldırma.'],
  gain26: ['GPIO26 — güc düzəlişi',
    'Bu təkərə gedən tələbi vurur. 1.00 = toxunma.',
    'Ölç: hər iki pinə eyni faiz ver, əyildiyi tərəfin əks təkərini azalt.',
    'Ən axırda işlət. Sürətlini azalt, yavaşı qaldırma.'],
  swap: ['Tərəfləri dəyiş',
    'GPIO26 sol təkəri sürürsə işə sal.',
    'Yoxla: /drive-da A bas — robot sola dönməlidir.',
    'Robot döngəni tərsinə alırsa səbəb budur, kP deyil.'],
  base:  ['Baza sürəti',
    'Düz yolda gedilən tələb. Hər şey bundan kəsilir.',
    'Ölü zonanın üstündə olmalıdır — yanındakı volt rəqəminə bax.',
    'Robot ləng dönürsə əvvəlcə bunu azalt, kP-ni qaldırma.'],
  kP: ['Sükan gücü',
    'Xətadan sükana çevirmə əmsalı.',
    'Qaldır: robot döngəni gec alırsa. Endir: düz yolda yırğalanırsa.',
    'Yırğalanma varsa əvvəlcə kD-ni qaldır, sonra kP-ni endir.'],
  kD: ['Qabağa baxış (saniyə)',
    'Xətanın neçə saniyə sonrakı yerinə görə sürmək.',
    'Yırğalanmanı söndürür.',
    'Çox qaldırsan hərəkət cırıq-cırıq olur — kamera səs-küyü böyüdülür.'],
  curve: ['Döngədə yavaşlama',
    'Döngə nə qədər kəskindirsə sürət o qədər kəsilir.',
    '1.00 = tam döngədə tam dayanma.',
    'Robot döngədə yoldan çıxırsa bunu qaldır — kP-ni yox.'],
  hard: ['Xilasetmə həddi',
    'Bu xətadan sonra irəli getmək vəziyyəti pisləşdirir.',
    'Robot yerində fırlanıb yola çevrilir.',
    'Çox tez-tez işə düşürsə base-i azalt.'],
  gear: ['İki sabit sürət',
    'NORMAL və SÜRƏT — eyni anda yalnız biri. Seçilən sürət pinlərə birbaşa '
    + 'öz DAC rəqəmini verir.',
    'İşlət: ARM, sonra sürəti seç. W/A/S/D basmaq sürəti söndürür — əl həmişə '
    + 'üstündür.',
    'Xam çıxış: dönmə həddi, güc düzəlişi və master level buna TƏTBİQ OLUNMUR '
    + '— yazdığın rəqəm pinə gedən rəqəmdir.'],
  gearDac: ['Sürətin DAC rəqəmi',
    'Pinin aldığı 0-255 rəqəmi: dac = V / 3.3 × 255. 124 ≈ 1.60 V, 241 ≈ 3.12 V.',
    'Ölç: /manual-da faizi qaldır, təkərin getdiyi sürəti bəyənəndə yanındakı '
    + 'DAC rəqəmini bura yaz.',
    '77-dən aşağısı boş yerədir — 1.00 V idle-dır, ondan aşağı heç vaxt '
    + 'çıxmır. İki pinin rəqəmi 2-3 fərqlənə bilər: motorlar eyni deyil.'],
  vmax: ['100 % nə deməkdir',
    'Serverin --v-max dəyəri. 100 % = bu gərginlik.',
    'ESP32 üçün 3.3 V.',
    'Bütün faizlər bu tavana görədir.'],
  closed: ['Qapalı dövrə',
    'Təkərin real sürətini ölçüb voltajı ona görə düzəldir.',
    'Motorun hall sensoru lazımdır.',
    'İşə salınıbsa gain düzəlişləri artıq kritik deyil — dövrə özü tutur.'],
  dac: ['İki DAC kanalını tutuşdurmaq',
    'ESP32-nin GPIO25 və GPIO26 kanalları eyni koda bir qədər fərqli gərginlik verir.',
    'Ölç: hər ikisinə 255 ver, multimetrlə oxu, ws_dac.ino-daki sabitlərə yaz.',
    'Bu pinləri bərabərləşdirir, təkərləri yox — düz getmək üçün güc düzəlişi lazımdır.'],
  metres: ['Məsafə kalibrasiyası',
    'Faizdən metrə çevirmə sabiti. Bu robotda enkoder yoxdur, ona görə əl ilə ölçülür.',
    'Ölç: məlum faizdə məlum məsafəni sür, saniyəni tut.',
    'Yalnız loglar üçündür — naviqasiya üçün deyil.'],
  raw: ['Bu səhifə xam faiz göndərir',
    'Aşağıdakı ayarlar burada TƏTBİQ OLUNMUR — nə yazsan, pinə o gedir.',
    'Bilərəkdən belədir: dönmə həddi məhz burada ölçülür.',
    'Ayarların tətbiq olunduğu yer /follow-dur.'],
  hzFull: ['Tam sürətdə tezlik',
    '100 % tələbdə bu təkərin verdiyi impuls/saniyə.',
    'Ölç: təkəri 100 %-də sür, Hz oxunuşunu yaz.',
    'Bu ölçülməyibsə qapalı dövrə işə düşmür — sistem açıq dövrədə qalır.'],
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
    tag.textContent = !measured ? 'ölçülməyib'
      : opts.mode === 'raw' ? 'xam çıxış' : 'təkər ayarı';
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
