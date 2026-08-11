// Pure task-graph logic, extracted out of server.js so it is testable without
// booting the HTTP server (server.js calls server.listen() at import time).
import { normalize as normalizeText } from '../graph/recipeMiner.js';

export function topoSortTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.depends_on || []) {
      if (!byId.has(dep)) {
        throw new Error(`Task "${t.id}" depends_on unknown task "${dep}".`);
      }
    }
  }
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(t) {
    if (visited.has(t.id)) return;
    if (visiting.has(t.id)) {
      throw new Error(`Circular dependency involving "${t.id}".`);
    }
    visiting.add(t.id);
    for (const dep of t.depends_on || []) visit(byId.get(dep));
    visiting.delete(t.id);
    visited.add(t.id);
    ordered.push(t);
  }
  // Preserve original relative order among tasks with no ordering constraint
  // between them — only reorder when depends_on actually forces it.
  for (const t of tasks) visit(t);
  return ordered;
}

// Auto-inserted fix-task ids need a uniqueness suffix — plain `${baseId}.fix`
// collides if the same node fails twice across retries.
export function uniqueFixId(baseId, existingIds) {
  let candidate = `${baseId}.fix`;
  let n = 2;
  while (existingIds.has(candidate)) {
    candidate = `${baseId}.fix${n}`;
    n++;
  }
  return candidate;
}

export function isPlanComplete(tasks, completedIds, abortedIds) {
  const completed = new Set(completedIds);
  const aborted = new Set(abortedIds);
  return (tasks || []).every((t) => completed.has(t.id) || aborted.has(t.id));
}

// A stable identity for "this is the same complaint as before", so a heal
// attempt that didn't actually fix anything is detected even if the
// auditor's wording drifts slightly between cycles. Reuses the recipe
// miner's placeholder-normaliser rather than inventing a second one.
export function issueSignature(issue) {
  return normalizeText(`${(issue && issue.task) || 'general'} ${(issue && issue.description) || ''}`);
}
