// roles/analyzer.js — the file-isolation pass. For each task, guesses which
// repo files it will touch, purely from the task text (never reads the repo),
// so the concurrent scheduler can parallelize tasks with disjoint file sets.
// Only runs when maxConcurrency > 1 (see server.js handleRun) — parallelism
// is meaningless at concurrency 1.
import { RAW_JSON_ARRAY_ONLY } from './shared.js';

export default {
  id: 'analyzer',
  purpose: 'Guess which files each task will create or modify, for parallel-run file-conflict detection.',
  outputShape: 'array',

  // ctx: { tasks } — only the tasks still missing a `files` annotation.
  buildPrompt(ctx) {
    return [
      'For each build task below, list the repository-relative file paths it will',
      'CREATE or MODIFY. Be inclusive: include shared/barrel files (e.g. src/index.ts),',
      'config files, and package.json when the task edits them — those are what decide',
      'whether two tasks conflict. Judge from the task text alone; do not read the repo.',
      '',
      RAW_JSON_ARRAY_ONLY,
      '[{ "id": "task-1", "files": ["path/a.ts", "path/b.ts"] }, ...]',
      '',
      '=== TASKS ===',
      ...ctx.tasks.map((t) => `${t.id}: ${t.description}`),
      '=== END TASKS ===',
    ].join('\n');
  },

  normalize(parsed) {
    return (Array.isArray(parsed) ? parsed : []).map((a) => ({
      id: a.id,
      files: Array.isArray(a.files) ? a.files.map(String) : [],
    }));
  },
};
