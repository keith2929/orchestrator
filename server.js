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
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, readJsonFile } from './core/jsonStore.js';
import { topoSortTasks, uniqueFixId, isPlanComplete, issueSignature } from './core/taskGraph.js';
import { readTaskState, setTaskState, runningEntries, classifyInterrupted, endAttempt, isStalled, shouldBlock } from './core/taskState.js';
import crypto from 'node:crypto';
import { extractKeywords, lessonTopicKey, rankLessons, backfillLesson, dedupeLessons } from './core/lessons.js';
import { formatSessionContextBlock, rolloverContent, windowPlannerChat } from './core/sessionContext.js';
import { substituteParams } from './core/recipeExpand.js';
import {
  writeCandidate,
  approveCandidate,
  reconcileIndex,
  resolveActiveVersion,
  recordEvidence,
} from './core/recipeStore.js';

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
import { getRecipe, recipeList } from './graph/recipes/index.js';
import { detectProjectProfile } from './graph/projectProfile.js';
import { mineCandidates, annotateCandidate, clusterByText } from './graph/recipeMiner.js';
import { buildIndex, resolveSection } from './graph/masterPromptIndex.js';
import { assembleLoopPrompt } from './graph/loopPrompt.js';

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
  recipeNotes: 'recipe-notes.json', // Phase 8: { [recipeId]: string[] } — lessons graduated into recipe hints
  customRecipes: 'recipes.json', // Phase 9: human-approved recipes mined from this project's own history
  taskState: 'task_state.json', // Hardening step 4: durable per-task state (attempts, current owner, history)
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

// Step 6: worker timeout, stall and repetition guard knobs. All optional in
// config.json — deliberately generous defaults so a legitimate long build
// doesn't die, while a hung worker no longer holds its concurrency slot (or
// burns a session retrying the same failure) forever.
const DEFAULT_STALL_MS = 600000; // 10 min — no output AND no repo change
const DEFAULT_MAX_ATTEMPT_MS = 2700000; // 45 min — hard ceiling on one attempt
const DEFAULT_MAX_ATTEMPTS = 3; // then blocked, not another retry
const DEFAULT_IDENTICAL_FAILURE_LIMIT = 2; // same failure signature twice -> stop retrying identically
function readWorkerLimits() {
  const cfg = getConfig();
  return {
    stallMs: Number(cfg.stallMs) || DEFAULT_STALL_MS,
    maxAttemptMs: Number(cfg.maxAttemptMs) || DEFAULT_MAX_ATTEMPT_MS,
    maxAttempts: Number(cfg.maxAttempts) || DEFAULT_MAX_ATTEMPTS,
    identicalFailureLimit: Number(cfg.identicalFailureLimit) || DEFAULT_IDENTICAL_FAILURE_LIMIT,
  };
}

// Per-task artefacts. error_logs/{id}.txt drives self-healing retry (Feature 3)
// and lesson capture (Feature 6); logs/{id}.log is the full tee'd run log
// (Feature 5).
//
// Step 8: these used to live next to this script, keyed by bare task id —
// and every plan reuses ids like "task-3", so a new project could read a
// stale error log (or mined recipe) from a completely different project that
// last used the tool. Both now resolve through getStateDir() like every
// other piece of state, lazily per CURRENT targetDir rather than once at
// module load — so switching projects never bleeds logs between them.
// './logs' and './error_logs' next to this script are dead and deletable.
function errorLogsDir() {
  const dir = path.join(getStateDir(), 'error_logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort: creation errors surface later on read/write */
  }
  return dir;
}
function logsDir() {
  const dir = path.join(getStateDir(), 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort: creation errors surface later on read/write */
  }
  return dir;
}

// Keeps only the newest `keep` .log/.txt files in `dir` — an unattended run
// over many plans must not accumulate artefacts forever. Best-effort: a
// failure here must never block the caller's own read/write.
const MAX_LOGS_PER_PROJECT = 50;
function pruneOldLogs(dir, keep = MAX_LOGS_PER_PROJECT) {
  try {
    const files = fs
      .readdirSync(dir)
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(keep)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* directory may not exist yet — nothing to prune */
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
// ---------------------------------------------------------------------------
// Phase 7: recipe expansion. A type:"recipe" node ({ id, type, depends_on,
// recipe, params }) is a REFERENCE, never executed directly — it is replaced
// here by the concrete type:"tool" node chain its expand(params, profile)
// produces, wired depends_on -> depends_on -> ... so the recipe's internal
// order is preserved and the first step inherits the recipe node's own
// dependencies. Runs on every writeTasks() call, so it doesn't matter
// whether a recipe node arrived via the API or a hand-edited tasks.json.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Step 11: project-local custom recipes are versioned, hand-editable files
// under <targetDir>/.orchestrator/recipes/ (core/recipeStore.js) instead of
// opaque rows in recipes.json — see HARDENING_PLAN.md step 11 for the file
// format and the candidate -> approve -> published lifecycle. Built-in
// recipes (graph/recipes/) still win on id collision — they ship with the
// codebase and are reviewed by a human at authoring time, not runtime.
// ---------------------------------------------------------------------------
function recipesDirFor(cwd) {
  const dir = path.join(cwd, '.orchestrator', 'recipes');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  migrateLegacyRecipesJson(cwd, dir);
  return dir;
}

// One-time migration: legacy recipes.json rows become v1.md files. No-ops
// once the legacy file is gone (renamed after a successful migration so this
// never re-runs and never re-imports something a human since deprecated).
function migrateLegacyRecipesJson(cwd, recipesDir) {
  const legacyPath = path.join(cwd, '.orchestrator', 'recipes.json');
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  } catch {
    return; // already migrated, or never existed
  }
  if (!Array.isArray(legacy) || !legacy.length) {
    try {
      fs.renameSync(legacyPath, `${legacyPath}.migrated`);
    } catch {
      /* best-effort */
    }
    return;
  }
  for (const r of legacy) {
    if (!r || !r.id || !Array.isArray(r.steps)) continue;
    const destDir = path.join(recipesDir, r.id);
    if (fs.existsSync(path.join(destDir, 'v1.md'))) continue; // already migrated
    try {
      const { path: candidatePath } = writeCandidate(recipesDir, {
        id: r.id,
        description: r.description || '',
        steps: r.steps,
        onFailureHint: r.onFailureHint || '',
      });
      const version = Number(/\.v(\d+)\.md$/.exec(candidatePath)[1]);
      approveCandidate(recipesDir, r.id, version);
    } catch {
      /* best-effort — a bad legacy row is skipped, not fatal */
    }
  }
  try {
    fs.renameSync(legacyPath, `${legacyPath}.migrated`);
  } catch {
    /* best-effort */
  }
}

// Built-ins first, then this project's own approved recipes (the ACTIVE
// published version — see core/recipeStore.js's reconcileIndex).
function getRecipeForProject(id, cwd) {
  const builtin = getRecipe(id);
  if (builtin) return builtin;
  const custom = resolveActiveVersion(recipesDirFor(cwd), id, recipeList.map((r) => r.id));
  if (!custom) return null;
  return {
    ...custom,
    expand(params) {
      return substituteParams(custom.steps, params || {});
    },
  };
}

function expandRecipeNodes(tasks, cwd) {
  if (!tasks.some((t) => t.type === 'recipe')) return tasks;
  const profile = detectProjectProfile(cwd);
  const out = [];
  for (const t of tasks) {
    if (t.type !== 'recipe') {
      out.push(t);
      continue;
    }
    const recipe = getRecipeForProject(t.recipe, cwd);
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
      // recipeHintFor (Phase 8) folds in whatever this project has since
      // learned about this recipe's failure modes, on top of its static text.
      if (recipe.exclusive) node.exclusive = true;
      const hint = recipeHintFor(recipe.id, cwd);
      if (hint) node.onFailureHint = hint;
      if (t.onFailure) node.onFailure = t.onFailure;
      out.push(node);
      prevIds = [stepId];
    });
  }
  return out;
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
// Phase 2 duplication inventory). Both are now thin wrappers over
// core/taskState.js's setTaskState, the single writer of task_state.json,
// which re-derives completed.json/aborted.json in the same call so every
// existing reader keeps working unchanged.
function markTaskAborted(id) {
  setTaskState(FILES.taskState, id, { status: 'aborted', current: null }, { completedFile: FILES.completed, abortedFile: FILES.aborted });
}
function markTaskCompleted(id) {
  setTaskState(FILES.taskState, id, { status: 'done', current: null }, { completedFile: FILES.completed, abortedFile: FILES.aborted });
}

// Phase 10: a plan is COMPLETE when every node has reached a terminal state
// (done or aborted). Checked after ANY task settles — the unified scheduler
// (every while-loop iteration) and handleRunOne (single-task manual runs) —
// not just once at end-of-run, so "is this plan finished" is answered the
// same way everywhere instead of re-derived ad hoc per call site.
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
// Migration: if task_state.json doesn't exist yet, synthesize one from the
// legacy completed.json/aborted.json arrays so upgrading mid-run doesn't
// forget what already finished.
function loadTaskState() {
  return readTaskState(FILES.taskState, { completed: readJson(FILES.completed, []), aborted: readJson(FILES.aborted, []) });
}

// readRunning() is now a projection over task_state.json's 'in_progress'
// records — running.json is no longer written. addRunning/removeRunning keep
// their names (existing call sites are unchanged) but now delegate to
// setTaskState.
function readRunning() {
  return runningEntries(loadTaskState());
}
// Synchronous counterpart to currentGitState() (below) — addRunning is
// called from inside runTask/runToolNode's synchronous Promise executor, so
// capturing the baseline here uses execFileSync rather than restructuring
// those into async functions for one git call. Real evidence here (not
// null) is what makes step 5's classifyInterrupted able to tell "this task
// already changed the repo" apart from "never got anywhere" after a crash.
function captureGitBaselineSync(cwd) {
  try {
    const head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const porcelain = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    return { head, porcelainHash: crypto.createHash('sha256').update(porcelain).digest('hex') };
  } catch {
    return null; // not a git repo, or git unavailable — recovery degrades to "no evidence"
  }
}

function addRunning(taskId, cwd) {
  const now = Date.now();
  setTaskState(
    FILES.taskState,
    taskId,
    {
      status: 'in_progress',
      current: {
        owner: null,
        leaseUntil: now + 3600000,
        startedAt: now,
        lastOutputAt: now,
        lastRepoChangeAt: now,
        gitBaseline: cwd ? captureGitBaselineSync(cwd) : null,
      },
    },
    { completedFile: FILES.completed, abortedFile: FILES.aborted }
  );
}
// Bumps lastOutputAt on the in-flight record as output streams in — without
// this, isStalled() would judge a legitimately chatty long task by a
// timestamp frozen at launch and abort it as "stalled" even while it's
// actively working. Throttled: called on every output chunk, but a
// setTaskState is a full read-modify-write of task_state.json, so this
// coalesces to at most one write per second per task.
const lastOutputBumpAt = new Map();
function bumpOutputActivity(taskId) {
  const now = Date.now();
  const last = lastOutputBumpAt.get(taskId) || 0;
  if (now - last < 1000) return;
  lastOutputBumpAt.set(taskId, now);
  const state = loadTaskState();
  const record = state[taskId];
  if (!record || !record.current) return;
  setTaskState(
    FILES.taskState,
    taskId,
    { current: { ...record.current, lastOutputAt: now } },
    { completedFile: FILES.completed, abortedFile: FILES.aborted }
  );
}
function removeRunning(taskId) {
  setTaskState(FILES.taskState, taskId, { status: 'pending', current: null }, { completedFile: FILES.completed, abortedFile: FILES.aborted });
}
// Resets every currently in_progress record to 'pending' — the fresh-run-start
// / boot-time equivalent of the old "delete running.json". Attempts/history
// are preserved; only the "is this actively running" flag is cleared.
function clearRunning() {
  const state = loadTaskState();
  for (const id of Object.keys(state)) {
    if (state[id].status === 'in_progress') {
      setTaskState(FILES.taskState, id, { status: 'pending', current: null }, { completedFile: FILES.completed, abortedFile: FILES.aborted });
    }
  }
}

// In-memory only (not persisted — a server restart naturally drops any
// in-flight subprocess anyway). Maps a running task's id to the
// AbortController that can stop it; used by POST /api/tasks/:id/stop.
const runningControllers = new Map();

// ---------------------------------------------------------------------------
// Feature 6 / Phase 8: failure memory. memory.json is a small residual list
// of lessons learned from tasks that failed and were then fixed — "residual"
// because a lesson whose failure matches a known recipe now graduates into
// that recipe's onFailureHint (see recordLesson/appendRecipeNote below)
// instead of staying here forever. What's left is ranked by RELEVANCE to the
// task at hand, not blind recency — a CSS task must never see SEC EDGAR
// lessons just because they're the 5 most recent.
// ---------------------------------------------------------------------------
function readMemory() {
  const raw = readJson(FILES.memory, []);
  const m = Array.isArray(raw) ? raw : [];
  const backfilled = m.map(backfillLesson);
  // Only write back if backfilling actually changed something — most reads
  // happen mid-run and shouldn't churn the file every time.
  if (JSON.stringify(backfilled) !== JSON.stringify(m)) writeJson(FILES.memory, backfilled);
  return backfilled;
}

// Cheap, deterministic, zero-LLM keyword extraction — used both to tag a
// lesson at write time and to rank stored lessons against a task's own text
// at read time. Not NLP-grade; it only needs to catch obvious overlap
// ("edgar", "wacc", "beta") to keep an unrelated task's prompt clean.
// Prompt fragment listing the stored lessons relevant to `ctx` — a single
// task, or (for the splitter) an array of candidate tasks — ranked by
// keyword/file overlap, or [] when nothing overlaps at all. This is the
// fix for both "every task prompt" and "every splitter prompt" blindly
// inlining the same last-5-by-recency list regardless of relevance.
function lessonsBlock(ctx, n = 3) {
  const relevant = rankLessons(readMemory(), ctx, n);

  if (!relevant.length) return [];
  return [
    '',
    'PREVIOUS MISTAKES TO AVOID (lessons from earlier failed tasks, relevant to this one):',
    ...relevant.map((l, i) => `  ${i + 1}. ${l.lesson || l.error_summary || '(no detail)'}`),
  ];
}

// ---------------------------------------------------------------------------
// Phase 8: recipe field notes. A lesson the lessoner matched to a built-in
// recipe graduates OUT of the flat memory.json list and into that recipe's
// onFailureHint instead — permanent, always surfaced for that failure mode,
// and costs nothing to show (vs. competing for a top-N slot forever). Stored
// per-project since the failure pattern is about this codebase, not the
// recipe itself.
// ---------------------------------------------------------------------------
const MAX_NOTES_PER_RECIPE = 5;
function readRecipeNotes() {
  const n = readJson(FILES.recipeNotes, {});
  return n && typeof n === 'object' ? n : {};
}
function appendRecipeNote(recipeId, note) {
  const text = String(note || '').trim();
  if (!text) return;
  const notes = readRecipeNotes();
  const list = Array.isArray(notes[recipeId]) ? notes[recipeId] : [];
  if (list.includes(text)) return; // don't pile up literal duplicates
  list.push(text);
  while (list.length > MAX_NOTES_PER_RECIPE) list.shift(); // bounded; newest wins
  notes[recipeId] = list;
  writeJson(FILES.recipeNotes, notes);
}
// The hint actually surfaced on an expanded recipe node: the recipe
// module's own static text (built-in or custom), plus whatever this project
// has since learned.
function recipeHintFor(recipeId, cwd) {
  const recipe = getRecipeForProject(recipeId, cwd);
  const base = (recipe && recipe.onFailureHint) || '';
  const notes = readRecipeNotes()[recipeId] || [];
  if (!notes.length) return base;
  return [base, '', 'Also learned from past failures on this project:', ...notes.map((n) => `- ${n}`)]
    .filter(Boolean)
    .join('\n');
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

// Phase 8: given to the lessoner so matched_recipe names a recipe that
// actually exists instead of guessing blind — recordLesson only graduates a
// lesson into a recipe's notes when getRecipe(matched_recipe) resolves.
function recipeMenu() {
  const menu = recipeList.map((r) => `  "${r.id}" — ${r.description}`).join('\n');
  return { names: recipeList.map((r) => r.id), menu };
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
// A task is worth the splitter's attention only if it's missing a
// green_test (so there's no way to tell when it's actually done) or its
// effort is high/ultracode (large enough to plausibly need breaking up).
// Tool/recipe nodes are mechanical, not prose — splitting doesn't apply.
function isSplitCandidate(t) {
  if (t.type === 'tool' || t.type === 'recipe') return false;
  return !t.green_test || t.effort === 'high' || t.effort === 'ultracode';
}

async function handleSplit(req, res) {
  const tasks = readJson(FILES.tasks, []);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return sendJson(res, 400, { error: 'No tasks to split. Generate a plan first.' });
  }

  // Phase 8: send only the candidates, not JSON.stringify(the entire plan) —
  // O(whole plan) input tokens to split one task doesn't scale. Everything
  // else passes through untouched.
  const candidates = tasks.filter(isSplitCandidate);
  if (candidates.length === 0) {
    return sendJson(res, 200, { tasks, note: 'Nothing to split — every task already has a green_test and low/medium effort.' });
  }

  const { menu, fallback } = workerModelMenu();
  const { names: toolNames, menu: toolMenuText } = toolMenu();

  let splitResult;
  try {
    splitResult = await runRole('splitter', {
      tasks: candidates,
      menu,
      fallback,
      lessons: lessonsBlock(candidates),
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

  // Merge the splitter's output (covering only `candidates`) back into the
  // full plan: each output entry belongs to a candidate if its id is that
  // candidate's id (untouched) or "<candidateId>.<suffix>" (split), per the
  // splitter's own "parentID.a, parentID.b" naming convention. Anything the
  // splitter emitted that doesn't match a candidate (a hallucinated new id)
  // is appended rather than silently dropped.
  const belongsTo = (entry, candidateId) => entry.id === candidateId || entry.id.startsWith(`${candidateId}.`);
  const consumed = new Set();
  const merged = [];
  for (const t of tasks) {
    if (!isSplitCandidate(t)) {
      merged.push(t);
      continue;
    }
    const produced = splitResult.filter((e) => belongsTo(e, t.id));
    if (produced.length) {
      produced.forEach((e) => {
        consumed.add(e.id);
        // Phase 10: the splitter's own schema doesn't ask for source_section,
        // so a split sub-task would otherwise lose the pointer entirely —
        // inherit it mechanically from the parent candidate instead.
        if (!e.source_section && t.source_section) e.source_section = t.source_section;
      });
      merged.push(...produced);
    } else {
      merged.push(t); // splitter dropped it — keep the original rather than losing it
    }
  }
  for (const e of splitResult) {
    if (!consumed.has(e.id)) merged.push(e);
  }

  let expanded;
  try {
    expanded = writeTasks(merged);
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

  // Step 9: the full transcript is still persisted below; only the REPLAY
  // sent to the model is bounded (first turn + most recent 20) so a long
  // planning conversation doesn't resend an ever-growing history every turn.
  let reply;
  try {
    reply = await resolveRole('planner').chat(
      windowPlannerChat(messages, 20).map((m) => ({ role: m.role, content: m.content })),
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
    // Phase 10: green_test was collected at split time but never actually
    // sent to the auditor — without it, the auditor has no way to know a
    // task already has its own settled definition of done and re-litigates
    // it instead of focusing on real gaps.
    const test = t.green_test ? ` [green_test: ${t.green_test}]` : '';
    return `- [${status}] ${t.id} (${t.assigned_model}): ${t.description}${test}`;
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
// Phase 9: post-mortem recipe mining. Detection (mineCandidates,
// annotateCandidate) is pure code, zero LLM; this wraps it with ONE bounded
// recipeCurator call per candidate that isn't already covered by an existing
// recipe. Never auto-promoted — see handleApproveRecipe.
// ---------------------------------------------------------------------------
async function mineAndCurateRecipes(cwd) {
  const clusters = mineCandidates({ tasksPath: FILES.tasks, memoryPath: FILES.memory, logsDir: logsDir() });
  const profile = detectProjectProfile(cwd);
  const { menu: toolMenuText, names: toolNames } = toolMenu();

  const results = [];
  for (const cluster of clusters) {
    const annotated = annotateCandidate(cluster, profile);
    if (annotated.matchesExistingRecipe) {
      results.push({
        ...annotated,
        proposal: null,
        note: `Already covered by the "${annotated.matchesExistingRecipe}" recipe — no new recipe needed.`,
      });
      continue;
    }
    try {
      const proposal = await runRole('recipeCurator', {
        examples: annotated.members.map((m) => m.text).slice(0, 5),
        toolMenu: toolMenuText,
        toolNames,
        profile,
        matchesProfileScripts: annotated.matchesProfileScripts,
      });
      results.push({ ...annotated, proposal });
    } catch (e) {
      results.push({ ...annotated, proposal: null, error: e.message });
    }
  }
  return results;
}

async function handleMineRecipes(res) {
  const cwd = getConfig().targetDir || process.cwd();
  try {
    sendJson(res, 200, { candidates: await mineAndCurateRecipes(cwd) });
  } catch (e) {
    sendJson(res, 500, { error: 'Recipe mining failed.', detail: e.message });
  }
}

// POST /api/recipes/approve — the human-approval gate. Body: { recipe: {
// id, description, params?, steps, onFailureHint? } } (a proposal from
// POST /api/recipes/mine, possibly hand-edited first). Writes a NEW
// candidate file and immediately moves it to published — the structural
// gate (step 11) is that a candidate is never resolvable UNTIL this move
// happens; the API keeps the same single-call shape callers already use.
async function handleApproveRecipe(req, res) {
  const body = await readBody(req);
  const proposal = body.recipe;
  if (!proposal || typeof proposal !== 'object') {
    return sendJson(res, 400, { error: 'Missing "recipe" in request body.' });
  }
  const id = String(proposal.id || '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    return sendJson(res, 400, { error: `Invalid recipe id: ${JSON.stringify(proposal.id)}` });
  }
  if (getRecipe(id)) {
    return sendJson(res, 400, { error: `"${id}" collides with a built-in recipe id — choose another.` });
  }
  const { names: toolNames } = toolMenu();
  const steps = Array.isArray(proposal.steps) ? proposal.steps : [];
  if (!steps.length) return sendJson(res, 400, { error: 'Recipe has no steps.' });
  for (let i = 0; i < steps.length; i++) {
    if (!steps[i] || !toolNames.includes(steps[i].tool)) {
      return sendJson(res, 400, { error: `Step ${i + 1} references unknown tool "${steps[i] && steps[i].tool}".` });
    }
  }

  const cwd = getConfig().targetDir || process.cwd();
  const recipesDir = recipesDirFor(cwd);
  const cleanSteps = steps.map((s) => ({ tool: s.tool, args: s.args && typeof s.args === 'object' ? s.args : {} }));
  const sourceLessons = Array.isArray(proposal.sourceLessons) ? proposal.sourceLessons.map(String) : [];
  const { path: candidatePath } = writeCandidate(recipesDir, {
    id,
    description: proposal.description || '(no description)',
    steps: cleanSteps,
    onFailureHint: proposal.onFailureHint || '',
    sourceLessons,
  });
  const version = Number(/\.v(\d+)\.md$/.exec(candidatePath)[1]);
  const { record } = approveCandidate(recipesDir, id, version);

  // Step 12: a proposal mined from memory.json backlog lessons carries their
  // ids as sourceLessons — approving retires them out of memory.json into
  // this version's file (already recorded in evidence.sourceLessons above),
  // archiving rather than silently deleting.
  if (sourceLessons.length) {
    const idSet = new Set(sourceLessons);
    const memory = readMemory();
    const retired = memory.filter((l) => idSet.has(String(l.id || l.taskId)));
    if (retired.length) {
      const remaining = memory.filter((l) => !idSet.has(String(l.id || l.taskId)));
      writeJson(FILES.memory, remaining);
      const historyDir = path.join(getStateDir(), 'history');
      fs.mkdirSync(historyDir, { recursive: true });
      const archivePath = path.join(historyDir, `memory-compacted-${new Date().toISOString().slice(0, 10)}.json`);
      writeJson(archivePath, [...readJson(archivePath, []), ...retired]);
    }
  }

  sendJson(res, 200, { recipe: record });
}

function handleGetRecipes(res) {
  const cwd = getConfig().targetDir || process.cwd();
  const recipesDir = recipesDirFor(cwd);
  const builtinIds = recipeList.map((r) => r.id);
  const builtins = recipeList.map((r) => ({ id: r.id, description: r.description, source: 'built-in' }));

  const { entries, candidates } = reconcileIndex(recipesDir, builtinIds);
  const custom = [];
  for (const [id, entry] of Object.entries(entries)) {
    for (const [version, v] of Object.entries(entry.versions)) {
      custom.push({
        id,
        version: Number(version),
        description: v.record ? v.record.description : undefined,
        source: 'custom',
        status: v.status,
        derived: v.derived || null,
        approvedAt: v.record ? v.record.approvedAt : undefined,
        confidence: v.record ? v.record.confidence : undefined,
        error: v.error,
      });
    }
  }
  const candidateRows = Object.values(candidates).map((c) => ({
    id: c.record ? c.record.id : null,
    version: c.record ? c.record.version : null,
    source: 'candidate',
    status: c.status,
    error: c.error,
  }));
  sendJson(res, 200, { recipes: [...builtins, ...custom, ...candidateRows] });
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
  const logPath = path.join(errorLogsDir(), `${id}.txt`);
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

  // Step 9: snapshot the dirty tree BEFORE this task runs, so its own
  // session_context.md entry can list only what IT changed.
  const beforeFiles = await gitChangedFiles(cwd);

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
    await appendSessionContext(task.id, cwd, beforeFiles);
    await recordLesson(task);
  }

  // Phase 10: checked here too, not just at end of a bulk run — a plan
  // finished one manual "Start" click at a time is just as complete.
  const allTasks = readJson(FILES.tasks, []);
  const complete = isPlanComplete(allTasks, readJson(FILES.completed, []), readJson(FILES.aborted, []));
  sse(res, { type: 'done', planComplete: complete, message: ok ? '✅ Task finished.' : '⛔ Task failed.' });
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
  const safeId = path.basename(String(id)); // never escape logsDir()
  const logPath = path.join(logsDir(), `${safeId}.log`);
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
// Step 12: POST /api/memory/compact — a re-runnable compaction pass over
// memory.json, dry-run by default ({ apply: true } to commit):
//   1. dedupe entries sharing a topic key (dedupeLessons — newest wins);
//   2. graduate anything matching an existing recipe into that recipe's
//      notes (reuses annotateCandidate's matchesExistingRecipe — the same
//      check recordLesson already does going forward, applied
//      retroactively to the backlog);
//   3. cluster what's left with minSize 2 (looser than ordinary mining's 3
//      — this is a one-off backlog pass, not the standing threshold) and
//      report them as proposal clusters for a human to mine into real
//      recipes via the existing POST /api/recipes/mine flow;
//   4. archive everything removed under .orchestrator/history/ rather than
//      deleting it outright.
// Never auto-approves anything — proposals are reported only, and
// graduation only touches recipe NOTES (recipe-notes.json), never a
// recipe's own step definitions.
// ---------------------------------------------------------------------------
async function handleCompactMemory(req, res) {
  const body = await readBody(req);
  const apply = !!body.apply;
  const cwd = getConfig().targetDir || process.cwd();
  const profile = detectProjectProfile(cwd);

  const memory = readMemory();
  const { kept, removed: dupRemoved } = dedupeLessons(memory);

  const lessonText = (l) => [l.error_summary, l.root_cause, l.lesson].filter(Boolean).join(' ');

  const graduated = [];
  const remaining = [];
  for (const lesson of kept) {
    const annotated = annotateCandidate({ members: [{ text: lessonText(lesson) }] }, profile);
    if (annotated.matchesExistingRecipe) {
      graduated.push({
        lessonId: lesson.id || lesson.taskId,
        recipeId: annotated.matchesExistingRecipe,
        note: lesson.lesson || lesson.error_summary || lessonText(lesson),
        lesson,
      });
    } else {
      remaining.push(lesson);
    }
  }

  // A looser threshold than ordinary mining (minSize 3) — this is a one-time
  // pass over an existing backlog, not the standing mining config.
  const clusters = clusterByText(
    remaining.map((l) => ({ id: l.id || l.taskId, text: lessonText(l) })),
    { minSize: 2 }
  );
  const proposals = clusters.map((c) => ({ size: c.length, memberIds: c.map((m) => m.id) }));

  if (!apply) {
    return sendJson(res, 200, {
      removed: dupRemoved.length,
      graduated: graduated.length,
      proposals: proposals.length,
      remaining: remaining.length,
      details: { proposals },
    });
  }

  for (const g of graduated) appendRecipeNote(g.recipeId, g.note);
  writeJson(FILES.memory, remaining);

  const archived = [...dupRemoved, ...graduated.map((g) => g.lesson)];
  if (archived.length) {
    const historyDir = path.join(getStateDir(), 'history');
    fs.mkdirSync(historyDir, { recursive: true });
    const archivePath = path.join(historyDir, `memory-compacted-${new Date().toISOString().slice(0, 10)}.json`);
    writeJson(archivePath, [...readJson(archivePath, []), ...archived]);
  }

  sendJson(res, 200, {
    removed: dupRemoved.length,
    graduated: graduated.length,
    proposals: proposals.length,
    remaining: remaining.length,
  });
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

// ---------------------------------------------------------------------------
// Step 5: crash recovery. Runs at boot and at the top of every runLoop pass,
// over every task_state.json record still marked 'in_progress'. Evidence —
// the record's own gitBaseline, the CURRENT git state, and whether every
// dependency is done — decides what happens next; see core/taskState.js's
// classifyInterrupted for the ladder. This replaces the old blind
// clearRunning() wipe: a task that already changed the repo is now verified
// or requeued with continuation context instead of silently re-run from
// scratch.
// ---------------------------------------------------------------------------
function currentGitState(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { shell: IS_WIN }, (err, stdout) => {
      const head = err ? null : String(stdout).trim();
      execFile(
        'git',
        ['-C', cwd, 'status', '--porcelain'],
        { maxBuffer: 4 * 1024 * 1024, shell: IS_WIN },
        (err2, stdout2) => {
          const porcelain = err2 ? '' : String(stdout2);
          resolve({ head, porcelainHash: crypto.createHash('sha256').update(porcelain).digest('hex') });
        }
      );
    });
  });
}

// Bounded by a fixed ceiling during recovery — the configurable maxAttemptMs
// knob is introduced by step 6; this uses a generous fixed default so a
// green_test verification here can never hang a boot/run-start indefinitely.
const RECOVERY_GREEN_TEST_TIMEOUT_MS = 300000;
function runGreenTestForRecovery(command, cwd) {
  return new Promise((resolve) => {
    execFile(
      command,
      { cwd, shell: true, timeout: RECOVERY_GREEN_TEST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, tail: String(stderr || stdout || '').slice(-2000) });
      }
    );
  });
}

async function recoverInterruptedTasks(cwd) {
  const state = loadTaskState();
  const inProgressIds = Object.keys(state).filter((id) => state[id].status === 'in_progress');
  if (!inProgressIds.length) return;

  const tasks = readJson(FILES.tasks, []);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const gitState = await currentGitState(cwd);

  for (const id of inProgressIds) {
    const record = state[id];
    const task = byId.get(id);
    const depsDone = !task || (task.depends_on || []).every((d) => state[d] && state[d].status === 'done');
    const { result, reason } = classifyInterrupted({ ...record, greenTest: task && task.green_test }, gitState, depsDone);

    if (result === 'done') {
      markTaskCompleted(id);
      console.log(`[recovery] ${id}: ${reason} -> done`);
      continue;
    }

    if (result === 'verify' && task && task.green_test) {
      const outcome = await runGreenTestForRecovery(task.green_test, cwd);
      if (outcome.ok) {
        markTaskCompleted(id);
        console.log(`[recovery] ${id}: repo changed, green_test passed -> done`);
      } else {
        setTaskState(FILES.taskState, id, { status: 'pending', current: null }, { completedFile: FILES.completed, abortedFile: FILES.aborted });
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx !== -1) {
          tasks[idx].suggested_fix = `Recovered from an interrupted run: repo had partial changes but green_test failed:\n${outcome.tail}`;
          writeTasks(tasks);
        }
        console.log(`[recovery] ${id}: repo changed, green_test failed -> pending with suggested_fix`);
      }
      continue;
    }

    if (result === 'needs_verification') {
      const changedFiles = await gitChangedFiles(cwd);
      let logTail = '';
      try {
        logTail = fs.readFileSync(path.join(logsDir(), `${id}.log`), 'utf8').slice(-2000);
      } catch {
        /* no log from this attempt */
      }
      setTaskState(FILES.taskState, id, { status: 'pending', current: null }, { completedFile: FILES.completed, abortedFile: FILES.aborted });
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx !== -1) {
        tasks[idx].suggested_fix = [
          'Recovered from an interrupted run — the repo already shows changes from a prior attempt (no green_test to verify automatically). Continue the work rather than starting over.',
          changedFiles.length ? `Changed files: ${changedFiles.join(', ')}` : '',
          logTail ? `Last log output:\n${logTail}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        writeTasks(tasks);
      }
      console.log(`[recovery] ${id}: repo changed, no green_test -> requeued with continuation context`);
      continue;
    }

    // 'pending' — no evidence of progress, or a dependency isn't done yet.
    // Just clear the in-flight marker so the scheduler picks it up normally.
    setTaskState(FILES.taskState, id, { status: 'pending', current: null }, { completedFile: FILES.completed, abortedFile: FILES.aborted });
    console.log(`[recovery] ${id}: ${reason} -> pending`);
  }
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

// Step 9: cap on session_context.md before rolling the older half out to a
// dated archive under .orchestrator/history/ — otherwise it grows unbounded
// across a long unattended run.
const SESSION_CONTEXT_CAP_BYTES = 256 * 1024;
function rolloverSessionContextIfNeeded() {
  let content;
  try {
    content = fs.readFileSync(FILES.sessionContext, 'utf8');
  } catch {
    return; // doesn't exist yet
  }
  const split = rolloverContent(content, SESSION_CONTEXT_CAP_BYTES);
  if (!split) return;
  try {
    const historyDir = path.join(getStateDir(), 'history');
    fs.mkdirSync(historyDir, { recursive: true });
    const archivePath = path.join(historyDir, `session_context-${new Date().toISOString().slice(0, 10)}.md`);
    fs.appendFileSync(archivePath, split.archived);
    fs.writeFileSync(FILES.sessionContext, split.kept);
  } catch {
    /* best-effort */
  }
}

// Feature 4 / Step 9: append a completion note (task id + changed files) to
// session_context.md so later tasks are told what earlier ones produced.
// `beforeFiles` is the dirty-tree snapshot taken right before this task
// started — diffing against it means only THIS task's own changes are
// listed, not every earlier task's leftovers still sitting in the tree.
async function appendSessionContext(taskId, cwd, beforeFiles = []) {
  const afterFiles = await gitChangedFiles(cwd);
  const block = formatSessionContextBlock(taskId, beforeFiles, afterFiles);
  try {
    fs.appendFileSync(FILES.sessionContext, block);
    rolloverSessionContextIfNeeded();
  } catch {
    /* best-effort */
  }
}

// Feature 6: when a task succeeds AFTER having failed (an error log exists),
// ask the LLM to distill the failure→fix into a lesson and append it to
// memory.json. The error log is then removed so the lesson isn't re-recorded.
async function recordLesson(task) {
  const logPath = path.join(errorLogsDir(), `${task.id}.txt`);
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
    const { menu: recipeMenuText } = recipeMenu();
    const lesson = await runRole('lessoner', {
      taskId: task.id,
      description: task.description,
      errorLog,
      recipeMenu: recipeMenuText,
    });

    // Graduate: a lesson matched to a real recipe folds into that recipe's
    // onFailureHint (permanent, always surfaced there) instead of competing
    // for a slot in the flat residual list. A hallucinated/unknown id falls
    // straight through to the normal path below.
    const matchedRecipe = lesson.matched_recipe && getRecipe(lesson.matched_recipe);
    if (matchedRecipe) {
      appendRecipeNote(matchedRecipe.id, lesson.lesson || lesson.fix || lesson.error_summary);
    } else {
      const keywords = extractKeywords(
        `${task.description} ${lesson.error_summary || ''} ${lesson.root_cause || ''}`
      );
      const entry = {
        id: `mem-${Date.now()}`,
        taskId: task.id,
        ...lesson,
        keywords,
        files: Array.isArray(task.files) ? task.files : [],
        created_at: new Date().toISOString(),
      };
      // Supersede: an existing entry about the same topic is replaced, not
      // just outranked — two lessons that flatly contradict each other is a
      // ranking problem ranking alone can't fix.
      const mem = readMemory().filter((e) => lessonTopicKey(e) !== lessonTopicKey(entry));
      mem.push(entry);
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

    // Feature 6 / Phase 8: lessons relevant to THIS task, not just recent ones.
    const lessons = lessonsBlock(task);

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
      `Never write to anything under .orchestrator/ — that directory is the`,
      `orchestrator's own state (tasks, recipes, memory) and is off-limits to workers.`,
      ...contextBlock,
      ...sessionBlock,
      ...lessons,
      ...fixBlock,
      '',
      `TASK: ${task.description}`,
    ].join('\n');

    // Feature 2: mark this task running (persisted, survives page refresh).
    addRunning(task.id, cwd);

    // Per-task stop: an AbortController that POST /api/tasks/:id/stop can
    // trigger to kill this task's subprocess mid-run.
    const controller = new AbortController();
    runningControllers.set(task.id, controller);

    // Step 6: hard ceiling on one attempt — a hung subprocess must not hold
    // its concurrency slot forever. Aborts the SAME controller a manual stop
    // uses; `timedOut` lets finish() report a distinct reason.
    const limits = readWorkerLimits();
    let timedOut = false;
    const attemptTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.maxAttemptMs);

    // Feature 5: tee everything to logs/{id}.log. Truncated each run so the log
    // reflects the latest attempt rather than accumulating across retries.
    const logPath = path.join(logsDir(), `${task.id}.log`);
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
      bumpOutputActivity(task.id); // Step 6: keep isStalled's evidence honest for a chatty task
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
      clearTimeout(attemptTimer);
      if (timedOut) {
        ok = false;
        failDetail = `timed out after ${limits.maxAttemptMs}ms`;
      }
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
          fs.writeFileSync(path.join(errorLogsDir(), `${task.id}.txt`), errText || '(no output captured)');
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
    addRunning(node.id, cwd);
    const controller = new AbortController();
    runningControllers.set(node.id, controller);

    const logPath = path.join(logsDir(), `${node.id}.log`);
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
      bumpOutputActivity(node.id); // Step 6: keep isStalled's evidence honest for a chatty tool node
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
          fs.writeFileSync(path.join(errorLogsDir(), `${node.id}.txt`), errText || '(no output captured)');
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
    errorText = fs.readFileSync(path.join(errorLogsDir(), `${node.id}.txt`), 'utf8');
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

// Phase 10: same detach/subscribe/resume pattern as the ordinary run loop
// (startRunLoop/handleRun) — the goal loop is just a different top-level
// driver over the same runManager, so it gets connection resilience,
// reattachment, and POST /api/run/stop for free.
function startGoalLoop() {
  if (runManager.active) return;
  runManager.active = true;
  runManager.stopRequested = false;
  runGoalLoop()
    .catch((e) => {
      broadcast({ type: 'error', message: `⛔ Goal loop crashed: ${e.message}` });
    })
    .finally(() => {
      runManager.active = false;
    });
}

async function handleGoalStart(res) {
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
  if (!fs.existsSync(FILES.master)) {
    sse(res, { type: 'error', message: '⛔ No MASTER_PROMPT.md — generate a plan first.' });
    sse(res, { type: 'done', message: 'done' });
    return;
  }
  startGoalLoop();
}

// POST /api/run/stop — the explicit stop that used to be implied by closing
// the SSE connection (Phase 2 and earlier). Cancels any pending auto-resume
// too, since a user-requested stop should not silently restart itself.
// Stops whichever driver (ordinary run or goal loop) is currently active.
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
async function runLoop({ skipEndOfRunExtras = false } = {}) {
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

  // Step 5: evidence-based recovery of any task still marked "in_progress"
  // from a previously crashed or force-closed run, instead of the old blind
  // wipe — see recoverInterruptedTasks / classifyInterrupted.
  await recoverInterruptedTasks(cwd);

  // Step 8: bound how many per-task artefacts one project accumulates across
  // an unattended run of many plans.
  pruneOldLogs(logsDir());
  pruneOldLogs(errorLogsDir());

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
  // Step 6: a task that hit maxAttempts or failed identically
  // identicalFailureLimit times in a row is "blocked" rather than aborted —
  // cascades through dependents exactly like aborted (core/taskState.js's
  // abortedIds() counts 'blocked' too) but is reported distinctly so a human
  // can tell "gave up after repeating itself" from "failed once".
  const markBlocked = (id, reason) => {
    abortedSet.add(id);
    setTaskState(FILES.taskState, id, { status: 'blocked' }, { completedFile: FILES.completed, abortedFile: FILES.aborted });
    broadcast({ type: 'task-aborted', id, message: `🚫 ${id} blocked — ${reason}` });
  };
  const workerLimits = readWorkerLimits();

  // Set when a provider rate/usage limit is hit. Stops NEW launches; tasks
  // already in flight are drained first, then the run ends with everything
  // untouched still pending.
  let haltedBy = null;

  // Step 6 watchdog: the scheduler loop below BLOCKS on
  // `Promise.race(inFlight.values())` while something is running, so a
  // check placed inline at the top of the loop body would only ever run
  // once something finishes — never while a single task hangs. A real
  // timer, independent of that await, is what actually catches a stall.
  // Checks every task in flight in THIS process (runningControllers) for a
  // stall or hard-ceiling breach and aborts it — the same controller a
  // manual stop uses. Still-alive tasks get their lease bumped so a future
  // second agent could tell a live task from an abandoned one.
  const watchdogIntervalMs = Math.max(1000, Math.min(workerLimits.stallMs / 4, 30000));
  const watchdogTimer = setInterval(() => {
    const now = Date.now();
    const liveState = loadTaskState();
    for (const [id, ctrl] of runningControllers) {
      const record = liveState[id];
      if (!record) continue;
      const { stalled, reason } = isStalled(record, now, workerLimits);
      if (stalled) {
        broadcast({ type: 'log', log: `⏱️ [${id}] ${reason} — aborting.\n` });
        ctrl.abort();
      } else if (record.current) {
        setTaskState(
          FILES.taskState,
          id,
          { current: { ...record.current, leaseUntil: now + workerLimits.stallMs } },
          { completedFile: FILES.completed, abortedFile: FILES.aborted }
        );
      }
    }
  }, watchdogIntervalMs);

  try {
    await runLoopScheduler();
  } finally {
    clearInterval(watchdogTimer);
  }

  async function runLoopScheduler() {
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
    if (pending.length === 0 && inFlight.size === 0 && isPlanComplete(allTasks, [...completed], [...abortedSet])) {
      const nAborted = allTasks.filter((t) => isAborted(t.id)).length;
      broadcast({
        type: 'done',
        planComplete: true,
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
      // Step 9: snapshot the dirty tree right before this task starts, so its
      // session_context.md entry can be scoped to only what IT changed.
      const beforeFiles = await gitChangedFiles(cwd);
      inFlight.set(
        t.id,
        (t.type === 'tool' ? runToolNode : runTask)(t, cwd, broadcast).then((r) => ({ id: t.id, task: t, beforeFiles, ...r }))
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
      // Step 6 repetition guard: hash this failure the same way the goal
      // loop hashes an audit issue (issueSignature), record it in
      // task_state.json's history, and stop retrying identically once
      // maxAttempts or identicalFailureLimit is hit — a "blocked" task
      // cascades to dependents exactly like "aborted" but is reported
      // distinctly.
      let errText = '';
      try {
        errText = fs.readFileSync(path.join(errorLogsDir(), `${done.id}.txt`), 'utf8');
      } catch {
        /* rate-limited/no-output failures skip the error log — see runTask finish() */
      }
      const priorAttempts = ((readTaskState(FILES.taskState) || {})[done.id] || {}).attempts || 0;
      setTaskState(FILES.taskState, done.id, { attempts: priorAttempts + 1 }, { completedFile: FILES.completed, abortedFile: FILES.aborted });
      const signature = errText ? issueSignature({ task: done.id, description: errText }) : null;
      const record = endAttempt(FILES.taskState, done.id, 'pending', { detail: errText.slice(0, 500), signature });

      if (shouldBlock(record, workerLimits)) {
        markBlocked(done.id, `gave up after ${record.attempts} attempt(s) — see task_state.json history for details.`);
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

      // Step 6: attempts remain under maxAttempts and the failure hasn't
      // repeated identically identicalFailureLimit times — requeue
      // automatically (task_state.json is already back to 'pending' from
      // endAttempt above) instead of giving up after one try. Only maxAttempts
      // / an identical-failure streak (handled above) or a cascaded dependency
      // failure ever produces a terminal aborted/blocked task now.
      broadcast({
        type: 'log',
        log: `⚠️ ${done.id} failed (attempt ${record.attempts}/${workerLimits.maxAttempts}) — retrying.\n`,
      });
      continue;
    }

    markTaskCompleted(done.id);
    broadcast({ type: 'task-complete', id: done.id, message: `✅ ${done.id} done.` });

    // Feature 4 / Step 9: record what this task changed for downstream tasks
    // to read — scoped to just its own changes via the pre-launch snapshot.
    await appendSessionContext(done.id, cwd, done.beforeFiles);
    // Feature 6: if this task had failed before (error log present), distill and
    // store the lesson learned, then clear the error log.
    await recordLesson(done.task);
  }
  }

  // P5: optional Auditor pass at the end of the pipeline (opt-in via
  // config.autoAudit). Skipped when a provider limit cut the run short — the
  // work is incomplete by definition, and the audit would only burn more of
  // the exhausted quota. Also skipped on an explicit stop, for the same
  // reason, and when the goal loop (Phase 10) is driving — it runs its own
  // audit every cycle and this would just duplicate it.
  if (!skipEndOfRunExtras && !stopped() && !haltedBy && getConfig().autoAudit) {
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

  // Phase 9: optional recipe-mining pass (opt-in via config.autoRecipeReview,
  // mirroring autoAudit). Purely informational — candidates are surfaced for
  // a human to review and POST /api/recipes/approve; nothing is ever
  // auto-promoted.
  if (!skipEndOfRunExtras && !stopped() && !haltedBy && getConfig().autoRecipeReview) {
    broadcast({ type: 'status', message: '🧩 Mining this run for recurring patterns…' });
    try {
      const candidates = await mineAndCurateRecipes(cwd);
      broadcast({
        type: 'recipe-candidates',
        candidates,
        message: candidates.length
          ? `🧩 Found ${candidates.length} recurring pattern(s) — review with POST /api/recipes/approve.`
          : '🧩 No recurring patterns found this run.',
      });
    } catch (e) {
      broadcast({ type: 'log', log: `[recipe-mining] failed: ${e.message}\n` });
    }
  }

  // Feature 2: run over — nothing should still show as running.
  clearRunning();
}

// ---------------------------------------------------------------------------
// Phase 10: the goal-based autonomous loop.
//
//   tasks clear -> audit -> healer distills each high-severity issue
//     -> requires_replan=false: seed affected_task.suggested_fix, requeue it
//     -> requires_replan=true:  write loop-N.md, planner replans additively
//     -> insert topologically-safely -> run -> repeat
//
// Capped at 5 cycles; an issue whose signature recurs after a heal attempt
// is escalated (not retried identically) so a ping-pong failure can't burn
// every remaining cycle making no progress.
// ---------------------------------------------------------------------------
const MAX_GOAL_CYCLES = 5;

// Un-terminals a task (drops it from completed/aborted) and seeds a
// suggested_fix, so the next runLoop pass picks it back up as pending and
// injects the fix into its prompt (the same fixBlock handleRetryTask
// already uses). Returns false if the id doesn't exist — a general/
// cross-cutting audit issue has no single task to requeue.
function seedTaskFix(taskId, fixSummary) {
  const tasks = readJson(FILES.tasks, []);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return false;
  if (fixSummary) tasks[idx].suggested_fix = fixSummary;
  writeTasks(tasks);
  writeJson(FILES.completed, readJson(FILES.completed, []).filter((id) => id !== taskId));
  writeJson(FILES.aborted, readJson(FILES.aborted, []).filter((id) => id !== taskId));
  return true;
}

// Mechanically gathers this cycle's brief (see graph/loopPrompt.js) and
// writes it to .orchestrator/loops/loop-N.md. `healedIssues` is
// [{ issue, heal }] — heal is the healer role's output for that issue.
function writeLoopPrompt(cycle, healedIssues) {
  const tasks = readJson(FILES.tasks, []);
  const completed = new Set(readJson(FILES.completed, []));
  const aborted = new Set(readJson(FILES.aborted, []));
  const taskInventory = tasks.map((t) => ({
    id: t.id,
    status: completed.has(t.id) ? 'DONE' : aborted.has(t.id) ? 'ABORTED' : 'PENDING',
    description: t.description || (t.tool ? `${t.tool}(${JSON.stringify(t.args || {})})` : '(no description)'),
  }));

  let master = '';
  try {
    master = fs.readFileSync(FILES.master, 'utf8');
  } catch {
    /* no master prompt */
  }
  const index = buildIndex(master);

  // Resolution chain: audit issue -> affected task -> source_section -> slice.
  const sectionNames = new Set();
  for (const { issue } of healedIssues) {
    const t = tasks.find((x) => x.id === issue.task);
    if (t && t.source_section) sectionNames.add(t.source_section);
  }
  const sections = [...sectionNames]
    .map((name) => ({ heading: name, text: resolveSection(index, name) }))
    .filter((s) => s.text);

  const text = assembleLoopPrompt({
    cycle,
    issues: healedIssues.map(({ issue, heal }) => ({
      ...issue,
      diagnosis: heal && heal.diagnosis,
      fix_summary: heal && heal.fix_summary,
    })),
    taskInventory,
    sections,
  });

  const dir = path.join(getStateDir(), 'loops');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  const file = path.join(dir, `loop-${cycle}.md`);
  fs.writeFileSync(file, text);
  return { path: file, text };
}

async function runGoalLoop() {
  const cwd = getConfig().targetDir || process.cwd();
  const stopped = () => runManager.stopRequested;
  let previousSignatures = new Set();
  const escalated = new Map(); // signature -> issue, for the final report

  for (let cycle = 1; cycle <= MAX_GOAL_CYCLES; cycle++) {
    if (stopped()) return;

    broadcast({ type: 'status', message: `🎯 Goal loop cycle ${cycle}/${MAX_GOAL_CYCLES}: running pending tasks…` });
    await runLoop({ skipEndOfRunExtras: true });
    if (stopped()) return;

    broadcast({ type: 'status', message: `🔎 Goal loop cycle ${cycle}: auditing…` });
    let audit;
    try {
      audit = await runAudit(cwd);
    } catch (e) {
      broadcast({ type: 'error', message: `⛔ Goal loop stopped — auditor failed: ${e.message}` });
      return;
    }
    broadcast({
      type: 'audit',
      cycle,
      result: audit,
      message: `🔎 Cycle ${cycle} audit: ${String(audit.verdict).toUpperCase()} — ${audit.summary}`,
    });

    if (audit.verdict === 'pass') {
      broadcast({ type: 'goal-complete', cycle, message: `✅ Goal reached after ${cycle} cycle(s) — audit passed.` });
      return;
    }

    const highIssues = audit.issues.filter((i) => i.severity === 'high');
    const currentSignatures = new Set(highIssues.map(issueSignature));

    // Oscillation guard: a signature that also showed up last cycle survived
    // a heal attempt unchanged — retrying it identically would just burn the
    // remaining cycles chasing the same ping-pong. Escalate instead.
    const toHeal = [];
    for (const issue of highIssues) {
      const sig = issueSignature(issue);
      if (previousSignatures.has(sig)) {
        escalated.set(sig, issue);
        broadcast({
          type: 'status',
          message: `⚠️ Issue recurred after a heal attempt — escalating instead of retrying: ${issue.description}`,
        });
      } else {
        toHeal.push(issue);
      }
    }

    if (!toHeal.length) {
      broadcast({
        type: 'goal-capped',
        cycle,
        escalated: [...escalated.values()],
        message: `⛔ Every remaining issue has already been escalated — stopping at cycle ${cycle}.`,
      });
      return;
    }

    const healedIssues = []; // needs a replan
    const requeued = []; // seeded + requeued directly
    for (const issue of toHeal) {
      if (stopped()) return;
      let heal;
      try {
        heal = await runRole('healer', {
          taskId: issue.task,
          description: issue.description,
          errorLog: issue.suggested_fix || issue.description,
        });
      } catch (e) {
        broadcast({ type: 'log', log: `[goal-loop] healer failed for "${issue.description}": ${e.message}\n` });
        continue;
      }
      if (!heal.requires_replan && seedTaskFix(heal.affected_task || issue.task, heal.fix_summary)) {
        requeued.push(heal.affected_task || issue.task);
      } else {
        // Either the healer asked for a replan, or there was no concrete
        // task to requeue (a general/cross-cutting issue) — either way this
        // needs new work, not just a retry.
        healedIssues.push({ issue, heal });
      }
    }

    if (requeued.length) {
      broadcast({
        type: 'status',
        message: `🩹 Requeued ${requeued.length} task(s) with a suggested fix: ${requeued.join(', ')}`,
      });
    }

    if (healedIssues.length) {
      const { text: loopText } = writeLoopPrompt(cycle, healedIssues);
      broadcast({ type: 'status', message: `📝 Wrote the cycle ${cycle} replan brief — extending the plan…` });
      const existingIds = readJson(FILES.tasks, []).map((t) => t.id);
      const { menu, fallback } = workerModelMenu();
      let newTasks = [];
      try {
        newTasks = await runRole('planner', { mode: 'replan', loopPrompt: loopText, menu, fallback, existingIds, cwd });
      } catch (e) {
        broadcast({ type: 'log', log: `[goal-loop] replan failed: ${e.message}\n` });
      }
      // Backstop (belt-and-suspenders on top of planner.normalize's own
      // filter): never let a replanned id collide with one that already
      // exists, completed or not.
      const additive = newTasks.filter((t) => !existingIds.includes(t.id));
      if (additive.length) {
        try {
          writeTasks([...readJson(FILES.tasks, []), ...additive]);
          broadcast({ type: 'status', message: `➕ Replan added ${additive.length} new task(s).` });
        } catch (e) {
          broadcast({ type: 'log', log: `[goal-loop] failed to insert replanned tasks: ${e.message}\n` });
        }
      }
    }

    if (!requeued.length && !healedIssues.length) {
      broadcast({
        type: 'goal-capped',
        cycle,
        escalated: [...escalated.values()],
        message: `⛔ No actionable fix could be produced this cycle — stopping at cycle ${cycle}.`,
      });
      return;
    }

    previousSignatures = currentSignatures;
  }

  // Cap reached without a passing audit.
  const finalAudit = await runAudit(cwd).catch(() => null);
  broadcast({
    type: 'goal-capped',
    cycle: MAX_GOAL_CYCLES,
    escalated: [...escalated.values()],
    result: finalAudit,
    message:
      `⛔ Reached the ${MAX_GOAL_CYCLES}-cycle cap without a clean audit. ${escalated.size} issue(s) could not be ` +
      'resolved automatically — consider clarifying or narrowing MASTER_PROMPT.md.',
  });
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
    if (req.method === 'POST' && pathname === '/api/memory/compact') return await handleCompactMemory(req, res);
    if (req.method === 'POST' && pathname === '/api/recipes/mine') return await handleMineRecipes(res);
    if (req.method === 'POST' && pathname === '/api/recipes/approve') return await handleApproveRecipe(req, res);
    if (req.method === 'GET' && pathname === '/api/recipes') return handleGetRecipes(res);
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
    if (req.method === 'GET' && pathname === '/api/goal/start') return await handleGoalStart(res);
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, async () => {
  // runningControllers is in-memory, so by definition nothing is in flight on
  // a fresh boot. Step 5: anything still "in_progress" from a backend that
  // was killed or crashed mid-run is recovered with evidence (git state +
  // dependency completion), not blindly wiped — see recoverInterruptedTasks.
  const stale = readRunning().map((r) => r.taskId);
  if (stale.length) {
    const cwd = getConfig().targetDir || process.cwd();
    await recoverInterruptedTasks(cwd);
    console.log(`Recovered ${stale.length} interrupted task(s) from a previous run: ${stale.join(', ')}`);
  }
  console.log(`claude-orchestrator backend listening on http://localhost:${PORT}`);
  console.log(`Using claude binary: ${CLAUDE_BIN}`);

  // Phase 4: a pause.json surviving a backend restart must still auto-resume
  // — otherwise a crash/redeploy during a provider-limit pause waits forever.
  resumeStalePauseOnBoot();
});
