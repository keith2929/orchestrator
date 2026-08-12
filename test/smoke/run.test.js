// test/smoke/run.test.js — five scripts against a real, isolated orchestrator
// process: happy path, kill-during-task, stall, repetitive failure, and the
// write-protection guard end to end. See core/*.test.js for the pure-logic
// unit coverage these scripts exercise through the real HTTP/process surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRig, waitFor, getJson, runToCompletion } from './harness.js';

function writeTasks(rig, tasks) {
  const dir = path.join(rig.targetDir, '.orchestrator');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasks, null, 2));
}

async function up(rig) {
  rig.startServer();
  await waitFor(() => getJson(rig.port, '/api/health').then((r) => r.ok));
}

test('1. happy path — plan runs in dependency order, completed.json correct', async () => {
  const rig = setupRig({ port: 4001 });
  try {
    writeTasks(rig, [
      { id: 'task-2', type: 'tool', tool: 'write_file', args: { path: 'b.txt', content: 'b' }, depends_on: ['task-1'] },
      { id: 'task-1', type: 'tool', tool: 'write_file', args: { path: 'a.txt', content: 'a' }, depends_on: [] },
    ]);
    await up(rig);
    const events = await runToCompletion(rig.port);
    assert.ok(events.some((e) => e.type === 'done' && e.planComplete));

    const tasks = await getJson(rig.port, '/api/tasks');
    assert.deepEqual(tasks.completed.sort(), ['task-1', 'task-2']);
    assert.deepEqual(tasks.aborted, []);
    assert.ok(fs.existsSync(path.join(rig.targetDir, 'a.txt')));
    assert.ok(fs.existsSync(path.join(rig.targetDir, 'b.txt')));
  } finally {
    await rig.teardown();
  }
});

test('2. kill during task — restart classifies the interrupted task instead of losing it', async () => {
  const rig = setupRig({ port: 4002, extraConfig: { maxConcurrency: 1 } });
  try {
    const markerPath = path.join(rig.targetDir, 'marker.txt');
    const stubScript = path.join(rig.workDir, 'hang.sh');
    // Writes a file (so the repo shows a real change) then hangs — simulating
    // a worker that made partial progress before the backend was killed.
    fs.writeFileSync(stubScript, `#!/usr/bin/env bash\necho started > "${markerPath}"\nsleep 300\n`);
    fs.chmodSync(stubScript, 0o755);

    writeTasks(rig, [{ id: 'task-1', assigned_model: 'claude:sonnet', effort: 'medium', description: 'a task', depends_on: [] }]);
    rig.startServer({ CLAUDE_STUB_SCRIPT: stubScript });
    await waitFor(() => getJson(rig.port, '/api/health').then((r) => r.ok));

    // Kick off a run (don't await completion — it will hang) and wait for the
    // marker file, proving the subprocess actually started before we kill it.
    getJson(rig.port, '/api/run').catch(() => {});
    await waitFor(() => fs.existsSync(markerPath));
    await waitFor(() => getJson(rig.port, '/api/tasks').then((t) => t.running.length === 1));

    rig.killServer('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    // Restart against the SAME target — recoverInterruptedTasks runs at boot,
    // but the HTTP server starts accepting connections before that async
    // work finishes, so poll task_state.json rather than trusting /api/health.
    rig.startServer({ CLAUDE_STUB_SCRIPT: stubScript });
    await waitFor(() => getJson(rig.port, '/api/health').then((r) => r.ok));
    const stateFile = path.join(rig.targetDir, '.orchestrator', 'task_state.json');
    await waitFor(() => {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return s['task-1'] && s['task-1'].status !== 'in_progress';
    });

    const taskState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Repo changed (marker.txt untracked) with no green_test -> needs_verification,
    // which recovery immediately requeues as 'pending' with continuation context
    // (not silently lost, not blindly restarted from scratch).
    assert.equal(taskState['task-1'].status, 'pending');
    const tasks = JSON.parse(fs.readFileSync(path.join(rig.targetDir, '.orchestrator', 'tasks.json'), 'utf8'));
    assert.ok(tasks[0].suggested_fix && tasks[0].suggested_fix.includes('marker.txt'));
  } finally {
    await rig.teardown();
  }
});

test('3. stall — a hung worker is aborted once stallMs elapses, loop continues', async () => {
  const rig = setupRig({ port: 4003, extraConfig: { stallMs: 2000, maxAttemptMs: 60000, maxConcurrency: 1 } });
  try {
    const stubScript = path.join(rig.workDir, 'stall.sh');
    fs.writeFileSync(stubScript, `#!/usr/bin/env bash\nsleep 300\n`);
    fs.chmodSync(stubScript, 0o755);

    writeTasks(rig, [{ id: 'task-1', assigned_model: 'claude:sonnet', effort: 'medium', description: 'a stalling task', depends_on: [] }]);
    rig.startServer({ CLAUDE_STUB_SCRIPT: stubScript });
    await waitFor(() => getJson(rig.port, '/api/health').then((r) => r.ok));

    const events = await runToCompletion(rig.port, { timeoutMs: 45000 });
    assert.ok(events.some((e) => e.type === 'log' && /stallMs.*exceeded/.test(e.log || '')));

    const taskState = JSON.parse(fs.readFileSync(path.join(rig.targetDir, '.orchestrator', 'task_state.json'), 'utf8'));
    assert.ok(taskState['task-1'].history.length >= 1);
  } finally {
    await rig.teardown();
  }
});

test('4. repetitive failure — blocked after maxAttempts, independent tasks still complete', async () => {
  const rig = setupRig({ port: 4004, extraConfig: { maxAttempts: 2, identicalFailureLimit: 2, maxConcurrency: 1 } });
  try {
    const stubScript = path.join(rig.workDir, 'fail.sh');
    fs.writeFileSync(stubScript, `#!/usr/bin/env bash\necho "same failure every time" >&2\nexit 1\n`);
    fs.chmodSync(stubScript, 0o755);

    writeTasks(rig, [
      { id: 'task-1', assigned_model: 'claude:sonnet', effort: 'medium', description: 'always fails', depends_on: [] },
      { id: 'task-2', type: 'tool', tool: 'write_file', args: { path: 'independent.txt', content: 'ok' }, depends_on: [] },
    ]);
    rig.startServer({ CLAUDE_STUB_SCRIPT: stubScript });
    await waitFor(() => getJson(rig.port, '/api/health').then((r) => r.ok));

    await runToCompletion(rig.port, { timeoutMs: 25000 });

    const tasks = await getJson(rig.port, '/api/tasks');
    assert.ok(tasks.aborted.includes('task-1')); // 'blocked' status derives into aborted.json
    assert.ok(tasks.completed.includes('task-2'));

    const taskState = JSON.parse(fs.readFileSync(path.join(rig.targetDir, '.orchestrator', 'task_state.json'), 'utf8'));
    assert.equal(taskState['task-1'].status, 'blocked');
  } finally {
    await rig.teardown();
  }
});

test('5. worker cannot mutate recipes — write under .orchestrator/ rejected, session_context.md read succeeds', async () => {
  const rig = setupRig({ port: 4005 });
  try {
    fs.mkdirSync(path.join(rig.targetDir, '.orchestrator'), { recursive: true });
    fs.writeFileSync(path.join(rig.targetDir, '.orchestrator', 'session_context.md'), 'prior context');
    await up(rig);

    const { createToolRunner } = await import(path.join(rig.appDir, 'agent', 'toolRunner.js'));
    const runner = createToolRunner({ cwd: rig.targetDir, limits: {}, onLog: () => {} });

    const write = await runner.run('write_file', { path: '.orchestrator/recipes/evil.md', content: 'x' });
    assert.equal(write.ok, false);

    const read = await runner.run('read_file', { path: '.orchestrator/session_context.md' });
    assert.equal(read.ok, true);
    assert.ok(read.content.includes('prior context'));
  } finally {
    await rig.teardown();
  }
});
