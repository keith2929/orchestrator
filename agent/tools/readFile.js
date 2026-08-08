// read_file — read a UTF-8 text file relative to the project directory.
import fs from 'node:fs';

export default {
  name: 'read_file',
  description:
    'Read a UTF-8 text file relative to the project directory. Prefer line_start/line_end to read ' +
    'only the part you need — whole large files crowd out your context. Returns total_lines so you ' +
    'can page through.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project directory.' },
      line_start: { type: 'integer', description: 'First line to return, 1-indexed and inclusive. Optional.' },
      line_end: { type: 'integer', description: 'Last line to return, 1-indexed and inclusive. Optional.' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const p = ctx.resolveReadPath(args.path);
    const max = ctx.limits?.maxFileBytes ?? 256 * 1024;
    const buf = fs.readFileSync(p);
    const truncated = buf.length > max;
    const text = buf.slice(0, max).toString('utf8');

    // Line ranges exist because models ASK for them: they were passing
    // line_start/line_end to a tool that never declared them, so the args were
    // dropped and a 48KB spec came back whole — three times in one task, which
    // is what blew the context budget. Measured on that same file: whole =
    // 2162 tokens (it hits the 8000-char result cap), 90 lines = 1526, 40
    // lines = 694, 20 lines = 298. The saving scales with the range asked for,
    // so this helps only as much as the model is specific.
    const start = Number.isInteger(args.line_start) ? Math.max(1, args.line_start) : null;
    const end = Number.isInteger(args.line_end) ? args.line_end : null;
    if (start === null && end === null) {
      return { ok: true, path: args.path, bytes: buf.length, truncated, content: text };
    }

    const lines = text.split('\n');
    const from = (start ?? 1) - 1;
    const to = end === null ? lines.length : Math.min(end, lines.length);
    return {
      ok: true,
      path: args.path,
      bytes: buf.length,
      total_lines: lines.length,
      line_start: from + 1,
      line_end: to,
      truncated,
      content: lines.slice(from, to).join('\n'),
    };
  },
};
