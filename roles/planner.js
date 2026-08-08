// roles/planner.js — breaks a master prompt into an ordered task list.
import { RAW_JSON_ARRAY_ONLY, MODEL_CHOICE_RULES, normalizeTask } from './shared.js';

export default {
  id: 'planner',
  purpose: 'Break a master prompt into an ordered list of concrete, independently-executable build tasks.',
  outputShape: 'array',

  // ctx: { prompt, menu, fallback }
  // Phase 10 extends this with a `ctx.mode === 'replan'` branch that reads a
  // narrow loop-prompt brief instead of the full master prompt; normalize()
  // there enforces additivity (no re-running completed ids). Not built yet —
  // there is no replan caller until the goal loop exists.
  buildPrompt(ctx) {
    return [
      'You are a software planning assistant. Read the following MASTER PROMPT and',
      'break it into an ordered list of concrete, independently-executable build tasks.',
      '',
      RAW_JSON_ARRAY_ONLY,
      'Each element MUST have exactly this shape:',
      '{',
      '  "id": "task-1",',
      '  "description": "a single, self-contained instruction",',
      '  "assigned_model": "<one of the models listed below>",',
      '  "effort": "low" | "medium" | "high" | "ultracode",',
      '  "depends_on": ["task-id", ...]',
      '}',
      '',
      'Available models:',
      ctx.menu,
      '',
      MODEL_CHOICE_RULES,
      '',
      'Rules: ids are sequential ("task-1", "task-2", ...). Use "depends_on" to encode',
      'ordering. Match "effort" to task complexity (low for trivial work, high/ultracode',
      'for complex work).',
      '',
      '=== MASTER PROMPT ===',
      ctx.prompt,
      '=== END MASTER PROMPT ===',
    ].join('\n');
  },

  normalize(parsed, ctx) {
    return (Array.isArray(parsed) ? parsed : []).map((t, i) => normalizeTask(t, i, ctx.fallback));
  },
};
