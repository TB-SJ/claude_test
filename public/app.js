'use strict';

// Single-user mobile dashboard. Talks to the same-origin API (cookie auth).
// The active provider is auto-detected from whichever calendar is connected.
const PROVIDER_ORDER = ['outlook', 'google'];
const PROVIDER_LABEL = { google: 'Google Calendar', outlook: 'Outlook Calendar' };
// Minutes to add to UTC to get local time (matches the optimizer's convention).
const TZ_OFFSET = -new Date().getTimezoneOffset();

let activeProvider = null;
let scope = 'day';
let proposal = null; // last analyze() result
let tzBase = '';

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
    const provs = health.providers || {};
    // Use the first connected provider (Outlook preferred, then Google).
    activeProvider = PROVIDER_ORDER.find((p) => provs[p] && provs[p].connected) || null;

    if (activeProvider) {
      $('tzLabel').textContent = `${tzBase} · ${PROVIDER_LABEL[activeProvider]}`;
      hide($('connectCard'));
      show($('todayCard'));
      show($('tasksCard'));
      show($('micBtn')); // voice control available once connected
      await loadEvents();
      await loadTasks();
    } else {
      hide($('micBtn'));
      hide($('tasksCard'));
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

async function loadEvents() {
  setLoading(true);
  try {
    const data = await api(`/calendar/${activeProvider}/events?range=${scope}`);
    renderSchedule($('eventList'), data.events || []);
  } catch (err) {
    $('eventList').innerHTML = `<p class="muted">Couldn't load events: ${escapeHtml(err.message)}</p>`;
  } finally {
    setLoading(false);
  }
}

// Renders the current global `proposal` into the proposal card. Shared by the
// Optimize button and the voice "optimize" command. `note` is an optional
// header line (e.g. the transcript that triggered it).
function renderProposalCard(note) {
  hide($('voiceCard'));
  const c = proposal.analysis.counts;
  const issues = c.conflicts + c.bufferIssues + c.fragmentedGaps + c.deepWorkViolations;
  const noteHtml = note ? `<p class="muted" style="margin:0 0 8px">${escapeHtml(note)}</p>` : '';

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
  try {
    proposal = await api(`/schedule/${activeProvider}/analyze`, {
      method: 'POST',
      body: { range: scope, rules: { tzOffsetMinutes: TZ_OFFSET } },
    });
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
  need_title: "I didn't catch what event you meant.",
  need_time: "I didn't catch a time — try e.g. \"add lunch tomorrow at noon\".",
  not_found: 'No matching event found in the next 3 weeks.',
};

// Small badge shown when Claude (not the rules parser) understood the command.
const engineSuffix = (result) => (result && result.engine === 'claude' ? '  ·  🧠 Claude' : '');

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

function renderTasks(tasks) {
  if (!tasks.length) {
    $('taskList').innerHTML = '<p class="muted" style="margin:6px 0">No tasks yet. Add one, then tap “Plan my day.”</p>';
    return;
  }
  tasks.sort((a, b) => a.done - b.done || (PRIO_RANK[a.priority] ?? 1) - (PRIO_RANK[b.priority] ?? 1));
  $('taskList').innerHTML = tasks
    .map((t) => {
      const meta = [`${t.estimatedMinutes} min`, PRIO_LABEL[t.priority], t.deadline ? `by ${t.deadline}` : null]
        .filter(Boolean)
        .join(' · ');
      return `<div class="task ${t.done ? 'done' : ''}">
          <input type="checkbox" class="t-check" data-id="${t.id}" ${t.done ? 'checked' : ''} />
          <div class="t-title">${escapeHtml(t.title)}<div class="t-meta">${escapeHtml(meta)}</div></div>
          <button class="del" data-id="${t.id}" aria-label="delete">✕</button>
        </div>`;
    })
    .join('');
  for (const c of $('taskList').querySelectorAll('.t-check')) {
    c.addEventListener('change', () => toggleTask(c.dataset.id, c.checked));
  }
  for (const d of $('taskList').querySelectorAll('.del')) {
    d.addEventListener('click', () => deleteTask(d.dataset.id));
  }
}

async function toggleTask(id, done) {
  await api(`/tasks/${id}`, { method: 'PATCH', body: { done } }).catch(() => {});
  loadTasks();
}

async function deleteTask(id) {
  await api(`/tasks/${id}`, { method: 'DELETE' }).catch(() => {});
  loadTasks();
}

async function addTaskFromForm() {
  const title = $('taskTitle').value.trim();
  if (!title) return toast('Enter a task title', 'err');
  const body = {
    title,
    estimatedMinutes: parseInt($('taskMins').value, 10) || 30,
    priority: $('taskPriority').value,
    deadline: $('taskDeadline').value || null,
  };
  try {
    await api('/tasks', { method: 'POST', body });
    $('taskTitle').value = '';
    $('taskDeadline').value = '';
    hide($('taskForm'));
    toast('Task added ✓', 'ok');
    loadTasks();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function planTasks() {
  setLoading(true);
  try {
    const plan = await api(`/tasks/plan/${activeProvider}`, { method: 'POST', body: { tzOffsetMinutes: TZ_OFFSET } });
    renderTaskPlan(plan);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

// Merged timeline of today's events + suggested task slots (tasks marked 📋).
function renderTaskPlan(plan) {
  const items = [];
  for (const e of plan.events || []) if (e.start.includes('T')) items.push({ kind: 'event', title: e.title, start: e.start, end: e.end });
  for (const s of plan.slots || []) items.push({ kind: 'task', title: s.title, start: s.start, end: s.end });
  items.sort((a, b) => new Date(a.start) - new Date(b.start));

  let html = '<div class="daygroup">';
  if (!items.length) html += '<p class="muted center">Nothing to plan — no events or tasks.</p>';
  for (const it of items) {
    const cls = it.kind === 'task' ? 'event task-slot' : 'event';
    const badge = it.kind === 'task' ? '📋 ' : '';
    html += `<div class="${cls}"><div class="time">${fmtRange(it.start, it.end)}</div><div class="title">${badge}${escapeHtml(it.title)}</div></div>`;
  }
  html += '</div>';
  if (plan.unscheduled && plan.unscheduled.length) {
    html += '<h3 class="muted" style="margin:12px 0 4px">Couldn’t fit today</h3>';
    html += plan.unscheduled
      .map((t) => `<div class="reason" style="margin-left:0">• ${escapeHtml(t.title)} (${t.estimatedMinutes} min)</div>`)
      .join('');
  }
  $('planBody').innerHTML = html;
  hide($('voiceCard'));
  hide($('proposalCard'));
  show($('taskPlanCard'));
  $('taskPlanCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  $('optimizeBtn').addEventListener('click', runOptimize);
  $('applyBtn').addEventListener('click', applyProposal);
  $('cancelBtn').addEventListener('click', () => hide($('proposalCard')));
  $('addTaskToggle').addEventListener('click', () => $('taskForm').classList.toggle('hidden'));
  $('taskAddBtn').addEventListener('click', addTaskFromForm);
  $('planBtn').addEventListener('click', planTasks);
  $('planCloseBtn').addEventListener('click', () => hide($('taskPlanCard')));
  $('micBtn').addEventListener('click', startVoice);
  $('voiceConfirmBtn').addEventListener('click', confirmVoice);
  $('voiceCancelBtn').addEventListener('click', () => {
    pendingVoice = null;
    hide($('voiceCard'));
  });
  $('logoutBtn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  refreshConnection();
}

document.addEventListener('DOMContentLoaded', init);
