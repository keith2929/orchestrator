// clients/openai.js — any OpenAI-compatible chat endpoint as a model client
// (kind: "chat"). One client covers OpenAI, DeepSeek, Groq, OpenRouter, local
// Ollama, etc. — they all speak POST {baseURL}/chat/completions.
//
// Uses Node's native fetch (Node 18+), so NO new dependency. The API key is read
// from process.env[cfg.apiKeyEnv] at call time and is never persisted or logged.
//
//   complete(prompt, opts)          -> one-shot text (planning roles)
//   chat(messages, {model, tools})  -> normalized { content, toolCalls[] } (agent loop)

// Model ids are interpolated into the request body, not a URL/shell, so this is
// a sanity check rather than a security boundary. The forward slash is required
// by aggregator providers whose ids are "vendor/model" (OpenRouter:
// "deepseek/deepseek-chat"); ref parsing splits on the FIRST colon, so
// "openrouter:vendor/model" still resolves correctly.
const SAFE_MODEL = /^[A-Za-z0-9._\/:-]+$/;

export function makeOpenAIClient(id, cfg = {}) {
  const baseURL = String(cfg.baseURL || '').replace(/\/+$/, '');
  const apiKeyEnv = cfg.apiKeyEnv || '';
  const models = Array.isArray(cfg.models) ? cfg.models : [];

  function apiKey() {
    const key = apiKeyEnv ? process.env[apiKeyEnv] : '';
    if (!key) {
      throw new Error(
        `Missing API key for client "${id}": set the ${apiKeyEnv || '<apiKeyEnv>'} environment variable.`
      );
    }
    return key;
  }

  // Last rate-limit headers this client saw, per model. build-models.mjs reads
  // it straight after a probe call to record real limits in config.json.
  let lastLimits = null;

  // Low-level POST to /chat/completions. `omitTemperature` is used to retry once
  // for reasoner models (deepseek-reasoner, o-series) that reject `temperature`.
  async function post(body, signal, omitTemperature = false) {
    if (!baseURL) throw new Error(`Client "${id}" has no baseURL configured.`);
    const payload = { ...body };
    if (omitTemperature) delete payload.temperature;

    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify(payload),
      signal,
    });

    // Stash the per-key rate limits the provider reports. Groq sends the real
    // numbers on every response (x-ratelimit-limit-tokens: 8000 — the free-tier
    // per-request ceiling that aborts agent tasks with a 413), which is far
    // better evidence than a catalogue's advertised context window. Recorded on
    // success AND failure, since a 429 is exactly when they matter.
    // Not every provider sends them: Gemini and OpenRouter send none.
    const num = (h) => {
      const v = resp.headers.get(h);
      const n = v == null ? NaN : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const seen = {
      tokensPerWindow: num('x-ratelimit-limit-tokens'),
      requestsPerWindow: num('x-ratelimit-limit-requests'),
      tokenWindow: resp.headers.get('x-ratelimit-reset-tokens') || undefined,
      requestWindow: resp.headers.get('x-ratelimit-reset-requests') || undefined,
    };
    if (Object.values(seen).some((v) => v !== undefined)) {
      lastLimits = { model: payload.model, ...seen };
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // Params are best-effort: some models 400 on `temperature`. Retry once
      // without it before giving up, so a per-role temperature never hard-fails.
      if (resp.status === 400 && !omitTemperature && 'temperature' in payload && /temperature/i.test(text)) {
        return post(body, signal, true);
      }
      throw new Error(`${id} chat/completions ${resp.status}: ${text.slice(0, 800)}`);
    }
    return resp.json();
  }

  function assertModel(model) {
    if (!model || !SAFE_MODEL.test(model)) {
      throw new Error(`Invalid model id for client "${id}": ${JSON.stringify(model)}`);
    }
    return model;
  }

  async function complete(prompt, opts = {}) {
    const body = {
      model: assertModel(opts.model),
      messages: [{ role: 'user', content: String(prompt) }],
    };
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    const data = await post(body, opts.signal);
    return String(data?.choices?.[0]?.message?.content ?? '');
  }

  // Agent-loop turn. `tools` are already in OpenAI function-tool schema
  // ({ type:"function", function:{ name, description, parameters } }). Returns a
  // provider-neutral shape so agent/executor.js never sees dialect differences.
  async function chat(messages, opts = {}) {
    const body = { model: assertModel(opts.model), messages };
    if (Array.isArray(opts.tools) && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;

    const data = await post(body, opts.signal);
    const msg = data?.choices?.[0]?.message ?? {};
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc) => {
          let args = {};
          try {
            args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            args = { __raw: tc.function?.arguments }; // surface unparseable args instead of throwing
          }
          return { id: tc.id, name: tc.function?.name, args };
        })
      : [];
    return { content: String(msg.content ?? ''), toolCalls, raw: msg };
  }

  return {
    id,
    kind: 'chat',
    baseURL,
    apiKeyEnv,
    models,
    costTier: cfg.costTier,
    complete,
    chat,
    seenLimits: () => lastLimits,
  };
}
