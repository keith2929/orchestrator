// read_cache — look up a value previously stored with write_cache. Pointer-
// based: the model asks for exactly the key it needs and gets that value
// back directly — never a blind inline of the whole cache.
import fs from 'node:fs';
import { resolveCacheFile } from './cachePath.js';

export default {
  name: 'read_cache',
  description:
    'Look up a value previously stored with write_cache, by the same key. Returns hit:false (not an ' +
    'error) on a miss or an expired TTL — check "hit" before trusting the value, then fetch fresh ' +
    'and write_cache it again.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The cache key to look up (must match a prior write_cache call).' },
    },
    required: ['key'],
  },
  async run(args, ctx) {
    const file = resolveCacheFile(ctx.cwd, args.key);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { ok: true, hit: false, key: args.key };
    }
    if (entry.expires_at && Date.now() > entry.expires_at) {
      return { ok: true, hit: false, key: args.key, reason: 'expired' };
    }
    return { ok: true, hit: true, key: args.key, value: entry.value, written_at: entry.written_at };
  },
};
