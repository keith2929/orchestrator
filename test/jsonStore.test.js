import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJson, writeJson } from '../core/jsonStore.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstore-')), 'data.json');
}

test('round-trip write/read', () => {
  const file = tmpFile();
  writeJson(file, { a: 1, b: [1, 2, 3] });
  assert.deepEqual(readJson(file, null), { a: 1, b: [1, 2, 3] });
});

test('readJson recovers from .prev when the file is truncated', () => {
  const file = tmpFile();
  writeJson(file, { ok: true });
  writeJson(file, { ok: 'updated' });
  // Corrupt the live file by hand; .prev still holds the first write.
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readJson(file, null), { ok: true });
});

test('readJson returns fallback when both file and .prev are corrupt', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{bad');
  fs.writeFileSync(`${file}.prev`, '{also bad');
  assert.deepEqual(readJson(file, { fallback: true }), { fallback: true });
});

test('writeJson leaves no .tmp file behind', () => {
  const file = tmpFile();
  writeJson(file, { x: 1 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
