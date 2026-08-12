# Model-agnostic orchestrator — implementation plan & progress

> **Living doc.** This is the source of truth for the model-agnostic refactor. Read this first;
> it saves re-exploring `server.js`. Update the checklist + progress log at the end of each phase.

## Why

Fable was dropped from the Pro plan, which broke the planner and file-isolation passes (both were
hardwired to the `fable` model). Rather than swap one hardcoded model for another, we make model
choice **configurable per role**, and make task execution work on **any** provider (Claude CLI or any
OpenAI-compatible chat API — DeepSeek, OpenAI, Groq, OpenRouter, Ollama…). Long-term target pipeline:
`Requirements → Planner → Splitter → Workers → Auditor`, each stage backed by a configurable model.

## Architecture — three layers

```
clients/    raw model communication, normalised (dialect differences hidden here)
agent/      ONE generic conversation + tool loop (works with any tool-calling chat client)
execution/  thin dispatch: native CLI backend (Claude), or the agent framework (chat clients)
roles.js    resolves a role name -> a callable { complete(prompt) }
shared.js   IS_WIN, CHILD_ENV, config.json reader + built-in defaults
```

Key idea: the agent loop is what turns a plain chat model into a coding agent, and it's identical for
every chat provider. Adding a provider = one small client with `chat()`; it then works as **both** a
planner and a worker with zero new executor/workflow code. Claude CLI stays the reference execution
path (`kind:"cli"`, routed to the native backend), behavior preserved.

## Directory map

```
server.js                 routes, SSE, scheduler — orchestration UNCHANGED
main.js / index.html      UI; model dropdown sourced from /api/models (capability-filtered)
config.json               targetDir + clients + roles (back-compat: absent -> claude-only defaults)
shared.js                 IS_WIN, CHILD_ENV, CONFIG_PATH, readConfig, DEFAULT_CLIENTS/ROLES
performance.js            write-only telemetry append (never read; failure ignored)
roles.js                  resolveRole(name) -> { complete(prompt, opts?) }
clients/
  index.js                loadClients, getClient(id), resolveModel("client:model"), listModels()
  claude-cli.js           kind:"cli"  — complete() via `claude --print`; claudeCliArgs()
  openai.js               kind:"chat" — complete() + chat(messages, tools)  (OpenAI-compatible)
execution/
  index.js                execute(ref, opts): dispatch by kind -> native | agent (+ perf record)
  native.js               spawn Claude CLI (relocated from runTask, semantics identical)
  agent.js                generic backend: runAgent(client, model, tools, …)
agent/
  executor.js             conversation loop, iteration/time caps, completion detection
  toolRunner.js           registry, path sandbox (resolvePath), timing, structured results, logging
  tools/
    index.js  readFile.js  writeFile.js  listDir.js  runBash.js  taskComplete.js
    (append_file, mkdir, glob, grep -> P4)
```

## Model references — two shapes
- **Role config** = object: `{ "client":"deepseek", "model":"deepseek-v4-pro", "temperature":0.2 }`.
- **Task `assigned_model`** = string `"client:model"`, parsed by `resolveModel(ref)`. Legacy bare names
  (`sonnet`) normalise to `claude:sonnet`; dead/unknown refs (`fable`) fall back to the planner model.
- **Worker-eligible** iff `kind === "cli"` OR `capabilities.toolCalling === true` (exposed as
  `execCapable` from `/api/models`; the UI hides non-eligible models from the per-task dropdown).

## Roles (config `roles.*`, all text/`complete()`)
`planner`, `splitter`, `healer`, `lessoner`, `auditor` (auditor delivered in P5). Unknown/unconfigured
text roles fall back to `planner`. The file-isolation analysis uses role `analyzer` → falls back to `planner`.

## Trust boundary (honest)
Filesystem tools confine to `targetDir`, but `run_bash` is a real shell and can escape (absolute paths,
`cd /`). This is **not** a security sandbox — same trust model as Claude's `--permission-mode
bypassPermissions`. Point `targetDir` at a repo you trust the agent to modify. API keys are read from env
vars named by `apiKeyEnv` (populated at startup from a **gitignored `.env`** by `env.js`, or from the shell);
they live only in `.env`, **never** in config.json or logs, and the `/api/keys` endpoint never returns a key
value back to the UI — only a `set` flag + a masked hint.

## Phase checklist
- [x] **P0 — roles plumbing (fixes Fable):** shared.js, clients/ (claude+openai), roles.js; rewired 5 text
  call sites to roles (plan/analyze→planner, split→splitter, heal→healer, lesson→lessoner); deleted
  `callClaude`; fixed config merge-writes; injected valid worker refs into planner/split prompts;
  added `GET /api/models`. Claude behavior identical. Unit + HTTP verified.
- [x] **P1 — OpenAI text client:** clients/openai.js `complete()`; `GET /api/models`; UI dropdown from API.
- [x] **P2 — agent framework:** agent/executor.js, toolRunner.js, v1 tools; openai `chat()`; execution/agent.js.
- [x] **P3 — execution dispatch:** execution/{native,index}.js; rewired the runTask producer to
  `execute(ref, …)` (cli→native spawn, chat→agent framework); deleted buildArgs/safeModel/ALLOWED_MODELS
  (and dead spawn/CHILD_ENV in server.js); write-only performance.json wired into execution + roles.
- [x] **P4 — tools:** append_file, mkdir, glob (fs.globSync), grep (grep -rInE); path-sandboxed +
  structured JSON; tool-log shows appended/matches. Registered in `agent/tools/index.js`. Verified offline.
- [x] **P5 — Auditor:** `runAudit` (auditor role over MASTER_PROMPT + tasks+status + session_context +
  `git status`); `POST /api/audit`; opt-in auto-run at end of a sequential run via `config.autoAudit`
  (streams an `audit` SSE); UI 🔎 Audit button + verdict/issues modal. Verified end-to-end.
- [~] **P6 — partial:** fallback providers DONE (role `fallback` = a `client:model` ref or ordered array;
  primary→fallback attempt loop in `roles.js`; default planner `opus`→`claude:sonnet`). Clients DONE:
  **gemini** (OpenAI-compat `/v1beta/openai`), **groq**, **openrouter** — config-only, no new code beyond
  allowing `/` in `SAFE_MODEL` (aggregator ids are `vendor/model`). Still deferred: voting/consensus,
  a benchmarking view over performance.json, Codex CLI client.

## Using a non-Claude provider (planner or workers)
1. Add the key named by the client's `apiKeyEnv` (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, …). Easiest: the
   **🔑 API keys** panel in Panel 1 — paste it in the browser and it's written to a gitignored `.env` and
   applied to the running server live, no restart (`POST /api/keys`; `GET` reports set/not-set per client).
   Alternatives: edit `.env` by hand (copy `.env.example`; `env.js` loads it at startup), or the old
   `export DEEPSEEK_API_KEY=sk-…` before `./run.sh`.
2. Pick the model per role **in the UI** — Panel 1 has a prominent **Planner model** dropdown plus a
   collapsible group for splitter / healer / lessoner / auditor. Changes persist to `config.json` via
   `POST /api/roles` and take effect on the next stage call. (Hand-editing `config.json` "roles" still works.)
   Planner options are every configured model (planning is text-only, so reasoner models are eligible).
3. For **workers**, set a task's Model dropdown to a tool-capable ref (e.g. `groq:llama-3.3-70b-versatile`).
   Reasoner models (`toolCalling:false`) can plan but are hidden from the Worker dropdown — they can't drive tools.
Nothing else changes; the orchestration logic is provider-agnostic. Missing key → a clear error in the UI.

**Adding a provider** is config-only: add a `clients` entry with `kind:"chat"`, `baseURL`, `apiKeyEnv` and a
`models` list. The 🔑 panel and every model dropdown pick it up automatically (no restart — `loadClients()`
re-reads config per call). Aggregator ids containing `/` and `:free` work: `resolveOne` splits on the FIRST
colon, so `openrouter:nvidia/nemotron-3-super-120b-a12b:free` parses correctly.

**Verify model ids against the provider** — catalogues churn and a dead id only surfaces as a 404 mid-run:
```
node verify-models.mjs          # all chat clients (skips ones with no key)
node verify-models.mjs groq     # just one
```
It reports ✓/✗ per configured id plus a sample of live ids you haven't configured. This caught DeepSeek
retiring `deepseek-chat`/`deepseek-reasoner` in favour of `deepseek-v4-flash`/`deepseek-v4-pro`. Note it
verifies **listing only** — a ✓ is not proof you can call it (Gemini lists models its own key rejects).

**Build model metadata from evidence** — `capabilities` is no longer hand-guessed:
```
node build-models.mjs                       # probe CONFIGURED models, dry run
node build-models.mjs --write               # ...apply (backs up config.json.bak)
node build-models.mjs groq --discover --limit=25 --write
```
Per model it runs a tiny completion (usable?) then, *if the catalogue doesn't already say*, a tiny tool
call (tool-capable?), and writes `capabilities.toolCalling` + a `verifiedAt` date. Design rules, each
learned from a real failure:
- **The catalogue outranks the probe where it speaks.** Some providers publish tool support in
  `/models` — Groq as `supported_features: ["tools","json_mode"]`, OpenRouter as
  `supported_parameters: ["tools","tool_choice",…]` — and the script already fetches that catalogue for
  pricing. A declaration is *better* evidence than a probe (the provider's own answer, no tokens, and it
  can't false-negative), so it short-circuits `probeTools` entirely. Only a **positive** declaration
  counts: a list that exists but omits "tools" is read as silence, not a denial, and is still probed —
  the same asymmetry applied to the catalogue. Providers whose entries carry no such field (Gemini
  returns only `id`/`object`/`owned_by`/`display_name`) are unaffected and still probed.
- **Scope defaults to configured models.** Discovery costs tokens per probe (OpenRouter lists 341), so
  it's opt-in via `--discover`, capped by `--limit`.
- **An unreachable verdict never edits config.** 402/429/rate-limit ⇒ "couldn't tell" ⇒ left untouched;
  only a genuine *model does not exist* removes an entry. An empty balance can't delete your models.
- **Evidence is asymmetric.** A tool call PROVES capability; a text-only reply only suggests its absence
  (models decline at random). So a confirmed `true` is never downgraded by an inferred `false` — without
  this the same model reported ✓ then ✗ across consecutive runs and the metadata was worthless.
- Hand-set fields (e.g. `reasoning`) are merged, not clobbered. Providers that state it outright
  (Groq: "`tool calling` is not supported with this model") are recorded as a definitive ✗.

**Cost & access labels.** The same probe answers the two questions you actually ask when picking a
model, and writes them per model for the UI dropdowns to show as `ref · label`:
- `access: 'ok' | 'blocked'` — `ok` means this key completed a real call just now. `blocked` is set
  *only* by a balance/billing refusal (a definite answer about access, even though it says nothing
  about capabilities); rate limits and outages leave the previous label alone.
- `cost: 'free' | 'free-tier' | 'paid' | 'subscription'` — an account-level `costTier` on the client
  outranks published pricing, because they answer different questions: Groq prices every model per
  token yet serves them free to a key with no billing, so its rate card would label the whole client
  "paid" and be wrong in the direction that matters. Pricing decides only where the provider bills
  strictly per-token (OpenRouter); `costTier` covers the rest, and the Claude CLI (never probed —
  no `/models` endpoint) inherits `subscription` via `listModels()`.

Blocked models stay selectable and sort last in the dropdowns: the block is about today's balance,
not the config, so it must not silently drop a role assignment.

**Rate coding ability** — `node rank-coding.mjs [client] [--runs=3] [--write]`. Four small problems
(`coding-probes.mjs`, 20 assertions) are put to each model and the replies are executed against
hidden tests; the median score over `--runs` becomes `codingScore` + `codingTier` on the model.
Same rules as above — an unreachable model is reported `unrated` and never written, because scoring
silence as 0 would brand it `weak` and steer the planner away from it permanently.
- **One run is not a measurement.** `gpt-oss-20b` scored 1.00 then 0.60 on consecutive passes and
  `nemotron` 1.00 then 0.70; writing code is a sampling decision. Use `--runs=3`; `codingRuns` in
  config records how many samples backed the number.
- **Watch `maxTokens`.** At 900 the cap silently truncated longer answers into syntax errors and
  three unrelated models produced an identical `topoSort:0 parseCsvLine:0` signature — that was the
  harness, not the models. 1500 fixed it. An identical failure pattern across models is the tell.
- **Memorisation inflates it.** LRUCache is LeetCode #146 and nearly everything aces it; `topoSort`
  and `parseCsvLine` are what actually discriminate. Read the per-probe detail, not the total.
- **Free tiers bind.** Gemini allows 20 requests/DAY on `gemini-3.6-flash` — one full pass over four
  Gemini models is 16. Rate one client at a time.

### Why the planner sent everything to Claude
Two causes, and the first one is not the orchestrator's fault:
1. `MASTER_PROMPT.md` said so outright ("synthesis → `claude:opus`, extraction → `claude:sonnet`").
   Planner guidance in the master prompt overrides anything the orchestrator suggests.
2. The prompt handed the planner a bare list of `client:model` strings next to "cheaper models for
   trivial work, stronger models for complex work" — without saying which was cheap or strong. Given
   no basis to choose, a model picks on name recognition, and Claude is *the* name in coding agents.
   Claude also sat first in the list (`DEFAULT_CLIENTS` spreads first) and was the hardcoded default.

Fixed by `workerModelMenu()` in server.js: one menu shared by the plan and split prompts, listing
each ref with its cost and coding tier, excluding `access: 'blocked'` models (assigning one produces
a task that dies on a balance error), and defaulting to the first usable ref instead of
`claude:sonnet`. Verified with a neutral master prompt: the planner assigned 0 of 9 tasks to Claude,
putting `llama-3.1-8b` (mid) on scaffolding/typo/README and `gemini-3.5-flash-lite` (strong, free)
on the storage layer and its tests.

### The PLANNER must be capable enough to follow a routing rule
Routing policy is only as good as the model reading it. With identical prompts
(master prompt + `MODEL_CHOICE_RULES`, both saying "default to Claude, free
models only for small tasks, never Groq for workers"):

| Planner | Result |
|---|---|
| `groq:openai/gpt-oss-120b` | Ignored it — 15 of 16 tasks onto Groq, the one option explicitly forbidden. |
| `claude:sonnet` | Followed it exactly — 13 `claude:sonnet`, 1 `claude:opus` for the judgment task, and `gemini-3.5-flash-lite` on precisely the two small courses (4 and 14 files). Zero Groq. |

So a weak planner does not merely plan worse, it silently overrides your cost
policy — and the damage only appears when the run dies. Keep the planner role on
a strong model; it is one completion per run, the cheapest place to spend.

### What it takes for a non-Claude model to actually be a WORKER
A coding score says a model can write a correct function. It says nothing about
surviving a 25-turn tool loop, which is where every real failure was. From one
16-task run (all 16 aborted) and the single-task runs that followed:

- **Retry transient errors, honouring the provider's own retry-after.** The
  executor treated any model error as fatal, so 13 of 16 tasks died on 429s that
  said "try again in 1.605s". Now retried up to `chatAttempts` (5).
- **"Request too large" is NOT a rate limit**, even though Groq returns it with
  `rate_limit_exceeded` and TPM wording. It is deterministic — the transcript
  exceeds what one request may carry — so it must fail fast instead of burning
  the retry budget. Checked before RETRYABLE, which its message also matches.
- **Echo the provider's assistant message verbatim.** Rebuilding it from parsed
  content + toolCalls drops provider fields; Gemini then rejects the next turn
  with "Function call is missing a thought_signature", killing every Gemini
  worker one call in. `chat()` already returned `raw` — the executor just
  ignored it. This single fix took a Gemini worker from 1 tool call to 25.
- **Recover from invented tool names.** Providers reject the whole request
  (Groq: 400 `tool_use_failed`) before anything runs, so it is recoverable
  in-band: tell the model which tools exist and retry, rather than lose the task.
- **The sandbox must be able to read `context/`.** Every worker prompt points at
  `context/kb-guardrails.md`, but that lives outside the target project and
  `resolvePath` rejected it — so only the unsandboxed Claude CLI could ever obey.
  `createToolRunner` now takes read-only `readRoots`; writes stay confined.
- **Tool RESULTS are the token cost, not tool schemas.** Measured: the 9 schemas
  are 919 tokens resent every request (~11% of a free tier's budget), while a
  single tool result is capped at 8000 chars ≈ 2162 tokens and stays in the
  transcript forever — four file reads exceed the whole budget on their own.
  Pruning schemas per-call is also impossible in principle: you cannot know
  which tool the model will reach for next. So the fixes are (a) `read_file`
  now honours `line_start`/`line_end` — it never declared them, so models kept
  passing them and silently got whole 48KB files back, three times in one task
  — and (b) `compactTranscript()` elides older results once the transcript
  passes `transcriptBudgetChars`, giving up recent results before the budget so
  a small-context setting is actually honoured.
- **25 iterations was too few.** Orienting in a 4,200-file vault plus a 48KB
  spec consumed the budget and the worker died holding a finished artifact it
  never committed. Now 40.

**Token limits in config** — `build-models.mjs` now records a `limits` block per
model, and the planner menu shows the one number that decides routing:
```json
"limits": { "contextTokens": 131072, "maxOutputTokens": 65536,
            "tokensPerWindow": 8000, "requestsPerWindow": 1000,
            "effectiveRequestTokens": 8000, "budgetBasis": "measured" }
```
- `effectiveRequestTokens = min(contextTokens, tokensPerWindow)` is the only
  figure worth routing on. Groq advertises `context_length: 131072` on every
  model while its free tier caps a request at 6k–12k — the catalogue number is
  **16x optimistic**, which is what made a task die on a 413 that "couldn't
  happen" against a 131k window.
- `budgetBasis` says how much to trust it. `measured` = the provider returned
  `x-ratelimit-limit-tokens` on a real call (only Groq does). `catalogue` = we
  know the model's advertised context and nothing about your key, so treat it as
  an upper bound (OpenRouter's 262k). Gemini reports neither, so it carries no
  limits at all — absent rather than guessed.
- `execution/agent.js` derives `transcriptBudgetChars` from it
  (`effectiveRequestTokens × 0.5 × 3.7 chars`), leaving room for the ~919 tokens
  of tool schemas, the prompt and the reply. So compaction is sized per model
  instead of one global default.

**Free-tier verdict for agentic work** (this is the constraint that matters, and
it is not the coding score):

| Provider | Verdict as a worker |
|---|---|
| Groq | **Impractical.** Compaction fixed the 413 (5 → 24 tool calls), but 8k tokens/minute is a throughput wall: a working turn costs ~5.8k tokens, so one request nearly spends the whole minute and the task stalls at ~1 turn/min. Fine for planning, not for a 40-turn worker. |
| Gemini flash-lite | **Works.** 1M context, no 413. Drove `kb_scan.py`, read the manifest, wrote a valid deliverable. Watch the daily request quota. |
| Claude CLI | Works, unsandboxed, no TPM wall — the reliable option, at subscription cost. |

## Progress log
- _2026-07-29_ — **Claude-by-default routing.** `MODEL_CHOICE_RULES` inverted:
  the default is now a subscription model, with free models reserved for tasks
  the planner judges genuinely small (and told to treat "in doubt" as not
  small). The vault template adds the matching kb-specific exception — a small
  `activate` course (≤ ~15 files) may use `gemini:gemini-3.5-flash-lite`, never
  Groq for workers. Planner role moved to `claude:sonnet` after a Groq planner
  ignored the policy outright (see above).
- _2026-07-29_ — **Made chat clients viable as workers.** Five fixes in
  `agent/executor.js`, `agent/toolRunner.js`, `execution/agent.js`, `shared.js`:
  retry-with-retry-after, fail-fast on request-too-large, verbatim assistant
  echo (Gemini `thought_signature`), unknown-tool recovery, read-only
  `readRoots` for `context/`, and maxIterations 25 → 40. Measured on one real
  task: Groq gpt-oss-20b went 1 → 5 productive tool calls before hitting an
  unfixable 413; Gemini 3.5-flash-lite went 1 → 25 and wrote a valid
  `vuca MAP.md`. See the worker section above for the free-tier verdict.
- _2026-07-29_ — **Coding-ability rating + planner routing.** New `rank-coding.mjs` /
  `coding-probes.mjs`; `codingScore`/`codingTier`/`codingRuns` now on 10 models. `workerModelMenu()`
  replaces the bare ref list in both planner prompts and excludes blocked models. Dropdowns read
  `ref · free tier · coding: strong`. Verified: with a neutral master prompt the planner assigned
  **0 of 9 tasks to Claude** (was 9 of 11), routing trivial work to `llama-3.1-8b` and the storage
  layer + tests to `gemini-3.5-flash-lite`. Still `unrated` — `gemini-3.6-flash`, `gemini-3.5-flash`,
  `qwen/qwen3.6-27b`, `gemma-4-31b-it:free` (daily quota exhausted); re-run per client to fill in.
- _2026-07-29_ — **Trust the catalogue for `toolCalling`.** `build-models.mjs` now skips `probeTools`
  when the `/models` entry declares tool support (`supported_features` / `supported_parameters`
  containing `"tools"`), via `declaresTools(entry)`; the row prints `tools=✓ (declared)`. Measured on
  `node build-models.mjs groq`: **13 HTTP calls → 6** (8.7s → 4.3s), all 5 models still ✓, no metadata
  changes. The baseline run also demonstrated the bug this removes: `qwen/qwen3.6-27b` declined the
  probe tool on all 3 attempts and was only saved from a `false` by the asymmetry rule. OpenRouter's
  `nvidia/nemotron-3-super-120b-a12b:free` resolves the same way via `supported_parameters`; Gemini's
  catalogue carries no such field, so it is still probed.
- _2026-07-28_ — **Cost/access labels.** `build-models.mjs` now also records `cost` + `access` per
  model (client `costTier` in config; OpenRouter pricing read from its catalogue). `listModels()`
  passes them through; both model dropdowns render `ref · free tier` / `ref · ⚠ needs billing · paid`
  and sort blocked models last. Current state: **14 usable, all free** (3 Claude CLI, 4 Gemini flash,
  5 Groq, 2 OpenRouter `:free`); 8 blocked on billing (DeepSeek ×2, OpenAI ×2, OpenRouter paid ×4).
- _2026-07-27_ — Plan approved. Created this doc.
- _2026-07-27_ — **P0–P3 complete (near-term milestone done).** Model choice is now config/role-driven;
  Fable dependency gone (planner defaults to `claude:sonnet`). New: `clients/`, `agent/`, `execution/`,
  `roles.js`, `shared.js`, `performance.js`; `config.json` gains `clients`+`roles`; UI dropdown from
  `/api/models`. Verified end-to-end: Claude plan (planner emitted `claude:haiku` ref), native Claude
  worker wrote a file, agent tool-loop + path sandbox (offline mock), missing-key error, `/api/models`
  capability filtering, `performance.json` records. Claude paths behave identically (relocated, not changed).
  Deferred as planned: P4 (append_file/mkdir/glob/grep), P5 (Auditor route + auto-run), P6 (strategies).
  NOTE: the `/api/plan` verification regenerated `tasks.json`/`completed.json` (the prior task list was
  replaced by a test task, then reset to empty) — regenerate via **Generate Plan** with `MASTER_PROMPT.md`.
- _2026-07-27_ — **Roles now selectable in the UI.** Added `POST /api/roles` (validates role + `client:model`
  ref, merges into `config.json`) and a Panel-1 Planner dropdown + collapsible splitter/healer/lessoner/
  auditor selectors ([index.html](index.html), [main.js](main.js) `renderRoles`). Verified: change persists
  to config and is rejected for unknown refs. The "new planner" is now usable without hand-editing config.
- _2026-07-27_ — **P4 + P5 done.** P4: `append_file` / `mkdir` / `glob` (fs.globSync) / `grep` tools
  (path-sandboxed, structured). P5: Auditor stage — `runAudit`, `POST /api/audit`, opt-in `config.autoAudit`
  auto-run (`audit` SSE), 🔎 Audit modal. Verified: tools offline; auditor returned a `partial` verdict that
  correctly flagged a missing required file, and the UI rendered it. Enable auto-audit by adding
  `"autoAudit": true` to config.json. GOTCHA discovered: `POST /api/plan` overwrites **MASTER_PROMPT.md** as
  well as tasks.json — the original KB master prompt was restored after testing.
- _2026-07-27_ — **Planner Chat.** A running, multi-turn conversation with the configured planner model to
  co-write the master prompt. `roles.js` gained `chat(messages, {system})` (uses the client's native `chat()`
  for chat clients, flattens to a transcript for the Claude CLI). New durable state `planner_chat.json` +
  routes `GET/POST/DELETE /api/planner-chat`. UI: 💬 Planner Chat modal ([index.html](index.html),
  [main.js](main.js) `openPlannerChat`) with a "📥 Use last reply as Master Prompt" action (extracts a
  ```markdown fenced block if present) that fills the prompt box → Generate Plan. Verified end-to-end via
  Claude: multi-turn persists, master-prompt draft extracted, transcript survives refresh, DELETE clears.
- _2026-07-27_ — **P6: fallback providers.** A role may set `fallback` (a `client:model` ref or an ordered
  array). If the primary errors (missing key / HTTP / non-zero exit), the next candidate is tried
  (`roles.js` `runWithFallback`) — applies to every text stage AND Planner Chat. Default: planner
  `opus`→`claude:sonnet`. Verified: a DeepSeek primary (no key) fell back to `claude:sonnet` and returned a
  result; both attempts logged to performance.json with a `fallback` flag. Remaining P6 items still deferred.
  **P0–P5 complete; P6 partial. The model-agnostic plan is delivered.**
- _2026-07-28_ — **API keys without the shell.** New `env.js` loads a gitignored `.env` into `process.env`
  on import (imported FIRST in server.js, before shared.js snapshots `CHILD_ENV`) and upserts keys via
  `setEnvKey`. New `GET/POST /api/keys` + a 🔑 panel in Panel 1: paste a key → written to `.env` AND applied
  to the live process (no restart). The GET returns only `set` + a masked hint, never the value, and only an
  env var that is some client's `apiKeyEnv` is writable. Added `.env.example`, `.gitignore`, and
  `vite.config.js` `server.watch.ignored` for `.env` (the backend writing it was full-reloading the UI on
  every save). Verified end-to-end in the browser + across a restart.
- _2026-07-28_ — **Three providers + evidence-based metadata.** Added `gemini`, `groq`, `openrouter`
  clients (config-only; the sole code change was allowing `/` in `SAFE_MODEL` for `vendor/model` ids).
  New `verify-models.mjs` (listing check) and `build-models.mjs` (probe → write `capabilities`+`verifiedAt`).
  Findings worth keeping: DeepSeek had **retired** the configured `deepseek-chat`/`deepseek-reasoner` — the
  402 for an empty balance was masking a dead id, since billing is checked *before* model validity.
  Gemini's free tier is **flash-only** (every `pro` 429s) and its `/models` lists ids the key cannot call;
  it returns canonical `models/<id>` while chat takes the bare id. Tool-calling confirmed by real tool calls
  for all Gemini flash + Groq models. Config now: 6 clients / 25 models, 14 carrying `verifiedAt`.
  Also corrected stale entries in this doc (P1/P2 were shipped but unchecked; a `deepseek-reasoner` example;
  the auditor "scaffold only" note).
- _2026-07-28_ — **The prompts were not model-agnostic even though the plumbing was.** Switching the KB
  planner from `claude:opus` to `gemini` produced three clarifying questions instead of a plan. Root cause
  is a capability asymmetry inside `complete()`, not model quality: `clients/claude-cli.js` shells out to
  `claude --print` with a `cwd`, so a Claude planner **is a full agent and can read files**, while
  `clients/openai.js` `complete()` is one tool-less chat completion. Any prompt that says "read X first"
  silently works on Claude and is unfollowable everywhere else — the model can only report that it cannot
  comply. Fixed vault-side (`_system/prompts/orchestrator.md`, `scripts/kb_orchestrate.py`): the master
  prompt is now self-contained, with per-course formats and resolved deliverable paths substituted INLINE,
  file references relabelled as worker-facing, and an explicit "assume you have no tools" section.
  **Generalisable rule for this orchestrator: a text role (`planner`, `splitter`, `healer`, `lessoner`,
  `auditor`, `analyzer`) must be given every fact it needs in its prompt — only worker execution
  (`kind:"cli"` native, or the agent framework) has tools.** Audited the in-repo stage prompts and they
  already honour this: the analyzer states "Judge from the task text alone; do not read the repo"
  (`server.js`), and `runAudit` substitutes `git status` output into the prompt rather than asking the
  model to run it. The bug was confined to the externally-authored KB master prompt — i.e. the rule was
  understood here and simply never written down where a prompt author would see it. It is now written
  down: this bullet, and the "Assume you have NO tools" section of the KB prompt itself.
