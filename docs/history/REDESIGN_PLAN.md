# Orchestrator Redesign — Implementation Plan

Source of truth for the 10-phase restructure planned 2026-08-08. Companion to
`MODEL_AGNOSTIC_PLAN.md` (the SoT for the previous provider-agnostic refactor).

This document is written to be executed by a session with **no prior conversation
context**. Everything needed — findings, decisions, rationale, file references — is
here. Read "Established findings" and "Locked decisions" before starting any phase.

---

## How to use this document

- Phases are **ordered by dependency**. Do not reorder without reading the rationale
  notes; several orderings exist specifically to avoid editing the same code twice.
- Each phase lists **Goal → Changes → Verification → Done when**. A phase is not
  finished until its "Done when" holds.
- When the user says **"start next phase"**: commit the finished phase, then begin the
  next one.

## Working conventions

- **Commits:** one commit per phase, on a branch — never straight to `main`.
- **No `Co-Authored-By: Claude` trailer** in commit messages. This is a standing user
  preference and overrides the default convention.
- **Verification rig:** an isolated copy of the repo with a fake `claude` on `PATH` and
  `PORT=3999`, which exercises the run loop without touching live state. Use it for any
  change to the scheduler or execution path.
- **Do not** run the orchestrator against the live target project to test a change.

## Environment facts

- Orchestrator repo: `/media/sf_github/orchestrator` — git initialised, remote
  `https://github.com/keith2929/orchestrator.git`.
- Active target project: `/media/sf_github/valuation-calc` (from `config.json.targetDir`)
  — a healthy git repo with history. Autonomous changes there are recoverable.
- Runs on a vboxsf shared mount; npm installs need `--no-bin-links`.

---

## Established findings

All verified against the code on 2026-08-08. These justify the phases; re-verify a
citation before relying on it if the code has moved.

### The dependency bug (motivating defect)

`DEFAULT_MODE = 'sequential'` (`server.js:72`), and sequential mode **ignores
`depends_on` entirely** — see the comment at `server.js:1486-1490`: *"We deliberately
IGNORE the depends_on graph for scheduling — insertion order is the intended ordering."*
Execution order is purely `tasks.json` array position.

Observed symptom: a task declaring "Stage 5 complete" ran while a task belonging to
stage 5 was still in flight. The moment array order and `depends_on` diverge — via a UI
edit, a re-split, or an LLM emitting a forking graph out of order — a downstream task
fires before its prerequisites, silently.

Concurrent mode is **already correct**: its `depsMet` check (`server.js:1710`) walks the
real graph against a freshly-read completed set each iteration. The bug is sequential
mode only.

Contributing: `handlePutTask` (`server.js:808-820`) lets the UI edit `depends_on` with no
cycle check, no existence check, no re-sort. Neither `handlePlan` nor `handleSplit`
validates that the emitted array order is topologically consistent with its own edges.

### Runs do not survive a dropped connection

`clientGone` is checked in 10+ places across both schedulers (`server.js:895-1800`) and
**stops** the run, not pauses it (`if (clientGone) break;` at 1515, 1545, 1737, 1758).
The run's lifetime is owned by one HTTP request, so a closed tab or slept laptop kills it.

### Rate-limit pause requires a human

`detectRateLimit` (`shared.js:92-97`) captures only a reason **string** — no reset time.
The pause behaviour (`server.js:1551-1558`) is correct in spirit (leave tasks pending,
don't burn the queue) but ends with "press Run again once the limit resets".
`agent/executor.js:93-98` (`retryAfterMs`) already parses provider retry hints for
per-request 429s; the same technique applies at plan level.

### State is global, not per-project

`FILES` (`server.js:53-65`) is a static object of paths in the orchestrator directory:
`MASTER_PROMPT.md`, `tasks.json`, `completed.json`, `aborted.json`, `running.json`,
`mode.json`, `session_context.md`, `memory.json`, `planner_chat.json`.

Switching projects means manually archiving all of them. The `.bak` files in the tree
(`memory.valuation-creator.2026-07-28.bak.json`, `session_context.valuation-creator.*`)
are exactly that, done by hand. Forgetting means silent cross-project bleed into prompts.

Current volumes: `memory.json` holds 57 lessons spanning 10 days;
`session_context.md` is 184KB / 1322 lines.

### Memory is inlined blindly

`lessonsBlock()` (`server.js:205-213`) inlines the **5 most recent** lessons into every
task prompt *and* every splitter prompt, with no relevance filter — a CSS task receives
SEC EDGAR parsing lessons. 57 stored, 5 ever read, no superseding.

`handleSplit` sends `JSON.stringify(tasks, null, 2)` of the **entire** plan
(`server.js:441`) on every call — O(whole plan) input tokens to split one task.

### No token telemetry

`performance.json` records `{timestamp, role, client, model, durationMs, success,
fallback}` — no token counts. `performance.js:4` states it is write-only by design.
**Decision: not adding token tracking.** `durationMs` is a rough directional proxy.

### `.orchestrator/` will poison the audit if not ignored

`gitChangedFiles()` (`server.js:1098-1114`) runs `git status --porcelain` in the target
dir. Its output feeds `appendSessionContext` (`server.js:1118`) and the auditor's "FILES
CHANGED IN WORKING TREE" block (`server.js:761`). valuation-calc's `.gitignore` does
**not** cover `.orchestrator/`, and `tasks.json`/`completed.json` rewrite on every task
completion — so every task would report orchestrator state churn as its own changed
files. Phase 1 must fix this.

### Text roles cannot read files

`planner`, `splitter`, `healer`, `lessoner`, `auditor` (`TEXT_ROLES`, `server.js:555`) go
through `resolveRole().complete()` — one-shot text, no tools. **A pointer to a file is
useless to them**; they only see what is inlined in the prompt. This is why Phase 10
needs a section index rather than a file reference.

### The Claude CLI is opaque

CLI-assigned tasks run via `execution/native.js` as a bare subprocess with
`--permission-mode bypassPermissions` (`clients/claude-cli.js:28-30`). It is already an
agent; the orchestrator cannot see or plan its internal tool calls. Any tool-call-graph
or `call_recipe` mechanism reaches **chat clients only** (`agent/executor.js`).

Also note `run_bash` is explicitly **not sandboxed** (`agent/tools/runBash.js:2-6`).

### Duplication inventory (cleanup targets)

- `markAborted` — identical closure defined twice (`server.js:1497-1505`, `1647-1655`).
- "push id to completed.json if absent" — repeated 3+ times (1570-1574, ~1784).
- LLM JSON extraction (`match(/\[...\]/)` → `JSON.parse` → error response) — near-identical
  in `handlePlan` (372-389), `handleSplit` (457-469), `runAudit` (766-768), `recordLesson`
  (1165-1167), `analyzeFiles` (1245-1252).
- Task normalisation block — duplicated `handlePlan` (391-397) / `handleSplit` (474-484).
- "Respond with ONE raw JSON… no markdown fences" — 5 near-verbatim copies.
- `analyzer` is not a configured role; `resolveRole` silently falls it back to `planner`
  (`roles.js:71`), so changing the planner's model invisibly changes the file analyser.

### Recurring work that should be recipes

`task-4.b`, `task-11.b`, `task-17.a.ii` hand-author a near-identical "repo-wide green-up":
run `pnpm -r test`, `pnpm -r build`, `eslint .`, plus the same troubleshooting paragraph
about stale dist copies / lockfile drift / `.goutputstream` artifacts and re-running
`sync-workspace-dists.sh`. Each is a full **opus** task.

valuation-calc's root `package.json` already defines `build`, `test`, `lint` — the
"recipe" exists in the project already and does not need authoring.

---

## Locked design decisions

Do not re-litigate these; they were decided deliberately.

| Decision | Rationale |
|---|---|
| **Hybrid graph**, not fully-literal tool calls | A splitter cannot pre-author `write_file` content for a repo it has not read. Mechanical steps become zero-LLM tool nodes; code authoring stays a prose task node. |
| **CLI nodes stay prose-based** | The CLI is opaque (see findings). Tool-call graphs apply to mechanical steps and chat-model nodes. |
| **Deterministic recipes only** | Agentic recipes, the worker-callable `call_recipe` tool, and CLI access via `--mcp-config` are deferred. |
| **Built-in recipes are generic only** | Project-specific recipes are discovered at runtime (Phase 9), not hand-authored. |
| **Recipe promotion is human-approved** | A bad generalisation baked into a reused recipe applies everywhere at once — worse than the duplication it replaces. |
| **Worker fallback is global config**, not planner-specified | Availability is operational; the planner has no signal about what is rate-limited right now. |
| **No cost ceiling on the goal loop** | The user accepts its token cost. Robustness is the priority, not spend. |
| **No token telemetry** | Explicitly declined. The redesign aims to reduce usage; measurement is not being built. |
| **State lives in `<targetDir>/.orchestrator/`** | Keyed by the project's own directory — no slugging, no collisions, travels with the project. |

### Memory model (from the memoryplugin.com taxonomy)

The five types map onto the orchestrator as follows. This framing drives Phases 8–9.

| Type | Instance | Treatment |
|---|---|---|
| Working | in-flight task/run state | fine as-is |
| Episodic | `session_context.md` | pointer-based; consolidation deferred |
| Semantic | `memory.json` lessons | Phase 8: relevance-rank, supersede, fold into recipes |
| Procedural | `config.json` roles, recipes | Phases 3, 7 — encode once, never re-derive |
| Document | `context/`, `MASTER_PROMPT.md` | Phase 10: index + slice, don't bulk-load |

Key principle carried throughout: **lessons should graduate into recipes**. A lesson
attached to a recipe's `onFailureHint` is permanent, always-present for that failure
mode, and costs nothing to surface — strictly better than competing for a top-5 slot in a
flat list. `memory.json` becomes a staging area that trends small, not a growing store.

---

## Phase 1 — Project-scoped state + migration

**Goal:** each project owns its own state; no cross-project bleed.

**Changes**
- Convert `FILES` (`server.js:53-65`) from a static object into a resolver —
  `getStateDir()` derived from `config.targetDir` → `<targetDir>/.orchestrator/`.
- Move: `MASTER_PROMPT.md`, `tasks.json`, `completed.json`, `aborted.json`,
  `running.json`, `mode.json`, `session_context.md`, `memory.json`, `planner_chat.json`.
- **Migrate existing state** into valuation-calc's directory — 57 lessons and 184KB of
  session context represent 10 days of accumulated learning. Do not orphan it.
- **Auto-add `.orchestrator/` to the target repo's `.gitignore`** on first use, **and**
  filter it inside `gitChangedFiles` (`server.js:1098`) as defense in depth. Without
  both, every task reports orchestrator state churn as its own changed files and the
  auditor sees it as build output.
- Remove now-stale state entries from the orchestrator's own `.gitignore`.

**Rationale for ordering:** mechanical, and touches every `readJson`/`writeJson` call
site *including the scheduler's*. Doing it after Phase 2 would mean editing that code
twice.

**Verification:** point `targetDir` at a scratch directory; confirm a fresh
`.orchestrator/` is created, gitignored, and that `git status` in the target stays clean
during a run.

**Done when:** two different `targetDir` values maintain fully independent state, and
`gitChangedFiles` never reports `.orchestrator/` paths.

---

## Phase 2 — Scheduler fix + unification

**Goal:** execution order always respects `depends_on`. One scheduler, not two.

**Changes**
- Collapse sequential + concurrent into **one** scheduler built on concurrent's correct
  `depsMet` logic (`server.js:1710`). `maxConcurrency=1` *is* correct sequential
  execution — same guarantee, driven by real edges instead of array position.
- Enforce **topological array order at every write path**: `handlePlan`, `handleSplit`,
  `handlePutTask`, `handleRetryTask`. Stored order and dependency order must never
  diverge. Also validate: referenced ids exist, no cycles.
- **Gate `analyzeFiles` behind `maxConc > 1`.** It currently only runs in the concurrent
  branch (`server.js:1632-1635`); without this gate, unifying modes would add a new LLM
  call to every former-sequential run. Parallelism is meaningless at concurrency 1.
- Dedup `markAborted` and the completed-bookkeeping repetitions (~150 lines).

**Frontend:** `renderMode()` (`main.js:729`) is the sequential/concurrent toggle.
Unification removes what it switches between — convert it to a **concurrency number**
(1 = today's sequential behaviour).

**Verification — required regression test:** build a graph where array order and
`depends_on` **disagree**; assert execution follows `depends_on`. This is exactly the
motivating defect; without the test it can silently regress. Use the testing rig.

**Done when:** that test passes, both old mode branches are gone, and a former-sequential
run makes no additional LLM calls versus before.

---

## Phase 3 — Role registry + output schemas

**Goal:** each role's behaviour and output contract defined once, in one file.

**Changes**
- New `roles/` directory, one module per role: `planner`, `splitter`, `healer`,
  `lessoner`, `auditor`, `analyzer`. Each exports:
  `{ id, purpose, outputShape, schema, buildPrompt(ctx), normalize(parsed, ctx) }`.
  `outputShape` is `'array' | 'object' | 'text'` — healer currently returns free text, so
  not everything is JSON.
- `roles/shared.js`: the JSON-instruction boilerplate, `extractJson(text, shape)`, and
  `MODEL_CHOICE_RULES` (moved from `server.js:297`).
- Generic `runRole(id, ctx)` replaces the 5 duplicated build→call→parse→normalize blocks.
- `roles/index.js` registers modules exactly like `agent/tools/index.js` does.
- Make `analyzer` a **first-class `config.json` role** instead of silently inheriting the
  planner's model via `roles.js:71`.

**Keep `roles.js` separate.** It answers "which model backs this role, with what
fallback" (routing). The new `roles/` directory answers "what is this role's job"
(behaviour). Two concerns that merely share a name.

**Output schemas**
```
planner   [{ id, description, assigned_model, effort, depends_on, source_section }]
splitter  (Phase 6 adds the type:"task"|"tool" discriminated union)
auditor   { verdict, summary, issues[{ severity, task, description, suggested_fix? }] }
          verdict derived mechanically: pass iff zero severity:"high"
healer    { diagnosis, fix_summary, affected_task?, requires_replan }
lessoner  { error_summary, root_cause, fix, lesson, matched_recipe? }
analyzer  [{ id, files[] }]
```

`source_section` names the `MASTER_PROMPT.md` heading a task derives from — captured once
at plan time, used every cycle by Phase 10 to resolve issue → task → relevant slice.

`requires_replan` lets one healer role serve both jobs (single-task error fix vs. audit
finding) with a machine-checkable branch instead of the caller guessing.

`planner.buildPrompt` branches on `ctx.mode === 'replan'` (reads the loop prompt instead
of the master prompt); `normalize()` enforces additivity in that mode.

**Rationale for ordering:** pulled earlier than originally planned because `runRole` and
`extractJson` are used by every later phase.

**Done when:** no handler in `server.js` builds a role prompt or parses role output
inline; `analyzer` has its own config entry.

---

## Phase 4 — Run resilience

**Goal:** a run survives disconnection and rate limits without a human.

**Changes**
- **Detach the run loop from the HTTP request.** Make it a server-owned process; an SSE
  connection merely *subscribes* to live output and may reconnect. Removes the
  `clientGone`-stops-the-run behaviour throughout.
- **Auto-resume after a provider limit.** Persist pause state; parse a reset ETA from the
  provider message where present (reuse the `retryAfterMs` technique,
  `agent/executor.js:93-98`); otherwise a conservative backoff. The server re-triggers
  the loop — no click required.
- **Global `workerFallback` chain** in `config.json`, consulted by `execution/index.js`
  when a worker's primary `assigned_model` fails with a rate/session-limit signature.
  Reuse `roles.js`'s existing `buildAttempts`/`runWithFallback`.

**Done when:** killing the browser mid-run leaves the run going; a simulated rate limit
pauses and self-resumes; a worker whose primary model is unavailable falls through.

---

## Phase 5 — Persistent cache

**Goal:** work is not redone across tasks.

**Changes**
- `<targetDir>/.orchestrator/cache/`, content-keyed (`edgar/<cik>-<tag>.json`,
  `ticker-universe.json`, …).
- New tools `read_cache(key)` / `write_cache(key, value, ttl?)` in `agent/tools/`.
- Pointer-based: a cache hit is *referenced*, never force-inlined into a prompt.
- TTL checked on read — near-permanent for filed EDGAR data, expiring for ticker universe.

**Done when:** a repeated fetch across two tasks hits the cache and skips the network.

---

## Phase 6 — Tool-call dependency graph

**Goal:** mechanical steps execute with zero LLM involvement.

**Changes**
- Optional `type` on nodes, default `"task"` — fully backward compatible.
  ```
  { id, type:"tool", depends_on[], onFailure?:'spawn-task'|'gate'|'abort',
    ...either { tool, args } or { recipe, params } }
  ```
- Add the discriminated union to the splitter's Phase 3 schema.
- `runToolNode` path in the unified scheduler: instantiate `createToolRunner`
  (`agent/toolRunner.js:34` — already exists, currently only reachable from inside the
  chat-agent loop) and call `runner.run(tool, args)` directly. Streams through the same
  SSE/log/error-capture plumbing as `runTask`.
- Static path-conflict detection for tool nodes (their `args` are known at plan time)
  replaces `analyzeFiles` guessing for those; keep `analyzeFiles` only as fallback for
  legacy task nodes with sparse `depends_on`.
- **Skip** context/session/lessons block-building for tool nodes — no prompt to inject into.
- Route failed tool nodes into the existing error-log / self-healing / `recordLesson`
  pipeline, triggered by exit code rather than an LLM's self-report.
- Splitter prompt: factor mechanical tails (install/build/test/lint/git) out of task prose
  into tool nodes. Validate emitted tool names against the registry.

**Frontend:** `renderTable()` (`main.js:321`) renders every row as a task with model
dropdown, effort and healer-retry. Tool nodes have none of those — render them distinctly
or they appear as broken rows.

**Done when:** a mixed hand-authored graph executes, tool nodes make zero LLM calls, and
a failing tool node produces a usable error log.

---

## Phase 7 — Built-in deterministic recipes

**Goal:** encode recurring mechanical sequences once, sourced from the project itself.

**Changes**
- `graph/recipes/*.js` registry mirroring `agent/tools/index.js`'s convention:
  `{ id, description, params, expand(params, profile), onFailureHint?, exclusive? }`.
- **Project-profile detector** (one-time, cached, zero LLM). Sourcing priority:
  `package.json` scripts → monorepo config (`turbo.json`/`nx.json`) → CI workflow files →
  hardcoded fallback. Verified to work for valuation-calc, whose `package.json` already
  defines `build`/`test`/`lint`.
  ```js
  expand(params, profile) {
    return ['test','build','lint']
      .filter(s => profile.scripts.includes(s))
      .map(s => ({ tool:'run_bash', args:{ command:`${profile.pkgManager} run ${s}` }}));
  }
  ```
- **Ship generic recipes only:** `repo-green-up`, `check-env-var` (a gate). Project-specific
  ones are mined at runtime in Phase 9.
- `onFailure:"spawn-task"` generates a fix task seeded with `onFailureHint` + captured
  stderr, rewired through Phase 2's topologically-safe insertion. **Auto-inserted ids need
  a uniqueness suffix** — `${node.id}.fix` collides if the same node fails twice.
- **Barrier semantics:** recipes touching the whole workspace (`repo-green-up` runs
  `pnpm -r build`) must set `exclusive: true`. Static path-conflict detection only knows
  the paths in a node's `args`, so it would otherwise schedule a green-up concurrently
  with a task editing source, producing flaky failures that look like real bugs. The
  scheduler drains in-flight work before an exclusive node.

**Done when:** `repo-green-up` runs on valuation-calc using its own npm scripts, with no
pnpm assumption in the recipe, and never overlaps another node.

---

## Phase 8 — Memory efficiency

**Goal:** stop inlining irrelevant context into every prompt.

**Changes**
- Rewrite `lessonsBlock()` (`server.js:205-213`) to **rank/filter by relevance** to the
  current node instead of blind last-5-by-recency. Tag lessons at write time in
  `recordLesson` with keywords / file footprint from the task description.
- Add **superseding**: dedupe by topic/file key, newest wins. Ranking alone does not fix
  two lessons flatly contradicting each other.
- `handleSplit` sends **only split candidates** (missing `green_test`, or effort
  `high`/`ultracode`) rather than the whole array (`server.js:441`). Passes the rest
  through untouched.
- **Lessons fold into recipes:** the lessoner's `matched_recipe` routes a distilled lesson
  into that recipe's `onFailureHint` instead of the flat list. Unmatched lessons remain in
  a small project-local residual list acting as a **staging area** for Phase 9's miner.

**Done when:** an unrelated task's prompt contains no lessons; `memory.json` shrinks as
lessons graduate.

---

## Phase 9 — Post-mortem recipe mining

**Goal:** the registry grows from observed repetition instead of hand-authoring.

**Changes**
- **Detection is pure code, zero LLM.** Normalise (strip variable tokens → placeholders)
  and cluster recurring patterns across: task descriptions, `error_logs/*.txt`,
  `memory.json`'s residual list, and — chat workers only — the structured
  `🔧 tool(args) → result` lines `formatLog` already writes (`agent/toolRunner.js:22`) to
  `logs/task-*.log`. CLI tasks have no tool trace, so those degrade to
  description-clustering (which is how the green-up duplication was found by hand).
- **Cross-check clusters against the project's own `package.json`/CI conventions** before
  proposing a bespoke recipe. If it matches, the promoted recipe delegates to the
  project's scripts rather than freezing observed strings.
- New `recipeCurator` role — `{ id, description, params?, steps[], onFailureHint? }`. One
  small bounded LLM call **per surfaced candidate**, not continuous mining.
  `steps` must stay declarative **data**; the registry turns it into `expand()`
  mechanically. Never let a model author an executable function body into the registry.
- **Human-approved** before landing. Opt-in end-of-run pass (`config.autoRecipeReview`)
  mirroring `autoAudit`.
- Scoped to one project's plan. Cross-project mining needs a plan archive that does not
  exist yet.

**Done when:** running the miner over the existing valuation-calc history surfaces the
green-up cluster as a candidate.

---

## Phase 10 — Goal-based autonomous loop

**Goal:** the plan drives itself to the `MASTER_PROMPT.md` goal until the audit clears.

**Changes**

*Completion detection*
- `isPlanComplete(tasks, completed, aborted)` fires after **any** task reaches a terminal
  state (unified scheduler **and** `handleRunOne`) — not only at end-of-run.

*Audit*
- Pass `green_test` into `runAudit`'s task listing (`server.js:728-731`) — it is collected
  today but never sent to the auditor.
- Reframe: a task that met its own `green_test` is settled, do not re-litigate. Findings
  focus on real gaps vs. the master prompt and integration issues no single `green_test`
  would catch.
- Verdict is **mechanical**: pass iff zero `severity:"high"` issues. Medium/low are
  informational and never block. A stable bar converges; holistic LLM judgement does not.

*Master-prompt section index*
- Build a deterministic index over `MASTER_PROMPT.md` (markdown headings → line ranges →
  status). The document is already structured as staged headings (it is
  `LIVE_GUI_PLAN.md` copied verbatim, e.g. `## Stage 3 — … ✅ CLEAR`), so heading parsing
  suffices — no vectors, no LLM.
- **Why this matters:** text roles cannot read files. A pointer to `MASTER_PROMPT.md` is
  useless to the planner. The index is what makes inlining a relevant *slice* possible
  instead of choosing between all ~13KB or nothing.
- Resolution chain: audit issue → affected task → `source_section` → slice.
- **The final full audit still sees the whole master prompt** — whole-goal coverage is its
  job. Slicing applies to the per-cycle replan brief only.

*Loop prompt*
- Each cycle writes `.orchestrator/loops/loop-N.md`, assembled **mechanically (zero LLM)**
  from: that cycle's high-severity issues, the healer's `fix_summary` fields, an inventory
  of existing task ids with one-line statuses, and the inlined master-prompt sections the
  failing tasks derive from.
- Planner runs with `ctx.mode='replan'` against this narrow brief, so **additivity comes
  from prompt scope** rather than being fought for afterward.
- Including the source section preserves the *why* — a brief that only says "DDM shows
  NaN" can be satisfied by hiding the view.
- **Backstop validation regardless:** completed ids are immutable, new work gets fresh
  non-colliding ids, no completed task may re-run. A prompt is a suggestion to an LLM, not
  a guarantee, and silently re-running finished work is expensive.

*Cycle*
```
tasks clear → audit → healer distills each issue
  → requires_replan=false: seed affected_task.suggested_fix, requeue it
  → requires_replan=true:  write loop-N.md, planner replans additively
  → insert topologically-safely → run → repeat
```

*Oscillation guard*
- Hash each issue signature per cycle. If a signature recurs after a heal attempt, stop
  retrying it identically and escalate it into the final report. Ping-pong (fix A breaks
  B, fix B breaks A) is the realistic failure mode and would otherwise burn all 5 cycles
  making no progress while looking like prompt vagueness.

*Termination*
- Cap at **5 cycles**; counter resets on a new master prompt/plan.
- On cap without a pass: stop and surface the latest findings with a prompt to clarify or
  narrow `MASTER_PROMPT.md`.

**Frontend:** `renderAudit()` (`main.js:812`) renders a one-shot audit — extend to show
cycle number, per-cycle findings, and the escalated-signature list.

**Done when:** a deliberately-incomplete plan converges to a clean audit unattended, and
an unsatisfiable one stops at 5 cycles with a clear explanation.

---

## Explicitly deferred

Do **not** build these as part of the ten phases.

- **Agentic recipes** — a recipe running as a nested `runAgent()` with its own narrow
  prompt, restricted tool subset and tight limits.
- **`call_recipe` as a worker-callable tool** — letting a chat worker spend one tool call
  instead of freehanding a known sequence. Needs a recursion guard when built.
- **Recipes reachable from the Claude CLI** via `--mcp-config` (`claudeCliArgs`,
  `clients/claude-cli.js:28-30`) — a local MCP server exposing the registry.
- **Automatic (non-approved) recipe promotion.**
- **Cross-project recipe mining** — needs a plan archive.
- **Token telemetry** and `performance.json` read-back for adaptive routing.
- **`session_context.md` consolidation** — episodic → semantic compaction.
- **Cost ceiling on the goal loop.**

## Housekeeping

Low priority, safe any time: `.goutputstream-8IM6R3` is a GNOME save-lock artifact and can
be deleted. The `.bak` files predate git and may be the only copy of prior state — confirm
with the user before removing.
