import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleLoopPrompt } from '../graph/loopPrompt.js';

test('assembleLoopPrompt renders issues, inventory, and sections', () => {
  const out = assembleLoopPrompt({
    cycle: 2,
    issues: [{ severity: 'high', task: 'task-1', description: 'broke build', diagnosis: 'bad import', fix_summary: 'fix the import' }],
    taskInventory: [{ id: 'task-1', status: 'DONE', description: 'build the thing' }],
    sections: [{ heading: 'Stage 1', text: 'stage 1 details' }],
  });
  assert.ok(out.includes('Replan brief — cycle 2'));
  assert.ok(out.includes('[high] task-1: broke build'));
  assert.ok(out.includes('Diagnosis: bad import'));
  assert.ok(out.includes('task-1 [DONE]: build the thing'));
  assert.ok(out.includes('### Stage 1'));
});

test('assembleLoopPrompt handles empty issues/inventory', () => {
  const out = assembleLoopPrompt({ cycle: 1, issues: [], taskInventory: [], sections: [] });
  assert.ok(out.includes('(none)'));
});
