// execution/index.js — the ExecutionProvider dispatch.
//
// runTask() calls execute(ref, {...}) and doesn't care how execution happens.
// We route by the resolved client kind:
//   kind:"cli"  -> native.js   (spawn the provider's agent CLI; Claude today)
//   kind:"chat" -> agent.js    (drive the generic tool-using agent framework)
// and append a write-only performance record either way.
import { resolveModel } from '../clients/index.js';
import { executeNative } from './native.js';
import { executeAgent } from './agent.js';
import { recordPerformance } from '../performance.js';

// Returns { ok, detail?, summary? }. Never throws — a backend error resolves to
// { ok:false } so the caller's single finish() path handles it uniformly.
export async function execute(ref, { prompt, cwd, onOut, onErr, limits, signal } = {}) {
  const resolved = resolveModel(ref);
  const started = Date.now();

  let result;
  try {
    result =
      resolved.kind === 'cli'
        ? await executeNative({ ref: resolved.ref, prompt, cwd, onOut, onErr, signal })
        : await executeAgent({ ref: resolved.ref, prompt, cwd, onOut, onErr, limits, signal });
  } catch (e) {
    result = { ok: false, detail: e.message };
  }

  recordPerformance({
    role: 'worker',
    client: resolved.clientId,
    model: resolved.model,
    durationMs: Date.now() - started,
    success: !!result.ok,
    error: result.ok ? null : result.detail || null,
  });

  return result;
}
