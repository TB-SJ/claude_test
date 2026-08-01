'use strict';

// Single-user mobile dashboard. Talks to the same-origin API (cookie auth).
const PROVIDER = 'google';
// Minutes to add to UTC to get local time (matches the optimizer's convention).
const TZ_OFFSET = -new Date().getTimezoneOffset();

let scope = 'day';
let proposal = null; // last analyze() result

// --- DOM helpers -----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

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
// the event's current time plus a struck-through "was <old>" note.
function eventRow(ev, wasRange) {
  const changed = Boolean(wasRange);
  return `<div class="event ${changed ? 'changed' : ''}">
      <div class="time">${fmtRange(ev.start, ev.end)}</div>
      <div>
        <div class="title">${escapeHtml(ev.title || '(untitled)')}</div>
        ${changed ? `<div class="muted" style="font-size:.82rem">was <span class="old">${wasRange}</span></div>` : ''}
      </div>
    </div>`;
}

function renderSchedule(container, events, changedMap) {
  const groups = groupByDay(events);
  if (groups.size === 0) {
    container.innerHTML = '<p class="muted center">No events.</p>';
    return;
  }
  let html = '';
  for (const [, list] of groups) {
    html += `<div class="daygroup"><h3>${dayLabel(list[0].start)}</h3>`;
    for (const ev of list) html += eventRow(ev, changedMap ? changedMap.get(ev.id) : null);
    html += '</div>';
  }
  container.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Flows -----------------------------------------------------------------
async function refreshConnection() {
  try {
    const health = await api('/health');
    const connected = health.providers && health.providers[PROVIDER] && health.providers[PROVIDER].connected;
    if (connected) {
      hide($('connectCard'));
      show($('todayCard'));
      await loadEvents();
    } else {
      show($('connectCard'));
      hide($('todayCard'));
      hide($('proposalCard'));
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function loadEvents() {
  setLoading(true);
  try {
    const data = await api(`/calendar/${PROVIDER}/events?range=${scope}`);
    renderSchedule($('eventList'), data.events || []);
  } catch (err) {
    $('eventList').innerHTML = `<p class="muted">Couldn't load events: ${escapeHtml(err.message)}</p>`;
  } finally {
    setLoading(false);
  }
}

async function runOptimize() {
  setLoading(true);
  hide($('proposalCard'));
  try {
    proposal = await api(`/schedule/${PROVIDER}/analyze`, {
      method: 'POST',
      body: { range: scope, rules: { tzOffsetMinutes: TZ_OFFSET } },
    });
    const c = proposal.analysis.counts;
    const issues = c.conflicts + c.bufferIssues + c.fragmentedGaps + c.deepWorkViolations;

    if (!proposal.moves.length) {
      $('analysisPill').textContent = 'All clear';
      $('analysisPill').className = 'pill ok';
      $('beforeAfter').innerHTML = '<p class="center">✅ Your ' + scope + ' is already optimized — nothing to change.</p>';
      $('reasons').innerHTML = '';
      hide($('applyBtn'));
    } else {
      $('analysisPill').textContent = `${issues} issue${issues === 1 ? '' : 's'} found`;
      $('analysisPill').className = issues ? 'pill warn' : 'pill';
      // Map each moved event id -> its ORIGINAL (before) time, shown struck in the After list.
      const changedMap = new Map(proposal.moves.map((m) => [m.id, fmtRange(m.from.start, m.from.end)]));
      const after = applyMoves(proposal.events, proposal.moves);
      $('beforeAfter').innerHTML =
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
    const result = await api(`/schedule/${PROVIDER}/apply`, {
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

// --- Wire up ---------------------------------------------------------------
function setScope(next) {
  scope = next;
  $('optScope').textContent = next;
  for (const b of $('scopeToggle').children) b.classList.toggle('active', b.dataset.scope === next);
  hide($('proposalCard'));
  loadEvents();
}

function init() {
  $('tzLabel').textContent = `UTC${TZ_OFFSET >= 0 ? '+' : ''}${(TZ_OFFSET / 60).toFixed(0)}h · ${Intl.DateTimeFormat().resolvedOptions().timeZone || ''}`;

  // Handle OAuth redirect results.
  const params = new URLSearchParams(window.location.search);
  if (params.get('connected')) toast(`Connected ${params.get('connected')} ✓`, 'ok');
  if (params.get('auth_error')) toast(`Connection failed: ${params.get('auth_error')}`, 'err');
  if (params.toString()) history.replaceState({}, '', '/');

  for (const b of $('scopeToggle').children) b.addEventListener('click', () => setScope(b.dataset.scope));
  $('refreshBtn').addEventListener('click', loadEvents);
  $('optimizeBtn').addEventListener('click', runOptimize);
  $('applyBtn').addEventListener('click', applyProposal);
  $('cancelBtn').addEventListener('click', () => hide($('proposalCard')));
  $('logoutBtn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  refreshConnection();
}

document.addEventListener('DOMContentLoaded', init);
