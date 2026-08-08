// performance.js — write-only telemetry.
//
// After every role/worker execution we append one JSON record to
// performance.json. NOTHING reads this file. It is a substrate for future
// benchmarking / adaptive routing. It is deliberately fire-and-forget: never
// awaited on the hot path, always wrapped so a write failure can NEVER break a
// run (e.g. a read-only filesystem must not abort a task).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERF_PATH = path.join(__dirname, 'performance.json');

// Append a record. `record` is merged with a timestamp. Synchronous append to a
// JSON-lines file (one record per line) — simplest format that survives partial
// writes and needs no read-modify-write. Any error is swallowed by design.
export function recordPerformance(record) {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n';
    fs.appendFileSync(PERF_PATH, line);
  } catch {
    /* write-only + best-effort: never throw, never block a run */
  }
}
