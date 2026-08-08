// env.js — zero-dependency .env loader + writer for provider API keys.
//
// The chat clients read their key from process.env[<apiKeyEnv>] at call time
// (see clients/openai.js). Nothing populated process.env from a file, so keys
// had to be `export`ed in the shell BEFORE ./run.sh — easy to forget because the
// launcher detaches the servers, so a missing key only surfaces when a role
// fails mid-run. This module:
//   - loads a gitignored .env into process.env at startup (on import), and
//   - lets the UI (POST /api/keys) upsert a key into .env AND apply it to the
//     running process, so a newly-pasted key works without a restart.
// No external dependency — keeps the "no deps" backend intact.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env lives next to this file (repo root), like config.json.
export const ENV_PATH = path.join(__dirname, '.env');

// Parse one line into { key, value } or null. Supports `KEY=value`,
// `export KEY=value`, and single/double-quoted values. Intentionally tiny —
// not a full dotenv spec, just enough for API-key lines.
function parseLine(line) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!m) return null;
  let val = m[2];
  if (
    val.length >= 2 &&
    ((val[0] === '"' && val[val.length - 1] === '"') ||
      (val[0] === "'" && val[val.length - 1] === "'"))
  ) {
    val = val.slice(1, -1);
  }
  return { key: m[1], value: val };
}

// Parse .env text into a plain { KEY: value } object (comments/blanks ignored).
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kv = parseLine(line);
    if (kv) out[kv.key] = kv.value;
  }
  return out;
}

// Read + parse .env, failing soft to {} when the file is absent/unreadable.
export function readEnvFile() {
  try {
    return parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// Load .env into process.env WITHOUT clobbering a var already set in the real
// environment — an exported shell var wins (matches dotenv semantics). An empty
// existing value ('') is treated as unset so a real key in .env can fill it.
// Returns how many vars were loaded.
export function loadEnv() {
  const parsed = readEnvFile();
  let loaded = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
      loaded++;
    }
  }
  return loaded;
}

// Upsert `name=value` in .env (preserving other lines/comments) and apply it to
// process.env immediately so the running server can use it without a restart.
// An empty/null value REMOVES the key from both the file and the process.
// Returns true when a value was set, false when it was cleared.
export function setEnvKey(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}`);
  }
  const val = value == null ? '' : String(value);
  // A newline would corrupt the file / smuggle in extra vars — reject it.
  if (/[\r\n]/.test(val)) throw new Error('API key value must not contain newlines.');

  let lines;
  try {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }

  const rendered = val === '' ? null : `${name}=${val}`;
  let replaced = false;
  const next = [];
  for (const line of lines) {
    const kv = parseLine(line);
    if (kv && kv.key === name) {
      if (rendered && !replaced) next.push(rendered); // keep first hit, drop dups
      replaced = true; // an empty value drops the line entirely
      continue;
    }
    next.push(line);
  }
  if (!replaced && rendered) next.push(rendered);

  // Normalise to exactly one trailing newline (no growing blank tail).
  while (next.length && next[next.length - 1].trim() === '') next.pop();
  const text = next.length ? next.join('\n') + '\n' : '';
  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
  // Best-effort tighten perms on an existing file (may be a no-op on vboxsf).
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    /* shared folders may not support chmod */
  }

  if (val === '') delete process.env[name];
  else process.env[name] = val;
  return val !== '';
}

// Load on import so process.env is populated before any other module (and its
// CHILD_ENV snapshot in shared.js) is evaluated. Placing this module's import
// first in server.js is what makes that ordering hold.
const _loaded = loadEnv();
if (_loaded) console.error(`[env] loaded ${_loaded} var(s) from .env`);
