import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readTaskState,
  setTaskState,
  startAttempt,
  endAttempt,
  completedIds,
  abortedIds,
  runningEntries,
  classifyInterrupted,
} from '../core/taskState.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taskstate-')), 'task_state.json');
}

test('derived views match the record', () => {
  const state = {
    a: { status: 'done' },
    b: { status: 'blocked' },
    c: { status: 'aborted' },
    d: { status: 'in_progress', current: { startedAt: 123 } },
    e: { status: 'pending' },
  };
  assert.deepEqual(completedIds(state), ['a']);
  assert.deepEqual(abortedIds(state), ['b', 'c']);
  assert.deepEqual(runningEntries(state), [{ taskId: 'd', startTime: 123 }]);
});

test('a done transition writes both task_state.json and completed.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskstate-'));
  const file = path.join(dir, 'task_state.json');
  const completedFile = path.join(dir, 'completed.json');
  const abortedFile = path.join(dir, 'aborted.json');

  setTaskState(file, 'task-1', { status: 'done' }, { completedFile, abortedFile });

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state['task-1'].status, 'done');
  assert.deepEqual(JSON.parse(fs.readFileSync(completedFile, 'utf8')), ['task-1']);
  assert.deepEqual(JSON.parse(fs.readFileSync(abortedFile, 'utf8')), []);
});

test('migration from legacy completed/aborted files', () => {
  const file = tmpFile();
  const state = readTaskState(file, { completed: ['task-1'], aborted: ['task-2'] });
  assert.equal(state['task-1'].status, 'done');
  assert.equal(state['task-2'].status, 'blocked');
});

test('readTaskState prefers an existing file over legacy synthesis', () => {
  const file = tmpFile();
  setTaskState(file, 'task-9', { status: 'pending' });
  const state = readTaskState(file, { completed: ['task-9'], aborted: [] });
  assert.equal(state['task-9'].status, 'pending');
});

test('attempt counters increment once per attempt', () => {
  const file = tmpFile();
  startAttempt(file, 'task-1', { owner: { agentId: 'a1' }, gitBaseline: { head: 'abc' } });
  let state = readTaskState(file);
  assert.equal(state['task-1'].attempts, 1);
  assert.equal(state['task-1'].status, 'in_progress');
  assert.equal(state['task-1'].current.gitBaseline.head, 'abc');

  endAttempt(file, 'task-1', 'pending', { detail: 'stalled', signature: 'sig-1' });
  state = readTaskState(file);
  assert.equal(state['task-1'].status, 'pending');
  assert.equal(state['task-1'].current, null);
  assert.equal(state['task-1'].history.length, 1);
  assert.equal(state['task-1'].history[0].attempt, 1);

  startAttempt(file, 'task-1', {});
  state = readTaskState(file);
  assert.equal(state['task-1'].attempts, 2);

  endAttempt(file, 'task-1', 'done', {});
  state = readTaskState(file);
  assert.equal(state['task-1'].history.length, 2);
  assert.equal(state['task-1'].history[1].attempt, 2);
});

// --- classifyInterrupted: one case per ladder row ---

test('classifyInterrupted: already done', () => {
  const out = classifyInterrupted({ status: 'done' }, { head: 'a', porcelainHash: 'x' }, true);
  assert.equal(out.result, 'done');
});

test('classifyInterrupted: no change, no output -> pending, attempt not counted', () => {
  const record = {
    status: 'in_progress',
    current: { startedAt: 100, lastOutputAt: 100, gitBaseline: { head: 'a', porcelainHash: 'x' } },
  };
  const out = classifyInterrupted(record, { head: 'a', porcelainHash: 'x' }, true);
  assert.equal(out.result, 'pending');
  assert.equal(out.countsTowardAttempts, false);
});

test('classifyInterrupted: repo changed + green_test -> verify', () => {
  const record = {
    status: 'in_progress',
    greenTest: 'npm test',
    current: { startedAt: 100, lastOutputAt: 100, gitBaseline: { head: 'a', porcelainHash: 'x' } },
  };
  const out = classifyInterrupted(record, { head: 'b', porcelainHash: 'y' }, true);
  assert.equal(out.result, 'verify');
});

test('classifyInterrupted: repo changed, no green_test -> needs_verification', () => {
  const record = {
    status: 'in_progress',
    current: { startedAt: 100, lastOutputAt: 100, gitBaseline: { head: 'a', porcelainHash: 'x' } },
  };
  const out = classifyInterrupted(record, { head: 'b', porcelainHash: 'y' }, true);
  assert.equal(out.result, 'needs_verification');
});

test('classifyInterrupted: dependency not done -> pending', () => {
  const record = {
    status: 'in_progress',
    current: { startedAt: 100, lastOutputAt: 100, gitBaseline: { head: 'a', porcelainHash: 'x' } },
  };
  const out = classifyInterrupted(record, { head: 'a', porcelainHash: 'x' }, false);
  assert.equal(out.result, 'pending');
  assert.equal(out.countsTowardAttempts, false);
});

test('classifyInterrupted: output captured but no repo change -> pending', () => {
  const record = {
    status: 'in_progress',
    current: { startedAt: 100, lastOutputAt: 500, gitBaseline: { head: 'a', porcelainHash: 'x' } },
  };
  const out = classifyInterrupted(record, { head: 'a', porcelainHash: 'x' }, true);
  assert.equal(out.result, 'pending');
});
