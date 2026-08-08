// clients/index.js — the model-client registry + reference resolution.
//
// A "model reference" is the string "client:model" (e.g. "claude:opus",
// "deepseek:deepseek-chat"). Task.assigned_model uses this form. Legacy bare
// names ("sonnet") and dead refs ("fable") are normalised here so old
// tasks.json / plans keep working.

import { getClientsConfig, getRolesConfig } from '../shared.js';
import { makeClaudeClient } from './claude-cli.js';
import { makeOpenAIClient } from './openai.js';

// Build the client registry from config on each call. Cheap (a small JSON read +
// a few closures) and means config.json edits take effect without a restart —
// handy for repointing roles at a different provider.
export function loadClients() {
  const cfgs = getClientsConfig();
  const out = {};
  for (const [id, cfg] of Object.entries(cfgs)) {
    const kind = cfg.kind || (cfg.baseURL ? 'chat' : 'cli');
    out[id] = kind === 'chat' ? makeOpenAIClient(id, cfg) : makeClaudeClient(id, cfg);
  }
  return out;
}

export function getClient(id) {
  const client = loadClients()[id];
  if (!client) throw new Error(`Unknown client "${id}". Check config.json "clients".`);
  return client;
}

// Parse "client:model" (or a legacy bare "model" → claude). Returns the concrete
// { clientId, model, client } only when the model is DECLARED in the client's
// models list; otherwise null so the caller can fall back.
function resolveOne(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  let clientId;
  let model;
  if (s.includes(':')) {
    const i = s.indexOf(':');
    clientId = s.slice(0, i);
    model = s.slice(i + 1);
  } else {
    clientId = 'claude'; // legacy bare model name → the Claude CLI
    model = s;
  }
  const client = loadClients()[clientId];
  if (!client || !model) return null;
  const known = (client.models || []).some((m) => m.id === model);
  return known ? { clientId, model, client } : null;
}

// Resolve any ref to a usable model, with a fallback chain:
//   exact ref → planner role's model → any cli client's first model.
// This is what turns a dead "fable" (no longer a known model) into the
// configured planner model instead of a hard failure.
export function resolveModel(ref) {
  let r = resolveOne(ref);
  if (!r) {
    const planner = getRolesConfig().planner || {};
    r = resolveOne(`${planner.client}:${planner.model}`);
  }
  if (!r) {
    const cli = Object.values(loadClients()).find((c) => c.kind === 'cli' && (c.models || []).length);
    if (cli) r = { clientId: cli.id, model: cli.models[0].id, client: cli };
  }
  if (!r) throw new Error(`Cannot resolve model ref "${ref}" and no fallback is available.`);

  const entry = (r.client.models || []).find((m) => m.id === r.model);
  const caps = entry?.capabilities || {};
  return {
    ref: `${r.clientId}:${r.model}`,
    clientId: r.clientId,
    model: r.model,
    client: r.client,
    kind: r.client.kind,
    capabilities: caps,
    limits: entry?.limits,
    // Worker-eligible iff a native CLI agent (Claude) OR a chat model that
    // supports tool-calling. CLI clients don't expose chat() but ARE agents.
    execCapable: r.client.kind === 'cli' || !!caps.toolCalling,
  };
}

// Flat list of every declared model as "client:model" refs, with capabilities.
// Powers GET /api/models (UI dropdown + planner-prompt ref injection).
export function listModels() {
  const out = [];
  for (const [id, client] of Object.entries(loadClients())) {
    for (const m of client.models || []) {
      const caps = m.capabilities || {};
      out.push({
        ref: `${id}:${m.id}`,
        client: id,
        model: m.id,
        kind: client.kind,
        capabilities: caps,
        execCapable: client.kind === 'cli' || !!caps.toolCalling,
        // Labels written by build-models.mjs from a real call. Both are absent
        // until that script has probed the model, so the UI must treat "no
        // label" as "unknown", not as "free" or "broken".
        // Client costTier is the fallback for models the prober never sees —
        // the Claude CLI is skipped entirely (no /models, nothing to probe).
        cost: m.cost || client.costTier,
        access: m.access,
        accessNote: m.accessNote,
        // Measured by rank-coding.mjs. Absent = never rated, which the planner
        // prompt and the UI both render as "unrated" rather than assuming weak.
        codingTier: m.codingTier,
        codingScore: m.codingScore,
        limits: m.limits,
      });
    }
  }
  return out;
}
