// roles/recipeCurator.js — turns ONE surfaced mining candidate into a
// proposed recipe. One small bounded LLM call per candidate (never
// continuous mining — the mining pass itself, graph/recipeMiner.js, is pure
// code). The output is DECLARATIVE DATA: a list of { tool, args } steps,
// never an executable function body — the registry mechanically wraps
// `steps` into a real expand() (see server.js getRecipeForProject). This is
// a hard boundary: never let a model author code that lands in the
// registry.
import { RAW_JSON_OBJECT_ONLY } from './shared.js';

export default {
  id: 'recipeCurator',
  purpose: 'Propose a reusable recipe (declarative steps only) from a cluster of near-duplicate hand-authored tasks.',
  outputShape: 'object',

  // ctx: { examples, toolMenu, toolNames, profile, matchesProfileScripts }
  buildPrompt(ctx) {
    return [
      'You are proposing a NEW reusable recipe for a build orchestrator, from a cluster of',
      'near-duplicate tasks that were hand-authored repeatedly across a project\'s history.',
      '',
      RAW_JSON_OBJECT_ONLY,
      '{',
      '  "id": "kebab-case-unique-id",',
      '  "description": "one sentence: what this recipe does",',
      '  "params": { "paramName": "what this parameter means" },',
      '  "steps": [ { "tool": "<tool name from the list below>", "args": { ... } }, ... ],',
      '  "onFailureHint": "diagnostic guidance for when a step in this recipe fails"',
      '}',
      '',
      '"steps" is DATA ONLY — a plain list of tool calls, never prose or code. If a step',
      'needs a value the caller supplies per-invocation, use a "{{paramName}}" placeholder',
      'inside a string arg and declare that name in "params" (empty {} if none needed).',
      '',
      "Prefer delegating to the project's OWN scripts/commands (below) over freezing the",
      'literal commands seen in the examples — the examples are evidence of a PATTERN, not',
      'a script to copy verbatim. If nothing below fits, use the tools directly.',
      '',
      'Available tools:',
      ctx.toolMenu || '(none)',
      '',
      `Project package manager: ${ctx.profile?.pkgManager || 'npm'}`,
      `Project scripts already touching this pattern: ${(ctx.matchesProfileScripts || []).join(', ') || '(none detected)'}`,
      '',
      '=== EXAMPLE OCCURRENCES OF THIS PATTERN (from real task history) ===',
      ...(ctx.examples || []).map((e, i) => `${i + 1}. ${e}`),
      '=== END EXAMPLES ===',
    ].join('\n');
  },

  normalize(parsed, ctx) {
    const id = String(parsed.id || '').trim();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new Error(`Curator proposed an invalid recipe id: ${JSON.stringify(parsed.id)}`);
    }
    const toolNames = ctx.toolNames || [];
    const steps = (Array.isArray(parsed.steps) ? parsed.steps : []).map((s, i) => {
      const tool = String((s && s.tool) || '').trim();
      if (!toolNames.includes(tool)) {
        throw new Error(`Curator proposed step ${i + 1} with unknown tool "${tool}".`);
      }
      return { tool, args: s && s.args && typeof s.args === 'object' ? s.args : {} };
    });
    if (!steps.length) {
      throw new Error('Curator proposed a recipe with no steps.');
    }
    return {
      id,
      description: parsed.description || '(no description)',
      params: parsed.params && typeof parsed.params === 'object' ? parsed.params : {},
      steps,
      onFailureHint: parsed.onFailureHint || '',
    };
  },
};
