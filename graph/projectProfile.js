// graph/projectProfile.js — one-time, zero-LLM detection of a project's own
// build tooling, so a recipe never freezes an assumption (a hardcoded "pnpm",
// an invented script name) that doesn't match the target repo. Sourcing
// priority: package.json scripts -> monorepo config (turbo.json/nx.json) ->
// hardcoded fallback (see REDESIGN_PLAN.md Phase 7).
import fs from 'node:fs';
import path from 'node:path';

// Detection reads a handful of files off disk — cheap, but no reason to
// repeat it on every recipe expansion within the same run. Keyed by absolute
// cwd since one orchestrator process can point at different targetDirs.
const cache = new Map();

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Lockfile presence is the most reliable signal — package.json's own
// "packageManager" field is opt-in and often absent even in real pnpm/yarn
// projects.
function detectPkgManager(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
  return 'npm';
}

export function detectProjectProfile(cwd) {
  const cached = cache.get(cwd);
  if (cached) return cached;

  const pkg = readJsonSafe(path.join(cwd, 'package.json'));
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : [];
  const monorepo =
    fs.existsSync(path.join(cwd, 'turbo.json')) ||
    fs.existsSync(path.join(cwd, 'nx.json')) ||
    fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml')) ||
    !!(pkg && pkg.workspaces);

  const profile = {
    hasPackageJson: !!pkg,
    pkgManager: detectPkgManager(cwd),
    scripts,
    monorepo,
  };
  cache.set(cwd, profile);
  return profile;
}

// A profile going stale mid-run (scripts changing under us) is unlikely
// within one orchestrator run, but cheap to support explicitly rather than
// leave undetectable.
export function clearProfileCache(cwd) {
  if (cwd) cache.delete(cwd);
  else cache.clear();
}
