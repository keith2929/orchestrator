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
import { runRole } from './roles/index.js';
import { listModels } from './clients/index.js';
import { getRolesConfig, getClientsConfig, CONTEXT_DIR, detectRateLimit, parseRetryAfterMs } from './shared.js';
import { execute } from './execution/index.js';
import { checkClaudeAuth } from './execution/native.js';
import { createToolRunner } from './agent/toolRunner.js';
import { toolList } from './agent/tools/index.js';
import { getRecipe } from './graph/recipes/index.js';
import { detectProjectProfile } from './graph/projectProfile.js';

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

// config.json is the one file that MUST live next to this script, not under a
// target dir — it's what tells us the target dir in the first place. Every
// other file is project state and lives in <targetDir>/.orchestrator/, so that
// switching projects never bleeds state between them (see REDESIGN_PLAN.md
// Phase 1). FILES is a Proxy so existing call sites (`FILES.tasks`, …) keep
// working unchanged while resolving lazily against the *current* targetDir.
const CONFIG_FILE = path.join(__dirname, 'config.json');

const STATE_FILENAMES = {
  master: 'MASTER_PROMPT.md',
  tasks: 'tasks.json',
  completed: 'completed.json',
  aborted: 'aborted.json',
  running: 'running.json', // Feature 2: persistent "Running"
  sessionContext: 'session_context.md', // Feature 4: stitching
  memory: 'memory.json', // Feature 6: lessons learned
  plannerChat: 'planner_chat.json', // Durable "chat with the planner" transcript
  pause: 'pause.json', // Phase 4: { reason, resumeAt } while auto-paused on a provider limit
};

// <targetDir>/.orchestrator/ — created on first access. Reads config.json
// directly (not via getConfig(), which is defined below and would recurse
// back through FILES.config) to avoid a definition-order cycle.
function getStateDir() {
  const cfg = readJsonFile(CONFIG_FILE, {});
  const targetDir = cfg.targetDir || process.cwd();
  const dir = path.join(targetDir, '.orchestrator');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort: creation errors surface later on read/write */
  }
  return dir;
}
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const FILES = new Proxy(
  { config: CONFIG_FILE },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in STATE_FILENAMES) return path.join(getStateDir(), STATE_FILENAMES[prop]);
      return undefined;
    },
  }
);

// Default ceiling on tasks in flight at once. config.json "maxConcurrency" (or
// $CONCURRENCY) overrides it; 1 reproduces the old "sequential" behaviour
// exactly, since the unified scheduler's depsMet check is what used to be
// concurrent-mode-only logic (see REDESIGN_PLAN.md Phase 2).
const DEFAULT_MAX_CONCURRENCY = 3;

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

// ---------------------------------------------------------------------------
// Topological order enforcement (Phase 2). The old "sequential" scheduler ran
// tasks.json in pure array order and ignored depends_on; the unified scheduler
// always follows depends_on, so the array itself must never disagree with the
// graph it stores — this is what makes the visible task list order match
// execution order. Every write path that can add tasks or change depends_on
// goes through writeTasks(), which re-derives array order from the graph and
// rejects a dangling reference or a cycle rather than persisting a plan the
// scheduler could get stuck on.
// ---------------------------------------------------------------------------
function topoSortTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.depends_on || []) {
      if (!byId.has(dep)) {
        throw new Error(`Task "${t.id}" depends_on unknown task "${dep}".`);
      }
    }
  }
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(t) {
    if (visited.has(t.id)) return;
    if (visiting.has(t.id)) {
      throw new Error(`Circular dependency involving "${t.id}".`);
    }
    visiting.add(t.id);
    for (const dep of t.depends_on || []) visit(byId.get(dep));
    visiting.delete(t.id);
    visited.add(t.id);
    ordered.push(t);
  }
  // Preserve original relative order among tasks with no ordering constraint
  // between them — only reorder when depends_on actually forces it.
  for (const t of tasks) visit(t);
  return ordered;
}
// ---------------------------------------------------------------------------
// Phase 7: recipe expansion. A type:"recipe" node ({ id, type, depends_on,
// recipe, params }) is a REFERENCE, never executed directly — it is replaced
// here by the concrete type:"tool" node chain its expand(params, profile)
// produces, wired depends_on -> depends_on -> ... so the recipe's internal
// order is preserved and the first step inherits the recipe node's own
// dependencies. Runs on every writeTasks() call, so it doesn't matter
// whether a recipe node arrived via the API or a hand-edited tasks.json.
// ---------------------------------------------------------------------------
function expandRecipeNodes(tasks, cwd) {
  if (!tasks.some((t) => t.type === 'recipe')) return tasks;
  const profile = detectProjectProfile(cwd);
  const out = [];
  for (const t of tasks) {
    if (t.type !== 'recipe') {
      out.push(t);
      continue;
    }
    const recipe = getRecipe(t.recipe);
    if (!recipe) {
      throw new Error(`Node "${t.id}" references unknown recipe "${t.recipe}".`);
    }
    let steps;
    try {
      steps = recipe.expand(t.params || {}, profile);
    } catch (e) {
      throw new Error(`Recipe "${t.recipe}" failed to expand for node "${t.id}": ${e.message}`);
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`Recipe "${t.recipe}" produced no steps for node "${t.id}" — nothing to run.`);
    }
    let prevIds = Array.isArray(t.depends_on) ? t.depends_on : [];
    steps.forEach((step, i) => {
      const stepId = `${t.id}.${i + 1}`;
      const node = {
        id: stepId,
        type: 'tool',
        description: step.description || `${recipe.id} step ${i + 1}: ${step.tool}(${JSON.stringify(step.args || {})})`,
        depends_on: prevIds,
        tool: step.tool,
        args: step.args || {},
      };
      // exclusive/onFailureHint are the recipe's own properties (a barrier
      // and diagnostic text respectively); onFailure is the graph author's
      // choice per invocation, not baked into the recipe module.
      if (recipe.exclusive) node.exclusive = true;
      if (recipe.onFailureHint) node.onFailureHint = recipe.onFailureHint;
      if (t.onFailure) node.onFailure = t.onFailure;
      out.push(node);
      prevIds = [stepId];
    });
  }
  return out;
}

// Auto-inserted fix-task ids need a uniqueness suffix — plain `${baseId}.fix`
// collides if the same node fails twice across retries.
function uniqueFixId(baseId, existingIds) {
  let candidate = `${baseId}.fix`;
  let n = 2;
  while (existingIds.has(candidate)) {
    candidate = `${baseId}.fix${n}`;
    n++;
  }
  return candidate;
}

function writeTasks(tasks) {
  const cwd = getConfig().targetDir || process.cwd();
  const expanded = expandRecipeNodes(tasks, cwd);
  const ordered = topoSortTasks(expanded);
  writeJson(FILES.tasks, ordered);
  return ordered;
}

// Shared completed/aborted bookkeeping — was duplicated 3+ times across the
// old sequential/concurrent branches and handleRunOne (see REDESIGN_PLAN.md
// Phase 2 duplication inventory).
function markTaskAborted(id) {
  const arr = readJson(FILES.aborted, []);
  if (!arr.includes(id)) {
    arr.push(id);
    writeJson(FILES.aborted, arr);
  }
}
function markTaskCompleted(id) {
  const arr = readJson(FILES.completed, []);
  if (!arr.includes(id)) {
    arr.push(id);
    writeJson(FILES.completed, arr);
  }
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

// Phase 6: the tools the splitter may fold a mechanical tail into. Excludes
// task_complete — that's an agent-loop-internal completion signal, not a
// standalone deterministic step. Names are validated against this same list
// (roles/shared.js normalizeToolNode) so a hallucinated tool name is rejected
// rather than silently persisted into a node the scheduler can't run.
function toolMenu() {
  const eligible = toolList.filter((t) => t.name !== 'task_complete');
  const names = eligible.map((t) => t.name);
  const menu = eligible.map((t) => `  "${t.name}" — ${t.description}`).join('\n');
  return { names, menu };
}

// ---------------------------------------------------------------------------
// Route: POST /api/plan
// ---------------------------------------------------------------------------
async function handlePlan(req, res) {
  const body = await readBody(req);
  const prompt = (body.prompt || '').trim();
  const targetDir = (body.targetDir || '').trim() || process.cwd();
  if (!prompt) return sendJson(res, 400, { error: 'Missing "prompt" in request body.' });

  // Merge targetDir into config BEFORE any FILES.* write below — FILES now
  // resolves against the *current* config.targetDir, so writing master first
  // would target the previous project's state dir.
  writeJson(FILES.config, { ...readJson(FILES.config, {}), targetDir });
  ensureStateDirIgnored(targetDir);
  fs.writeFileSync(FILES.master, prompt);

  // Offer the planner the concrete, worker-eligible "client:model" refs it may
  // assign, so it never emits a model that can't actually run a task.
  const { menu, fallback } = workerModelMenu();

  let tasks;
  try {
    tasks = await runRole('planner', { prompt, menu, fallback, cwd: targetDir });
  } catch (e) {
    return sendJson(res, e.raw ? 502 : 500, {
      error: e.raw ? 'The planner did not return a valid task array.' : 'The planner model failed while planning.',
      detail: (e.message || '').toString(),
      raw: e.raw,
      hint: e.raw
        ? undefined
        : 'Check config.json "roles.planner": is its client reachable (claude on PATH, or the provider API key env var set)?',
    });
  }
  try {
    tasks = writeTasks(tasks);
  } catch (e) {
    return sendJson(res, 502, { error: 'Planner produced an invalid task graph.', detail: e.message });
  }
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

  const { menu, fallback } = workerModelMenu();
  const { names: toolNames, menu: toolMenuText } = toolMenu();

  let expanded;
  try {
    expanded = await runRole('splitter', {
      tasks,
      menu,
      fallback,
      lessons: lessonsBlock(),
      toolMenu: toolMenuText,
      toolNames,
      cwd: getConfig().targetDir || process.cwd(),
    });
  } catch (e) {
    return sendJson(res, e.raw ? 502 : 500, {
      error: e.raw ? 'The splitter did not return a valid task array.' : 'The splitter model failed while splitting.',
      detail: e.message,
      raw: e.raw,
    });
  }

  try {
    expanded = writeTasks(expanded);
  } catch (e) {
    return sendJson(res, 502, { error: 'Splitter produced an invalid task graph.', detail: e.message });
  }
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
  ensureStateDirIgnored(targetDir);
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
    maxConcurrency: Math.max(1, Number(getConfig().maxConcurrency) || DEFAULT_MAX_CONCURRENCY),
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
const TEXT_ROLES = new Set(['planner', 'splitter', 'healer', 'lessoner', 'auditor', 'analyzer']);
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
// auto-runs at end of a run when config.autoAudit is true.
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

  return runRole('auditor', { master, taskLines, sessionCtx, changed, cwd });
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
// Route: POST /api/concurrency — set the max tasks in flight at once.
// Body: { maxConcurrency: number }. 1 reproduces the old "sequential" mode;
// there is no longer a separate scheduler to switch to (see Phase 2).
// ---------------------------------------------------------------------------
async function handleSetConcurrency(req, res) {
  const body = await readBody(req);
  const n = Math.floor(Number(body.maxConcurrency));
  if (!Number.isFinite(n) || n < 1) {
    return sendJson(res, 400, { error: '"maxConcurrency" must be a whole number >= 1.' });
  }
  writeJson(FILES.config, { ...readJson(FILES.config, {}), maxConcurrency: n });
  sendJson(res, 200, { maxConcurrency: n });
}

// ---------------------------------------------------------------------------
// Route: PUT /api/tasks/:id
// ---------------------------------------------------------------------------
async function handlePutTask(req, res, id) {
  const patch = await readBody(req);
  const tasks = readJson(FILES.tasks, []);
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return sendJson(res, 404, { error: `No task with id "${id}".` });

  const allowed = ['description', 'assigned_model', 'effort', 'depends_on', 'type', 'tool', 'args', 'onFailure', 'recipe', 'params'];
  for (const key of allowed) {
    if (key in patch) tasks[idx][key] = patch[key];
  }
  let ordered;
  try {
    ordered = writeTasks(tasks);
  } catch (e) {
    return sendJson(res, 400, { error: 'Edit would produce an invalid task graph.', detail: e.message });
  }
  sendJson(res, 200, { task: ordered.find((t) => t.id === id) });
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

  // Tool nodes have no prompt for a suggested_fix to feed into — a shell
  // command either works or it doesn't, and the retry re-runs it verbatim
  // (e.g. a transient `npm install` network blip). Skip the healer LLM call
  // entirely rather than produce advice nothing will ever read.
  if (errorLog.trim() && tasks[idx].type !== 'tool') {
    try {
      const heal = await runRole('healer', { taskId: id, description: tasks[idx].description, errorLog });
      suggested_fix = heal.fix_summary || null;
      tasks[idx].suggested_fix = suggested_fix;
      tasks[idx].suggested_fix_diagnosis = heal.diagnosis || undefined;
      writeTasks(tasks);
    } catch (e) {
      // Non-fatal: still un-abort so the user can retry manually. Report the
      // hiccup so it isn't silently swallowed.
      suggested_fix = null;
      tasks[idx].suggested_fix_error = e.message;
      writeTasks(tasks);
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

  // Phase 7: catch an unexpanded recipe node here too (see runLoop) — a
  // hand-edited tasks.json might get a manual "Start" click before ever
  // going through a full run.
  let tasks;
  try {
    tasks = writeTasks(readJson(FILES.tasks, []));
  } catch (e) {
    sse(res, { type: 'error', message: `⛔ Invalid task graph: ${e.message}` });
    sse(res, { type: 'done', message: 'done' });
    return res.end();
  }
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

  // Tool nodes never touch a provider — skip the claude-CLI login preflight
  // entirely rather than block a zero-LLM step on an unrelated login check.
  if (task.type !== 'tool') {
    sse(res, { type: 'status', message: '🔐 Checking claude CLI login…' });
    const auth = await checkClaudeAuth();
    if (!auth.ok) {
      sse(res, { type: 'error', message: `⛔ ${auth.message}` });
      sse(res, { type: 'done', message: `⛔ Run stopped before starting — ${auth.message}` });
      if (!clientGone) res.end();
      return;
    }
  }

  // Starting a task manually clears any prior aborted mark, same as retry.
  writeJson(FILES.aborted, readJson(FILES.aborted, []).filter((x) => x !== id));

  sse(res, {
    type: 'task-start',
    id: task.id,
    message:
      task.type === 'tool'
        ? `🔧 ${task.id} — ${task.description} [tool:${task.tool}]`
        : `▶️ ${task.id} — ${task.description} [${task.assigned_model}/${task.effort}]`,
  });

  const runFn = task.type === 'tool' ? runToolNode : runTask;
  const { ok, rateLimited } = await runFn(task, cwd, (payload) => sse(res, payload));
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
    markTaskAborted(id);
    sse(res, {
      type: 'task-aborted',
      id: task.id,
      message: `❌ ${task.id} could not be completed — marked aborted.`,
    });
  } else {
    markTaskCompleted(id);
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
          .filter(Boolean)
          // Defense in depth: .orchestrator/ should already be gitignored in the
          // target repo (see ensureStateDirIgnored), but a stale/missing
          // .gitignore must never let our own state churn masquerade as a
          // task's changed files.
          .filter((f) => f !== '.orchestrator' && !f.startsWith('.orchestrator/'));
        resolve(files);
      }
    );
  });
}

// Adds ".orchestrator/" to the target repo's .gitignore, once, the first time
// a targetDir is set. Idempotent: no-ops if already present. Best-effort —
// a non-git target dir or a permissions error must not block anything else.
function ensureStateDirIgnored(targetDir) {
  try {
    const giPath = path.join(targetDir, '.gitignore');
    const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
    if (/(^|\n)\.orchestrator\/?(\n|$)/.test(existing)) return;
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(giPath, `${existing}${sep}.orchestrator/\n`);
  } catch {
    /* best-effort */
  }
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

  try {
    const lesson = await runRole('lessoner', { taskId: task.id, description: task.description, errorLog });
    const mem = readMemory();
    mem.push({
      id: `mem-${Date.now()}`,
      taskId: task.id,
      ...lesson,
      created_at: new Date().toISOString(),
    });
    writeJson(FILES.memory, mem);
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
  // Phase 6: tool nodes never go through the LLM guesser — normalizeToolNode
  // already derived a static files[] where the tool's args make that possible
  // (write_file/append_file/mkdir); everything else intentionally runs solo
  // (see the "unknownFiles" handling in the scheduler). Either way, asking
  // the analyzer to guess a shell command's file footprint would be a
  // pointless LLM call for a node designed to cost zero.
  const need = tasks.filter((t) => t.type !== 'tool' && !Array.isArray(t.files));
  if (need.length === 0) return tasks;

  let ann;
  try {
    ann = await runRole('analyzer', { tasks: need, cwd });
  } catch {
    return tasks; // best-effort: leave unannotated → scheduler runs tasks solo
  }
  const byId = new Map(ann.map((a) => [a.id, a.files]));
  for (const t of tasks) {
    if (!Array.isArray(t.files)) {
      const f = byId.get(t.id);
      t.files = Array.isArray(f) ? f.map(String) : [];
    }
  }
  writeTasks(tasks);
  return tasks;
}

function runTask(task, cwd, emit) {
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
        emit({ type: 'log', log: `[${task.id}] ${buf.slice(0, nl)}\n` });
        buf = buf.slice(nl + 1);
      }
      if (isErr) errBuf = buf;
      else outBuf = buf;
    };
    const flush = () => {
      if (outBuf) emit({ type: 'log', log: `[${task.id}] ${outBuf}\n` });
      if (errBuf) emit({ type: 'log', log: `[${task.id}] ${errBuf}\n` });
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

// ---------------------------------------------------------------------------
// Phase 6: mechanical type:"tool" nodes. Zero LLM involvement — runs the
// named tool directly via createToolRunner instead of building a worker
// prompt, but shares the same running.json/log-file/error-log/abort-
// controller plumbing as runTask so the rest of the scheduler and the UI
// don't need to know the difference. A failure writes error_logs/{id}.txt
// from the tool's own result — self-healing/lesson capture is triggered by
// the exit code, not an LLM's self-report.
// ---------------------------------------------------------------------------
function runToolNode(node, cwd, emit) {
  return new Promise((resolve) => {
    addRunning(node.id);
    const controller = new AbortController();
    runningControllers.set(node.id, controller);

    const logPath = path.join(LOGS_DIR, `${node.id}.log`);
    let logStream = null;
    try {
      logStream = fs.createWriteStream(logPath, { flags: 'w' });
    } catch {
      /* best-effort: streaming still works without the on-disk log */
    }

    let outAll = '';
    const OUT_CAP = 16000;
    const onLog = (line) => {
      if (logStream) {
        try {
          logStream.write(line);
        } catch {
          /* ignore log write errors */
        }
      }
      outAll = (outAll + line).slice(-OUT_CAP);
      emit({ type: 'log', log: `[${node.id}] ${line}` });
    };

    (async () => {
      let result;
      if (node.recipe) {
        // Schema accepted ahead of the registry that will interpret it —
        // see REDESIGN_PLAN.md Phase 7. Fails loud rather than silently
        // no-op-ing a node the plan expects to have run.
        result = { ok: false, error: `Recipe nodes are not runnable yet (Phase 7): "${node.recipe}"` };
      } else {
        const runner = createToolRunner({ cwd, limits: {}, onLog });
        try {
          result = await runner.run(node.tool, node.args || {});
        } catch (e) {
          result = { ok: false, error: e.message };
        }
      }

      removeRunning(node.id);
      runningControllers.delete(node.id);
      if (logStream) {
        try {
          logStream.end();
        } catch {
          /* ignore */
        }
      }

      if (!result.ok) {
        // result.error covers most tools (bad args, path escape, unknown
        // tool); run_bash instead reports stdout/stderr/exitCode with no
        // `error` field — without pulling those in, the error log would hold
        // only the toolRunner's one-line summary, not the command's actual
        // output, which is exactly what self-healing/lesson capture needs.
        const parts = [];
        if (result.error) parts.push(String(result.error));
        if (typeof result.exitCode === 'number') parts.push(`exit code: ${result.exitCode}`);
        if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);
        if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`);
        const errText = parts.join('\n\n').trim() || outAll.trim();
        try {
          fs.writeFileSync(path.join(ERROR_LOGS_DIR, `${node.id}.txt`), errText || '(no output captured)');
        } catch {
          /* best-effort */
        }
      }
      // Tool nodes never touch a provider, so a rate-limit pause never
      // applies to them.
      resolve({ ok: !!result.ok, rateLimited: null });
    })();
  });
}

// Phase 7: onFailure:"spawn-task". A tool node's failure normally just
// aborts it (see the scheduler below) — this additionally seeds a NEW,
// independent task with the recipe's onFailureHint plus the captured error,
// so the next run has something actionable instead of a dead end the user
// has to diagnose from scratch. Inserted via writeTasks, so it's
// topologically valid the moment it lands.
function spawnFixTask(node, cwd) {
  const tasks = readJson(FILES.tasks, []);
  const existingIds = new Set(tasks.map((t) => t.id));
  const id = uniqueFixId(node.id, existingIds);

  let errorText = '';
  try {
    errorText = fs.readFileSync(path.join(ERROR_LOGS_DIR, `${node.id}.txt`), 'utf8');
  } catch {
    /* nothing captured */
  }

  const description = [
    node.onFailureHint || `The step "${node.id}" (${node.description}) failed. Diagnose and fix it.`,
    '',
    `Failed step: ${node.id} — ${node.description}`,
    errorText ? `\n=== ERROR LOG ===\n${errorText.slice(0, 4000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const fix = {
    id,
    description,
    assigned_model: workerModelMenu().fallback,
    effort: 'medium',
    depends_on: [],
  };
  tasks.push(fix);
  try {
    writeTasks(tasks);
  } catch (e) {
    // Best-effort: a malformed insertion must not crash the run.
    console.error(`[spawn-task] failed to insert fix task for ${node.id}: ${e.message}`);
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// The run loop. Unified in Phase 2: there is one scheduler, built on what was
// previously "concurrent mode"'s depsMet logic — it always follows the real
// depends_on graph (re-read fresh each iteration), never array position.
// maxConcurrency=1 reproduces the old "sequential" guarantee (one task at a
// time, real dependency order) without a second code path; the old sequential
// mode's bug was that it used array position INSTEAD of depends_on, which
// silently diverged from the graph the moment a UI edit, a re-split, or the
// planner emitted tasks out of topological order (see REDESIGN_PLAN.md).
// ---------------------------------------------------------------------------
// Run manager (Phase 4): the run loop is a server-owned process, not tied to
// one HTTP request. GET /api/run subscribes the response to live broadcast()
// output and starts runLoop() if one isn't already active; closing the tab or
// losing the connection only drops that subscription — the loop keeps going.
// A genuine stop is now an explicit action (POST /api/run/stop), since
// connection loss no longer implies "stop".
// ---------------------------------------------------------------------------
const DEFAULT_PAUSE_BACKOFF_MS = 5 * 60 * 1000; // used when the provider gave no reset hint
const MAX_PAUSE_BACKOFF_MS = 30 * 60 * 1000;

const runManager = {
  active: false,
  subscribers: new Set(), // Set<res>
  stopRequested: false,
  resumeTimer: null,
};

function broadcast(payload) {
  for (const res of runManager.subscribers) sse(res, payload);
}
function subscribeRun(res) {
  runManager.subscribers.add(res);
  res.on('close', () => runManager.subscribers.delete(res));
}

function clearPause() {
  if (runManager.resumeTimer) {
    clearTimeout(runManager.resumeTimer);
    runManager.resumeTimer = null;
  }
  try {
    fs.unlinkSync(FILES.pause);
  } catch {
    /* already gone */
  }
}

// Persists { reason, resumeAt } and schedules an unattended re-invocation of
// runLoop — "press Run again once the limit resets" becomes automatic. Honors
// a provider-stated wait (parseRetryAfterMs) when present, else a conservative
// fixed backoff that grows on repeated pauses (capped) so a persistent outage
// doesn't hammer the provider every 5 minutes forever.
function schedulePauseResume(reason) {
  const prior = readJson(FILES.pause, null);
  const streak = prior && prior.reason === reason ? (prior.streak || 1) + 1 : 1;
  const waitMs = Math.min(
    parseRetryAfterMs(reason) || DEFAULT_PAUSE_BACKOFF_MS * streak,
    MAX_PAUSE_BACKOFF_MS
  );
  const resumeAt = Date.now() + waitMs;
  writeJson(FILES.pause, { reason, resumeAt, streak });
  if (runManager.resumeTimer) clearTimeout(runManager.resumeTimer);
  runManager.resumeTimer = setTimeout(() => {
    runManager.resumeTimer = null;
    try {
      fs.unlinkSync(FILES.pause);
    } catch {
      /* already gone */
    }
    broadcast({ type: 'status', message: '▶️ Auto-resuming after provider limit…' });
    startRunLoop();
  }, waitMs);
  return resumeAt;
}

// Called once at boot: a pause.json left over from a backend restart mid-pause
// must still resume unattended, not silently wait forever for a click.
function resumeStalePauseOnBoot() {
  const pause = readJson(FILES.pause, null);
  if (!pause || !pause.resumeAt) return;
  const remaining = pause.resumeAt - Date.now();
  if (remaining <= 0) {
    try {
      fs.unlinkSync(FILES.pause);
    } catch {
      /* ignore */
    }
    startRunLoop();
  } else {
    runManager.resumeTimer = setTimeout(() => {
      runManager.resumeTimer = null;
      try {
        fs.unlinkSync(FILES.pause);
      } catch {
        /* ignore */
      }
      startRunLoop();
    }, remaining);
  }
}

// Starts runLoop() if one isn't already active. Fire-and-forget — callers
// (handleRun, the auto-resume timer) do not await this.
function startRunLoop() {
  if (runManager.active) return;
  runManager.active = true;
  runManager.stopRequested = false;
  runLoop()
    .catch((e) => {
      broadcast({ type: 'error', message: `⛔ Run crashed: ${e.message}` });
    })
    .finally(() => {
      runManager.active = false;
    });
}

async function handleRun(res) {
  setCors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  subscribeRun(res);

  if (runManager.active) {
    sse(res, { type: 'status', message: '📡 Reattached to an in-progress run.' });
    return;
  }
  const pause = readJson(FILES.pause, null);
  if (pause) {
    sse(res, {
      type: 'paused',
      message: `⏸️ Paused — ${pause.reason}. Auto-resuming at ${new Date(pause.resumeAt).toLocaleTimeString()}.`,
    });
    return;
  }
  startRunLoop();
}

// POST /api/run/stop — the explicit stop that used to be implied by closing
// the SSE connection (Phase 2 and earlier). Cancels any pending auto-resume
// too, since a user-requested stop should not silently restart itself.
function handleStopRun(res) {
  runManager.stopRequested = true;
  clearPause();
  broadcast({ type: 'status', message: '⏹️ Stop requested — finishing in-flight task(s), then stopping.' });
  sendJson(res, 200, { stopping: true });
}

// ---------------------------------------------------------------------------
// The run loop. Unified in Phase 2: there is one scheduler, built on what was
// previously "concurrent mode"'s depsMet logic — it always follows the real
// depends_on graph (re-read fresh each iteration), never array position.
// maxConcurrency=1 reproduces the old "sequential" guarantee (one task at a
// time, real dependency order) without a second code path; the old sequential
// mode's bug was that it used array position INSTEAD of depends_on, which
// silently diverged from the graph the moment a UI edit, a re-split, or the
// planner emitted tasks out of topological order (see REDESIGN_PLAN.md).
//
// Phase 4: detached from any single HTTP request — see runManager above.
// stopRequested (not clientGone) is now the only thing that halts the loop.
// ---------------------------------------------------------------------------
async function runLoop() {
  const cfg = getConfig();
  const cwd = cfg.targetDir || process.cwd();
  // Max tasks in flight at once. Tasks only actually run in parallel when
  // their file sets are disjoint (see below) — this is just the ceiling. 1
  // means strictly one at a time, in dependency order.
  const maxConc = Math.max(
    1,
    Number(process.env.CONCURRENCY) || Number(cfg.maxConcurrency) || DEFAULT_MAX_CONCURRENCY
  );

  const stopped = () => runManager.stopRequested;

  // Phase 7: a recipe node normally gets expanded the moment it's written
  // (writeTasks), but tasks.json can also be hand-edited directly — catch an
  // unexpanded recipe node here too, defensively, before the loop ever tries
  // to run something it doesn't know how to execute.
  try {
    writeTasks(readJson(FILES.tasks, []));
  } catch (e) {
    broadcast({ type: 'error', message: `⛔ Invalid task graph: ${e.message}` });
    broadcast({ type: 'done', message: `⛔ Run stopped before starting — ${e.message}` });
    return;
  }

  // Feature 2: clear any stale "running" entries left by a previously crashed or
  // force-closed run before we start fresh.
  clearRunning();

  // Preflight: catch "claude CLI not logged in / not installed" ONCE, up front,
  // instead of aborting every queued task with the same stderr one by one.
  broadcast({ type: 'status', message: '🔐 Checking claude CLI login…' });
  const auth = await checkClaudeAuth();
  if (!auth.ok) {
    // A rate limit can trip on this ping itself, before any task ever runs —
    // that must auto-resume too, not just stop cold (the whole point of
    // Phase 4 is no click required).
    if (auth.rateLimited) {
      const resumeAt = schedulePauseResume(auth.message);
      broadcast({
        type: 'paused',
        message: `⏸️ ${auth.message} — auto-resuming at ${new Date(resumeAt).toLocaleTimeString()}.`,
      });
      broadcast({ type: 'done', message: `⏸️ Run paused before starting — ${auth.message}` });
      clearRunning();
      return;
    }
    broadcast({ type: 'error', message: `⛔ ${auth.message}` });
    broadcast({ type: 'done', message: `⛔ Run stopped before starting — ${auth.message}` });
    clearRunning();
    return;
  }

  broadcast({
    type: 'status',
    message: `Starting run in ${cwd} — up to ${maxConc} task(s) in parallel, in dependency order`,
  });

  // Parallelism is meaningless at concurrency 1, so only pay for the file-
  // isolation analysis pass when it can actually matter (Phase 2 gate — see
  // REDESIGN_PLAN.md: without this, unifying the modes would add a new LLM
  // call to every former-sequential run).
  if (maxConc > 1) {
    broadcast({ type: 'status', message: '🔎 First pass: analyzing task file isolation (fable)…' });
    await analyzeFiles(readJson(FILES.tasks, []), cwd);
    if (stopped()) return;
  }

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
    markTaskAborted(id);
  };

  // Set when a provider rate/usage limit is hit. Stops NEW launches; tasks
  // already in flight are drained first, then the run ends with everything
  // untouched still pending.
  let haltedBy = null;

  while (!stopped()) {
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
        broadcast({
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
      broadcast({
        type: 'done',
        message: nAborted
          ? `⚠️ Run finished — ${nAborted} task(s) aborted.`
          : '✅ All tasks complete.',
      });
      break;
    }

    // Halted by a provider limit and everything in flight has drained: pause
    // and schedule an unattended auto-resume instead of just stopping.
    if (haltedBy && inFlight.size === 0) {
      const resumeAt = schedulePauseResume(haltedBy.reason);
      broadcast({
        type: 'done',
        message:
          `⏸️ Run paused — ${haltedBy.reason}. The remaining tasks are still PENDING ` +
          `(not aborted); auto-resuming at ${new Date(resumeAt).toLocaleTimeString()}.`,
      });
      break;
    }

    // A task can start when its deps are done AND it doesn't clash on files.
    // A task with unknown/empty file info (analysis failed) is treated as
    // conflicting-with-everything: it runs solo, preserving the old safe
    // order. Phase 7: an exclusive node (a recipe like repo-green-up that
    // touches the whole workspace) gets the exact same solo treatment —
    // drain in-flight work first, launch nothing else alongside it — since
    // static path-conflict detection only knows the paths in a node's own
    // args and can't see a workspace-wide command coming.
    const depsMet = (t) => (t.depends_on || []).every((d) => isDone(d));
    const startable = pending.filter(depsMet);

    let launched = false;
    for (const t of haltedBy ? [] : startable) {
      if (inFlight.size >= maxConc) break;
      const soloRequired = t.exclusive || !Array.isArray(t.files) || t.files.length === 0;
      if (soloRequired) {
        if (inFlight.size > 0) continue; // must run alone
      } else if (overlaps(t)) {
        continue; // shares a file with something in flight
      }

      claim(t);
      broadcast({
        type: 'task-start',
        id: t.id,
        message:
          t.type === 'tool'
            ? `🔧 ${t.id} — ${t.description} [tool:${t.tool}]${t.exclusive ? ' [exclusive]' : ''}`
            : `▶️ ${t.id} — ${t.description} [${t.assigned_model}/${t.effort}]`,
      });
      inFlight.set(
        t.id,
        (t.type === 'tool' ? runToolNode : runTask)(t, cwd, broadcast).then((r) => ({ id: t.id, task: t, ...r }))
      );
      launched = true;

      if (soloRequired) break; // solo/exclusive: don't start anything alongside it
      await delay(1500); // gentle stagger between parallel launches
      if (stopped()) break;
    }

    if (inFlight.size === 0) {
      // Nothing running and nothing could be launched => genuinely stuck.
      if (!launched) {
        broadcast({
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
    if (stopped()) break;

    // A provider limit is not this task's fault and will hit every other task
    // identically, so leave it PENDING and stop launching new work.
    if (done.rateLimited) {
      haltedBy = done.rateLimited;
      broadcast({
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
      broadcast({
        type: 'task-aborted',
        id: done.id,
        message: `❌ ${done.id} could not be completed — marked aborted. Continuing with remaining tasks.`,
      });
      if (done.task.type === 'tool' && done.task.onFailure === 'spawn-task') {
        const fixId = spawnFixTask(done.task, cwd);
        if (fixId) {
          broadcast({
            type: 'status',
            message: `🩹 Spawned fix task "${fixId}" for the failed step "${done.id}".`,
          });
        }
      }
      continue;
    }

    markTaskCompleted(done.id);
    broadcast({ type: 'task-complete', id: done.id, message: `✅ ${done.id} done.` });

    // Feature 4: record what this task changed for downstream tasks to read.
    await appendSessionContext(done.id, cwd);
    // Feature 6: if this task had failed before (error log present), distill and
    // store the lesson learned, then clear the error log.
    await recordLesson(done.task);
  }

  // P5: optional Auditor pass at the end of the pipeline (opt-in via
  // config.autoAudit). Skipped when a provider limit cut the run short — the
  // work is incomplete by definition, and the audit would only burn more of
  // the exhausted quota. Also skipped on an explicit stop, for the same reason.
  if (!stopped() && !haltedBy && getConfig().autoAudit) {
    broadcast({ type: 'status', message: '🔎 Auditor: reviewing the completed work…' });
    try {
      const audit = await runAudit(cwd);
      broadcast({
        type: 'audit',
        result: audit,
        message: `🔎 Audit verdict: ${String(audit.verdict).toUpperCase()} — ${audit.summary}`,
      });
    } catch (e) {
      broadcast({ type: 'log', log: `[audit] failed: ${e.message}\n` });
    }
  }

  // Feature 2: run over — nothing should still show as running.
  clearRunning();
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
    if (req.method === 'POST' && pathname === '/api/concurrency') return await handleSetConcurrency(req, res);
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
    if (req.method === 'POST' && pathname === '/api/run/stop') return handleStopRun(res);
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

  // Phase 4: a pause.json surviving a backend restart must still auto-resume
  // — otherwise a crash/redeploy during a provider-limit pause waits forever.
  resumeStalePauseOnBoot();
});
