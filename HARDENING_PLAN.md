# Orchestrator hardening — execution plan

> **Status: active. This is the source of truth for current work.**
> Written 2026-08-12, after the 10-phase redesign merged to `main`.
> `REDESIGN_PLAN.md` and `MODEL_AGNOSTIC_PLAN.md` are **history** — read them for
> background on why the architecture looks the way it does, not for what to do next.
>
> **Starting a session:** find the first unchecked box below, read that step, do only that
> step. Tick the box in the same commit.

## Progress

- [x] Step 1 — Atomic JSON writes
- [x] Step 2 — Extract pure logic into `core/`
- [ ] Step 3 — Tests for the already-pure modules
- [ ] Step 4 — Durable task state
- [ ] Step 5 — Crash recovery
- [ ] Step 6 — Worker timeout, stall and repetition guards
- [ ] Step 7 — Resurrect `memory.json`
- [ ] Step 8 — Project-scope `logs/` and `error_logs/`
- [ ] Step 9 — Bound worker context
- [ ] Step 10 — Workers cannot mutate the knowledge base
- [ ] Step 11 — Recipes as versioned files
- [ ] Step 12 — Lesson compaction into recipes
- [ ] Step 13 — Smoke tests
- [ ] Step 14 — Hygiene and local-only lockdown
- [ ] Step 15 — Documentation

## Goal

Make the orchestrator survive ~5 hours unattended (one Claude session): leave it running,
come back after the session limit resets, and find it made progress rather than needing
repair. The **task** — not the Claude process, session, or agent — is the durable unit of
work.

## How to execute this document

- **Work one step at a time, in order.** Each step is one branch + one commit, named in the
  step. Push the branch before starting the next step.
- **Do not skip ahead.** Later steps assume earlier ones landed.
- Every step lists **Files**, **Do**, **Do NOT**, **Tests**, and **Done when**. Do not
  expand beyond what **Do** says. If something looks broken but is out of scope, note it in
  the commit body; do not fix it.
- `npm test` must pass before every commit, from step 2 onward.
- Match the surrounding code: ESM, `node:` imports, no new dependencies, comments that
  explain *why* (this codebase's comments are unusually good — keep that bar).
- Commit messages: `Step N: <short summary>`. No `Co-Authored-By` trailer.
- Paths are relative to `/media/sf_github/orchestrator` unless stated otherwise.

## Reliability invariants (acceptance criteria)

Each is tested by the step named beside it.

1. A task survives an orchestrator/session/worker restart. — steps 4, 5
2. Completed work is never silently forgotten. — steps 1, 4
3. An incomplete task cannot stay `in_progress` forever undetected. — step 6
4. A failing worker cannot burn a session in repetitive retries. — step 6
5. State is scoped to the correct target project. — step 8
6. Workers consume the knowledge base; they never mutate it. — step 10
7. Recipes are auditable and versioned. — step 11
8. Context handed to a worker is bounded and task-specific. — step 9
9. Humans intervene for real decisions and session limits, not routine recovery. — step 13

---

# Step 1 — Atomic JSON writes

**Branch:** `step-1-atomic-writes`

**Why:** `writeJson` ([server.js:182](server.js:182)) is `writeFileSync` — truncate, then
write. Every reader is `readJson(file, fallback)`, which silently returns the fallback on a
parse error. A kill mid-write (`./stop.sh`, OOM, VM pause — exactly the unattended-crash
case) becomes "the plan vanished" or "every completed task re-ran", with no error anywhere.
Everything later in this plan persists state, so this comes first.

**Files:** new `core/jsonStore.js`; `server.js` (remove the local helpers, import instead).

**Do:**
- Create `core/jsonStore.js` exporting:
  - `readJson(file, fallback)` — try `file`; on throw, try `${file}.prev` and
    `console.warn('[jsonStore] recovered <file> from .prev')` on success; else return
    `fallback`.
  - `writeJson(file, data)` — serialise with `JSON.stringify(data, null, 2)`; if `file`
    exists, copy it to `${file}.prev`; write `${file}.tmp`; `fs.renameSync(tmp, file)`.
  - `readJsonFile(file, fallback)` — plain read, no `.prev` fallback (used by
    `getStateDir()`, which must not recurse).
- In `server.js`, delete the local `readJson` / `writeJson` / `readJsonFile`
  ([server.js:97](server.js:97), [server.js:175-184](server.js:175)) and import from
  `core/jsonStore.js`. Call sites stay identical.

**Do NOT:** change any call site's arguments; add locking; make anything async.

**Tests:** `test/jsonStore.test.js`
- round-trip write/read;
- truncate the file by hand → `readJson` recovers from `.prev`;
- corrupt both file and `.prev` → returns the fallback;
- `writeJson` leaves no `.tmp` behind.

**Done when:** `npm test` green (add `"test": "node --test"` to
[package.json](package.json:5) in this step), and the app still boots and runs a plan.

---

# Step 2 — Extract pure logic into `core/`

**Branch:** `step-2-core-extraction`

**Why:** `server.js` calls `server.listen()` at import ([server.js:2748](server.js:2748)),
so none of its logic is testable. This is the same extraction `shared.js` already did for
the same reason.

**Files:** new `core/taskGraph.js`, `core/lessons.js`; `server.js`.

**Do:**
- `core/taskGraph.js` — move verbatim from `server.js`: `topoSortTasks`
  ([server.js:199](server.js:199)), `uniqueFixId` ([server.js:336](server.js:336)),
  `isPlanComplete` ([server.js:377](server.js:377)), `issueSignature`
  ([server.js:2458](server.js:2458)).
- `core/lessons.js` — move verbatim: `KEYWORD_STOPWORDS`, `extractKeywords`
  ([server.js:446](server.js:446)), `lessonTopicKey` ([server.js:460](server.js:460)),
  `lessonRelevance` ([server.js:466](server.js:466)). Add a new pure
  `rankLessons(memory, ctx, n)` holding the ranking body of `lessonsBlock`
  ([server.js:480](server.js:480)); `lessonsBlock` stays in `server.js`, keeps the
  `readMemory()` call, and delegates ranking.
- `server.js` imports them. **Behaviour must not change in this step.**

**Do NOT:** move anything that touches `FILES`, `getConfig()`, or the network. Do not move
recipe expansion yet (step 11 reshapes it).

**Tests:** `test/taskGraph.test.js`, `test/lessons.test.js`
- topo sort: correct order; dangling `depends_on` rejected; cycle rejected;
- `uniqueFixId` collision walk; `isPlanComplete` with mixed done/aborted;
- `issueSignature` stability across cosmetic differences;
- `extractKeywords` stopword/length filtering; `lessonTopicKey` prefers files → keywords →
  taskId; `rankLessons` orders by file match over keyword match and returns `[]` when
  nothing overlaps.

**Done when:** `npm test` green; a real plan runs unchanged.

---

# Step 3 — Tests for the already-pure modules

**Branch:** `step-3-baseline-tests`

**Why:** Lock in current behaviour before changing anything. These modules need no
extraction.

**Files:** `test/` only. **No source changes at all.**

**Do:** write tests for:
- `shared.js`: `detectRateLimit` — matches each pattern; **must not** match a benign
  sentence about implementing rate limiting when the caller passes success output (document
  that the guard is the caller's, per [server.js:1772](server.js:1772));
  `parseRetryAfterMs` — `"try again in 1.605s"` → 1605, `"retry in 300ms"` → 300, absent →
  0.
- `roles/shared.js`: `extractJson` on a fenced block, on prose-wrapped JSON, on malformed
  JSON (throws with `.raw`); `normalizeTask` defaults; `normalizeToolNode` rejects an
  unknown tool and derives `files` for `write_file`/`append_file`/`mkdir`.
- `graph/recipeMiner.js`: `normalize` placeholder substitution; `jaccard` edge cases;
  `clusterByText` honours `threshold`/`minSize` and strips scratch fields.
- `graph/masterPromptIndex.js`, `graph/loopPrompt.js`, `graph/projectProfile.js`: one
  representative test each.

**Done when:** `npm test` green with no source diff.

---

# Step 4 — Durable task state

**Branch:** `step-4-task-state`

**Why:** Today the answer to "what is task X doing?" is scattered across `running.json`,
`completed.json`, `aborted.json` and in-memory `runningControllers`
([server.js:421](server.js:421)) — and `running.json` is *wiped* at run start
([server.js:2183](server.js:2183)) and at boot ([server.js:2753](server.js:2753)). After a
crash the orchestrator cannot tell a task was mid-flight.

**Files:** new `core/taskState.js`; `server.js`.

**Do:**
- New state file `<targetDir>/.orchestrator/task_state.json`, keyed by task id:

```jsonc
{
  "task-4": {
    "status": "pending|in_progress|done|failed|blocked|needs_verification",
    "attempts": 2,
    "retries": 1,
    "lastResult": { "ok": false, "detail": "…", "signature": "…", "at": 0 },
    "current": {
      "owner": { "agentId": "…", "kind": "cli", "ref": "claude:sonnet", "pid": 0, "host": "…" },
      "leaseUntil": 0,
      "startedAt": 0,
      "lastOutputAt": 0,
      "lastRepoChangeAt": 0,
      "gitBaseline": { "head": "…", "porcelainHash": "…" }
    },
    "history": [
      { "attempt": 1, "startedAt": 0, "endedAt": 0, "outcome": "stalled", "signature": "…" }
    ]
  }
}
```

- `core/taskState.js` exports `readTaskState(file)`, `setTaskState(file, id, patch)`,
  `startAttempt(...)`, `endAttempt(...)`, plus derived views `completedIds(state)`,
  `abortedIds(state)`, `runningEntries(state)`.
- **`setTaskState` is the only writer.** It writes `task_state.json` and, in the same call,
  re-derives and writes `completed.json` and `aborted.json` so every existing reader
  (`markTaskCompleted`, `markTaskAborted`, `isPlanComplete`, the scheduler's deps check,
  the UI) keeps working unchanged. Reimplement `markTaskCompleted`
  ([server.js:364](server.js:364)) and `markTaskAborted` ([server.js:357](server.js:357))
  as thin wrappers over it.
- `readRunning()` ([server.js:394](server.js:394)) becomes a projection over
  `status === 'in_progress'`; `running.json` is no longer written. Keep `addRunning` /
  `removeRunning` as names, now delegating to `setTaskState`.
- `owner` is **metadata only** — no code may branch on `agentId`/`pid`/session. `leaseUntil`
  is a heartbeat so a future second agent can reclaim an abandoned task; nothing multi-agent
  is built now.
- Capture `gitBaseline` at attempt start: `git rev-parse HEAD` plus a sha256 of the
  `git status --porcelain` output (reuse the `execFile` pattern in `gitChangedFiles`,
  [server.js:1462](server.js:1462)).
- Migration: on first read, if `task_state.json` is absent, build it from the existing
  `completed.json` / `aborted.json`.

**Do NOT:** delete `completed.json`/`aborted.json`; change `tasks.json`'s shape; touch the
recovery ladder (step 5) or stall detection (step 6) yet.

**Tests:** `test/taskState.test.js` — derived views match the record; a `done` transition
writes both `task_state.json` and `completed.json`; migration from legacy files; attempt
counters increment once per attempt.

**Done when:** `npm test` green; a full run behaves identically in the UI (Running badge,
completed ticks, aborted rows).

---

# Step 5 — Crash recovery (invariant 1)

**Branch:** `step-5-recovery`

**Why:** After a crash, an `in_progress` task is currently just re-run blind — the
orchestrator doesn't know whether it already changed the repo.

**Files:** `core/taskState.js` (add the classifier); `server.js` (call it at boot and at
run-loop start).

**Do:**
- Add a **pure** `classifyInterrupted(record, gitState, depsDone)` → one of
  `'done' | 'pending' | 'verify' | 'needs_verification'` plus a reason string. It takes
  evidence as arguments; it must not read files or run git itself (so it is unit-testable).
- Ladder, in order:

| Evidence | Result | Action by the caller |
| --- | --- | --- |
| id already in `completedIds` | `done` | reconcile, no re-run |
| repo unchanged vs `gitBaseline` **and** no captured output | `pending` | attempt recorded in `history` but **not** counted toward `maxAttempts` |
| repo changed **and** task has `green_test` | `verify` | run `green_test`; pass → `done`; fail → `pending` with the partial-work note + log tail as `suggested_fix` |
| repo changed, no `green_test` | `needs_verification` | requeue, prompt carries the changed-file list + log tail so the worker *continues* rather than restarts |
| a dependency is not done | `pending` | not runnable yet |

- `green_test` already exists in the task schema ([roles/shared.js:74](roles/shared.js:74))
  and is currently unused — this is what it was for. Run it with the existing
  `run_bash`-style spawn, bounded by `maxAttemptMs`.
- Caller: on boot and at the top of `runLoop`, for every `in_progress` record whose
  `leaseUntil` has expired, gather `gitState`, call the classifier, apply the action.
- **Delete the blind wipes**: `clearRunning()` at [server.js:2183](server.js:2183) and the
  stale-clear at [server.js:2753](server.js:2753) are replaced by this pass. That evidence
  is what recovery needs.

**Do NOT:** attempt semantic reconstruction of what the worker was doing. Evidence only:
task state, git, dependencies, `green_test`, captured output.

**Tests:** `test/recovery.test.js` — one case per ladder row, including "repo changed +
`green_test` passes → done" and "no change, no output → pending, attempts not incremented".

**Done when:** `npm test` green, and the step-13 kill-during-task smoke test (written in
step 12) passes.

---

# Step 6 — Worker timeout, stall and repetition guards (invariants 3, 4)

**Branch:** `step-6-stuck-detection`

**Why:** `executeNative` ([execution/native.js:53](execution/native.js:53)) has **no
timeout** — a hung `claude --print` holds its concurrency slot forever. Only `runBash`
(120 s) and the auth probe (20 s) are bounded. Nothing counts attempts, so a worker failing
identically will do so until the session dies. This is the single highest-value step for
the 5-hour target; ship it even if later steps slip.

**Files:** `execution/native.js`, `execution/agent.js`, `execution/index.js`, `server.js`,
`core/taskState.js`.

**Do:**
- Config knobs in `config.json`, all optional with these defaults (read them the way
  `maxConcurrency` is read at [server.js:2162](server.js:2162)):

| Knob | Default | Meaning |
| --- | --- | --- |
| `stallMs` | 600000 (10 min) | no output **and** no repo change → stalled |
| `maxAttemptMs` | 2700000 (45 min) | hard ceiling on one attempt |
| `maxAttempts` | 3 | then `blocked`, not another retry |
| `identicalFailureLimit` | 2 | same failure signature twice → stop retrying identically |

- **Bound the worker:** thread a timeout through `execute()` into `executeNative` /
  `executeAgent` and enforce it by aborting the existing `AbortController` already wired up
  in `runTask` ([server.js:1700](server.js:1700)). Resolve `{ ok: false, detail: 'timed out
  after …' }` — do not throw.
- **Watchdog:** in the run loop's existing iteration, for each `in_progress` record check a
  pure `isStalled(record, now, limits)` (in `core/taskState.js`) and abort on breach. Bump
  `leaseUntil` on the same tick. `lastOutputAt` is updated from `runTask`'s existing
  `onOut`/`onErr` handlers ([server.js:1801](server.js:1801)); `lastRepoChangeAt` when the
  porcelain hash moves.
- **Repetition guard:** hash each failure with `issueSignature` (now in `core/taskGraph.js`)
  and store it in `lastResult.signature`. On `identicalFailureLimit` consecutive matches,
  stop retrying identically: first re-heal through the existing `handleRetryTask` fix path
  ([server.js:1189](server.js:1189)), then `blocked` with a reason.
- **`blocked` cascades like `aborted`** in the dependency cascade
  ([server.js:2252](server.js:2252)), so the scheduler keeps working on independent tasks
  instead of jamming. Surface blocked tasks in the end-of-run report and to the goal loop's
  replan — that is the human-decision boundary of invariant 9.

**Do NOT:** add per-task timeout UI; retry a task that is `blocked`; make the timeout so
short that a legitimate long build dies (defaults above are deliberately generous).

**Tests:** `test/stuck.test.js` — `isStalled` at/just under/over `stallMs` and
`maxAttemptMs`; attempts reach `blocked` at exactly `maxAttempts`; `identicalFailureLimit`
consecutive identical signatures escalates while differing signatures do not.

**Done when:** `npm test` green; step 12's stall and repetitive-failure smoke tests pass.

---

# Step 7 — Resurrect `memory.json`

**Branch:** `step-7-memory-backfill`

**Why:** `lessonRelevance` scores only on `keywords`/`files`. **All 57 entries** in
`valuation-calc/.orchestrator/memory.json` (102 KB) have neither — they predate Phase 8 —
so every score is 0 and `lessonsBlock`'s `.filter(s => s.score > 0)`
([server.js:487](server.js:487)) drops all of them. No worker prompt has included a lesson
since Phase 8 shipped.

**Files:** `server.js` (`readMemory`, [server.js:432](server.js:432)); `core/lessons.js`.

**Do:**
- Add pure `backfillLesson(entry)` to `core/lessons.js`: if `keywords` is missing/empty,
  set it from `extractKeywords(error_summary + ' ' + root_cause + ' ' + lesson)`; default
  `files` to `[]`.
- `readMemory()` backfills on read and, if anything changed, writes the file back once.

**Do NOT:** reintroduce recency-based selection. A lesson that still scores 0 after backfill
stays filtered — the point is to make ranking *work*.

**Tests:** in `test/lessons.test.js` — a legacy entry (no `keywords`, no `files`) scores
**> 0** after backfill against a task whose description shares its vocabulary. This is the
regression test proving the memory system was dead.

**Done when:** `npm test` green, and a manual `rankLessons` call against the real
`valuation-calc` memory returns a non-empty list for an overlapping task description.

---

# Step 8 — Project-scope `logs/` and `error_logs/` (invariant 5)

**Branch:** `step-8-scope-logs`

**Why:** Phase 1 moved all state under `<targetDir>/.orchestrator/`; these two stayed in
this repo ([server.js:125-126](server.js:125)) keyed by bare task id — and every plan reuses
ids from `task-1`. `error_logs/` currently holds 14 files from an Aug 4–6 run of a
**different project**. Consequences: `recordLesson` runs on **success** and reads
`error_logs/{id}.txt` ([server.js:1517](server.js:1517)), so a new project's `task-3`
succeeding records a lesson fabricated from an unrelated project's error; `handleRetryTask`
([server.js:1197](server.js:1197)) injects that stale error as a `suggested_fix`;
`mineAndCurateRecipes` ([server.js:1047](server.js:1047)) mines every project that ever used
the tool.

**Files:** `server.js` only.

**Do:** resolve both directories through `getStateDir()` like every other state path,
created lazily per target dir rather than once at module load. Add a prune that keeps the
newest 50 `.log` files per project.

**Do NOT:** migrate the old directories. Stop reading them; say in the commit body that
`./logs` and `./error_logs` are now deletable.

**Tests:** covered by step 12's smoke test — assert logs land under
`<target>/.orchestrator/` and this repo's `logs/`/`error_logs/` are untouched.

**Done when:** a run against a scratch project writes only under that project.

---

# Step 9 — Bound worker context (invariant 8)

**Branch:** `step-9-bounded-context`

**Why:** `gitChangedFiles` returns the **whole dirty tree**, so every completed task appends
every dirty file to `session_context.md` — 184 KB in the live project, single lines up to
3,991 chars, `task-1 completed` repeated across unrelated plans — and workers are explicitly
told to read it ([server.js:1653](server.js:1653)). Separately, `planner_chat.json` is
112 KB and the **entire** transcript is replayed to the model every turn
([server.js:960](server.js:960)).

**Files:** `server.js` (`appendSessionContext` [server.js:1502](server.js:1502),
`handlePostPlannerChat` [server.js:954](server.js:954)).

**Do:**
- `appendSessionContext` diffs against the `gitBaseline` step 4 already captures for that
  attempt, and appends **only that task's own changes**. Same snapshot serves both needs —
  take it once.
- Cap the appended list: first 25 files, then `… and N more`.
- Cap the file: past 256 KB, move the older half to
  `<targetDir>/.orchestrator/history/session_context-<date>.md` and keep the tail.
- Planner chat: send the first turn plus the most recent 20 messages. Persist the full
  transcript; only the *replay* is bounded.

**Do NOT:** build a summarisation step, an embedding index, or a new memory store. This is
context management, not memory architecture.

**Tests:** `test/sessionContext.test.js` — given two porcelain snapshots, only the delta is
formatted; the >25 case truncates with the count; rollover keeps the tail and writes the
archive. Planner-chat windowing is a pure function test.

**Done when:** two tasks run in a dirty repo and the second `session_context.md` block lists
only that task's files.

---

# Step 10 — Workers cannot mutate the knowledge base (invariant 6)

**Branch:** `step-10-protect-state`

**Why:** the tool sandbox confines writes to the target dir
([agent/toolRunner.js:47](agent/toolRunner.js:47)) — and `.orchestrator/` lives **inside**
it. A chat worker can `write_file` straight into the recipe store, `memory.json`, or
`tasks.json`. During a 5-hour unattended run that is a self-corruption risk, not a
hypothetical.

**Files:** `agent/toolRunner.js`; `server.js` (worker prompt, [server.js:1675](server.js:1675)).

**Do:**
- In `resolvePath` (the **write** path only), reject any target inside
  `<root>/.orchestrator` with a clear error. Leave `resolveReadPath` alone — workers are
  told to read `session_context.md`.
- The Claude CLI can't be sandboxed, so add one explicit line to the worker prompt
  forbidding writes under `.orchestrator/`. Treat the sandbox deny as the enforceable half
  and say so in a comment.

**Do NOT:** block reads; add a general-purpose deny-list mechanism. One hard-coded rule.

**Tests:** `test/toolRunner.test.js` — `write_file` at `.orchestrator/recipes/x.md`,
`./.orchestrator/tasks.json`, and a `../`-escape all reject; `read_file` on
`.orchestrator/session_context.md` succeeds; an ordinary project write succeeds.

**Done when:** `npm test` green.

---

# Step 11 — Recipes as versioned files (invariant 7)

**Branch:** `step-11-recipe-files`

**Why:** recipes are knowledge worth reading and hand-editing, and today they are opaque
rows in `recipes.json` with no version, status, or evidence. Keep the existing separation:
workers emit outcomes and lessons, the miner turns lessons into candidates, **a human
approves**. Nothing here changes that.

**Files:** new `core/recipeStore.js`, new `core/recipeExpand.js`; `server.js`
(`getRecipeForProject` [server.js:272](server.js:272), `handleApproveRecipe`
[server.js:1092](server.js:1092), `handleGetRecipes` [server.js:1129](server.js:1129),
`readCustomRecipes`/`writeCustomRecipes` [server.js:244](server.js:244), `recipeHintFor`
[server.js:527](server.js:527)).

## 11.1 Layout

```
<targetDir>/.orchestrator/recipes/
  index.json                       # cache only — files are authoritative
  candidates/
    sync-workspace-dists.v2.md     # proposed; NOT resolvable
  sync-workspace-dists/
    v1.md                          # retained forever
    v2.md
  repo-green-up/
    notes.md                       # project-local overlay for a BUILT-IN id
```

## 11.2 File format

Scalar frontmatter (hand-editable, ~30-line parser, no dependency) plus fenced JSON for the
parts that must be machine-exact. Full spec in **Appendix A**.

## 11.3 Rules

- **`status` in frontmatter is `candidate` | `published` | `deprecated` only.** `active` and
  `superseded` are **derived**: the active version of an id is its highest-numbered
  `published` version that nothing supersedes; lower ones derive as superseded. This is what
  lets **creating v2 never touch v1's file** while v1 still reads as superseded everywhere.
- **Approval is a move.** `POST /api/recipes/approve` validates steps against the tool
  registry (the check it already does at [server.js:1108](server.js:1108)), then moves
  `candidates/<id>.vN.md` → `<id>/vN.md` with `status: published`. Candidates are never
  resolvable before that, so the human gate is structural rather than a flag.
- **Immutable versions.** The write path only ever *creates* `vN.md` where N = max + 1. It
  never opens an existing version for write.
- **Confidence is derived and explainable.** When a recipe-expanded node group settles,
  append the outcome to `## Evidence` and recompute
  `score = (successes + 1) / (successes + failures + 2)` — Laplace-smoothed, starts at 0.5,
  bounded, monotone in the evidence — with a history row recording `scoreBefore`,
  `scoreAfter`, `outcome`, `taskId`. A hand-edited score is honoured but recorded as
  `confidenceSource: manual` with a history row. **Confidence never promotes anything.**
- **Built-in precedence unchanged.** `getRecipe(id)` (a module in `graph/recipes/`) still
  wins over any project file with the same id.
- `recipes.json` entries are migrated to `v1.md` files on first run.

## 11.4 Index reconciliation

`reconcileIndex()` runs at boot, at run-loop start, and before any resolution.

- `index.json` stores `{ path, contentHash, mtimeMs, size }` per version. Reconcile stats
  the tree; anything whose mtime/size moved, or that the index doesn't know, is re-parsed. A
  stat-per-file over a small directory — cheap enough for the read path.
- **Files win, always.** A hand-edited file's parsed frontmatter replaces the index entry.
  The index is never a source of content.
- **Nothing invalid loads silently.** A file failing frontmatter parse, step-schema
  validation, or tool-registry validation is indexed `{ status: "invalid", error }` and is
  not resolvable. `expandRecipeNodes` already throws on an unresolvable id
  ([server.js:285](server.js:285)) and `writeTasks` rejects the plan rather than persisting
  one the scheduler could jam on — same principle, extended to a corrupt file.
- Defined conflicts: **missing file** → dropped; the id falls back to the highest remaining
  published version, else becomes unresolvable. **Two files claiming the same version
  number** → both flagged invalid; neither silently wins. **Steps under a built-in id's
  directory** → flagged `shadowed`, ignored, reported.
- `handleGetRecipes` reports `invalid` and `shadowed` entries so a bad hand-edit shows up in
  the UI instead of only failing at run time.

## 11.5 `recipe-notes.json` goes away

It exists only because a built-in recipe is a module in *this* repo, so its per-project
hints had nowhere to live ([server.js:509-536](server.js:509)). The recipe directory now
provides that home: `recipes/<builtin-id>/notes.md`, same format, `## On failure` +
`## Evidence` only, no steps. `appendRecipeNote` and `recipeHintFor` become thin wrappers
over `core/recipeStore.js`, and any existing `recipe-notes.json` is migrated on first run.

**Do NOT:** let a worker write recipes (step 10 already blocks it); auto-promote on
confidence; mutate an existing version; add a YAML dependency.

**Tests:** `test/recipeStore.test.js`, over a temp recipes dir:
1. a mined proposal writes `candidates/<id>.v1.md` and is **not** resolvable;
2. approval moves it to `<id>/v1.md` as `published` and updates `index.json`;
3. a v2 candidate is created and `v1.md` is **byte-identical** afterwards;
4. approving v2 makes it active; v1 derives as superseded, stays on disk, loads by version;
5. a hand-edited file (changed step, `status: deprecated`, hand-set confidence) is picked up
   by `reconcileIndex` — file wins over index, and a manual confidence gets
   `confidenceSource: manual` plus a history row;
6. a corrupt file and a missing file are indexed `invalid` and are not resolvable —
   `expandRecipeNodes` throws naming the file; **no silently empty recipe**;
7. index/file consistency: stale hash, deleted version, and duplicate version numbers each
   reconcile to the defined outcome;
8. built-in precedence: steps under a built-in id are `shadowed` and ignored;
9. evidence moves confidence with an explainable history row.

**Done when:** `npm test` green; the recipes panel still lists built-ins and customs.

---

# Step 12 — Lesson compaction into recipes

**Branch:** `step-12-memory-compaction`

**Why:** `mineCandidates` already treats `memory.json` as a source
([graph/recipeMiner.js:100](graph/recipeMiner.js:100)), but two gaps keep the file growing:
`clusterByText` requires `minSize: 3` ([graph/recipeMiner.js:49](graph/recipeMiner.js:49)),
and **approval never retires the source lessons**. Today's 57 entries collapse to 35
distinct `lessonTopicKey`s — a third are already redundant.

**Depends on:** steps 7 (backfill — matching is impossible without keywords), 8, 11.

**Files:** `server.js` (new `POST /api/memory/compact`, extend `handleApproveRecipe`);
`core/lessons.js`.

**Do:** a re-runnable compaction pass, **dry-run by default** (`{ apply: true }` to commit),
built from existing parts:
1. **Dedupe, zero LLM:** collapse entries sharing a `lessonTopicKey`, newest wins.
2. **Graduate into existing recipes:** reuse `annotateCandidate`'s `matchesExistingRecipe`
   ([graph/recipeMiner.js:178](graph/recipeMiner.js:178)); on a match fold the lesson into
   that recipe's `## On failure` / `## Evidence` and drop it from `memory.json`. This is
   `recordLesson`'s graduation path ([server.js:1547](server.js:1547)) applied
   retroactively.
3. **Propose new recipes** from what remains, `minSize: 2` **for this backlog pass only**.
4. **Retire on approve:** the candidate carries `sourceLessons`; approving moves those
   lessons out of `memory.json` into the approved version's file.
5. **Archive, never delete:** everything removed appends to
   `<targetDir>/.orchestrator/history/memory-compacted-<date>.json` (that dir exists).

Response shape: `{ removed, graduated, proposals, remaining }`.

**Do NOT:** auto-approve proposals; change the default `minSize` for ordinary mining; delete
anything without archiving it.

**Tests:** `test/compaction.test.js` — dedupe count on a fixture; graduation moves a lesson
into the recipe file and out of memory; approving a proposal retires exactly its
`sourceLessons`; dry-run mutates nothing.

**Done when:** a dry-run against the real `valuation-calc` reports the 57 → ~35 dedupe.

---

# Step 13 — Smoke tests

**Branch:** `step-13-smoke-tests`

**Why:** unit tests can't prove the run loop survives a kill. This scripts the rig you
already use by hand (isolated copy + fake `claude` on PATH + `PORT=3999`).

**Files:** `test/smoke/` only.

**Do:** a helper that boots `server.js` on `PORT=3999` against a temp git repo with a stub
`claude` on `PATH`, then five tests:
1. **Happy path** — plan → run → `completed.json` correct, dependency order respected,
   abort cascade works.
2. **Kill during task (invariant 1)** — stub writes a file then hangs; `SIGKILL` the
   orchestrator mid-task; restart; assert the task is classified partial (not lost, not
   blindly restarted) and the run completes.
3. **Stall (invariant 3)** — stub sleeps past `stallMs` (override it to a few seconds);
   assert abort, attempt recorded, loop continues.
4. **Repetitive failure (invariant 4)** — stub fails identically every time; assert
   `blocked` after `maxAttempts` and that independent tasks still complete.
5. **Worker cannot mutate recipes (invariant 6)** — a tool call writing under
   `.orchestrator/recipes/` is rejected while reading `session_context.md` succeeds.

**Do NOT:** call a real model; write outside the temp dir; leave stray processes (kill the
server in teardown).

**Done when:** `npm test` runs unit + smoke green from a clean checkout.

---

# Step 14 — Hygiene and local-only lockdown

**Branch:** `step-14-hygiene`

**Files:** `.gitignore`, `config.example.json`, `server.js`, `package.json`.

**Do:**
- **Untrack `config.json`** — it is tracked *and* rewritten by `handleSetConfig`
  ([server.js:788](server.js:788)), the roles panel, and `build-models.mjs`, so the repo is
  never clean and every branch carries `/media/sf_github/valuation-calc`.
  `git rm --cached config.json`, add to `.gitignore`, commit `config.example.json` (same
  content with `targetDir: ""` and no personal paths), and seed `config.json` from it on
  first boot if absent.
- **Untrack `.claude/scheduled_tasks.lock`** — a runtime lock holding a live pid.
- **Bind loopback:** `server.listen(PORT, '127.0.0.1')` ([server.js:2748](server.js:2748)).
- **Drop `Access-Control-Allow-Origin: *`** ([server.js:541](server.js:541)). Vite already
  proxies `/api` same-origin ([vite.config.js:14](vite.config.js:14)), so local dev needs no
  CORS. Replace with an `Origin` allow-list (`http://localhost:5173`,
  `http://127.0.0.1:5173`); reject anything else with 403.
  *Why this matters:* today any site open in any tab can `fetch()` `POST /api/config` to
  point the target dir at `$HOME`, then `GET /api/run`, which executes
  `claude --permission-mode bypassPermissions` there. It's a simple request so no preflight
  blocks it, and `*` lets the page read the replies.

**Do NOT:** add auth tokens or a login; loopback + Origin check is the whole scope.

**Tests:** `test/cors.test.js` — a disallowed `Origin` gets 403; an allowed one passes;
`/api/health` still answers on loopback.

**Done when:** the UI on `:5173` works unchanged and `curl <LAN-IP>:3001/api/health`
refuses to connect.

---

# Step 15 — Documentation

**Branch:** `step-15-docs`

**Files:** `README.md`, `server.js` header, new `docs/DESIGN.md`, `docs/history/`.

**Do:**
- Rewrite `README.md`. It currently documents **6 of 31 endpoints** and the pre-Phase-1
  state model, and never mentions `run.sh`/`stop.sh`, roles, recipes, the goal loop, the 🔑
  key panel, or the model-agnostic layer. Generate the endpoint table from the router
  ([server.js:2691-2740](server.js:2691)). Add the invariants and the step-6 config knobs.
- **Delete the Netlify and Cloudflare Tunnel sections (§4–5)** — they instruct exposing a
  backend that runs arbitrary code with `bypassPermissions` to the public internet, which
  step 14 deliberately prevents.
- **Document the recipe file format** (Appendix A): frontmatter fields, the three sections,
  what is safe to hand-edit, how the index reconciles. These are files a human is expected
  to open, so the format is interface, not implementation.
- Replace the `server.js` header comment ([server.js:1-11](server.js:1)) — it lists 4 routes
  and the old state model — with a module map.
- Move `REDESIGN_PLAN.md` and `MODEL_AGNOSTIC_PLAN.md` (58 KB combined, both claiming to be
  the living source of truth, both now history) to `docs/history/`. Distil their
  "Established findings" and "Locked design decisions" plus the invariants above into a
  short `docs/DESIGN.md`.

**Done when:** a fresh reader can set up, run, and understand the state model from
`README.md` alone.

---

# Appendix A — recipe file format

````md
---
id: sync-workspace-dists
version: 2
status: published          # candidate | published | deprecated
supersedes: sync-workspace-dists@1
createdAt: 2026-08-12T09:00:00Z
approvedAt: 2026-08-12T09:14:00Z
confidence: 0.75
confidenceSource: derived  # derived | manual
---

## Description
Rebuild workspace dists before a dependent package's tests run.

## Steps
```json
[{ "tool": "run_bash", "args": { "command": "pnpm -r --filter ./packages/* build" } }]
```

## On failure
Check that pnpm-workspace.yaml lists the package…

## Evidence
```json
{ "successes": 2, "failures": 0,
  "sourceLessons": ["mem-1754…", "mem-1755…"],
  "history": [{ "at": "2026-08-12T10:02:00Z", "outcome": "success", "taskId": "task-9",
                "scoreBefore": 0.66, "scoreAfter": 0.75 }] }
```
````

Parser rules (`core/recipeStore.js`):
- Frontmatter is the block between the first two `---` lines; **scalars only**, one
  `key: value` per line, values trimmed, no nesting, no arrays. Unknown keys are preserved
  verbatim on rewrite.
- `## Steps` and `## Evidence` bodies must be a single fenced ```json block. `## Description`
  and `## On failure` are free markdown.
- Required for a valid recipe: `id`, `version` (integer ≥ 1), `status`, and a `## Steps`
  block that parses and whose every `tool` is in the registry (`toolMenu().names`).
  A `notes.md` overlay is valid **without** `## Steps`.
- Serialisation is deterministic (stable key order, `\n` endings) so a rewrite produces no
  spurious diff.

# Appendix B — final verification

Run after step 15.

- `npm test` — unit + all five smoke tests green from a clean checkout.
- **The real bar — unattended soak:** point at a scratch project, start the goal loop, and
  while it runs `SIGKILL` the backend once and `SIGKILL` a worker once. Restart. It must
  converge with no manual bookkeeping, and `task_state.json` must explain every task's path
  — attempts, outcomes, and why anything is blocked.
- **Step 7:** `rankLessons` against the real `valuation-calc` memory returns a non-empty
  list for an overlapping task description (it returned `[]` for every input before).
- **Step 8:** a run writes logs only under `<target>/.orchestrator/`.
- **Step 9:** two tasks in a dirty repo → the second `session_context.md` block lists only
  that task's files.
- **Step 11:** approve a v2 candidate → v2 active, `v1.md` byte-identical and deriving as
  superseded, `index.json` updated. Hand-edit `v2.md` → change takes effect next resolution
  with no manual index edit. Corrupt `v2.md` → a plan referencing it fails loudly naming the
  file, and `GET /api/recipes` shows it `invalid`.
- **Step 12:** source lessons move out of `memory.json` into the approved version's file,
  `recipe-notes.json` is migrated and gone, removals are archived under
  `.orchestrator/history/`, and every confidence change is explained by its history row.
- **Step 14:** `curl -H 'Origin: https://evil.example' -X POST localhost:3001/api/config`
  → 403; the UI on `:5173` is unaffected; `curl <LAN-IP>:3001/api/health` refuses.
