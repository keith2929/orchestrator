// execution/native.js — native execution for cli clients (the Claude CLI).
//
// This is a byte-for-byte relocation of the original runTask spawn: same argv
// (claudeCliArgs → --model/--print/--permission-mode bypassPermissions), same
// CHILD_ENV, same shell-on-Windows, exit code → ok. It streams stdout/stderr to
// onOut/onErr and resolves { ok, detail }. The claude CLI is already an agent,
// so it does NOT go through the agent framework.
import { spawn, execFile } from 'node:child_process';
import { IS_WIN, CHILD_ENV, detectRateLimit } from '../shared.js';
import { resolveModel } from '../clients/index.js';
import { claudeCliArgs } from '../clients/claude-cli.js';

// One-shot check that the `claude` CLI has a live login session, so a run can
// fail fast with one clear message instead of aborting every queued task with
// the same "Not logged in" stderr. Not a guarantee (the session can still
// expire mid-run) — just catches the common "forgot to log back in" case
// before it burns through the whole plan.
export function checkClaudeAuth(bin = process.env.CLAUDE_BIN || 'claude') {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['--print', '--model', 'sonnet'],
      { timeout: 20000, shell: IS_WIN, env: CHILD_ENV },
      (err, stdout, stderr) => {
        const text = `${stdout || ''}${stderr || ''}`;
        if (/not logged in|please run \/login/i.test(text)) {
          return resolve({ ok: false, message: 'claude CLI is not logged in — run `claude` then `/login` in a terminal, then retry.' });
        }
        if (err && err.code === 'ENOENT') {
          return resolve({ ok: false, message: `\`${bin}\` not found on PATH — is the claude CLI installed?` });
        }
        // A usage/session limit is the other condition worth catching up front:
        // it makes every task exit 1 instantly, so without this the whole plan
        // burns in seconds. `err` guards against a task that merely *mentions*
        // a rate limit in an otherwise successful probe.
        if (err) {
          const limit = detectRateLimit(text);
          if (limit) {
            return resolve({ ok: false, rateLimited: true, message: `${limit.reason} — the run was not started. Wait for the limit to reset, then run again.` });
          }
        }
        // Any other error (bad model name, timeout, etc.) isn't an auth
        // problem we can diagnose here — let the real task run surface it.
        resolve({ ok: true });
      }
    );
    child.stdin.write('ping');
    child.stdin.end();
  });
}

export function executeNative({ ref, prompt, cwd, onOut, onErr, signal }) {
  return new Promise((resolve) => {
    const { client, model } = resolveModel(ref);
    const bin = client.bin || 'claude';

    let child;
    try {
      child = spawn(bin, claudeCliArgs(model), { cwd, shell: IS_WIN, env: CHILD_ENV, signal });
    } catch (e) {
      if (onErr) onErr(`[spawn error] ${e.message}\n`);
      return resolve({ ok: false, detail: `[spawn error] ${e.message}` });
    }

    child.stdout.on('data', (d) => onOut && onOut(d.toString()));
    child.stderr.on('data', (d) => onErr && onErr(d.toString()));
    child.on('error', (e) => {
      const aborted = e.name === 'AbortError' || (signal && signal.aborted);
      if (aborted) {
        if (onErr) onErr('\n[stopped by user]\n');
        return resolve({ ok: false, detail: 'Stopped by user' });
      }
      if (onErr) onErr(`\n[spawn error] ${e.message}\nIs \`${bin}\` installed and on PATH?\n`);
      resolve({ ok: false, detail: `[spawn error] ${e.message}` });
    });
    child.on('close', (code) => resolve({ ok: code === 0, detail: `Process exited with code ${code}` }));

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
