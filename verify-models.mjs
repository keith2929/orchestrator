// verify-models.mjs — check the model ids in config.json against what each
// provider actually serves. Model catalogues churn (providers rename/retire ids
// constantly), so a hand-written config drifts silently until a task run dies
// with a confusing 404 mid-build. This asks each provider directly.
//
//   node verify-models.mjs           # check every configured chat client
//   node verify-models.mjs groq      # check one client
//
// Reads keys the same way the server does (.env via env.js, or the shell), so a
// key pasted into the UI's 🔑 panel is picked up with no extra setup. Clients
// with no key are reported as SKIPPED, not failed.
//
// LIMITS — a ✓ here means the id is LISTED, not that you can use it:
//   - Gemini lists models its own key can't call ("no longer available to new
//     users"), and gates every `pro` model behind billing (429 on the free tier).
//   - Tool-calling is never reported by /models. Both were confirmed for the
//     configured models by real calls; re-confirm the same way if you add one.

import './env.js';
import { getClientsConfig } from './shared.js';

const only = process.argv[2];
const clients = getClientsConfig();

// GET {baseURL}/models — the OpenAI-compatible discovery endpoint. Returns the
// set of live model ids, or throws with a short reason.
async function liveModels(cfg) {
  const base = String(cfg.baseURL || '').replace(/\/+$/, '');
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : '';
  const resp = await fetch(`${base}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  }
  const data = await resp.json();
  const list = Array.isArray(data?.data) ? data.data : [];
  // Gemini lists canonical resource names ("models/gemini-3.5-flash") but its
  // chat endpoint takes the bare id — compare without the prefix so a correct
  // config isn't reported as missing.
  return new Set(list.map((m) => String(m.id).replace(/^models\//, '')));
}

let problems = 0;

for (const [id, cfg] of Object.entries(clients)) {
  if (only && id !== only) continue;
  const kind = cfg.kind || (cfg.baseURL ? 'chat' : 'cli');
  if (kind !== 'chat') {
    console.log(`\n${id}: SKIP (kind "${kind}" — no /models endpoint)`);
    continue;
  }
  if (cfg.apiKeyEnv && !process.env[cfg.apiKeyEnv]) {
    console.log(`\n${id}: SKIP — no ${cfg.apiKeyEnv} set. Add it in the UI's 🔑 panel, then re-run.`);
    continue;
  }

  process.stdout.write(`\n${id}: querying ${cfg.baseURL}/models … `);
  let live;
  try {
    live = await liveModels(cfg);
  } catch (e) {
    console.log(`ERROR\n  ${e.message}`);
    problems++;
    continue;
  }
  console.log(`${live.size} models live`);

  const configured = (cfg.models || []).map((m) => m.id);
  for (const m of configured) {
    console.log(`  ${live.has(m) ? '✓' : '✗ MISSING'}  ${m}`);
    if (!live.has(m)) problems++;
  }

  // Surface a few live ids that aren't in config yet — handy for spotting a
  // renamed model (e.g. the "-latest" or dated variant that replaced yours).
  const extra = [...live].filter((m) => !configured.includes(m)).sort();
  if (extra.length) {
    console.log(`  … ${extra.length} more available, e.g.: ${extra.slice(0, 8).join(', ')}`);
  }
}

console.log(
  problems
    ? `\n${problems} problem(s) found — fix the ids in config.json "clients".`
    : '\nAll configured models verified.'
);
