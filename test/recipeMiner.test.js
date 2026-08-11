import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, jaccard, clusterByText } from '../graph/recipeMiner.js';

test('normalize strips variable tokens to placeholders', () => {
  assert.equal(normalize('Stage 3 failed'), normalize('Stage 5 failed'));
  assert.equal(normalize('Task "task-1.a" errored with `abc123def`'), normalize('Task "task-2.b" errored with `xyz789ghi`'));
});

test('jaccard edge cases', () => {
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.equal(jaccard(new Set(['a']), new Set()), 0);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
});

test('clusterByText honours threshold and minSize', () => {
  const items = [
    { id: '1', text: 'run pnpm build and fix regressions' },
    { id: '2', text: 'run pnpm build and fix regressions' },
    { id: '3', text: 'run pnpm build and fix regressions' },
    { id: '4', text: 'completely unrelated single item' },
  ];
  const clusters = clusterByText(items, { threshold: 0.55, minSize: 3 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 3);
  // scratch fields stripped
  assert.ok(!('norm' in clusters[0][0]));
  assert.ok(!('tokens' in clusters[0][0]));
});

test('clusterByText respects minSize excluding small groups', () => {
  const items = [
    { id: '1', text: 'alpha beta gamma' },
    { id: '2', text: 'alpha beta gamma' },
  ];
  assert.deepEqual(clusterByText(items, { minSize: 3 }), []);
  assert.equal(clusterByText(items, { minSize: 2 }).length, 1);
});
