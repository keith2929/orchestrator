// claude-orchestrator — native Node.js backend (no Express, no deps).
//
// Responsibilities:
//   POST /api/plan       -> save the master prompt, ask `claude` to break it
//                           into a task list, persist tasks.json/completed.json
//   GET  /api/tasks      -> return { tasks, completed }
//   PUT  /api/tasks/:id  -> patch a single task (model / effort / etc.)
//   GET  /api/run        -> Server-Sent Events: run pending tasks in order,
//                           streaming logs live to the browser
//
// State lives in flat JSON files next to this script. No database.

import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env into process.env FIRST — before any module below captures a snapshot
// of the environment (e.g. shared.js CHILD_ENV) or reads a key. env.js loads on
// import; setEnvKey backs the POST /api/keys endpoint.
import { setEnvKey } from './env.js';

// Model-agnostic layer (see MODEL_AGNOSTIC_PLAN.md). Text stages go through
// roles; worker execution is dispatched in execution/ (wired in P3).
import { resolveRole } from './roles.js';
import { listModels } from './clients/index.js';
import { getRolesConfig, getClientsConfig, CONTEXT_DIR, detectRateLimit } from './shared.js';
import { execute } from './execution/index.js';
import { checkClaudeAuth } from './execution/native.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Safety net: a single stray error (e.g. writing an SSE chunk to a browser tab
// that was closed/refreshed mid-run) must NOT take the whole backend down —
// otherwise the UI dies and a page refresh shows a connection error. Log and
// keep serving instead of crashing.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// On Windows the `claude` on PATH is a `.cmd`/`.ps1` shim that Node's
// spawn/execFile can't launch directly, so shell-invoking helpers (e.g.
// gitChangedFiles) pass shell:true there. Model invocation and its allow-listing
// now live in clients/ (claude-cli.js) and execution/.
const IS_WIN = process.platform === 'win32';

const FILES = {
  master: path.join(__dirname, 'MASTER_PROMPT.md'),
  tasks: path.join(__dirname, 'tasks.json'),
  completed: path.join(__dirname, 'completed.json'),
  aborted: path.join(__dirname, 'aborted.json'),
  config: path.join(__dirname, 'config.json'),
  // --- New feature state (all relative to this orchestrator dir) -------------
  running: path.join(__dirname, 'running.json'), // Feature 2: persistent "Running"
  sessionContext: path.join(__dirname, 'session_context.md'), // Feature 4: stitching
  memory: path.join(__dirname, 'memory.json'), // Feature 6: lessons learned
  mode: path.join(__dirname, 'mode.json'), // Run mode: "sequential" | "concurrent"
  plannerChat: path.join(__dirname, 'planner_chat.json'), // Durable "chat with the planner" transcript
};

// Run modes. Sequential (the default) runs tasks strictly in plan order, one at
// a time — the reliable choice, since it never violates a hidden ordering
// dependency the depends_on graph didn't capture. Concurrent keeps the original
// DAG/parallel scheduler.
const RUN_MODES = new Set(['sequential', 'concurrent']);
const DEFAULT_MODE = 'sequential';

// Per-task artefacts. error_logs/{id}.txt drives self-healing retry (Feature 3)
// and lesson capture (Feature 6); logs/{id}.log is the full tee'd run log
// (Feature 5). Created up-front so writes never race a missing directory.
const ERROR_LOGS_DIR = path.join(__dirname, 'error_logs');
const LOGS_DIR = path.join(__dirname, 'logs');
for (const dir of [ERROR_LOGS_DIR, LOGS_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort: creation errors surface later on read/write */
  }
}

// Where the user drops reference/context files (Excel, PDF, CSV, notes, …) that
// the implementing subprocess is told about and can read while working. Kept
// next to this script so it survives across runs and target-dir changes.
// Defined in shared.js because the agent sandbox needs the same path as a
// read-only root — two copies of it would drift and silently re-break reads.
try {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
} catch {
  /* best-effort: creation errors surface later on read/write */
}

// Reference files are dropped in by name; keep the on-disk name to a safe
// basename so an upload can never escape CONTEXT_DIR (no "../", no separators).
function safeContextName(name) {
  const base = path.basename(String(name || '')).trim();
  const cleaned = base.replace(/[^\w.\- ]/g, '_');
  return cleaned || `file-${Date.now()}`;
}

// The reference files currently available, as plain filenames.
function listContextFiles() {
  try {
    return fs
      .readdirSync(CONTEXT_DIR)
      .filter((f) => {
        try {
          return fs.statSync(path.join(CONTEXT_DIR, f)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Small JSON file helpers — always fail soft to sane defaults.
// ---------------------------------------------------------------------------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function getConfig() {
  return readJson(FILES.config, { targetDir: process.cwd() });
}
// Current run mode, defaulting to sequential and tolerating a missing/garbled
// mode.json or an unknown value.
function getMode() {
  const m = readJson(FILES.mode, {});
  return RUN_MODES.has(m && m.mode) ? m.mode : DEFAULT_MODE;
}
function setMode(mode) {
  const safe = RUN_MODES.has(mode) ? mode : DEFAULT_MODE;
  writeJson(FILES.mode, { mode: safe });
  return safe;
}

// One-shot LLM calls used by the planner-adjacent features (split, self-healing
// retry, lesson capture) now go through resolveRole(<role>).complete(prompt),
// which picks the configured provider/model per role. See roles.js. The old
// callClaude() helper (claude-only) was removed in the model-agnostic refactor.

// ---------------------------------------------------------------------------
// Feature 2: persistent "Running" status. running.json holds an array of
// { taskId, startTime } so parallel in-flight tasks all show up, and the badge
// survives a page refresh. Stale entries from a crashed run are cleared when a
// fresh run starts (see handleRun).
// ---------------------------------------------------------------------------
function readRunning() {
  const data = readJson(FILES.running, []);
  if (Array.isArray(data)) return data;
  // Back-compat: tolerate a single { taskId, startTime } object.
  return data && data.taskId ? [data] : [];
}
function addRunning(taskId) {
  const arr = readRunning().filter((r) => r.taskId !== taskId);
  arr.push({ taskId, startTime: Date.now() });
  writeJson(FILES.running, arr);
}
function removeRunning(taskId) {
  const arr = readRunning().filter((r) => r.taskId !== taskId);
  if (arr.length) writeJson(FILES.running, arr);
  else clearRunning();
}
function clearRunning() {
  try {
    fs.unlinkSync(FILES.running);
  } catch {
    /* already gone */
  }
}

// In-memory only (not persisted — a server restart naturally drops any
// in-flight subprocess anyway). Maps a running task's id to the
// AbortController that can stop it; used by POST /api/tasks/:id/stop.
const runningControllers = new Map();

// ---------------------------------------------------------------------------
// Feature 6: failure memory. memory.json is an array of lessons learned from
// tasks that failed and were then fixed. The most recent few are fed back into
// the implementation and splitter prompts as "previous mistakes to avoid".
// ---------------------------------------------------------------------------
function readMemory() {
  const m = readJson(FILES.memory, []);
  return Array.isArray(m) ? m : [];
}
function recentLessons(n = 5) {
  return readMemory().slice(-n);
}
// Prompt fragment listing recent lessons, or [] when there are none.
function lessonsBlock() {
  const lessons = recentLessons(5);
  if (!lessons.length) return [];
  return [
    '',
    'PREVIOUS MISTAKES TO AVOID (lessons from earlier failed tasks):',
    ...lessons.map((l, i) => `  ${i + 1}. ${l.lesson || l.error_summary || '(no detail)'}`),
  ];
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJson(res, status, body) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      // Context uploads arrive base64-encoded in the JSON body, which inflates
      // the payload ~33%; allow up to ~50MB so real Excel/PDF files fit.
      if (raw.length > 50 * 1024 * 1024) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// The menu of models the planner may assign, WITH the facts it needs to choose.
//
// This used to be a bare list of "client:model" strings next to an instruction
// to use "cheaper models for trivial work, stronger models for complex work" —
// with nothing saying which was cheap or strong. A model given no basis to
// choose falls back on name recognition, which is why every task landed on
// Claude regardless of difficulty. So each ref now carries its cost and its
// measured coding tier (from `node rank-coding.mjs`).
//
// Blocked models are excluded outright: assigning one produces a task that
// fails at execution time on a balance error, which is never what the user
// wants from a planning run.
// ---------------------------------------------------------------------------
function workerModelMenu() {
  const usable = listModels().filter((m) => m.execCapable && m.access !== 'blocked');
  const pool = usable.length ? usable : listModels().filter((m) => m.execCapable);
  const refs = pool.map((m) => m.ref);
  const width = Math.max(...refs.map((r) => r.length), 0) + 2;
  const menu = pool
    .map((m) => {
      const facts = [m.cost || 'cost unknown'];
      // An unrated model is described as such rather than silently ranked — the
      // planner should know the difference between "weak" and "never measured".
      facts.push(m.codingTier ? `coding: ${m.codingTier}` : 'coding: unrated');
      // The per-request ceiling, which decides whether a model can hold a big
      // task at all. A worker on a 6k budget cannot read a large spec and keep
      // working, however good its code is — that failure looks like a crash
      // mid-task, so the planner needs to see it before assigning.
      const tok = m.limits?.effectiveRequestTokens;
      if (tok) {
        const approx = m.limits.budgetBasis === 'catalogue' ? ' (upper bound)' : '';
        facts.push(`request budget: ${tok >= 1000 ? Math.round(tok / 1000) + 'k' : tok} tokens${approx}`);
      }
      return `  "${m.ref}"${' '.repeat(Math.max(1, width - m.ref.length))}— ${facts.join(', ')}`;
    })
    .join('\n');
  return { refs, menu, fallback: refs[0] || 'claude:sonnet' };
}

// The shared selection rule, so the plan and split prompts can't drift apart.
//
// Deliberately biased toward the reliable default rather than the cheapest
// adequate one. The earlier "pick the cheapest that can code" rule routed a
// whole run onto free models, and they failed for reasons a coding score cannot
// predict: per-request token ceilings and tokens-per-minute throughput walls,
// which surface as a task dying mid-run rather than as a bad answer. A free
// model is worth it only when the task is genuinely small.
const MODEL_CHOICE_RULES = [
  'Choosing assigned_model — default to a "subscription" model (the Claude CLI).',
  'It has no per-request ceiling and no rate-limit wall, so it is the safe choice',
  'for any task that is long-running, reads large files, or must not fail midway.',
  '',
  'Assign a "free"/"free-tier" model ONLY when the task is clearly SMALL — a',
  'single well-specified deliverable, touching few files, needing no large spec',
  'read into context. When in doubt, it is not small: a task that dies halfway',
  'through costs far more than it saved.',
  '  - Respect "request budget": it is the hard ceiling on ONE request, and the',
  '    running transcript (instructions + every file the worker reads) must fit',
  '    inside it. Under ~16k tokens, only small self-contained tasks are safe;',
  '    a model with no budget listed is either unconstrained (the Claude CLI) or',
  '    simply unmeasured.',
  '  - coding "strong" handles anything; "mid" suits mechanical or well-specified',
  '    work; "light"/"weak" and "unrated" only for trivial, low-risk edits.',
  'assigned_model MUST be exactly one of the quoted "client:model" strings above.',
].join('\n');

// ---------------------------------------------------------------------------
// Route: POST /api/plan
// ---------------------------------------------------------------------------
async function handlePlan(req, res) {
  const body = await readBody(req);
  const prompt = (body.prompt || '').trim();
  const targetDir = (body.targetDir || '').trim() || process.cwd();
  if (!prompt) return sendJson(res, 400, { error: 'Missing "prompt" in request body.' });

  fs.writeFileSync(FILES.master, prompt);
  // Merge targetDir into config — must NOT clobber "clients"/"roles".
  writeJson(FILES.config, { ...readJson(FILES.config, {}), targetDir });

  // Offer the planner the concrete, worker-eligible "client:model" refs it may
  // assign, so it never emits a model that can't actually run a task.
  const { menu, fallback } = workerModelMenu();

  const planningPrompt = [
    'You are a software planning assistant. Read the following MASTER PROMPT and',
    'break it into an ordered list of concrete, independently-executable build tasks.',
    '',
    'Respond with ONE raw JSON array and NOTHING else — no prose, no markdown fences.',
    'Each element MUST have exactly this shape:',
    '{',
    '  "id": "task-1",',
    '  "description": "a single, self-contained instruction",',
    '  "assigned_model": "<one of the models listed below>",',
    '  "effort": "low" | "medium" | "high" | "ultracode",',
    '  "depends_on": ["task-id", ...]',
    '}',
    '',
    'Available models:',
    menu,
    '',
    MODEL_CHOICE_RULES,
    '',
    'Rules: ids are sequential ("task-1", "task-2", ...). Use "depends_on" to encode',
    'ordering. Match "effort" to task complexity (low for trivial work, high/ultracode',
    'for complex work).',
    '',
    '=== MASTER PROMPT ===',
    prompt,
    '=== END MASTER PROMPT ===',
  ].join('\n');

  let stdout;
  try {
    stdout = await resolveRole('planner').complete(planningPrompt, { cwd: targetDir });
  } catch (e) {
    return sendJson(res, 500, {
      error: 'The planner model failed while planning.',
      detail: (e.message || '').toString(),
      hint: 'Check config.json "roles.planner": is its client reachable (claude on PATH, or the provider API key env var set)?',
    });
  }

  // Extract the first JSON array from the output.
  const match = String(stdout).match(/\[[\s\S]*\]/);
  if (!match) {
    return sendJson(res, 502, {
      error: 'Could not find a JSON task array in the model output.',
      raw: String(stdout).slice(0, 4000),
    });
  }
  let tasks;
  try {
    tasks = JSON.parse(match[0]);
  } catch (e) {
    return sendJson(res, 502, {
      error: 'Model returned malformed JSON.',
      detail: e.message,
      raw: match[0].slice(0, 4000),
    });
  }
  // Normalize + guard defaults.
  tasks = (Array.isArray(tasks) ? tasks : []).map((t, i) => ({
    id: t.id || `task-${i + 1}`,
    description: t.description || '(no description)',
    assigned_model: t.assigned_model || fallback,
    effort: t.effort || 'medium',
    depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
  }));
  writeJson(FILES.tasks, tasks);
  writeJson(FILES.completed, []);
  writeJson(FILES.aborted, []);
  sendJson(res, 200, { tasks, completed: [], aborted: [], targetDir });
}

// ---------------------------------------------------------------------------
// Route: POST /api/split  (Feature 1: complexity-aware splitting)
// ---------------------------------------------------------------------------
// Ask the LLM to break oversized/complex tasks into sub-tasks (parentID.a, .b),
// then overwrite tasks.json with the expanded list. Recent failure lessons are
// injected so the splitter avoids re-creating splits that previously blew up.
async function handleSplit(req, res) {
  const tasks = readJson(FILES.tasks, []);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return sendJson(res, 400, { error: 'No tasks to split. Generate a plan first.' });
  }

  const { menu: splitMenu } = workerModelMenu();

  const prompt = [
    "Split any task that would change >150 LOC, touches >3 modules, or has circular dependencies. Name sub-tasks as parentID.a, parentID.b, etc. Each sub-task must have a clear 'green test' criterion and explicit depends_on. Output expanded JSON.",
    '',
    'Leave tasks that do NOT need splitting exactly as they are. Every task in the',
    'output MUST keep this JSON shape (add a "green_test" string on any task you split):',
    '{',
    '  "id": "task-1" | "task-1.a",',
    '  "description": "…",',
    '  "assigned_model": "<one of the models listed below>",',
    '  "effort": "low" | "medium" | "high" | "ultracode",',
    '  "depends_on": ["task-id", ...],',
    '  "green_test": "how to know this sub-task is done (optional)"',
    '}',
    '',
    'Available models:',
    splitMenu,
    '',
    MODEL_CHOICE_RULES,
    '',
    'Respond with ONE raw JSON array and NOTHING else — no prose, no markdown fences.',
    ...lessonsBlock(),
    '',
    '=== CURRENT TASKS (JSON) ===',
    JSON.stringify(tasks, null, 2),
    '=== END TASKS ===',
  ].join('\n');

  let out;
  try {
    out = await resolveRole('splitter').complete(prompt, {
      cwd: getConfig().targetDir || process.cwd(),
    });
  } catch (e) {
    return sendJson(res, 500, {
      error: 'The splitter model failed while splitting.',
      detail: e.message,
    });
  }

  const match = String(out).match(/\[[\s\S]*\]/);
  if (!match) {
    return sendJson(res, 502, {
      error: 'Could not find a JSON task array in the splitter output.',
      raw: String(out).slice(0, 4000),
    });
  }
  let expanded;
  try {
    expanded = JSON.parse(match[0]);
  } catch (e) {
    return sendJson(res, 502, { error: 'Splitter returned malformed JSON.', detail: e.message });
  }

  // Normalize to the canonical task shape. We deliberately DROP any cached
  // `files` annotation so the run-time isolation analysis re-runs over the new
  // (possibly sub-divided) task set instead of using stale file lists.
  expanded = (Array.isArray(expanded) ? expanded : []).map((t, i) => {
    const norm = {
      id: t.id || `task-${i + 1}`,
      description: t.description || '(no description)',
      assigned_model: t.assigned_model || workerModelMenu().fallback,
      effort: t.effort || 'medium',
      depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
    };
    if (t.green_test) norm.green_test = String(t.green_test);
    return norm;
  });

  writeJson(FILES.tasks, expanded);
  sendJson(res, 200, { tasks: expanded });
}

// ---------------------------------------------------------------------------
// Route: POST /api/config  — set the target project directory on its own,
// without having to regenerate the plan. Validates the directory exists so a
// typo'd path fails loudly instead of silently building in the wrong place.
// ---------------------------------------------------------------------------
async function handleSetConfig(req, res) {
  const body = await readBody(req);
  const targetDir = (body.targetDir || '').trim();
  if (!targetDir) return sendJson(res, 400, { error: 'Missing "targetDir".' });
  try {
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return sendJson(res, 400, { error: `Not a directory: ${targetDir}` });
    }
  } catch {
    return sendJson(res, 400, {
      error: `Directory does not exist: ${targetDir}`,
      hint: 'Create the folder first (mkdir), then set it here.',
    });
  }
  // Merge — preserve "clients"/"roles" already in config.json.
  writeJson(FILES.config, { ...readJson(FILES.config, {}), targetDir });
  sendJson(res, 200, { targetDir });
}

// ---------------------------------------------------------------------------
// Route: GET /api/tasks
// ---------------------------------------------------------------------------
function handleGetTasks(res) {
  const tasks = readJson(FILES.tasks, []);
  const completed = readJson(FILES.completed, []);
  const aborted = readJson(FILES.aborted, []);
  // Feature 2: expose the set of currently-running task ids so the table can
  // render a persistent "Running" badge across page refreshes.
  const running = readRunning().map((r) => r.taskId);
  sendJson(res, 200, {
    tasks,
    completed,
    aborted,
    running,
    mode: getMode(),
    targetDir: getConfig().targetDir,
  });
}

// ---------------------------------------------------------------------------
// Route: GET /api/models — the configured client:model refs (+ capabilities)
// for the UI dropdowns, plus the current role→model assignments. `execCapable`
// tells the UI which models may back a Worker (per-task assigned_model).
// ---------------------------------------------------------------------------
function handleGetModels(res) {
  try {
    sendJson(res, 200, { models: listModels(), roles: getRolesConfig() });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/roles — set which client:model backs a planning role.
// Body: { role, ref } where role ∈ TEXT_ROLES and ref is a configured
// "client:model". Persisted to config.json (merged) so resolveRole() picks it up
// on the next stage call and the choice survives a restart. This is what makes a
// non-Claude planner selectable from the UI instead of hand-editing config.json.
// ---------------------------------------------------------------------------
const TEXT_ROLES = new Set(['planner', 'splitter', 'healer', 'lessoner', 'auditor']);
async function handleSetRole(req, res) {
  const body = await readBody(req);
  const role = String(body.role || '').trim();
  const ref = String(body.ref || body.model || '').trim();
  if (!TEXT_ROLES.has(role)) {
    return sendJson(res, 400, {
      error: `Unknown role "${role}". Expected one of: ${[...TEXT_ROLES].join(', ')}.`,
    });
  }
  if (!listModels().some((m) => m.ref === ref)) {
    return sendJson(res, 400, {
      error: `Unknown model "${ref}". Must be a configured client:model id (see /api/models).`,
    });
  }
  const i = ref.indexOf(':');
  const client = ref.slice(0, i);
  const model = ref.slice(i + 1);
  // Merge into config.json without clobbering clients/targetDir or the role's
  // other params (e.g. a per-role temperature).
  const cfg = readJson(FILES.config, {});
  const roles = { ...(cfg.roles || {}) };
  roles[role] = { ...(roles[role] || {}), client, model };
  writeJson(FILES.config, { ...cfg, roles });
  sendJson(res, 200, { role, ref, roles: getRolesConfig() });
}

// ---------------------------------------------------------------------------
// Route: /api/keys — manage provider API keys from the UI instead of exporting
// env vars in the shell before ./run.sh. Keys are stored in a gitignored .env
// (loaded at startup by env.js) and applied to the running process on save, so a
// pasted key works without a restart. The GET never returns a raw key — only a
// boolean + a masked hint — so the value is write-only over the wire. This is a
// localhost dev tool whose API already runs arbitrary commands, so the trust
// boundary is unchanged; we just avoid echoing secrets back.
//   GET             -> { keys: [{ env, clients[], set, hint }] }
//   POST { env, value } -> upsert (empty value clears); { env, set, hint }
// ---------------------------------------------------------------------------

// Mask a secret to a short, non-reversible hint (last 4 chars) for the UI.
function maskKey(v) {
  const s = String(v || '');
  return s.length <= 4 ? '••••' : '••••' + s.slice(-4);
}

// The apiKeyEnv of every configured client, grouped so one row is shown per env
// var even if two clients happen to share it. CLI clients (no apiKeyEnv) are
// skipped — they don't use a key here.
function keyRowsFromConfig() {
  const byEnv = new Map();
  for (const [id, cfg] of Object.entries(getClientsConfig())) {
    const env = cfg && cfg.apiKeyEnv;
    if (!env) continue;
    if (!byEnv.has(env)) byEnv.set(env, []);
    byEnv.get(env).push(id);
  }
  return byEnv;
}

function handleGetKeys(res) {
  try {
    const keys = [...keyRowsFromConfig().entries()].map(([env, clients]) => ({
      env,
      clients,
      set: !!process.env[env],
      hint: process.env[env] ? maskKey(process.env[env]) : '',
    }));
    sendJson(res, 200, { keys });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function handleSetKey(req, res) {
  const body = await readBody(req);
  const env = String(body.env || '').trim();
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  // Only allow env vars an actual configured client references, so the UI can't
  // be used to scribble arbitrary vars into .env.
  if (!keyRowsFromConfig().has(env)) {
    return sendJson(res, 400, {
      error: `Unknown key "${env}". It must be the apiKeyEnv of a configured client (see config.json "clients").`,
    });
  }
  try {
    const set = setEnvKey(env, value); // '' clears the key
    sendJson(res, 200, { env, set, hint: set ? maskKey(process.env[env]) : '' });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Route: /api/planner-chat — a durable, multi-turn conversation with the
// configured planner model, to help the user co-write a MASTER PROMPT. The
// transcript persists in planner_chat.json so the chat "keeps running" across
// refreshes/restarts (matching the tool's flat-file, resumable design).
//   GET    -> { messages, model }
//   POST { message } -> append user turn, get the planner's reply, save, return
//   DELETE -> clear the transcript
// ---------------------------------------------------------------------------
const PLANNER_CHAT_SYSTEM = [
  'You are the planning assistant for an autonomous coding orchestrator.',
  'Through conversation, help the user turn a rough idea into a clear, detailed',
  'MASTER PROMPT that another model will later break into concrete build tasks.',
  'Ask concise clarifying questions when the request is ambiguous (scope, tech',
  'stack, constraints, done-criteria). When the user asks you to write it, output',
  'a complete, well-structured master prompt inside a ```markdown fenced block so',
  'it can be copied verbatim. Keep replies focused and practical.',
].join(' ');

function readPlannerChat() {
  const data = readJson(FILES.plannerChat, []);
  return Array.isArray(data) ? data : [];
}
function plannerRef() {
  const r = getRolesConfig().planner || {};
  return r.client && r.model ? `${r.client}:${r.model}` : '(unset)';
}
function handleGetPlannerChat(res) {
  sendJson(res, 200, { messages: readPlannerChat(), model: plannerRef() });
}
async function handlePostPlannerChat(req, res) {
  const body = await readBody(req);
  const message = String(body.message || '').trim();
  if (!message) return sendJson(res, 400, { error: 'Missing "message".' });

  const messages = readPlannerChat();
  messages.push({ role: 'user', content: message, ts: Date.now() });

  let reply;
  try {
    reply = await resolveRole('planner').chat(
      messages.map((m) => ({ role: m.role, content: m.content })),
      { system: PLANNER_CHAT_SYSTEM }
    );
  } catch (e) {
    // Persist the user turn so it isn't lost, but report the failure.
    writeJson(FILES.plannerChat, messages);
    return sendJson(res, 500, {
      error: 'The planner model failed while chatting.',
      detail: e.message,
      hint: 'Check config.json "roles.planner" — is its client reachable (claude on PATH, or the provider API key env var set)?',
    });
  }

  messages.push({ role: 'assistant', content: String(reply), ts: Date.now() });
  writeJson(FILES.plannerChat, messages);
  sendJson(res, 200, { messages, reply: String(reply), model: plannerRef() });
}
function handleDeletePlannerChat(res) {
  writeJson(FILES.plannerChat, []);
  sendJson(res, 200, { messages: [] });
}

// ---------------------------------------------------------------------------
// Auditor stage (pipeline: Requirements → Planner → Splitter → Workers →
// Auditor). Reviews whether the completed build satisfies the requirements,
// using the auditor role. Inputs: MASTER_PROMPT (requirements), the task plan +
// completion status, the per-task change log (session_context.md), and a bounded
// working-tree diff. Returns a structured verdict. Manual via POST /api/audit;
// auto-runs at end of a sequential run when config.autoAudit is true.
// ---------------------------------------------------------------------------
async function runAudit(cwd) {
  let master = '';
  try {
    master = fs.readFileSync(FILES.master, 'utf8');
  } catch {
    /* no master prompt */
  }
  const tasks = readJson(FILES.tasks, []);
  const completed = new Set(readJson(FILES.completed, []));
  const aborted = new Set(readJson(FILES.aborted, []));
  const taskLines = (Array.isArray(tasks) ? tasks : []).map((t) => {
    const status = completed.has(t.id) ? 'DONE' : aborted.has(t.id) ? 'ABORTED' : 'PENDING';
    return `- [${status}] ${t.id} (${t.assigned_model}): ${t.description}`;
  });
  let sessionCtx = '';
  try {
    sessionCtx = fs.readFileSync(FILES.sessionContext, 'utf8').slice(-8000);
  } catch {
    /* none */
  }
  // git status --porcelain (via gitChangedFiles) — includes UNTRACKED files, so
  // a fresh autonomous build (all-new files) still shows up, unlike `git diff`.
  const changed = await gitChangedFiles(cwd);

  const prompt = [
    'You are a senior code auditor reviewing whether an autonomous build satisfied its requirements.',
    'Review the MASTER PROMPT (requirements), the task plan with completion status, the per-task change',
    'log, and the files changed in the working tree. Judge whether the work is complete and correct, and',
    'flag gaps (unmet requirements, aborted tasks, no file changes where changes were expected).',
    '',
    'Respond with ONE raw JSON object and NOTHING else — no prose, no markdown fences:',
    '{',
    '  "verdict": "pass" | "partial" | "fail",',
    '  "summary": "one short paragraph assessment",',
    '  "issues": [ { "severity": "high"|"medium"|"low", "task": "task-id or general", "description": "...", "suggested_fix": "..." } ]',
    '}',
    '',
    '=== MASTER PROMPT (requirements) ===',
    master || '(none)',
    '=== TASK PLAN & STATUS ===',
    ...(taskLines.length ? taskLines : ['(no tasks)']),
    '=== PER-TASK CHANGE LOG (session_context.md) ===',
    sessionCtx || '(none)',
    '=== FILES CHANGED IN WORKING TREE (git status) ===',
    changed.length ? changed.join('\n') : '(none detected / not a git repo)',
  ].join('\n');

  const out = await resolveRole('auditor').complete(prompt, { cwd });
  const match = String(out).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Auditor did not return JSON. Raw: ' + String(out).slice(0, 500));
  const parsed = JSON.parse(match[0]);
  return {
    verdict: parsed.verdict || 'unknown',
    summary: parsed.summary || '',
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
  };
}

async function handleAudit(res) {
  const cwd = getConfig().targetDir || process.cwd();
  try {
    sendJson(res, 200, await runAudit(cwd));
  } catch (e) {
    sendJson(res, 500, {
      error: 'The auditor model failed.',
      detail: e.message,
      hint: 'Check config.json "roles.auditor" — is its client reachable (claude on PATH, or the provider API key env var set)?',
    });
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/mode  — set the global run mode.
// Body: { mode: "sequential" | "concurrent" }.
// ---------------------------------------------------------------------------
async function handleSetMode(req, res) {
  const body = await readBody(req);
  const requested = (body.mode || '').trim();
  if (!RUN_MODES.has(requested)) {
    return sendJson(res, 400, {
      error: 'Invalid "mode". Expected "sequential" or "concurrent".',
    });
  }
  const mode = setMode(requested);
  sendJson(res, 200, { mode });
}

// ---------------------------------------------------------------------------
// Route: PUT /api/tasks/:id
// ---------------------------------------------------------------------------
async function handlePutTask(req, res, id) {
  const patch = await readBody(req);
  const tasks = readJson(FILES.tasks, []);
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return sendJson(res, 404, { error: `No task with id "${id}".` });

  const allowed = ['description', 'assigned_model', 'effort', 'depends_on'];
  for (const key of allowed) {
    if (key in patch) tasks[idx][key] = patch[key];
  }
  writeJson(FILES.tasks, tasks);
  sendJson(res, 200, { task: tasks[idx] });
}

// ---------------------------------------------------------------------------
// Route: POST /api/tasks/:id/retry
// ---------------------------------------------------------------------------
// Clear a task's "aborted" mark so the next run picks it up again (it becomes
// pending). Handy after fixing whatever made it fail, or after adding context.
//
// Feature 3 (self-healing): if we captured an error log for this task, feed the
// task description + error to the LLM and stash its suggested fix on the task
// (task.suggested_fix in tasks.json) before clearing the aborted flag. The
// stored fix is surfaced to the implementing subprocess on the next run. If
// there's no error log, this degrades to the original behaviour (just un-abort).
async function handleRetryTask(res, id) {
  const tasks = readJson(FILES.tasks, []);
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) {
    return sendJson(res, 404, { error: `No task with id "${id}".` });
  }

  let suggested_fix = null;
  const logPath = path.join(ERROR_LOGS_DIR, `${id}.txt`);
  let errorLog = '';
  try {
    errorLog = fs.readFileSync(logPath, 'utf8');
  } catch {
    /* no error log — fall through to the plain un-abort */
  }

  if (errorLog.trim()) {
    const prompt = [
      'The following task failed. Here is the error log. Fix the errors without',
      'changing the intended behaviour. Output the corrected implementation plan or',
      'code snippets needed. Do not rewrite the entire file unless necessary.',
      '',
      `TASK: ${tasks[idx].description}`,
      '',
      '=== ERROR LOG ===',
      errorLog.slice(0, 12000),
      '=== END ERROR LOG ===',
    ].join('\n');
    try {
      const out = await resolveRole('healer').complete(prompt);
      suggested_fix = String(out).trim();
      tasks[idx].suggested_fix = suggested_fix;
      writeJson(FILES.tasks, tasks);
    } catch (e) {
      // Non-fatal: still un-abort so the user can retry manually. Report the
      // hiccup so it isn't silently swallowed.
      suggested_fix = null;
      tasks[idx].suggested_fix_error = e.message;
      writeJson(FILES.tasks, tasks);
    }
  }

  const aborted = readJson(FILES.aborted, []).filter((x) => x !== id);
  writeJson(FILES.aborted, aborted);
  sendJson(res, 200, { id, aborted, suggested_fix, hadErrorLog: Boolean(errorLog.trim()) });
}

// ---------------------------------------------------------------------------
// Route: GET /api/tasks/:id/run (SSE)
// ---------------------------------------------------------------------------
// Per-task counterpart to handleRun: runs exactly one task instead of the
// whole pending queue. Reuses runTask() as-is, so streaming, logging, the
// error-log capture, and running.json bookkeeping all behave the same as a
// full run — only the surrounding loop is single-task.
async function handleRunOne(res, id) {
  setCors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
  });

  const tasks = readJson(FILES.tasks, []);
  const task = tasks.find((t) => t.id === id);
  if (!task) {
    sse(res, { type: 'error', message: `No task with id "${id}".` });
    sse(res, { type: 'done', message: 'done' });
    return res.end();
  }
  if (runningControllers.has(id)) {
    sse(res, { type: 'error', message: `${id} is already running.` });
    sse(res, { type: 'done', message: 'done' });
    return res.end();
  }

  const cfg = getConfig();
  const cwd = cfg.targetDir || process.cwd();

  sse(res, { type: 'status', message: '🔐 Checking claude CLI login…' });
  const auth = await checkClaudeAuth();
  if (!auth.ok) {
    sse(res, { type: 'error', message: `⛔ ${auth.message}` });
    sse(res, { type: 'done', message: `⛔ Run stopped before starting — ${auth.message}` });
    if (!clientGone) res.end();
    return;
  }

  // Starting a task manually clears any prior aborted mark, same as retry.
  writeJson(FILES.aborted, readJson(FILES.aborted, []).filter((x) => x !== id));

  sse(res, {
    type: 'task-start',
    id: task.id,
    message: `▶️ ${task.id} — ${task.description} [${task.assigned_model}/${task.effort}]`,
  });

  const { ok, rateLimited } = await runTask(task, cwd, res);
  if (clientGone) return;

  // A provider limit isn't this task's fault — leave it PENDING rather than
  // marking it aborted, so it runs normally once the limit resets.
  if (rateLimited) {
    sse(res, {
      type: 'paused',
      message: `⏸️ ${task.id} did not run — ${rateLimited.reason}`,
    });
    sse(res, {
      type: 'done',
      message: '⏸️ Paused — provider limit reached. The task is still pending; try again after it resets.',
    });
    if (!clientGone) res.end();
    return;
  }

  if (!ok) {
    const arr = readJson(FILES.aborted, []);
    if (!arr.includes(id)) {
      arr.push(id);
      writeJson(FILES.aborted, arr);
    }
    sse(res, {
      type: 'task-aborted',
      id: task.id,
      message: `❌ ${task.id} could not be completed — marked aborted.`,
    });
  } else {
    const comp = readJson(FILES.completed, []);
    if (!comp.includes(id)) {
      comp.push(id);
      writeJson(FILES.completed, comp);
    }
    sse(res, { type: 'task-complete', id: task.id, message: `✅ ${task.id} done.` });
    await appendSessionContext(task.id, cwd);
    await recordLesson(task);
  }

  sse(res, { type: 'done', message: ok ? '✅ Task finished.' : '⛔ Task failed.' });
  if (!clientGone) res.end();
}

// ---------------------------------------------------------------------------
// Route: POST /api/tasks/:id/stop
// ---------------------------------------------------------------------------
// Kills the subprocess for a currently-running task via its AbortController
// (registered in runTask). No-op with 404 if the task isn't running.
function handleStopTask(res, id) {
  const controller = runningControllers.get(id);
  if (!controller) {
    // No in-flight subprocess. If running.json still lists the task, the entry
    // is stale — left behind by a backend that was killed mid-run — and the row
    // would otherwise keep showing "Running" with a Stop button that can only
    // 404. Clear it and report success: the caller's intent is already true.
    if (readRunning().some((r) => r.taskId === id)) {
      removeRunning(id);
      return sendJson(res, 200, { id, stopped: true, stale: true });
    }
    return sendJson(res, 404, { error: `Task "${id}" is not currently running.` });
  }
  controller.abort();
  sendJson(res, 200, { id, stopped: true });
}

// ---------------------------------------------------------------------------
// Route: POST /api/retry-all
// ---------------------------------------------------------------------------
// Clear ALL aborted marks in one action so every aborted task becomes pending
// again on the next run. Purely additive: it does not touch the per-task retry
// endpoint, the LLM self-healing path, or completed/tasks state. We reset
// aborted.json to an empty array (the format used everywhere else) rather than
// deleting the file, so the rest of the app keeps reading a valid state file.
function handleRetryAll(res) {
  const count = readJson(FILES.aborted, []).length;
  writeJson(FILES.aborted, []);
  sendJson(res, 200, { success: true, count });
}

// ---------------------------------------------------------------------------
// Route: GET /api/context  — list uploaded reference files (name + size).
// ---------------------------------------------------------------------------
function handleListContext(res) {
  const files = listContextFiles().map((name) => {
    let size = 0;
    try {
      size = fs.statSync(path.join(CONTEXT_DIR, name)).size;
    } catch {
      /* ignore */
    }
    return { name, size };
  });
  sendJson(res, 200, { files, dir: CONTEXT_DIR });
}

// ---------------------------------------------------------------------------
// Route: POST /api/context  — upload one reference file.
// Body: { name, dataBase64 }. We keep it dependency-free by taking the file as
// base64 in a JSON body rather than parsing multipart/form-data by hand.
// ---------------------------------------------------------------------------
async function handleUploadContext(req, res) {
  const body = await readBody(req);
  const name = safeContextName(body.name);
  const b64 = String(body.dataBase64 || '');
  if (!b64) return sendJson(res, 400, { error: 'Missing "dataBase64" in request body.' });
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return sendJson(res, 400, { error: 'dataBase64 is not valid base64.' });
  }
  try {
    fs.writeFileSync(path.join(CONTEXT_DIR, name), buf);
  } catch (e) {
    return sendJson(res, 500, { error: `Could not save file: ${e.message}` });
  }
  sendJson(res, 200, { name, size: buf.length });
}

// ---------------------------------------------------------------------------
// Route: DELETE /api/context/:name  — remove a reference file.
// ---------------------------------------------------------------------------
function handleDeleteContext(res, rawName) {
  const name = safeContextName(rawName);
  const target = path.join(CONTEXT_DIR, name);
  try {
    fs.unlinkSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return sendJson(res, 404, { error: `No such file: ${name}` });
    return sendJson(res, 500, { error: e.message });
  }
  sendJson(res, 200, { name });
}

// ---------------------------------------------------------------------------
// Route: GET /api/logs/:id  (Feature 5: task log view)
// ---------------------------------------------------------------------------
// Return the full tee'd run log for a task, or a friendly note if none exists.
function handleGetLog(res, id) {
  const safeId = path.basename(String(id)); // never escape LOGS_DIR
  const logPath = path.join(LOGS_DIR, `${safeId}.log`);
  let content = '';
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch {
    return sendJson(res, 200, { id, log: '', exists: false });
  }
  sendJson(res, 200, { id, log: content, exists: true });
}

// ---------------------------------------------------------------------------
// Route: GET /api/memory  (Feature 6: lessons learned)
// ---------------------------------------------------------------------------
function handleGetMemory(res) {
  sendJson(res, 200, { memory: readMemory() });
}

// ---------------------------------------------------------------------------
// Feature 4 helper: list the files git sees as changed in the target project.
// `git status --porcelain` captures both modified and newly-created (untracked)
// files, which is what we want since tasks mostly create new files. Fails soft
// to [] when the target isn't a git repo or git is unavailable.
// ---------------------------------------------------------------------------
function gitChangedFiles(cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'status', '--porcelain'],
      { maxBuffer: 4 * 1024 * 1024, shell: IS_WIN },
      (err, stdout) => {
        if (err) return resolve([]);
        const files = String(stdout)
          .split('\n')
          .map((l) => l.slice(3).trim()) // strip the 2-char status + space
          .filter(Boolean);
        resolve(files);
      }
    );
  });
}

// Feature 4: append a completion note (task id + changed files) to
// session_context.md so later tasks are told what earlier ones produced.
async function appendSessionContext(taskId, cwd) {
  const files = await gitChangedFiles(cwd);
  const block =
    `\n---\n` +
    `Task ${taskId} completed. Changed files: ${files.length ? files.join(', ') : '(none detected)'}\n`;
  try {
    fs.appendFileSync(FILES.sessionContext, block);
  } catch {
    /* best-effort */
  }
}

// Feature 6: when a task succeeds AFTER having failed (an error log exists),
// ask the LLM to distill the failure→fix into a lesson and append it to
// memory.json. The error log is then removed so the lesson isn't re-recorded.
async function recordLesson(task) {
  const logPath = path.join(ERROR_LOGS_DIR, `${task.id}.txt`);
  let errorLog = '';
  try {
    errorLog = fs.readFileSync(logPath, 'utf8');
  } catch {
    return; // never failed → nothing to learn
  }
  if (!errorLog.trim()) {
    try {
      fs.unlinkSync(logPath);
    } catch {
      /* ignore */
    }
    return;
  }

  const prompt = [
    'A build task previously FAILED and has now been fixed and completed successfully.',
    'Summarise what went wrong in this failed task and how it was fixed.',
    'Output JSON: { error_summary, root_cause, fix, lesson }',
    'Respond with ONE raw JSON object and NOTHING else — no prose, no markdown fences.',
    '',
    `TASK: ${task.description}`,
    '',
    '=== ERROR LOG ===',
    errorLog.slice(0, 12000),
    '=== END ERROR LOG ===',
  ].join('\n');

  try {
    const out = await resolveRole('lessoner').complete(prompt);
    const match = String(out).match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const mem = readMemory();
      mem.push({
        id: `mem-${Date.now()}`,
        taskId: task.id,
        error_summary: parsed.error_summary || '',
        root_cause: parsed.root_cause || '',
        fix: parsed.fix || '',
        lesson: parsed.lesson || '',
        created_at: new Date().toISOString(),
      });
      writeJson(FILES.memory, mem);
    }
  } catch {
    /* best-effort: a failed lesson write must not disrupt the run */
  }
  // Clear the error log now the failure has been resolved & (maybe) recorded.
  try {
    fs.unlinkSync(logPath);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Route: GET /api/run  (Server-Sent Events)
// ---------------------------------------------------------------------------
// We use spawn (not exec) here on purpose: exec buffers all output until the
// process exits, so it literally cannot "stream" a live console. spawn gives us
// stdout/stderr chunks as they happen, which is the whole point of Panel 3.
function sse(res, payload) {
  // The client may have closed the tab or refreshed mid-run, ending the
  // response. Writing to a finished/destroyed stream throws (EPIPE / "write
  // after end"), which previously crashed the whole backend. Guard it.
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// First pass: file-isolation analysis
// ---------------------------------------------------------------------------
// Ask the analyzer role which files each task will create/modify, so the
// scheduler can run tasks with DISJOINT file sets in parallel and serialize any
// that share a file (e.g. a barrel src/index.ts). Results are cached back into
// tasks.json as task.files, so the pass only runs once. On any failure we leave
// tasks unannotated, which the scheduler treats as "run solo" (i.e. sequential).
// "analyzer" has no dedicated role by default → resolveRole falls back to the
// planner model (this was the cheap `fable` pass before the refactor).
async function analyzeFiles(tasks, cwd) {
  const need = tasks.filter((t) => !Array.isArray(t.files));
  if (need.length === 0) return tasks;

  const prompt = [
    'For each build task below, list the repository-relative file paths it will',
    'CREATE or MODIFY. Be inclusive: include shared/barrel files (e.g. src/index.ts),',
    'config files, and package.json when the task edits them — those are what decide',
    'whether two tasks conflict. Judge from the task text alone; do not read the repo.',
    '',
    'Respond with ONE raw JSON array and NOTHING else — no prose, no fences:',
    '[{ "id": "task-1", "files": ["path/a.ts", "path/b.ts"] }, ...]',
    '',
    '=== TASKS ===',
    ...need.map((t) => `${t.id}: ${t.description}`),
    '=== END TASKS ===',
  ].join('\n');

  let stdout;
  try {
    stdout = await resolveRole('analyzer').complete(prompt, { cwd });
  } catch {
    return tasks; // best-effort: leave unannotated → scheduler runs tasks solo
  }
  const match = String(stdout).match(/\[[\s\S]*\]/);
  if (!match) return tasks;
  let ann;
  try {
    ann = JSON.parse(match[0]);
  } catch {
    return tasks;
  }
  const byId = new Map((Array.isArray(ann) ? ann : []).map((a) => [a.id, a.files]));
  for (const t of tasks) {
    if (!Array.isArray(t.files)) {
      const f = byId.get(t.id);
      t.files = Array.isArray(f) ? f.map(String) : [];
    }
  }
  writeJson(FILES.tasks, tasks);
  return tasks;
}

function runTask(task, cwd, res) {
  return new Promise((resolve) => {
    const contextFiles = listContextFiles();
    const contextBlock = contextFiles.length
      ? [
          '',
          `REFERENCE / CONTEXT FILES: the user has provided the following files in`,
          `${CONTEXT_DIR}`,
          ...contextFiles.map((f) => `  - ${path.join(CONTEXT_DIR, f)}`),
          `Read any that are relevant to this task (they may contain requirements,`,
          `data, specs, or examples) before implementing.`,
        ]
      : [];

    // Feature 4: point each task at session_context.md (once it exists) so it
    // knows what previous tasks changed/exported.
    const sessionBlock = fs.existsSync(FILES.sessionContext)
      ? [
          '',
          `PRIOR-TASK CONTEXT: earlier tasks in this run recorded what they changed in`,
          `${FILES.sessionContext}`,
          `Read it to understand existing exports/contracts before implementing.`,
        ]
      : [];

    // Feature 6: recent lessons learned from previously-failed tasks.
    const lessons = lessonsBlock();

    // Feature 3: if a self-healing retry produced a suggested fix, hand it to
    // the subprocess as a starting point.
    const fixBlock = task.suggested_fix
      ? [
          '',
          `SUGGESTED FIX (from a prior failed attempt at this task — apply if sound):`,
          task.suggested_fix,
        ]
      : [];

    const implementPrompt = [
      `Effort level: ${task.effort}.`,
      `You are working inside the project directory: ${cwd}`,
      '',
      `Implement the following task completely. Create or edit whatever files are`,
      `needed. Do not ask questions — just do the work.`,
      '',
      `You are AUTHORIZED to run non-interactive install and build commands`,
      `(e.g. \`pnpm install\`, \`npm install\`, \`tsc\`, \`vite build\`) to complete and`,
      `verify the task. The environment is non-interactive (CI=true) — prefer flags`,
      `that avoid prompts, and do NOT skip a required step out of caution; carry it`,
      `out. Do not delete or wipe existing node_modules or unrelated files.`,
      ...contextBlock,
      ...sessionBlock,
      ...lessons,
      ...fixBlock,
      '',
      `TASK: ${task.description}`,
    ].join('\n');

    // Feature 2: mark this task running (persisted, survives page refresh).
    addRunning(task.id);

    // Per-task stop: an AbortController that POST /api/tasks/:id/stop can
    // trigger to kill this task's subprocess mid-run.
    const controller = new AbortController();
    runningControllers.set(task.id, controller);

    // Feature 5: tee everything to logs/{id}.log. Truncated each run so the log
    // reflects the latest attempt rather than accumulating across retries.
    const logPath = path.join(LOGS_DIR, `${task.id}.log`);
    let logStream = null;
    try {
      logStream = fs.createWriteStream(logPath, { flags: 'w' });
    } catch {
      /* best-effort: streaming still works without the on-disk log */
    }
    const tee = (text) => {
      if (logStream) {
        try {
          logStream.write(text);
        } catch {
          /* ignore log write errors */
        }
      }
    };

    // Feature 3: accumulate output so we can persist it on failure. stderr is
    // the primary signal, but some failures — notably provider rate/usage
    // limits — are printed to STDOUT and exit non-zero, which used to leave
    // error_logs/{id}.txt holding nothing but "Process exited with code 1".
    // Both are capped so a chatty task can't sit on megabytes of memory.
    const OUT_CAP = 16000;
    const capTail = (s) => (s.length > OUT_CAP ? s.slice(-OUT_CAP) : s);
    let stderrAll = '';
    let stdoutAll = '';

    // Line-buffer output and prefix each line with the task id, so several
    // parallel tasks' logs stay readable when interleaved in the console.
    let outBuf = '';
    let errBuf = '';
    const emitLines = (chunk, isErr) => {
      const raw = typeof chunk === 'string' ? chunk : chunk.toString();
      tee(raw); // Feature 5: full, un-prefixed output to the per-task log file
      let buf = (isErr ? errBuf : outBuf) + raw;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        sse(res, { type: 'log', log: `[${task.id}] ${buf.slice(0, nl)}\n` });
        buf = buf.slice(nl + 1);
      }
      if (isErr) errBuf = buf;
      else outBuf = buf;
    };
    const flush = () => {
      if (outBuf) sse(res, { type: 'log', log: `[${task.id}] ${outBuf}\n` });
      if (errBuf) sse(res, { type: 'log', log: `[${task.id}] ${errBuf}\n` });
      outBuf = errBuf = '';
    };

    // Single exit path: clear running state, close the log, and (on failure)
    // persist the error log for self-healing retry / lesson capture.
    let settled = false;
    const finish = (ok, failDetail) => {
      if (settled) return;
      settled = true;
      removeRunning(task.id); // Feature 2
      runningControllers.delete(task.id);
      if (logStream) {
        try {
          logStream.end();
        } catch {
          /* ignore */
        }
      }
      // Only inspect output on FAILURE — a task that succeeds while legitimately
      // printing "rate limit" (e.g. one implementing rate limiting) must never
      // pause the queue. See detectRateLimit in shared.js.
      const rateLimited = ok
        ? null
        : detectRateLimit(`${stderrAll}\n${stdoutAll}\n${failDetail || ''}`);

      // A rate limit means the task never really ran, so there is no failure to
      // learn from: skip the error log entirely rather than feeding "you've hit
      // your session limit" to the self-healing retry and lesson capture.
      if (!ok && !rateLimited) {
        // Feature 3: prefer captured stderr, then stdout, then whatever detail
        // we have, so the retry has *something* real to work from.
        const errText = stderrAll.trim() || stdoutAll.trim() || (failDetail || '').trim();
        try {
          fs.writeFileSync(path.join(ERROR_LOGS_DIR, `${task.id}.txt`), errText || '(no output captured)');
        } catch {
          /* best-effort */
        }
      }
      resolve({ ok, rateLimited });
    };

    // Dispatch to the execution backend for this task's model ref: the claude
    // CLI (kind:"cli", unchanged) or the agent framework for a chat model
    // (kind:"chat"). Output streams through the same emitLines/tee, and the
    // resolved ok/detail drives the single finish() exit path (which persists
    // the error log for self-healing retry / lesson capture on failure).
    execute(task.assigned_model, {
      prompt: implementPrompt,
      cwd,
      signal: controller.signal,
      onOut: (text) => {
        stdoutAll = capTail(stdoutAll + text);
        emitLines(text, false);
      },
      onErr: (text) => {
        stderrAll = capTail(stderrAll + text);
        emitLines(text, true);
      },
    })
      .then((r) => {
        flush();
        finish(!!(r && r.ok), (r && r.detail) || '');
      })
      .catch((e) => {
        flush();
        finish(false, e.message);
      });
  });
}

async function handleRun(res) {
  setCors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const cfg = getConfig();
  const cwd = cfg.targetDir || process.cwd();
  // Max tasks in flight at once. Tasks only actually run in parallel when their
  // file sets are disjoint (see below); this is just the ceiling.
  const maxConc = Math.max(1, Number(process.env.CONCURRENCY) || Number(cfg.maxConcurrency) || 3);

  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
  });

  // Feature 2: clear any stale "running" entries left by a previously crashed or
  // force-closed run before we start fresh.
  clearRunning();

  // Preflight: catch "claude CLI not logged in / not installed" ONCE, up front,
  // instead of aborting every queued task with the same stderr one by one.
  sse(res, { type: 'status', message: '🔐 Checking claude CLI login…' });
  const auth = await checkClaudeAuth();
  if (!auth.ok) {
    sse(res, { type: 'error', message: `⛔ ${auth.message}` });
    sse(res, { type: 'done', message: `⛔ Run stopped before starting — ${auth.message}` });
    clearRunning();
    if (!clientGone) res.end();
    return;
  }

  const mode = getMode();

  // -------------------------------------------------------------------------
  // SEQUENTIAL MODE (default): run tasks strictly in plan.json order, one at a
  // time. We deliberately IGNORE the depends_on graph for scheduling — insertion
  // order is the intended ordering — so a late "repo hygiene / build" task can
  // never fire before the earlier tasks that actually make the build pass.
  // -------------------------------------------------------------------------
  if (mode === 'sequential') {
    sse(res, {
      type: 'status',
      message: `Starting run in ${cwd} — 🧭 Sequential mode (one task at a time, in plan order)`,
    });

    const abortedSet = new Set(readJson(FILES.aborted, []));
    const markAborted = (id) => {
      abortedSet.add(id);
      const arr = readJson(FILES.aborted, []);
      if (!arr.includes(id)) {
        arr.push(id);
        writeJson(FILES.aborted, arr);
      }
    };

    // Tasks passed over because a previous run marked them aborted, and the
    // provider limit (if any) that cut this run short.
    const skipped = [];
    let haltedBy = null;

    // Snapshot the task order once; iterate in array order.
    const orderedTasks = readJson(FILES.tasks, []);
    for (let i = 0; i < orderedTasks.length; i++) {
      if (clientGone) break;
      const task = orderedTasks[i];

      // Re-read completion each iteration so a task completed in a previous run
      // (or manually) is skipped rather than re-run.
      const completed = new Set(readJson(FILES.completed, []));
      if (completed.has(task.id)) continue;

      // aborted.json persists across runs and a new run does NOT clear it, so an
      // aborted task stays skipped until it is explicitly retried. Say that out
      // loud: skipping in silence is why "Run All Pending" could look like it
      // did nothing at all.
      if (abortedSet.has(task.id)) {
        skipped.push(task.id);
        sse(res, {
          type: 'task-skipped',
          id: task.id,
          message: `⏭️ ${task.id} skipped — aborted by an earlier run. Use ↻ on the task (or Retry All) to make it pending again.`,
        });
        continue;
      }

      sse(res, {
        type: 'task-start',
        id: task.id,
        message: `▶️ [${i + 1}/${orderedTasks.length}] ${task.id} — ${task.description} [${task.assigned_model}/${task.effort}]`,
      });

      // Wait for this task to fully finish (Done or Aborted) before the next.
      const { ok, rateLimited } = await runTask(task, cwd, res);
      if (clientGone) break;

      // A provider limit makes every subsequent task fail instantly for the same
      // reason. Stop the run and leave this task and the rest PENDING — marking
      // them aborted would burn the whole queue in seconds and then have later
      // runs skip them all.
      if (rateLimited) {
        haltedBy = rateLimited;
        sse(res, {
          type: 'paused',
          message: `⏸️ ${task.id} did not run — ${rateLimited.reason}`,
        });
        break;
      }

      if (!ok) {
        markAborted(task.id);
        sse(res, {
          type: 'task-aborted',
          id: task.id,
          message: `❌ ${task.id} could not be completed — marked aborted. Continuing with the next task.`,
        });
        continue;
      }

      const comp = readJson(FILES.completed, []);
      if (!comp.includes(task.id)) {
        comp.push(task.id);
        writeJson(FILES.completed, comp);
      }
      sse(res, { type: 'task-complete', id: task.id, message: `✅ ${task.id} done.` });

      // Feature 4 + 6: same post-completion bookkeeping as concurrent mode.
      await appendSessionContext(task.id, cwd);
      await recordLesson(task);
    }

    // P5: optional Auditor pass at the end of the pipeline (opt-in via
    // config.autoAudit). Streamed before "done" so the client is still listening.
    // Skipped when a provider limit cut the run short — the work is incomplete
    // by definition, and the audit would only burn more of the exhausted quota.
    if (!clientGone && !haltedBy && getConfig().autoAudit) {
      sse(res, { type: 'status', message: '🔎 Auditor: reviewing the completed work…' });
      try {
        const audit = await runAudit(cwd);
        sse(res, {
          type: 'audit',
          result: audit,
          message: `🔎 Audit verdict: ${String(audit.verdict).toUpperCase()} — ${audit.summary}`,
        });
      } catch (e) {
        sse(res, { type: 'log', log: `[audit] failed: ${e.message}\n` });
      }
    }

    if (haltedBy) {
      sse(res, {
        type: 'done',
        message:
          `⏸️ Run paused — ${haltedBy.reason}. The remaining tasks are still PENDING ` +
          `(not aborted); press Run again once the limit resets.`,
      });
    } else {
      const nAborted = orderedTasks.filter((t) => abortedSet.has(t.id)).length;
      const skipNote = skipped.length
        ? ` ${skipped.length} previously-aborted task(s) were skipped: ${skipped.join(', ')}.`
        : '';
      sse(res, {
        type: 'done',
        message:
          (nAborted ? `⚠️ Run finished — ${nAborted} task(s) aborted.` : '✅ All tasks complete.') +
          skipNote,
      });
    }
    clearRunning();
    if (!clientGone) res.end();
    return;
  }

  // -------------------------------------------------------------------------
  // CONCURRENT MODE (advanced/legacy): the original DAG scheduler below.
  // -------------------------------------------------------------------------
  sse(res, {
    type: 'status',
    message: `Starting run in ${cwd} — ⚡ Concurrent mode (up to ${maxConc} in parallel)`,
  });

  // First pass: figure out which files each task touches so we can parallelize
  // only the ones that don't collide.
  sse(res, { type: 'status', message: '🔎 First pass: analyzing task file isolation (fable)…' });
  await analyzeFiles(readJson(FILES.tasks, []), cwd);
  if (clientGone) return;

  const filesInUse = new Set(); // files being edited by currently in-flight tasks
  const inFlight = new Map(); // id -> Promise<{ id, task, ok, rateLimited }>
  const overlaps = (t) => (t.files || []).some((f) => filesInUse.has(f));
  const claim = (t) => (t.files || []).forEach((f) => filesInUse.add(f));
  const release = (t) => (t.files || []).forEach((f) => filesInUse.delete(f));

  // Tasks that couldn't be completed. A failed task is marked "aborted" and the
  // run keeps going with everything that doesn't depend on it — rather than
  // halting the whole plan. Persisted to aborted.json so the UI can show it.
  const abortedSet = new Set(readJson(FILES.aborted, []));
  const markAborted = (id) => {
    abortedSet.add(id);
    const arr = readJson(FILES.aborted, []);
    if (!arr.includes(id)) {
      arr.push(id);
      writeJson(FILES.aborted, arr);
    }
  };

  // Set when a provider rate/usage limit is hit. Stops NEW launches; tasks
  // already in flight are drained first, then the run ends with everything
  // untouched still pending (see the sequential-mode note above).
  let haltedBy = null;

  while (!clientGone) {
    const allTasks = readJson(FILES.tasks, []);
    const completed = new Set(readJson(FILES.completed, []));
    const isDone = (id) => completed.has(id);
    const isAborted = (id) => abortedSet.has(id);

    // Cascade: a not-yet-run task whose dependency was aborted can never satisfy
    // its deps, so abort it too instead of leaving it to jam the scheduler.
    for (const t of allTasks) {
      if (isDone(t.id) || isAborted(t.id) || inFlight.has(t.id)) continue;
      if ((t.depends_on || []).some((d) => isAborted(d))) {
        markAborted(t.id);
        sse(res, {
          type: 'task-aborted',
          id: t.id,
          message: `⛔ ${t.id} aborted — a dependency could not be completed.`,
        });
      }
    }

    const pending = allTasks.filter(
      (t) => !isDone(t.id) && !isAborted(t.id) && !inFlight.has(t.id)
    );
    if (pending.length === 0 && inFlight.size === 0) {
      const nAborted = allTasks.filter((t) => isAborted(t.id)).length;
      sse(res, {
        type: 'done',
        message: nAborted
          ? `⚠️ Run finished — ${nAborted} task(s) aborted.`
          : '✅ All tasks complete.',
      });
      break;
    }

    // Halted by a provider limit and everything in flight has drained.
    if (haltedBy && inFlight.size === 0) {
      sse(res, {
        type: 'done',
        message:
          `⏸️ Run paused — ${haltedBy.reason}. The remaining tasks are still PENDING ` +
          `(not aborted); press Run again once the limit resets.`,
      });
      break;
    }

    // A task can start when its deps are done AND it doesn't clash on files.
    // A task with unknown/empty file info (analysis failed) is treated as
    // conflicting-with-everything: it runs solo, preserving the old safe order.
    const depsMet = (t) => (t.depends_on || []).every((d) => isDone(d));
    const startable = pending.filter(depsMet);

    let launched = false;
    for (const t of haltedBy ? [] : startable) {
      if (inFlight.size >= maxConc) break;
      const unknownFiles = !Array.isArray(t.files) || t.files.length === 0;
      if (unknownFiles) {
        if (inFlight.size > 0) continue; // must run alone
      } else if (overlaps(t)) {
        continue; // shares a file with something in flight
      }

      claim(t);
      sse(res, {
        type: 'task-start',
        id: t.id,
        message: `▶️ ${t.id} — ${t.description} [${t.assigned_model}/${t.effort}]`,
      });
      inFlight.set(
        t.id,
        runTask(t, cwd, res).then((r) => ({ id: t.id, task: t, ...r }))
      );
      launched = true;

      if (unknownFiles) break; // solo task: don't start anything alongside it
      await delay(1500); // gentle stagger between parallel launches
      if (clientGone) break;
    }

    if (inFlight.size === 0) {
      // Nothing running and nothing could be launched => genuinely stuck.
      if (!launched) {
        sse(res, {
          type: 'error',
          message:
            '⛔ Stuck: pending tasks remain but their dependencies are unmet or circular. ' +
            `Blocked: ${pending.map((t) => t.id).join(', ')}`,
        });
        break;
      }
      continue; // launched solo task; loop to wait on it
    }

    // Wait for the next in-flight task to finish, then free its files.
    const done = await Promise.race(inFlight.values());
    inFlight.delete(done.id);
    release(done.task);
    if (clientGone) break;

    // A provider limit is not this task's fault and will hit every other task
    // identically, so leave it PENDING and stop launching new work.
    if (done.rateLimited) {
      haltedBy = done.rateLimited;
      sse(res, {
        type: 'paused',
        message: `⏸️ ${done.id} did not run — ${done.rateLimited.reason}`,
      });
      continue;
    }

    if (!done.ok) {
      // Don't halt the whole plan: mark this one aborted and let the scheduler
      // carry on with tasks that don't depend on it (dependents cascade to
      // aborted at the top of the next loop).
      markAborted(done.id);
      sse(res, {
        type: 'task-aborted',
        id: done.id,
        message: `❌ ${done.id} could not be completed — marked aborted. Continuing with remaining tasks.`,
      });
      continue;
    }

    const comp = readJson(FILES.completed, []);
    if (!comp.includes(done.id)) {
      comp.push(done.id);
      writeJson(FILES.completed, comp);
    }
    sse(res, { type: 'task-complete', id: done.id, message: `✅ ${done.id} done.` });

    // Feature 4: record what this task changed for downstream tasks to read.
    await appendSessionContext(done.id, cwd);
    // Feature 6: if this task had failed before (error log present), distill and
    // store the lesson learned, then clear the error log.
    await recordLesson(done.task);
  }

  // Feature 2: run over — nothing should still show as running.
  clearRunning();
  if (!clientGone) res.end();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === 'POST' && pathname === '/api/plan') return await handlePlan(req, res);
    if (req.method === 'POST' && pathname === '/api/split') return await handleSplit(req, res);
    if (req.method === 'POST' && pathname === '/api/mode') return await handleSetMode(req, res);
    if (req.method === 'POST' && pathname === '/api/config') return await handleSetConfig(req, res);
    if (req.method === 'GET' && pathname === '/api/tasks') return handleGetTasks(res);
    if (req.method === 'GET' && pathname === '/api/models') return handleGetModels(res);
    if (req.method === 'POST' && pathname === '/api/roles') return await handleSetRole(req, res);
    if (req.method === 'GET' && pathname === '/api/keys') return handleGetKeys(res);
    if (req.method === 'POST' && pathname === '/api/keys') return await handleSetKey(req, res);
    if (req.method === 'GET' && pathname === '/api/planner-chat') return handleGetPlannerChat(res);
    if (req.method === 'POST' && pathname === '/api/planner-chat') return await handlePostPlannerChat(req, res);
    if (req.method === 'DELETE' && pathname === '/api/planner-chat') return handleDeletePlannerChat(res);
    if (req.method === 'POST' && pathname === '/api/audit') return await handleAudit(res);
    if (req.method === 'GET' && pathname === '/api/memory') return handleGetMemory(res);
    if (req.method === 'GET' && pathname.startsWith('/api/logs/')) {
      const id = decodeURIComponent(pathname.slice('/api/logs/'.length));
      return handleGetLog(res, id);
    }
    if (req.method === 'POST' && pathname === '/api/retry-all') return handleRetryAll(res);
    if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/retry$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice('/api/tasks/'.length, -'/retry'.length));
      return await handleRetryTask(res, id);
    }
    if (req.method === 'GET' && /^\/api\/tasks\/[^/]+\/run$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice('/api/tasks/'.length, -'/run'.length));
      return await handleRunOne(res, id);
    }
    if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/stop$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice('/api/tasks/'.length, -'/stop'.length));
      return handleStopTask(res, id);
    }
    if (req.method === 'PUT' && pathname.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(pathname.slice('/api/tasks/'.length));
      return await handlePutTask(req, res, id);
    }
    if (req.method === 'GET' && pathname === '/api/context') return handleListContext(res);
    if (req.method === 'POST' && pathname === '/api/context') return await handleUploadContext(req, res);
    if (req.method === 'DELETE' && pathname.startsWith('/api/context/')) {
      const name = decodeURIComponent(pathname.slice('/api/context/'.length));
      return handleDeleteContext(res, name);
    }
    if (req.method === 'GET' && pathname === '/api/run') return await handleRun(res);
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  // runningControllers is in-memory, so by definition nothing is in flight on a
  // fresh boot. Anything left in running.json is stale from a backend that was
  // killed or crashed mid-run; keeping it would show phantom "Running" rows
  // that survive restarts until the next full run happens to clear them.
  const stale = readRunning().map((r) => r.taskId);
  if (stale.length) {
    clearRunning();
    console.log(`Cleared ${stale.length} stale running entr(ies): ${stale.join(', ')}`);
  }
  console.log(`claude-orchestrator backend listening on http://localhost:${PORT}`);
  console.log(`Using claude binary: ${CLAUDE_BIN}`);
});
