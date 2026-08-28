"use strict";
// AI live self-test: proves every AI pipeline against the CONFIGURED model in
// miniature — run it after any model/endpoint change instead of discovering mid-scan
// that a local model can't hold the JSON contract. Six checks, sequential, each with
// its own timeout and failure text. Uses FIXED synthetic market data (no market-data
// network calls; the only network is the model endpoint itself). Nothing is persisted.
const llm = require("../ai/llm");
const settings = require("../settings");

// A fixed NVDA-ish candidate + chain — realistic shapes, deterministic content.
const FIXTURE_CANDIDATE = {
  symbol: "TESTCO", asset_type: "stock", name: "Test Corp", price: 100,
  indicators: {
    price: 100, rsi: 31.2, macd: { line: -0.8, signal: -0.5, hist: -0.3 },
    sma: { sma50: 98.5, sma200: 92.1, price_vs_fast_pct: 1.5, price_vs_slow_pct: 8.6 },
    atr: 2.4, atr_pct: 2.4, adx: 24.1, atr_percentile: 38,
    change_1d_pct: -1.2, change_5d_pct: -4.8, change_20d_pct: 3.1,
    pct_off_period_high: -9.5, pct_off_period_low: 22.4, volume_vs_20d_avg: 1.7,
    signals: ["RSI 31.2 <= 35 (user buy zone)", "SMA50 above SMA200 (uptrend)"],
  },
  headlines: ["Test Corp beats estimates", "Analysts raise Test Corp targets"],
  options_chain: {
    symbol: "TESTCO", spot: 100, expiry: "2099-12-17", dte: 45,
    calls: [{ strike: 100, bid: 4.8, ask: 5.2, iv: 38, open_interest: 500, last: 5, volume: 20 },
            { strike: 105, bid: 2.7, ask: 2.9, iv: 39, open_interest: 300, last: 2.8, volume: 12 }],
    puts: [{ strike: 95, bid: 2.2, ask: 2.4, iv: 40, open_interest: 250, last: 2.3, volume: 9 },
           { strike: 100, bid: 4.1, ask: 4.3, iv: 39, open_interest: 400, last: 4.2, volume: 14 }],
  },
};

async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    return { name, ok: true, ms: Date.now() - t0, note: note || "" };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 300) };
  }
}

async function runSelfTest() {
  const s = settings.getSync();
  const prefs = s.preferences;
  const opts = { timeout_ms: 90000, max_tokens: 1500, task: "selftest" };   // task tag = usage-telemetry label (no model override configured for it)
  const results = [];

  // 1. Endpoint round-trip — can we reach the model at all?
  results.push(await timed("endpoint round-trip", async () => {
    const r = await llm.chat([{ role: "user", content: "Reply with exactly: OK" }], { ...opts, max_tokens: 200 });
    if (!r.content) throw new Error("empty reply");
    return `model ${r.model}${r.via_failover ? " (VIA FAILOVER — the primary failed)" : ""}`;
  }));
  if (!results[0].ok) return { results, summary: summarize(results), aborted: "endpoint unreachable — remaining checks skipped" };

  // 2. Strict-JSON contract — the backbone of every engine.
  results.push(await timed("strict JSON output", async () => {
    const { data } = await llm.chatJSON([
      { role: "system", content: 'Respond ONLY with JSON exactly: {"status":"ready","n":42}' },
      { role: "user", content: "Emit the object." },
    ], opts);
    if (data.status !== "ready" || data.n !== 42) throw new Error("wrong JSON payload: " + JSON.stringify(data).slice(0, 120));
    return "response_format + extraction both good";
  }));

  // 3. Tool-calling loop — the advisor chat's foundation.
  results.push(await timed("tool calling", async () => {
    const tool = { type: "function", function: { name: "get_test_quote", description: "Returns the live test quote. ALWAYS call this when asked for the quote.", parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } } };
    const convo = [
      { role: "system", content: "You have one tool. When asked for a quote you MUST call it — never answer from memory." },
      { role: "user", content: "What is the TESTCO quote right now?" },
    ];
    const r1 = await llm.chat(convo, { ...opts, tools: [tool] });
    if (!r1.tool_calls || !r1.tool_calls.length) throw new Error("model answered without calling the tool");
    convo.push({ role: "assistant", content: r1.content || "", tool_calls: r1.tool_calls });
    convo.push({ role: "tool", tool_call_id: r1.tool_calls[0].id, content: JSON.stringify({ symbol: "TESTCO", price: 123.45 }) });
    const r2 = await llm.chat(convo, { ...opts, tools: [tool] });
    if (!/123\.45|123,45/.test(r2.content || "")) throw new Error("final answer ignored the tool result: " + String(r2.content).slice(0, 120));
    return "call → result → grounded answer";
  }));

  // 4. Scan contract in miniature — one candidate through the REAL prompt + gauntlet.
  results.push(await timed("scan recommendation contract", async () => {
    const recommender = require("./recommender");
    const context = {
      market: { as_of: new Date().toISOString(), regime: { regime: "neutral", note: "test" }, active_recommendations: [], sentiment: {}, top_headlines: [] },
      candidates: [FIXTURE_CANDIDATE],
    };
    const { recs, model } = await recommender.recommend(context);
    // An empty answer is contractually VALID ("never force ideas") — the check is that
    // the call parsed and anything returned survived validation.
    return recs.length ? `model ${model} returned ${recs.length} validated idea(s) — e.g. ${recs[0].side} ${recs[0].symbol} R:R ${recs[0].risk_reward}` : `model ${model} returned a valid empty set (acceptable)`;
  }));

  // 5. Options pass contract (only when options are enabled).
  if (prefs.options.enabled) {
    results.push(await timed("options play contract", async () => {
      const optionsEngine = require("./options");
      const { recs } = await optionsEngine.recommendOptions({
        market: { as_of: new Date().toISOString(), sentiment: {}, top_headlines: [] },
        candidates: [FIXTURE_CANDIDATE],
      }, () => {}, { viewHint: "bullish" });
      return recs.length ? `validated ${recs[0].options_play.strategy} @ ~${recs[0].current_price} premium` : "valid empty set (no play cleared the gauntlet — acceptable)";
    }));
  }

  // 6. Strategy compile contract.
  results.push(await timed("strategy compile", async () => {
    const lab = require("./strategylab");
    const { spec, notes } = await lab.compileStrategy("Buy when RSI dips under 30 while the 50-day average is above the 200-day. Stop 2x ATR. Sell half at 2R and let the rest run with a 3x ATR trail.");
    const conds = spec.entry.conditions.map((c) => `${c.left} ${c.op} ${c.right}`).join(", ");
    if (!spec.entry.conditions.some((c) => c.left === "rsi")) throw new Error("compiled spec lost the RSI condition: " + conds);
    return `compiled to valid spec (${conds})${notes ? " — notes: " + notes.slice(0, 80) : ""}`;
  }));

  return { results, summary: summarize(results) };
}

function summarize(results) {
  const ok = results.filter((r) => r.ok).length;
  return { passed: ok, failed: results.length - ok, total: results.length,
    verdict: ok === results.length ? "all AI pipelines work with the configured model"
      : "some pipelines failed — the failing features will error the same way in real use" };
}

module.exports = { runSelfTest, FIXTURE_CANDIDATE };
