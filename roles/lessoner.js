// roles/lessoner.js — distills a lesson from a task that failed and was then
// fixed. `matched_recipe` (Phase 8) routes the distilled lesson into that
// recipe's onFailureHint instead of the flat residual list — permanent,
// always-surfaced for that failure mode. ctx.recipeMenu lists the real
// recipe ids so the model names one that actually exists rather than
// guessing; server.js validates it again regardless (getRecipe(id)).
import { RAW_JSON_OBJECT_ONLY } from './shared.js';

export default {
  id: 'lessoner',
  purpose: 'Summarise what went wrong in a now-fixed failed task and the lesson learned.',
  outputShape: 'object',

  // ctx: { taskId, description, errorLog, recipeMenu }
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
      '  "matched_recipe": "id from the list below this failure mode matches, or null"',
      '}',
      '',
      'Only set "matched_recipe" if the failure is the kind this recipe runs into in general',
      '(e.g. a repo-wide build/test/lint failure matches "repo-green-up") — not just because',
      'this task happened to also run a similar command. When in doubt, use null.',
      '',
      'Recipes:',
      ctx.recipeMenu || '(none)',
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
