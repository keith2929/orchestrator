// core/taskState.js — the durable, per-task record of "what is task X doing
// and what has happened to it", replacing the old running.json/completed.json/
// aborted.json + in-memory runningControllers split. setTaskState is the
// single writer; every other exported function is a pure read/derive over
// the record shape or a thin convenience wrapper around it.
//
// Record shape (see HARDENING_PLAN.md step 4):
// {
//   status: 'pending'|'in_progress'|'done'|'failed'|'blocked'|'needs_verification',
//   attempts: number,
//   retries: number,
//   lastResult: { ok, detail, signature, at } | null,
//   current: { owner, leaseUntil, startedAt, lastOutputAt, lastRepoChangeAt, gitBaseline } | null,
//   history: [{ attempt, startedAt, endedAt, outcome, signature }],
// }
import { readJson, writeJson } from './jsonStore.js';

function defaultRecord() {
  return { status: 'pending', attempts: 0, retries: 0, lastResult: null, current: null, history: [] };
}

// Migration: if task_state.json doesn't exist yet, synthesize one from the
// legacy completed.json/aborted.json arrays so upgrading mid-run doesn't
// forget what already finished.
export function readTaskState(file, legacy) {
  const existing = readJson(file, null);
  if (existing && typeof existing === 'object') return existing;
  if (!legacy) return {};
  const state = {};
  for (const id of legacy.completed || []) {
    state[id] = { ...defaultRecord(), status: 'done', attempts: 1 };
  }
  for (const id of legacy.aborted || []) {
    if (state[id]) continue;
    state[id] = { ...defaultRecord(), status: 'blocked', attempts: 1 };
  }
  return state;
}

// The only writer. Merges `patch` into the record for `id`, writes
// task_state.json, and re-derives completed.json/aborted.json in the same
// call so every legacy reader keeps working unchanged.
export function setTaskState(file, id, patch, { completedFile, abortedFile } = {}) {
  const state = readTaskState(file);
  const existing = state[id] || defaultRecord();
  const record = { ...existing, ...patch };
  state[id] = record;
  writeJson(file, state);
  if (completedFile) writeJson(completedFile, completedIds(state));
  if (abortedFile) writeJson(abortedFile, abortedIds(state));
  return record;
}

// Begins a new attempt on `id`: bumps attempts, moves status to
// 'in_progress', and captures the owner/lease/gitBaseline evidence a future
// crash-recovery pass needs. owner is metadata only — no code may branch on
// agentId/pid/session.
export function startAttempt(file, id, { owner, leaseMs = 60000, gitBaseline } = {}) {
  const state = readTaskState(file);
  const existing = state[id] || defaultRecord();
  const now = Date.now();
  const record = {
    ...existing,
    status: 'in_progress',
    attempts: existing.attempts + 1,
    current: {
      owner: owner || null,
      leaseUntil: now + leaseMs,
      startedAt: now,
      lastOutputAt: now,
      lastRepoChangeAt: now,
      gitBaseline: gitBaseline || null,
    },
  };
  state[id] = record;
  writeJson(file, state);
  return record;
}

// Ends the current attempt on `id` with a terminal or requeue outcome,
// appending a history row and clearing `current`.
export function endAttempt(file, id, outcome, { detail, signature, retries } = {}) {
  const state = readTaskState(file);
  const existing = state[id] || defaultRecord();
  const current = existing.current;
  const now = Date.now();
  const history = existing.history.concat([
    {
      attempt: existing.attempts,
      startedAt: current ? current.startedAt : now,
      endedAt: now,
      outcome,
      signature: signature || null,
    },
  ]);
  const record = {
    ...existing,
    status: outcome,
    current: null,
    retries: typeof retries === 'number' ? retries : existing.retries,
    lastResult: { ok: outcome === 'done', detail: detail || null, signature: signature || null, at: now },
    history,
  };
  state[id] = record;
  writeJson(file, state);
  return record;
}

export function completedIds(state) {
  return Object.keys(state).filter((id) => state[id].status === 'done');
}

export function abortedIds(state) {
  return Object.keys(state).filter((id) => state[id].status === 'blocked' || state[id].status === 'aborted');
}

// Projection replacing the old running.json — every id currently 'in_progress'.
export function runningEntries(state) {
  return Object.keys(state)
    .filter((id) => state[id].status === 'in_progress')
    .map((id) => ({ taskId: id, startTime: (state[id].current && state[id].current.startedAt) || Date.now() }));
}

// Step 5 — crash recovery. Pure: takes evidence as arguments (a task_state.json
// record — optionally carrying a `greenTest` field the caller copies over from
// tasks.json — the CURRENT git state, and whether every dependency is done)
// and returns which branch of the recovery ladder applies. It never reads
// files or runs git itself, so it is unit-testable without a filesystem.
//
// Ladder (see HARDENING_PLAN.md step 5):
//   1. id already done                                -> 'done'
//   2. repo unchanged vs gitBaseline AND no output     -> 'pending' (attempt not counted)
//   3. repo changed AND task has a green_test          -> 'verify'
//   4. repo changed, no green_test                     -> 'needs_verification'
//   5. a dependency is not done                        -> 'pending'
export function classifyInterrupted(record, gitState, depsDone) {
  if (!record || record.status === 'done') {
    return { result: 'done', reason: 'already marked done' };
  }
  if (depsDone === false) {
    return { result: 'pending', reason: 'a dependency is not done yet', countsTowardAttempts: false };
  }

  const current = record.current || {};
  const baseline = current.gitBaseline;
  const repoChanged = !!(baseline && gitState) && (baseline.head !== gitState.head || baseline.porcelainHash !== gitState.porcelainHash);
  const hasOutput =
    typeof current.lastOutputAt === 'number' && typeof current.startedAt === 'number' && current.lastOutputAt > current.startedAt;

  if (!repoChanged && !hasOutput) {
    return { result: 'pending', reason: 'repo unchanged and no captured output', countsTowardAttempts: false };
  }
  if (repoChanged && record.greenTest) {
    return { result: 'verify', reason: 'repo changed and a green_test is defined — verify before deciding' };
  }
  if (repoChanged) {
    return { result: 'needs_verification', reason: 'repo changed but no green_test — requeue so the worker continues rather than restarts' };
  }
  // Output was captured but the repo shows no net change (e.g. a read-only
  // investigation task, or edits that were later reverted) — not enough
  // evidence to call it done, so treat like "no progress".
  return { result: 'pending', reason: 'output captured but no repo change detected', countsTowardAttempts: false };
}
