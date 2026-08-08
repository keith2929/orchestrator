// append_file — append text to a file relative to the project directory.
import fs from 'node:fs';
import path from 'node:path';

export default {
  name: 'append_file',
  description:
    'Append text to a file relative to the project directory. Creates the file (and parent directories) if it does not exist.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project directory.' },
      content: { type: 'string', description: 'Text to append.' },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    const p = ctx.resolvePath(args.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const content = String(args.content ?? '');
    fs.appendFileSync(p, content);
    return { ok: true, path: args.path, bytesAppended: Buffer.byteLength(content) };
  },
};
