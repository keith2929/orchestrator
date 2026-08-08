// roles/healer.js — diagnoses a failed task from its error log and proposes a
// fix. Structured (not free text) so the same role can serve both a
// single-task retry (today) and an audit-driven heal (Phase 10) — the caller
// branches on `requires_replan` instead of guessing from prose.
import { RAW_JSON_OBJECT_ONLY } from './shared.js';

export default {
  id: 'healer',
  purpose: 'Diagnose a failed task and propose a concrete fix, or flag that the plan itself needs to change.',
  outputShape: 'object',

  // ctx: { taskId, description, errorLog }
  buildPrompt(ctx) {
    return [
      'A build task failed. Diagnose the failure and propose a fix.',
      '',
      RAW_JSON_OBJECT_ONLY,
      '{',
      '  "diagnosis": "what went wrong, in one or two sentences",',
      '  "fix_summary": "the corrected implementation plan or code needed — concrete enough to apply directly",',
      '  "affected_task": "task id this fix applies to",',
      '  "requires_replan": false',
      '}',
      '',
      'Fix the errors without changing the intended behaviour. Do not rewrite the',
      'entire file unless necessary. Set "requires_replan" true only if the error',
      'reveals the plan itself is wrong (e.g. an impossible requirement) rather',
      'than just the implementation.',
      '',
      `TASK (${ctx.taskId}): ${ctx.description}`,
      '',
      '=== ERROR LOG ===',
      String(ctx.errorLog || '').slice(0, 12000),
      '=== END ERROR LOG ===',
    ].join('\n');
  },

  normalize(parsed, ctx) {
    return {
      diagnosis: parsed.diagnosis || '',
      fix_summary: parsed.fix_summary || '',
      affected_task: parsed.affected_task || ctx.taskId || null,
      requires_replan: Boolean(parsed.requires_replan),
    };
  },
};
