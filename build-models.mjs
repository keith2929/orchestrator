// build-models.mjs — derive per-model metadata from EVIDENCE, not guesswork.
//
// Why this exists: `capabilities` in config.json used to be hand-written, and
// hand-written metadata drifts silently. Three ways it bit us:
//   - DeepSeek retired `deepseek-chat`/`deepseek-reasoner` (a 402 for an empty
//     balance masked the 404, so it looked like a billing problem).
//   - Gemini's /models LISTS models the key cannot call ("no longer available
//     to new users"), so a catalogue listing is not proof of usability.
//   - No provider reports tool-calling at all, yet `toolCalling` decides whether
//     a model may back a Worker — wrong value = a task dies mid-run.
// Only a real call settles any of these, so this probes each model for real:
//   list -> tiny completion (usable?) -> tiny tool call (tool-capable?)
// ...except where the catalogue already states tool support (Groq, OpenRouter):
// the provider's own answer beats a probe, so the tool call is skipped there.
//
//   node build-models.mjs                 # probe CONFIGURED models, report only
//   node build-models.mjs --write         # ...and update config.json
//   node build-models.mjs groq --write    # one client
//   node build-models.mjs gemini --discover --limit=25 --write
//
// Default scope is deliberately the models already in config.json: discovery
// probes cost real tokens on paid providers (OpenRouter lists 341 models), so
// it's opt-in via --discover and capped by --limit (default 20).
//
// Safety: a probe that can't reach a verdict — no balance (402), quota/billing
// (429), rate-limited — leaves that model's CAPABILITIES untouched and reports it
// as unverified. Only a genuine "model does not exist" removes an entry, so an
// empty balance can never delete your config. --write backs up config.json.bak.
//
// Besides capabilities, each model gets two labels the UI shows in its dropdowns:
//   access: 'ok' | 'blocked'  — did this key actually complete a call just now?
//   cost:   'free' | 'paid' | 'subscription' — from the provider's own pricing
//           where it publishes one (OpenRouter), else the client's `costTier`.

import './env.js';
import fs from 'node:fs';
import { CONFIG_PATH, getClientsConfig } from './shared.js';
import { loadClients } from './clients/index.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const WRITE = flag('write');
const DISCOVER = flag('discover');
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 20;
const only = argv.find((a) => !a.startsWith('--'));

// Non-conversational models pollute discovery (OpenAI lists 117, mostly these).
const NOT_CHAT =
  /embed|whisper|tts|audio|speech|image|dall-e|sora|moderation|guard|rerank|realtime|transcribe|video|veo|imagen|orpheus|safety|aqa/i;

// A single tool the model can only satisfy by emitting a tool call.
const PROBE_TOOL = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];

// Turn a provider error into a verdict. The distinction that matters: "dead"
// is actionable (remove it), everything else means "couldn't tell" (keep it).
function classify(msg) {
  const m = String(msg);
  if (/no longer available|not found|does not exist|invalid model|unknown model|model_not_found|decommission/i.test(m))
    return { verdict: 'dead', note: 'model does not exist for this key' };
  // Wording varies by provider: DeepSeek "Insufficient Balance",
  // OpenRouter "Insufficient credits", OpenAI "exceeded your current quota".
  if (/insufficient\s+(balance|credit)/i.test(m)) return { verdict: 'unknown', note: 'no balance' };
  if (/insufficient_quota|exceeded your current quota|billing/i.test(m))
    return { verdict: 'unknown', note: 'needs billing' };
  if (/rate limit|too many requests|\b429\b/i.test(m)) return { verdict: 'unknown', note: 'rate-limited' };
  if (/401|403|unauthorized|invalid.*api key/i.test(m)) return { verdict: 'unknown', note: 'auth rejected' };
  // Unrecognised: surface the provider's own message rather than raw JSON.
  const inner = /"message"\s*:\s*"([^"]{3,120})"/.exec(m);
  return { verdict: 'unknown', note: (inner ? inner[1] : m).replace(/\s+/g, ' ').slice(0, 70) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET {baseURL}/models once per client. The id list feeds --discover, and each
// entry's `pricing` block — which OpenRouter publishes and most providers don't
// — is the only hard evidence of what a model costs.
async function fetchCatalogue(cfg) {
  const base = String(cfg.baseURL).replace(/\/+$/, '');
  const resp = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${process.env[cfg.apiKeyEnv]}` },
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json();
  const entries = new Map();
  for (const m of data?.data || []) entries.set(String(m.id).replace(/^models\//, ''), m); // Gemini prefixes "models/"
  return entries;
}

// What does this model cost ME to call? Not the same question as its rate card:
// Groq publishes a per-token price for every model yet serves them free (within
// rate limits) to a key with no billing, so its list price would label the whole
// client "paid" and be wrong in the direction that matters. So an account-level
// costTier — 'free-tier', 'subscription' — outranks pricing, and published
// pricing only decides where the provider bills strictly per-token.
function costOf(entry, model, cfg) {
  if (cfg.costTier === 'free-tier' || cfg.costTier === 'subscription') return cfg.costTier;
  const p = entry?.pricing;
  if (p && p.prompt != null && p.completion != null) {
    return Number(p.prompt) === 0 && Number(p.completion) === 0 ? 'free' : 'paid';
  }
  if (/:free$/.test(model)) return 'free'; // OpenRouter's marker for its no-cost variants
  return cfg.costTier || undefined;
}

// What this model can carry in ONE request, and how fast you may call it.
//
// The distinction that matters, learned from a task that died on a 413: a
// catalogue's `context_length` is what the MODEL supports, not what your KEY may
// send. Groq advertises 131072 for gpt-oss-20b while capping a free-tier request
// at 8000 tokens — the advertised number is off by 16x in the dangerous
// direction. `effectiveRequestTokens` is the min of the two, and is the only one
// worth routing on.
function limitsOf(entry, seen) {
  const out = {};
  const ctx = Number(entry?.context_length ?? entry?.top_provider?.context_length);
  if (Number.isFinite(ctx) && ctx > 0) out.contextTokens = ctx;
  const maxOut = Number(entry?.max_output_length ?? entry?.top_provider?.max_completion_tokens);
  if (Number.isFinite(maxOut) && maxOut > 0) out.maxOutputTokens = maxOut;

  if (seen?.tokensPerWindow) {
    out.tokensPerWindow = seen.tokensPerWindow;
    if (seen.tokenWindow) out.tokenWindow = seen.tokenWindow;
  }
  if (seen?.requestsPerWindow) {
    out.requestsPerWindow = seen.requestsPerWindow;
    if (seen.requestWindow) out.requestWindow = seen.requestWindow;
  }

  const budgets = [out.contextTokens, out.tokensPerWindow].filter(Boolean);
  if (budgets.length) {
    out.effectiveRequestTokens = Math.min(...budgets);
    // How much to trust that number. 'measured' means the provider reported a
    // per-key token limit on a real response (Groq does). 'catalogue' means we
    // only know the model's advertised context and NOTHING about what your key
    // may actually send — Gemini and OpenRouter report no limit headers, so a
    // roomy-looking 262k there is an upper bound, not a promise.
    out.budgetBasis = out.tokensPerWindow ? 'measured' : 'catalogue';
  }
  return Object.keys(out).length ? out : undefined;
}

// Can this key actually call the model? Retries once on a transient rate limit,
// because a 429 on the first try would otherwise read as "couldn't tell".
async function probeUsable(client, model) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await client.complete('Reply with exactly one word: pong', { model, maxTokens: 8 });
      return { verdict: 'usable' };
    } catch (e) {
      const c = classify(e.message);
      if (c.note === 'rate-limited' && attempt === 0) {
        await sleep(2500);
        continue;
      }
      return c;
    }
  }
  return { verdict: 'unknown', note: 'rate-limited' };
}

// Does the catalogue itself state that this model takes tools? Where a provider
// says so, that beats a probe: it's the provider's own answer, it costs nothing,
// and it can't false-negative the way a probe can (a tool-capable model may just
// decline to call the tool on a given turn). The field name varies:
//   Groq        supported_features:   ["tools", "json_mode", …]
//   OpenRouter  supported_parameters: ["tools", "tool_choice", …]
// Only a POSITIVE declaration counts. A list that exists but omits "tools" is
// read as silence, not a denial — same asymmetry as the probe: proof of support
// is definitive, absence of a mention is not, so those still get probed.
const TOOL_DECL_FIELDS = ['supported_features', 'supported_parameters'];
function declaresTools(entry) {
  return TOOL_DECL_FIELDS.some((f) =>
    Array.isArray(entry?.[f]) && entry[f].some((v) => String(v).toLowerCase() === 'tools')
  );
}

// Does it emit a real tool call? A capable model may still decline to call one,
// so this can false-negative — the safe direction (hidden from Workers rather
// than failing mid-task). Errors here mean "couldn't tell", not "no tools".
async function probeTools(client, model) {
  // Two attempts. A tool-CAPABLE model can still decline to call the tool on any
  // given turn (it's a sampling decision), so one silent run is not evidence of
  // "no tool support" — probing once made this script non-deterministic, with
  // the same model reporting ✓ then ✗ across runs. Only two consecutive
  // text-only replies are treated as a no, and then only as *inferred*.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await client.chat(
        [
          {
            role: 'user',
            content:
              'What is the weather in Paris? Call the get_weather tool to find out. Do not answer in plain text.',
          },
        ],
        { model, tools: PROBE_TOOL, maxTokens: 200 }
      );
      if (r.toolCalls?.length) return { tools: true }; // definitive: it called one
      if (attempt < 2) {
        await sleep(600);
        continue;
      }
      return { tools: false, inferred: true };
    } catch (e) {
      const msg = String(e.message);
      // Some providers answer outright — Groq rejects the request with
      // "`tool calling` is not supported with this model". Definitive no.
      if (/tool.?call|function.?call|\btools\b/i.test(msg) && /not support|unsupported|not available|no longer/i.test(msg)) {
        return { tools: false };
      }
      return { tools: null, note: classify(msg).note };
    }
  }
}

const cfgRaw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const clients = loadClients();
const changes = [];
let unverified = 0;

for (const [id, cfg] of Object.entries(getClientsConfig())) {
  if (only && id !== only) continue;
  const kind = cfg.kind || (cfg.baseURL ? 'chat' : 'cli');
  if (kind !== 'chat') {
    console.log(`\n${id}: SKIP (kind "${kind}" — nothing to probe)`);
    continue;
  }
  if (cfg.apiKeyEnv && !process.env[cfg.apiKeyEnv]) {
    console.log(`\n${id}: SKIP — no ${cfg.apiKeyEnv} set.`);
    continue;
  }

  const client = clients[id];
  const configured = (cfg.models || []).map((m) => m.id);
  let targets = configured;

  let catalogue = new Map();
  let catalogueError = '';
  try {
    catalogue = await fetchCatalogue(cfg);
  } catch (e) {
    catalogueError = e.message.slice(0, 60);
  }

  if (DISCOVER) {
    const live = [...catalogue.keys()].filter((m) => !NOT_CHAT.test(m));
    const extra = live.filter((m) => !configured.includes(m)).slice(0, LIMIT);
    targets = [...configured, ...extra];
    console.log(`\n${id}: ${configured.length} configured + ${extra.length} new (of ${live.length} chat-ish live)`);
  } else {
    console.log(`\n${id}: probing ${targets.length} configured model(s)`);
  }
  if (catalogueError) console.log(`  (no catalogue: ${catalogueError} — cost falls back to costTier)`);

  const verified = [];
  for (const model of targets) {
    const isNew = !configured.includes(model);
    const u = await probeUsable(client, model);

    if (u.verdict !== 'usable') {
      if (u.verdict === 'dead' && !isNew) {
        console.log(`  ✗ DEAD       ${model}  (${u.note})`);
        changes.push(`${id}: removed ${model} — ${u.note}`);
      } else if (!isNew) {
        const kept = { ...((cfg.models || []).find((m) => m.id === model) || { id: model }) };
        // An empty balance says nothing about capabilities, but it IS a definite
        // answer about access: this key cannot call the model until you top up.
        // Rate limits and provider outages are noise — they leave `access` alone.
        const blocked = /balance|billing/.test(u.note);
        if (blocked) {
          if (kept.access !== 'blocked') changes.push(`${id}: ${model} access → blocked (${u.note})`);
          kept.access = 'blocked';
          kept.accessNote = u.note;
        }
        const cost = costOf(catalogue.get(model), model, cfg);
        if (cost) kept.cost = cost;
        console.log(`  ${blocked ? '$ blocked  ' : '? unverified'} ${model}  (${u.note}) — capabilities kept as-is`);
        unverified++;
        verified.push(kept);
      }
      await sleep(350);
      continue;
    }

    const entry = catalogue.get(model);
    // Declared support short-circuits the probe (up to 3 calls saved per model).
    const t = declaresTools(entry) ? { tools: true, declared: true } : await probeTools(client, model);
    const prev = (cfg.models || []).find((m) => m.id === model);
    // Merge: only toolCalling is evidence-based here. Anything hand-set
    // (e.g. `reasoning`) is preserved rather than clobbered.
    const caps = { ...(prev?.capabilities || {}) };
    let toolNote;
    if (t.tools === null) {
      // No verdict: keep whatever was configured (nothing at all, if this is a
      // newly discovered model — absent toolCalling means "not worker-eligible",
      // which is the safe default).
      unverified++;
      toolNote = `tools=?  (${t.note})`;
    } else if (t.tools === false && t.inferred && caps.toolCalling === true) {
      // Evidence is asymmetric: seeing a tool call PROVES capability, while a
      // text-only reply only suggests its absence (the model may just have
      // declined). Never let the weak signal erase a confirmed true, or the
      // same model flaps ✓/✗ between runs and the metadata is worthless.
      toolNote = 'tools=✓ (kept — declined to call this run)';
    } else {
      if (prev && !!caps.toolCalling !== t.tools) {
        changes.push(`${id}: ${model} toolCalling ${!!caps.toolCalling} → ${t.tools}`);
      }
      caps.toolCalling = t.tools;
      // "inferred" = it answered in text twice rather than the provider saying
      // tools are unsupported. Worth showing, since it's the weaker signal.
      toolNote = `tools=${t.tools ? (t.declared ? '✓ (declared)' : '✓') : t.inferred ? '✗ (inferred)' : '✗'}`;
    }
    const cost = costOf(entry, model, cfg);
    // Read straight after the probe calls, so the headers describe THIS model.
    const limits = limitsOf(entry, client.seenLimits?.());
    if (prev?.access === 'blocked') changes.push(`${id}: ${model} access → ok (was blocked)`);
    if (isNew) changes.push(`${id}: added ${model} (${toolNote.replace(/\s+/g, ' ')})`);
    const budget = limits?.effectiveRequestTokens;
    console.log(
      `  ${isNew ? '+ new ' : '✓ ok  '} ${model}  ${toolNote}${cost ? `  ${cost}` : ''}` +
        `${budget ? `  budget=${budget >= 1000 ? Math.round(budget / 1000) + 'k' : budget}` : ''}`
    );
    // Spread `prev` first so fields this script does NOT own survive a --write.
    // rank-coding.mjs writes codingScore/codingTier/codingRuns onto the same
    // entries; rebuilding the object from scratch silently wiped them, and the
    // loss is invisible until the planner starts routing on missing data.
    const { accessNote, ...keep } = prev || {};
    verified.push({
      ...keep,
      id: model,
      capabilities: caps,
      access: 'ok', // proven: it just answered a real call with this key
      ...(cost ? { cost } : {}),
      ...(limits ? { limits } : {}),
      verifiedAt: new Date().toISOString().slice(0, 10),
    });
    await sleep(350);
  }

  if (WRITE && verified.length) {
    cfgRaw.clients = cfgRaw.clients || {};
    cfgRaw.clients[id] = { ...(cfgRaw.clients[id] || cfg), models: verified };
  } else if (WRITE) {
    console.log(`  (nothing verified for ${id} — leaving its config untouched)`);
  }
}

console.log('\n' + '─'.repeat(60));
if (!changes.length) console.log('No metadata changes — config already matches reality.');
else changes.forEach((c) => console.log('  • ' + c));
if (unverified) console.log(`\n${unverified} model(s) could not be verified (balance/quota/rate limit) — left unchanged.`);

if (WRITE) {
  fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgRaw, null, 2) + '\n');
  console.log(`\nconfig.json updated (backup: config.json.bak)`);
} else if (changes.length) {
  console.log('\nDry run — re-run with --write to apply.');
}
