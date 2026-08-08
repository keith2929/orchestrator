// shared.js — cross-module constants + config.json access.
//
// These used to live inline in server.js. They are extracted here so the new
// clients/, agent/, and execution/ modules can reuse them WITHOUT importing
// server.js (which would create an import cycle). server.js imports the same
// constants from here so there is a single source of truth.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// On Windows the `claude` on PATH is a `.cmd`/`.ps1` shim that Node's
// spawn/execFile can't launch directly — we run through the shell there.
export const IS_WIN = process.platform === 'win32';

// Non-interactive environment for every subprocess we spawn (the claude CLI and
// the agent's run_bash tool). CI=true makes many CLIs skip interactive prompts,
// so tasks can install/build unattended instead of skipping a step "to be safe".
export const CHILD_ENV = { ...process.env, CI: 'true', npm_config_yes: 'true' };

// config.json lives next to this file (repo root). Single canonical path.
export const CONFIG_PATH = path.join(__dirname, 'config.json');

// Where the user's reference/context files live. This sits OUTSIDE every target
// project, so the agent sandbox is handed it as an explicit read-only root (see
// createToolRunner's `readRoots`) — otherwise the worker prompt points at files
// the worker is forbidden to open.
export const CONTEXT_DIR = path.join(__dirname, 'context');

// ---------------------------------------------------------------------------
// Built-in defaults. When config.json has no `clients`/`roles`, the tool must
// still work exactly as before — Claude-only, no API keys required. Defaults
// keep the orchestrator bootable on a fresh/old config.
// ---------------------------------------------------------------------------
export const DEFAULT_CLIENTS = {
  claude: {
    kind: 'cli',
    // process.env.CLAUDE_BIN honored for back-compat with the old server.js.
    bin: process.env.CLAUDE_BIN || 'claude',
    models: [
      { id: 'opus', capabilities: { toolCalling: false, reasoning: true } },
      { id: 'sonnet', capabilities: { toolCalling: false } },
      { id: 'haiku', capabilities: { toolCalling: false } },
    ],
  },
};

// planner was previously hardwired to `fable` (now gone) → default to a live
// Claude model so planning keeps working with zero configuration.
export const DEFAULT_ROLES = {
  planner: { client: 'claude', model: 'sonnet' },
  splitter: { client: 'claude', model: 'opus' },
  healer: { client: 'claude', model: 'sonnet' },
  lessoner: { client: 'claude', model: 'sonnet' },
  auditor: { client: 'claude', model: 'opus' },
};

// ---------------------------------------------------------------------------
// Rate/usage-limit detection.
// ---------------------------------------------------------------------------
// A provider limit ("You've hit your session limit · resets 1:20pm") is a
// GLOBAL, TEMPORARY condition, not a defect in the task being run. The CLI
// prints it and exits non-zero, which is indistinguishable from a real failure
// unless we look at the text — so a single limit used to burn the entire queue
// in seconds (12 tasks in ~60s on 2026-08-06) and leave every one of them
// marked aborted, which the sequential runner then skipped silently forever.
//
// IMPORTANT: only ever run this over the output of a run that ALREADY FAILED.
// A task whose job is to implement rate limiting will legitimately print these
// words on a successful run, and pausing the queue over that would be worse
// than the bug this fixes.
const RATE_LIMIT_RE = new RegExp(
  [
    "hit your (?:session|usage|weekly|monthly|daily) limit",
    'quota exceeded',
    'exceeded your (?:current )?quota',
    'insufficient_quota',
    'rate[ _-]?limit(?:ed|ing)?',
    'too many requests',
    'resource[ _-]?exhausted',
    'overloaded_error',
    '(?:status|code|http)[^0-9]{0,10}429',
  ].join('|'),
  'i'
);

// Returns { reason } when `text` looks like a provider limit, else null.
// `reason` is the offending line (trimmed/capped) so the UI can surface the
// reset time the provider gave us.
export function detectRateLimit(text) {
  const s = String(text || '');
  if (!RATE_LIMIT_RE.test(s)) return null;
  const line = s.split(/\r?\n/).find((l) => RATE_LIMIT_RE.test(l)) || '';
  return { reason: line.trim().slice(0, 200) || 'provider rate/usage limit' };
}

// Read + parse config.json, failing soft to an empty object.
export function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Client definitions from config, falling back to the Claude-only default.
// A config that defines `clients` but omits `claude` still gets the default
// claude client merged in, so the CLI path is always available.
export function getClientsConfig() {
  const cfg = readConfig();
  const clients = cfg.clients && typeof cfg.clients === 'object' ? cfg.clients : {};
  return { ...DEFAULT_CLIENTS, ...clients };
}

// Role→model map from config, falling back to Claude-only defaults per role.
export function getRolesConfig() {
  const cfg = readConfig();
  const roles = cfg.roles && typeof cfg.roles === 'object' ? cfg.roles : {};
  return { ...DEFAULT_ROLES, ...roles };
}
