// glob — find files matching a glob pattern within the project directory.
import fs from 'node:fs';

export default {
  name: 'glob',
  description:
    'Find files matching a glob pattern (e.g. "src/**/*.js") within the project directory. Returns matching relative paths.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, relative to the project directory.' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const pattern = String(args.pattern ?? '');
    // Keep the search inside the project directory: no absolute patterns, no
    // parent-directory escapes.
    if (pattern.startsWith('/') || pattern.split(/[\\/]/).includes('..')) {
      return { ok: false, error: `pattern escapes the project directory: ${pattern}` };
    }
    const max = 500;
    const matches = [];
    // fs.globSync is available in Node 18.20+/20+/22+. Yields paths relative to cwd.
    for (const m of fs.globSync(pattern, { cwd: ctx.cwd })) {
      matches.push(m);
      if (matches.length >= max) break;
    }
    return { ok: true, pattern, count: matches.length, truncated: matches.length >= max, matches };
  },
};
