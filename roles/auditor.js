// roles/auditor.js — reviews whether an autonomous build satisfied its
// requirements. The verdict is derived MECHANICALLY from the issues list
// (pass iff zero severity:"high"), not trusted from the model's own verdict
// field — a stable, code-owned bar is what lets Phase 10's goal loop converge
// instead of chasing a holistic judgement that can flip between cycles.
import { RAW_JSON_OBJECT_ONLY } from './shared.js';

export default {
  id: 'auditor',
  purpose: 'Review whether the completed work satisfies the master prompt; flag gaps.',
  outputShape: 'object',

  // ctx: { master, taskLines, sessionCtx, changed }
  buildPrompt(ctx) {
    return [
      'You are a senior code auditor reviewing whether an autonomous build satisfied its requirements.',
      'Review the MASTER PROMPT (requirements), the task plan with completion status, the per-task change',
      'log, and the files changed in the working tree. Judge whether the work is complete and correct, and',
      'flag gaps (unmet requirements, aborted tasks, no file changes where changes were expected).',
      '',
      'A DONE task that lists a "green_test" is SETTLED for that specific criterion — do not',
      're-litigate whether it individually passes. Spend your attention on: real gaps against the',
      'MASTER PROMPT no task covers, aborted tasks, and cross-task INTEGRATION problems that no',
      'single green_test would ever catch (e.g. two tasks each pass their own test but disagree on',
      'a shared contract). Only raise an issue on a green_test-bearing task if the change log or',
      'diff shows its own stated test was never actually run or evidently does not hold.',
      '',
      RAW_JSON_OBJECT_ONLY,
      '{',
      '  "summary": "one short paragraph assessment",',
      '  "issues": [ { "severity": "high"|"medium"|"low", "task": "task-id or general", "description": "...", "suggested_fix": "..." } ]',
      '}',
      '',
      '=== MASTER PROMPT (requirements) ===',
      ctx.master || '(none)',
      '=== TASK PLAN & STATUS ===',
      ...(ctx.taskLines && ctx.taskLines.length ? ctx.taskLines : ['(no tasks)']),
      '=== PER-TASK CHANGE LOG (session_context.md) ===',
      ctx.sessionCtx || '(none)',
      '=== FILES CHANGED IN WORKING TREE (git status) ===',
      ctx.changed && ctx.changed.length ? ctx.changed.join('\n') : '(none detected / not a git repo)',
    ].join('\n');
  },

  normalize(parsed) {
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const verdict = issues.some((i) => i.severity === 'high') ? 'fail' : 'pass';
    return {
      verdict,
      summary: parsed.summary || '',
      issues,
    };
  },
};
