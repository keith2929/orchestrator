// write_cache — persist a JSON-serializable value to the project-scoped
// content cache (<targetDir>/.orchestrator/cache/), so a later task — or a
// later call in this one — can skip re-fetching the same data.
import fs from 'node:fs';
import { resolveCacheFile } from './cachePath.js';

export default {
  name: 'write_cache',
  description:
    'Persist a JSON-serializable value to the project-scoped content cache, keyed by a stable ' +
    'path-like string (e.g. "edgar/0000320193-Revenues.json"). A later task — or a later call in ' +
    'this one — can read_cache the same key instead of re-fetching. Set ttl_seconds for data that ' +
    'goes stale (omit it for near-permanent data like filed historical facts).',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Stable, path-like cache key. Reused across tasks to hit the same entry.' },
      value: { description: 'Any JSON-serializable value to store.' },
      ttl_seconds: { type: 'integer', description: 'Optional: seconds until this entry is considered stale. Omit for no expiry.' },
    },
    required: ['key', 'value'],
  },
  async run(args, ctx) {
    const file = resolveCacheFile(ctx.cwd, args.key);
    const entry = {
      value: args.value,
      written_at: new Date().toISOString(),
      expires_at: Number.isFinite(args.ttl_seconds) ? Date.now() + args.ttl_seconds * 1000 : null,
    };
    fs.writeFileSync(file, JSON.stringify(entry, null, 2));
    return { ok: true, key: args.key };
  },
};
