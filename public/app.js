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
let claudeAvailable = false; // server has ANTHROPIC_API_KEY set

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

// --- Theme (default / One Piece pirate) ------------------------------------
function applyTheme(themed) {
  document.body.classList.toggle('theme-onepiece', themed);
  $('brandIcon').textContent = themed ? '👒' : '🗓';
  $('brandName').textContent = themed ? 'Grand Line Planner' : 'Calendar Optimizer';
  $('themeBtn').textContent = themed ? '🗓' : '👒';
  $('themeBtn').title = themed ? 'Switch to the default theme' : 'Switch to the pirate theme';
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
  const edit = editable ? `<button class="ev-edit" data-id="${escapeHtml(ev.id)}" aria-label="edit">✎</button>` : '';
  return `<div class="event ${changed ? 'changed' : ''}">
      <div class="time">${fmtRange(ev.start, ev.end)}</div>
      <div style="flex:1">
        <div class="title">${escapeHtml(ev.title || '(untitled)')}</div>
        ${changed ? `<div class="muted" style="font-size:.82rem">was <span class="old">${wasRange}</span></div>` : ''}
      </div>
      ${edit}
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
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
      show($('todayCard'));
      show($('tasksCard'));
      show($('micBtn')); // voice control available once connected
      show($('briefCard'));
      await loadEvents();
      await loadTasks();
      await loadBrief();
      setupNotifications();
    } else {
      hide($('micBtn'));
      hide($('tasksCard'));
      hide($('briefCard'));
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
    const data = await api(`/calendar/${activeProvider}/events?range=${scope}&date=${encodeURIComponent(localAnchor)}`);
    currentEvents = data.events || [];
    renderSchedule($('eventList'), currentEvents, null, { editable: true });
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
  };
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

function resetEventForm() {
  editingEventId = null;
  $('evTitle').value = '';
  $('evDesc').value = '';
  $('evDate').value = '';
  $('evTime').value = '';
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
  $('evAddBtn').textContent = 'Save changes';
  show($('eventForm'));
  $('eventForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    $('briefBody').innerHTML = '<p class="muted">Couldn\'t load your brief.</p>';
  }
}

function renderBrief(b) {
  $('briefTitle').textContent = `🌅 Today · ${dayLabelFromKey(b.dayKey)}`;
  const rows = [];
  rows.push(
    b.meetingCount
      ? `🗓 ${b.meetingCount} meeting${b.meetingCount === 1 ? '' : 's'} · ${fmtDur(b.meetingMinutes)} booked`
      : '🗓 No meetings today'
  );
  const dw = b.deepWorkClear === true ? ' · deep-work protected ✓'
    : b.deepWorkClear === false ? ' · deep-work has a meeting ⚠️' : '';
  rows.push(`🎯 ${fmtDur(b.freeMinutes)} free${dw}`);
  if (b.nextEvent) rows.push(`⏭ Next: ${escapeHtml(b.nextEvent.title)} at ${fmtTime(b.nextEvent.start)}`);
  if (b.topTask) {
    rows.push(`✅ Top task: ${escapeHtml(b.topTask.title)} (${fmtDur(b.topTask.estimatedMinutes || 30)}${b.topTask.priority === 'high' ? ', High' : ''})`);
  } else if (b.pendingTaskCount === 0) {
    rows.push('✅ No open tasks');
  }
  let html = rows.map((r) => `<div class="brief-stat">${r}</div>`).join('');
  for (const r of b.atRisk || []) {
    html += `<div class="brief-stat warn">⚠️ ${escapeHtml(r.title)} — ${escapeHtml(r.when)}</div>`;
  }
  $('briefBody').innerHTML = html;
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
  const btn = $('notifyBtn');
  btn.textContent = on ? '🔔 On' : '🔔 Reminders';
  btn.classList.toggle('active', on);
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

function renderTasks(tasks) {
  lastTasks = tasks;
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
          <button class="t-edit" data-id="${t.id}" aria-label="edit">✎</button>
          <button class="del" data-id="${t.id}" aria-label="delete">✕</button>
        </div>`;
    })
    .join('');
  for (const c of $('taskList').querySelectorAll('.t-check')) {
    c.addEventListener('change', () => toggleTask(c.dataset.id, c.checked));
  }
  for (const e of $('taskList').querySelectorAll('.t-edit')) {
    e.addEventListener('click', () => startEditTask(e.dataset.id));
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
  $('taskAddBtn').textContent = 'Save changes';
  show($('taskForm'));
  $('taskForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
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

let lastPlanSlots = []; // task slots from the most recent plan, for time-blocking

// Merged timeline of today's events + suggested task slots (tasks marked 📋).
function renderTaskPlan(plan) {
  lastPlanSlots = (plan.slots || []).map((s) => ({ taskId: s.taskId, title: s.title, start: s.start, end: s.end }));
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
      .map((t) => `<div class="reason ${t.atRisk ? 'warn' : ''}" style="margin-left:0">• ${t.atRisk ? '⚠️ ' : ''}${escapeHtml(t.title)} (${t.estimatedMinutes} min${t.deadline ? `, due ${t.deadline}` : ''})</div>`)
      .join('');
  }
  $('planBody').innerHTML = html;
  $('commitPlanBtn').classList.toggle('hidden', lastPlanSlots.length === 0);
  hide($('voiceCard'));
  hide($('proposalCard'));
  show($('taskPlanCard'));
  $('taskPlanCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  $('planBtn').addEventListener('click', planTasks);
  $('planCloseBtn').addEventListener('click', () => hide($('taskPlanCard')));
  $('commitPlanBtn').addEventListener('click', commitPlan);
  $('queryCloseBtn').addEventListener('click', () => hide($('queryCard')));
  $('briefRefresh').addEventListener('click', loadBrief);
  setupCollapse('briefCard', 'briefCollapse', 'collapse.brief');
  setupCollapse('todayCard', 'todayCollapse', 'collapse.schedule');
  setupCollapse('tasksCard', 'tasksCollapse', 'collapse.tasks');
  $('micBtn').addEventListener('click', startVoice);
  $('voiceConfirmBtn').addEventListener('click', confirmVoice);
  $('voiceCancelBtn').addEventListener('click', () => {
    pendingVoice = null;
    hide($('voiceCard'));
  });
  applyTheme(localStorage.getItem('appTheme') === 'onepiece');
  $('themeBtn').addEventListener('click', () => {
    const themed = !document.body.classList.contains('theme-onepiece');
    applyTheme(themed);
    localStorage.setItem('appTheme', themed ? 'onepiece' : 'default');
  });
  $('logoutBtn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  refreshConnection();
}

document.addEventListener('DOMContentLoaded', init);
