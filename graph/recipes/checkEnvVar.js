// graph/recipes/checkEnvVar.js — a gate: fail fast if a required environment
// variable is not set, before whatever depends on it runs. Cheap and
// deterministic, so it costs nothing to insert ahead of any task that needs
// e.g. an API key already exported.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export default {
  id: 'check-env-var',
  description: 'Gate: fail fast if a required environment variable is not set.',
  params: { name: 'string — the environment variable name to check' },

  onFailureHint: 'A required environment variable is not set. Set it in .env (or export it), then retry.',

  expand(params) {
    const name = String((params && params.name) || '').trim();
    if (!NAME_RE.test(name)) {
      throw new Error(`check-env-var: "name" must be a valid environment variable name, got ${JSON.stringify(params && params.name)}`);
    }
    return [
      {
        tool: 'run_bash',
        args: { command: `test -n "\${${name}:-}" || { echo "Missing required env var: ${name}" >&2; exit 1; }` },
        description: `check-env-var: ${name} is set`,
      },
    ];
  },
};
