import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSessionContextBlock, rolloverContent, windowPlannerChat } from '../core/sessionContext.js';

test('formatSessionContextBlock: only the delta between two snapshots is formatted', () => {
  const before = ['a.js', 'b.js'];
  const after = ['a.js', 'b.js', 'c.js', 'd.js'];
  const block = formatSessionContextBlock('task-2', before, after);
  assert.ok(block.includes('c.js'));
  assert.ok(block.includes('d.js'));
  assert.ok(!block.includes('a.js'));
  assert.ok(!block.includes('b.js'));
});

test('formatSessionContextBlock: no changes reports none detected', () => {
  const block = formatSessionContextBlock('task-1', ['a.js'], ['a.js']);
  assert.ok(block.includes('(none detected)'));
});

test('formatSessionContextBlock: >cap truncates with a count', () => {
  const after = Array.from({ length: 30 }, (_, i) => `f${i}.js`);
  const block = formatSessionContextBlock('task-3', [], after, 25);
  assert.ok(block.includes('… and 5 more'));
  assert.ok(block.includes('f0.js'));
  assert.ok(!block.includes('f29.js'));
});

test('rolloverContent: within cap returns null', () => {
  assert.equal(rolloverContent('short content', 1000), null);
});

test('rolloverContent: over cap keeps the tail and returns the archive', () => {
  const content = 'A'.repeat(50) + 'B'.repeat(50);
  const result = rolloverContent(content, 60);
  assert.ok(result);
  assert.equal(result.archived + result.kept, content);
  assert.ok(result.kept.endsWith('B'.repeat(50)));
});

test('windowPlannerChat: short transcript passes through unchanged', () => {
  const messages = [{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }];
  assert.deepEqual(windowPlannerChat(messages, 20), messages);
});

test('windowPlannerChat: long transcript keeps first turn + most recent N', () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const windowed = windowPlannerChat(messages, 20);
  assert.equal(windowed.length, 21);
  assert.equal(windowed[0].content, 'm0');
  assert.equal(windowed[1].content, 'm30');
  assert.equal(windowed[20].content, 'm49');
});
