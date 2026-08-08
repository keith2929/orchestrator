// grep — search file contents for a pattern within the project directory.
import { execFile } from 'node:child_process';

export default {
  name: 'grep',
  description:
    'Search file contents for a pattern (extended regular expression) within the project directory. Returns matching { file, line, text } entries.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Extended-regex pattern to search for.' },
      path: {
        type: 'string',
        description:
          'Optional subdirectory or file to limit the search (relative to the project directory). Defaults to the whole project.',
      },
    },
    required: ['pattern'],
  },
  run(args, ctx) {
    return new Promise((resolve) => {
      const pattern = String(args.pattern ?? '');
      // Validate the optional target stays inside the project directory, then
      // pass it to grep RELATIVE to cwd so returned paths stay relative.
      let target = '.';
      if (args.path) {
        ctx.resolvePath(args.path); // throws if it escapes
        target = args.path;
      }
      execFile(
        'grep',
        ['-rInE', '--', pattern, target],
        { cwd: ctx.cwd, env: ctx.env, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          // grep exits 1 when there are simply no matches — not an error here.
          if (err && err.code !== 1 && !stdout) {
            return resolve({ ok: false, error: (err.stderr || err.message || 'grep failed').toString() });
          }
          const lines = String(stdout || '')
            .split('\n')
            .filter(Boolean);
          const max = 200;
          const matches = lines.slice(0, max).map((l) => {
            const m = l.match(/^(.*?):(\d+):(.*)$/);
            return m ? { file: m[1], line: Number(m[2]), text: m[3] } : { raw: l };
          });
          resolve({ ok: true, pattern, count: lines.length, truncated: lines.length > max, matches });
        }
      );
    });
  },
};
