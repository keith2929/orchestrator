// agent/tools/cachePath.js — shared path resolution for read_cache/write_cache.
//
// Cache entries live at <targetDir>/.orchestrator/cache/, keyed by a stable,
// path-like string the model chooses (e.g. "edgar/0000320193-Revenues.json").
// Content-keyed rather than a flat kv-store so related entries can be grouped
// under a directory prefix, mirroring how the data is actually organised
// (e.g. one folder per data source).
import fs from 'node:fs';
import path from 'node:path';

export function cacheDirFor(cwd) {
  const dir = path.join(cwd, '.orchestrator', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Segment-based containment check (mirrors toolRunner's resolvePath) — a key
// is a relative path under the cache root; ".." must never escape it.
export function resolveCacheFile(cwd, key) {
  const raw = String(key || '').trim();
  if (!raw) throw new Error('cache key is required');
  const dir = cacheDirFor(cwd);
  const target = path.resolve(dir, raw);
  const rel = path.relative(dir, target);
  if (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) {
    throw new Error(`cache key escapes the cache directory: ${key}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}
