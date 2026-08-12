# Design

Distilled from `docs/history/REDESIGN_PLAN.md` and `docs/history/MODEL_AGNOSTIC_PLAN.md`
(both historical — read them for *why*, not *what to do next*; `HARDENING_PLAN.md` at the
repo root is the current source of truth) plus the reliability work in `HARDENING_PLAN.md`.

## Architecture

```
clients/    raw model communication, normalised (dialect differences hidden here)
agent/      ONE generic conversation + tool loop (works with any tool-calling chat client)
execution/  thin dispatch: native CLI backend (Claude), or the agent framework (chat clients)
core/       pure logic — no FILES, no getConfig(), no network — extracted so it's unit-testable
graph/      zero-LLM mechanical passes: recipe expansion, recipe mining, prompt/section indexing
roles.js    resolves a role name -> a callable { complete(prompt) } / { chat(messages) }
shared.js   IS_WIN, CHILD_ENV, config.json reader + built-in defaults
server.js   HTTP routes, SSE, the run-loop scheduler — orchestration
```

The Claude CLI is already an agent (`kind:"cli"`, routed to `execution/native.js` — a bare
`spawn`, no visibility into its internal tool calls). A plain chat model becomes a coding
agent via `agent/executor.js`'s generic tool loop (`kind:"chat"`, routed to
`execution/agent.js`) — adding a provider is one small `clients/*.js` file with `chat()`;
it then works as both a planner and a worker with zero new executor code.

## State

Everything project-scoped lives under `<targetDir>/.orchestrator/` (never in this repo),
keyed by the target directory itself — switching projects never bleeds state between them.
`config.json` (gitignored, seeded from `config.example.json` on first boot) is the one file
that stays next to `server.js`, since it's what tells the app the target directory in the
first place.

| File | Purpose |
|---|---|
| `task_state.json` | durable per-task record — status, attempts, current owner/lease/gitBaseline, history (`core/taskState.js`) |
| `completed.json` / `aborted.json` | derived views over `task_state.json`, kept for backward-compat readers |
| `tasks.json` | the task graph (topologically ordered on every write) |
| `memory.json` | residual lessons that haven't graduated into a recipe |
| `recipes/` | versioned, hand-editable recipe files (`core/recipeStore.js`) |
| `session_context.md` | what each task changed, for later tasks to read (bounded — step 9) |
| `history/` | archived session-context rollovers, compacted memory, dated backups |

All JSON state goes through `core/jsonStore.js`: write-to-`.tmp`-then-rename (atomic on the
same filesystem) with a `.prev` backup, so a kill mid-write can't corrupt or silently drop
state.

## The task lifecycle (steps 4-6)

A task's `task_state.json` record moves through `pending -> in_progress -> done | pending
(retry) | blocked`. `blocked` and `aborted` both derive into `aborted.json` and cascade to
dependents identically — `blocked` is reported distinctly (a repetition guard gave up) from
`aborted` (a dependency failed).

- **Crash recovery** (`recoverInterruptedTasks` / `classifyInterrupted`): a task still
  `in_progress` after a restart is classified by evidence — git state captured at attempt
  start (`gitBaseline`) vs. now, dependency completion, and whether a `green_test` exists —
  never blindly re-run and never blindly assumed done.
- **Stall / hard-ceiling detection**: a `setInterval` watchdog (independent of the
  scheduler's own await-on-completion loop, which would otherwise never notice a hung
  task) aborts a task with no output/repo-change for `stallMs`, or past `maxAttemptMs`
  regardless of activity.
- **Repetition guard**: a failure's signature (`issueSignature`, shared with the goal
  loop's audit-issue hashing) is recorded each attempt; `identicalFailureLimit` consecutive
  matches, or reaching `maxAttempts`, moves the task to `blocked` instead of retrying
  forever. Below that, a failure auto-retries.

Config knobs (`config.json`, all optional): `stallMs` (default 600000), `maxAttemptMs`
(2700000), `maxAttempts` (3), `identicalFailureLimit` (2).

## Recipes

A recipe is deterministic, zero-LLM: a `type:"tool"` step chain, not a prose task. Built-in
recipes (`graph/recipes/`) always win over a project's own on id collision — they ship with
the codebase and are reviewed by a human at authoring time. A project's own recipes are
proposed by mining (`graph/recipeMiner.js` clusters near-duplicate task descriptions /
memory lessons / tool-call logs), curated by an LLM role into concrete steps, and always
require human approval — nothing executable is ever written by a worker or a model alone.

See `HARDENING_PLAN.md` Appendix A for the on-disk file format (frontmatter + fenced JSON
`## Steps` / `## Evidence`, versioned, hand-editable).

## Locked decisions (carried forward from the redesign)

| Decision | Rationale |
|---|---|
| Hybrid graph, not fully-literal tool calls | A splitter cannot pre-author `write_file` content for a repo it hasn't read. Mechanical steps become zero-LLM tool nodes; code authoring stays a prose task node. |
| CLI nodes stay prose-based | The CLI is opaque — no visibility into its internal tool calls. Tool-call graphs apply to mechanical steps and chat-model nodes only. |
| Recipe promotion is human-approved | A bad generalisation baked into a reused recipe applies everywhere at once — worse than the duplication it replaces. |
| Worker fallback is global config, not planner-specified | Availability is operational; the planner has no signal about what's rate-limited right now. |
| No cost ceiling on the goal loop, no token telemetry | The user accepts the token cost; robustness is the priority, not spend or measurement. |
| `run_bash` is a real shell, not a sandbox | Filesystem tools confine writes to `targetDir` (`agent/toolRunner.js`'s `resolvePath`, also blocking `.orchestrator/` writes — step 10), but `run_bash` can escape via absolute paths / `cd`. Same trust model as `--permission-mode bypassPermissions`: point `targetDir` at a repo you trust the agent to modify. |
| Local-only by default | The backend executes arbitrary shell/model commands in `targetDir` with no prompts. It binds loopback only and allow-lists the Vite dev server's own origin (step 14) — no public exposure without deliberately re-opening that. |

## Reliability invariants (`HARDENING_PLAN.md`)

1. A task survives an orchestrator/session/worker restart.
2. Completed work is never silently forgotten.
3. An incomplete task cannot stay `in_progress` forever undetected.
4. A failing worker cannot burn a session in repetitive retries.
5. State is scoped to the correct target project.
6. Workers consume the knowledge base; they never mutate it.
7. Recipes are auditable and versioned.
8. Context handed to a worker is bounded and task-specific.
9. Humans intervene for real decisions and session limits, not routine recovery.
