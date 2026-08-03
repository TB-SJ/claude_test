'use strict';

// Single-user mobile dashboard. Talks to the same-origin API (cookie auth).
// The active provider is auto-detected from whichever calendar is connected.
const PROVIDER_ORDER = ['outlook', 'google'];
const PROVIDER_LABEL = { google: 'Google Calendar', outlook: 'Outlook Calendar' };
// Minutes to add to UTC to get local time (matches the optimizer's convention).
const TZ_OFFSET = -new Date().getTimezoneOffset();
// IANA zone name (e.g. "America/New_York") — sent so recurring events handle DST.
const TZ_NAME = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';

let activeProvider = null;
let scope = 'day';
let proposal = null; // last analyze() result
let tzBase = '';
let claudeAvailable = false; // server has ANTHROPIC_API_KEY set

// --- DOM helpers -----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

// --- Inline line-icons (original, currentColor stroke) ---------------------
const ICONS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  check: '<rect x="3" y="3.5" width="18" height="17" rx="4.5"/><path d="M8 12l3 3 5-6"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.2 5.6"/><path d="M20 4.5V11h-6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chart: '<path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 6-2.5 8-2.5 8h17S18 14 18 8"/><path d="M10.5 21a1.8 1.8 0 0 0 3 0"/>',
  edit: '<path d="M4 20.5h4L18.7 9.8a2 2 0 0 0-2.8-2.8L5 17.5v3z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  moon: '<path d="M21 12.8A8 8 0 1 1 11.2 3 6.3 6.3 0 0 0 21 12.8z"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.4-1-1.5-1-2.6 0-.8.7-1.4 1.5-1.4H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="11" r="1"/>',
  logout: '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M10 12h10M17 9l3 3-3 3"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.6"/>',
  next: '<path d="M6 5l8 7-8 7z"/><path d="M18 5v14"/>',
  alert: '<path d="M12 3.5l9 16.5H3z"/><path d="M12 10v4.5"/><path d="M12 17.6v.1"/>',
  flame: '<path d="M12 3s5 3.7 5 9a5 5 0 0 1-10 0c0-1.8.8-3.2 1.8-4.2C8.8 9.6 10 10.6 11 10.6 11 7.7 12 5.6 12 3z"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h13M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18.5" cy="18" r="2"/>',
  download: '<path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 20h16"/>',
  lotus: '<path d="M12 20c-4.2 0-7.5-2.3-7.5-2.3C4.5 14.5 8 12.8 12 12.8s7.5 1.7 7.5 4.9c0 0-3.3 2.3-7.5 2.3z"/><path d="M12 13.2c-1.7-2.3-1.7-5.6 0-8.9 1.7 3.3 1.7 6.6 0 8.9z"/><path d="M12 13.2C9.3 12.1 7.6 9.3 7.2 6.1c2.9.8 4.6 3.6 4.8 7.1z"/><path d="M12 13.2c2.7-1.1 4.4-3.9 4.8-7.1-2.9.8-4.6 3.6-4.8 7.1z"/>',
  trash: '<path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M10 11v6M14 11v6"/>',
  sparkle: '<path d="M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
};

function svgIcon(name, size = 20) {
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// Inject icons into any [data-icon] element (icon-only or before existing text).
function injectIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone) continue;
    el.insertAdjacentHTML('afterbegin', svgIcon(el.dataset.icon, el.classList.contains('icon-tile') ? 18 : 20));
    el.dataset.iconDone = '1';
  }
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function setLoading(on) {
  if (on) show($('loading'));
  else hide($('loading'));
}

// --- Themes -----------------------------------------------------------------
// Modern organizer skins + the two anime themes. The anime themes can use your
// own art (public/theme/<id>/bg.jpg + logo.png); modern ones are pure CSS.
const THEME_ORDER = ['default', 'minimal', 'midnight', 'sunset', 'forest', 'onepiece', 'akatsuki'];
const THEMES = {
  default: { cls: null, icon: '🗓', name: 'Calendar Optimizer', label: 'Classic' },
  minimal: { cls: 'theme-minimal', icon: '◽', name: 'Calendar Optimizer', label: 'Minimal' },
  midnight: { cls: 'theme-midnight', icon: '🌙', name: 'Calendar Optimizer', label: 'Midnight' },
  sunset: { cls: 'theme-sunset', icon: '🌇', name: 'Calendar Optimizer', label: 'Sunset' },
  forest: { cls: 'theme-forest', icon: '🌿', name: 'Calendar Optimizer', label: 'Forest' },
  onepiece: { cls: 'theme-onepiece', icon: '👒', name: 'Grand Line Planner', label: 'Grand Line', art: true },
  akatsuki: { cls: 'theme-akatsuki', icon: '☁️', name: 'Akatsuki Planner', label: 'Akatsuki', art: true },
};
const THEME_CLASSES = Object.values(THEMES).map((m) => m.cls).filter(Boolean);

function applyTheme(id) {
  const meta = THEMES[id] || THEMES.default;
  document.body.classList.remove(...THEME_CLASSES);
  if (meta.cls) document.body.classList.add(meta.cls);
  $('brandName').textContent = meta.name;
  $('brandIcon').textContent = meta.icon;
  $('themeBtn').textContent = meta.icon;
  const ts = $('themeStatus');
  if (ts) ts.textContent = meta.label;

  // Anime themes can use a custom logo; show it only if it loads, else emoji.
  const logo = $('brandLogo');
  if (meta.art) {
    logo.onload = () => { show(logo); hide($('brandIcon')); };
    logo.onerror = () => { hide(logo); show($('brandIcon')); };
    logo.src = `/theme/${id}/logo.png`;
  } else {
    hide(logo);
    logo.removeAttribute('src');
    show($('brandIcon'));
  }
  buildThemeMenu(id);
}

function buildThemeMenu(currentId) {
  const menu = $('themeMenu');
  menu.innerHTML = THEME_ORDER
    .map((tid) => {
      const m = THEMES[tid];
      return `<button data-theme="${tid}" class="${tid === currentId ? 'on' : ''}"><span>${m.icon}</span> ${escapeHtml(m.label)}</button>`;
    })
    .join('');
  for (const b of menu.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      const tid = b.dataset.theme;
      applyTheme(tid);
      localStorage.setItem('appTheme', tid);
      hide(menu);
    });
  }
}

function toggleThemeMenu() {
  $('themeMenu').classList.toggle('hidden');
}

// --- Bottom tab navigation --------------------------------------------------
const TAB_CARDS = {
  today: ['setupCard', 'briefCard', 'meditationCard'],
  schedule: ['todayCard'],
  tasks: ['tasksCard'],
  more: ['moreCard'],
};
const ALL_TAB_CARDS = ['setupCard', 'briefCard', 'meditationCard', 'todayCard', 'tasksCard', 'moreCard'];
let activeTab = 'today';

function setTab(name) {
  if (!TAB_CARDS[name]) name = 'today';
  activeTab = name;
  for (const id of ALL_TAB_CARDS) hide($(id));
  for (const id of TAB_CARDS[name]) show($(id));
  // Reset transient result cards when switching tabs.
  for (const id of ['proposalCard', 'queryCard', 'voiceCard', 'taskPlanCard', 'settingsCard']) hide($(id));
  for (const b of $('tabbar').querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === name);
  renderSetup(); // may re-hide the setup card if complete/dismissed
  if (name === 'today') renderMeditation();
  localStorage.setItem('activeTab', name);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// First-run checklist shown on the Today tab until complete or dismissed.
function renderSetup() {
  const card = $('setupCard');
  if (activeTab !== 'today' || localStorage.getItem('setupDismissed') === '1') { hide(card); return; }
  const steps = [
    { label: 'Connect your calendar', done: Boolean(activeProvider) },
    { label: 'Add your first task', done: (lastTasks || []).length > 0 },
    { label: 'Turn on reminders', done: notifyOn },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done >= steps.length) { hide(card); return; } // auto-hide once everything's done
  show(card);
  $('setupPct').textContent = `${Math.round((done / steps.length) * 100)}%`;
  $('setupBarFill').style.width = `${(done / steps.length) * 100}%`;
  $('setupSteps').innerHTML = steps
    .map((s) => `<div class="setup-step ${s.done ? 'done' : ''}">${s.done ? svgIcon('check', 18) : '<span class="step-dot"></span>'}<span>${s.label}</span></div>`)
    .join('');
}

// --- Greeting hero + progress ring -----------------------------------------
function timeGreeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function todayTaskProgress() {
  const todayKey = localTodayKey();
  const dow = new Date().getDay();
  const rel = (lastTasks || []).filter((t) => !t.deferred && (isRecurring(t) ? t.repeat.includes(dow) : true));
  if (!rel.length) return null;
  const done = rel.filter((t) => (isRecurring(t) ? t.lastDone === todayKey : t.done)).length;
  return { done, total: rel.length, pct: Math.round((done / rel.length) * 100) };
}

function setRing(pct) {
  const C = 113.1; // 2πr, r=18
  $('ringFg').style.strokeDashoffset = String(C * (1 - (pct || 0) / 100));
  $('ringPct').textContent = pct == null ? '–' : `${pct}%`;
}

function updateHero(b) {
  $('heroGreeting').textContent = timeGreeting();
  const prog = todayTaskProgress();
  if (prog) {
    setRing(prog.pct);
    $('heroSub').textContent = `${prog.done}/${prog.total} task${prog.total === 1 ? '' : 's'} done today`;
  } else {
    setRing(null);
    $('heroSub').textContent = b && b.meetingCount ? `${b.meetingCount} meeting${b.meetingCount === 1 ? '' : 's'} today` : 'Nothing scheduled — enjoy it';
  }
}

// --- Time formatting (browser is already in the user's timezone) -----------
function fmtTime(iso) {
  if (!iso.includes('T')) return 'All day';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtRange(start, end) {
  if (!start.includes('T')) return 'All day';
  return `${fmtTime(start)}–${fmtTime(end)}`;
}
function dayLabel(iso) {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function dayKey(iso) {
  return new Date(iso).toLocaleDateString([], { year: 'numeric', month: '2-digit', day: 'numeric' });
}

// --- API -------------------------------------------------------------------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const j = await res.json().catch(() => ({}));
    if (j.code === 'LOGIN_REQUIRED') {
      window.location.href = '/login';
      throw new Error('login required');
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

// --- Rendering -------------------------------------------------------------
function groupByDay(events) {
  const map = new Map();
  for (const ev of [...events].sort((a, b) => new Date(a.start) - new Date(b.start))) {
    const k = dayKey(ev.start);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(ev);
  }
  return map;
}

function applyMoves(events, moves) {
  const byId = new Map(moves.map((m) => [m.id, m.to]));
  return events.map((e) => (byId.has(e.id) ? { ...e, start: byId.get(e.id).start, end: byId.get(e.id).end } : e));
}

// `wasRange` (a formatted old time string) marks a changed event: the row shows
// the event's current time plus a struck-through "was <old>" note. `editable`
// adds a ✎ button that opens the inline edit form.
function eventRow(ev, wasRange, editable) {
  const changed = Boolean(wasRange);
  const controls = editable
    ? `<button class="ev-edit" data-id="${escapeHtml(ev.id)}" aria-label="edit">${svgIcon('edit', 18)}</button>`
      + `<button class="ev-del" data-id="${escapeHtml(ev.id)}" aria-label="delete">${svgIcon('trash', 18)}</button>`
    : '';
  return `<div class="event ${changed ? 'changed' : ''} ${ev.tag ? `tag-${ev.tag}` : ''}">
      <div class="time">${fmtRange(ev.start, ev.end)}</div>
      <div style="flex:1">
        <div class="title">${escapeHtml(ev.title || '(untitled)')} ${tagPill(ev.tag)}</div>
        ${changed ? `<div class="muted" style="font-size:.82rem">was <span class="old">${wasRange}</span></div>` : ''}
      </div>
      ${controls}
    </div>`;
}

function renderSchedule(container, events, changedMap, opts = {}) {
  const groups = groupByDay(events);
  if (groups.size === 0) {
    container.innerHTML = '<p class="muted center">No events.</p>';
    return;
  }
  let html = '';
  for (const [, list] of groups) {
    html += `<div class="daygroup"><h3>${dayLabel(list[0].start)}</h3>`;
    for (const ev of list) html += eventRow(ev, changedMap ? changedMap.get(ev.id) : null, opts.editable);
    html += '</div>';
  }
  container.innerHTML = html;
  if (opts.editable) {
    for (const b of container.querySelectorAll('.ev-edit')) {
      b.addEventListener('click', () => startEditEvent(b.dataset.id));
    }
    for (const b of container.querySelectorAll('.ev-del')) {
      b.addEventListener('click', () => deleteEventById(b.dataset.id));
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Work / personal tags ---------------------------------------------------
// A small colored pill shown on tagged tasks/events.
function tagPill(tag) {
  if (tag !== 'work' && tag !== 'personal') return '';
  return `<span class="tagpill ${tag}">${tag === 'work' ? 'Work' : 'Personal'}</span>`;
}

// Segmented control (None / Work / Personal) helpers, keyed by container id.
function segValue(id) {
  const b = $(id).querySelector('button.active');
  return b ? (b.dataset.tag || '') : '';
}
function setSeg(id, val) {
  for (const b of $(id).querySelectorAll('button')) {
    b.classList.toggle('active', (b.dataset.tag || '') === (val || ''));
  }
}
function wireSeg(id) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tag]');
    if (!b) return;
    for (const x of $(id).querySelectorAll('button')) x.classList.toggle('active', x === b);
  });
}

// Global work/personal lens applied to both the schedule and the task list.
let tagFilter = localStorage.getItem('tagFilter') || 'all';
function passTag(item) {
  return tagFilter === 'all' || (item && item.tag === tagFilter);
}
function setTagFilter(v) {
  tagFilter = v;
  localStorage.setItem('tagFilter', v);
  for (const b of $('tagFilterBar').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tag === v);
  if (activeProvider) {
    renderScheduleView();
    if (lastTasks) renderTasks(lastTasks);
  }
}
function renderScheduleView() {
  const evs = (currentEvents || []).filter(passTag);
  if (scope === 'week') renderWeekGrid($('eventList'), evs);
  else renderSchedule($('eventList'), evs, null, { editable: true });
}

// --- Visual week grid (7 day columns with proportional event blocks) --------
function localMinutes(iso) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function weekKeysFromToday(n) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(t);
    d.setDate(t.getDate() + i);
    out.push({ key: dateInputValue(d), dow: d.toLocaleDateString([], { weekday: 'short' }), date: d.getDate(), today: i === 0 });
  }
  return out;
}

function hhmm(min) {
  const h = Math.floor((min % 1440) / 60);
  const ap = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 || 12;
  return `${h12}${ap}`;
}

// Compact, non-wrapping local time for tight grid blocks: "2p" / "2:30p".
function fmtTimeCompact(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return m ? `${h}:${pad2(m)}${ap}` : `${h}${ap}`;
}

// Renders the rolling 7-day week as a compact grid: each day is a column, each
// event a block positioned by time. Blocks are tappable to edit. Horizontally
// scrollable so columns stay legible on a phone.
function renderWeekGrid(container, events) {
  const days = weekKeysFromToday(7);
  const timed = events.filter((e) => e.start.includes('T'));
  const allday = events.filter((e) => !e.start.includes('T'));

  // Display window: default awake hours, expanded to fit any earlier/later event.
  let winStart = 6 * 60;
  let winEnd = 21 * 60;
  for (const e of timed) {
    const s = localMinutes(e.start);
    const durMin = Math.max(0, (new Date(e.end) - new Date(e.start)) / 60000);
    winStart = Math.min(winStart, Math.floor(s / 60) * 60);
    winEnd = Math.max(winEnd, Math.ceil((s + durMin) / 60) * 60);
  }
  winStart = Math.max(0, winStart);
  winEnd = Math.min(24 * 60, winEnd); // a cross-midnight event clamps, not stretches
  const span = Math.max(60, winEnd - winStart);
  const H = 320; // track height in px
  const pct = (min) => ((min - winStart) / span) * 100;

  const byDay = new Map(days.map((d) => [d.key, []]));
  for (const e of timed) {
    const k = dateInputValue(new Date(e.start));
    if (byDay.has(k)) byDay.get(k).push(e);
  }
  const alldayByDay = new Map(days.map((d) => [d.key, []]));
  for (const e of allday) {
    const k = dateInputValue(new Date(e.start));
    if (alldayByDay.has(k)) alldayByDay.get(k).push(e);
  }

  // Faint gridlines + labels every 3 hours.
  let axis = '';
  const lines = [];
  for (let m = Math.ceil(winStart / 180) * 180; m <= winEnd; m += 180) {
    axis += `<div class="wg-hr" style="top:${pct(m)}%">${hhmm(m)}</div>`;
    lines.push(`<div class="wg-line" style="top:${pct(m)}%"></div>`);
  }
  const lineHtml = lines.join('');

  let cols = '';
  for (const d of days) {
    const list = byDay.get(d.key).sort((a, b) => new Date(a.start) - new Date(b.start));
    let blocks = lineHtml;
    for (const ad of alldayByDay.get(d.key)) {
      blocks += `<div class="wg-allday wg-ev" data-id="${escapeHtml(ad.id)}" title="${escapeHtml(ad.title || '')}">${escapeHtml(ad.title || '')}</div>`;
    }
    for (const e of list) {
      const s = localMinutes(e.start);
      const durMin = Math.max(10, (new Date(e.end) - new Date(e.start)) / 60000);
      const top = Math.max(0, pct(s));
      const height = Math.min(100 - top, pct(winStart + durMin));
      const isTask = /^📋/.test(e.title || '');
      const tagCls = e.tag ? ` tag-${e.tag}` : '';
      blocks += `<div class="wg-ev${isTask ? ' task' : ''}${tagCls}" data-id="${escapeHtml(e.id)}" style="top:${top}%;height:${height}%" title="${escapeHtml((e.title || '') + ' · ' + fmtRange(e.start, e.end))}">
        <span class="wg-t">${fmtTimeCompact(e.start)}</span><span class="wg-n">${escapeHtml(e.title || '(untitled)')}</span>
      </div>`;
    }
    cols += `<div class="wg-col${d.today ? ' today' : ''}">
      <div class="wg-head"><span class="wg-dow">${d.dow}</span><span class="wg-date">${d.date}</span></div>
      <div class="wg-track" style="height:${H}px">${blocks}</div>
    </div>`;
  }

  container.innerHTML = `<p class="muted center" style="font-size:.8rem;margin:0 0 8px">Tap an event to edit.</p>
    <div class="wgrid"><div class="wg-axis" style="height:${H}px;margin-top:34px">${axis}</div><div class="wg-cols">${cols}</div></div>`;

  for (const b of container.querySelectorAll('.wg-ev')) {
    b.addEventListener('click', () => startEditEvent(b.dataset.id));
  }
}

// --- Flows -----------------------------------------------------------------
async function refreshConnection() {
  try {
    const health = await api('/health');
    const provs = health.providers || {};
    claudeAvailable = Boolean(health.ai && health.ai.claude);
    setupClaudeToggle();
    // Use the first connected provider (Outlook preferred, then Google).
    activeProvider = PROVIDER_ORDER.find((p) => provs[p] && provs[p].connected) || null;

    if (activeProvider) {
      $('tzLabel').textContent = `${tzBase} · ${PROVIDER_LABEL[activeProvider]}`;
      hide($('connectCard'));
      show($('micBtn')); // voice control available once connected
      show($('tabbar'));
      show($('tagFilterBar'));
      await loadEvents();
      await loadTasks();
      await loadBrief();
      setupNotifications();
      setTab(localStorage.getItem('activeTab') || 'today');
    } else {
      hide($('micBtn'));
      hide($('tasksCard'));
      hide($('briefCard'));
      hide($('tabbar'));
      hide($('tagFilterBar'));
      // Offer a connect button for each configured-but-unconnected provider.
      const configured = PROVIDER_ORDER.filter((p) => provs[p] && provs[p].reason !== 'not_configured');
      const list = configured.length ? configured : PROVIDER_ORDER;
      $('connectButtons').innerHTML = list
        .map((p) => `<a class="btn primary full" style="margin-top:8px" href="/auth/${p}">Connect ${PROVIDER_LABEL[p]}</a>`)
        .join('');
      show($('connectCard'));
      hide($('todayCard'));
      hide($('proposalCard'));
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

let currentEvents = []; // last-loaded events, for the inline edit form

async function loadEvents() {
  setLoading(true);
  try {
    // Anchor the range on the browser's LOCAL date (noon UTC of it), so "day"
    // and the rolling "week" match the user's calendar day regardless of tz.
    const now = new Date();
    const localAnchor = `${dateInputValue(now)}T12:00:00Z`;
    const data = await api(`/calendar/${activeProvider}/events?range=${scope}&date=${encodeURIComponent(localAnchor)}&tzOffsetMinutes=${TZ_OFFSET}`);
    currentEvents = data.events || [];
    renderScheduleView();
  } catch (err) {
    $('eventList').innerHTML = `<p class="muted">Couldn't load events: ${escapeHtml(err.message)}</p>`;
  } finally {
    setLoading(false);
  }
}

// --- Quick-add / edit event (typed fields → saved directly; no AI, no cost) --
let editingEventId = null; // when set, the form saves an edit instead of adding

const pad2 = (n) => String(n).padStart(2, '0');
function dateInputValue(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function timeInputValue(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

async function addEventFromForm() {
  const title = $('evTitle').value.trim();
  const date = $('evDate').value; // YYYY-MM-DD (local)
  const time = $('evTime').value; // HH:MM (local)
  if (!title) return toast('Enter an event title', 'err');
  if (!date || !time) return toast('Pick a date and start time', 'err');
  // Build a local Date from the picker values, then send as a UTC ISO instant.
  const start = new Date(`${date}T${time}`);
  if (Number.isNaN(start.getTime())) return toast('Invalid date/time', 'err');
  const editing = editingEventId;
  const body = {
    title,
    start: start.toISOString(),
    duration: parseInt($('evMins').value, 10) || 60,
    description: editing ? $('evDesc').value.trim() : ($('evDesc').value.trim() || undefined),
    tag: segValue('evTag'), // '' clears the tag on edit; ignored on create when empty
  };
  // Recurrence is set on creation only (editing a single instance's rule isn't
  // supported). Send the IANA zone so the repeat handles DST correctly.
  if (!editing) {
    const repeat = $('evRepeat').value;
    if (repeat && repeat !== 'none') {
      body.repeat = repeat;
      body.timeZone = TZ_NAME;
      const ends = $('evEnds').value;
      if (ends === 'after') {
        const n = parseInt($('evEndsCount').value, 10);
        if (n > 0) body.repeatCount = n;
      } else if (ends === 'on') {
        if ($('evEndsDate').value) body.repeatUntil = $('evEndsDate').value;
      }
    }
  }
  setLoading(true);
  try {
    if (editing) {
      await api(`/calendar/${activeProvider}/events/${encodeURIComponent(editing)}`, { method: 'PATCH', body });
    } else {
      await api(`/calendar/${activeProvider}/events`, { method: 'POST', body });
    }
    resetEventForm();
    hide($('eventForm'));
    toast(editing ? 'Event updated ✓' : 'Event added ✓', 'ok');
    await loadEvents();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

// Show the "Ends" row only when a repeat is chosen; show the right end input.
function onRepeatChange() {
  const repeating = $('evRepeat').value !== 'none';
  $('evEndsRow').classList.toggle('hidden', !repeating);
  onEndsChange();
}
function onEndsChange() {
  const v = $('evEnds').value;
  $('evEndsCount').classList.toggle('hidden', v !== 'after');
  $('evEndsDate').classList.toggle('hidden', v !== 'on');
}

function resetEventForm() {
  editingEventId = null;
  $('evTitle').value = '';
  $('evDesc').value = '';
  $('evDate').value = '';
  $('evTime').value = '';
  $('evRepeat').value = 'none';
  $('evEnds').value = 'never';
  setSeg('evTag', '');
  show($('evRepeatRow')); // repeat is available when adding
  onRepeatChange(); // hides the Ends row for a non-repeating event
  hide($('evDeleteBtn')); // no event to delete when adding
  $('evAddBtn').textContent = 'Add event';
}

// Opens the form prefilled to edit an existing event.
function startEditEvent(id) {
  const ev = currentEvents.find((e) => e.id === id);
  if (!ev || !ev.start.includes('T')) return toast("This event can't be edited here.", 'err');
  const start = new Date(ev.start);
  editingEventId = id;
  $('evTitle').value = ev.title || '';
  $('evDate').value = dateInputValue(start);
  $('evTime').value = timeInputValue(start);
  $('evMins').value = Math.max(5, Math.round((new Date(ev.end) - start) / 60000)) || 60;
  $('evDesc').value = ev.description || '';
  setSeg('evTag', ev.tag || '');
  hide($('evRepeatRow')); // recurrence is set at creation, not per-instance edit
  hide($('evEndsRow'));
  show($('evDeleteBtn')); // can delete the event being edited
  $('evAddBtn').textContent = 'Save changes';
  show($('eventForm'));
  $('eventForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Deletes a calendar event after confirmation (it's removed from the real
// calendar). For a recurring series this removes the tapped occurrence.
async function deleteEventById(id) {
  const ev = currentEvents.find((e) => e.id === id);
  const name = ev && ev.title ? `“${ev.title}”` : 'this event';
  if (!window.confirm(`Delete ${name} from your calendar?`)) return;
  setLoading(true);
  try {
    await api(`/calendar/${activeProvider}/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (editingEventId === id) { resetEventForm(); hide($('eventForm')); }
    toast('Event deleted', 'ok');
    await loadEvents();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

// Defaults the quick-add date/time to now (next quarter-hour) when opened empty.
function primeEventForm() {
  if (!$('evDate').value) {
    const now = new Date();
    now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
    $('evDate').value = dateInputValue(now);
    $('evTime').value = timeInputValue(now);
  }
}

// --- Collapsible cards (persisted, to save screen space) --------------------
function setupCollapse(cardId, btnId, storeKey) {
  const card = $(cardId);
  const btn = $(btnId);
  const apply = (collapsed) => {
    card.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
  };
  apply(localStorage.getItem(storeKey) === '1');
  btn.addEventListener('click', () => {
    const collapsed = !card.classList.contains('collapsed');
    apply(collapsed);
    localStorage.setItem(storeKey, collapsed ? '1' : '0');
  });
}

// --- Claude optimizer toggle (shown only when the server has a key) ----------
function setupClaudeToggle() {
  const wrap = $('claudeToggleWrap');
  if (!claudeAvailable) {
    hide(wrap);
    return;
  }
  show(wrap);
  // Default ON when available; remember the user's choice.
  const saved = localStorage.getItem('useClaudeOptimizer');
  $('claudeToggle').checked = saved === null ? true : saved === '1';
}

// Renders the current global `proposal` into the proposal card. Shared by the
// Optimize button and the voice "optimize" command. `note` is an optional
// header line (e.g. the transcript that triggered it).
function renderProposalCard(note) {
  hide($('voiceCard'));
  const c = proposal.analysis.counts;
  const issues = c.conflicts + c.bufferIssues + c.fragmentedGaps + c.deepWorkViolations;
  const byClaude = proposal.engine === 'claude';
  const noteHtml = (note ? `<p class="muted" style="margin:0 0 8px">${escapeHtml(note)}</p>` : '') +
    (byClaude ? '<p class="muted" style="margin:0 0 8px; font-size:.82rem">Proposed by Claude · validated against your rules 🧠</p>' : '');

  if (!proposal.moves.length) {
    $('analysisPill').textContent = 'All clear';
    $('analysisPill').className = 'pill ok';
    $('beforeAfter').innerHTML = noteHtml + '<p class="center">✅ Already optimized — nothing to change.</p>';
    $('reasons').innerHTML = '';
    hide($('applyBtn'));
  } else {
    $('analysisPill').textContent = `${issues} issue${issues === 1 ? '' : 's'} found`;
    $('analysisPill').className = issues ? 'pill warn' : 'pill';
    const changedMap = new Map(proposal.moves.map((m) => [m.id, fmtRange(m.from.start, m.from.end)]));
    const after = applyMoves(proposal.events, proposal.moves);
    $('beforeAfter').innerHTML =
      noteHtml +
      '<h3 class="muted" style="margin:6px 0">Before</h3><div id="beforeList"></div>' +
      '<h3 class="muted" style="margin:14px 0 6px">After</h3><div id="afterList"></div>';
    renderSchedule($('beforeList'), proposal.events, null);
    renderSchedule($('afterList'), after, changedMap);
    $('reasons').innerHTML =
      '<h3 class="muted" style="margin:0 0 6px">Why</h3>' +
      proposal.moves
        .map((m) => `<div class="reason" style="margin-left:0">• <b>${escapeHtml(m.title)}</b>: ${escapeHtml(m.reasons.join('; '))}</div>`)
        .join('');
    show($('applyBtn'));
  }
  show($('proposalCard'));
  $('proposalCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function runOptimize() {
  setLoading(true);
  hide($('proposalCard'));
  const useClaude = claudeAvailable && $('claudeToggle').checked;
  try {
    proposal = await api(`/schedule/${activeProvider}/analyze`, {
      method: 'POST',
      body: { range: scope, rules: { tzOffsetMinutes: TZ_OFFSET }, engine: useClaude ? 'claude' : 'rules' },
    });
    if (useClaude && proposal.engine === 'rules-fallback') {
      toast('Claude was unavailable — used the free rules engine.', '');
    }
    renderProposalCard();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

async function applyProposal() {
  if (!proposal || !proposal.moves.length) return;
  setLoading(true);
  try {
    const result = await api(`/schedule/${activeProvider}/apply`, {
      method: 'POST',
      body: { confirm: true, moves: proposal.moves },
    });
    toast(`Saved: ${result.applied} updated${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'err' : 'ok');
    hide($('proposalCard'));
    proposal = null;
    await loadEvents();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

// --- Voice control ---------------------------------------------------------
let listening = false;
let pendingVoice = null; // add/remove/move command awaiting confirmation

function setListening(on) {
  listening = on;
  $('micBtn').classList.toggle('listening', on);
  $('micStatus').classList.toggle('hidden', !on);
}

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast('Voice input needs Chrome (Android/desktop). Not supported here.', 'err');
    return;
  }
  if (listening) return;
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    setListening(false);
    handleTranscript(transcript);
  };
  rec.onerror = (e) => {
    setListening(false);
    if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Mic: ${e.error}`, 'err');
  };
  rec.onend = () => setListening(false);
  try {
    rec.start();
    setListening(true);
  } catch (err) {
    setListening(false);
    toast(err.message, 'err');
  }
}

async function handleTranscript(transcript) {
  setLoading(true);
  try {
    const result = await api('/voice/command', {
      method: 'POST',
      body: { provider: activeProvider, transcript, tzOffsetMinutes: TZ_OFFSET },
    });
    dispatchVoice(result, transcript);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

const VOICE_ERRORS = {
  need_title: "I didn't catch what you meant.",
  need_time: "I didn't catch a time — try e.g. \"add lunch tomorrow at noon\".",
  need_change: "I didn't catch what to change.",
  not_found: 'No match found in the next 3 weeks.',
};

// Small badge shown when Claude (not the rules parser) understood the command.
const engineSuffix = (result) => (result && result.engine === 'claude' ? '  ·  🧠 Claude' : '');

// --- Read-only query views (show schedule / show free time) ----------------
function dayLabelFromKey(key) {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtDur(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}
function showQueryCard() {
  hide($('voiceCard'));
  hide($('proposalCard'));
  hide($('taskPlanCard'));
  show($('queryCard'));
  $('queryCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderQuerySchedule(result, transcript) {
  $('queryTitle').textContent = `🗓 ${result.label || 'Schedule'}`;
  $('queryHeard').textContent = `Heard: "${transcript}"${engineSuffix(result)}`;
  renderSchedule($('queryBody'), result.events || [], null);
  showQueryCard();
}
function renderQueryFree(result, transcript) {
  $('queryTitle').textContent = `🕓 Free time · ${result.label || ''}`;
  $('queryHeard').textContent = `Heard: "${transcript}"${engineSuffix(result)}`;
  const days = result.days || [];
  let html = '';
  if (!days.some((d) => d.slots.length)) {
    html = '<p class="muted center">No free time within working hours.</p>';
  } else {
    for (const d of days) {
      if (!d.slots.length) continue;
      html += `<div class="daygroup"><h3>${dayLabelFromKey(d.dayKey)}</h3>`;
      for (const s of d.slots) {
        html += `<div class="event"><div class="time">${fmtRange(s.start, s.end)}</div><div class="title" style="flex:1">Free · ${fmtDur(s.minutes)}</div></div>`;
      }
      html += '</div>';
    }
  }
  $('queryBody').innerHTML = html;
  showQueryCard();
}

function dispatchVoice(result, transcript) {
  if (result.type === 'unknown') {
    toast(`Heard "${transcript}" — try "optimize my day", "add…", "move…", or "remove…".`, 'err');
    return;
  }
  if (result.type === 'optimize') {
    proposal = result.proposal;
    renderProposalCard(`🎤 "${transcript}"${engineSuffix(result)}`);
    return;
  }
  if (result.type === 'plan_tasks') {
    renderTaskPlan(result.plan);
    return;
  }
  if (result.type === 'brief') {
    renderBrief(result.brief);
    const card = $('briefCard');
    card.classList.remove('collapsed'); // make sure it's visible
    show(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (result.type === 'review') {
    renderReview(result.review);
    return;
  }
  if (result.type === 'whatnow') {
    renderFocus(result.focus);
    return;
  }
  if (result.type === 'show_schedule') {
    renderQuerySchedule(result, transcript);
    return;
  }
  if (result.type === 'show_free') {
    renderQueryFree(result, transcript);
    return;
  }
  if (result.type === 'add_task') {
    if (result.error) return toast(VOICE_ERRORS[result.error] || "Couldn't add that task.", 'err');
    pendingVoice = result;
    const t = result.task;
    const meta = [`${t.estimatedMinutes} min`, PRIO_LABEL[t.priority], t.deadline ? `by ${t.deadline}` : null].filter(Boolean).join(' · ');
    $('voiceHeard').textContent = `Heard: "${transcript}"${engineSuffix(result)}`;
    $('voiceSummary').textContent = `Add task: “${t.title}” (${meta})`;
    hide($('proposalCard'));
    show($('voiceCard'));
    $('voiceCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (result.error) {
    toast(VOICE_ERRORS[result.error] || 'Sorry, I couldn\'t do that.', 'err');
    return;
  }
  pendingVoice = result;
  let summary = '';
  if (result.type === 'add') {
    summary = `Add “${result.event.title}” — ${dayLabel(result.event.start)}, ${fmtRange(result.event.start, result.event.end)}`;
  } else if (result.type === 'remove') {
    summary = `Remove “${result.match.title}” — ${dayLabel(result.match.start)}, ${fmtRange(result.match.start, result.match.end)}`;
  } else if (result.type === 'move') {
    summary = `Move “${result.match.title}” → ${dayLabel(result.to.start)}, ${fmtRange(result.to.start, result.to.end)}`;
  } else if (result.type === 'edit') {
    const ch = result.changes;
    const parts = [];
    if (ch.title) parts.push(`rename to “${ch.title}”`);
    if (ch.duration) parts.push(`${ch.duration} min long`);
    if (ch.start) parts.push(`→ ${dayLabel(ch.start)}, ${fmtTime(ch.start)}`);
    summary = `Edit “${result.match.title}”: ${parts.join(', ')}`;
  } else if (result.type === 'edit_task') {
    const p = result.patch;
    const parts = [];
    if (p.title) parts.push(`rename to “${p.title}”`);
    if (p.estimatedMinutes) parts.push(`${p.estimatedMinutes} min`);
    if (p.priority) parts.push(`${PRIO_LABEL[p.priority]} priority`);
    if (p.deadline) parts.push(`by ${p.deadline}`);
    if (p.done != null) parts.push(p.done ? 'mark done' : 'reopen');
    summary = `Edit task “${result.task.title}”: ${parts.join(', ')}`;
  }
  if (result.otherMatches) summary += `\n(+${result.otherMatches} other match${result.otherMatches > 1 ? 'es' : ''} — using the soonest)`;
  $('voiceHeard').textContent = `Heard: "${transcript}"${engineSuffix(result)}`;
  $('voiceSummary').textContent = summary;
  hide($('proposalCard'));
  show($('voiceCard'));
  $('voiceCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function confirmVoice() {
  if (!pendingVoice) return;
  const v = pendingVoice;
  pendingVoice = null;
  hide($('voiceCard'));
  setLoading(true);
  try {
    if (v.type === 'add_task') {
      await api('/tasks', { method: 'POST', body: v.task });
      toast('Task added ✓', 'ok');
      await loadTasks();
      return;
    }
    if (v.type === 'edit_task') {
      await api(`/tasks/${v.task.id}`, { method: 'PATCH', body: v.patch });
      toast('Task updated ✓', 'ok');
      await loadTasks();
      return;
    }
    if (v.type === 'edit') {
      await api(`/calendar/${activeProvider}/events/${encodeURIComponent(v.match.id)}`, { method: 'PATCH', body: v.changes });
      toast('Event updated ✓', 'ok');
      await loadEvents();
      return;
    }
    if (v.type === 'add') {
      await api(`/calendar/${activeProvider}/events`, { method: 'POST', body: v.event });
      toast('Event added ✓', 'ok');
    } else if (v.type === 'remove') {
      await api(`/calendar/${activeProvider}/events/${encodeURIComponent(v.match.id)}`, { method: 'DELETE' });
      toast('Event removed ✓', 'ok');
    } else if (v.type === 'move') {
      await api(`/calendar/${activeProvider}/events/${encodeURIComponent(v.match.id)}`, {
        method: 'PATCH',
        body: { start: v.to.start, end: v.to.end },
      });
      toast('Event moved ✓', 'ok');
    }
    await loadEvents();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

// --- Daily brief -----------------------------------------------------------
async function loadBrief() {
  try {
    const now = new Date();
    const anchor = `${dateInputValue(now)}T12:00:00Z`;
    const brief = await api(`/brief/${activeProvider}?tzOffsetMinutes=${TZ_OFFSET}&date=${encodeURIComponent(anchor)}`);
    renderBrief(brief);
  } catch (_) {
    $('briefStats').innerHTML = '<p class="muted">Couldn\'t load your brief.</p>';
  }
}

// A stat line with a small colored leading icon. `text` must be safe HTML.
function statRow(icon, text, { color, cls = '' } = {}) {
  const style = color ? ` style="color:var(--${color})"` : '';
  return `<div class="brief-stat ${cls}"><span class="stat-ico"${style}>${svgIcon(icon, 18)}</span><span>${text}</span></div>`;
}

function renderBrief(b) {
  $('briefTitle').textContent = `Today · ${dayLabelFromKey(b.dayKey)}`;
  let html = '';
  html += statRow('calendar',
    b.meetingCount ? `${b.meetingCount} meeting${b.meetingCount === 1 ? '' : 's'} · ${fmtDur(b.meetingMinutes)} booked` : 'No meetings today',
    { color: 'accent' });
  const dw = b.deepWorkClear === true ? ' · deep-work protected'
    : b.deepWorkClear === false ? ' · deep-work has a meeting' : '';
  html += statRow('target', `${fmtDur(b.freeMinutes)} free${escapeHtml(dw)}`, { color: b.deepWorkClear === false ? 'amber' : 'green' });
  if (b.nextEvent) html += statRow('next', `Next: ${escapeHtml(b.nextEvent.title)} at ${fmtTime(b.nextEvent.start)}`, { color: 'accent' });
  if (b.topTask) {
    html += statRow('check', `Top task: ${escapeHtml(b.topTask.title)} (${fmtDur(b.topTask.estimatedMinutes || 30)}${b.topTask.priority === 'high' ? ', High' : ''})`, { color: 'green' });
  } else if (b.pendingTaskCount === 0) {
    html += statRow('check', 'No open tasks', { color: 'green' });
  }
  for (const r of b.atRisk || []) {
    html += statRow('alert', `${escapeHtml(r.title)} — ${escapeHtml(r.when)}`, { color: 'amber', cls: 'warn' });
  }
  $('briefStats').innerHTML = html;
  updateHero(b);
}

// --- Weekly review ---------------------------------------------------------
async function loadReview() {
  setLoading(true);
  try {
    const review = await api(`/review/${activeProvider}?tzOffsetMinutes=${TZ_OFFSET}`);
    renderReview(review);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

// Tiny inline SVG sparkline (filled area + line) for a small numeric series.
function sparkline(values, { w = 220, h = 44, pad = 4 } = {}) {
  const n = values.length;
  if (n < 2) return '';
  const max = Math.max(1, ...values);
  const dx = (w - pad * 2) / (n - 1);
  const y = (v) => h - pad - (v / max) * (h - pad * 2);
  const pts = values.map((v, i) => [pad + i * dx, y(v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[n - 1][0].toFixed(1)} ${h - pad} L${pad} ${h - pad} Z`;
  const last = pts[n - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" class="spark-fill"/>
    <path d="${line}" class="spark-line" fill="none"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" class="spark-dot"/>
  </svg>`;
}

function renderReview(r) {
  $('queryTitle').textContent = 'Weekly review';
  $('queryHeard').textContent = `${r.range.from} → ${r.range.to}`;
  const trendArrow = r.meetings.trend === 'up' ? '▲' : r.meetings.trend === 'down' ? '▼' : '—';
  let html = '';
  if (r.meetingTrend && r.meetingTrend.length > 1) {
    const vals = r.meetingTrend.map((wk) => Math.round(wk.minutes / 60 * 10) / 10);
    html += `<div class="spark-card">
      <div class="spark-head"><span class="muted">Meeting hours · last ${r.meetingTrend.length} weeks</span><b>${fmtDur(r.meetings.minutes)}</b></div>
      ${sparkline(vals)}
    </div>`;
  }
  html += statRow('calendar', `${r.meetings.count} meetings · ${fmtDur(r.meetings.minutes)} <span class="muted">(${trendArrow} vs last week)</span>`, { color: 'accent' });
  html += statRow('target', `${fmtDur(r.freeMinutes)} free/focus time`, { color: 'green' });
  if (r.deepWork.days) html += statRow('shield', `Deep-work protected ${r.deepWork.protected}/${r.deepWork.days} days`, { color: 'green' });
  html += statRow('check', `${r.tasks.completedThisWeek} done · ${r.tasks.open} open`, { color: 'green' });
  if (r.tasks.overdue) html += statRow('alert', `${r.tasks.overdue} overdue`, { color: 'amber', cls: 'warn' });
  if (r.habits.length) {
    html += '<h3 class="muted" style="margin:12px 0 4px">Habit streaks</h3>';
    html += r.habits.map((h) => statRow('flame', `${escapeHtml(h.title)} — ${h.streak} day${h.streak === 1 ? '' : 's'}`, { color: 'amber' })).join('');
  }
  $('queryBody').innerHTML = html;
  showQueryCard();
}

// --- Settings ---------------------------------------------------------------
function fillSettings(s) {
  $('setWorkStart').value = s.workday.start;
  $('setWorkEnd').value = s.workday.end;
  $('setDeepEnabled').checked = !!s.deepWork.enabled;
  $('setDeepStart').value = s.deepWork.start;
  $('setDeepEnd').value = s.deepWork.end;
  $('setMeetEnabled').checked = !!s.meetingWindow.enabled;
  $('setMeetStart').value = s.meetingWindow.start;
  $('setMeetEnd').value = s.meetingWindow.end;
  $('setBuffer').value = s.bufferMinutes;
  $('setBriefTime').value = s.briefTime;
  $('setLead').value = s.reminderLeadMinutes;
  $('setPrefs').value = s.optimizePrefs || '';
}

function readSettingsForm() {
  return {
    workday: { start: $('setWorkStart').value, end: $('setWorkEnd').value },
    deepWork: { enabled: $('setDeepEnabled').checked, start: $('setDeepStart').value, end: $('setDeepEnd').value },
    meetingWindow: { enabled: $('setMeetEnabled').checked, start: $('setMeetStart').value, end: $('setMeetEnd').value },
    bufferMinutes: Number($('setBuffer').value),
    briefTime: $('setBriefTime').value,
    reminderLeadMinutes: Number($('setLead').value),
    optimizePrefs: $('setPrefs').value,
  };
}

async function openSettings() {
  setLoading(true);
  try {
    const { settings } = await api('/settings');
    fillSettings(settings);
    for (const id of ['proposalCard', 'queryCard', 'voiceCard', 'taskPlanCard']) hide($(id));
    show($('settingsCard'));
    $('settingsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

async function saveSettings() {
  setLoading(true);
  try {
    const { settings } = await api('/settings', { method: 'PUT', body: readSettingsForm() });
    fillSettings(settings);
    toast('Settings saved', 'ok');
    hide($('settingsCard'));
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

// --- Daily meditation + manifesting ----------------------------------------
// Original prompts (no third-party content), rotated deterministically by day.
const MED_FOCUS = [
  'Follow your breath — in for four, out for six. Let each exhale soften your shoulders.',
  'Notice five sounds around you, then let them settle into the background.',
  'Scan from head to toe, releasing tension everywhere your attention lands.',
  'Rest your attention in the quiet space between thoughts.',
  'Breathe into your belly and feel it rise and fall like a calm tide.',
  'Let each thought pass like a cloud — noticed, not chased.',
  'Ground down. Feel every point where your body meets the earth.',
  'Soften your jaw, your eyes, your hands. Let stillness spread from there.',
];
const MED_AFFIRM = [
  'I am building a life that fits me, and today I take one clear step toward it.',
  'Opportunity flows to me because I stay open, prepared, and calm.',
  'I attract what I focus on — today I choose progress and peace.',
  'I am enough as I am, and I am growing a little every day.',
  'Abundance is my natural state; I welcome it with gratitude.',
  'I trust my timing. What is meant for me will find its way to me.',
  'My energy shapes my day. I choose steady, grounded, and positive.',
  'I release what I cannot control and pour my focus into what I can.',
];

function dayOfYear(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

let medTimer = null;

function renderMeditation() {
  const di = dayOfYear();
  $('medFocus').textContent = MED_FOCUS[di % MED_FOCUS.length];
  $('medAffirm').textContent = MED_AFFIRM[(di * 3 + 1) % MED_AFFIRM.length];
  updateMedStreak();
}

function updateMedStreak() {
  const streak = Number(localStorage.getItem('med.streak') || 0);
  const done = localStorage.getItem('med.lastDone') === dateInputValue(new Date());
  $('medStreak').textContent = streak > 0
    ? `🔥 ${streak}-day streak${done ? '' : ' — keep it going'}`
    : 'Start your streak today';
  $('medDoneChip').classList.toggle('hidden', !done);
}

function startMeditation(mins) {
  stopMeditation();
  let remaining = mins * 60;
  hide($('medDurBtns'));
  show($('medTimerWrap'));
  const phases = [['Breathe in…', 4], ['Hold…', 2], ['Breathe out…', 4], ['Hold…', 1]];
  let pi = 0;
  let pt = 0;
  $('medCue').textContent = phases[0][0];
  updateMedClock(remaining);
  medTimer = setInterval(() => {
    remaining -= 1;
    pt += 1;
    if (pt >= phases[pi][1]) { pt = 0; pi = (pi + 1) % phases.length; $('medCue').textContent = phases[pi][0]; }
    updateMedClock(remaining);
    if (remaining <= 0) finishMeditation();
  }, 1000);
}

function updateMedClock(s) {
  $('medClock').textContent = `${Math.floor(s / 60)}:${pad2(Math.max(0, s % 60))}`;
}

function stopMeditation() {
  if (medTimer) { clearInterval(medTimer); medTimer = null; }
  hide($('medTimerWrap'));
  show($('medDurBtns'));
}

function finishMeditation() {
  stopMeditation();
  markMeditationDone();
  toast('Meditation complete 🧘', 'ok');
}

function markMeditationDone() {
  const today = dateInputValue(new Date());
  if (localStorage.getItem('med.lastDone') === today) { updateMedStreak(); return; }
  const yesterday = dateInputValue(new Date(Date.now() - 86400000));
  const prev = Number(localStorage.getItem('med.streak') || 0);
  const streak = localStorage.getItem('med.lastDone') === yesterday ? prev + 1 : 1;
  localStorage.setItem('med.streak', String(streak));
  localStorage.setItem('med.lastDone', today);
  updateMedStreak();
  toast(`Nice — ${streak}-day streak 🔥`, 'ok');
}

// Prefill the quick-add form with a daily-recurring meditation block so the
// user just picks a time. Reuses the recurring-events flow.
function scheduleMeditation() {
  setTab('schedule');
  resetEventForm();
  primeEventForm();
  $('evTitle').value = '🧘 Meditation';
  $('evMins').value = 10;
  $('evRepeat').value = 'daily';
  onRepeatChange();
  show($('eventForm'));
  $('eventForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Pick a time, then Add event', '');
}

// Download a JSON backup of tasks + settings (opens the authed export endpoint).
function exportData() {
  const a = document.createElement('a');
  a.href = '/settings/export';
  a.download = 'calendar-optimizer-backup.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Backup downloaded', 'ok');
}

// --- "What should I do now?" + focus timer ---------------------------------
async function loadFocus() {
  setLoading(true);
  try {
    const focus = await api(`/focus/${activeProvider}?tzOffsetMinutes=${TZ_OFFSET}`);
    renderFocus(focus);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

function renderFocus(f) {
  $('queryTitle').textContent = 'What now?';
  $('queryHeard').textContent = '';
  let html;
  if (f.status === 'ok') {
    const t = f.task;
    const metaBits = [`${t.estimatedMinutes} min`, PRIO_LABEL[t.priority], t.category].filter(Boolean).join(' · ');
    html = statRow('check', `Work on <b>${escapeHtml(t.title)}</b>`, { color: 'green' })
      + `<div class="brief-stat muted" style="padding-left:27px">${escapeHtml(metaBits)}</div>`
      + statRow('clock', `${fmtDur(f.availableMinutes)} until ${fmtTime(f.until)}${f.fits ? '' : ' — enough to make a start'}`, { color: 'accent' })
      + `<button class="primary full" id="startFocusBtn" style="margin-top:10px">${svgIcon('play', 18)} Start focus (${Math.min(t.estimatedMinutes, f.availableMinutes)} min)</button>`;
  } else if (f.status === 'busy') {
    html = statRow('clock', `You're in <b>${escapeHtml(f.event.title)}</b> until ${fmtTime(f.event.end)}.`, { color: 'accent' });
  } else if (f.status === 'free_no_tasks') {
    html = statRow('sun', `${fmtDur(f.availableMinutes)} free and nothing due — enjoy it, or add a task.`, { color: 'amber' });
  } else {
    html = `<div class="brief-stat">Nothing to suggest right now${f.reason === 'day_over' ? " — your day's work window is over." : '.'}</div>`;
  }
  $('queryBody').innerHTML = html;
  showQueryCard();
  if (f.status === 'ok') {
    const mins = Math.min(f.task.estimatedMinutes, f.availableMinutes);
    $('startFocusBtn').addEventListener('click', () => startFocus(f.task, mins));
  }
}

let focusTimer = null;
let focusState = null; // { taskId, title, endMs }

function startFocus(task, minutes) {
  hide($('queryCard'));
  focusState = { taskId: task.id, title: task.title, endMs: Date.now() + minutes * 60000 };
  $('focusTitle').textContent = task.title;
  show($('focusBar'));
  tickFocus();
  if (focusTimer) clearInterval(focusTimer);
  focusTimer = setInterval(tickFocus, 1000);
}

function tickFocus() {
  if (!focusState) return;
  const remain = focusState.endMs - Date.now();
  const over = remain < 0;
  const abs = Math.abs(remain);
  const mm = Math.floor(abs / 60000);
  const ss = Math.floor((abs % 60000) / 1000);
  const el = $('focusTime');
  el.textContent = `${over ? '+' : ''}${mm}:${String(ss).padStart(2, '0')}`;
  el.classList.toggle('over', over);
}

function stopFocus() {
  if (focusTimer) clearInterval(focusTimer);
  focusTimer = null;
  focusState = null;
  hide($('focusBar'));
}

async function focusDone() {
  const id = focusState && focusState.taskId;
  stopFocus();
  if (!id) return;
  await api(`/tasks/${id}`, { method: 'PATCH', body: { done: true, date: localTodayKey() } }).catch(() => {});
  toast('Nice — task done ✓', 'ok');
  loadTasks();
  loadBrief();
}

// --- Push notifications (daily brief + reminders) --------------------------
let notifyOn = false;

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
}

function setNotifyBtn(on) {
  notifyOn = on;
  const status = $('notifyStatus');
  if (status) status.textContent = on ? 'On' : 'Off';
  $('notifyBtn').classList.toggle('on', on);
  renderSetup(); // reminders is a setup step
}

async function setupNotifications() {
  const btn = $('notifyBtn');
  if (!pushSupported()) return; // stays hidden
  let info;
  try {
    info = await api('/push/key');
  } catch (_) {
    return;
  }
  if (!info.enabled) return; // server has no VAPID keys — leave the button hidden
  show(btn);
  try {
    await navigator.serviceWorker.register('/sw.js');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    setNotifyBtn(Boolean(sub));
  } catch (_) {
    setNotifyBtn(false);
  }
  btn.onclick = () => (notifyOn ? disableNotifications() : enableNotifications());
}

async function enableNotifications() {
  try {
    const info = await api('/push/key');
    if (!info.enabled) return toast('Reminders aren’t configured on the server.', 'err');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications permission was denied.', 'err');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(info.publicKey),
    });
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub, tzOffsetMinutes: TZ_OFFSET } });
    setNotifyBtn(true);
    await api('/push/test', { method: 'POST' }).catch(() => {});
    toast('Reminders on — sent you a test notification ✓', 'ok');
  } catch (err) {
    toast(`Couldn’t enable reminders: ${err.message}`, 'err');
  }
}

async function disableNotifications() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    setNotifyBtn(false);
    toast('Reminders off', '');
  } catch (err) {
    toast(err.message, 'err');
  }
}

// --- Tasks -----------------------------------------------------------------
const PRIO_RANK = { high: 0, med: 1, low: 2 };
const PRIO_LABEL = { high: 'High', med: 'Medium', low: 'Low' };

async function loadTasks() {
  try {
    const data = await api('/tasks');
    renderTasks(data.tasks || []);
  } catch (_) {
    /* non-fatal */
  }
}

let lastTasks = []; // last-loaded tasks, for the inline edit form

const DOW_ABBR = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
function localTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function isRecurring(t) { return Array.isArray(t.repeat) && t.repeat.length > 0; }
function repeatLabel(days) {
  if (!Array.isArray(days) || !days.length) return '';
  if (days.length === 7) return 'Daily';
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return 'Weekdays';
  return days.slice().sort((a, b) => a - b).map((d) => DOW_ABBR[d]).join(' ');
}

let taskFilterCat = null; // active category filter (null = All)

function isOverdue(t, todayKey) {
  return !isRecurring(t) && !t.done && t.deadline && t.deadline < todayKey;
}

function renderTasks(tasks) {
  lastTasks = tasks;
  const todayKey = localTodayKey();
  const todayDow = new Date().getDay();

  // Category suggestions for the form.
  const allCats = [...new Set(tasks.map((t) => t.category).filter(Boolean))].sort();
  $('catList').innerHTML = allCats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');

  // Active (not deferred) tasks relevant today; recurring only on due days.
  const active = tasks
    .filter((t) => !t.deferred)
    .map((t) => {
      const recurring = isRecurring(t);
      const checked = recurring ? t.lastDone === todayKey : Boolean(t.done);
      return { t, recurring, checked };
    })
    .filter(({ t, recurring, checked }) => !recurring || t.repeat.includes(todayDow) || checked)
    .filter(({ t }) => passTag(t)); // work/personal lens

  renderTaskFilter([...new Set(active.map(({ t }) => t.category).filter(Boolean))].sort());
  const shown = taskFilterCat ? active.filter(({ t }) => t.category === taskFilterCat) : active;

  if (!shown.length) {
    $('taskList').innerHTML = '<p class="muted" style="margin:6px 0">Nothing here. Add a task, then tap “Plan my day.”</p>';
  } else {
    shown.sort((a, b) =>
      a.checked - b.checked
      || (isOverdue(b.t, todayKey) - isOverdue(a.t, todayKey))
      || (PRIO_RANK[a.t.priority] ?? 1) - (PRIO_RANK[b.t.priority] ?? 1));
    $('taskList').innerHTML = shown
      .map(({ t, recurring, checked }) => {
        const overdue = isOverdue(t, todayKey);
        const bits = [`${t.estimatedMinutes} min`, PRIO_LABEL[t.priority]];
        if (!recurring && t.deadline) bits.push(overdue ? `⚠️ was due ${t.deadline}` : `by ${t.deadline}`);
        if (recurring) bits.push(`🔁 ${repeatLabel(t.repeat)}`);
        const streak = recurring && t.streak > 0 ? `<span class="t-badge streak">🔥 ${t.streak}</span>` : '';
        const cat = t.category ? `<span class="cat-chip">${escapeHtml(t.category)}</span>` : '';
        return `<div class="task ${checked ? 'done' : ''} ${overdue ? 'overdue' : ''} ${t.tag ? `tag-${t.tag}` : ''}">
            <input type="checkbox" class="t-check" data-id="${t.id}" ${checked ? 'checked' : ''} />
            <div class="t-title">${escapeHtml(t.title)} ${tagPill(t.tag)}${streak}${cat}<div class="t-meta">${escapeHtml(bits.join(' · '))}</div></div>
            <button class="t-edit" data-id="${t.id}" aria-label="edit">${svgIcon('edit', 18)}</button>
            <button class="t-defer" data-id="${t.id}" title="Move to Someday">${svgIcon('moon', 18)}</button>
            <button class="del" data-id="${t.id}" aria-label="delete">${svgIcon('close', 18)}</button>
          </div>`;
      })
      .join('');
    for (const c of $('taskList').querySelectorAll('.t-check')) {
      c.addEventListener('change', () => toggleTask(c.dataset.id, c.checked));
    }
    for (const e of $('taskList').querySelectorAll('.t-edit')) {
      e.addEventListener('click', () => startEditTask(e.dataset.id));
    }
    for (const b of $('taskList').querySelectorAll('.t-defer')) {
      b.addEventListener('click', () => deferTask(b.dataset.id, true));
    }
    for (const d of $('taskList').querySelectorAll('.del')) {
      d.addEventListener('click', () => deleteTask(d.dataset.id));
    }
  }

  renderSomeday(tasks.filter((t) => t.deferred));
}

function renderTaskFilter(cats) {
  const el = $('taskFilter');
  if (!cats.length) { el.innerHTML = ''; return; }
  const chip = (label, val) =>
    `<button class="ghost filter-chip ${taskFilterCat === val ? 'on' : ''}" data-cat="${val == null ? '' : escapeHtml(val)}">${escapeHtml(label)}</button>`;
  el.innerHTML = chip('All', null) + cats.map((c) => chip(c, c)).join('');
  for (const b of el.querySelectorAll('.filter-chip')) {
    b.addEventListener('click', () => { taskFilterCat = b.dataset.cat || null; renderTasks(lastTasks); });
  }
}

function renderSomeday(deferredAll) {
  const section = $('somedaySection');
  const deferred = deferredAll.filter(passTag); // respect the work/personal lens
  if (!deferred.length) { hide(section); return; }
  show(section);
  $('somedayCount').textContent = deferred.length;
  $('somedayList').innerHTML = deferred
    .map((t) => {
      const meta = [PRIO_LABEL[t.priority], t.category].filter(Boolean).join(' · ');
      return `<div class="task ${t.tag ? `tag-${t.tag}` : ''}">
          <div class="t-title">${escapeHtml(t.title)} ${tagPill(t.tag)}<div class="t-meta">${escapeHtml(meta)}</div></div>
          <button class="t-wake" data-id="${t.id}" title="Move back to active">${svgIcon('sun', 18)}</button>
          <button class="del" data-id="${t.id}" aria-label="delete">${svgIcon('close', 18)}</button>
        </div>`;
    })
    .join('');
  for (const b of $('somedayList').querySelectorAll('.t-wake')) {
    b.addEventListener('click', () => deferTask(b.dataset.id, false));
  }
  for (const d of $('somedayList').querySelectorAll('.del')) {
    d.addEventListener('click', () => deleteTask(d.dataset.id));
  }
}

async function toggleTask(id, done) {
  // Send the local date so recurring "done today" + streaks are computed correctly.
  await api(`/tasks/${id}`, { method: 'PATCH', body: { done, date: localTodayKey() } }).catch(() => {});
  loadTasks();
  loadBrief();
}

async function deferTask(id, deferred) {
  await api(`/tasks/${id}`, { method: 'PATCH', body: { deferred } }).catch(() => {});
  loadTasks();
}

async function deleteTask(id) {
  const t = (lastTasks || []).find((x) => x.id === id);
  const name = t && t.title ? `“${t.title}”` : 'this task';
  if (!window.confirm(`Delete ${name}?`)) return;
  await api(`/tasks/${id}`, { method: 'DELETE' }).catch(() => {});
  loadTasks();
}

// Repeat day-chip helpers.
function selectedRepeatDays() {
  return [...$('taskRepeat').querySelectorAll('button.on')].map((b) => parseInt(b.dataset.d, 10));
}
function setRepeatDays(days) {
  const set = new Set(days || []);
  for (const b of $('taskRepeat').querySelectorAll('button')) {
    b.classList.toggle('on', set.has(parseInt(b.dataset.d, 10)));
  }
}

let editingTaskId = null; // when set, the task form saves an edit instead of adding

async function addTaskFromForm() {
  const title = $('taskTitle').value.trim();
  if (!title) return toast('Enter a task title', 'err');
  const editing = editingTaskId;
  const body = {
    title,
    estimatedMinutes: parseInt($('taskMins').value, 10) || 30,
    priority: $('taskPriority').value,
    deadline: $('taskDeadline').value || null,
    repeat: selectedRepeatDays(), // [] → one-off
    category: $('taskCategory').value.trim() || null,
    tag: segValue('taskTag') || null,
  };
  try {
    if (editing) {
      await api(`/tasks/${editing}`, { method: 'PATCH', body });
    } else {
      await api('/tasks', { method: 'POST', body });
    }
    resetTaskForm();
    hide($('taskForm'));
    toast(editing ? 'Task updated ✓' : 'Task added ✓', 'ok');
    loadTasks();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function resetTaskForm() {
  editingTaskId = null;
  $('taskTitle').value = '';
  $('taskDeadline').value = '';
  $('taskMins').value = '30';
  $('taskPriority').value = 'med';
  $('taskCategory').value = '';
  setSeg('taskTag', '');
  setRepeatDays([]);
  $('taskAddBtn').textContent = 'Add task';
}

function startEditTask(id) {
  const t = lastTasks.find((x) => x.id === id);
  if (!t) return;
  editingTaskId = id;
  $('taskTitle').value = t.title || '';
  $('taskMins').value = t.estimatedMinutes || 30;
  $('taskPriority').value = t.priority || 'med';
  $('taskDeadline').value = t.deadline || '';
  $('taskCategory').value = t.category || '';
  setSeg('taskTag', t.tag || '');
  setRepeatDays(t.repeat || []);
  $('taskAddBtn').textContent = 'Save changes';
  show($('taskForm'));
  $('taskForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function planTasks(order) {
  setLoading(true);
  try {
    const body = { tzOffsetMinutes: TZ_OFFSET };
    if (tagFilter !== 'all') body.priorityTag = tagFilter; // work/personal-first
    if (order) body.order = order;
    const plan = await api(`/tasks/plan/${activeProvider}`, { method: 'POST', body });
    renderTaskPlan(plan);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

let lastPlanSlots = []; // task slots from the most recent plan, for time-blocking
let planTaskOrder = []; // task ids in the current plan order (for manual rearrange)

// Merged timeline of today's events + suggested task slots (tasks marked 📋).
// Task rows carry ↑/↓ controls to re-prioritize; re-planning re-slots them.
function renderTaskPlan(plan) {
  lastPlanSlots = (plan.slots || []).map((s) => ({ taskId: s.taskId, title: s.title, start: s.start, end: s.end }));
  // Canonical task order: scheduled (in placement order) then unscheduled.
  planTaskOrder = [...(plan.slots || []).map((s) => s.taskId), ...(plan.unscheduled || []).map((t) => t.id)];
  const reorderable = planTaskOrder.length > 1;

  const items = [];
  for (const e of plan.events || []) if (e.start.includes('T')) items.push({ kind: 'event', title: e.title, start: e.start, end: e.end });
  for (const s of plan.slots || []) items.push({ kind: 'task', title: s.title, start: s.start, end: s.end, taskId: s.taskId });
  items.sort((a, b) => new Date(a.start) - new Date(b.start));

  const moveBtns = (id) => reorderable
    ? `<div class="plan-move"><button class="mv" data-dir="-1" data-id="${escapeHtml(id)}" aria-label="earlier">▲</button><button class="mv" data-dir="1" data-id="${escapeHtml(id)}" aria-label="later">▼</button></div>`
    : '';

  let html = '<div class="daygroup">';
  if (!items.length) html += '<p class="muted center">Nothing to plan — no events or tasks.</p>';
  for (const it of items) {
    const cls = it.kind === 'task' ? 'event task-slot' : 'event';
    const badge = it.kind === 'task' ? '📋 ' : '';
    html += `<div class="${cls}"><div class="time">${fmtRange(it.start, it.end)}</div><div class="title">${badge}${escapeHtml(it.title)}</div>${it.kind === 'task' ? moveBtns(it.taskId) : ''}</div>`;
  }
  html += '</div>';
  if (plan.unscheduled && plan.unscheduled.length) {
    html += '<h3 class="muted" style="margin:12px 0 4px">Couldn’t fit today</h3>';
    html += plan.unscheduled
      .map((t) => `<div class="event unfit"><div class="title">${t.atRisk ? '⚠️ ' : ''}${escapeHtml(t.title)} <span class="muted">(${t.estimatedMinutes} min${t.deadline ? `, due ${t.deadline}` : ''})</span></div>${moveBtns(t.id)}</div>`)
      .join('');
  }
  $('planBody').innerHTML = html;
  for (const b of $('planBody').querySelectorAll('.mv')) {
    b.addEventListener('click', () => moveTaskInPlan(b.dataset.id, parseInt(b.dataset.dir, 10)));
  }
  $('commitPlanBtn').classList.toggle('hidden', lastPlanSlots.length === 0);
  hide($('voiceCard'));
  hide($('proposalCard'));
  show($('taskPlanCard'));
  $('taskPlanCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Move a task earlier/later in the plan queue, then re-plan with the new order
// so it re-slots around the fixed events.
function moveTaskInPlan(id, dir) {
  const i = planTaskOrder.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= planTaskOrder.length) return;
  const arr = planTaskOrder.slice();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  planTasks(arr);
}

// Time-blocking: write the suggested task slots onto the calendar (opt-in).
async function commitPlan() {
  if (!lastPlanSlots.length) return;
  setLoading(true);
  try {
    const res = await api(`/tasks/commit/${activeProvider}`, { method: 'POST', body: { slots: lastPlanSlots } });
    toast(`Added ${res.created} block${res.created === 1 ? '' : 's'} to your calendar ✓`, res.failed ? 'err' : 'ok');
    hide($('taskPlanCard'));
    lastPlanSlots = [];
    await loadEvents();
    await loadTasks();
    await loadBrief();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

// --- Wire up ---------------------------------------------------------------
function setScope(next) {
  scope = next;
  $('optScope').textContent = next;
  for (const b of $('scopeToggle').children) b.classList.toggle('active', b.dataset.scope === next);
  hide($('proposalCard'));
  loadEvents();
}

function init() {
  tzBase = `UTC${TZ_OFFSET >= 0 ? '+' : ''}${(TZ_OFFSET / 60).toFixed(0)}h · ${Intl.DateTimeFormat().resolvedOptions().timeZone || ''}`;
  $('tzLabel').textContent = tzBase;

  // Handle OAuth redirect results.
  const params = new URLSearchParams(window.location.search);
  if (params.get('connected')) toast(`Connected ${params.get('connected')} ✓`, 'ok');
  if (params.get('auth_error')) toast(`Connection failed: ${params.get('auth_error')}`, 'err');
  if (params.toString()) history.replaceState({}, '', '/');

  for (const b of $('scopeToggle').children) b.addEventListener('click', () => setScope(b.dataset.scope));
  $('refreshBtn').addEventListener('click', loadEvents);
  $('addEventToggle').addEventListener('click', () => {
    const form = $('eventForm');
    const opening = form.classList.contains('hidden');
    if (opening) {
      resetEventForm();
      primeEventForm();
    }
    form.classList.toggle('hidden');
  });
  $('evAddBtn').addEventListener('click', addEventFromForm);
  $('evDeleteBtn').addEventListener('click', () => { if (editingEventId) deleteEventById(editingEventId); });
  $('evRepeat').addEventListener('change', onRepeatChange);
  $('evEnds').addEventListener('change', onEndsChange);
  wireSeg('evTag');
  wireSeg('taskTag');
  setTagFilter(tagFilter); // reflect the saved lens in the filter bar
  for (const b of $('tagFilterBar').querySelectorAll('button')) {
    b.addEventListener('click', () => setTagFilter(b.dataset.tag));
  }
  // Meditation card
  for (const b of document.querySelectorAll('.med-dur')) {
    b.addEventListener('click', () => startMeditation(parseInt(b.dataset.min, 10) || 5));
  }
  $('medStopBtn').addEventListener('click', stopMeditation);
  $('medDoneBtn').addEventListener('click', markMeditationDone);
  $('medScheduleBtn').addEventListener('click', scheduleMeditation);
  setupCollapse('meditationCard', 'medCollapse', 'collapse.meditation');
  $('claudeToggle').addEventListener('change', () => {
    localStorage.setItem('useClaudeOptimizer', $('claudeToggle').checked ? '1' : '0');
  });
  $('optimizeBtn').addEventListener('click', runOptimize);
  $('applyBtn').addEventListener('click', applyProposal);
  $('cancelBtn').addEventListener('click', () => hide($('proposalCard')));
  $('addTaskToggle').addEventListener('click', () => {
    const form = $('taskForm');
    if (form.classList.contains('hidden')) resetTaskForm();
    form.classList.toggle('hidden');
  });
  $('taskAddBtn').addEventListener('click', addTaskFromForm);
  $('taskRepeat').addEventListener('click', (e) => {
    if (e.target.matches('button[data-d]')) e.target.classList.toggle('on');
  });
  $('whatnowBtn').addEventListener('click', loadFocus);
  $('somedayToggle').addEventListener('click', () => {
    const list = $('somedayList');
    list.classList.toggle('hidden');
    $('somedayChevron').textContent = list.classList.contains('hidden') ? '▸' : '▾';
  });
  $('focusDoneBtn').addEventListener('click', focusDone);
  $('focusStopBtn').addEventListener('click', stopFocus);
  for (const b of $('tabbar').querySelectorAll('.tab')) {
    b.addEventListener('click', () => setTab(b.dataset.tab));
  }
  $('planBtn').addEventListener('click', planTasks);
  $('planCloseBtn').addEventListener('click', () => hide($('taskPlanCard')));
  $('commitPlanBtn').addEventListener('click', commitPlan);
  $('queryCloseBtn').addEventListener('click', () => hide($('queryCard')));
  $('briefRefresh').addEventListener('click', loadBrief);
  $('reviewBtn').addEventListener('click', loadReview);
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsCloseBtn').addEventListener('click', () => hide($('settingsCard')));
  $('settingsSaveBtn').addEventListener('click', saveSettings);
  $('exportBtn').addEventListener('click', exportData);
  setupCollapse('briefCard', 'briefCollapse', 'collapse.brief');
  setupCollapse('todayCard', 'todayCollapse', 'collapse.schedule');
  setupCollapse('tasksCard', 'tasksCollapse', 'collapse.tasks');
  $('micBtn').addEventListener('click', startVoice);
  $('voiceConfirmBtn').addEventListener('click', confirmVoice);
  $('voiceCancelBtn').addEventListener('click', () => {
    pendingVoice = null;
    hide($('voiceCard'));
  });
  injectIcons();
  applyTheme(localStorage.getItem('appTheme') || 'default');
  $('themeBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleThemeMenu(); });
  $('themeMoreBtn').addEventListener('click', (e) => { e.stopPropagation(); window.scrollTo({ top: 0, behavior: 'smooth' }); toggleThemeMenu(); });
  $('setupDismiss').addEventListener('click', () => { localStorage.setItem('setupDismissed', '1'); renderSetup(); });
  document.addEventListener('click', (e) => {
    if (!$('themeMenu').classList.contains('hidden') && !e.target.closest('#themeMenu') && e.target !== $('themeBtn')) {
      hide($('themeMenu'));
    }
  });
  $('logoutBtn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  registerServiceWorker();
  refreshConnection();
}

// Register the service worker on load so the app is installable (PWA) and its
// shell works offline. Push setup reuses this same registration when enabled.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
