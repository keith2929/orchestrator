// mkdir — create a directory (and any missing parents) in the project directory.
import fs from 'node:fs';

export default {
  name: 'mkdir',
  description:
    'Create a directory (and any missing parent directories) relative to the project directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to the project directory.' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const p = ctx.resolvePath(args.path);
    fs.mkdirSync(p, { recursive: true });
    return { ok: true, path: args.path };
  },
};
