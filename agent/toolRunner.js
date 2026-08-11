// agent/toolRunner.js — executes a tool call, enforcing the cross-cutting
// concerns so individual tools stay tiny: path confinement, timing, structured
// results, and a standard log record (action → tool → args → result → duration).
import fs from 'node:fs';
import path from 'node:path';
import { CHILD_ENV } from '../shared.js';
import { tools as toolRegistry } from './tools/index.js';

// Compact one-line preview of a value for the transcript log.
function preview(value, max = 200) {
  let s;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// The standard tool-call transcript line. run_bash also reports its exit code.
function formatLog(name, args, result, durationMs) {
  const status = result.ok ? 'ok' : `error: ${preview(result.error, 160)}`;
  const extra = [];
  if (typeof result.exitCode === 'number') extra.push(`exit=${result.exitCode}`);
  if (typeof result.bytesWritten === 'number') extra.push(`wrote=${result.bytesWritten}b`);
  if (typeof result.bytesAppended === 'number') extra.push(`appended=${result.bytesAppended}b`);
  if (typeof result.bytes === 'number') extra.push(`read=${result.bytes}b`);
  if (typeof result.count === 'number') extra.push(`matches=${result.count}`);
  const tail = extra.length ? ' ' + extra.join(' ') : '';
  return `🔧 ${name}(${preview(args, 160)}) → ${status}${tail} [${durationMs}ms]\n`;
}

export function createToolRunner({ cwd, limits, onLog, readRoots = [] }) {
  const root = path.resolve(cwd);
  const extraRoots = readRoots.map((r) => path.resolve(r));

  const within = (target, base) => {
    const rel = path.relative(base, target);
    if (rel === '') return true;
    return rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
  };

  const orchestratorDir = path.resolve(root, '.orchestrator');

  // Resolve a caller path against the project root and REJECT anything that
  // escapes it. Segment-based so a file literally named "..foo" is allowed while
  // a real "../" escape (or an absolute path) is not.
  //
  // Step 10 (hardening): this is the WRITE path (write_file/append_file/mkdir,
  // plus grep's containment check) — resolveReadPath below is deliberately
  // untouched, since workers are told to read session_context.md. A chat
  // worker's tool calls are the enforceable half of this rule (the Claude CLI
  // can't be sandboxed at all; the worker prompt just tells it not to write
  // there — see server.js). Self-corrupting the recipe store / memory.json /
  // tasks.json mid-run is a real risk on a long unattended run, not a
  // hypothetical one this guards against.
  function resolvePath(p) {
    const target = path.resolve(root, String(p ?? ''));
    if (!within(target, root)) throw new Error(`path escapes the project directory: ${p}`);
    if (within(target, orchestratorDir)) throw new Error(`workers may not write under .orchestrator/: ${p}`);
    return target;
  }

  // READS may additionally reach `readRoots` — the orchestrator's context/ dir,
  // which lives outside the project and which every worker prompt tells the
  // model to read. Without this, a chat worker gets ENOENT on the relative path
  // and "escapes the project directory" on the absolute one, then flails; only
  // the unsandboxed Claude CLI could ever honour that instruction.
  //
  // Writes deliberately do NOT get this: a worker that can overwrite the
  // guardrails it was handed is a worker with no guardrails.
  function resolveReadPath(p) {
    const raw = String(p ?? '');
    const target = path.resolve(root, raw);
    if (within(target, root) && fs.existsSync(target)) return target;

    for (const base of extraRoots) {
      // Absolute (as printed in the prompt), relative-to-the-root ("context/x.md"),
      // and bare ("x.md") are all things models actually try.
      const candidates = [
        path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw),
        path.resolve(base, path.basename(raw)),
      ];
      for (const abs of candidates) {
        if (within(abs, base) && fs.existsSync(abs)) return abs;
      }
    }

    // Inside the project but missing: let the tool report a normal ENOENT
    // rather than a confusing sandbox error.
    if (within(target, root)) return target;
    throw new Error(`path escapes the project directory: ${p}`);
  }

  const ctx = { cwd: root, resolvePath, resolveReadPath, env: CHILD_ENV, limits };

  async function run(name, args) {
    const started = Date.now();
    const tool = toolRegistry[name];
    let result;
    if (!tool) {
      result = { ok: false, error: `unknown tool: ${name}` };
    } else {
      try {
        const r = await tool.run(args || {}, ctx);
        result = r && typeof r === 'object' ? r : { ok: true, result: r };
        if (result.ok === undefined) result.ok = true;
      } catch (e) {
        result = { ok: false, error: e.message };
      }
    }
    const durationMs = Date.now() - started;
    if (onLog) onLog(formatLog(name, args, result, durationMs));
    return { ...result, durationMs };
  }

  return { run, resolvePath, ctx };
}
