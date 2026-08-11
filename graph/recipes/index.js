// graph/recipes/index.js — the recipe registry, mirroring agent/tools/index.js's
// registration convention. Ship generic recipes only (see REDESIGN_PLAN.md
// Phase 7); project-specific ones are mined at runtime in Phase 9.
import repoGreenUp from './repoGreenUp.js';
import checkEnvVar from './checkEnvVar.js';

export const recipeList = [repoGreenUp, checkEnvVar];

// id -> module, for expansion lookups.
export const recipes = Object.fromEntries(recipeList.map((r) => [r.id, r]));

export function getRecipe(id) {
  return recipes[id] || null;
}
