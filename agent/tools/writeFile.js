// write_file — create or overwrite a text file relative to the project directory.
import fs from 'node:fs';
import path from 'node:path';

export default {
  name: 'write_file',
  description:
    'Create or overwrite a text file relative to the project directory. Parent directories are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project directory.' },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    const p = ctx.resolvePath(args.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const content = String(args.content ?? '');
    fs.writeFileSync(p, content);
    return { ok: true, path: args.path, bytesWritten: Buffer.byteLength(content) };
  },
};
