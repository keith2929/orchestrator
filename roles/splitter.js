// roles/splitter.js — breaks oversized/complex tasks into sub-tasks.
import { RAW_JSON_ARRAY_ONLY, MODEL_CHOICE_RULES, normalizeTask } from './shared.js';

export default {
  id: 'splitter',
  purpose: 'Split oversized/complex tasks into sub-tasks with explicit depends_on and a green_test.',
  outputShape: 'array',

  // ctx: { tasks, menu, fallback, lessons }
  buildPrompt(ctx) {
    return [
      "Split any task that would change >150 LOC, touches >3 modules, or has circular dependencies. Name sub-tasks as parentID.a, parentID.b, etc. Each sub-task must have a clear 'green test' criterion and explicit depends_on. Output expanded JSON.",
      '',
      'Leave tasks that do NOT need splitting exactly as they are. Every task in the',
      'output MUST keep this JSON shape (add a "green_test" string on any task you split):',
      '{',
      '  "id": "task-1" | "task-1.a",',
      '  "description": "…",',
      '  "assigned_model": "<one of the models listed below>",',
      '  "effort": "low" | "medium" | "high" | "ultracode",',
      '  "depends_on": ["task-id", ...],',
      '  "green_test": "how to know this sub-task is done (optional)"',
      '}',
      '',
      'Available models:',
      ctx.menu,
      '',
      MODEL_CHOICE_RULES,
      '',
      RAW_JSON_ARRAY_ONLY,
      ...(ctx.lessons || []),
      '',
      '=== CURRENT TASKS (JSON) ===',
      JSON.stringify(ctx.tasks, null, 2),
      '=== END TASKS ===',
    ].join('\n');
  },

  // Deliberately DROPS any cached `files` annotation so the run-time isolation
  // analysis re-runs over the new (possibly sub-divided) task set instead of
  // using stale file lists.
  normalize(parsed, ctx) {
    return (Array.isArray(parsed) ? parsed : []).map((t, i) => normalizeTask(t, i, ctx.fallback));
  },
};
