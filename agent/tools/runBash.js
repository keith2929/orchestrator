// run_bash — run a shell command in the project directory.
//
// NOTE: this is a real shell. It is NOT sandboxed to the project directory —
// a command can reach outside via absolute paths. This is the documented "same
// trust as claude --permission-mode bypassPermissions" boundary (see
// MODEL_AGNOSTIC_PLAN.md). Only ever point targetDir at a repo you trust.
import { execFile } from 'node:child_process';
import { IS_WIN } from '../../shared.js';

export default {
  name: 'run_bash',
  description:
    'Run a shell command in the project directory and return its stdout, stderr and exit code. The environment is non-interactive (CI=true); prefer flags that avoid prompts.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
    },
    required: ['command'],
  },
  run(args, ctx) {
    return new Promise((resolve) => {
      const timeout = ctx.limits?.bashTimeoutMs ?? 120000;
      const maxBuffer = ctx.limits?.bashMaxBuffer ?? 4 * 1024 * 1024;
      const command = String(args.command ?? '');
      const file = IS_WIN ? 'cmd' : 'bash';
      const cmdArgs = IS_WIN ? ['/c', command] : ['-lc', command];
      execFile(
        file,
        cmdArgs,
        { cwd: ctx.cwd, env: ctx.env, timeout, maxBuffer },
        (err, stdout, stderr) => {
          const timedOut = !!(err && err.killed);
          const exitCode = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
          resolve({
            ok: exitCode === 0 && !timedOut,
            exitCode,
            timedOut,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
          });
        }
      );
    });
  },
};
