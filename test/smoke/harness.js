// test/smoke/harness.js — boots a full, isolated copy of the orchestrator
// backend (its own config.json, its own .orchestrator/ state, its own PATH
// with a stub `claude`) so the smoke suite can exercise the real run loop —
// kill/restart, stall, repetition — without touching this repo's own
// config.json or the live dev instance.
//
// No npm dependency exists anywhere in server.js's import graph (grep
// confirms: only node: builtins and relative imports), so a plain recursive
// file copy is a complete, runnable app — no `npm install` needed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');

const COPY_ENTRIES = ['server.js', 'shared.js', 'roles.js', 'env.js', 'performance.js', 'core', 'execution', 'agent', 'graph', 'roles', 'clients', 'package.json'];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.copyFileSync(src, dest);
  }
}

// A stub \`claude\` CLI. checkClaudeAuth() (the run-loop preflight) invokes
// this SAME binary with a trivial "ping" stdin before any real task runs —
// always answer that instantly and successfully, regardless of
// CLAUDE_STUB_SCRIPT, or every smoke test would eat a ~20s auth-check
// timeout (and a hang/fail stub would falsely look like the real task
// started during the ping). Only a real (long) task prompt on stdin runs
// the configured script.
const CLAUDE_STUB = `#!/usr/bin/env bash
set -u
prompt="$(cat)"
if [ "\${#prompt}" -lt 50 ]; then
  echo '{"result":"ok"}'
  exit 0
fi
if [ -n "\${CLAUDE_STUB_SCRIPT:-}" ]; then
  bash "$CLAUDE_STUB_SCRIPT"
else
  echo '{"result":"ok"}'
  exit 0
fi
`;

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'smoke@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'smoke test target\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

// Sets up one isolated rig: an app copy + a scratch git target project + a
// stub claude on its own PATH prefix. Returns paths and a startServer()
// helper — call it (repeatedly, for the kill/restart tests) to spawn the
// backend as a real child process on `port`.
export function setupRig({ port = 3999, extraConfig = {} } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-'));
  const appDir = path.join(workDir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const entry of COPY_ENTRIES) {
    copyRecursive(path.join(REPO_ROOT, entry), path.join(appDir, entry));
  }

  const targetDir = path.join(workDir, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  gitInit(targetDir);

  fs.writeFileSync(path.join(appDir, 'config.json'), JSON.stringify({ targetDir, maxConcurrency: 2, ...extraConfig }, null, 2));

  const binDir = path.join(workDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const claudePath = path.join(binDir, 'claude');
  fs.writeFileSync(claudePath, CLAUDE_STUB);
  fs.chmodSync(claudePath, 0o755);

  let proc = null;
  // Every process GROUP ever started by this rig (a test can restart the
  // server, e.g. the kill/restart smoke test) — killServer/teardown kill all
  // of them, not just the current one, and by GROUP (negative pid) so a
  // SIGKILL of the node parent doesn't orphan the claude-stub/hang-script
  // grandchildren it spawned (a bare proc.kill() only kills the direct
  // child; those grandchildren would otherwise leak as stray processes).
  const allGroupPids = [];

  function startServer(env = {}) {
    proc = spawn('node', ['server.js'], {
      cwd: appDir,
      env: { ...process.env, PORT: String(port), PATH: `${binDir}:${process.env.PATH}`, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so the group can be killed as a unit
    });
    allGroupPids.push(proc.pid);
    return proc;
  }

  function killServer(signal = 'SIGKILL') {
    if (proc && !proc.killed) {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        /* group may already be gone */
      }
    }
  }

  async function teardown() {
    for (const pid of allGroupPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return { workDir, appDir, targetDir, binDir, port, startServer, killServer, teardown, getProc: () => proc };
}

export function apiUrl(port, p) {
  return `http://127.0.0.1:${port}${p}`;
}

export function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get(apiUrl(port, p), (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

export function postJson(port, p, body) {
  const data = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      apiUrl(port, p),
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Drains GET /api/run's SSE stream until it sends a "done" event (or the
// connection closes), collecting every event along the way.
export function runToCompletion(port, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`run did not complete within ${timeoutMs}ms; events so far: ${JSON.stringify(events)}`));
    }, timeoutMs);

    const req = http.get(apiUrl(port, '/api/run'), (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            events.push(payload);
            if (payload.type === 'done') {
              clearTimeout(timer);
              res.destroy();
              resolve(events);
            }
          } catch {
            /* ignore malformed SSE chunks */
          }
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve(events);
      });
    });
    req.on('error', reject);
  });
}

// Polls a condition against the server's HTTP API until it's true or the
// deadline passes — used instead of a fixed sleep for "wait until the
// backend is up" / "wait until recovery finished at boot".
export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out${lastErr ? `: ${lastErr.message}` : ''}`);
}
