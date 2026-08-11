import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, resolveSection } from '../graph/masterPromptIndex.js';

test('buildIndex sections a subheading into its parent and resolveSection finds it loosely', () => {
  const md = [
    '# Stage 1',
    'intro text',
    '## Substage 1.a',
    'sub text',
    '# Stage 2',
    'other text',
  ].join('\n');
  const index = buildIndex(md);
  assert.equal(index.length, 3);
  const stage1 = index.find((s) => s.heading === 'Stage 1');
  assert.ok(stage1.text.includes('Substage 1.a'));
  assert.ok(stage1.text.includes('sub text'));

  // resolveSection tolerates case/whitespace/marker drift
  assert.ok(resolveSection(index, '  stage 1 ✅ CLEAR').includes('intro text'));
  assert.equal(resolveSection(index, 'does not exist'), null);
});
