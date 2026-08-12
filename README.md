# 🎛️ claude-orchestrator

A self-contained web app that orchestrates multi-step development tasks with the
[`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI (and, optionally, any
OpenAI-compatible chat model as a worker or planner).

You give it a **master prompt**; the planner breaks the work into a dependency-ordered
task graph; you tune the **model** and **effort** per task; then it runs the tasks —
sequentially or in parallel, in dependency order — streaming logs to a live console. A
goal loop can drive multiple plan → run → audit → replan cycles unattended. See
`docs/DESIGN.md` for the architecture and `HARDENING_PLAN.md` for the reliability work
that makes an unattended run survive a crash, a stall, or a repeated failure.

- **Backend:** Node.js native `http`, zero npm dependencies.
- **Frontend:** vanilla HTML/CSS/JS (no framework).
- **Bundler:** Vite (the only dev dependency).
- **State:** flat files under `<targetDir>/.orchestrator/` — no database. See
  `docs/DESIGN.md` § State.

---

## 1. Installation

```bash
npm install      # installs Vite only
```

You also need the `claude` CLI installed and authenticated, and on your `PATH`:

```bash
claude --version
```

If your `claude` binary lives elsewhere, set `CLAUDE_BIN` (see below). To use a
non-Claude model as a worker or planner, add its client + API key — see
`docs/history/MODEL_AGNOSTIC_PLAN.md` § "Using a non-Claude provider".

## 2. Local testing

The app has two processes: the backend (`:3001`, loopback-only) and the Vite dev server
(`:5173`).

**One-click (Linux/macOS):** `./run.sh` starts both as detached background processes and
opens your browser; `./stop.sh` stops them. Logs land in `.run/`.

**Manual — Windows (PowerShell), run each in its own terminal:**

```powershell
npm run server    # terminal 1  -> backend on http://localhost:3001
npm run client    # terminal 2  -> UI on http://localhost:5173
```

**Manual — macOS / Linux, one command:**

```bash
npm run dev       # backgrounds the server (&) and starts Vite
```

Then open **http://localhost:5173** and:

1. Enter your **Target Project Directory** (where Claude should build).
2. Upload `MASTER_PROMPT.md` (or paste the prompt).
3. Click **🧠 Generate Plan**.
4. Tweak model/effort dropdowns (auto-saved).
5. Click **▶️ Run All Pending** and watch the live console.

## 3. Environment variables

| Variable       | Where     | Default            | Purpose                                            |
| -------------- | --------- | ------------------ | --------------------------------------------------- |
| `VITE_API_URL` | frontend  | `''` (same-origin) | Base URL of the backend, if not same-origin.        |
| `CLAUDE_BIN`   | backend   | `claude`           | Path to the `claude` executable.                    |
| `PORT`         | backend   | `3001`              | Backend port (bound to `127.0.0.1` only).            |
| `CONCURRENCY`  | backend   | `config.json`'s `maxConcurrency`, else `3` | Max tasks in flight at once. |

Provider API keys (for non-Claude clients) live in a gitignored `.env` at the repo root —
set via the 🔑 key panel in the UI, or `export`ed before `./run.sh`. See `env.js`.

Locally you don't set `VITE_API_URL` — Vite proxies `/api` to `:3001`, so it's
same-origin. The backend allow-lists only the Vite dev server's own origin
(`http://localhost:5173` / `http://127.0.0.1:5173`) — see § Security below.

---

## 4. Security

The backend executes `claude --permission-mode bypassPermissions` (or a chat model's own
tool loop) with real file-write and shell-command ability inside whatever `targetDir`
`config.json` points at, with no per-action prompts. Only point `targetDir` at a project
you're comfortable letting an agent modify autonomously.

To keep this local-only:

- The server binds `127.0.0.1` — nothing on your LAN or the public internet can reach it,
  regardless of firewall rules.
- Cross-origin requests are rejected (403) unless the `Origin` is the Vite dev server's own
  (`localhost:5173` / `127.0.0.1:5173`). A same-origin request (curl, the app's own health
  checks — no `Origin` header at all) is unaffected; this only stops a page in another tab
  from `fetch()`-ing your backend.
- `agent/toolRunner.js`'s write path rejects any target under `.orchestrator/` — a worker
  can read `session_context.md` there but never mutate the task graph, recipes, or memory
  it's being driven by (see `docs/DESIGN.md` § Locked decisions).

There is no further sandbox: `run_bash` is a real shell and can escape `targetDir` via an
absolute path or `cd`. This is the same trust model as running `claude` with
`--permission-mode bypassPermissions` directly.

---

## API reference

Generated from the router in `server.js`. `id` in a `:id` segment is URL-encoded; `run`
(`GET /api/run`, `GET /api/goal/start`) streams **Server-Sent Events**, everything else
returns JSON.

| Method | Path                        | Notes                                                        |
| ------ | --------------------------- | -------------------------------------------------------------- |
| POST   | `/api/plan`                 | `{ prompt, targetDir }` → planner generates & saves `tasks.json` |
| POST   | `/api/split`                | Splits a task with unclear scope into smaller sub-tasks       |
| POST   | `/api/concurrency`          | `{ maxConcurrency }` → persisted to `config.json`              |
| POST   | `/api/config`               | `{ targetDir }` → set build dir (validated to exist)            |
| GET    | `/api/tasks`                | `{ tasks, completed, aborted, running, maxConcurrency, targetDir }` |
| PUT    | `/api/tasks/:id`            | Patch `assigned_model` / `effort` / `description` / `depends_on` |
| GET    | `/api/tasks/:id/run`        | SSE — run just this one task                                   |
| POST   | `/api/tasks/:id/stop`       | Abort a currently-running task                                 |
| POST   | `/api/tasks/:id/retry`      | Self-healing retry — asks the healer role for a suggested fix  |
| POST   | `/api/retry-all`            | Retries every aborted task                                     |
| GET    | `/api/models`                | Capability-filtered model list, sourced from `config.json`'s `clients` |
| POST   | `/api/roles`                 | `{ role, client, model, fallback? }` → persisted role routing  |
| GET    | `/api/keys`                  | Which provider API keys are set (masked hint only, never the value) |
| POST   | `/api/keys`                  | `{ id, key }` → writes to `.env`, applies to the running process |
| GET    | `/api/planner-chat`          | Full persisted "chat with the planner" transcript              |
| POST   | `/api/planner-chat`          | `{ message }` → one turn (replay to the model is windowed — step 9) |
| DELETE | `/api/planner-chat`          | Clears the transcript                                          |
| POST   | `/api/audit`                 | Runs the auditor role once against the current build           |
| GET    | `/api/memory`                | The lessons-learned backlog (`memory.json`)                    |
| POST   | `/api/memory/compact`        | `{ apply? }` → dedupe/graduate/propose over the memory backlog (dry-run by default — step 12) |
| GET    | `/api/recipes`               | Built-in + this project's custom recipes (with version/status)  |
| POST   | `/api/recipes/mine`          | Mines this project's history for recurring-work candidates      |
| POST   | `/api/recipes/approve`       | `{ recipe }` → writes + publishes a new recipe version (step 11) |
| GET    | `/api/logs/:id`              | Full tee'd run log for a task                                  |
| GET    | `/api/context`               | Reference files available to workers                            |
| POST   | `/api/context`               | Upload a reference file                                         |
| DELETE | `/api/context/:name`         | Remove a reference file                                         |
| GET    | `/api/run`                   | SSE — runs all pending tasks in dependency order                |
| POST   | `/api/run/stop`              | Stops the run loop after the current task(s) finish              |
| GET    | `/api/goal/start`            | SSE — the goal loop: plan → run → audit → replan, unattended     |
| GET    | `/api/health`                | `{ ok: true }`                                                  |

## Notes on the `claude` CLI (important)

Two intentional deviations from a literal reading of the original spec, both so
the tool **actually runs on first try**:

0. **Windows launch fix.** On Windows the `claude` on your PATH is a `.cmd`
   shim, and Node's `spawn`/`execFile` can't launch that directly — you'd get
   `spawn claude ENOENT`. The backend runs claude through the shell on Windows
   (`shell: true`) and feeds the prompt over **stdin**, so the shell never sees
   the (untrusted, multi-line) prompt text — only fixed flags and an
   allow-listed model name go into argv.

1. **No `--effort` / `--prompt` flags by default.** Not every installed `claude`
   version recognizes these, and an unknown flag makes the process exit non-zero
   *before doing anything*. So the backend calls
   `claude --model <model> --print` and feeds the prompt over **stdin** (which
   also dodges all shell-quoting problems with multi-line prompts). The requested
   effort level is embedded into the prompt text as a hint. If your CLI does
   support `--effort`, there's a one-line switch in `clients/claude-cli.js`.

2. **`/api/run` uses `spawn`, not `exec`.** `exec` buffers *all* output until the
   process exits, so it literally cannot stream a live console. `spawn` streams
   stdout/stderr chunks as they happen — which is the whole point of the live console.
   (Planning still uses `execFile` with a bounded buffer since it's a single JSON result.)

If `claude` is missing or errors, the failure is surfaced verbatim in the UI —
either in the plan status line or the live console.

3. **The subprocess runs with `--permission-mode bypassPermissions`.** Without
   it, a headless (`--print`) claude can't answer permission prompts, so it just
   *describes* the files it would create and exits 0 — the orchestrator then
   marks the task "done" while nothing was actually written. bypassPermissions
   lets it write files autonomously. See § Security above.
