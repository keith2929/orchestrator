import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectProjectProfile, clearProfileCache } from '../graph/projectProfile.js';

test('detectProjectProfile reads package.json scripts and pnpm lockfile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x', test: 'y' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  const profile = detectProjectProfile(dir);
  assert.equal(profile.hasPackageJson, true);
  assert.equal(profile.pkgManager, 'pnpm');
  assert.deepEqual(profile.scripts.sort(), ['build', 'test']);
  clearProfileCache(dir);
});
