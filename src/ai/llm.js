"use strict";
// LLM client: any OpenAI-compatible /chat/completions endpoint — OpenAI, Ollama (/v1),
// LiteLLM, LM Studio... Configured entirely from Settings (base_url, api_key, model).
// chatJSON() is the workhorse: asks for strict JSON and robustly extracts/parses it
// (local models love to wrap JSON in markdown fences or <think> blocks).
const settings = require("../settings");

// Task-tier model resolution: opts.task ('scan' | 'light') picks the configured
// per-task model when one is set; an explicit opts.model always wins; otherwise the
// default ai.model. Chat passes no task and uses the default.
function modelFor(opts, ai) {
  if (opts.model) return opts.model;
  const t = opts.task && ai.task_models && ai.task_models[opts.task];
  return (t && String(t).trim()) || ai.model;
}

// Endpoints that rejected response_format (older local servers) — remembered per base
// URL so we stop sending it after the first refusal.
const noJsonMode = new Set();

// Optional failover config, or null when disabled/unconfigured.
function failoverCfg() {
  const f = settings.getSync().ai.failover || {};
  return f.enabled && (f.model || f.base_url) ? f : null;
}

// Wraps a transport call with the optional one-shot failover: when the PRIMARY
// endpoint hard-fails (network error, timeout, 5xx…), retry once against the
// configured failover endpoint/model. Skipped when the caller supplied its own
// base_url (e.g. the Settings "Test connection" — that must test what it was given).
async function withFailover(opts, fn) {
  try { return await fn(opts); }
  catch (e) {
    const f = failoverCfg();
    if (!f || opts.base_url || opts.no_failover) throw e;
    const ai = settings.getSync().ai;
    console.warn(`[llm] primary endpoint failed (${String(e.message).slice(0, 140)}) — trying failover ${f.model || ai.model}`);
    const r = await fn({
      ...opts, no_failover: true,
      base_url: f.base_url || ai.base_url,
      api_key: f.api_key ? f.api_key : (opts.api_key !== undefined ? opts.api_key : ai.api_key),
      model: f.model || modelFor(opts, ai),
    });
    r.via_failover = true;
    return r;
  }
}

const chat = (messages, opts = {}) => withFailover(opts, (o) => chatOnce(messages, o));

async function chatOnce(messages, opts = {}) {
  const ai = settings.getSync().ai;
  const base = (opts.base_url || ai.base_url || "").replace(/\/+$/, "");
  if (!base) throw new Error("AI endpoint not configured (Settings → AI)");
  const headers = { "Content-Type": "application/json" };
  const key = opts.api_key !== undefined ? opts.api_key : ai.api_key;
  if (key) headers.Authorization = "Bearer " + key;

  const body = {
    model: modelFor(opts, ai),
    messages,
    temperature: opts.temperature ?? ai.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? ai.max_tokens ?? 4000,
    stream: false,
  };
  if (opts.tools && opts.tools.length) { body.tools = opts.tools; body.tool_choice = "auto"; }
  // Structured-output mode (chatJSON sets opts.json): ask the endpoint to constrain
  // output to a JSON object. Feature-detected — an endpoint that 400s it is remembered
  // and the request retried without (extractJSON remains the safety net either way).
  if (opts.json && !noJsonMode.has(base)) body.response_format = { type: "json_object" };

  const send = () => fetch(base + "/chat/completions", {
    method: "POST", headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeout_ms || 300000),   // local reasoning models are slow — be patient
  });
  let r = await send();
  if (!r.ok && r.status === 400 && body.response_format) {
    const t = await r.text();
    if (/response_format|json_object|format/i.test(t)) {
      noJsonMode.add(base);
      delete body.response_format;
      r = await send();
    } else {
      throw new Error(`LLM 400 (model ${body.model}): ${t.slice(0, 400)}`);
    }
  }
  if (!r.ok) {
    const t = (await r.text()).slice(0, 400);
    throw new Error(`LLM ${r.status} (model ${body.model}): ${t}`);
  }
  const d = await r.json();
  const m = (d.choices && d.choices[0] && d.choices[0].message) || {};
  return { content: m.content || "", tool_calls: m.tool_calls || null, usage: d.usage || null, model: body.model };
}

// Streaming chat: same contract as chat(), but content tokens are delivered through
// onToken(text) as they arrive. Returns the assembled {content, tool_calls} at the end.
// (Reasoning deltas from local models are ignored — the chat UI shows final prose only.)
// Failover applies only when the primary fails BEFORE any token reached the client —
// a stream that dies midway is surfaced as the error it is (no silent double replies).
async function chatStream(messages, opts = {}, onToken = () => {}) {
  let emitted = false;
  const gate = (tok) => { emitted = true; onToken(tok); };
  try { return await chatStreamOnce(messages, opts, gate); }
  catch (e) {
    const f = failoverCfg();
    if (!f || opts.base_url || opts.no_failover || emitted) throw e;
    const ai = settings.getSync().ai;
    console.warn(`[llm] primary endpoint failed on stream (${String(e.message).slice(0, 140)}) — trying failover ${f.model || ai.model}`);
    const r = await chatStreamOnce(messages, {
      ...opts, no_failover: true,
      base_url: f.base_url || ai.base_url,
      api_key: f.api_key ? f.api_key : (opts.api_key !== undefined ? opts.api_key : ai.api_key),
      model: f.model || modelFor(opts, ai),
    }, onToken);
    r.via_failover = true;
    return r;
  }
}

async function chatStreamOnce(messages, opts = {}, onToken = () => {}) {
  const ai = settings.getSync().ai;
  const base = (opts.base_url || ai.base_url || "").replace(/\/+$/, "");
  if (!base) throw new Error("AI endpoint not configured (Settings → AI)");
  const headers = { "Content-Type": "application/json" };
  const key = opts.api_key !== undefined ? opts.api_key : ai.api_key;
  if (key) headers.Authorization = "Bearer " + key;
  const body = {
    model: modelFor(opts, ai), messages,
    temperature: opts.temperature ?? ai.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? ai.max_tokens ?? 4000,
    stream: true,
  };
  if (opts.tools && opts.tools.length) { body.tools = opts.tools; body.tool_choice = "auto"; }
  const r = await fetch(base + "/chat/completions", {
    method: "POST", headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeout_ms || 300000),
  });
  if (!r.ok || !r.body) throw new Error(`LLM ${r.status} (model ${body.model}): ${(await r.text()).slice(0, 300)}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "";
  const toolCalls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json; try { json = JSON.parse(payload); } catch { continue; }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; try { onToken(delta.content); } catch (_) {} }
      if (delta.tool_calls) {
        for (const d of delta.tool_calls) {
          const i = d.index || 0;
          if (!toolCalls[i]) toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
          if (d.id) toolCalls[i].id = d.id;
          if (d.function && d.function.name) toolCalls[i].function.name += d.function.name;
          if (d.function && d.function.arguments) toolCalls[i].function.arguments += d.function.arguments;
        }
      }
    }
  }
  const tc = toolCalls.filter(Boolean);
  return { content, tool_calls: tc.length ? tc : null };
}

// Pull the first complete JSON object out of model output. Handles: raw JSON, ```json
// fences, <think>...</think> preambles, and leading/trailing prose.
function extractJSON(text) {
  let t = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const start = t.indexOf("{");
  if (start === -1) throw new Error("model returned no JSON object");
  // Walk to the matching close brace (string-aware).
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error("model returned truncated JSON");
}

// Chat and parse strict JSON, retrying once with the parse error fed back to the model.
async function chatJSON(messages, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt === 0 ? messages : [
      ...messages,
      { role: "assistant", content: lastRaw || "" },
      { role: "user", content: `Your previous reply was not valid JSON (${lastErr}). Respond again with ONLY the JSON object — no prose, no markdown fences.` },
    ];
    var lastRaw;
    const r = await chat(msgs, { ...opts, json: true });
    lastRaw = r.content;
    try { return { data: extractJSON(r.content), usage: r.usage, model: r.model }; }
    catch (e) { lastErr = e.message; }
  }
  throw new Error("model failed to produce valid JSON: " + lastErr);
}

// Settings-page "Test connection": tiny round-trip that proves endpoint+model+key work.
async function test(cfg) {
  const r = await chat(
    [{ role: "user", content: "Reply with exactly: OK" }],
    { ...cfg, max_tokens: 500, timeout_ms: 60000 }
  );
  return { ok: true, model: r.model, reply: (r.content || "").trim().slice(0, 80) };
}

module.exports = { chat, chatStream, chatJSON, extractJSON, test };
