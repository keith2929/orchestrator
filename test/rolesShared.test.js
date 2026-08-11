import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, normalizeTask, normalizeToolNode } from '../roles/shared.js';

test('extractJson parses a fenced block', () => {
  const text = 'Here you go:\n```json\n[{"id":"a"}]\n```\n';
  assert.deepEqual(extractJson(text, 'array'), [{ id: 'a' }]);
});

test('extractJson parses prose-wrapped JSON', () => {
  const text = 'Sure, the object is {"ok":true} — hope that helps!';
  assert.deepEqual(extractJson(text, 'object'), { ok: true });
});

test('extractJson throws with .raw on malformed JSON', () => {
  const text = 'The array is [1, 2,] which is truncated';
  assert.throws(() => extractJson(text, 'array'), (err) => {
    assert.ok(err.raw);
    return true;
  });
});

test('normalizeTask fills in defaults', () => {
  const t = normalizeTask({}, 0, 'claude:sonnet');
  assert.equal(t.id, 'task-1');
  assert.equal(t.description, '(no description)');
  assert.equal(t.assigned_model, 'claude:sonnet');
  assert.equal(t.effort, 'medium');
  assert.deepEqual(t.depends_on, []);
  assert.ok(!('green_test' in t));
  assert.ok(!('source_section' in t));
});

test('normalizeTask preserves supplied fields', () => {
  const t = normalizeTask(
    { id: 'x', description: 'do it', assigned_model: 'openai:gpt', effort: 'high', depends_on: ['a'], green_test: 'npm test', source_section: 'Stage 1' },
    5,
    'claude:sonnet'
  );
  assert.equal(t.id, 'x');
  assert.equal(t.green_test, 'npm test');
  assert.equal(t.source_section, 'Stage 1');
});

test('normalizeToolNode rejects an unknown tool', () => {
  assert.throws(() => normalizeToolNode({ tool: 'nope' }, 0, ['run_bash', 'write_file']), /unknown tool/);
});

test('normalizeToolNode derives files for write_file/append_file/mkdir', () => {
  const toolNames = ['write_file', 'append_file', 'mkdir', 'run_bash'];
  for (const tool of ['write_file', 'append_file', 'mkdir']) {
    const node = normalizeToolNode({ tool, args: { path: 'foo/bar.txt' } }, 0, toolNames);
    assert.deepEqual(node.files, ['foo/bar.txt']);
  }
  const bash = normalizeToolNode({ tool: 'run_bash', args: { command: 'ls' } }, 0, toolNames);
  assert.ok(!('files' in bash));
});
