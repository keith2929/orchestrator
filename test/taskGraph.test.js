import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topoSortTasks, uniqueFixId, isPlanComplete, issueSignature } from '../core/taskGraph.js';

test('topoSortTasks orders dependents after their dependencies', () => {
  const tasks = [
    { id: 'a', depends_on: [] },
    { id: 'b', depends_on: ['a'] },
    { id: 'c', depends_on: ['b'] },
  ];
  const ordered = topoSortTasks(tasks.slice().reverse());
  assert.deepEqual(ordered.map((t) => t.id), ['a', 'b', 'c']);
});

test('topoSortTasks preserves relative order absent constraints', () => {
  const tasks = [
    { id: 'x', depends_on: [] },
    { id: 'y', depends_on: [] },
    { id: 'z', depends_on: [] },
  ];
  assert.deepEqual(topoSortTasks(tasks).map((t) => t.id), ['x', 'y', 'z']);
});

test('topoSortTasks rejects a dangling depends_on', () => {
  const tasks = [{ id: 'a', depends_on: ['ghost'] }];
  assert.throws(() => topoSortTasks(tasks), /unknown task/);
});

test('topoSortTasks rejects a cycle', () => {
  const tasks = [
    { id: 'a', depends_on: ['b'] },
    { id: 'b', depends_on: ['a'] },
  ];
  assert.throws(() => topoSortTasks(tasks), /Circular dependency/);
});

test('uniqueFixId walks past collisions', () => {
  const existing = new Set(['task-1.fix', 'task-1.fix2']);
  assert.equal(uniqueFixId('task-1', existing), 'task-1.fix3');
  assert.equal(uniqueFixId('task-2', existing), 'task-2.fix');
});

test('isPlanComplete with mixed done/aborted', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(isPlanComplete(tasks, ['a'], ['b']), false);
  assert.equal(isPlanComplete(tasks, ['a', 'c'], ['b']), true);
});

test('issueSignature is stable across cosmetic differences', () => {
  const a = { task: 'task-1', description: 'Build failed with "abc123" after 3 retries' };
  const b = { task: 'task-1', description: "Build failed with 'xyz789' after 7 retries" };
  assert.equal(issueSignature(a), issueSignature(b));
});
