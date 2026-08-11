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
import { readConfig, detectRateLimit } from '../shared.js';

// Phase 4: config.json's top-level "workerFallback" — a single "client:model"
// ref or an ordered array — is availability config (what else CAN run a task
// right now), not something the planner decides per task: it has no signal
// about what's rate-limited at run time. Consulted only when the PRIMARY
// assigned_model fails with a rate/session-limit signature; any other failure
// (bad code, wrong tool call) would fail identically on the next model too, so
// falling through would just burn quota for nothing.
function workerFallbackChain(ref) {
  const cfg = readConfig();
  const raw = cfg.workerFallback;
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  return list.map((r) => String(r || '').trim()).filter((r) => r && r !== ref);
}

async function runOne(ref, { prompt, cwd, onOut, onErr, limits, signal }, fallback) {
  const resolved = resolveModel(ref);
  const started = Date.now();

  // Captured independently of the caller's onOut/onErr so a fallback decision
  // can be made after this attempt without affecting what the caller sees —
  // the real stream still forwards through untouched.
  let capturedOut = '';
  let capturedErr = '';
  const wrapOut = (t) => {
    capturedOut += t;
    onOut && onOut(t);
  };
  const wrapErr = (t) => {
    capturedErr += t;
    onErr && onErr(t);
  };

  let result;
  try {
    result =
      resolved.kind === 'cli'
        ? await executeNative({ ref: resolved.ref, prompt, cwd, onOut: wrapOut, onErr: wrapErr, signal })
        : await executeAgent({ ref: resolved.ref, prompt, cwd, onOut: wrapOut, onErr: wrapErr, limits, signal });
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
    fallback,
  });

  if (result.ok) return { result, limited: null };
  const limited = detectRateLimit(`${capturedOut}\n${capturedErr}\n${result.detail || ''}`);
  return { result, limited };
}

// Returns { ok, detail?, summary? }. Never throws — a backend error resolves to
// { ok:false } so the caller's single finish() path handles it uniformly.
export async function execute(ref, opts = {}) {
  const { result: primaryResult, limited } = await runOne(ref, opts, false);
  if (primaryResult.ok || !limited) return primaryResult;

  const chain = workerFallbackChain(ref);
  let last = primaryResult;
  for (const candidate of chain) {
    if (opts.signal && opts.signal.aborted) return last;
    if (opts.onOut) {
      opts.onOut(`\n[worker fallback] ${ref} hit a limit — trying ${candidate}…\n`);
    }
    const { result, limited: stillLimited } = await runOne(candidate, opts, true);
    last = result;
    if (result.ok || !stillLimited) return result;
  }
  return last;
}
