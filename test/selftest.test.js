"use strict";
// The AI self-test, tested against a scripted stub model that answers each pipeline's
// contract correctly — proving the harness passes a good model and fails a broken one.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { samplePrefs } = require("./helpers");

const settings = require("../src/settings");
let behave = "good";   // "good" | "no-json"

const INDICATORS = { rsi: { enabled: true, period: 14, buy_below: 35, sell_above: 70 }, sma: { enabled: true, fast: 50, slow: 200 }, atr: { enabled: true, period: 14 } };
settings.getSync = () => ({
  ai: { base_url: "http://127.0.0.1:18431/v1", api_key: "", model: "stub", temperature: 0, max_tokens: 500,
        task_models: { scan: "", light: "" }, scan_batching: "single", failover: { enabled: false } },
  preferences: samplePrefs(),
  indicators: INDICATORS,
});

const reply = (content, toolCalls) => JSON.stringify({ choices: [{ message: { content, tool_calls: toolCalls || null } }], usage: { total_tokens: 10 } });
let srv;
before(() => new Promise((resolve) => {
  srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b);
      const sys = (body.messages.find((m) => m.role === "system") || {}).content || "";
      const hasToolResult = body.messages.some((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "application/json" });
      if (behave === "no-json" && /ONLY with JSON/i.test(sys)) return res.end(reply("I cannot produce JSON, sorry!"));
      if (/exactly: OK/i.test(body.messages.at(-1).content || "")) return res.end(reply("OK"));
      if (/"status":"ready"/.test(sys)) return res.end(reply('{"status":"ready","n":42}'));
      if (body.tools && !hasToolResult) return res.end(reply("", [{ id: "c1", type: "function", function: { name: "get_test_quote", arguments: '{"symbol":"TESTCO"}' } }]));
      if (body.tools && hasToolResult) return res.end(reply("TESTCO is trading at 123.45 right now."));
      if (/trading analyst/i.test(sys)) return res.end(reply('{"market_outlook":"calm","recommendations":[]}'));
      if (/options strategist/i.test(sys)) return res.end(reply('{"market_outlook":"calm","plays":[]}'));
      if (/backtesting engine/i.test(sys)) return res.end(reply(JSON.stringify({
        spec: { name: "compiled", timeframe: "1d", direction: "long", universe: "stocks",
          entry: { logic: "all", conditions: [{ left: "rsi", op: "<", right: 30 }, { left: "sma_fast", op: ">", right: "sma_slow" }] },
          exit: { stop: { type: "atr", multiple: 2 }, targets: [{ rr: 2, sell_pct: 50 }], trail: { atr_multiple: 3 }, max_hold_bars: 30 } },
        notes: "",
      })));
      return res.end(reply("unmatched prompt"));
    });
  });
  srv.listen(18431, resolve);
}));
after(() => new Promise((resolve) => srv.close(resolve)));

test("self-test passes end-to-end against a well-behaved model", async () => {
  const { runSelfTest } = require("../src/engine/selftest");
  const r = await runSelfTest();
  assert.strictEqual(r.summary.failed, 0, JSON.stringify(r.results.filter((x) => !x.ok)));
  const names = r.results.map((x) => x.name);
  for (const expect of ["endpoint round-trip", "strict JSON output", "tool calling", "scan recommendation contract", "options play contract", "strategy compile"])
    assert.ok(names.includes(expect), "missing check: " + expect);
});

test("self-test reports the failing pipeline when the model breaks the JSON contract", async () => {
  behave = "no-json";
  const { runSelfTest } = require("../src/engine/selftest");
  const r = await runSelfTest();
  behave = "good";
  assert.ok(r.summary.failed >= 1, "at least the JSON check must fail");
  const jsonCheck = r.results.find((x) => x.name === "strict JSON output");
  assert.strictEqual(jsonCheck.ok, false);
  assert.ok(jsonCheck.error, "failure carries the error text");
});
