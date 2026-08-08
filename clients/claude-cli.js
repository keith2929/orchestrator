// clients/claude-cli.js — the `claude` CLI as a model client (kind: "cli").
//
// This is the REFERENCE implementation. Its behavior is a byte-for-byte
// relocation of the original server.js `callClaude()` + `buildArgs()`: prompt
// over stdin, allow-listed single-token model in argv, --print, and
// bypassPermissions. It only implements complete() (one-shot text); it has NO
// chat() because the CLI is itself an agent — worker execution for cli clients
// goes through execution/native.js, not the agent framework.

import { execFile } from 'node:child_process';
import { IS_WIN, CHILD_ENV } from '../shared.js';

// A model id must be a single safe token: it is the ONLY user-influenced value
// that reaches argv (the prompt always goes over stdin), so we never let shell
// metacharacters or spaces through. Mirrors the old safeModel() intent.
const SAFE_MODEL = /^[A-Za-z0-9._-]+$/;
function assertSafeModel(model) {
  if (!model || !SAFE_MODEL.test(model)) {
    throw new Error(`Unsafe/empty claude model id: ${JSON.stringify(model)}`);
  }
  return model;
}

// The claude CLI argv. --permission-mode bypassPermissions is REQUIRED: headless
// (--print) claude can't answer permission prompts, so without it a task just
// *describes* the files it would write and exits 0. Exported so the native
// execution backend builds identical args.
export function claudeCliArgs(model) {
  return ['--model', assertSafeModel(model), '--print', '--permission-mode', 'bypassPermissions'];
}

export function makeClaudeClient(id, cfg = {}) {
  const bin = cfg.bin || process.env.CLAUDE_BIN || 'claude';
  const models = Array.isArray(cfg.models) ? cfg.models : [];

  // One-shot text completion. temperature/maxTokens are accepted for interface
  // parity but the CLI has no such flags, so they're ignored. Resolves stdout;
  // rejects with stderr on a non-zero exit so callers surface the failure.
  function complete(prompt, opts = {}) {
    const model = opts.model || 'sonnet';
    const cwd = opts.cwd || process.cwd();
    return new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        claudeCliArgs(model),
        { maxBuffer: 10 * 1024 * 1024, cwd, shell: IS_WIN, env: CHILD_ENV },
        (err, stdout, stderr) => {
          if (err) return reject(new Error((stderr || err.message || '').toString()));
          resolve(String(stdout));
        }
      );
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  return { id, kind: 'cli', bin, models, costTier: cfg.costTier, complete };
}
