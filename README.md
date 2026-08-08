# 🎛️ claude-orchestrator

A tiny, self-contained web app that orchestrates multi-step development tasks
with the [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI.

You give it a **master prompt**; it asks Claude to break the work into an ordered
task list; you tune the **model** and **effort** per task; then it runs the tasks
sequentially, streaming logs to a live console.

- **Backend:** Node.js native `http` (no Express, no dependencies).
- **Frontend:** vanilla HTML/CSS/JS (no framework).
- **Bundler:** Vite (the only dev dependency).
- **State:** flat files — `tasks.json`, `completed.json`, `config.json`. No database.

---

## 1. Installation

```bash
npm install      # installs Vite only
```

You also need the `claude` CLI installed and authenticated, and on your `PATH`:

```bash
claude --version
```

If your `claude` binary lives elsewhere, set `CLAUDE_BIN` (see below).

## 2. Local testing

The app has two processes: the backend (`:3001`) and the Vite dev server (`:5173`).

**Windows (PowerShell) — run each in its own terminal:**

```powershell
npm run server    # terminal 1  -> backend on http://localhost:3001
npm run client    # terminal 2  -> UI on http://localhost:5173
```

**macOS / Linux — one command:**

```bash
npm run dev       # backgrounds the server (&) and starts Vite
```

> Why the split on Windows? The `npm run dev` script uses a bash-style `&` to
> background the server, which doesn't do concurrent processes in PowerShell/cmd.
> Running the two scripts in separate terminals is the reliable cross-platform way.

Then open **http://localhost:5173** and:

1. Enter your **Target Project Directory** (where Claude should build).
2. Upload `MASTER_PROMPT.md` (or paste the prompt).
3. Click **🧠 Generate Plan**.
4. Tweak model/effort dropdowns (auto-saved).
5. Click **▶️ Run All Pending** and watch Panel 3.

## 3. Environment variables

| Variable       | Where     | Default            | Purpose                                            |
| -------------- | --------- | ------------------ | -------------------------------------------------- |
| `VITE_API_URL` | frontend  | `''` (same-origin) | Base URL of the backend in production (Netlify).   |
| `CLAUDE_BIN`   | backend   | `claude`           | Path to the `claude` executable.                   |
| `PORT`         | backend   | `3001`             | Backend port.                                      |

Locally you don't set `VITE_API_URL` — Vite proxies `/api` to `:3001`, so it's
same-origin and CORS-free.

---

## 4. Deploying the frontend to Netlify

Only the **frontend** is deployed; the backend stays on your machine (§5).

```bash
npm run build     # outputs static site to ./dist
```

**Netlify setup:**

- **Build command:** `npm run build`
- **Publish directory:** `dist`
- **Environment variable:** `VITE_API_URL` = your Cloudflare Tunnel URL (see §5).

You can point your Porkbun domain at the Netlify site via Netlify's *Domain
management → Add custom domain*, then update your Porkbun DNS to Netlify's
nameservers (or add the `CNAME`/`A` records Netlify shows you).

## 5. Connecting the public frontend to your local backend (Cloudflare Tunnel)

The backend runs `claude` on **your** machine, so the Netlify site needs a public
tunnel to reach it.

1. **Install cloudflared** — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Start your backend: `npm run server`
3. In another terminal, open a quick tunnel:

   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```

4. Copy the public URL it prints, e.g. `https://random-name.trycloudflare.com`.
5. In Netlify, set the env var and redeploy:

   ```
   VITE_API_URL = https://random-name.trycloudflare.com
   ```

6. Redeploy the frontend. The public website now talks to the backend running on
   your local machine.

> The backend already sets `Access-Control-Allow-Origin: *`, so the cross-origin
> Netlify → tunnel calls work. Quick-tunnel URLs change every restart; for a
> stable URL use a named Cloudflare tunnel.

---

## API reference

| Method | Path             | Body / Notes                                             |
| ------ | ---------------- | ------------------------------------------------------- |
| POST   | `/api/plan`      | `{ prompt, targetDir }` → generates & saves tasks       |
| POST   | `/api/config`    | `{ targetDir }` → set build dir (validates it exists)   |
| GET    | `/api/tasks`     | → `{ tasks, completed, targetDir }`                     |
| PUT    | `/api/tasks/:id` | patch `assigned_model` / `effort` / `description`       |
| GET    | `/api/run`       | Server-Sent Events; runs pending tasks in order         |
| GET    | `/api/health`    | → `{ ok: true }`                                        |

---

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
   support `--effort`, there's a one-line switch in `buildArgs()` in `server.js`.

2. **`/api/run` uses `spawn`, not `exec`.** `exec` buffers *all* output until the
   process exits, so it literally cannot stream a live console. `spawn` streams
   stdout/stderr chunks as they happen — which is the whole point of Panel 3.
   (Planning still uses `execFile` with `maxBuffer: 10MB` since it's a single
   JSON result.)

If `claude` is missing or errors, the failure is surfaced verbatim in the UI —
either in the plan status line or the live console.

3. **The subprocess runs with `--permission-mode bypassPermissions`.** Without
   it, a headless (`--print`) claude can't answer permission prompts, so it just
   *describes* the files it would create and exits 0 — the orchestrator then
   marks the task "done" while nothing was actually written. bypassPermissions
   lets it write files autonomously.

   ⚠️ **Safety:** this means each task runs with full tool permissions (file
   writes, shell commands) inside your **Target Project Directory**, with no
   prompts. Only point the target directory at a project you're comfortable
   letting Claude modify freely. The directory is set via the **📁 Set
   Directory** button (or automatically saved when you click Run), and the tool
   validates it exists before saving so a typo can't silently build elsewhere.
