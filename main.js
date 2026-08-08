// claude-orchestrator — vanilla frontend logic.
//
// In local dev, Vite proxies /api -> localhost:3001, so API_BASE is ''.
// In production (Netlify), set VITE_API_URL to your Cloudflare Tunnel URL and
// all calls go straight to your local backend. See README.
const API_BASE = import.meta.env.VITE_API_URL || '';

// Worker model choices are "client:model" refs fetched from /api/models at boot
// (capability-filtered so only CLI/tool-capable models appear). EFFORTS is static.
const EFFORTS = ['low', 'medium', 'high', 'ultracode'];

let state = { tasks: [], completed: [], aborted: [], running: [], maxConcurrency: 3, models: [], roles: {}, keys: [] };
let eventSource = null;
let refreshTimer = null;
// Per-task SSE streams for individually-started tasks (id -> EventSource).
const taskStreams = {};

// --- DOM refs --------------------------------------------------------------
const el = (id) => document.getElementById(id);
const planBtn = el('planBtn');
const runBtn = el('runBtn');
const splitBtn = el('splitBtn');
const lessonsBtn = el('lessonsBtn');
const concurrencyInput = el('concurrencyInput');
const retryAllBtn = el('retryAllBtn');
const promptFile = el('promptFile');
const promptText = el('promptText');
const targetDir = el('targetDir');
const setDirBtn = el('setDirBtn');
const dirStatus = el('dirStatus');
const planStatus = el('planStatus');
const tableWrap = el('tableWrap');
const consoleBox = el('console');
const contextFile = el('contextFile');
const uploadContextBtn = el('uploadContextBtn');
const contextStatus = el('contextStatus');
const contextList = el('contextList');

// --- Console helpers -------------------------------------------------------
function log(text, cls) {
  if (consoleBox.classList.contains('empty')) {
    consoleBox.textContent = '';
    consoleBox.classList.remove('empty');
  }
  if (cls) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text.endsWith('\n') ? text : text + '\n';
    consoleBox.appendChild(span);
  } else {
    consoleBox.appendChild(document.createTextNode(text));
  }
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

// --- API -------------------------------------------------------------------
async function api(path, options) {
  const res = await fetch(API_BASE + path, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Fetch the configured model refs (+ capabilities). Never throws — a failure
// just leaves the dropdown showing whatever each task already has assigned.
async function loadModels() {
  try {
    const data = await api('/api/models');
    state.models = Array.isArray(data.models) ? data.models : [];
    state.roles = data.roles && typeof data.roles === 'object' ? data.roles : {};
  } catch (e) {
    state.models = [];
    state.roles = {};
    console.warn('loadModels:', e.message);
  }
  renderRoles();
}

// The configurable text stages, in display order. The planner is rendered
// prominently (its own #role-planner select in the HTML); the rest live in the
// collapsible #rolesGrid. Every model can back a text role (planning is a plain
// completion), so — unlike the Worker dropdown — these are NOT capability-filtered.
const TEXT_ROLES = [
  { key: 'planner', label: 'Planner — plans & analyzes the task breakdown' },
  { key: 'splitter', label: 'Splitter — splits oversized/complex tasks' },
  { key: 'healer', label: 'Healer — suggests fixes for failed tasks' },
  { key: 'lessoner', label: 'Lessoner — distills lessons from failures' },
  { key: 'auditor', label: 'Auditor — reviews finished work against the master prompt' },
  { key: 'analyzer', label: 'Analyzer — guesses file overlap for concurrent runs' },
];

// The current "client:model" ref assigned to a role (from config).
function roleRef(role) {
  const r = state.roles[role];
  return r && r.client && r.model ? `${r.client}:${r.model}` : '';
}

// What a model costs, whether the key can currently call it, and how it scored
// on the coding probes — written by `node build-models.mjs` and
// `node rank-coding.mjs` from real calls. Shown in every model dropdown so a
// model that needs billing, or that can't write working code, is visible as such
// BEFORE it's assigned and dies mid-run. An unprobed model carries no labels and
// shows as a bare ref, which reads as "unknown" rather than "free" or "weak".
const COST_LABEL = { free: 'free', 'free-tier': 'free tier', subscription: 'subscription', paid: 'paid' };
function modelLabel(ref) {
  const m = state.models.find((x) => x.ref === ref);
  if (!m) return ref;
  const tags = [];
  if (m.access === 'blocked') tags.push(`⚠ ${m.accessNote || 'unavailable'}`);
  if (COST_LABEL[m.cost]) tags.push(COST_LABEL[m.cost]);
  if (m.codingTier) tags.push(`coding: ${m.codingTier}`);
  return tags.length ? `${ref} · ${tags.join(' · ')}` : ref;
}

// Blocked models sort last (they're still selectable — the block is about
// today's balance, not the config), otherwise config order is preserved.
function byUsableFirst(a, b) {
  const blocked = (ref) => (state.models.find((x) => x.ref === ref)?.access === 'blocked' ? 1 : 0);
  return blocked(a) - blocked(b);
}

// Shared by both model dropdowns. Distinct from the plain `optionsHtml` below,
// which renders the effort list and title-cases its values.
function labeledModelOptions(values, selected) {
  return values
    .map(
      (v) =>
        `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(
          modelLabel(v)
        )}</option>`
    )
    .join('');
}

// Options for a role dropdown = every configured model ref, keeping the current
// assignment visible even if the model list is empty or the ref is unknown.
function roleModelOptions(selectedRef) {
  const refs = state.models.map((m) => m.ref).sort(byUsableFirst);
  const values = !selectedRef || refs.includes(selectedRef) ? refs.slice() : [selectedRef, ...refs];
  if (!values.length) values.push(selectedRef || 'claude:sonnet');
  return labeledModelOptions(values, selectedRef);
}

// Fill the planner select and the collapsible grid of the remaining roles.
function renderRoles() {
  const planner = el('role-planner');
  if (planner) planner.innerHTML = roleModelOptions(roleRef('planner'));
  const grid = el('rolesGrid');
  if (grid) {
    grid.innerHTML = TEXT_ROLES.filter((r) => r.key !== 'planner')
      .map(
        (r) =>
          `<label for="role-${r.key}">${r.label}</label>
           <select id="role-${r.key}" data-role="${r.key}" style="width:100%;">${roleModelOptions(
             roleRef(r.key)
           )}</select>`
      )
      .join('');
  }
}

// Persist a role→model change to config.json (POST /api/roles). Delegated at the
// document level so both the planner select and the dynamically-built grid selects
// are covered.
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-role]');
  if (!sel) return;
  const role = sel.dataset.role;
  const ref = sel.value;
  const status = el('roleStatus');
  try {
    const data = await api('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, ref }),
    });
    if (data.roles) state.roles = data.roles;
    if (status) {
      status.textContent = `✓ ${role} → ${ref}`;
      status.className = 'sub status-line';
    }
  } catch (err) {
    if (status) {
      status.textContent = `⚠ failed to set ${role}: ${err.message}`;
      status.className = 'sub status-err';
    }
  }
});

// --- API keys --------------------------------------------------------------
// Each provider client with an `apiKeyEnv` (deepseek, openai, …) gets a row:
// its env-var name, which client(s) use it, a set/not-set indicator, and a
// password field. Saving POSTs to /api/keys, which writes .env and applies the
// key to the running server — so it works without a restart. The key value is
// never sent back by the server; we only ever show the set flag + a masked hint.
async function loadKeys() {
  try {
    const data = await api('/api/keys');
    state.keys = Array.isArray(data.keys) ? data.keys : [];
  } catch (e) {
    state.keys = [];
    console.warn('loadKeys:', e.message);
  }
  renderKeys();
}

function renderKeys() {
  const grid = el('keysGrid');
  if (!grid) return;
  if (!state.keys.length) {
    grid.innerHTML =
      '<p class="sub">No API-key providers configured. Add a client with an <code>apiKeyEnv</code> to <code>config.json</code> → "clients" (e.g. deepseek, openai).</p>';
    return;
  }
  grid.innerHTML = state.keys
    .map((k) => {
      const who = (k.clients || []).join(', ');
      const status = k.set
        ? `<span class="status-line">● set${k.hint ? ` (${escapeHtml(k.hint)})` : ''}</span>`
        : '<span class="sub">○ not set</span>';
      const id = `key-${escapeHtml(k.env)}`;
      return `
        <label for="${id}" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
          <span>${escapeHtml(k.env)} <span class="sub">· ${escapeHtml(who)}</span></span>
          ${status}
        </label>
        <div style="display:flex;gap:6px;margin:2px 0 10px;">
          <input type="password" id="${id}" data-key="${escapeHtml(k.env)}" autocomplete="off"
            placeholder="${k.set ? 'enter a new value to replace' : 'paste API key'}"
            style="flex:1;min-width:0;background:var(--panel-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font:inherit;" />
          <button data-save-key="${escapeHtml(k.env)}">Save</button>
        </div>`;
    })
    .join('');
}

async function saveKey(env) {
  const input = el(`key-${env}`);
  if (!input) return;
  const status = el('keyStatus');
  try {
    const data = await api('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env, value: input.value }),
    });
    input.value = '';
    await loadKeys(); // refresh the set/hint indicators
    if (status) {
      status.textContent = data.set ? `✓ saved ${env}` : `✓ cleared ${env}`;
      status.className = 'sub status-line';
    }
  } catch (err) {
    if (status) {
      status.textContent = `⚠ failed to save ${env}: ${err.message}`;
      status.className = 'sub status-err';
    }
  }
}

// Delegated so the dynamically-built rows are covered: click Save, or press
// Enter inside a key field.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-save-key]');
  if (!btn) return;
  e.preventDefault();
  saveKey(btn.dataset.saveKey);
});
document.addEventListener('keydown', (e) => {
  const input = e.target.closest && e.target.closest('input[data-key]');
  if (input && e.key === 'Enter') {
    e.preventDefault();
    saveKey(input.dataset.key);
  }
});

async function loadTasks() {
  try {
    const data = await api('/api/tasks');
    state.tasks = data.tasks || [];
    state.completed = data.completed || [];
    state.aborted = data.aborted || [];
    state.running = data.running || [];
    if (data.maxConcurrency) state.maxConcurrency = data.maxConcurrency;
    if (data.targetDir && !targetDir.value) targetDir.value = data.targetDir;
    renderConcurrency();
    renderTable();
  } catch (e) {
    // Non-fatal on first load (no tasks.json yet).
    console.warn('loadTasks:', e.message);
  }
}

// --- Rendering -------------------------------------------------------------
function optionsHtml(values, selected) {
  return values
    .map(
      (v) =>
        `<option value="${v}"${v === selected ? ' selected' : ''}>${
          v.charAt(0).toUpperCase() + v.slice(1)
        }</option>`
    )
    .join('');
}

// Per-task Worker model dropdown. Options are the worker-eligible "client:model"
// refs from /api/models; the current assignment is always kept selectable even
// if it's a legacy bare name ("sonnet") or the model list hasn't loaded yet.
function modelOptionsHtml(selected) {
  const refs = state.models.filter((m) => m.execCapable).map((m) => m.ref).sort(byUsableFirst);
  const values = !selected || refs.includes(selected) ? refs.slice() : [selected, ...refs];
  if (!values.length) values.push(selected || 'claude:sonnet');
  return labeledModelOptions(values, selected);
}

function renderTable() {
  updateRetryAllBtn();
  if (!state.tasks.length) {
    tableWrap.innerHTML = '<p class="empty">No tasks yet. Generate a plan to get started.</p>';
    return;
  }
  const rows = state.tasks
    .map((t) => {
      // Precedence: done > running > aborted > pending. A currently-running task
      // shows an orange "Running" badge that persists across page refreshes
      // (backed by running.json server-side).
      const done = state.completed.includes(t.id);
      const running = !done && state.running.includes(t.id);
      const aborted = !done && !running && state.aborted.includes(t.id);
      const status = done ? 'done' : running ? 'running' : aborted ? 'aborted' : 'pending';
      const label = done ? 'Done' : running ? 'Running' : aborted ? 'Aborted' : 'Pending';
      // Locked once done or while running; an aborted task stays editable so you
      // can tweak the model/effort and retry it.
      const locked = done || running;
      const statusCell = aborted
        ? `<span class="badge aborted">Aborted</span>
           <button class="tiny retry" data-action="retry">↻ Retry</button>`
        : `<span class="badge ${status}">${label}</span>`;
      const actionCell = running
        ? `<button class="tiny stop" data-action="stop-task">⏹️ Stop</button>`
        : done
        ? ''
        : `<button class="tiny start" data-action="run-task">▶️ Start</button>`;
      return `
        <tr class="${status}" data-id="${t.id}">
          <td>${t.id}</td>
          <td class="desc">${escapeHtml(t.description)}</td>
          <td>
            <select data-field="assigned_model" ${locked ? 'disabled' : ''}>
              ${modelOptionsHtml(t.assigned_model)}
            </select>
          </td>
          <td>
            <select data-field="effort" ${locked ? 'disabled' : ''}>
              ${optionsHtml(EFFORTS, t.effort)}
            </select>
          </td>
          <td>${statusCell}</td>
          <td>${actionCell}</td>
          <td><button class="tiny" data-action="log">📄 Log</button></td>
        </tr>`;
    })
    .join('');

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr><th>ID</th><th>Description</th><th>Model</th><th>Effort</th><th>Status</th><th>Start/Stop</th><th>Log</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// --- Event delegation: persist dropdown changes ----------------------------
tableWrap.addEventListener('change', async (e) => {
  const select = e.target.closest('select');
  if (!select) return;
  const tr = select.closest('tr');
  const id = tr.dataset.id;
  const field = select.dataset.field;
  const value = select.value;

  const task = state.tasks.find((t) => t.id === id);
  if (task) task[field] = value;

  try {
    await api(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    log(`↳ saved ${id}.${field} = ${value}\n`, 'status-line');
  } catch (err) {
    log(`⚠ failed to save ${id}.${field}: ${err.message}\n`, 'status-err');
  }
});

// --- Event delegation: retry an aborted task -------------------------------
tableWrap.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="retry"]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr.dataset.id;
  btn.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    log(`↻ ${id} reset to pending — it will run on the next run.\n`, 'status-line');
    await loadTasks();
  } catch (err) {
    btn.disabled = false;
    log(`⚠ failed to retry ${id}: ${err.message}\n`, 'status-err');
  }
});

// --- Per-task start ----------------------------------------------------
function startTask(id) {
  if (taskStreams[id]) return;

  log(`\n▶️ Starting ${id}…\n`, 'status-line');
  const es = new EventSource(API_BASE + `/api/tasks/${encodeURIComponent(id)}/run`);
  taskStreams[id] = es;
  renderTable();

  const cleanup = () => {
    es.close();
    delete taskStreams[id];
    loadTasks();
  };

  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      log(ev.data + '\n');
      return;
    }
    switch (msg.type) {
      case 'log':
        log(msg.log);
        break;
      case 'status':
      case 'task-start':
      case 'task-complete':
        log('\n' + (msg.message || '') + '\n', 'status-line');
        if (msg.type === 'task-complete') loadTasks();
        break;
      case 'task-aborted':
        log('\n' + (msg.message || 'Task aborted') + '\n', 'status-err');
        loadTasks();
        break;
      case 'error':
        log('\n' + (msg.message || 'Error') + '\n', 'status-err');
        cleanup();
        break;
      case 'done':
        log('\n' + (msg.message || 'Done') + '\n', 'status-line');
        cleanup();
        break;
      default:
        if (msg.log) log(msg.log);
    }
  };

  es.onerror = () => {
    if (taskStreams[id]) {
      log(`\n[${id} stream closed]\n`, 'status-line');
      cleanup();
    }
  };
}

// --- Per-task stop -------------------------------------------------------
async function stopTask(id) {
  log(`\n⏹️ Stopping ${id}…\n`, 'status-line');
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  } catch (err) {
    log(`⚠ failed to stop ${id}: ${err.message}\n`, 'status-err');
  }
  if (taskStreams[id]) {
    taskStreams[id].close();
    delete taskStreams[id];
  }
  await loadTasks();
}

// --- Event delegation: per-task start/stop ---------------------------------
tableWrap.addEventListener('click', (e) => {
  const startBtn = e.target.closest('button[data-action="run-task"]');
  if (startBtn) {
    startTask(startBtn.closest('tr').dataset.id);
    return;
  }
  const stopBtn = e.target.closest('button[data-action="stop-task"]');
  if (stopBtn) {
    stopBtn.disabled = true;
    stopTask(stopBtn.closest('tr').dataset.id);
  }
});

// --- Modal overlay (shared by log + lessons views) -------------------------
function openModal(title, buildBody) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modalOverlay';
  const modal = document.createElement('div');
  modal.className = 'modal';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  const close = document.createElement('button');
  close.className = 'tiny';
  close.textContent = '✕ Close';
  close.addEventListener('click', closeModal);
  head.append(h3, close);
  const body = document.createElement('div');
  buildBody(body);
  modal.append(head, body);
  overlay.appendChild(modal);
  // Click outside the modal closes it.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
}
function closeModal() {
  const existing = el('modalOverlay');
  if (existing) existing.remove();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// --- Planner Chat: a running conversation with the planner model to co-write
// the master prompt. The transcript persists server-side (planner_chat.json), so
// it survives refreshes. "Use last reply as Master Prompt" drops the planner's
// draft into the prompt textarea for Generate Plan. -------------------------
function chatBubble(m) {
  const div = document.createElement('div');
  div.className = `chat-msg ${m.role === 'user' ? 'user' : 'assistant'}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = m.role === 'user' ? 'You' : 'Planner';
  const txt = document.createElement('span');
  txt.textContent = m.content;
  div.append(who, txt);
  return div;
}

async function openPlannerChat() {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modalOverlay';
  const modal = document.createElement('div');
  modal.className = 'modal';

  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = '💬 Planner Chat';
  const headBtns = document.createElement('div');
  headBtns.style.cssText = 'display:flex;gap:8px;';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'tiny';
  clearBtn.textContent = '🗑 Clear';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tiny';
  closeBtn.textContent = '✕ Close';
  closeBtn.addEventListener('click', closeModal);
  headBtns.append(clearBtn, closeBtn);
  head.append(h3, headBtns);

  const msgs = document.createElement('div');
  msgs.className = 'chat-messages';

  const footer = document.createElement('div');
  footer.className = 'chat-footer';
  const input = document.createElement('textarea');
  input.rows = 3;
  input.placeholder = 'Describe what you want to build… (Enter to send, Shift+Enter for a newline)';
  const actions = document.createElement('div');
  actions.className = 'chat-actions';
  const useBtn = document.createElement('button');
  useBtn.textContent = '📥 Use last reply as Master Prompt';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'primary';
  sendBtn.textContent = 'Send ▶';
  actions.append(useBtn, sendBtn);
  footer.append(input, actions);

  modal.append(head, msgs, footer);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);

  let history = [];
  function render() {
    msgs.innerHTML = '';
    if (!history.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent =
        'Tell the planner what you want to build. It will ask questions and draft a master prompt you can use.';
      msgs.appendChild(empty);
    } else {
      history.forEach((m) => msgs.appendChild(chatBubble(m)));
    }
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    history.push({ role: 'user', content: text });
    render();
    const typing = document.createElement('div');
    typing.className = 'chat-msg assistant';
    typing.textContent = '…';
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;
    sendBtn.disabled = true;
    try {
      const data = await api('/api/planner-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      history = data.messages || history;
      if (data.model) h3.textContent = `💬 Planner Chat — ${data.model}`;
      render();
    } catch (e) {
      typing.remove();
      const err = document.createElement('div');
      err.className = 'chat-msg assistant';
      err.style.color = 'var(--danger)';
      err.textContent = `⚠ ${e.message}`;
      msgs.appendChild(err);
      msgs.scrollTop = msgs.scrollHeight;
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  clearBtn.addEventListener('click', async () => {
    try {
      await api('/api/planner-chat', { method: 'DELETE' });
    } catch (e) {
      /* ignore */
    }
    history = [];
    render();
    input.focus();
  });
  useBtn.addEventListener('click', () => {
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) {
      log('No planner reply to use yet.\n', 'status-err');
      return;
    }
    // Prefer a fenced ```markdown block if the planner wrapped the prompt; else
    // take the whole reply.
    const fenced = lastAssistant.content.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/i);
    el('promptText').value = fenced ? fenced[1].trim() : lastAssistant.content.trim();
    closeModal();
    log('↳ master prompt filled from planner chat. Review it, then Generate Plan.\n', 'status-line');
  });

  // Load the existing (durable) transcript.
  try {
    const data = await api('/api/planner-chat');
    history = data.messages || [];
    if (data.model) h3.textContent = `💬 Planner Chat — ${data.model}`;
  } catch (e) {
    console.warn('planner-chat load:', e.message);
  }
  render();
  input.focus();
}

const plannerChatBtn = el('plannerChatBtn');
if (plannerChatBtn) plannerChatBtn.addEventListener('click', openPlannerChat);

// --- View a task's log (Feature 5) -----------------------------------------
tableWrap.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="log"]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  try {
    const data = await api(`/api/logs/${encodeURIComponent(id)}`);
    openModal(`📄 Log — ${id}`, (body) => {
      body.className = 'modal-body';
      body.textContent = data.exists && data.log ? data.log : 'No log available.';
    });
  } catch (err) {
    openModal(`📄 Log — ${id}`, (body) => {
      body.className = 'modal-body';
      body.textContent = `Failed to load log: ${err.message}`;
    });
  }
});

// --- Concurrency (max tasks in flight) --------------------------------------
function renderConcurrency() {
  if (!concurrencyInput) return;
  if (document.activeElement !== concurrencyInput) {
    concurrencyInput.value = state.maxConcurrency;
  }
}

concurrencyInput?.addEventListener('change', async () => {
  const n = Math.max(1, Math.floor(Number(concurrencyInput.value)) || 1);
  // Don't let this change mid-run — it wouldn't take effect until the next run.
  if (eventSource) {
    log('⚠ Stop the current run before changing concurrency.\n', 'status-err');
    renderConcurrency();
    return;
  }
  const prev = state.maxConcurrency;
  state.maxConcurrency = n; // optimistic
  try {
    await api('/api/concurrency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: n }),
    });
    log(`⚡ Concurrency set to ${n}.\n`, 'status-line');
  } catch (err) {
    state.maxConcurrency = prev; // revert on failure
    renderConcurrency();
    log(`⚠ failed to set concurrency: ${err.message}\n`, 'status-err');
  }
});

// --- Retry all aborted -----------------------------------------------------
// Grey the button out when nothing is aborted. Called from renderTable so it
// stays in sync as tasks complete/abort.
function updateRetryAllBtn() {
  if (retryAllBtn) retryAllBtn.disabled = !state.aborted.length;
}

retryAllBtn?.addEventListener('click', async () => {
  retryAllBtn.disabled = true;
  try {
    const data = await api('/api/retry-all', { method: 'POST' });
    log(`↻ Retry all aborted: cleared ${data.count} task(s).\n`, 'status-line');
    await loadTasks(); // refreshes the table (and re-evaluates the disabled state)
  } catch (err) {
    log(`⚠ failed to retry all aborted: ${err.message}\n`, 'status-err');
    updateRetryAllBtn();
  }
});

// --- Split tasks (Feature 1) -----------------------------------------------
splitBtn.addEventListener('click', async () => {
  if (!state.tasks.length) {
    log('No tasks to split. Generate a plan first.\n', 'status-err');
    return;
  }
  splitBtn.disabled = true;
  const original = splitBtn.textContent;
  splitBtn.textContent = '🔬 Splitting…';
  log('\n=== Splitting complex tasks (calling claude)… ===\n', 'status-line');
  try {
    const data = await api('/api/split', { method: 'POST' });
    state.tasks = data.tasks || [];
    await loadTasks();
    log(`✅ Split complete: ${state.tasks.length} task(s) now.\n`, 'status-line');
  } catch (e) {
    log(`❌ Split failed: ${e.message}\n`, 'status-err');
  } finally {
    splitBtn.disabled = false;
    splitBtn.textContent = original;
  }
});

// --- Audit (P5): ask the auditor role to review the completed work ----------
function renderAudit(body, result) {
  body.className = 'modal-body text';
  const v = String(result.verdict || 'unknown').toUpperCase();
  const color = v === 'PASS' ? 'var(--accent-2)' : v === 'FAIL' ? 'var(--danger)' : '#f6c177';
  const issues = (result.issues || [])
    .map(
      (i) => `
      <div class="lesson-item">
        <div class="lh">[${escapeHtml(String(i.severity || '').toUpperCase())}] ${escapeHtml(i.task || 'general')}</div>
        <div>${escapeHtml(i.description || '')}</div>
        ${i.suggested_fix ? `<div class="lk">Fix: ${escapeHtml(i.suggested_fix)}</div>` : ''}
      </div>`
    )
    .join('');
  body.innerHTML =
    `<p style="font-size:15px;margin-top:0;"><strong style="color:${color};">Verdict: ${escapeHtml(v)}</strong></p>` +
    `<p>${escapeHtml(result.summary || '')}</p>` +
    (issues || '<p class="empty">No issues reported.</p>');
}

const auditBtn = el('auditBtn');
if (auditBtn) {
  auditBtn.addEventListener('click', async () => {
    openModal('🔎 Audit', (body) => {
      body.className = 'modal-body text';
      body.innerHTML =
        '<p class="empty">Auditing… asking the auditor model to review the work against the requirements.</p>';
    });
    try {
      const result = await api('/api/audit', { method: 'POST' });
      openModal('🔎 Audit', (body) => renderAudit(body, result));
    } catch (e) {
      openModal('🔎 Audit', (body) => {
        body.className = 'modal-body text';
        body.innerHTML = `<p class="status-err">Audit failed: ${escapeHtml(e.message)}</p>`;
      });
    }
  });
}

// --- Lessons learned (Feature 6, optional UI) ------------------------------
lessonsBtn.addEventListener('click', async () => {
  try {
    const data = await api('/api/memory');
    const lessons = data.memory || [];
    openModal('📚 Lessons Learned', (body) => {
      body.className = 'modal-body text';
      if (!lessons.length) {
        body.innerHTML = '<p class="empty">No lessons yet. They accumulate when a previously-failed task succeeds on retry.</p>';
        return;
      }
      body.innerHTML = lessons
        .slice()
        .reverse()
        .map(
          (l) => `
            <div class="lesson-item">
              <div class="lh">${escapeHtml(l.taskId || '')} — ${escapeHtml(l.lesson || '')}</div>
              <div><span class="lk">Error:</span> ${escapeHtml(l.error_summary || '')}</div>
              <div><span class="lk">Root cause:</span> ${escapeHtml(l.root_cause || '')}</div>
              <div><span class="lk">Fix:</span> ${escapeHtml(l.fix || '')}</div>
            </div>`
        )
        .join('');
    });
  } catch (e) {
    log(`⚠ failed to load lessons: ${e.message}\n`, 'status-err');
  }
});

// --- Context files ---------------------------------------------------------
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1)); // strip data:...;base64,
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function renderContext(files) {
  if (!files.length) {
    contextList.innerHTML = '<li class="empty" style="border:none;background:none;">No context files yet.</li>';
    return;
  }
  contextList.innerHTML = files
    .map(
      (f) => `
        <li data-name="${escapeHtml(f.name)}">
          <span class="ctx-name" title="${escapeHtml(f.name)}">📄 ${escapeHtml(f.name)}</span>
          <span class="ctx-size">${fmtSize(f.size)}</span>
          <button data-action="delete-context">✕</button>
        </li>`
    )
    .join('');
}

async function loadContext() {
  try {
    const data = await api('/api/context');
    renderContext(data.files || []);
  } catch (e) {
    console.warn('loadContext:', e.message);
  }
}

uploadContextBtn.addEventListener('click', async () => {
  const files = Array.from(contextFile.files || []);
  if (!files.length) {
    contextStatus.textContent = 'Choose one or more files first.';
    return;
  }
  uploadContextBtn.disabled = true;
  let ok = 0;
  for (const file of files) {
    contextStatus.textContent = `Uploading ${file.name}…`;
    try {
      const dataBase64 = await fileToBase64(file);
      await api('/api/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, dataBase64 }),
      });
      ok++;
    } catch (e) {
      log(`⚠ upload failed for ${file.name}: ${e.message}\n`, 'status-err');
    }
  }
  contextStatus.textContent = `✅ Uploaded ${ok}/${files.length} file(s).`;
  contextFile.value = '';
  uploadContextBtn.disabled = false;
  loadContext();
});

contextList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="delete-context"]');
  if (!btn) return;
  const name = btn.closest('li').dataset.name;
  try {
    await api(`/api/context/${encodeURIComponent(name)}`, { method: 'DELETE' });
    loadContext();
  } catch (err) {
    contextStatus.textContent = `❌ ${err.message}`;
  }
});

// --- Set target directory --------------------------------------------------
async function saveDir(silent) {
  const dir = targetDir.value.trim();
  if (!dir) {
    if (!silent) dirStatus.textContent = 'Enter a directory path first.';
    return false;
  }
  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDir: dir }),
    });
    dirStatus.textContent = `✅ Building in: ${dir}`;
    dirStatus.classList.remove('status-err');
    return true;
  } catch (e) {
    dirStatus.textContent = `❌ ${e.message}`;
    dirStatus.classList.add('status-err');
    return false;
  }
}
setDirBtn.addEventListener('click', () => saveDir(false));

// --- Generate plan ---------------------------------------------------------
async function readPromptInput() {
  const file = promptFile.files[0];
  if (file) return await file.text();
  return promptText.value.trim();
}

planBtn.addEventListener('click', async () => {
  const prompt = await readPromptInput();
  if (!prompt) {
    planStatus.textContent = 'Provide a MASTER_PROMPT.md file or paste the prompt first.';
    return;
  }
  planBtn.disabled = true;
  planStatus.textContent = '🧠 Planning… (calling claude, this can take a bit)';
  log('=== Generating plan ===\n', 'status-line');
  try {
    const data = await api('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, targetDir: targetDir.value.trim() }),
    });
    state.tasks = data.tasks || [];
    state.completed = data.completed || [];
    renderTable();
    planStatus.textContent = `✅ Plan ready: ${state.tasks.length} task(s).`;
    log(`Plan generated: ${state.tasks.length} task(s).\n`, 'status-line');
  } catch (e) {
    planStatus.textContent = `❌ ${e.message}`;
    log(`Plan failed: ${e.message}\n`, 'status-err');
  } finally {
    planBtn.disabled = false;
  }
});

// --- Run all pending -------------------------------------------------------
function stopRun() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  runBtn.disabled = false;
  runBtn.textContent = '▶️ Run All Pending';
}

runBtn.addEventListener('click', async () => {
  if (eventSource) {
    stopRun();
    return;
  }
  if (!state.tasks.length) {
    log('No tasks to run. Generate a plan first.\n', 'status-err');
    return;
  }
  // Persist the current directory field first so the run uses it (not a stale
  // value saved at plan time). Abort if the directory is invalid.
  if (targetDir.value.trim()) {
    const ok = await saveDir(true);
    if (!ok) {
      log(`\nRun aborted: ${dirStatus.textContent}\n`, 'status-err');
      return;
    }
  }
  runBtn.textContent = '⏹️ Stop';
  log('\n=== Run started ===\n', 'status-line');

  eventSource = new EventSource(API_BASE + '/api/run');

  // Refresh the table periodically so statuses turn green as tasks complete.
  refreshTimer = setInterval(loadTasks, 3000);

  eventSource.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      log(ev.data + '\n');
      return;
    }
    switch (msg.type) {
      case 'log':
        log(msg.log);
        break;
      case 'status':
      case 'task-start':
      case 'task-complete':
        log('\n' + (msg.message || '') + '\n', 'status-line');
        if (msg.type === 'task-complete') loadTasks();
        break;
      case 'task-aborted':
        log('\n' + (msg.message || 'Task aborted') + '\n', 'status-err');
        loadTasks();
        break;
      case 'paused':
        // A provider rate/usage limit. Deliberately NOT the 'error' case: that
        // one calls stopRun(), which would close the stream before the server's
        // closing 'done' explanation arrived.
        log('\n' + (msg.message || 'Paused') + '\n', 'status-err');
        loadTasks();
        break;
      case 'task-skipped':
        // Passed over because an earlier run aborted it. Not an error, but it
        // has to be visible — a silent skip is indistinguishable from "the run
        // did nothing at all".
        log('\n' + (msg.message || 'Task skipped') + '\n', 'status-line');
        break;
      case 'audit':
        log('\n' + (msg.message || 'Audit complete') + '\n', 'status-line');
        (msg.result && msg.result.issues ? msg.result.issues : []).forEach((i) =>
          log(`  • [${String(i.severity || '').toUpperCase()}] ${i.task || 'general'}: ${i.description}\n`)
        );
        break;
      case 'error':
        log('\n' + (msg.message || 'Error') + '\n', 'status-err');
        loadTasks();
        stopRun();
        break;
      case 'done':
        log('\n' + (msg.message || 'Done') + '\n', 'status-line');
        loadTasks();
        stopRun();
        break;
      default:
        if (msg.log) log(msg.log);
    }
  };

  eventSource.onerror = () => {
    // EventSource fires onerror on normal server close too; only report if we
    // still think we're running.
    if (eventSource) {
      log('\n[stream closed]\n', 'status-line');
      loadTasks();
      stopRun();
    }
  };
});

// --- Boot ------------------------------------------------------------------
renderConcurrency(); // show the default immediately; loadTasks() refines it
loadModels().then(loadTasks); // models first so the per-task dropdowns populate
loadKeys(); // API-key panel (independent of models/tasks)
loadContext();
