// The AI "brain", whichever one the user picked: Claude (Anthropic), ChatGPT (OpenAI), Grok (xAI), or a free local
// model through Ollama. Both apps work without any of them; with one, they can hold real conversations and use tools.
//
//   const llm = createLLM({ getConfig: () => ({ provider, keys: { anthropic, openai, xai }, model, ollamaUrl }) });
//   llm.ready() · llm.complete({ system, prompt }) · llm.messages(body) · llm.chatWithToolsOpenAI({...}) · llm.test() · llm.models()
//
// No environment variables are read here: the app passes a getter (fromEnv() builds one from process.env, the way
// Dayspring's .env is laid out). Conversations are kept in one neutral shape (Anthropic-style blocks: text, tool_use,
// tool_result) so switching providers never breaks a conversation; OpenAI-compatible providers are translated.
// Uses fetch only (no SDK), so it has no dependencies. Tests pass their own fetch.

export const PROVIDERS = {
  anthropic: { label: "Claude (Anthropic)", keyName: "anthropic", keyVar: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-5", webSearch: true, base: "https://api.anthropic.com/v1", keyUrl: "https://platform.claude.com/settings/keys" },
  openai: { label: "ChatGPT (OpenAI)", keyName: "openai", keyVar: "OPENAI_API_KEY", defaultModel: "gpt-5-mini", base: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  xai: { label: "Grok (xAI)", keyName: "xai", keyVar: "XAI_API_KEY", defaultModel: "grok-4", base: "https://api.x.ai/v1", keyUrl: "https://console.x.ai/team/default/api-keys" },
  ollama: { label: "Local model (Ollama, free)", keyName: null, keyVar: null, defaultModel: "llama3.1:8b", base: null, keyUrl: "https://ollama.com/download" },
};
export const ANTHROPIC_MODELS = ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"];

// A config getter from environment variables (Dayspring's .env names). extra: { modelVar } for an app-specific model name.
export function fromEnv(env = process.env, { modelVar = null } = {}) {
  return () => ({
    provider: String(env.AI_PROVIDER ?? "").toLowerCase() || (env.ANTHROPIC_API_KEY ? "anthropic" : "none"),
    keys: { anthropic: env.ANTHROPIC_API_KEY ?? "", openai: env.OPENAI_API_KEY ?? "", xai: env.XAI_API_KEY ?? "" },
    model: env.AI_MODEL || (modelVar ? env[modelVar] : "") || "",
    ollamaUrl: env.OLLAMA_URL || "",
    bases: { anthropic: env.ANTHROPIC_BASE_URL || "", openai: env.OPENAI_BASE_URL || "", xai: env.XAI_BASE_URL || "" },
  });
}

const err = (message, status) => Object.assign(new Error(message), { status });

export function createLLM({ getConfig, fetch: f = globalThis.fetch } = {}) {
  if (typeof getConfig !== "function") throw new Error("createLLM needs getConfig()");
  const cfg = () => { const c = getConfig() ?? {}; return { keys: {}, bases: {}, ...c, keys: { ...(c.keys ?? {}) }, bases: { ...(c.bases ?? {}) } }; };
  const provider = () => { const p = String(cfg().provider ?? "").toLowerCase(); return PROVIDERS[p] ? p : "none"; };
  const keyOf = (p) => (PROVIDERS[p]?.keyName ? String(cfg().keys[PROVIDERS[p].keyName] ?? "") : "");
  const ready = () => { const p = provider(); if (p === "none") return false; if (p === "ollama") return true; return Boolean(keyOf(p)); };
  const modelName = () => { const p = provider(); if (p === "none") return "none"; return cfg().model || PROVIDERS[p].defaultModel; };
  const label = () => (provider() === "none" ? "no AI (built-in skills only)" : `${PROVIDERS[provider()].label} · ${modelName()}`);
  const canSearchWeb = () => provider() === "anthropic";
  const baseUrl = (p) => {
    const c = cfg();
    if (p === "ollama") return `${String(c.ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "")}/v1`;
    return String(c.bases[p] || PROVIDERS[p].base).replace(/\/$/, "");
  };

  // Anthropic Messages API, raw. body: { model?, max_tokens, system?, messages, tools?, ... }. Returns the response JSON.
  async function messages(body, { timeoutMs = 60_000, beta = null } = {}) {
    if (provider() !== "anthropic" || !ready()) throw err("Claude isn't set up", 401);
    const headers = { "content-type": "application/json", "x-api-key": keyOf("anthropic"), "anthropic-version": "2023-06-01" };
    if (beta) headers["anthropic-beta"] = beta;
    const r = await f(`${baseUrl("anthropic")}/messages`, { method: "POST", headers, body: JSON.stringify({ model: modelName(), ...body }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw err(j.error?.message ?? `Claude answered ${r.status}`, r.status);
    return j;
  }

  async function openaiChat(p, body, timeoutMs = 60_000) {
    const headers = { "content-type": "application/json" };
    if (p !== "ollama") headers.authorization = `Bearer ${keyOf(p)}`;
    const payload = { model: modelName(), ...body };
    // newer OpenAI models take max_completion_tokens instead of max_tokens
    if (p === "openai" && payload.max_tokens) { payload.max_completion_tokens = payload.max_tokens; delete payload.max_tokens; }
    const r = await f(`${baseUrl(p)}/chat/completions`, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw err(j.error?.message ?? `${PROVIDERS[p].label} answered ${r.status}`, r.status);
    return j;
  }

  // One-shot text (announcements, summaries, short compositions)
  async function complete({ system = "", prompt, maxTokens = 400, timeoutMs = 45_000 }) {
    const p = provider();
    if (!ready()) throw err("no AI is set up", 401);
    if (p === "anthropic") {
      const r = await messages({ max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: "user", content: prompt }] }, { timeoutMs });
      return (r.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    }
    const r = await openaiChat(p, { messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }], max_tokens: maxTokens }, timeoutMs);
    return String(r.choices?.[0]?.message?.content ?? "").trim();
  }

  // A conversation with tools for OpenAI-compatible providers (the Anthropic loop lives in each app's assistant).
  // history: neutral messages. tools: [{ name, description, input_schema }]. runTool(name, input) → any.
  async function chatWithToolsOpenAI({ system, history = [], userText, tools = [], runTool, maxRounds = 8 }) {
    const p = provider();
    const neutral = [...history, { role: "user", content: userText }];
    const fnTools = tools.filter((t) => t.input_schema).map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
    let reply = "", usage = null;
    for (let round = 0; round < maxRounds; round++) {
      const r = await openaiChat(p, { messages: [{ role: "system", content: system }, ...toOpenAI(neutral)], tools: fnTools.length ? fnTools : undefined, max_tokens: 1200 });
      usage = r.usage ? { input_tokens: r.usage.prompt_tokens, output_tokens: r.usage.completion_tokens } : usage;
      const msg = r.choices?.[0]?.message ?? {};
      const calls = msg.tool_calls ?? [];
      const blocks = [];
      if (msg.content) blocks.push({ type: "text", text: String(msg.content) });
      for (const c of calls) { let input = {}; try { input = JSON.parse(c.function?.arguments || "{}"); } catch { /* bad JSON from the model */ } blocks.push({ type: "tool_use", id: c.id, name: c.function?.name, input }); }
      neutral.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
      if (!calls.length) { reply = String(msg.content ?? "").trim(); break; }
      const results = [];
      for (const b of blocks.filter((x) => x.type === "tool_use")) {
        try { let out = JSON.stringify(await runTool(b.name, b.input)); if (out.length > 60_000) out = out.slice(0, 60_000) + "…(cut off)"; results.push({ type: "tool_result", tool_use_id: b.id, content: out }); }
        catch (e) { results.push({ type: "tool_result", tool_use_id: b.id, content: `Error: ${e.message}`, is_error: true }); }
      }
      neutral.push({ role: "user", content: results });
    }
    return { reply: reply || "Done.", history: neutral, usage };
  }

  // The setup "Test" button: try a provider (optionally with a key and model that aren't saved yet)
  async function test(p = provider(), key, model) {
    const probe = createLLM({ fetch: f, getConfig: () => { const c = cfg(); const keys = { ...c.keys }; if (key && PROVIDERS[p]?.keyName) keys[PROVIDERS[p].keyName] = key; return { ...c, provider: p, model: model || c.model, keys }; } });
    try {
      const t0 = Date.now();
      const text = await probe.complete({ prompt: "Reply with exactly: ready", maxTokens: 20, timeoutMs: 30_000 });
      return { ok: true, text, ms: Date.now() - t0, model: probe.modelName() };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Models the user can pick from
  async function models(p = provider()) {
    try {
      if (p === "anthropic") return [...ANTHROPIC_MODELS];
      if (p === "ollama") { const r = await f(`${String(cfg().ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(5000) }); const j = await r.json(); return (j.models ?? []).map((m) => m.name); }
      const r = await f(`${baseUrl(p)}/models`, { headers: { authorization: `Bearer ${keyOf(p)}` }, signal: AbortSignal.timeout(8000) });
      const j = await r.json(); return (j.data ?? []).map((m) => m.id).sort();
    } catch { return [PROVIDERS[p]?.defaultModel].filter(Boolean); }
  }

  return { PROVIDERS, provider, ready, modelName, label, canSearchWeb, complete, messages, chatWithToolsOpenAI, test, models, baseUrl };
}

// neutral (Anthropic-style) → OpenAI chat messages
export function toOpenAI(msgs) {
  const out = [];
  for (const m of msgs) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const r of blocks.filter((b) => b.type === "tool_result")) out.push({ role: "tool", tool_call_id: r.tool_use_id, content: typeof r.content === "string" ? r.content : JSON.stringify(r.content) });
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}
