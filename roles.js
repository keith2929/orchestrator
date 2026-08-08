// roles.js — the provider-agnostic planning seam.
//
// Every TEXT stage (planner, splitter, healer, lessoner, auditor, and the
// file-isolation analyzer) goes through resolveRole(name).complete(prompt). The
// stage code never names a provider or model — only a role. Swapping a role's
// backing model is a config.json edit, no code change.
//
// FALLBACK (P6): a role may declare `fallback` in config — a single "client:model"
// ref or an ordered array. If the primary model errors (missing API key, HTTP
// failure, non-zero CLI exit), the next candidate is tried, and so on. This makes
// a run resilient to a provider outage. Each attempt is recorded in
// performance.json (with `fallback: true` when it wasn't the primary).

import { getRolesConfig } from './shared.js';
import { getClient } from './clients/index.js';
import { recordPerformance } from './performance.js';

// Ordered [{ clientId, model }] to try: the primary, then any `fallback` refs.
function buildAttempts(cfg) {
  const attempts = [{ clientId: cfg.client, model: cfg.model }];
  const fb = cfg.fallback;
  const list = fb == null ? [] : Array.isArray(fb) ? fb : [fb];
  for (const raw of list) {
    const ref = String(raw || '').trim();
    if (!ref) continue;
    const i = ref.indexOf(':');
    if (i > 0) attempts.push({ clientId: ref.slice(0, i), model: ref.slice(i + 1) });
    else attempts.push({ clientId: 'claude', model: ref }); // legacy bare name → Claude CLI
  }
  return attempts;
}

// Try each candidate in order; return the first success; throw an aggregated
// error if all fail. `invoke(client, model)` performs the actual call.
async function runWithFallback(perfRole, attempts, invoke) {
  const errors = [];
  for (let k = 0; k < attempts.length; k++) {
    const { clientId, model } = attempts[k];
    const started = Date.now();
    try {
      const client = getClient(clientId); // clear error if the client is undefined
      const out = await invoke(client, model);
      recordPerformance({
        role: perfRole,
        client: clientId,
        model,
        durationMs: Date.now() - started,
        success: true,
        fallback: k > 0,
      });
      return out;
    } catch (e) {
      recordPerformance({
        role: perfRole,
        client: clientId,
        model,
        durationMs: Date.now() - started,
        success: false,
        error: e.message,
        fallback: k > 0,
      });
      errors.push(`${clientId}:${model} → ${e.message}`);
    }
  }
  throw new Error(`All models failed for "${perfRole}": ${errors.join(' | ')}`);
}

export function resolveRole(name) {
  const roles = getRolesConfig();
  // Every role in roles/index.js's registry has a DEFAULT_ROLES entry (see
  // shared.js) as of Phase 3, so this only matters for a name that isn't a
  // real role at all — falls back to the planner rather than hard-failing.
  const cfg = roles[name] || roles.planner || { client: 'claude', model: 'sonnet' };
  const { client: clientId, model, temperature, maxTokens } = cfg;
  const attempts = buildAttempts(cfg);

  return {
    role: name,
    clientId,
    model,
    // One-shot completion (all planning stages).
    async complete(prompt, opts = {}) {
      return runWithFallback(name, attempts, (client, m) =>
        client.complete(prompt, { model: m, temperature, maxTokens, ...opts })
      );
    },
    // Multi-turn conversation (Planner Chat). Uses the client's native chat()
    // when available (chat clients), else flattens the transcript into a single
    // completion (the Claude CLI has no chat API).
    async chat(messages, opts = {}) {
      const sys = opts.system;
      return runWithFallback(`${name}:chat`, attempts, async (client, m) => {
        if (typeof client.chat === 'function') {
          const msgs = sys ? [{ role: 'system', content: sys }, ...messages] : messages;
          const res = await client.chat(msgs, { model: m, temperature, maxTokens });
          return res.content;
        }
        const transcript =
          (sys ? sys + '\n\n' : '') +
          messages
            .map((mm) => `${mm.role === 'assistant' ? 'Assistant' : 'User'}: ${mm.content}`)
            .join('\n\n') +
          '\n\nAssistant:';
        return client.complete(transcript, { model: m, temperature, maxTokens });
      });
    },
  };
}
