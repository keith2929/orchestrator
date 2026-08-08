// roles/lessoner.js — distills a lesson from a task that failed and was then
// fixed. `matched_recipe` is optional and unused until Phase 9's recipe
// miner exists; requesting it now means the field is already present in
// stored lessons once that lands, instead of needing a memory.json migration.
import { RAW_JSON_OBJECT_ONLY } from './shared.js';

export default {
  id: 'lessoner',
  purpose: 'Summarise what went wrong in a now-fixed failed task and the lesson learned.',
  outputShape: 'object',

  // ctx: { taskId, description, errorLog }
  buildPrompt(ctx) {
    return [
      'A build task previously FAILED and has now been fixed and completed successfully.',
      'Summarise what went wrong in this failed task and how it was fixed.',
      '',
      RAW_JSON_OBJECT_ONLY,
      '{',
      '  "error_summary": "...",',
      '  "root_cause": "...",',
      '  "fix": "...",',
      '  "lesson": "...",',
      '  "matched_recipe": "id of an existing built-in recipe this failure mode matches, or null"',
      '}',
      '',
      `TASK: ${ctx.description}`,
      '',
      '=== ERROR LOG ===',
      String(ctx.errorLog || '').slice(0, 12000),
      '=== END ERROR LOG ===',
    ].join('\n');
  },

  normalize(parsed) {
    return {
      error_summary: parsed.error_summary || '',
      root_cause: parsed.root_cause || '',
      fix: parsed.fix || '',
      lesson: parsed.lesson || '',
      matched_recipe: parsed.matched_recipe || null,
    };
  },
};
