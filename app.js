'use strict';

/* =====================================================================
   TELEGRAM
   ===================================================================== */
const tg = window.Telegram && window.Telegram.WebApp;
const inTG = !!(tg && tg.initData);
const tgv = v => inTG && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast(v);

// Сервер бота (Cloudflare Worker): приветствие на /start и напоминания.
// Пусто — приложение работает без сервера, раздел напоминаний скрыт.
const BOT_API = 'https://forma-bot.forma-trener.workers.dev';
const BOT_USERNAME = 'forma_trener_bot';

function haptic(type = 'light') {
  try {
    if (tgv('6.1')) {
      if (['success', 'warning', 'error'].includes(type)) tg.HapticFeedback.notificationOccurred(type);
      else if (type === 'select') tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.impactOccurred(type);
    } else if (navigator.vibrate) {
      navigator.vibrate(type === 'success' ? [120, 80, 120] : 12);
    }
  } catch (e) { /* ничего */ }
}
// Своё окно подтверждения внутри приложения: системные confirm/showConfirm
// в некоторых клиентах Telegram не показываются, и кнопки «молча» не работали.
let confirmResolve = null;
function confirmAsync(msg, okText = 'Да', danger = false) {
  return new Promise(res => {
    if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
    openSheet(`<p class="confirm-text">${esc(msg)}</p>
      <button class="btn ${danger ? 'btn-red' : ''}" data-act="confirm-yes">${esc(okText)}</button>
      <button class="btn ghost" data-act="confirm-no">Отмена</button>`);
    confirmResolve = res;
    haptic('warning');
  });
}

/* =====================================================================
   ХРАНЕНИЕ: localStorage + облако Telegram (CloudStorage)
   ===================================================================== */
const KEY = 'forma.v1';
const defaultState = () => ({
  v: 3, updatedAt: 0,
  my: [],          // программы в «Для меня»
  levels: {},      // уровень сложности по программе
  swaps: {},       // замены упражнений: "prog/day/index" -> id
  last: {},        // последние веса/повторы по упражнению
  history: [],     // завершённые тренировки
  session: null,   // текущая тренировка
  rest: null,      // таймер отдыха
  measures: [],    // замеры тела
  sound: true,
  guidesRead: [],  // прочитанные гайды
  guidesSaved: [], // гайды в закладках
  body: null,      // параметры тела для КБЖУ
  goal: 'keep',    // цель: cut / keep / bulk
  remind: { on: false, days: [0, 2, 4], time: '19:00' }, // напоминания от бота (0 = пн)
  remindSent: '',  // что последний раз отправили на сервер бота
  weekGoal: 2,     // тренировок в неделю для серии
  streakWarn: true, // бот предупреждает в субботу, если серия под угрозой
  restPush: true,  // бот пишет в чат, когда отдых закончился, а приложение свёрнуто
  ach: {},         // полученные достижения: id -> дата
});

// v2: сплит Арнольда переписан — старые замены упражнений в нём больше не подходят
function migrate(st) {
  if ((st.v || 1) < 2) {
    Object.keys(st.swaps || {}).forEach(k => { if (k.startsWith('arnold/')) delete st.swaps[k]; });
    st.v = 2;
  }
  // v3: каталог программ заменён программами из приложения
  if (st.v < 3) {
    const ids = new Set(PROGRAMS.map(p => p.id));
    if (st.session && !ids.has(st.session.pid)) { st.session = null; st.rest = null; }
    st.my = (st.my || []).filter(id => ids.has(id));
    Object.keys(st.swaps || {}).forEach(k => { if (!ids.has(k.split('/')[0]) || k.startsWith('ppl/')) delete st.swaps[k]; });
    st.v = 3;
  }
  return st;
}

let S = loadLocal();
function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(Object.assign(defaultState(), JSON.parse(raw)));
  } catch (e) { /* пусто */ }
  return defaultState();
}
function save() {
  S.updatedAt = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* пусто */ }
  cloudSaveSoon();
}
let saveTimer;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }

const cloud = tgv('6.9') && tg.CloudStorage ? tg.CloudStorage : null;
const CHUNK = 4000;
let cloudTimer;
function cloudSaveSoon() { if (!cloud) return; clearTimeout(cloudTimer); cloudTimer = setTimeout(cloudSave, 1500); }
function cloudSave() {
  const json = JSON.stringify(S);
  const parts = [];
  for (let i = 0; i < json.length;) {
    let end = Math.min(i + CHUNK, json.length);
    const c = json.charCodeAt(end - 1);
    if (end < json.length && c >= 0xd800 && c <= 0xdbff) end--; // не резать эмодзи пополам
    parts.push(json.slice(i, end));
    i = end;
  }
  let left = parts.length;
  parts.forEach((p, i) => cloud.setItem('c' + i, p, () => {
    if (--left === 0) cloud.setItem('meta', JSON.stringify({ n: parts.length, t: S.updatedAt }), () => {});
  }));
}
function cloudLoad() {
  if (!cloud) return;
  cloud.getItem('meta', (err, val) => {
    if (err) return;
    if (!val) { if (S.updatedAt) cloudSave(); return; }
    let meta;
    try { meta = JSON.parse(val); } catch (e) { return; }
    if (meta.t < S.updatedAt) { cloudSave(); return; }
    if (meta.t === S.updatedAt) return;
    const keys = Array.from({ length: meta.n }, (_, i) => 'c' + i);
    cloud.getItems(keys, (e2, vals) => {
      if (e2 || !vals) return;
      try {
        const data = JSON.parse(keys.map(k => vals[k] || '').join(''));
        S = migrate(Object.assign(defaultState(), data));
        localStorage.setItem(KEY, JSON.stringify(S));
        render();
        toast('Данные загружены из облака');
      } catch (e) { /* битые данные — игнорируем */ }
    });
  });
}

/* =====================================================================
   УТИЛИТЫ
   ===================================================================== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
const pad = n => String(n).padStart(2, '0');
const fmtClock = sec => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};
const fmtNum = n => String(Math.round(n * 10) / 10).replace('.', ',');
const fmtTon = kg => kg >= 1000 ? fmtNum(kg / 1000) + ' т' : Math.round(kg) + ' кг';
const dkey = d => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_G = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c; };
const mondayOf = d => { d = new Date(d); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d; };
const addDays = (d, n) => { d = new Date(d); d.setDate(d.getDate() + n); return d; };

const exName = id => (LIB[id] || [id])[0];
const exMuscle = id => (LIB[id] || [, ''])[1];
const exTip = id => (LIB[id] || [, , ''])[2];
const isTime = reps => /сек/.test(reps);
const repsLabel = r => isTime(r) ? r : `${r} повторений`;
const repsMin = r => parseInt(r, 10) || 0;
const prog = id => PROGRAMS.find(p => p.id === id);
const slot = (pid, day, i) => `${pid}/${day}/${i}`;
const setsFor = (pid, e) => (e.sets || 2) + LEVELS[S.levels[pid] || 'light'].add;
// подход засчитан, если отмечен галочкой или вписаны повторения
const setCounts = x => x.done || String(x.r ?? '').trim() !== '';
const MUSCLE_ICON = { 'грудь': '🏋️', 'спина': '🚣', 'плечи': '🤸', 'бицепс': '💪', 'трицепс': '🦾', 'ноги': '🦵', 'икры': '🦶', 'пресс': '🔥', 'кардио': '🏃', 'ягодицы': '🍑' };
const setTonnage = sets => sets.reduce((a, x) => a + num(x.w) * num(x.r), 0);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* =====================================================================
   ИКОНКИ
   ===================================================================== */
const sv = (d, s = 22, w = 1.8) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  back: sv('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  fwd: sv('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  prevs: sv('<path d="M12 6l-6 6 6 6M18 6l-6 6 6 6"/>'),
  nexts: sv('<path d="M6 6l6 6-6 6M12 6l6 6-6 6"/>'),
  sliders: sv('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><path d="M15 4v6M9 14v6"/>'),
  timer: sv('<circle cx="12" cy="14" r="7"/><path d="M12 10v4M10 2h4"/>'),
  play: sv('<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>'),
  history: sv('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  swap: sv('<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>'),
  plus: sv('<path d="M12 5v14M5 12h14"/>', 24),
  check: sv('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 22, 2.2),
  bm: sv('<path d="M6 3h12v18l-6-4.5L6 21z"/>', 26, 2),
  bmFill: sv('<path d="M6 3h12v18l-6-4.5L6 21z" fill="currentColor"/>', 26, 2),
  grid: sv('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M14 15h7M14 19h7"/>', 24),
  cal: sv('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>', 24),
  user: sv('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>', 24),
  x: sv('<path d="M6 6l12 12M18 6L6 18"/>', 18, 2.2),
  trash: sv('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 18),
  dots: sv('<circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/>', 22, 0),
  food: sv('<path d="M5 11h14a7 7 0 0 1-14 0z"/><path d="M9 7c0-2 2-2 2-4M13 7c0-2 2-2 2-4"/>', 24),
  search: sv('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', 24),
  chev: sv('<path d="M8 10l4-4 4 4M8 14l4 4 4-4"/>', 18),
  share: sv('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>', 20),
  bell: sv('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>', 20),
};

/* =====================================================================
   НАВИГАЦИЯ
   ===================================================================== */
const ui = {
  mode: 'all', filters: {}, day: {}, sumTab: 'train',
  calMonth: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(),
  selDay: dkey(new Date()),
  libTab: 'guides', gMode: 'all', gSaved: false, exGroup: null, bd: null,
};
let tab = 'home';
let nav = [{ v: 'home' }];
const cur = () => nav[nav.length - 1];

function go(view) { nav.push(view); render(); window.scrollTo(0, 0); }
function back() { if (nav.length > 1) { nav.pop(); render(); } }
function setTab(t) { tab = t; nav = [{ v: t }]; render(); window.scrollTo(0, 0); }

function render() {
  closeMenu();
  if (cur().v === 'ex' && (!S.session || !S.session.exercises[cur().i])) nav.pop();
  const view = cur();
  const html = (VIEWS[view.v] || VIEWS.home)(view);
  $('#app').innerHTML = html + (nav.length === 1 && view.v !== 'done' ? tabbar() : '');
  renderRest();
  tick();
  updateBackButton();
}

function tabbar() {
  const items = [['home', 'Программы', I.grid], ['food', 'Питание', I.food], ['summary', 'Сводка', I.cal], ['library', 'Обзор', I.search], ['profile', 'Профиль', I.user]];
  return `<nav class="tabbar">${items.map(([k, l, ic]) =>
    `<button class="${tab === k ? 'on' : ''}" data-act="tab" data-arg="${k}">${ic}<span>${l}</span></button>`).join('')}</nav>`;
}

/* =====================================================================
   ЭКРАНЫ
   ===================================================================== */
const VIEWS = {};

/* ---------- Главная: список программ ---------- */
const FILTERS = [
  { k: 'days', label: 'Дней в неделю', opts: [1, 2, 3, 4, 5, 6], fmt: n => `${n} ${plural(n, 'день', 'дня', 'дней')}` },
  { k: 'place', label: 'Место', opts: ['В зале', 'Дома'] },
  { k: 'exp', label: 'Опыт', opts: ['Новичку и опытным', 'Только опытным', 'Быстрая'] },
  { k: 'sex', label: 'Пол', opts: ['Муж.', 'Жен.'] },
];
const matchFilters = p => FILTERS.every(f => {
  const v = ui.filters[f.k];
  if (v === undefined) return true;
  if (f.k === 'sex') return p.sex === v || p.sex === 'Всем';
  return p[f.k] === v;
});

VIEWS.home = () => {
  const list = ui.mode === 'my' ? PROGRAMS.filter(p => S.my.includes(p.id)) : PROGRAMS.filter(matchFilters);
  let body;
  if (list.length) body = list.map(programCard).join('');
  else if (ui.mode === 'my') body = `<div class="empty"><div class="big">🔖</div>Нажмите на закладку на карточке программы — она появится здесь.</div>`;
  else body = `<div class="empty"><div class="big">🔍</div>Нет программ под эти фильтры.</div>`;

  return `<div class="page has-nav">
    <header class="home-head">
      ${streakChip()}
      <div class="logo">FOR<b>MA</b></div>
      <button class="icon-btn" data-act="tab" data-arg="profile">${I.user}</button>
    </header>
    ${S.session ? sessionBanner() : ''}
    ${ui.mode === 'all' ? filterChips() : ''}
    ${body}
    <div class="mode">
      <button class="${ui.mode === 'my' ? 'on' : ''}" data-act="mode" data-arg="my">Для меня</button>
      <button class="${ui.mode === 'all' ? 'on' : ''}" data-act="mode" data-arg="all">Все программы</button>
    </div>
  </div>`;
};

function sessionBanner() {
  const p = prog(S.session.pid);
  return `<button class="banner" data-act="resume"><i class="dot"></i>
    <div><b>Идёт тренировка · <span data-el="elapsed"></span></b><small>${esc(p ? p.title : '')} · день ${esc(S.session.day)}</small></div>${I.fwd}</button>`;
}

function filterChips() {
  return `<div class="chips">${FILTERS.map(f => {
    const v = ui.filters[f.k];
    if (v === undefined) return `<button class="chip" data-act="filter" data-arg="${f.k}">${f.label}</button>`;
    return `<button class="chip on" data-act="filter-clear" data-arg="${f.k}">${esc(f.fmt ? f.fmt(v) : v)} ${I.x}</button>`;
  }).join('')}</div>`;
}

// кружок на карточке: отрезок на каждый день программы, пройденные в текущем цикле закрашены,
// в центре — буква следующей тренировки
function dayRing(p) {
  const n = p.plan.length, next = defaultDay(p);
  const done = p.plan.findIndex(d => d.key === next);
  const r = 20, gap = n > 1 ? 0.22 : 0, step = 2 * Math.PI / n;
  let arcs = '';
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i * step + gap / 2, a1 = a0 + step - gap;
    const pt = a => `${(23 + r * Math.cos(a)).toFixed(2)} ${(23 + r * Math.sin(a)).toFixed(2)}`;
    arcs += n === 1
      ? `<circle cx="23" cy="23" r="${r}" class="${i < done ? 'on' : ''}"/>`
      : `<path d="M ${pt(a0)} A ${r} ${r} 0 0 1 ${pt(a1)}" class="${i < done ? 'on' : ''}"/>`;
  }
  return `<div class="pcard-badge"><svg viewBox="0 0 46 46">${arcs}</svg><span>${esc(next)}</span></div>`;
}

function programCard(p) {
  const on = S.my.includes(p.id);
  const tags = [`${p.days} ${plural(p.days, 'день', 'дня', 'дней')}`, p.place, p.exp, p.since, p.sex];
  return `<div class="pcard" role="button" data-act="open-program" data-arg="${p.id}" style="--h:${p.hue}">
    <button class="bm" data-act="toggle-my" data-arg="${p.id}" aria-label="В мои программы">${on ? I.bmFill : I.bm}</button>
    ${dayRing(p)}
    <div class="pcard-art">${p.emoji}</div>
    <h2 class="pcard-title">${esc(p.title)}</h2>
    <div class="tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
  </div>`;
}

/* ---------- Программа: дни и упражнения ---------- */
function defaultDay(p) {
  if (S.session && S.session.pid === p.id) return S.session.day;
  for (let i = S.history.length - 1; i >= 0; i--) {
    const r = S.history[i];
    if (r.pid === p.id) {
      const idx = p.plan.findIndex(d => d.key === r.day);
      return p.plan[(idx + 1) % p.plan.length].key;
    }
  }
  return p.plan[0].key;
}

const isCardio = e => e && (e.kind === 'cardio' || exMuscle(e.id) === 'кардио');

// Все шаги дня по порядку: кардио-разминка → упражнения → кардио-заминка
function planItems(pid, day) {
  const sw = key => S.swaps[slot(pid, day.key, key)];
  const cardioItem = (c, role) => ({ kind: 'cardio', role, slot: role, orig: c.id, id: sw(role) || c.id, reps: String(c.min), rest: 60, sets: 1, w: 0 });
  const items = [];
  if (day.cardio) items.push(cardioItem(day.cardio, 'warm'));
  day.ex.forEach((e, i) => {
    const id = sw(i) || e.id;
    items.push({ kind: 'ex', slot: i, orig: e.id, id, reps: e.reps, rest: e.rest, sets: setsFor(pid, e), w: id === e.id ? (e.w || 0) : 0 });
  });
  if (day.cool) items.push(cardioItem(day.cool, 'cool'));
  return items;
}

VIEWS.program = ({ pid }) => {
  const p = prog(pid);
  const dayKey = ui.day[pid] || defaultDay(p);
  const day = p.plan.find(d => d.key === dayKey) || p.plan[0];
  const L = LEVELS[S.levels[pid] || 'light'];
  const active = S.session && S.session.pid === pid && S.session.day === day.key ? S.session : null;

  const items = active
    ? active.exercises.map(e => ({ ...e, sets: e.sets.length, done: e.sets.filter(setCounts).length, w: Math.max(0, ...e.sets.map(x => num(x.w))) }))
    : planItems(pid, day).map(it => ({ ...it, done: 0 }));
  const exCount = items.filter(x => !isCardio(x)).length;

  const row = (r, i) => {
    let meta;
    if (isCardio(r)) meta = `<span>${esc(r.reps)} минут</span>`;
    else {
      const last = S.last[r.id];
      const maxW = active ? r.w : ((last ? Math.max(0, ...last.w.map(num)) : 0) || r.w || 0);
      meta = `<span>${r.sets} × ${esc(repsLabel(r.reps))}</span>${maxW ? `<span class="kg">${fmtNum(maxW)} кг</span>` : ''}`;
    }
    const allDone = r.done && r.done === r.sets;
    return `<div class="ex-row" role="button" data-act="open-ex" data-arg="${pid}|${day.key}|${i}">
      ${exCircle(r.id, r.done, r.sets, '')}
      <div class="meta"><b>${esc(exName(r.id))}</b>${meta}</div>
      ${active && allDone ? `<span class="tick on">${I.check}</span>` : ''}
      <button class="dots" data-act="row-menu" data-arg="${pid}|${day.key}|${i}" aria-label="Меню">${I.dots}</button>
    </div>`;
  };

  let list = '', exTitle = false;
  items.forEach((r, i) => {
    const gap = i ? ' style="margin-top:22px"' : '';
    if (isCardio(r)) list += `<div class="sec-title"${gap}>Кардио</div>`;
    else if (!exTitle) {
      exTitle = true;
      list += `<div class="sec-title"${gap}>${exCount} ${plural(exCount, 'упражнение', 'упражнения', 'упражнений')}<small>${esc(day.name)}</small></div>`;
    }
    list += row(r, i);
  });

  const cta = active
    ? `<button class="cta finish" data-act="finish">Завершить · <span data-el="elapsed"></span></button>`
    : `<button class="cta" data-act="start-day" data-arg="${pid}|${day.key}">Начать день ${esc(day.key)}</button>`;

  return `<div class="page has-cta">
    <div class="topbar">
      <button class="icon-btn" data-act="back">${I.back}</button>
      <h1>${esc(p.title)}</h1>
      <button class="icon-btn" data-act="prog-menu" data-arg="${pid}">${I.sliders}</button>
    </div>
    ${weekStrip(pid)}
    <div class="day-row">
      <div class="days">${p.plan.map(d => `<button class="${d.key === day.key ? 'on' : ''}" data-act="pick-day" data-arg="${pid}|${d.key}">${esc(d.key)}</button>`).join('')}</div>
      <button class="lvl" data-act="level" data-arg="${pid}"><i style="background:${L.color}"></i>${L.name}${I.chev}</button>
    </div>
    ${list}
    ${cta}
  </div>`;
};

function weekStrip(pid) {
  const mon = mondayOf(new Date());
  const today = dkey(new Date());
  const byDay = histByDay();
  return `<div class="week">${Array.from({ length: 7 }, (_, n) => {
    const d = addDays(mon, n), k = dkey(d), recs = byDay[k] || [];
    const mine = recs.find(r => r.pid === pid);
    const isToday = k === today;
    const label = isToday ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}` : WD[n];
    return `<div class="${isToday ? 'today' : ''}">${label}<i class="${recs.length ? 'on' : ''}"></i><b>${mine ? esc(mine.day) : (recs.length ? '•' : '--')}</b></div>`;
  }).join('')}</div>`;
}

// пол модели на картинках: по программе, которую сейчас смотрят или делают
function mediaSex() {
  const v = cur();
  const pid = v.pid || (S.session && S.session.pid);
  const p = pid && prog(pid);
  return p && p.sex === 'Жен.' ? 'f' : 'm';
}
const hasMedia = id => typeof MEDIA !== 'undefined' && !!MEDIA[id];
// содержимое кружка: картинка, видео (video=true) или значок группы мышц
// силуэт из Flow: в кружках первый кадр, на экране упражнения — смена кадров
const hasFlow = id => typeof FLOW !== 'undefined' && !!FLOW[id];
const flowSrc = (id, i) => `media/flow/${FLOW[id][0]}-${i}.svg`;
function flowPic(id, animate) {
  const f = FLOW[id];
  if (animate) for (let i = 0; i < f[1]; i++) new Image().src = flowSrc(id, i);   // предзагрузка кадров
  return `<img class="ex-media flow" src="${flowSrc(id, f[2][0])}" alt=""${animate ? ` data-flow="${id}"` : ' loading="lazy"'}>`;
}
// анимация силуэтов: кадры по порядку из базы, с её скоростью
setInterval(() => {
  document.querySelectorAll('img[data-flow]').forEach(img => {
    const f = FLOW[img.dataset.flow], seq = f[2];
    const i = seq[Math.floor(Date.now() / f[3]) % seq.length];
    const src = flowSrc(img.dataset.flow, i);
    if (!img.src.endsWith(src)) img.src = src;
  });
}, 60);

function exPic(id, video) {
  if (!hasMedia(id)) return hasFlow(id) ? flowPic(id, video) : (MUSCLE_ICON[exMuscle(id)] || '🏋️');
  const want = mediaSex(), have = MEDIA[id];
  const b = `media/${id}-${have.includes(want) ? want : have[0]}`;
  return video
    ? `<video class="ex-media" src="${b}.mp4" poster="${b}.jpg" autoplay muted loop playsinline></video>`
    : `<img class="ex-media" src="${b}.jpg" alt="" loading="lazy">`;
}

function exCircle(id, done, total, size) {
  const r = 46, c = 2 * Math.PI * r, pct = total ? done / total : 0;
  return `<div class="exc ${size}"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="${r}" class="ring-bg"/>
    <circle cx="50" cy="50" r="${r}" class="ring" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}" transform="rotate(-90 50 50)"/></svg>
    <div class="exc-in">${exPic(id, size === 'big')}</div></div>`;
}

/* ---------- Тренировка: старт / завершение ---------- */
function mkSessionItem(it) {
  if (it.kind === 'cardio') {
    return { kind: 'cardio', role: it.role, slot: it.slot, id: it.id, reps: it.reps, rest: 60, note: '', sets: [{ w: '', r: '', done: false }] };
  }
  const last = S.last[it.id];
  return {
    kind: 'ex', slot: it.slot, id: it.id, reps: it.reps, rest: it.rest, note: '',
    sets: Array.from({ length: it.sets }, (_, k) => {
      const w = last && last.w.length ? num(last.w[Math.min(k, last.w.length - 1)]) : num(it.w);
      return { w: w ? String(w) : '', r: '', done: false };
    }),
  };
}

async function startDay(pid, dayKey, openIdx) {
  if (S.session && !(S.session.pid === pid && S.session.day === dayKey)) {
    if (!await confirmAsync('Сейчас идёт другая тренировка. Сбросить её и начать новую?', 'Начать новую', true)) return;
    S.session = null; S.rest = null;
  }
  if (!S.session) {
    const day = prog(pid).plan.find(d => d.key === dayKey);
    S.session = { pid, day: dayKey, startedAt: Date.now(), exercises: planItems(pid, day).map(mkSessionItem) };
    save();
    haptic('medium');
    requestWake();
  }
  ui.day[pid] = dayKey;
  go({ v: 'ex', i: Math.min(openIdx || 0, S.session.exercises.length - 1) });
}

async function finishSession() {
  const s = S.session;
  if (!s) return;
  const anyDone = s.exercises.some(e => e.sets.some(setCounts));
  if (!anyDone) {
    if (await confirmAsync('Ни один подход не заполнен. Отменить тренировку без сохранения?', 'Отменить тренировку', true)) {
      S.session = null; S.rest = null; save(); releaseWake();
      tab = 'home'; nav = [{ v: 'home' }]; render();
    }
    return;
  }
  if (!await confirmAsync('Завершить тренировку и сохранить результат?', 'Завершить')) return;
  if (S.session !== s) return;

  const ex = s.exercises
    .map(e => ({
      id: e.id, kind: isCardio(e) ? 'cardio' : 'ex', note: e.note || '',
      sets: e.sets.filter(setCounts).map(x => ({ w: num(x.w), r: num(x.r) || repsMin(e.reps) })),
    }))
    .filter(e => e.sets.length);
  const rec = {
    id: Date.now().toString(36),
    date: new Date(s.startedAt).toISOString(),
    pid: s.pid, day: s.day,
    dur: Math.round((Date.now() - s.startedAt) / 1000),
    ex,
    tonnage: ex.filter(e => !isCardio(e)).reduce((a, e) => a + setTonnage(e.sets), 0),
  };
  rec.prs = findRecords(ex, rec.date);
  S.history.push(rec);
  rec.ach = checkAch(true).map(a => a.id);
  botSync();
  ex.forEach(e => { S.last[e.id] = { w: e.sets.map(x => x.w), r: e.sets.map(x => x.r), date: rec.date }; });
  S.session = null; S.rest = null;
  save(); releaseWake(); haptic('success');
  tab = 'home'; nav = [{ v: 'done', id: rec.id }]; render(); window.scrollTo(0, 0);
}

// как показать подход: «40 кг × 10» или «2,6 км · 10 мин»
function fmtSet(e, x, short = false) {
  if (isCardio(e)) return [x.w ? fmtNum(x.w) + ' км' : '', fmtNum(x.r) + ' мин'].filter(Boolean).join(' · ');
  return short ? (x.w ? fmtNum(x.w) + '×' : '') + fmtNum(x.r) : (x.w ? fmtNum(x.w) + ' кг × ' : '') + fmtNum(x.r);
}

/* ---------- Подсказка веса на сегодня ---------- */
// правило двойной прогрессии: все подходы дошли до верха диапазона → +шаг веса
function suggestion(e) {
  if (isCardio(e) || isTime(e.reps)) return null;
  const last = S.last[e.id];
  if (!last || !last.w || !last.w.length) return null;
  const [lo, hi] = String(e.reps).split(/[-–]/).map(n => parseInt(n, 10));
  const top = hi || lo;
  if (!top) return null;
  const ws = last.w.map(num), rs = last.r.map(num);
  const lw = Math.max(0, ...ws);
  if (!lw) return null;
  const atW = rs.filter((r, k) => ws[k] === lw);
  let w = lw, msg;
  if (atW.every(r => r >= top)) {
    w = lw + (lw < 10 ? 1 : 2.5);
    msg = `Все подходы дошли до ${top} повторений — пора добавить вес.`;
  } else if (atW.some(r => r < (lo || top))) {
    msg = `Оставь вес и доведи все подходы хотя бы до ${lo}.`;
  } else {
    msg = `Оставь вес и добавь 1–2 повтора. Когда дойдёшь до ${top} во всех подходах — прибавим вес.`;
  }
  return { w, up: w > lw, msg, lastStr: ws.map((x, k) => `${x ? fmtNum(x) + '×' : ''}${fmtNum(rs[k])}`).join(', ') };
}
function suggBlock(e) {
  const sg = suggestion(e);
  if (!sg) return '';
  const need = e.sets.some(x => !x.done && num(x.w) !== sg.w);
  return `<div class="sugg ${sg.up ? 'up' : ''}"><div class="sugg-t"><small>Прошлый раз: ${sg.lastStr}</small>
      <b>${sg.up ? '📈 ' : ''}Сегодня: ${fmtNum(sg.w)} кг</b><span>${esc(sg.msg)}</span></div>
    ${need ? `<button data-act="apply-sugg">Поставить</button>` : ''}</div>`;
}

/* ---------- Экран упражнения ---------- */
VIEWS.ex = ({ i }) => {
  const s = S.session, e = s.exercises[i], last = S.last[e.id], cardio = isCardio(e);
  const done = e.sets.filter(x => x.done).length;
  const prev = i > 0 ? i - 1 : null, next = i < s.exercises.length - 1 ? i + 1 : null;

  const rows = e.sets.map((x, k) => {
    const lr = !cardio && last && last.r[k];
    const wPh = cardio ? (last && last.w[0] ? fmtNum(last.w[0]) : '0') : '0';
    return `<div class="set-row ${x.done ? 'done' : ''}">
      <button class="set-num" data-act="del-set" data-arg="${k}">${k + 1}</button>
      <label class="field"><input inputmode="decimal" enterkeyhint="done" data-f="w" data-k="${k}" value="${esc(x.w)}" placeholder="${wPh}"><span>${cardio ? 'км' : 'кг'}</span></label>
      <label class="field"><input inputmode="${cardio ? 'decimal' : 'numeric'}" enterkeyhint="done" data-f="r" data-k="${k}" value="${esc(x.r)}" placeholder="${esc(e.reps.replace(' сек', ''))}">${cardio ? '<span>мин</span>' : (lr ? `<i class="badge">${fmtNum(lr)}</i>` : '')}</label>
      <button class="check" data-act="check" data-arg="${k}" aria-label="Подход выполнен">${I.check}</button>
    </div>`;
  }).join('');

  const nextBtn = next !== null
    ? `<button class="next-card" data-act="ex-go" data-arg="${next}">${exCircle(s.exercises[next].id, 0, 0, 'sm')}
        <div class="nc-text"><b>${esc(exName(s.exercises[next].id))}</b><small>Далее</small></div>${I.nexts}</button>`
    : `<button class="next-card finish" data-act="finish"><div class="nc-text"><b>Завершить тренировку</b><small data-el="elapsed"></small></div>${I.check}</button>`;

  const sub = cardio
    ? (e.role === 'cool' ? 'заминка' : 'разминка')
    : `${esc(exMuscle(e.id))} · ${esc(repsLabel(e.reps))} · отдых ${e.rest} с`;

  return `<div class="page ex-page">
    <div class="ex-top">
      <button class="icon-btn" data-act="back">${I.back}</button>
      ${exCircle(e.id, done, e.sets.length, 'big')}
      <div class="right"><button class="icon-btn" data-act="rest-menu">${I.timer}</button></div>
    </div>
    <h1 class="ex-title">${esc(exName(e.id))}</h1>
    <div class="ex-muscle">${sub}</div>
    <div class="ex-actions">
      <button data-act="tech" data-arg="${i}">${I.play}<span>Техника</span></button>
      <button data-act="ex-history" data-arg="${i}">${I.history}<span>История</span></button>
      <button data-act="swap" data-arg="${i}">${I.swap}<span>Заменить</span></button>
    </div>
    ${suggBlock(e)}
    <div class="sets-head"><span></span><span>${cardio ? 'Расстояние' : 'Вес'}</span><span>${cardio ? 'Время' : isTime(e.reps) ? 'Секунды' : 'Повторения'}</span><span></span></div>
    ${rows}
    ${cardio ? '' : `<button class="add-set" data-act="add-set"><span class="circle">${I.plus}</span>Ещё подход</button>`}
    <textarea class="note" data-note="${i}" placeholder="Оставить заметку...">${esc(e.note)}</textarea>
    <div class="ex-nav">
      <button class="icon-btn" data-act="ex-go" data-arg="${prev ?? ''}" ${prev === null ? 'disabled' : ''}>${I.prevs}</button>
      ${nextBtn}
    </div>
  </div>`;
};

function toggleSet(k) {
  const s = S.session, e = s.exercises[cur().i], x = e.sets[k];
  x.done = !x.done;
  if (x.done) {
    const last = S.last[e.id];
    if (x.r === '' || x.r == null) {
      const lr = !isCardio(e) && last && last.r[k];
      x.r = String(lr || repsMin(e.reps) || '');
    }
    haptic('medium');
    const allDone = s.exercises.every(ex => ex.sets.every(z => z.done));
    if (allDone) toast('Все подходы выполнены 💪');
    else if (!isCardio(e)) startRest(e.rest);
  } else haptic('select');
  save();
  render();
}

/* ---------- Замена упражнения ---------- */
let swapCtx = null;
// семейство замен для упражнения (из catalog.js)
const swapFamily = id => (typeof SWAP_FAMILIES !== 'undefined' ? SWAP_FAMILIES : []).find(f => f.r.includes(id)) || null;

function openSwap(pid, dayKey, slotKey, curId) {
  const cardio = exMuscle(curId) === 'кардио';
  const all = Object.keys(LIB).filter(id => id !== curId && (exMuscle(id) === 'кардио') === cardio);
  let rec, rest;
  if (cardio) {
    rec = CARDIO_REC.filter(id => id !== curId);
    rest = all.filter(id => !rec.includes(id));
  } else {
    // замены как в приложении: семейство упражнения, затем остальные той же группы
    const fam = swapFamily(curId);
    const mu = exMuscle(curId);
    if (fam) {
      rec = fam.r.filter(id => id !== curId && LIB[id]);
      const o = fam.o.filter(id => id !== curId && LIB[id] && !rec.includes(id));
      rest = [...o, ...all.filter(id => exMuscle(id) === mu && !rec.includes(id) && !o.includes(id))];
    } else {
      rec = all.filter(id => exMuscle(id) === mu);
      rest = all.filter(id => exMuscle(id) !== mu);
    }
  }
  const opt = (id, on, showMuscle) => `<button class="swap-opt ${on ? 'on' : ''}" data-act="swap-pick" data-arg="${id}">
      <span class="thumb">${exPic(id)}</span>
      <span class="name">${esc(exName(id))}${showMuscle ? `<small>${esc(exMuscle(id))}</small>` : ''}</span>
      <i class="radio">${on ? I.check : ''}</i></button>`;
  swapCtx = { pid, dayKey, slotKey: String(slotKey), curId };
  openSheet(`<div class="sheet-head"><span></span><h4>Замены</h4><button class="icon-btn ghost" data-act="sheet-close" aria-label="Закрыть">${I.x}</button></div>
    ${opt(curId, true)}
    ${rec.length ? `<div class="swap-group">Рекомендованные</div>${rec.map(id => opt(id)).join('')}` : ''}
    ${rest.length ? `<div class="swap-group">Остальные</div>${rest.map(id => opt(id, false, !cardio && exMuscle(id) !== exMuscle(curId))).join('')}` : ''}`, 'flush');
}

function applySwap(id) {
  const c = swapCtx;
  if (!c || id === c.curId) return;
  const day = prog(c.pid).plan.find(d => d.key === c.dayKey);
  const key = slot(c.pid, c.dayKey, c.slotKey);
  const planned = planItems(c.pid, day).find(x => String(x.slot) === c.slotKey);
  if (planned && planned.orig === id) delete S.swaps[key]; else S.swaps[key] = id;

  const s = S.session;
  if (s && s.pid === c.pid && s.day === c.dayKey) {
    const idx = s.exercises.findIndex((e, i) => String(e.slot ?? i) === c.slotKey);
    const fresh = planItems(c.pid, day).find(x => String(x.slot) === c.slotKey);
    if (idx >= 0 && fresh) {
      if (!isCardio(fresh)) fresh.sets = s.exercises[idx].sets.length;
      s.exercises[idx] = mkSessionItem(fresh);
    }
  }
  save(); haptic('success'); render(); toast('Упражнение заменено');
}

/* ---------- Меню «⋮» у упражнения ---------- */
let menuEl = null, menuY = 0;
function closeMenu() {
  if (!menuEl) return;
  menuEl.remove(); menuEl = null;
  document.querySelectorAll('.ex-row.hl').forEach(r => r.classList.remove('hl'));
}
function itemAt(pid, dayKey, i) {
  const s = S.session;
  if (s && s.pid === pid && s.day === dayKey) { const e = s.exercises[i]; return e && { id: e.id, slot: e.slot ?? i }; }
  const day = prog(pid).plan.find(d => d.key === dayKey);
  return planItems(pid, day)[i];
}

/* ---------- Конец отдыха — сообщение от бота, если приложение свёрнуто ---------- */
let restPushed = false;
function restPushSend(payload) {
  if (!BOT_API || !inTG) return;
  const data = JSON.stringify({ ...payload, initData: tg.initData });
  // sendBeacon успевает уйти, даже когда приложение сворачивается
  const ok = navigator.sendBeacon && navigator.sendBeacon(BOT_API + '/api/rest', new Blob([data], { type: 'text/plain' }));
  if (!ok) fetch(BOT_API + '/api/rest', { method: 'POST', body: data, keepalive: true }).catch(() => {});
}
function restPushArm() {
  if (!S.restPush || !S.rest || !S.session) return;
  const left = S.rest.endsAt - Date.now();
  if (left < 4000) return;
  const v = cur(), e = v.v === 'ex' ? S.session.exercises[v.i] : null;
  let text = '⏱ <b>Отдых окончен</b> — пора на следующий подход!';
  if (e) {
    const k = e.sets.findIndex(x => !x.done);
    if (k >= 0) text += `\n\n${esc(exName(e.id))} — подход ${k + 1} из ${e.sets.length}`;
  }
  restPushSend({ at: S.rest.endsAt, text });
  restPushed = true;
}
function restPushCancel() {
  if (!restPushed) return;
  restPushed = false;
  restPushSend({ cancel: true });
}

/* ---------- Таймер отдыха ---------- */
function startRest(sec) {
  unlockAudio();
  S.rest = { endsAt: Date.now() + sec * 1000, total: sec * 1000 };
  save();
  $('#rest-root').innerHTML = '';
  renderRest();
}
function renderRest() {
  const r = $('#rest-root');
  if (!S.rest) { r.innerHTML = ''; return; }
  if (r.firstChild) return;
  r.innerHTML = `<div class="rest">
    <div class="rest-main"><span>Отдых</span><b data-el="rest">--:--</b></div>
    <button data-act="rest-add">+15 с</button>
    <button data-act="rest-skip">Пропустить</button>
    <div class="rest-bar"><i></i></div>
  </div>`;
}
function restDone() {
  // три сильных толчка: заметно, даже если телефон лежит на скамье
  haptic('success');
  [250, 500].forEach(t => setTimeout(() => haptic('heavy'), t));
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 300]);
  if (S.sound) beep();
  toast('Отдых окончен — следующий подход!');
}

let actx = null;
function unlockAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { /* без звука */ }
}
function tickSound() {
  if (!actx) return;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = 660; o.connect(g); g.connect(actx.destination);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  o.start(t); o.stop(t + 0.1);
}
function beep() {
  if (!actx) return;
  const t = actx.currentTime;
  [0, 0.28, 0.56].forEach((d, j) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = j === 2 ? 1320 : 880;
    o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.0001, t + d);
    g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.2);
    o.start(t + d); o.stop(t + d + 0.22);
  });
}

let wake = null;
async function requestWake() {
  if (!S.session || !('wakeLock' in navigator) || wake) return;
  try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch (e) { /* не поддерживается */ }
}
function releaseWake() { try { wake && wake.release(); } catch (e) { /* пусто */ } wake = null; }

function tick() {
  const now = Date.now();
  if (S.session) {
    const t = fmtClock((now - S.session.startedAt) / 1000);
    document.querySelectorAll('[data-el="elapsed"]').forEach(el => { el.textContent = t; });
  }
  if (S.rest) {
    const left = (S.rest.endsAt - now) / 1000;
    if (left <= 0) {
      S.rest = null; save(); renderRest(); restDone();
    } else {
      const el = document.querySelector('[data-el="rest"]');
      if (el) el.textContent = fmtClock(Math.ceil(left));
      // лёгкий отсчёт на последних 3 секундах
      const sec = Math.ceil(left);
      if (sec <= 3 && S.rest.buzz !== sec) { S.rest.buzz = sec; haptic('rigid'); if (S.sound) tickSound(); }
      const bar = document.querySelector('.rest-bar i');
      if (bar) bar.style.width = Math.min(100, left * 1000 / S.rest.total * 100) + '%';
    }
  }
}
setInterval(tick, 250);

/* ---------- Итог тренировки ---------- */
VIEWS.done = ({ id }) => {
  const r = S.history.find(x => x.id === id);
  if (!r) { nav = [{ v: 'home' }]; return VIEWS.home(); }
  const sets = r.ex.reduce((a, e) => a + e.sets.length, 0);
  const prev = S.history.filter(x => x.pid === r.pid && x.day === r.day && x.date < r.date).pop();
  const diff = prev && prev.tonnage ? Math.round((r.tonnage - prev.tonnage) / prev.tonnage * 100) : null;
  const prs = r.prs || [];
  return `<div class="page">
    <div class="done-hero"><div class="ok">${sv('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 46, 2.4)}</div>
      <h1>Тренировка<br>завершена</h1><p class="muted">${esc((prog(r.pid) || {}).title || '')} · день ${esc(r.day)}</p></div>
    <div class="stats">
      <div class="stat"><b>${fmtClock(r.dur)}</b><span>время</span></div>
      <div class="stat"><b>${fmtTon(r.tonnage)}</b><span>тоннаж</span></div>
      <div class="stat"><b>${sets}</b><span>${plural(sets, 'подход', 'подхода', 'подходов')}</span></div>
    </div>
    ${diff !== null && r.tonnage ? `<div class="cmp ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '▲' : '▼'} ${diff >= 0 ? '+' : ''}${diff}% тоннажа<small>к прошлому дню ${esc(r.day)} (${fmtTon(prev.tonnage)})</small></div>` : ''}
    ${prs.length ? `<div class="prs"><div class="sec-title">🏆 ${prs.length === 1 ? 'Новый рекорд' : 'Новые рекорды'}</div>
      ${prs.map(p => `<div class="pr-row"><span>${esc(exName(p.id))}</span><b>${fmtNum(p.w)} кг × ${fmtNum(p.r)}</b><small>${p.kind === 'w' ? 'рекорд веса' : 'лучший подход'}</small></div>`).join('')}</div>` : ''}
    ${(r.ach || []).length ? `<div class="prs"><div class="sec-title">🏅 ${r.ach.length === 1 ? 'Новое достижение' : 'Новые достижения'}</div>
      ${r.ach.map(id => ACH.find(a => a.id === id)).filter(Boolean).map(a => `<div class="pr-row"><span>${a.e} ${esc(a.t)}</span><b></b><small>${esc(a.d)}</small></div>`).join('')}</div>` : ''}
    ${(() => { const st = weekStats(); return st.done === st.goal ? `<div class="cmp up">🔥 Неделя засчитана<small>серия ${st.full} ${plural(st.full, 'неделя', 'недели', 'недель')}</small></div>` : st.done < st.goal ? `<div class="cmp">🔥 ${st.done} из ${st.goal} на этой неделе<small>до зачёта недели ещё ${st.goal - st.done}</small></div>` : ''; })()}
    ${recordCard(r, false)}
    <button class="btn" data-act="share-rec" data-arg="${r.id}">${I.share || ''}Поделиться</button>
    <button class="btn ghost" data-act="tab" data-arg="home">Отлично</button>
  </div>`;
};

// текст для «Поделиться»
function shareText(r) {
  const sets = r.ex.reduce((a, e) => a + e.sets.length, 0);
  const lines = [`💪 Тренировка в FORMA`, `${(prog(r.pid) || {}).title || ''} · день ${r.day}`, '',
    `⏱ ${fmtClock(r.dur)}   🏋️ ${fmtTon(r.tonnage)}   ✅ ${sets} ${plural(sets, 'подход', 'подхода', 'подходов')}`];
  if ((r.prs || []).length) {
    lines.push('', '🏆 Рекорды:');
    r.prs.forEach(p => lines.push(`• ${exName(p.id)}: ${fmtNum(p.w)} кг × ${fmtNum(p.r)}`));
  }
  return lines.join('\n');
}
function shareRec(id) {
  const r = S.history.find(x => x.id === id);
  if (!r) return;
  const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : location.origin + location.pathname;
  const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText(r))}`;
  if (inTG && tgv('6.1')) tg.openTelegramLink(url);
  else if (navigator.share) navigator.share({ text: shareText(r), url: link }).catch(() => {});
  else window.open(url, '_blank');
}

function recordCard(r, withDelete = true) {
  const p = prog(r.pid);
  const d = new Date(r.date);
  return `<div class="rec">
    <div class="rec-h"><div><b>${esc(p ? p.title : 'Тренировка')} · день ${esc(r.day)}</b>
      <small>${pad(d.getHours())}:${pad(d.getMinutes())} · ${fmtClock(r.dur)} · ${fmtTon(r.tonnage)}</small></div>
      ${withDelete ? `<button class="del" data-act="del-rec" data-arg="${r.id}" aria-label="Удалить">${I.trash}</button>` : ''}</div>
    ${r.ex.map(e => `<div class="rec-line"><span>${esc(exName(e.id))}</span><span>${e.sets.map(x => fmtSet(e, x, true)).join(', ')}</span></div>`).join('')}
  </div>`;
}

/* ---------- Сводка ---------- */
function histByDay() {
  const m = {};
  S.history.forEach(r => { (m[dkey(r.date)] = m[dkey(r.date)] || []).push(r); });
  return m;
}
function weekCount() {
  const mon = mondayOf(new Date()).getTime();
  return S.history.filter(r => new Date(r.date).getTime() >= mon).length;
}

VIEWS.summary = () => {
  const tabs = [['train', 'Тренировки'], ['measure', 'Замеры'], ['ton', 'Тоннаж']];
  const body = ui.sumTab === 'train' ? calendarView() : ui.sumTab === 'ton' ? tonnageView() : measureView();
  return `<div class="page has-nav">
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${ui.sumTab === k ? 'on' : ''}" data-act="sum-tab" data-arg="${k}">${l}</button>`).join('')}</div>
    ${body}
  </div>`;
};

function calendarView() {
  const m = ui.calMonth, byDay = histByDay();
  const now = new Date(), todayK = dkey(now);
  const isCurMonth = m.getFullYear() === now.getFullYear() && m.getMonth() === now.getMonth();
  const first = mondayOf(m);
  const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const offset = (m.getDay() + 6) % 7;
  const cells = Math.ceil((offset + daysInMonth) / 7) * 7;

  let grid = WD.map(w => `<div class="wd">${w}</div>`).join('');
  for (let n = 0; n < cells; n++) {
    const d = addDays(first, n), k = dkey(d);
    const cls = [
      d.getMonth() !== m.getMonth() ? 'out' : '',
      d > now && k !== todayK ? 'future' : '',
      byDay[k] ? 'has' : '',
      k === todayK ? 'today' : '',
      k === ui.selDay ? 'sel' : '',
    ].join(' ');
    grid += `<button class="${cls}" data-act="sel-day" data-arg="${k}">${d.getDate()}</button>`;
  }

  const sd = new Date(ui.selDay + 'T12:00:00');
  const recs = byDay[ui.selDay] || [];
  return `<div class="cal-head"><h1>${MONTHS[m.getMonth()]}<small>${m.getFullYear()}</small></h1>
      <div class="arrows"><button class="icon-btn" data-act="cal" data-arg="-1">${I.back}</button>
      <button class="icon-btn ${isCurMonth ? 'ghost' : ''}" data-act="cal" data-arg="1" ${isCurMonth ? 'disabled' : ''}>${I.fwd}</button></div></div>
    <div class="cal">${grid}</div>
    <div class="day-title">${sd.getDate()} ${MONTHS_G[sd.getMonth()]}, ${WD[(sd.getDay() + 6) % 7].toLowerCase()}</div>
    ${recs.length ? recs.map(r => recordCard(r)).join('') : `<div class="empty"><div class="big">🗓️</div>В этот день тренировок не было</div>`}`;
}

function tonnageView() {
  const total = S.history.reduce((a, r) => a + r.tonnage, 0);
  const n = S.history.length;
  const mon = mondayOf(new Date());
  const weeks = Array.from({ length: 8 }, (_, j) => {
    const start = addDays(mon, -7 * (7 - j)), end = addDays(start, 7);
    const sum = S.history.filter(r => { const t = new Date(r.date); return t >= start && t < end; }).reduce((a, r) => a + r.tonnage, 0);
    return { start, sum, now: j === 7 };
  });
  const max = Math.max(1, ...weeks.map(w => w.sum));

  const since = addDays(new Date(), -30);
  const byMuscle = {};
  S.history.filter(r => new Date(r.date) >= since).forEach(r => r.ex.forEach(e => {
    if (isCardio(e)) return;
    const mu = exMuscle(e.id) || 'другое';
    byMuscle[mu] = (byMuscle[mu] || 0) + setTonnage(e.sets);
  }));
  const mus = Object.entries(byMuscle).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const mmax = Math.max(1, ...mus.map(x => x[1]));

  return `<div class="stats">
      <div class="stat"><b>${n}</b><span>${plural(n, 'тренировка', 'тренировки', 'тренировок')}</span></div>
      <div class="stat"><b>${fmtTon(total)}</b><span>всего поднято</span></div>
      <div class="stat"><b>${fmtTon(n ? total / n : 0)}</b><span>в среднем</span></div>
    </div>
    <div class="sec-title">Тоннаж по неделям</div>
    <div class="bars">${weeks.map(w => `<div class="${w.now ? 'now' : ''}">
      <em>${w.sum ? fmtTon(w.sum) : ''}</em><i style="height:${(w.sum / max * 100).toFixed(1)}%"></i>
      <small>${pad(w.start.getDate())}.${pad(w.start.getMonth() + 1)}</small></div>`).join('')}</div>
    <div class="sec-title" style="margin-top:24px">По группам мышц<small>30 дней</small></div>
    ${mus.length ? mus.map(([k, v]) => `<div class="hbar"><div class="t"><span>${esc(k)}</span><span>${fmtTon(v)}</span></div>
      <div class="track"><i style="width:${(v / mmax * 100).toFixed(1)}%"></i></div></div>`).join('')
      : `<p class="muted">Пока нет данных. Отмечайте подходы с весом — здесь появится статистика.</p>`}`;
}

const MEAS = [['weight', 'Вес тела', 'кг'], ['chest', 'Грудь', 'см'], ['waist', 'Талия', 'см'], ['hips', 'Бёдра', 'см'], ['arm', 'Бицепс', 'см'], ['thigh', 'Бедро', 'см']];
// график выбранного замера + изменение с первого замера
function measureChart() {
  const avail = MEAS.filter(([k]) => S.measures.filter(m => m[k]).length > 1);
  if (!avail.length) return '';
  const k = avail.some(([x]) => x === ui.measK) ? ui.measK : avail[0][0];
  const [, label, unit] = MEAS.find(([x]) => x === k);
  const vals = S.measures.filter(m => m[k]);
  const d = vals[vals.length - 1][k] - vals[0][k];
  return `<div class="sec-title" style="margin-top:24px">Динамика</div>
    ${avail.length > 1 ? `<div class="chips">${avail.map(([x, l]) => `<button class="chip ${x === k ? 'on' : ''}" data-act="meas-k" data-arg="${x}">${l}</button>`).join('')}</div>` : ''}
    <div class="rec meas-chart"><div class="rec-h"><div><b>${label}</b><small>с первого замера: <span class="${d > 0 ? 'plus' : d < 0 ? 'minus' : ''}">${d > 0 ? '+' : ''}${fmtNum(d)} ${unit}</span></small></div></div>
    ${lineChart(vals.slice(-16).map(m => ({ t: shortDate(m.date), v: m[k] })), unit)}</div>`;
}
function measureView() {
  const last = S.measures[S.measures.length - 1] || {};
  const list = S.measures.map((m, i) => ({ m, i })).reverse();
  return `<div class="form-grid">${MEAS.map(([k, l, u]) => `<div class="mfield"><label>${l}</label>
      <div><input inputmode="decimal" data-m="${k}" placeholder="${last[k] ? fmtNum(last[k]) : '—'}"><span>${u}</span></div></div>`).join('')}</div>
    <button class="btn" data-act="save-measure">Сохранить замер</button>
    ${measureChart()}
    <div class="sec-title" style="margin-top:24px">История замеров</div>
    ${list.length ? list.map(({ m, i }) => {
      const d = new Date(m.date);
      return `<div class="rec"><div class="rec-h"><div><b>${d.getDate()} ${MONTHS_G[d.getMonth()]} ${d.getFullYear()}</b></div>
        <button class="del" data-act="del-measure" data-arg="${i}">${I.trash}</button></div>
        ${MEAS.filter(([k]) => m[k]).map(([k, l, u]) => `<div class="rec-line"><span>${l}</span><span>${fmtNum(m[k])} ${u}</span></div>`).join('')}</div>`;
    }).join('') : `<p class="muted">Записывайте замеры раз в 1–2 недели, утром натощак.</p>`}`;
}

/* ---------- Питание: расчёт КБЖУ ---------- */
const ACTIVITY = [
  ['Почти без движения', 'Сидячая работа, тренировок нет или они редкие. Меньше 5 тысяч шагов в день.', 1.2],
  ['1–2 тренировки в неделю', 'Немного двигаетесь в течение дня и иногда тренируетесь.', 1.375],
  ['3–4 тренировки в неделю', 'Регулярные тренировки и обычная бытовая активность. Подходит большинству тех, кто ходит в зал без физической работы.', 1.55],
  ['5–6 тренировок в неделю', 'Частые тренировки или много шагов каждый день (10+ тысяч).', 1.725],
  ['Тяжёлая нагрузка', 'Физическая работа плюс тренировки или две тренировки в день.', 1.9],
];
const GOALS = {
  cut:  { name: 'Худею',       k: 0.85, p: 2.0, note: 'Дефицит около 15%. На дефиците рабочие веса могут немного снизиться: это нормально.' },
  keep: { name: 'Поддержание', k: 1.0,  p: 1.8, note: 'Калорий столько, сколько вы тратите: вес держится на месте.' },
  bulk: { name: 'Набор',       k: 1.1,  p: 1.8, note: 'Профицит около 10%. Хороший темп набора: +0,25–0,5 кг в неделю.' },
};
const MACRO = [['p', 'Белки', '#5fc58e'], ['f', 'Жиры', '#ef7a3c'], ['c', 'Углеводы', '#a9a6f5']];

function ageOf(birth) {
  const b = new Date(birth + 'T12:00:00'), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}

// формула Миффлина — Сан Жеора × активность × цель
function calcKbju(b, goal) {
  const age = ageOf(b.birth);
  const bmr = 10 * b.w + 6.25 * b.h - 5 * age + (b.sex === 'f' ? -161 : 5);
  const G = GOALS[goal];
  const kcal = Math.round(bmr * ACTIVITY[b.act - 1][2] * G.k);
  const p = Math.round(b.w * G.p);
  const f = Math.round(Math.max(b.w * 0.8, kcal * 0.25 / 9));
  const c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
  return { kcal, p, f, c };
}

function donut(r) {
  const cals = { p: r.p * 4, f: r.f * 9, c: r.c * 4 };
  const total = cals.p + cals.f + cals.c || 1;
  const R = 80, L = 2 * Math.PI * R, gap = 6;
  let off = 0, arcs = '', labels = '';
  MACRO.forEach(([k, , col]) => {
    const share = cals[k] / total, len = Math.max(0, share * L - gap);
    arcs += `<circle r="${R}" cx="110" cy="110" fill="none" stroke="${col}" stroke-width="26" stroke-dasharray="${len} ${L}" stroke-dashoffset="${-off}" transform="rotate(-90 110 110)"/>`;
    const mid = (off + share * L / 2) / L * 2 * Math.PI - Math.PI / 2;
    labels += `<span style="left:${(50 + Math.cos(mid) * 58).toFixed(1)}%;top:${(50 + Math.sin(mid) * 58).toFixed(1)}%">${Math.round(share * 100)}%</span>`;
    off += share * L;
  });
  return `<div class="donut"><svg viewBox="0 0 220 220">${arcs}</svg>${labels}
    <div class="donut-c"><b>${r.kcal}</b><small>ккал</small></div></div>`;
}

VIEWS.food = () => {
  if (!S.body) return VIEWS.bodyform({ first: true });
  const r = calcKbju(S.body, S.goal);
  return `<div class="page has-nav">
    <div class="tabs"><button class="on">Расчёт КБЖУ</button></div>
    <div class="muted" style="margin-bottom:6px">Суточная норма калорий 🔥</div>
    ${donut(r)}
    <div class="stats">${MACRO.map(([k, l, col]) => `<div class="stat macro"><i style="background:${col}"></i><span>${l}</span><b>${r[k]} г</b></div>`).join('')}</div>
    <div class="seg">${Object.entries(GOALS).map(([k, G]) => `<button class="${S.goal === k ? 'on' : ''}" data-act="goal" data-arg="${k}">${G.name}</button>`).join('')}</div>
    <p class="muted center small">${GOALS[S.goal].note}<br>Подробнее про питание — во вкладке «Обзор».</p>
    <button class="btn ghost" data-act="body-edit">Параметры тела</button>
    <button class="btn ghost" data-act="food-guides">Гайды про КБЖУ</button>
  </div>`;
};

VIEWS.bodyform = ({ first } = {}) => {
  const lastW = [...S.measures].reverse().find(m => m.weight);
  const b = ui.bd || (ui.bd = Object.assign({ w: lastW ? lastW.weight : '', h: '', birth: '', sex: 'm', act: 3 }, S.body || {}));
  const A = ACTIVITY[b.act - 1];
  return `<div class="page ${first ? 'has-nav' : ''}">
    ${first ? `<div class="tabs"><button class="on">Расчёт КБЖУ</button></div>`
      : `<div class="topbar"><button class="icon-btn" data-act="back">${I.back}</button><h1>Параметры тела</h1><span></span></div>`}
    <div class="muted" style="margin-bottom:10px">Расскажите о себе</div>
    <div class="form-grid">
      <div class="mfield"><label>Вес</label><div><input inputmode="decimal" data-b="w" value="${esc(b.w)}" placeholder="—"><span>кг</span></div></div>
      <div class="mfield"><label>Рост</label><div><input inputmode="numeric" data-b="h" value="${esc(b.h)}" placeholder="—"><span>см</span></div></div>
    </div>
    <div class="mfield" style="margin-top:10px"><label>Дата рождения</label><div><input type="date" data-b="birth" value="${esc(b.birth)}" max="${dkey(new Date())}"></div></div>
    <div class="seg" style="margin-top:12px">
      <button class="${b.sex === 'm' ? 'on' : ''}" data-act="bd-sex" data-arg="m">Мужчина</button>
      <button class="${b.sex === 'f' ? 'on' : ''}" data-act="bd-sex" data-arg="f">Женщина</button>
    </div>
    <div class="muted" style="margin:20px 0 6px">Уровень активности</div>
    <input type="range" class="act-range" min="1" max="5" step="1" value="${b.act}" data-b="act">
    <div class="act-nums">${[1, 2, 3, 4, 5].map(n => `<span class="${n === +b.act ? 'on' : ''}">${n}</span>`).join('')}</div>
    <div class="act-card"><b data-el="act-t">${A[0]}</b><p data-el="act-d">${A[1]}</p></div>
    <button class="btn" data-act="body-save">Рассчитать</button>
  </div>`;
};

/* ---------- Обзор: гайды и упражнения ---------- */
const guide = id => GUIDES.find(g => g.id === id);
const MUSCLES = [...new Set(Object.values(LIB).map(x => x[1]))];
const guideTags = g => `<div class="g-tags"><span>~${g.min} мин</span>${g.imp ? '<span class="imp">Важное</span>' : ''}</div>`;

VIEWS.library = () => {
  const tabs = [['guides', 'Гайды'], ['ex', 'Упражнения']];
  return `<div class="page has-nav">
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${ui.libTab === k ? 'on' : ''}" data-act="lib-tab" data-arg="${k}">${l}</button>`).join('')}</div>
    ${ui.libTab === 'guides' ? guidesList() : exLibrary()}
  </div>`;
};

function guidesList() {
  let list = GUIDES;
  if (ui.gSaved) list = list.filter(g => S.guidesSaved.includes(g.id));
  if (ui.gMode === 'new') list = list.filter(g => !S.guidesRead.includes(g.id));
  const cats = GUIDE_CATS.filter(c => list.some(g => g.cat === c));
  const chips = `<div class="chips">
    <button class="chip icon ${ui.gSaved ? 'on' : ''}" data-act="g-saved" aria-label="Закладки">${ui.gSaved ? I.bmFill : I.bm}</button>
    ${cats.map(c => `<button class="chip" data-act="g-cat" data-arg="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
  const body = cats.length ? cats.map(c => `<div class="g-sec" data-cat="${esc(c)}">${esc(c)}</div>
    ${list.filter(g => g.cat === c).map(g => `<button class="g-row" data-act="open-guide" data-arg="${g.id}">
      <div><b>${esc(g.title)}</b>${guideTags(g)}</div>${S.guidesRead.includes(g.id) ? `<i class="g-read">${I.check}</i>` : ''}</button>`).join('')}`).join('')
    : `<div class="empty"><div class="big">${ui.gSaved ? '🔖' : '🎉'}</div>${ui.gSaved ? 'Сохраняйте гайды закладкой — они появятся здесь.' : 'Вы прочитали все гайды.'}</div>`;
  return `${chips}${body}
    <div class="mode">
      <button class="${ui.gMode === 'all' ? 'on' : ''}" data-act="g-mode" data-arg="all">Все гайды</button>
      <button class="${ui.gMode === 'new' ? 'on' : ''}" data-act="g-mode" data-arg="new">Новые</button>
    </div>`;
}

VIEWS.guide = ({ id }) => {
  const g = guide(id);
  if (!g) return VIEWS.library();
  const i = GUIDES.indexOf(g), next = GUIDES[i + 1];
  const saved = S.guidesSaved.includes(id);
  return `<div class="page">
    <div class="topbar">
      <button class="icon-btn" data-act="back">${I.back}</button><span></span>
      <button class="icon-btn" data-act="g-save" data-arg="${id}" aria-label="В закладки">${saved ? I.bmFill : I.bm}</button>
    </div>
    <article class="guide">
      <div class="muted g-cat">${esc(g.cat)}</div>
      <h1>${esc(g.title)}</h1>${guideTags(g)}
      ${g.text.map(t => `<p>${esc(t)}</p>`).join('')}
    </article>
    ${next ? `<button class="opt" data-act="next-guide" data-arg="${next.id}"><span>${esc(next.title)}<small>Следующий гайд</small></span>${I.fwd}</button>` : ''}
  </div>`;
};

function exBest(id) {
  const l = S.last[id];
  if (!l || !l.w) return '';
  const best = Math.max(0, ...l.w.map(num));
  return best ? `${fmtNum(best)} кг` : '';
}

function exLibrary() {
  const g = ui.exGroup || MUSCLES[0];
  const ids = Object.keys(LIB).filter(id => LIB[id][1] === g).sort((a, b) => exName(a).localeCompare(exName(b), 'ru'));
  return `<div class="chips">${MUSCLES.map(m => `<button class="chip ${m === g ? 'on' : ''}" data-act="ex-group" data-arg="${esc(m)}">${esc(m[0].toUpperCase() + m.slice(1))}</button>`).join('')}</div>
    <div class="g-sec">${esc(g)}</div>
    ${ids.map(id => `<button class="lib-row" data-act="open-exinfo" data-arg="${id}">
      <span class="lib-ic">${exPic(id)}</span><b>${esc(exName(id))}</b><span class="muted">${exBest(id) || '—'}</span></button>`).join('')}`;
}

VIEWS.exinfo = ({ id }) => {
  const mu = exMuscle(id);
  const inProgs = PROGRAMS.filter(p => p.plan.some(d => d.ex.some(e => e.id === id) || (d.cardio && d.cardio.id === id) || (d.cool && d.cool.id === id)));
  const best = exBest(id);
  return `<div class="page">
    <div class="topbar"><button class="icon-btn" data-act="back">${I.back}</button><span></span><span></span></div>
    <div class="exinfo">
      <div class="exinfo-ic">${exPic(id, true)}</div>
      <h1>${esc(exName(id))}</h1>
      <div class="muted">${esc(mu)}</div>
    </div>
    <div class="exinfo-btns">
      <button data-act="lib-tech" data-arg="${id}">${I.play}<span>Техника</span></button>
      <button data-act="lib-hist" data-arg="${id}">${I.history}<span>История</span></button>
    </div>
    ${(() => { const st = exStats(id); return st.best ? `<div class="stats two">
      <div class="stat"><b>${fmtNum(st.maxW)} кг</b><span>🏆 рекорд веса</span></div>
      <div class="stat"><b>${fmtNum(st.best.w)} × ${fmtNum(st.best.r)}</b><span>лучший подход</span></div></div>` : best ? `<div class="stats"><div class="stat"><b>${best}</b><span>последний максимум</span></div></div>` : ''; })()}
    ${inProgs.length ? `<div class="label">Есть в программах</div><div class="list">${inProgs.map(p =>
      `<button data-act="open-program" data-arg="${p.id}"><div>${p.emoji} ${esc(p.title)}</div>${I.fwd}</button>`).join('')}</div>` : ''}
  </div>`;
};

function techSheet(id, extra = '') {
  openSheet(`<h3>${esc(exName(id))}</h3>
    <p><b>Группа мышц:</b> ${esc(exMuscle(id))}</p>
    <p>${esc(exTip(id))}</p>${extra}
    <button class="btn ghost" data-act="sheet-close">Понятно</button>`);
}

/* ---------- Прогресс и рекорды ---------- */
// расчётный максимум на 1 повтор (формула Эпли) — чтобы сравнивать подходы с разными повторами
const e1rm = (w, r) => w * (1 + r / 30);
function exStats(id, beforeDate) {
  let maxW = 0, best = null, n = 0;
  S.history.forEach(r => {
    if (beforeDate && r.date >= beforeDate) return;
    const e = r.ex.find(x => x.id === id);
    if (!e || isCardio(e)) return;
    n++;
    e.sets.forEach(x => {
      if (x.w > maxW) maxW = x.w;
      const v = e1rm(x.w, x.r);
      if (x.w && (!best || v > best.v)) best = { v, w: x.w, r: x.r };
    });
  });
  return { maxW, best, n };
}
// новые рекорды в тренировке: по весу или (если вес не вырос) по лучшему подходу
function findRecords(ex, date) {
  const out = [];
  ex.forEach(e => {
    if (isCardio(e)) return;
    const prev = exStats(e.id, date);
    if (!prev.n || !prev.best) return; // первый раз — не рекорд
    const maxW = Math.max(0, ...e.sets.map(x => x.w));
    if (maxW > prev.maxW) { const s = e.sets.find(x => x.w === maxW); out.push({ id: e.id, kind: 'w', w: maxW, r: s.r }); return; }
    const top = e.sets.filter(x => x.w).reduce((b, x) => (!b || e1rm(x.w, x.r) > e1rm(b.w, b.r) ? x : b), null);
    if (top && e1rm(top.w, top.r) > prev.best.v + 0.01) out.push({ id: e.id, kind: 'set', w: top.w, r: top.r });
  });
  return out;
}

// линейный график: pts = [{ t: подпись, v: число }]
function lineChart(pts, unit) {
  if (pts.length < 2) return '';
  const W = 320, H = 130, PX = 10, PT = 24, PB = 10;
  const vs = pts.map(p => p.v), mn = Math.min(...vs), mx = Math.max(...vs), span = mx - mn || 1;
  const xy = pts.map((p, i) => [PX + (W - 2 * PX) * i / (pts.length - 1), PT + (H - PT - PB) * (1 - (p.v - mn) / span)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)} ${H} L${xy[0][0].toFixed(1)} ${H} Z`;
  const iMax = vs.indexOf(mx), [lx, ly] = xy[xy.length - 1], [mxX, mxY] = xy[iMax];
  const anchor = x => x < 40 ? 'start' : x > W - 40 ? 'end' : 'middle';
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}">
      <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c6ff3d" stop-opacity=".28"/><stop offset="1" stop-color="#c6ff3d" stop-opacity="0"/></linearGradient></defs>
      <path d="${area}" fill="url(#cg)"/><path d="${line}" fill="none" stroke="#c6ff3d" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
      ${xy.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#000" stroke="#c6ff3d" stroke-width="2"/>`).join('')}
      ${iMax !== xy.length - 1 ? `<text x="${mxX.toFixed(1)}" y="${(mxY - 9).toFixed(1)}" text-anchor="${anchor(mxX)}" class="ct mute">${fmtNum(mx)}</text>` : ''}
      <text x="${lx.toFixed(1)}" y="${(ly - 9).toFixed(1)}" text-anchor="end" class="ct">${fmtNum(vs[vs.length - 1])} ${unit}</text>
    </svg><div class="chart-x"><span>${esc(pts[0].t)}</span><span>${esc(pts[pts.length - 1].t)}</span></div></div>`;
}
const shortDate = d => { d = new Date(d); return `${d.getDate()} ${MONTHS_G[d.getMonth()].slice(0, 3)}`; };

function historySheet(id) {
  const all = S.history.filter(r => r.ex.some(e => e.id === id));
  const items = all.slice(-15).reverse();
  const cardio = exMuscle(id) === 'кардио';
  const pts = cardio ? [] : all.slice(-12).map(r => ({ t: shortDate(r.date), v: Math.max(0, ...r.ex.find(x => x.id === id).sets.map(x => num(x.w))) })).filter(p => p.v > 0);
  const st = cardio ? null : exStats(id);
  const head = st && st.best ? `<div class="stats two">
      <div class="stat"><b>${fmtNum(st.maxW)} кг</b><span>🏆 рекорд веса</span></div>
      <div class="stat"><b>${fmtNum(st.best.w)} × ${fmtNum(st.best.r)}</b><span>лучший подход</span></div></div>
    ${pts.length > 1 ? `<div class="sec-title">Рабочий вес<small>макс. за тренировку</small></div>${lineChart(pts, 'кг')}` : ''}` : '';
  openSheet(`<h3>История · ${esc(exName(id))}</h3>${head}${items.length ? items.map(r => {
    const e = r.ex.find(x => x.id === id), d = new Date(r.date);
    const best = isCardio(e) ? 0 : Math.max(...e.sets.map(x => num(x.w)));
    const pr = (r.prs || []).some(p => p.id === id);
    return `<div class="hist-item"><b>${d.getDate()} ${MONTHS_G[d.getMonth()]}</b>${best ? ` <span class="kg">макс ${fmtNum(best)} кг</span>` : ''}${pr ? ' <span class="pr">🏆 рекорд</span>' : ''}
      <div>${e.sets.map(x => fmtSet(e, x)).join(' · ')}</div>${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}</div>`;
  }).join('') : `<p class="muted">Вы ещё не делали это упражнение. После тренировки здесь появятся веса и повторы.</p>`}`);
}

/* ---------- Серия недель ---------- */
// неделя засчитана, если тренировок в ней не меньше цели (S.weekGoal)
function weekStats() {
  const goal = S.weekGoal || 2;
  const cnt = {};
  S.history.forEach(r => { const k = dkey(mondayOf(r.date)); cnt[k] = (cnt[k] || 0) + 1; });
  const cur = mondayOf(new Date()), curK = dkey(cur);
  const done = cnt[curK] || 0;
  let base = 0;
  for (let w = addDays(cur, -7); (cnt[dkey(w)] || 0) >= goal; w = addDays(w, -7)) base++;
  const full = done >= goal ? base + 1 : base;
  // лучшая серия за всё время
  let best = 0;
  const keys = Object.keys(cnt).sort();
  if (keys.length) {
    let run = 0;
    for (let w = mondayOf(keys[0] + 'T12:00:00'); w <= cur; w = addDays(w, 7)) {
      run = (cnt[dkey(w)] || 0) >= goal ? run + 1 : (dkey(w) === curK ? run : 0);
      best = Math.max(best, run);
    }
  }
  return { goal, done, base, full, best, wk: curK };
}
function streakChip() {
  const st = weekStats();
  return `<button class="streak-chip ${st.full ? 'on' : ''}" data-act="streak" aria-label="Серия недель">
    <span>🔥</span><b>${st.full}</b></button>`;
}
function streakSheet() {
  const st = weekStats();
  const left = 7 - (new Date().getDay() + 6) % 7; // дней до конца недели, включая сегодня
  const status = st.done >= st.goal
    ? `Неделя засчитана ✅ Серия: ${st.full} ${plural(st.full, 'неделя', 'недели', 'недель')}.`
    : st.base
      ? `Чтобы не прервать серию из ${st.base} ${plural(st.base, 'недели', 'недель', 'недель')}, нужно ещё ${st.goal - st.done} ${plural(st.goal - st.done, 'тренировка', 'тренировки', 'тренировок')}${left > 1 ? ` — осталось ${left} ${plural(left, 'день', 'дня', 'дней')}, включая сегодня` : ' — сегодня последний день'}.`
      : `Сделай ${st.goal} ${plural(st.goal, 'тренировку', 'тренировки', 'тренировок')} за неделю — и серия начнётся.`;
  openSheet(`<div class="streak-hero"><div class="flame">🔥</div><b>${st.full}</b><span>${plural(st.full, 'неделя', 'недели', 'недель')} подряд</span></div>
    <div class="streak-week">${Array.from({ length: st.goal }, (_, i) => `<i class="${i < st.done ? 'on' : ''}"></i>`).join('')}<small>${st.done} из ${st.goal} на этой неделе</small></div>
    <p>${status}</p>
    <div class="stats two"><div class="stat"><b>${st.best}</b><span>лучшая серия</span></div><div class="stat"><b>${st.goal}</b><span>тренировок в неделю — цель</span></div></div>
    <div class="label">Цель на неделю</div>
    <div class="goal-pick">${[1, 2, 3, 4, 5, 6].map(n => `<button class="${n === st.goal ? 'on' : ''}" data-act="week-goal" data-arg="${n}">${n}</button>`).join('')}</div>`);
}

/* ---------- Достижения ---------- */
const ACH = [
  { id: 'first', e: '🎉', t: 'Первый шаг', d: 'Завершить первую тренировку', v: s => s.n, max: 1 },
  { id: 'w10', e: '💪', t: 'Втянулся', d: '10 тренировок', v: s => s.n, max: 10 },
  { id: 'w25', e: '🏋️', t: 'Завсегдатай', d: '25 тренировок', v: s => s.n, max: 25 },
  { id: 'w50', e: '🦾', t: 'Железный', d: '50 тренировок', v: s => s.n, max: 50 },
  { id: 'w100', e: '👑', t: 'Сотня', d: '100 тренировок', v: s => s.n, max: 100 },
  { id: 'st2', e: '🔥', t: 'Разгон', d: 'Серия 2 недели подряд', v: s => s.best, max: 2 },
  { id: 'st4', e: '📅', t: 'Месяц без пропусков', d: 'Серия 4 недели подряд', v: s => s.best, max: 4 },
  { id: 'st8', e: '⚡', t: 'Привычка', d: 'Серия 8 недель подряд', v: s => s.best, max: 8 },
  { id: 'st12', e: '🌋', t: 'Квартал огня', d: 'Серия 12 недель подряд', v: s => s.best, max: 12 },
  { id: 'ton1', e: '🪨', t: 'Тонна', d: 'Поднять 1 т за одну тренировку', v: s => s.maxTon / 1000, max: 1 },
  { id: 'ton5', e: '🚛', t: 'Грузовик', d: 'Поднять 5 т за одну тренировку', v: s => s.maxTon / 1000, max: 5 },
  { id: 'tot100', e: '🏔️', t: 'Сто тонн', d: 'Всего поднято 100 т', v: s => s.total / 1000, max: 100 },
  { id: 'pr1', e: '🏆', t: 'Рекордсмен', d: 'Побить свой рекорд', v: s => s.prs, max: 1 },
  { id: 'pr10', e: '🥇', t: 'Десять рекордов', d: 'Побить 10 рекордов', v: s => s.prs, max: 10 },
  { id: 'cycle', e: '🔁', t: 'Полный цикл', d: 'Пройти все дни одной программы', v: s => s.cycle, max: 1 },
  { id: 'var20', e: '🧭', t: 'Разносторонний', d: 'Сделать 20 разных упражнений', v: s => s.variety, max: 20 },
  { id: 'early', e: '🌅', t: 'Ранняя пташка', d: 'Начать тренировку до 8 утра', v: s => s.early, max: 1 },
  { id: 'late', e: '🌙', t: 'Ночная смена', d: 'Начать тренировку после 21:00', v: s => s.late, max: 1 },
  { id: 'meas', e: '📏', t: 'Под контролем', d: 'Записать 5 замеров', v: s => s.meas, max: 5 },
];
function achStats() {
  const ex = new Set(), days = {};
  let maxTon = 0, total = 0, prs = 0, early = 0, late = 0;
  S.history.forEach(r => {
    maxTon = Math.max(maxTon, r.tonnage); total += r.tonnage; prs += (r.prs || []).length;
    r.ex.forEach(e => ex.add(e.id));
    (days[r.pid] = days[r.pid] || new Set()).add(r.day);
    const h = new Date(r.date).getHours();
    if (h < 8) early = 1;
    if (h >= 21) late = 1;
  });
  const cycle = Object.entries(days).some(([pid, set]) => { const p = prog(pid); return p && p.plan.every(d => set.has(d.key)); }) ? 1 : 0;
  return { n: S.history.length, best: weekStats().best, maxTon, total, prs, cycle, variety: ex.size, early, late, meas: S.measures.length };
}
// проверить и выдать новые достижения; возвращает список новых
function checkAch(silent) {
  const st = achStats(), fresh = [];
  ACH.forEach(a => { if (!S.ach[a.id] && a.v(st) >= a.max) { S.ach[a.id] = new Date().toISOString(); fresh.push(a); } });
  if (fresh.length) {
    save();
    if (!silent) { haptic('success'); toast(`${fresh[0].e} Достижение: ${fresh[0].t}${fresh.length > 1 ? ` и ещё ${fresh.length - 1}` : ''}`); }
  }
  return fresh;
}
VIEWS.ach = () => {
  const st = achStats();
  const got = ACH.filter(a => S.ach[a.id]).length;
  return `<div class="page">
    <div class="topbar"><button class="icon-btn" data-act="back">${I.back}</button><span></span><span></span></div>
    <h1 class="display" style="font-size:26px;margin:4px 0 4px">Достижения</h1>
    <p class="muted" style="margin:0 0 18px">${got} из ${ACH.length}</p>
    <div class="ach-grid">${ACH.map(a => {
      const on = !!S.ach[a.id], v = Math.min(a.v(st), a.max);
      return `<div class="ach ${on ? 'on' : ''}"><div class="ach-ic">${a.e}</div><b>${a.t}</b><small>${a.d}</small>
        ${on ? `<em>${shortDate(S.ach[a.id])}</em>` : `<div class="ach-bar"><i style="width:${(v / a.max * 100).toFixed(0)}%"></i></div>`}</div>`;
    }).join('')}</div>
  </div>`;
};

/* ---------- Профиль ---------- */
VIEWS.profile = () => {
  const user = inTG && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const total = S.history.reduce((a, r) => a + r.tonnage, 0);
  const time = S.history.reduce((a, r) => a + r.dur, 0);
  return `<div class="page has-nav">
    <div class="home-head"><div><div class="display" style="font-size:22px">${user ? esc(user.first_name) : 'Профиль'}</div>
      <div class="muted" style="font-size:14px;margin-top:4px">${cloud ? '☁️ Данные синхронизируются с Telegram' : '📱 Данные хранятся на этом устройстве'}</div></div></div>
    <div class="stats">
      <div class="stat"><b>${S.history.length}</b><span>тренировок</span></div>
      <div class="stat"><b>${fmtTon(total)}</b><span>поднято</span></div>
      <div class="stat"><b>${Math.round(time / 3600)} ч</b><span>в зале</span></div>
    </div>
    <button class="ach-entry" data-act="open-ach"><span class="ach-row">${ACH.filter(a => S.ach[a.id]).slice(-4).map(a => `<i>${a.e}</i>`).join('') || '<i>🏅</i>'}</span>
      <div><b>Достижения</b><small>${ACH.filter(a => S.ach[a.id]).length} из ${ACH.length}</small></div>${I.fwd}</button>
    <div class="label">Настройки</div>
    <div class="list">
      <button data-act="sound"><div>Звук таймера отдыха<small>Отсчёт 3-2-1 и сигнал в конце. Вибрация работает всегда</small></div><span class="switch ${S.sound ? 'on' : ''}"></span></button>
    </div>
    ${BOT_API && inTG ? remindBlock() : ''}
    <div class="label">Резервная копия</div>
    <div class="list">
      <button data-act="backup-copy"><div>Скопировать данные<small>Вставьте в «Избранное» Telegram — так копия не потеряется</small></div>${I.fwd}</button>
      <button data-act="backup-download"><div>Скачать файл<small>JSON с историей и замерами</small></div>${I.fwd}</button>
      <button data-act="backup-restore"><div>Восстановить<small>Из скопированного текста или файла</small></div>${I.fwd}</button>
    </div>
    <button class="btn danger" data-act="reset">Удалить все данные</button>
  </div>`;
};

/* ---------- Напоминания от бота ---------- */
const REM_TIMES = Array.from({ length: 38 }, (_, i) => { const m = 5 * 60 + i * 30; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; });
function remindBlock() {
  const r = S.remind;
  return `<div class="label">Напоминания</div>
    <div class="list">
      <button data-act="rem-on"><div>Напоминать о тренировке<small>Бот пришлёт сообщение с тренировкой дня</small></div><span class="switch ${r.on ? 'on' : ''}"></span></button>
      <button data-act="streak-warn"><div>Серия под угрозой<small>В субботу вечером, если на неделе не хватает тренировок</small></div><span class="switch ${S.streakWarn ? 'on' : ''}"></span></button>
      <button data-act="rest-push"><div>Конец отдыха в чат<small>Если приложение свёрнуто, бот напишет, что пора на подход</small></div><span class="switch ${S.restPush ? 'on' : ''}"></span></button>
    </div>
    ${r.on ? `<div class="rem-box">
      <div class="rem-days">${WD.map((w, i) => `<button class="${r.days.includes(i) ? 'on' : ''}" data-act="rem-day" data-arg="${i}">${w}</button>`).join('')}</div>
      <label class="rem-time"><span>Время</span><select data-rem-time>${REM_TIMES.map(t => `<option ${t === r.time ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    </div>` : ''}`;
}
// активная программа: та, что сейчас идёт или по которой была последняя тренировка
function activeProgram() {
  if (S.session) return prog(S.session.pid);
  for (let i = S.history.length - 1; i >= 0; i--) { const p = prog(S.history[i].pid); if (p) return p; }
  return S.my.map(prog).find(Boolean) || null;
}
function remindText() {
  const p = activeProgram();
  if (!p) return '💪 Время тренировки! Открой FORMA и выбери программу.';
  const key = defaultDay(p), day = p.plan.find(d => d.key === key);
  const names = planItems(p.id, day).filter(x => !isCardio(x)).map(x => exName(x.id));
  return `💪 Сегодня тренировка!\n<b>${esc(p.title)} · день ${esc(key)}</b>\n\n${names.map(n => '• ' + esc(n)).join('\n')}`;
}
let botTimer;
function botSync(force) {
  if (!BOT_API || !inTG) return;
  clearTimeout(botTimer);
  botTimer = setTimeout(async () => {
    const st = weekStats();
    const body = { remind: S.remind, tz: new Date().getTimezoneOffset(), text: S.remind.on ? remindText() : '',
      week: S.streakWarn ? { wk: st.wk, done: st.done, goal: st.goal, base: st.base, full: st.full } : null };
    const sig = JSON.stringify(body);
    if (!force && sig === S.remindSent) return;
    try {
      const r = await fetch(BOT_API + '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, initData: tg.initData }) });
      if (r.ok) { S.remindSent = sig; save(); } else if (force) toast('Не удалось сохранить напоминания');
    } catch (e) { if (force) toast('Нет связи с ботом'); }
  }, 600);
}
function remindChanged() { save(); render(); botSync(true); }

/* =====================================================================
   ШТОРКИ (bottom sheet)
   ===================================================================== */
let sheetPick = null;
const sheetIsOpen = () => $('#sheet-root').classList.contains('open');
function openSheet(inner, cls = '') {
  const r = $('#sheet-root');
  r.innerHTML = `<div class="sheet-bg" data-act="sheet-close"></div><div class="sheet ${cls}"><div class="grab"></div>${inner}</div>`;
  void r.offsetHeight;
  r.classList.add('open');
  updateBackButton();
}
function closeSheet() {
  const r = $('#sheet-root');
  r.classList.remove('open');
  sheetPick = null;
  if (confirmResolve) { const res = confirmResolve; confirmResolve = null; res(false); }
  setTimeout(() => { if (!r.classList.contains('open')) r.innerHTML = ''; }, 260);
  updateBackButton();
}
function picker(title, items, onPick) {
  openSheet(`<h3>${esc(title)}</h3>${items.map((it, i) => it.group
    ? `<div class="opt-group">${esc(it.group)}</div>`
    : `<button class="opt ${it.on ? 'on' : ''}" data-act="sheet-pick" data-arg="${i}"><span>${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${it.on ? I.check : ''}</button>`).join('')}`);
  sheetPick = i => onPick(items[i], i);
}

function levelPicker(pid) {
  const curL = S.levels[pid] || 'light';
  const items = Object.entries(LEVELS).map(([k, L]) => ({ k, label: L.name, sub: L.sub, on: k === curL }));
  picker('Сложность', items, it => {
    S.levels[pid] = it.k; save(); render();
    if (S.session && S.session.pid === pid) toast('Применится со следующей тренировки');
  });
}

function updateBackButton() {
  if (!tgv('6.1')) return;
  if (nav.length > 1 || sheetIsOpen()) tg.BackButton.show(); else tg.BackButton.hide();
}

/* =====================================================================
   ДЕЙСТВИЯ
   ===================================================================== */
const curEx = () => S.session.exercises[cur().i];

const ACT = {
  tab: k => setTab(k),
  back: () => back(),
  mode: m => { ui.mode = m; haptic('select'); render(); },
  'open-program': pid => go({ v: 'program', pid }),
  'toggle-my': pid => {
    const i = S.my.indexOf(pid);
    if (i < 0) { S.my.push(pid); toast('Добавлено в «Для меня»'); } else S.my.splice(i, 1);
    save(); haptic('select'); render();
  },
  filter: k => {
    const f = FILTERS.find(x => x.k === k);
    picker(f.label, f.opts.map(o => ({ label: f.fmt ? f.fmt(o) : o, v: o })), it => { ui.filters[k] = it.v; render(); });
  },
  'filter-clear': k => { delete ui.filters[k]; render(); },
  resume: () => {
    const s = S.session;
    ui.day[s.pid] = s.day;
    tab = 'home'; nav = [{ v: 'home' }, { v: 'program', pid: s.pid }];
    render(); window.scrollTo(0, 0);
  },
  'pick-day': a => { const [pid, k] = a.split('|'); ui.day[pid] = k; haptic('select'); render(); },
  level: pid => levelPicker(pid),
  'prog-menu': pid => {
    const p = prog(pid);
    const hasSwaps = Object.keys(S.swaps).some(k => k.startsWith(pid + '/'));
    openSheet(`<h3>${esc(p.title)}</h3><p>${esc(p.desc)}</p>
      <button class="opt" data-act="level" data-arg="${pid}"><span>Сложность<small>${LEVELS[S.levels[pid] || 'light'].name}</small></span>${I.fwd}</button>
      <button class="opt" data-act="toggle-my-sheet" data-arg="${pid}"><span>${S.my.includes(pid) ? 'Убрать из «Для меня»' : 'Добавить в «Для меня»'}</span>${S.my.includes(pid) ? I.bmFill : I.bm}</button>
      ${hasSwaps ? `<button class="opt" data-act="reset-swaps" data-arg="${pid}"><span>Вернуть исходные упражнения<small>Сбросить все замены в программе</small></span>${I.swap}</button>` : ''}`);
  },
  'toggle-my-sheet': pid => { closeSheet(); ACT['toggle-my'](pid); },
  'reset-swaps': pid => {
    Object.keys(S.swaps).forEach(k => { if (k.startsWith(pid + '/')) delete S.swaps[k]; });
    save(); closeSheet(); render(); toast('Замены сброшены');
  },
  'start-day': a => { const [pid, k] = a.split('|'); startDay(pid, k, 0); },
  'open-ex': a => { const [pid, k, i] = a.split('|'); startDay(pid, k, +i); },
  'row-menu': (a, el) => {
    const same = menuEl && menuEl.dataset.arg === a;
    closeMenu();
    if (same) return;
    const r = el.getBoundingClientRect();
    const m = document.createElement('div');
    m.className = 'popmenu'; m.dataset.arg = a;
    m.innerHTML = `<button data-act="menu-swap" data-arg="${a}"><span>Заменить</span>${I.swap}</button>
      <button data-act="menu-open" data-arg="${a}"><span>Открыть</span>${I.fwd}</button>`;
    document.body.appendChild(m);
    let top = r.bottom + 4;
    if (top + m.offsetHeight > window.innerHeight - 12) top = r.top - m.offsetHeight - 4;
    m.style.top = top + 'px';
    menuEl = m; menuY = window.scrollY;
    el.closest('.ex-row').classList.add('hl');
    haptic('select');
  },
  'menu-swap': a => {
    closeMenu();
    const [pid, k, i] = a.split('|');
    const it = itemAt(pid, k, +i);
    if (it) openSwap(pid, k, it.slot, it.id);
  },
  'menu-open': a => { closeMenu(); ACT['open-ex'](a); },
  'swap-pick': id => { closeSheet(); applySwap(id); },
  finish: () => finishSession(),
  'ex-go': i => {
    if (i === '' || i == null) return;
    nav[nav.length - 1] = { v: 'ex', i: +i };
    haptic('select'); render(); window.scrollTo(0, 0);
  },
  check: k => toggleSet(+k),
  'share-rec': id => shareRec(id),
  'apply-sugg': () => {
    const e = curEx(), sg = suggestion(e);
    if (!sg) return;
    e.sets.forEach(x => { if (!x.done) x.w = String(sg.w); });
    save(); haptic('success'); render();
  },
  'add-set': () => {
    const e = curEx(), ls = e.sets[e.sets.length - 1];
    e.sets.push({ w: ls ? ls.w : '', r: '', done: false });
    save(); render();
  },
  'del-set': async k => {
    const e = curEx();
    if (e.sets.length < 2) return;
    if (await confirmAsync(`Удалить подход ${+k + 1}?`, 'Удалить', true)) { e.sets.splice(+k, 1); save(); render(); }
  },
  tech: i => {
    const e = S.session.exercises[+i];
    techSheet(e.id, `<p class="muted">План: ${isCardio(e) ? `${esc(e.reps)} минут` : `${esc(repsLabel(e.reps))}, отдых ${e.rest} сек`}.</p>`);
  },
  'ex-history': i => historySheet(S.session.exercises[+i].id),
  'lib-tab': k => { ui.libTab = k; haptic('select'); render(); },
  'g-mode': m => { ui.gMode = m; haptic('select'); render(); },
  'g-saved': () => { ui.gSaved = !ui.gSaved; haptic('select'); render(); },
  'g-cat': (c, btn) => {
    const el = [...document.querySelectorAll('.g-sec')].find(x => x.dataset.cat === c);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 8, behavior: btn ? 'smooth' : 'auto' });
  },
  'open-guide': id => {
    if (!S.guidesRead.includes(id)) { S.guidesRead.push(id); save(); }
    go({ v: 'guide', id });
  },
  'next-guide': id => {
    if (!S.guidesRead.includes(id)) { S.guidesRead.push(id); save(); }
    nav[nav.length - 1] = { v: 'guide', id }; render(); window.scrollTo(0, 0);
  },
  'g-save': id => {
    const i = S.guidesSaved.indexOf(id);
    if (i < 0) { S.guidesSaved.push(id); toast('Гайд в закладках'); } else S.guidesSaved.splice(i, 1);
    save(); haptic('select'); render();
  },
  'ex-group': g => {
    ui.exGroup = g; haptic('select'); render(); window.scrollTo(0, 0);
    const on = document.querySelector('.chip.on');
    if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  },
  'open-exinfo': id => go({ v: 'exinfo', id }),
  'lib-tech': id => techSheet(id),
  'lib-hist': id => historySheet(id),
  goal: k => { S.goal = k; save(); haptic('select'); render(); },
  'body-edit': () => { ui.bd = null; go({ v: 'bodyform' }); },
  'bd-sex': x => { ui.bd.sex = x; haptic('select'); render(); },
  'body-save': () => {
    const b = ui.bd, w = num(b.w), h = num(b.h);
    if (w < 30 || w > 300) { toast('Проверьте вес'); return; }
    if (h < 120 || h > 230) { toast('Проверьте рост'); return; }
    const age = b.birth ? ageOf(b.birth) : NaN;
    if (!(age >= 12 && age <= 100)) { toast('Укажите дату рождения'); return; }
    S.body = { w, h, birth: b.birth, sex: b.sex, act: +b.act };
    ui.bd = null; save(); haptic('success');
    if (nav.length > 1) back(); else render();
    window.scrollTo(0, 0);
  },
  'food-guides': () => {
    ui.libTab = 'guides'; ui.gMode = 'all'; ui.gSaved = false; setTab('library');
    setTimeout(() => ACT['g-cat']('КБЖУ'), 50);
  },
  swap: i => {
    const s = S.session, e = s.exercises[+i];
    openSwap(s.pid, s.day, e.slot ?? +i, e.id);
  },
  'rest-menu': () => {
    const e = curEx();
    const opts = [...new Set([e.rest, 30, 60, 90, 120, 180])].sort((a, b) => a - b);
    picker('Таймер отдыха', opts.map(sec => ({ sec, label: `${fmtClock(sec)}`, sub: sec === e.rest ? 'по плану для упражнения' : '' })), it => startRest(it.sec));
  },
  'rest-add': () => { if (S.rest) { S.rest.endsAt += 15000; S.rest.total += 15000; save(); tick(); } },
  'rest-skip': () => { S.rest = null; save(); renderRest(); restPushCancel(); },
  'sheet-close': () => closeSheet(),
  'confirm-yes': () => { const r = confirmResolve; confirmResolve = null; closeSheet(); if (r) r(true); },
  'confirm-no': () => closeSheet(),
  'sheet-pick': i => { const fn = sheetPick; closeSheet(); if (fn) fn(+i); },
  'sum-tab': k => { ui.sumTab = k; render(); },
  'meas-k': k => { ui.measK = k; haptic('select'); render(); },
  cal: d => { ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() + Number(d), 1); render(); },
  'sel-day': k => { ui.selDay = k; haptic('select'); render(); },
  'del-rec': async id => {
    if (!await confirmAsync('Удалить эту тренировку из истории?', 'Удалить', true)) return;
    S.history = S.history.filter(r => r.id !== id); save(); render();
  },
  'save-measure': () => {
    const m = { date: new Date().toISOString() };
    let any = false;
    document.querySelectorAll('[data-m]').forEach(inp => { const v = num(inp.value); if (v > 0) { m[inp.dataset.m] = v; any = true; } });
    if (!any) { toast('Введите хотя бы одно значение'); return; }
    S.measures.push(m); save(); haptic('success'); render(); toast('Замер сохранён'); setTimeout(() => checkAch(), 1200);
  },
  'del-measure': async i => {
    if (!await confirmAsync('Удалить замер?', 'Удалить', true)) return;
    S.measures.splice(+i, 1); save(); render();
  },
  streak: () => streakSheet(),
  'week-goal': n => { S.weekGoal = +n; save(); haptic('select'); checkAch(); botSync(); streakSheet(); render(); },
  'open-ach': () => go({ v: 'ach' }),
  'streak-warn': () => { S.streakWarn = !S.streakWarn; haptic('select'); remindChanged(); },
  'rest-push': () => { S.restPush = !S.restPush; haptic('select'); save(); render(); },
  'rem-on': () => {
    S.remind.on = !S.remind.on;
    haptic('select');
    // разрешение боту писать первым (если пользователь ещё не нажимал /start)
    if (S.remind.on && tgv('6.9')) try { tg.requestWriteAccess(); } catch (e) { /* пусто */ }
    remindChanged();
    if (S.remind.on) toast('Напоминания включены');
  },
  'rem-day': i => {
    const d = S.remind.days, k = d.indexOf(+i);
    if (k < 0) d.push(+i); else if (d.length > 1) d.splice(k, 1); else { toast('Нужен хотя бы один день'); return; }
    d.sort(); haptic('select'); remindChanged();
  },
  sound: () => { S.sound = !S.sound; if (S.sound) { unlockAudio(); beep(); } save(); render(); },
  'backup-copy': async () => { toast(await copyText(JSON.stringify(S)) ? 'Скопировано — вставьте в «Избранное»' : 'Не удалось скопировать'); },
  'backup-download': () => {
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `forma-backup-${dkey(new Date())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  'backup-restore': () => openSheet(`<h3>Восстановить данные</h3>
    <p>Вставьте скопированную резервную копию или выберите файл. Текущие данные будут заменены.</p>
    <textarea id="restore-text" placeholder='{"v":1, ...}'></textarea>
    <button class="btn" data-act="restore-apply">Восстановить</button>
    <label class="btn ghost">Выбрать файл<input type="file" id="restore-file" accept=".json,application/json" hidden></label>`),
  'restore-apply': () => restoreFrom($('#restore-text').value),
  reset: async () => {
    if (!await confirmAsync('Удалить всю историю, замеры и настройки? Это нельзя отменить.', 'Удалить всё', true)) return;
    S = defaultState(); save(); releaseWake(); render(); toast('Данные удалены');
  },
};

async function restoreFrom(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { toast('Это не похоже на резервную копию'); return; }
  if (!data || !Array.isArray(data.history)) { toast('В копии нет истории тренировок'); return; }
  if (!await confirmAsync(`Восстановить ${data.history.length} тренировок? Текущие данные будут заменены.`, 'Восстановить')) return;
  S = migrate(Object.assign(defaultState(), data));
  save(); closeSheet(); setTab('summary'); toast('Данные восстановлены');
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* пусто */ }
    ta.remove();
    return ok;
  }
}

/* =====================================================================
   СОБЫТИЯ
   ===================================================================== */
document.addEventListener('click', e => {
  unlockAudio();
  if (menuEl && !menuEl.contains(e.target) && !e.target.closest('[data-act="row-menu"]')) {
    closeMenu(); e.preventDefault(); return;
  }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset.arg, el, e); }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.b && ui.bd) {
    ui.bd[t.dataset.b] = t.value;
    if (t.dataset.b === 'act') {
      const A = ACTIVITY[+t.value - 1];
      $('[data-el="act-t"]').textContent = A[0];
      $('[data-el="act-d"]').textContent = A[1];
      document.querySelectorAll('.act-nums span').forEach((x, i) => x.classList.toggle('on', i + 1 === +t.value));
      haptic('select');
    }
    return;
  }
  if (!S.session) return;
  if (t.dataset.f && cur().v === 'ex') {
    curEx().sets[+t.dataset.k][t.dataset.f] = t.value;
    saveSoon();
  } else if (t.dataset.note !== undefined) {
    S.session.exercises[+t.dataset.note].note = t.value;
    saveSoon();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
});

document.addEventListener('change', e => {
  if (e.target.matches('[data-rem-time]')) { S.remind.time = e.target.value; remindChanged(); return; }
  if (e.target.id === 'restore-file' && e.target.files[0]) {
    const reader = new FileReader();
    reader.onload = () => restoreFrom(String(reader.result));
    reader.readAsText(e.target.files[0]);
  }
});

document.addEventListener('visibilitychange', () => {
  // вернулись в приложение — подтянуть изменения с другого устройства;
  // свернули — сразу отправить в облако (таймер на 1,5 с может не успеть)
  if (document.visibilityState === 'visible') { requestWake(); tick(); cloudLoad(); restPushCancel(); }
  else { save(); clearTimeout(cloudTimer); if (cloud) cloudSave(); restPushArm(); }
});

/* =====================================================================
   СТАРТ
   ===================================================================== */
if (inTG) {
  tg.ready();
  tg.expand();
  try {
    if (tgv('6.1')) { tg.setHeaderColor('#000000'); tg.setBackgroundColor('#000000'); tg.BackButton.onClick(() => sheetIsOpen() ? closeSheet() : back()); }
    if (tgv('7.10')) tg.setBottomBarColor('#000000');
    if (tgv('7.7')) tg.disableVerticalSwipes();
    if (tgv('6.2')) tg.enableClosingConfirmation();
    if (tgv('8.0')) {
      tg.onEvent('activated', () => { cloudLoad(); restPushCancel(); });
      tg.onEvent('deactivated', () => { clearTimeout(cloudTimer); if (cloud) cloudSave(); if (!restPushed) restPushArm(); });
    }
  } catch (e) { /* старый клиент */ }
}

render();
cloudLoad();
requestWake();
checkAch(true); // выдать достижения за уже сделанные тренировки
botSync(); // обновить текст напоминания (следующий день программы)

window.addEventListener('scroll', () => { if (menuEl && Math.abs(window.scrollY - menuY) > 12) closeMenu(); }, { passive: true });
