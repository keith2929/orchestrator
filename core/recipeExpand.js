// core/recipeExpand.js — mechanical (zero-LLM) recipe step expansion.

// Turns a curator-proposed step's args into concrete values by substituting
// "{{paramName}}" inside string values — NEVER eval, never a model-authored
// function body. A param with no supplied value leaves its placeholder
// untouched rather than guessing.
export function substituteParams(value, params) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in params ? String(params[name]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substituteParams(v, params));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteParams(v, params)]));
  }
  return value;
}
