import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createToolRunner } from '../agent/toolRunner.js';

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolrunner-'));
  fs.mkdirSync(path.join(dir, '.orchestrator'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.orchestrator', 'session_context.md'), 'hello');
  return dir;
}

test('write_file at .orchestrator/recipes/x.md rejects', async () => {
  const cwd = tmpProject();
  const runner = createToolRunner({ cwd, limits: {}, onLog: () => {} });
  const result = await runner.run('write_file', { path: '.orchestrator/recipes/x.md', content: 'nope' });
  assert.equal(result.ok, false);
  assert.match(result.error, /\.orchestrator/);
});

test('write_file at ./.orchestrator/tasks.json rejects', async () => {
  const cwd = tmpProject();
  const runner = createToolRunner({ cwd, limits: {}, onLog: () => {} });
  const result = await runner.run('write_file', { path: './.orchestrator/tasks.json', content: '[]' });
  assert.equal(result.ok, false);
  assert.match(result.error, /\.orchestrator/);
});

test('a ../-escape into .orchestrator from a subdirectory rejects', async () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, 'sub'));
  const runner = createToolRunner({ cwd, limits: {}, onLog: () => {} });
  const result = await runner.run('write_file', { path: 'sub/../.orchestrator/evil.json', content: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /\.orchestrator/);
});

test('read_file on .orchestrator/session_context.md succeeds', async () => {
  const cwd = tmpProject();
  const runner = createToolRunner({ cwd, limits: {}, onLog: () => {} });
  const result = await runner.run('read_file', { path: '.orchestrator/session_context.md' });
  assert.equal(result.ok, true);
  assert.ok(result.content.includes('hello'));
});

test('an ordinary project write still succeeds', async () => {
  const cwd = tmpProject();
  const runner = createToolRunner({ cwd, limits: {}, onLog: () => {} });
  const result = await runner.run('write_file', { path: 'src/index.js', content: 'console.log(1)' });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(path.join(cwd, 'src', 'index.js')));
});
