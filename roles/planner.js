// roles/planner.js — breaks a master prompt into an ordered task list, and
// (Phase 10) additively replans against a narrow loop-prompt brief instead
// of the whole document.
import { RAW_JSON_ARRAY_ONLY, MODEL_CHOICE_RULES, normalizeTask } from './shared.js';

export default {
  id: 'planner',
  purpose: 'Break a master prompt into an ordered list of concrete, independently-executable build tasks.',
  outputShape: 'array',

  // ctx (initial plan): { prompt, menu, fallback }
  // ctx (replan, Phase 10): { mode: 'replan', loopPrompt, menu, fallback, existingIds }
  buildPrompt(ctx) {
    if (ctx.mode === 'replan') {
      return [
        'You are a software planning assistant continuing an IN-PROGRESS build. Read the',
        'brief below — it lists what is still wrong, per the last audit — and propose ONLY',
        'the NEW tasks needed to fix it. Do NOT re-describe or repeat work already done.',
        '',
        RAW_JSON_ARRAY_ONLY,
        'Each element MUST have exactly this shape:',
        '{',
        '  "id": "<a NEW id, not in the existing-ids list below>",',
        '  "description": "a single, self-contained instruction",',
        '  "assigned_model": "<one of the models listed below>",',
        '  "effort": "low" | "medium" | "high" | "ultracode",',
        '  "depends_on": ["task-id", ...],',
        '  "source_section": "the MASTER PROMPT heading this task addresses, if the brief names one"',
        '}',
        '',
        'Available models:',
        ctx.menu,
        '',
        MODEL_CHOICE_RULES,
        '',
        'Rules: every id MUST be new — do not reuse or redefine any id listed below, even if',
        'you think it needs more work; if an existing task needs follow-up, create a NEW task',
        'that depends_on it instead. "depends_on" may reference either an existing id or one',
        'of your own new ids.',
        '',
        `Existing ids (immutable — do not reuse): ${(ctx.existingIds || []).join(', ') || '(none)'}`,
        '',
        '=== BRIEF (this cycle\'s issues, prior fixes, task inventory, relevant MASTER PROMPT sections) ===',
        ctx.loopPrompt,
        '=== END BRIEF ===',
      ].join('\n');
    }

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
      '  "depends_on": ["task-id", ...],',
      '  "source_section": "the MASTER PROMPT heading (## ...) this task is derived from"',
      '}',
      '',
      'Available models:',
      ctx.menu,
      '',
      MODEL_CHOICE_RULES,
      '',
      'Rules: ids are sequential ("task-1", "task-2", ...). Use "depends_on" to encode',
      'ordering. Match "effort" to task complexity (low for trivial work, high/ultracode',
      'for complex work). Set "source_section" to the nearest MASTER PROMPT heading this',
      'task comes from — it lets a later replan cycle re-inline just that section instead',
      'of the whole document.',
      '',
      '=== MASTER PROMPT ===',
      ctx.prompt,
      '=== END MASTER PROMPT ===',
    ].join('\n');
  },

  normalize(parsed, ctx) {
    const tasks = (Array.isArray(parsed) ? parsed : []).map((t, i) => normalizeTask(t, i, ctx.fallback));

    if (ctx.mode === 'replan') {
      // Backstop additivity: even if the model ignored the instruction and
      // reused an existing id, never let it land — completed ids especially
      // must be immutable, or the loop could silently re-run finished work.
      const existing = new Set(ctx.existingIds || []);
      const additive = tasks.filter((t) => !existing.has(t.id));
      if (!additive.length) {
        throw new Error('Replan produced no new tasks — every proposed id collided with an existing one.');
      }
      return additive;
    }

    return tasks;
  },
};
