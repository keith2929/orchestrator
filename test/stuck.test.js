import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStalled, shouldBlock } from '../core/taskState.js';

const limits = { stallMs: 1000, maxAttemptMs: 5000, maxAttempts: 3, identicalFailureLimit: 2 };

test('isStalled: no current record -> never stalled', () => {
  assert.equal(isStalled({}, 100000, limits).stalled, false);
});

test('isStalled: just under stallMs -> not stalled', () => {
  const record = { current: { startedAt: 0, lastOutputAt: 500, lastRepoChangeAt: 500 } };
  assert.equal(isStalled(record, 1499, limits).stalled, false);
});

test('isStalled: at/over stallMs -> stalled', () => {
  const record = { current: { startedAt: 0, lastOutputAt: 500, lastRepoChangeAt: 500 } };
  assert.equal(isStalled(record, 1500, limits).stalled, true);
});

test('isStalled: just under maxAttemptMs -> not stalled even with recent activity gap', () => {
  const record = { current: { startedAt: 0, lastOutputAt: 4999, lastRepoChangeAt: 4999 } };
  assert.equal(isStalled(record, 4999, limits).stalled, false);
});

test('isStalled: at/over maxAttemptMs -> stalled regardless of recent activity', () => {
  const record = { current: { startedAt: 0, lastOutputAt: 4999, lastRepoChangeAt: 4999 } };
  assert.equal(isStalled(record, 5000, limits).stalled, true);
});

test('shouldBlock: reaches blocked at exactly maxAttempts', () => {
  assert.equal(shouldBlock({ attempts: 2, history: [] }, limits), false);
  assert.equal(shouldBlock({ attempts: 3, history: [] }, limits), true);
});

test('shouldBlock: identicalFailureLimit consecutive identical signatures escalates', () => {
  const record = {
    attempts: 2,
    history: [
      { signature: 'sig-a' },
      { signature: 'sig-a' },
    ],
  };
  assert.equal(shouldBlock(record, limits), true);
});

test('shouldBlock: differing signatures do not escalate', () => {
  const record = {
    attempts: 2,
    history: [
      { signature: 'sig-a' },
      { signature: 'sig-b' },
    ],
  };
  assert.equal(shouldBlock(record, limits), false);
});

test('shouldBlock: missing signature never counts as a match', () => {
  const record = { attempts: 2, history: [{ signature: null }, { signature: null }] };
  assert.equal(shouldBlock(record, limits), false);
});
