// agent/executor.js — the generic conversation + tool loop.
//
// Works with ANY chat client that implements the normalized
//   chat(messages, { model, tools }) -> { content, toolCalls[] }
// interface (see clients/openai.js). It owns iteration/wall-clock limits, tool
// dispatch, and completion detection. It never names a provider.
import { createToolRunner } from './toolRunner.js';
import { toolSchemas } from './tools/index.js';
import { parseRetryAfterMs } from '../shared.js';

const DEFAULT_LIMITS = {
  // 25 was not enough for a real task: orienting in a 4,200-file vault and
  // reading a 48KB spec consumed the whole budget, and the worker died holding
  // a finished artifact it never got to commit. The cap is here to stop runaway
  // loops, not to cut off work that is progressing.
  maxIterations: 40,
  wallClockMs: 10 * 60 * 1000,
  bashTimeoutMs: 120000,
  maxFileBytes: 256 * 1024,
  bashMaxBuffer: 4 * 1024 * 1024,
  chatAttempts: 5, // per turn, across transient failures
  // Cap on the accumulated transcript before old tool results get elided.
  // ~16k tokens: generous for a large-context model, while still stopping the
  // unbounded growth that turns a long task into a request-too-large failure.
  // Lower it for a model on a small per-request budget.
  transcriptBudgetChars: 60000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tool results are the dominant cost in a long transcript and they accumulate
// permanently: each is capped at 8000 chars (~2200 tokens), so four file reads
// alone exceed a free tier's whole 8000-token request budget. Older results
// have usually already been acted on, so drop their bodies and keep the recent
// ones intact — a model can always re-read a file, but it cannot recover from
// a "request too large". Returns how many were elided.
function compactTranscript(messages, { keepRecent = 3, budgetChars }) {
  const size = () =>
    messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  if (size() <= budgetChars) return 0;

  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  let elided = 0;

  const elide = (i) => {
    const m = messages[i];
    if (typeof m.content !== 'string' || m.content.length <= 200) return false;
    m.content = JSON.stringify({
      ok: true,
      elided: 'earlier tool result dropped to stay within the context budget — re-read if you still need it',
      original_chars: m.content.length,
    });
    elided++;
    return true;
  };

  // Oldest first, preserving the `keepRecent` most recent results…
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent))) {
    elide(i);
    if (size() <= budgetChars) return elided;
  }

  // …but keepRecent full results can exceed the budget on their own (3 × the
  // 8000-char cap is 24000), which would silently blow a budget set for a
  // small-context model. So give up the recent ones too rather than the budget,
  // keeping only the very last result — the one the model is mid-way reasoning
  // about — intact.
  for (const i of toolIdx.slice(Math.max(0, toolIdx.length - keepRecent), -1)) {
    elide(i);
    if (size() <= budgetChars) break;
  }
  return elided;
}

// Worth waiting out rather than killing the task for. Free tiers rate-limit by
// TOKENS per minute (Groq: 8k TPM), so a worker doing real work trips this
// constantly — treating it as fatal aborted 13 of 16 tasks in one run.
const RETRYABLE = /rate limit|rate_limit|too many requests|\b429\b|\b50[0234]\b|timeout|fetch failed|ECONNRESET|socket hang up/i;

// ...but "request too large" is NOT that, despite arriving with the same
// rate_limit_exceeded code and TPM wording. The transcript exceeds what one
// request may carry, so it fails identically no matter how long you wait —
// retrying just burns the attempt budget and delays a clear error. Checked
// FIRST because the message matches RETRYABLE too.
const TOO_LARGE = /request too large|reduce your message size|\b413\b|context.{0,15}(too long|length exceeded)|maximum context length/i;

// The model emitted a call to a tool that doesn't exist and the provider
// rejected the whole request (Groq: 400 tool_use_failed). Nothing ran, so this
// is recoverable in-band — see the handler below.
const UNKNOWN_TOOL = /tool_use_failed|attempted to call tool|not in request\.tools/i;

export async function runAgent({ client, model, systemPrompt, userPrompt, cwd, onOut, onErr, limits, readRoots, signal }) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const runner = createToolRunner({ cwd, limits: lim, readRoots, onLog: (line) => onOut && onOut(line) });
  const tools = toolSchemas();

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const started = Date.now();
  for (let i = 0; i < lim.maxIterations; i++) {
    if (signal && signal.aborted) {
      return { ok: false, reason: 'stopped by user', iterations: i };
    }
    if (Date.now() - started > lim.wallClockMs) {
      return { ok: false, reason: `wall-clock limit (${lim.wallClockMs}ms) exceeded`, iterations: i };
    }

    let turn;
    let lastErr = null;
    for (let attempt = 0; attempt < lim.chatAttempts; attempt++) {
      try {
        turn = await client.chat(messages, { model, tools });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const msg = String(e.message);

        // Invented tool name: the provider refused the request, so no tool ran
        // and the transcript is still clean. Tell the model what actually
        // exists and let it try again — far better than losing the task.
        if (UNKNOWN_TOOL.test(msg)) {
          const named = /call tool '([^']+)'/.exec(msg)?.[1];
          messages.push({
            role: 'user',
            content:
              `Your previous reply tried to call ${named ? `a tool named "${named}"` : 'a tool'} that does not exist. ` +
              `The ONLY tools available are: ${tools.map((t) => t.function.name).join(', ')}. ` +
              `Retry using one of those exact names.`,
          });
          if (onOut) onOut(`[agent] unknown tool${named ? ` "${named}"` : ''} — corrected, retrying\n`);
          continue;
        }

        if (TOO_LARGE.test(msg)) {
          if (onErr) {
            onErr(
              `[agent] transcript too large for one request — this model's per-request budget ` +
                `cannot hold this task's context. Not retryable; use a model with a larger budget.\n`
            );
          }
          break;
        }

        if (RETRYABLE.test(msg) && attempt < lim.chatAttempts - 1) {
          const wait = Math.min(parseRetryAfterMs(msg) + 500 || 2000 * (attempt + 1), 60000);
          if (Date.now() - started + wait > lim.wallClockMs) break; // no point sleeping past the deadline
          if (onOut) {
            onOut(
              `[agent] ${/429|rate limit/i.test(msg) ? 'rate-limited' : 'transient error'} — ` +
                `retrying in ${(wait / 1000).toFixed(1)}s (attempt ${attempt + 2}/${lim.chatAttempts})\n`
            );
          }
          await sleep(wait);
          continue;
        }
        break;
      }
    }
    if (!turn) {
      if (onErr) onErr(`[agent] model error: ${lastErr.message}\n`);
      return { ok: false, reason: `model error: ${lastErr.message}`, iterations: i };
    }

    // Stream any assistant narration to the console.
    if (turn.content && turn.content.trim() && onOut) onOut(turn.content.trim() + '\n');

    // Record the assistant turn (incl. tool_calls) so the model keeps context.
    //
    // Echo the provider's OWN message object when we have it. Some providers
    // attach fields that must come back verbatim on the next turn — Gemini
    // rejects the whole request with "Function call is missing a
    // thought_signature in functionCall parts" if they're dropped, which made
    // every Gemini worker die immediately after its first tool call. A
    // reconstructed message loses them, so reconstruct only as a fallback.
    let assistantMsg = turn.raw && typeof turn.raw === 'object' ? { role: 'assistant', ...turn.raw } : null;
    if (!assistantMsg) {
      assistantMsg = { role: 'assistant', content: turn.content || '' };
      if (turn.toolCalls && turn.toolCalls.length) {
        assistantMsg.tool_calls = turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        }));
      }
    }
    messages.push(assistantMsg);

    // No tool calls → the model is done talking. Soft completion.
    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      return { ok: true, summary: (turn.content || '').trim() || '(no summary)', iterations: i + 1, viaExplicit: false };
    }

    // Run each tool call and feed a tool-result message back (one per call id —
    // required by the tool-calling protocol before the next assistant turn).
    for (const tc of turn.toolCalls) {
      const result = await runner.run(tc.name, tc.args);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 8000),
      });
      if (tc.name === 'task_complete' && result.done) {
        return { ok: true, summary: result.summary || '(done)', iterations: i + 1, viaExplicit: true };
      }
    }

    const elided = compactTranscript(messages, { budgetChars: lim.transcriptBudgetChars });
    if (elided && onOut) onOut(`[agent] context budget reached — elided ${elided} older tool result(s)\n`);
  }

  return {
    ok: false,
    reason: `iteration limit (${lim.maxIterations}) reached without task_complete`,
    iterations: lim.maxIterations,
  };
}
