// roles/index.js — role module registry + the generic run pipeline.
//
// Mirrors agent/tools/index.js's registration convention. Each module here
// answers "what is this role's job" (buildPrompt/normalize); roles.js (repo
// root) answers "which model backs it, with what fallback" (resolveRole).
// runRole() is what used to be 5 near-identical build→call→parse→normalize
// blocks inline in server.js — one per role, now unified.
import { resolveRole } from '../roles.js';
import { extractJson } from './shared.js';
import planner from './planner.js';
import splitter from './splitter.js';
import healer from './healer.js';
import lessoner from './lessoner.js';
import auditor from './auditor.js';
import analyzer from './analyzer.js';
import recipeCurator from './recipeCurator.js';

const REGISTRY = { planner, splitter, healer, lessoner, auditor, analyzer, recipeCurator };

export function getRoleModule(id) {
  const mod = REGISTRY[id];
  if (!mod) throw new Error(`Unknown role module "${id}".`);
  return mod;
}

// Build → call → parse → normalize. `ctx` carries whatever the role's
// buildPrompt/normalize need (see each module's ctx comment) plus optional
// `cwd` (passed through to the model call) and `completeOpts` for anything
// beyond cwd.
//
// Errors from the model call itself propagate as-is (caller maps to a 500 —
// "the model failed"). Errors from extractJson carry a `.raw` field the
// caller can surface (maps to a 502 — "the model answered, but not in the
// shape we asked for").
export async function runRole(id, ctx = {}) {
  const mod = getRoleModule(id);
  const prompt = mod.buildPrompt(ctx);
  const opts = { ...(ctx.completeOpts || {}) };
  if (ctx.cwd) opts.cwd = ctx.cwd;

  const raw = await resolveRole(id).complete(prompt, opts);

  if (mod.outputShape === 'text') {
    return mod.normalize ? mod.normalize(raw, ctx) : raw;
  }
  const parsed = extractJson(raw, mod.outputShape);
  return mod.normalize ? mod.normalize(parsed, ctx) : parsed;
}
