// list_dir — list entries of a directory relative to the project directory.
import fs from 'node:fs';

export default {
  name: 'list_dir',
  description:
    'List the entries (files and subdirectories) of a directory relative to the project directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path relative to the project directory. Defaults to "." (the root).',
      },
    },
    required: [],
  },
  async run(args, ctx) {
    const rel = args.path || '.';
    const p = ctx.resolveReadPath(rel);
    const entries = fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
    }));
    return { ok: true, path: rel, entries };
  },
};
