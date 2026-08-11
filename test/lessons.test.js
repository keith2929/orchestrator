import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeywords, lessonTopicKey, lessonRelevance, rankLessons, backfillLesson } from '../core/lessons.js';

test('extractKeywords filters stopwords', () => {
  const kws = extractKeywords('The build was not passing because of a WACC calculation issue');
  assert.ok(kws.includes('wacc'));
  assert.ok(kws.includes('calculation'));
  assert.ok(!kws.includes('the'));
  assert.ok(!kws.includes('was'));
  assert.ok(!kws.includes('not'));
});

test('extractKeywords drops words of length <= 3', () => {
  const kws = extractKeywords('bug fix now WACC');
  assert.ok(!kws.includes('bug'));
  assert.ok(!kws.includes('now'));
  assert.ok(kws.includes('wacc'));
});

test('lessonTopicKey prefers files, then keywords, then taskId', () => {
  assert.equal(lessonTopicKey({ files: ['b.js', 'a.js'], keywords: ['x', 'y'], taskId: 't1' }), 'a.js|b.js');
  assert.equal(lessonTopicKey({ files: [], keywords: ['y', 'x'], taskId: 't1' }), 'x|y');
  assert.equal(lessonTopicKey({ files: [], keywords: [], taskId: 't1' }), 't1');
  assert.equal(lessonTopicKey({ files: [], keywords: [], id: 'mem-1' }), 'mem-1');
});

test('lessonRelevance weights file matches over keyword matches', () => {
  const lesson = { files: ['a.js'], keywords: ['wacc'] };
  assert.equal(lessonRelevance(lesson, [], ['a.js']), 5);
  assert.equal(lessonRelevance(lesson, ['wacc'], []), 1);
  assert.equal(lessonRelevance(lesson, ['wacc'], ['a.js']), 6);
  assert.equal(lessonRelevance(lesson, ['unrelated'], ['other.js']), 0);
});

test('rankLessons orders by file match over keyword match', () => {
  const memory = [
    { id: 'kw-only', keywords: ['wacc'], files: [] },
    { id: 'file-match', keywords: [], files: ['calc.js'] },
  ];
  const ranked = rankLessons(memory, { description: 'fix wacc calc', files: ['calc.js'] }, 5);
  assert.equal(ranked[0].id, 'file-match');
});

test('rankLessons returns [] when nothing overlaps', () => {
  const memory = [{ id: 'x', keywords: ['unrelated'], files: [] }];
  assert.deepEqual(rankLessons(memory, { description: 'totally different topic' }, 3), []);
});

test('backfillLesson leaves an already-tagged entry untouched', () => {
  const entry = { id: 'a', keywords: ['wacc'], files: [] };
  assert.strictEqual(backfillLesson(entry), entry);
});

test('backfillLesson derives keywords for a legacy entry with none, and it then scores > 0', () => {
  // The regression test for the dead-memory bug: every entry in the wild
  // predates keyword/file tagging (Phase 8), so lessonRelevance always
  // scored 0 and lessonsBlock's score>0 filter dropped every lesson.
  const legacy = { id: 'mem-1', error_summary: 'WACC calculation used stale beta', root_cause: 'beta not refreshed', lesson: 'always refetch beta before computing WACC' };
  const backfilled = backfillLesson(legacy);
  assert.ok(backfilled.keywords.length > 0);
  assert.deepEqual(backfilled.files, []);

  const ranked = rankLessons([backfilled], { description: 'Fix the WACC beta calculation' }, 3);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'mem-1');
});
