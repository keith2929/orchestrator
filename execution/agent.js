// execution/agent.js — execution backend for chat clients (DeepSeek, OpenAI,
// …). Wraps the generic agent framework so a plain chat model can act as a
// worker: it drives read/write/list/run_bash tools until the task is done.
//
// This is the kind:"chat" branch of execution/index.js. The kind:"cli" branch
// (Claude) uses execution/native.js instead — the CLI is already an agent.
import { resolveModel } from '../clients/index.js';
import { runAgent } from '../agent/executor.js';
import { CONTEXT_DIR } from '../shared.js';

export async function executeAgent({ ref, prompt, cwd, onOut, onErr, limits, signal }) {
  const { client, model, limits: modelLimits } = resolveModel(ref);
  if (typeof client.chat !== 'function') {
    if (onErr) onErr(`[agent] client "${client.id}" has no chat() — it cannot run a worker task.\n`);
    return { ok: false, detail: `client "${client.id}" is not agent-capable (no tool-calling chat)` };
  }

  const systemPrompt = [
    `You are an autonomous software-engineering agent working inside the project directory: ${cwd}`,
    `You cannot see the filesystem except through the provided tools. All paths you WRITE are RELATIVE`,
    `to the project directory and you cannot write anything outside it.`,
    ``,
    `Reference files the task points you at live in ${CONTEXT_DIR} and are readable even though they`,
    `sit outside the project — read_file and list_dir accept them by full path, by "context/<name>",`,
    `or by bare filename. They are read-only.`,
    ``,
    `Use read_file / list_dir to inspect, write_file to create or overwrite files, and run_bash to run`,
    `install/build/test commands (the environment is non-interactive, CI=true). Work in small, verified`,
    `steps. Do NOT ask the user questions — just do the work.`,
    ``,
    `Only the tools provided to you exist. Never invent a tool name.`,
    ``,
    `When the task is fully implemented (and verified where applicable), call task_complete with a short`,
    `summary. If you cannot make progress, still call task_complete and explain what is blocking you.`,
  ].join('\n');

  // Size the transcript budget to THIS model rather than one global default.
  // effectiveRequestTokens is what the key may send in one request (Groq's free
  // tier allows 6k–12k while advertising 131k), and the budget must leave room
  // for the ~900-token tool schemas, the task prompt, and the reply — so spend
  // about half of it on accumulated transcript. ~3.7 chars/token.
  const budgetTokens = modelLimits?.effectiveRequestTokens;
  const derived = budgetTokens ? { transcriptBudgetChars: Math.floor(budgetTokens * 0.5 * 3.7) } : {};
  const effLimits = { ...derived, ...(limits || {}) }; // an explicit caller limit still wins

  if (onOut) {
    onOut(
      `[agent] ${client.id}:${model} starting…` +
        (budgetTokens ? ` (request budget ${budgetTokens} tok → transcript ${effLimits.transcriptBudgetChars} chars)` : '') +
        '\n'
    );
  }
  const result = await runAgent({
    client,
    model,
    systemPrompt,
    userPrompt: prompt,
    cwd,
    onOut,
    onErr,
    limits: effLimits,
    readRoots: [CONTEXT_DIR],
    signal,
  });

  if (result.ok) {
    if (onOut) {
      onOut(
        `\n[agent] ✅ completed in ${result.iterations} iteration(s)` +
          `${result.viaExplicit ? ' (task_complete)' : ' (model stopped)'}.\n`
      );
    }
    return { ok: true, summary: result.summary };
  }
  if (onErr) onErr(`\n[agent] ❌ ${result.reason}\n`);
  return { ok: false, detail: result.reason };
}
