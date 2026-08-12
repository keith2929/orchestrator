import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeLessons } from '../core/lessons.js';

// The server.js POST /api/memory/compact handler wires dedupeLessons +
// annotateCandidate + clusterByText together; those three are already
// covered individually (lessons.test.js, recipeMiner.test.js). This test
// locks in the dedupe count on a realistic fixture, which is the number the
// HARDENING_PLAN.md "Done when" checks against the real project's backlog.
test('dedupe count on a fixture with known duplicate topics', () => {
  const memory = [
    { id: 'a', files: ['edgar.ts'], lesson: 'old' },
    { id: 'b', files: ['wacc.ts'], lesson: 'old wacc note' },
    { id: 'c', files: ['edgar.ts'], lesson: 'newer edgar note' }, // supersedes 'a'
    { id: 'd', keywords: ['unrelated', 'topic'] },
    { id: 'e', files: ['wacc.ts'], lesson: 'newest wacc note' }, // supersedes 'b'
  ];
  const { kept, removed } = dedupeLessons(memory);
  assert.equal(kept.length, 3);
  assert.equal(removed.length, 2);
  assert.deepEqual(kept.map((e) => e.id).sort(), ['c', 'd', 'e']);
});

test('dry-run mutates nothing (dedupeLessons is pure)', () => {
  const memory = [{ id: 'a', files: ['x.js'] }, { id: 'b', files: ['x.js'] }];
  const snapshot = JSON.stringify(memory);
  dedupeLessons(memory);
  assert.equal(JSON.stringify(memory), snapshot);
});
