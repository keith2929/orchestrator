// roles/shared.js — plumbing shared by every role module: the "respond with
// raw JSON" boilerplate, the JSON extractor, and the model-choice rules text
// (moved here from server.js so the planner/splitter prompts and the rules
// they reference can never drift apart).
//
// Kept separate from roles.js (repo root): that file answers "which model
// backs this role, with what fallback" (routing). This file — and the rest of
// roles/ — answers "what is this role's job" (behaviour/output contract).

// Pulls the first {...} or [...] out of free-form model output and parses it.
// Throws with the raw output attached (.raw) so a caller can surface it in an
// error response without re-deriving the slice logic.
export function extractJson(text, shape) {
  const re = shape === 'object' ? /\{[\s\S]*\}/ : /\[[\s\S]*\]/;
  const s = String(text || '');
  const match = s.match(re);
  if (!match) {
    const err = new Error(`Model did not return a JSON ${shape === 'object' ? 'object' : 'array'}.`);
    err.raw = s.slice(0, 4000);
    throw err;
  }
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    const err = new Error(`Model returned malformed JSON: ${e.message}`);
    err.raw = match[0].slice(0, 4000);
    throw err;
  }
}

export const RAW_JSON_ARRAY_ONLY =
  'Respond with ONE raw JSON array and NOTHING else — no prose, no markdown fences.';
export const RAW_JSON_OBJECT_ONLY =
  'Respond with ONE raw JSON object and NOTHING else — no prose, no markdown fences.';

// The shared model-selection rule, so the planner and splitter prompts can't
// drift apart on how "assigned_model" gets chosen.
//
// Deliberately biased toward the reliable default rather than the cheapest
// adequate one. The earlier "pick the cheapest that can code" rule routed a
// whole run onto free models, and they failed for reasons a coding score cannot
// predict: per-request token ceilings and tokens-per-minute throughput walls,
// which surface as a task dying mid-run rather than as a bad answer. A free
// model is worth it only when the task is genuinely small.
export const MODEL_CHOICE_RULES = [
  'Choosing assigned_model — default to a "subscription" model (the Claude CLI).',
  'It has no per-request ceiling and no rate-limit wall, so it is the safe choice',
  'for any task that is long-running, reads large files, or must not fail midway.',
  '',
  'Assign a "free"/"free-tier" model ONLY when the task is clearly SMALL — a',
  'single well-specified deliverable, touching few files, needing no large spec',
  'read into context. When in doubt, it is not small: a task that dies halfway',
  'through costs far more than it saved.',
  '  - Respect "request budget": it is the hard ceiling on ONE request, and the',
  '    running transcript (instructions + every file the worker reads) must fit',
  '    inside it. Under ~16k tokens, only small self-contained tasks are safe;',
  '    a model with no budget listed is either unconstrained (the Claude CLI) or',
  '    simply unmeasured.',
  '  - coding "strong" handles anything; "mid" suits mechanical or well-specified',
  '    work; "light"/"weak" and "unrated" only for trivial, low-risk edits.',
  'assigned_model MUST be exactly one of the quoted "client:model" strings above.',
].join('\n');

// Canonical task-shape normalizer, shared by the planner and splitter — both
// emit the same base fields and previously duplicated this block.
export function normalizeTask(t, i, fallbackModel) {
  const norm = {
    id: t.id || `task-${i + 1}`,
    description: t.description || '(no description)',
    assigned_model: t.assigned_model || fallbackModel,
    effort: t.effort || 'medium',
    depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
  };
  if (t.green_test) norm.green_test = String(t.green_test);
  return norm;
}

// Phase 6: tools whose target path is a known arg at plan time, so the
// scheduler can statically derive the node's file footprint instead of
// asking the (LLM) file-isolation analyzer to guess it — see analyzeFiles in
// server.js, which now skips type:"tool" nodes entirely.
const STATIC_FILE_TOOLS = new Set(['write_file', 'append_file', 'mkdir']);

const ALLOWED_ON_FAILURE = new Set(['spawn-task', 'gate', 'abort']);

// Canonical type:"tool" node normalizer. Mechanical steps (install/build/
// test/lint/git) execute with zero LLM involvement — the splitter is the
// only role that currently emits these. `onFailure` is accepted here for
// forward compatibility with Phase 7's recipes but not yet interpreted; a
// failing tool node is handled exactly like a failing task today (see
// runToolNode in server.js).
export function normalizeToolNode(t, i, toolNames) {
  const id = t.id || `task-${i + 1}`;
  const tool = String(t.tool || '').trim();
  if (!toolNames.includes(tool)) {
    throw new Error(
      `Tool node "${id}" references unknown tool "${tool}". Available: ${toolNames.join(', ')}`
    );
  }
  const args = t.args && typeof t.args === 'object' && !Array.isArray(t.args) ? t.args : {};
  const node = {
    id,
    type: 'tool',
    description: t.description || `${tool}(${JSON.stringify(args)})`,
    depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
    tool,
    args,
  };
  if (ALLOWED_ON_FAILURE.has(t.onFailure)) node.onFailure = t.onFailure;
  if (STATIC_FILE_TOOLS.has(tool) && typeof args.path === 'string') node.files = [args.path];
  return node;
}
