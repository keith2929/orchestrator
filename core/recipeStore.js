// core/recipeStore.js — recipes as versioned, hand-editable files under
// <targetDir>/.orchestrator/recipes/ (see HARDENING_PLAN.md step 11).
//
// Layout:
//   recipes/index.json                 cache only — files are authoritative
//   recipes/candidates/<id>.vN.md      proposed; NOT resolvable
//   recipes/<id>/vN.md                 published, retained forever
//
// File format: scalar frontmatter (hand-editable) + fenced ```json blocks for
// ## Steps and ## Evidence. See HARDENING_PLAN.md Appendix A.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const SECTION_RE = /^##\s+(.+?)\s*$/;

function parseFrontmatter(block) {
  const out = {};
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function serializeFrontmatter(fm) {
  return Object.entries(fm)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

// Splits body markdown into named sections by "## Heading" lines.
function parseSections(body) {
  const lines = body.split('\n');
  const sections = {};
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) sections[current] = buf.join('\n').trim();
    buf = [];
  };
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) {
      flush();
      current = m[1];
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function extractFencedJson(text) {
  if (!text) return undefined;
  const m = /```json\n([\s\S]*?)\n?```/.exec(text);
  if (!m) throw new Error('expected a single fenced ```json block');
  return JSON.parse(m[1]);
}

function fenceJson(value) {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

// Parses a recipe file's raw text into a record, or throws with a message
// naming what's wrong (caller wraps this into an { status: 'invalid' }
// index entry rather than letting a bad file silently resolve to nothing).
export function parseRecipeFile(content, { requireSteps = true } = {}) {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) throw new Error('missing frontmatter block (--- ... ---)');
  const frontmatter = parseFrontmatter(m[1]);
  const sections = parseSections(m[2]);

  if (!frontmatter.id) throw new Error('frontmatter missing "id"');
  const version = Number(frontmatter.version);
  if (!Number.isInteger(version) || version < 1) throw new Error('frontmatter "version" must be an integer >= 1');
  if (!['candidate', 'published', 'deprecated'].includes(frontmatter.status)) {
    throw new Error(`frontmatter "status" must be candidate|published|deprecated, got ${JSON.stringify(frontmatter.status)}`);
  }

  let steps;
  if (sections['Steps'] !== undefined) {
    steps = extractFencedJson(sections['Steps']);
    if (!Array.isArray(steps)) throw new Error('## Steps must be a JSON array');
  } else if (requireSteps) {
    throw new Error('missing ## Steps block');
  }

  let evidence = { successes: 0, failures: 0, sourceLessons: [], history: [] };
  if (sections['Evidence'] !== undefined) {
    const parsed = extractFencedJson(sections['Evidence']);
    evidence = { ...evidence, ...parsed };
  }

  return {
    id: frontmatter.id,
    version,
    status: frontmatter.status,
    supersedes: frontmatter.supersedes || null,
    createdAt: frontmatter.createdAt || null,
    approvedAt: frontmatter.approvedAt || null,
    confidence: frontmatter.confidence !== undefined ? Number(frontmatter.confidence) : 0.5,
    confidenceSource: frontmatter.confidenceSource || 'derived',
    description: sections['Description'] || '',
    steps: steps || [],
    onFailureHint: sections['On failure'] || '',
    evidence,
    _extraFrontmatter: Object.fromEntries(
      Object.entries(frontmatter).filter(
        ([k]) => !['id', 'version', 'status', 'supersedes', 'createdAt', 'approvedAt', 'confidence', 'confidenceSource'].includes(k)
      )
    ),
  };
}

// Deterministic serialisation — a rewrite produces no spurious diff.
export function serializeRecipeFile(record) {
  const fm = {
    id: record.id,
    version: record.version,
    status: record.status,
    supersedes: record.supersedes || undefined,
    createdAt: record.createdAt || undefined,
    approvedAt: record.approvedAt || undefined,
    confidence: record.confidence,
    confidenceSource: record.confidenceSource || 'derived',
    ...(record._extraFrontmatter || {}),
  };
  const parts = [`---\n${serializeFrontmatter(fm)}\n---`, '', '## Description', record.description || ''];
  if (record.steps) parts.push('', '## Steps', fenceJson(record.steps));
  parts.push('', '## On failure', record.onFailureHint || '');
  parts.push('', '## Evidence', fenceJson(record.evidence || { successes: 0, failures: 0, sourceLessons: [], history: [] }));
  return parts.join('\n') + '\n';
}

function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function listVersionFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^v(\d+)\.md$/.test(f))
      .map((f) => ({ file: f, version: Number(/^v(\d+)\.md$/.exec(f)[1]) }));
  } catch {
    return [];
  }
}

// Scans recipes/<id>/vN.md and recipes/candidates/<id>.vN.md, parses every
// file, and derives status per id: which published version is ACTIVE (the
// highest-numbered published version nothing supersedes), which are
// superseded, and which files are invalid — never silently dropped.
// builtinIds lets a directory that shadows a built-in id be flagged instead
// of silently winning.
export function reconcileIndex(recipesDir, builtinIds = []) {
  const entries = {}; // id -> { versions: { N: {...} }, active: N|null }
  const builtinSet = new Set(builtinIds);

  const dirs = (() => {
    try {
      return fs.readdirSync(recipesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'candidates');
    } catch {
      return [];
    }
  })();

  for (const d of dirs) {
    const id = d.name;
    const dirPath = path.join(recipesDir, d.name);
    const versions = {};
    const seen = new Set();
    for (const { file, version } of listVersionFiles(dirPath)) {
      if (seen.has(version)) {
        // Two files claiming the same version number — both invalid.
        versions[version] = { status: 'invalid', error: `duplicate version ${version} in ${id}/`, path: path.join(dirPath, file) };
        continue;
      }
      seen.add(version);
      const filePath = path.join(dirPath, file);
      let record;
      try {
        record = parseRecipeFile(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        versions[version] = { status: 'invalid', error: e.message, path: filePath };
        continue;
      }
      if (builtinSet.has(id)) {
        versions[version] = { status: 'shadowed', path: filePath, record };
        continue;
      }
      versions[version] = { status: record.status, path: filePath, record, contentHash: contentHash(fs.readFileSync(filePath, 'utf8')) };
    }
    const publishedVersions = Object.keys(versions)
      .map(Number)
      .filter((v) => versions[v].status === 'published')
      .sort((a, b) => b - a);
    const active = publishedVersions[0] ?? null;
    for (const v of publishedVersions.slice(1)) versions[v].derived = 'superseded';
    if (active !== null) versions[active].derived = 'active';
    entries[id] = { versions, active };
  }

  const candidates = {};
  const candidatesDir = path.join(recipesDir, 'candidates');
  let candidateFiles = [];
  try {
    candidateFiles = fs.readdirSync(candidatesDir).filter((f) => /\.v\d+\.md$/.test(f));
  } catch {
    /* no candidates dir yet */
  }
  for (const file of candidateFiles) {
    const filePath = path.join(candidatesDir, file);
    let record;
    try {
      record = parseRecipeFile(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      candidates[file] = { status: 'invalid', error: e.message, path: filePath };
      continue;
    }
    candidates[file] = { status: 'candidate', path: filePath, record };
  }

  return { entries, candidates };
}

// Resolves an id to its ACTIVE published version's parsed record, or null.
export function resolveActiveVersion(recipesDir, id, builtinIds = []) {
  const { entries } = reconcileIndex(recipesDir, builtinIds);
  const e = entries[id];
  if (!e || e.active === null) return null;
  const v = e.versions[e.active];
  return v && v.status === 'published' ? v.record : null;
}

// Writes a NEW candidate file. Version is max(existing candidate + published
// versions for this id) + 1 — the write path only ever creates, never opens
// an existing version for write.
export function writeCandidate(recipesDir, { id, description, steps, onFailureHint, sourceLessons }) {
  const { entries, candidates } = reconcileIndex(recipesDir, []);
  const publishedMax = entries[id] ? Math.max(0, ...Object.keys(entries[id].versions).map(Number)) : 0;
  const candidateMax = Math.max(
    0,
    ...Object.values(candidates)
      .filter((c) => c.record && c.record.id === id)
      .map((c) => c.record.version)
  );
  const version = Math.max(publishedMax, candidateMax) + 1;

  const record = {
    id,
    version,
    status: 'candidate',
    createdAt: new Date().toISOString(),
    confidence: 0.5,
    confidenceSource: 'derived',
    description: description || '',
    steps,
    onFailureHint: onFailureHint || '',
    evidence: { successes: 0, failures: 0, sourceLessons: sourceLessons || [], history: [] },
  };
  const candidatesDir = path.join(recipesDir, 'candidates');
  fs.mkdirSync(candidatesDir, { recursive: true });
  const filePath = path.join(candidatesDir, `${id}.v${version}.md`);
  fs.writeFileSync(filePath, serializeRecipeFile(record));
  return { path: filePath, record };
}

// Approval is a MOVE: candidates/<id>.vN.md -> <id>/vN.md, status ->
// published. The candidate file is deleted; v1.md etc. are never opened for
// write again after this.
export function approveCandidate(recipesDir, id, version) {
  const candidatesDir = path.join(recipesDir, 'candidates');
  const src = path.join(candidatesDir, `${id}.v${version}.md`);
  const record = parseRecipeFile(fs.readFileSync(src, 'utf8'));
  record.status = 'published';
  record.approvedAt = new Date().toISOString();

  const { entries } = reconcileIndex(recipesDir, []);
  if (entries[id] && entries[id].active !== null) {
    record.supersedes = `${id}@${entries[id].active}`;
  }

  const destDir = path.join(recipesDir, id);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `v${version}.md`);
  fs.writeFileSync(dest, serializeRecipeFile(record));
  fs.unlinkSync(src);
  return { path: dest, record };
}

// Laplace-smoothed, starts at 0.5, bounded, monotone in the evidence.
export function computeConfidence(successes, failures) {
  return (successes + 1) / (successes + failures + 2);
}

// Appends an outcome to a published version's Evidence and recomputes
// confidence, with a history row recording the before/after — never
// promotes anything (that's what approving a NEW candidate is for).
export function recordEvidence(recipesDir, id, version, outcome, taskId) {
  const filePath = path.join(recipesDir, id, `v${version}.md`);
  const record = parseRecipeFile(fs.readFileSync(filePath, 'utf8'));
  const ev = record.evidence;
  const scoreBefore = record.confidence;
  if (outcome === 'success') ev.successes = (ev.successes || 0) + 1;
  else ev.failures = (ev.failures || 0) + 1;
  ev.history = ev.history || [];
  const scoreAfter = record.confidenceSource === 'manual' ? scoreBefore : computeConfidence(ev.successes, ev.failures);
  ev.history.push({ at: new Date().toISOString(), outcome, taskId, scoreBefore, scoreAfter });
  if (record.confidenceSource !== 'manual') record.confidence = scoreAfter;
  fs.writeFileSync(filePath, serializeRecipeFile(record));
  return record;
}

// A human hand-editing confidence in frontmatter is honoured but flagged —
// recorded with a history row the next time evidence is recorded, and
// confidenceSource stays 'manual' until a future edit clears it.
export function setManualConfidence(recipesDir, id, version, confidence) {
  const filePath = path.join(recipesDir, id, `v${version}.md`);
  const record = parseRecipeFile(fs.readFileSync(filePath, 'utf8'));
  const scoreBefore = record.confidence;
  record.confidence = confidence;
  record.confidenceSource = 'manual';
  record.evidence.history = record.evidence.history || [];
  record.evidence.history.push({ at: new Date().toISOString(), outcome: 'manual', taskId: null, scoreBefore, scoreAfter: confidence });
  fs.writeFileSync(filePath, serializeRecipeFile(record));
  return record;
}
