// roles/splitter.js — breaks oversized/complex tasks into sub-tasks, and
// factors purely mechanical tails (install/build/test/lint/git) out of task
// prose into zero-LLM type:"tool" nodes (Phase 6).
import { RAW_JSON_ARRAY_ONLY, MODEL_CHOICE_RULES, normalizeTask, normalizeToolNode } from './shared.js';

export default {
  id: 'splitter',
  purpose: 'Split oversized/complex tasks into sub-tasks with explicit depends_on and a green_test; factor mechanical steps into tool nodes.',
  outputShape: 'array',

  // ctx: { tasks, menu, fallback, lessons, toolMenu, toolNames }
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
      'You MAY ALSO factor a purely MECHANICAL tail (install/build/test/lint/git',
      'status, etc. — no code authoring, no judgement calls) out of a task into a',
      'separate "tool" node instead of prose. The orchestrator runs these directly',
      'with zero LLM cost, so prefer this whenever the step is just a command:',
      '{',
      '  "id": "task-4.b",',
      '  "type": "tool",',
      '  "description": "run the test suite",',
      '  "depends_on": ["task-4.a"],',
      '  "tool": "<one of the tool names below>",',
      '  "args": { }',
      '}',
      'Only split off a tool node when a single deterministic command or file',
      'operation accomplishes the whole step — anything needing judgement or code',
      'authoring stays a normal task node (no "type" field, or "type":"task").',
      '"tool" MUST be exactly one of the names below; do not invent a tool.',
      '',
      'Available tools:',
      ctx.toolMenu || '(none)',
      '',
      RAW_JSON_ARRAY_ONLY,
      ...(ctx.lessons || []),
      '',
      '=== CURRENT TASKS (JSON) ===',
      JSON.stringify(ctx.tasks, null, 2),
      '=== END TASKS ===',
    ].join('\n');
  },

  // Deliberately DROPS any cached `files` annotation on task nodes so the
  // run-time isolation analysis re-runs over the new (possibly sub-divided)
  // task set instead of using stale file lists. Tool nodes get their files
  // (if any) re-derived statically from args by normalizeToolNode instead.
  normalize(parsed, ctx) {
    return (Array.isArray(parsed) ? parsed : []).map((t, i) =>
      t && t.type === 'tool' ? normalizeToolNode(t, i, ctx.toolNames || []) : normalizeTask(t, i, ctx.fallback)
    );
  },
};
