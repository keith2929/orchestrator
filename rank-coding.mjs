// rank-coding.mjs — rate each model's CODING ability by making it write code
// and running hidden tests against the result.
//
// Why this exists: the planner is asked to pick "cheaper models for trivial work,
// stronger models for complex work" but is handed a bare list of "client:model"
// strings. With nothing to reason from it picks by name recognition, which is why
// every task landed on Claude. This produces the missing fact — and produces it
// the same way build-models.mjs produces `toolCalling`: by a real call, not by a
// hand-written guess that drifts.
//
//   node rank-coding.mjs                 # rate every usable model, report only
//   node rank-coding.mjs --write         # ...and write codingScore/codingTier
//   node rank-coding.mjs groq            # one client
//   node rank-coding.mjs --include-blocked
//
// Scope: models whose `access` is 'blocked' are skipped — they can't be called,
// so probing them only burns time on guaranteed failures. build-models.mjs sets
// that label; run it first if config has never been probed.
//
// LIMITS, because the score will be over-read otherwise:
//   - It measures single-function correctness on four small problems (20
//     assertions). NOT multi-file agentic work, long-context instruction
//     following, or tool use — the things a Worker actually does. Treat it as a
//     floor ("can this model write correct code at all?"), not a ranking of
//     agent quality. A model scoring 1.00 here can still fail a real task.
//   - Memorisation inflates part of it. LRUCache is LeetCode #146 and nearly
//     every model aces it; the discriminating probes are topoSort (models get
//     the DFS post-order backwards) and parseCsvLine (quote escaping). Read the
//     per-probe detail, not just the total.
//   - Free tiers are the binding constraint on RUNNING it: Gemini allows 20
//     requests/DAY on gemini-3.6-flash, and one full pass over 4 Gemini models
//     is 16. Rate a single client at a time if you hit that.
//
// SAFETY: this executes model-generated code in a child `node` process. It runs
// in a scratch directory under os.tmpdir() with a hard timeout, but it is NOT a
// sandbox — the code can do anything your user can. That is the same trust model
// as the agent's run_bash tool, but it is worth knowing before you point this at
// an untrusted endpoint.

import './env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, getClientsConfig } from './shared.js';
import { loadClients } from './clients/index.js';
import { PROBES, TOTAL_ASSERTIONS } from './coding-probes.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const WRITE = flag('write');
const INCLUDE_BLOCKED = flag('include-blocked');
const RUNS = Number((argv.find((a) => a.startsWith('--runs=')) || '').split('=')[1]) || 1;
const only = argv.find((a) => !a.startsWith('--'));

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-coding-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let unratedCount = 0;

// Models reply with prose and markdown fences however firmly you ask them not
// to. Prefer a fenced block when there is one, else use the whole reply.
export function extractCode(reply) {
  const text = String(reply || '');
  const fenced = [...text.matchAll(/```(?:javascript|js|node)?\s*\n([\s\S]*?)```/g)];
  if (fenced.length) return fenced.map((m) => m[1]).join('\n\n');
  return text;
}

// Run one candidate solution against one probe's assertions. Resolves to the
// number of assertions passed — a crash, a timeout or a missing export is 0,
// never a throw, so one bad model can't abort the run.
export function runProbe(probe, code) {
  const dir = fs.mkdtempSync(path.join(WORK_DIR, 'probe-'));
  const solution = path.join(dir, 'solution.cjs');
  const test = path.join(dir, 'test.cjs');

  // The model is told to use module.exports, but they routinely emit a bare
  // declaration or an ESM `export`. Append a tolerant re-export so a correct
  // function isn't scored 0 over module syntax, which is not what we're testing.
  fs.writeFileSync(
    solution,
    `${code}\n\ntry { module.exports = { ${probe.exportName} }; } catch (e) { /* not declared */ }\n`
  );

  fs.writeFileSync(
    test,
    `
const assert = require('node:assert');
let passed = 0;
function ok(cond, label) { if (cond) passed++; else console.error('  fail: ' + label); }
function eq(actual, expected, label) {
  try { assert.deepStrictEqual(actual, expected); passed++; }
  catch { console.error('  fail: ' + label); }
}
function throws(fn, label) {
  try { fn(); console.error('  fail: ' + label); } catch { passed++; }
}
try {
  const mod = require('./solution.cjs');
  const ${probe.exportName} = mod.${probe.exportName} || mod.default || mod;
  if (typeof ${probe.exportName} === 'undefined') throw new Error('no export named ${probe.exportName}');
  ${probe.tests}
} catch (e) {
  console.error('  crash: ' + (e && e.message));
}
console.log('PASSED=' + passed);
`
  );

  return new Promise((resolve) => {
    execFile('node', [test], { cwd: dir, timeout: 10000 }, (err, stdout) => {
      const m = /PASSED=(\d+)/.exec(String(stdout));
      resolve(m ? Number(m[1]) : 0);
    });
  });
}

// Median of the per-run scores. Median rather than mean so one truncated or
// derailed reply can't drag an otherwise consistent model down a whole tier.
function median(scores) {
  const s = [...scores].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Number(m.toFixed(2));
}

// A score band, not a precise ranking — the probe set is too small to justify
// finer gradations, and pretending otherwise would invite over-reading it.
function tierFor(score) {
  if (score >= 0.9) return 'strong';
  if (score >= 0.65) return 'mid';
  if (score >= 0.3) return 'light';
  return 'weak';
}

// Ask one model all four problems and total its assertions.
//
// The rule that matters here is build-models.mjs's: a verdict we couldn't reach
// is NOT a bad verdict. If the model never answered — quota, rate limit, network
// — scoring the silence as 0 would brand it 'weak', which is a lie that then
// steers the planner away from it forever. So any unanswered probe makes the
// whole model UNRATED (score null): reported, never written.
async function rateModel(client, model) {
  let passed = 0;
  const detail = [];
  let unreachable = '';

  for (const probe of PROBES) {
    let reply;
    // Free tiers rate-limit aggressively (Gemini allows 20 requests/DAY on
    // gemini-3.6-flash), and a burst of probes is exactly what trips them.
    for (let attempt = 0; attempt < 3 && reply === undefined; attempt++) {
      try {
        reply = await client.complete(
          `${probe.prompt}\n\nReply with ONLY JavaScript source code — no explanation, no markdown ` +
            `fences. Use CommonJS: end with module.exports = { ${probe.exportName} };`,
          { model, maxTokens: 1500, cwd: WORK_DIR }
        );
      } catch (e) {
        const msg = String(e.message);
        const retryable = /rate limit|too many requests|\b429\b|timeout|fetch failed/i.test(msg);
        // Honour the provider's own "retry in Ns" when it gives one, but don't
        // sit out a multi-minute daily-quota reset — that's a lost cause here.
        const wait = Number(/retry in ([\d.]+)s/i.exec(msg)?.[1] || 0);
        if (retryable && attempt < 2 && wait < 90) {
          await sleep(wait ? wait * 1000 + 500 : 3000 * (attempt + 1));
          continue;
        }
        unreachable = /quota|429|rate limit/i.test(msg) ? 'quota/rate limit' : msg.slice(0, 45);
        break;
      }
    }
    if (reply === undefined) {
      detail.push(`${probe.name}:—`);
      break; // one dead probe means the run is inconclusive; stop burning calls
    }
    const got = await runProbe(probe, extractCode(reply));
    detail.push(`${probe.name}:${got}`);
    passed += got;
    await sleep(400);
  }

  if (unreachable) return { passed, score: null, detail, unreachable };
  return { passed, score: Number((passed / TOTAL_ASSERTIONS).toFixed(2)), detail };
}

// One client's models, in sequence. Clients run in PARALLEL with each other
// (separate rate-limit buckets) but never internally, so a free tier isn't
// tripped by our own probes.
async function rateClient(id, cfg) {
  const lines = [];
  const kind = cfg.kind || (cfg.baseURL ? 'chat' : 'cli');
  if (cfg.apiKeyEnv && !process.env[cfg.apiKeyEnv]) {
    return { id, lines: [`${id}: SKIP — no ${cfg.apiKeyEnv} set.`], results: [] };
  }
  const client = loadClients()[id];
  const results = [];

  for (const m of cfg.models || []) {
    if (m.access === 'blocked' && !INCLUDE_BLOCKED) {
      lines.push(`  - skip     ${m.id}  (${m.accessNote || 'blocked'})`);
      continue;
    }
    const started = Date.now();
    // Writing code is a sampling decision, so one pass is noisy: gpt-oss-20b
    // scored 1.00 then 0.60 on consecutive runs, nemotron 1.00 then 0.70. The
    // MEDIAN of several passes is what makes the number worth routing on;
    // --runs=1 is fine for a quick look but should not be written to config.
    const attempts = [];
    let passed = 0;
    let detail = [];
    let unreachable = '';
    for (let i = 0; i < RUNS; i++) {
      const r = await rateModel(client, m.id);
      if (r.score === null) {
        // A dead run makes the whole model unrated even if earlier passes
        // succeeded — a median over a truncated sample is not a median.
        unreachable = r.unreachable;
        detail = r.detail;
        break;
      }
      attempts.push(r.score);
      passed = r.passed;
      detail = r.detail;
    }
    const score = unreachable ? null : median(attempts);
    const secs = Math.round((Date.now() - started) / 1000);

    if (score === null) {
      lines.push(`  ? unrated      ${m.id}  (${unreachable}, ${secs}s, ${detail.join(' ')}) — not written`);
      unratedCount++;
      continue;
    }
    const tier = tierFor(score);
    const spread = RUNS > 1 ? ` runs=[${attempts.map((a) => a.toFixed(2)).join(' ')}]` : '';
    lines.push(
      `  ${score >= 0.65 ? '✓' : '·'} ${score.toFixed(2).padEnd(5)} ${tier.padEnd(6)} ` +
        `${m.id}  (${passed}/${TOTAL_ASSERTIONS}, ${secs}s, ${detail.join(' ')}${spread})`
    );
    results.push({ id: m.id, score, tier, runs: RUNS });
  }
  return { id, lines: [`${id}: ${results.length} model(s) rated  [kind=${kind}]`, ...lines], results };
}

// Importing this file (to test the harness, or to reuse runProbe) must not fire
// off a full rating run against every provider.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
  const clients = Object.entries(getClientsConfig()).filter(([id]) => !only || id === only);
  console.log(`Rating ${clients.length} client(s) on ${PROBES.length} problems / ${TOTAL_ASSERTIONS} assertions…\n`);

  const settled = await Promise.all(clients.map(([id, cfg]) => rateClient(id, cfg)));
  for (const s of settled) console.log(s.lines.join('\n') + '\n');
  if (unratedCount) {
    console.log(`${unratedCount} model(s) could not be rated (quota/rate limit) — left unchanged.\n`);
  }

  if (WRITE) {
    const cfgRaw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    let n = 0;
    for (const { id, results } of settled) {
      const models = cfgRaw.clients?.[id]?.models;
      if (!models) continue;
      for (const r of results) {
        const entry = models.find((m) => m.id === r.id);
        if (!entry) continue;
        entry.codingScore = r.score;
        entry.codingTier = r.tier;
        entry.codingRuns = r.runs; // 1 = single noisy sample; treat with suspicion
        entry.codingProbedAt = today;
        n++;
      }
    }
    fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgRaw, null, 2) + '\n');
    console.log(`config.json updated for ${n} model(s) (backup: config.json.bak)`);
  } else {
    console.log('Dry run — re-run with --write to record codingScore/codingTier in config.json.');
  }

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
}
