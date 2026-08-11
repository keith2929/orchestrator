// graph/recipeMiner.js — post-mortem recipe mining. Pure code, zero LLM:
// normalises text (strips variable tokens to placeholders) and clusters
// recurring patterns across task descriptions, memory.json's residual
// lessons, and — chat workers only — the structured "🔧 tool(args) → result"
// lines toolRunner's formatLog already writes to logs/task-*.log. A CLI task
// has no tool trace, so it degrades to description-clustering, which is how
// the green-up duplication was originally found by hand (see
// REDESIGN_PLAN.md's Established Findings).
import fs from 'node:fs';
import path from 'node:path';
import { recipeList } from './recipes/index.js';

// Strips the parts of a string that vary between otherwise-identical
// occurrences (numbers, hashes, quoted literals, paths, task ids) down to a
// placeholder, so "Stage 3" and "Stage 5" normalise to the same text instead
// of looking unrelated.
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/`[^`]*`/g, '<code>')
    .replace(/"[^"]*"/g, '<str>')
    .replace(/'[^']*'/g, '<str>')
    .replace(/\btask-[\w.]+\b/g, '<taskid>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hash>')
    .replace(/(\.?\/[\w.-]+){2,}/g, '<path>')
    .replace(/\b\d+(\.\d+)?\b/g, '<num>')
    .replace(/[^a-z0-9<> ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenSet(normalized) {
  return new Set(normalized.split(' ').filter(Boolean));
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Groups `items` (each { id, text, ...extra }) into clusters of near-
// duplicate `text`, by token-Jaccard similarity over the normalised form.
// O(n^2) — fine at the scale of one project's task/log history; this is not
// meant to run continuously (see the curator role: one bounded LLM call per
// surfaced candidate, not per mining pass, let alone per comparison).
export function clusterByText(items, { threshold = 0.55, minSize = 3 } = {}) {
  const prepped = items.map((it) => {
    const norm = normalize(it.text);
    return { ...it, norm, tokens: tokenSet(norm) };
  });
  const used = new Array(prepped.length).fill(false);
  const clusters = [];
  for (let i = 0; i < prepped.length; i++) {
    if (used[i] || !prepped[i].tokens.size) continue;
    const group = [prepped[i]];
    used[i] = true;
    for (let j = i + 1; j < prepped.length; j++) {
      if (used[j]) continue;
      if (jaccard(prepped[i].tokens, prepped[j].tokens) >= threshold) {
        group.push(prepped[j]);
        used[j] = true;
      }
    }
    // Strip the working `norm`/`tokens` fields — they're clustering
    // scratch state, not part of the public shape a caller (or the
    // curator role) should see.
    if (group.length >= minSize) {
      clusters.push(group.map(({ norm, tokens, ...rest }) => rest));
    }
  }
  return clusters;
}

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// Source 1: every task description in the current plan (tasks.json). This is
// how the green-up trio (task-4.b / task-11.b / task-17.a.ii, each a
// hand-authored "run pnpm -r test/build/lint and fix regressions" tail) gets
// found — they're near-identical prose the splitter emitted three times.
function descriptionItems(tasksPath) {
  const tasks = readJsonSafe(tasksPath, []);
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t.type !== 'tool' && t.type !== 'recipe' && t.description)
    .map((t) => ({ id: t.id, text: t.description, source: 'task-description' }));
}

// Source 2: memory.json's residual lessons (ones that never matched an
// existing recipe — see Phase 8) — a recurring root_cause/lesson across
// several unrelated tasks is itself a signal worth surfacing, even before
// any recipe exists to fold it into.
function memoryItems(memoryPath) {
  const mem = readJsonSafe(memoryPath, []);
  return (Array.isArray(mem) ? mem : []).map((m) => ({
    id: m.id || m.taskId,
    text: [m.error_summary, m.root_cause, m.lesson].filter(Boolean).join(' '),
    source: 'memory',
  }));
}

// Source 3: chat workers' own tool-call transcripts. CLI tasks (the opaque
// Claude CLI) leave no trace here — see toolRunner.js's formatLog, which
// only chat-client tasks go through — so this degrades gracefully to just
// the other two sources for an all-CLI project.
const TOOL_LOG_LINE = /^🔧 (\w+)\((.*)\) → /;
function toolLogItems(logsDir) {
  let files = [];
  try {
    files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
  } catch {
    return [];
  }
  const items = [];
  for (const f of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(logsDir, f), 'utf8');
    } catch {
      continue;
    }
    const taskId = f.replace(/\.log$/, '');
    let n = 0;
    for (const line of content.split('\n')) {
      const m = TOOL_LOG_LINE.exec(line);
      if (!m) continue;
      n++;
      items.push({ id: `${taskId}#${n}`, text: `${m[1]} ${m[2]}`, source: 'tool-log', taskId, tool: m[1] });
    }
  }
  return items;
}

// The main entry point. Returns clusters across all three sources, each
// tagged with which source(s) it came from and the member items so a caller
// (or a human) can see exactly what was grouped together.
export function mineCandidates({ tasksPath, memoryPath, logsDir }, opts = {}) {
  const items = [
    ...(tasksPath ? descriptionItems(tasksPath) : []),
    ...(memoryPath ? memoryItems(memoryPath) : []),
    ...(logsDir ? toolLogItems(logsDir) : []),
  ];
  // Cluster each source independently — mixing e.g. a task description with
  // a raw tool-call line would never legitimately match, and keeping sources
  // separate makes each cluster's provenance unambiguous.
  const bySource = new Map();
  for (const it of items) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }
  const clusters = [];
  for (const [source, group] of bySource) {
    for (const cluster of clusterByText(group, opts)) {
      clusters.push({ source, size: cluster.length, members: cluster });
    }
  }
  return clusters;
}

// Cross-checks a cluster against the project's own conventions BEFORE
// anyone proposes a bespoke recipe for it (see REDESIGN_PLAN.md Phase 9):
// - matchesProfileScripts: which of the project's own package.json scripts
//   are mentioned in the cluster's text — if a curated recipe gets built
//   for this cluster, it should delegate to these rather than freeze the
//   literal observed command strings.
// - matchesExistingRecipe: a built-in (or previously-promoted) recipe whose
//   own expand() output overlaps this cluster closely enough that nothing
//   new needs to be authored at all — this is what should happen for
//   valuation-calc's green-up trio, since repo-green-up (Phase 7) already
//   covers exactly this pattern.
export function annotateCandidate(cluster, profile) {
  // Raw (not placeholder-normalised) tokens for the script-name check —
  // normalize() replaces quoted substrings with <str>, which is exactly
  // where a shell command like 'pnpm -r test' lives, so the literal script
  // name would otherwise never be seen.
  const rawTokens = tokenSet(
    cluster.members
      .map((m) => m.text)
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
  );
  const matchesProfileScripts = (profile.scripts || []).filter((s) => rawTokens.has(s.toLowerCase()));

  // Same reasoning: compare RAW tokens against each recipe's own expanded
  // output, not the placeholder-normalised form — the whole point is to
  // catch literal script/command-name overlap ("test", "build", "pnpm").
  //
  // Overlap COEFFICIENT (intersection / recipe's own token count), not
  // Jaccard (intersection / union): a cluster's prose is typically much
  // longer than a recipe's terse "pnpm run test" output, so union-based
  // similarity is dominated by the cluster's unrelated words ("stale",
  // "lockfile", "sync-workspace-dists") and never crosses a sane threshold.
  // What actually matters is whether the recipe's own small set of
  // distinctive words shows up in the cluster at all.
  const NOISE_TOKENS = new Set(['tool', 'run_bash', 'command', 'args']);
  let matchesExistingRecipe = null;
  for (const recipe of recipeList) {
    let steps;
    try {
      steps = recipe.expand({}, profile);
    } catch {
      continue;
    }
    if (!Array.isArray(steps) || !steps.length) continue;
    const stepTokens = [
      ...tokenSet(
        steps
          .map((s) => `${s.tool} ${JSON.stringify(s.args || {})}`)
          .join(' ')
          .toLowerCase()
          .replace(/[^a-z0-9 ]+/g, ' ')
      ),
    ].filter((t) => !NOISE_TOKENS.has(t) && t.length > 1);
    if (!stepTokens.length) continue;
    const covered = stepTokens.filter((t) => rawTokens.has(t)).length;
    if (covered / stepTokens.length >= 0.5) {
      matchesExistingRecipe = recipe.id;
      break;
    }
  }

  return { ...cluster, matchesProfileScripts, matchesExistingRecipe };
}
