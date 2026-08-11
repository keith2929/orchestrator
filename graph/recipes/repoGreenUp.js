// graph/recipes/repoGreenUp.js — run whatever green-up scripts the project's
// own package.json defines (test/build/lint, whichever exist), via its own
// package manager. Generic only — no pnpm assumption, no invented script
// names (see REDESIGN_PLAN.md Phase 7: "ship generic recipes only").
export default {
  id: 'repo-green-up',
  description:
    "Run the project's own test/build/lint scripts (whichever it defines), via its own package manager.",
  params: {},

  // Touches the whole workspace (a monorepo "build" script commonly runs
  // `<pkgManager> -r build` under the hood) — must never overlap another
  // in-flight node, or a concurrent source edit races it into a flaky
  // failure that looks like a real regression.
  exclusive: true,

  onFailureHint:
    'A repo-wide test/build/lint script failed. Check for: a stale dist/ copy needing a rebuild, ' +
    'lockfile drift (reinstall), or a genuine regression from a recent change.',

  expand(params, profile) {
    return ['test', 'build', 'lint']
      .filter((s) => profile.scripts.includes(s))
      .map((s) => ({
        tool: 'run_bash',
        args: { command: `${profile.pkgManager} run ${s}` },
        description: `repo-green-up: ${profile.pkgManager} run ${s}`,
      }));
  },
};
