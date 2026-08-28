"use strict";
// Research report generator: context gathering composes every engine's read from
// stubbed providers, the note round-trips through the library (save/list/get/delete),
// and the library caps at 15. The model is a scripted stub HTTP server.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { useTempDb, stubModule, syntheticCandles, sampleChain, samplePrefs } = require("./helpers");

useTempDb();

stubModule("providers/yahoo.js", {
  quote: async () => ({ price: 120, change_pct: 1.2, name: "Apple Inc", market_cap: 3e12 }),
  history: async (sym) => syntheticCandles(300, { base: sym === "SPY" ? 500 : 100 }),
  nextEarnings: async () => ({ date: "2099-10-30", days_away: 40 }),
  optionsChain: async () => sampleChain(),
});
stubModule("providers/news.js", {
  headlines: async () => [{ title: "Apple beats on earnings" }, { title: "Unrelated macro story" }],
  matching: (all) => [all[0]],
});
stubModule("providers/fundamentals.js", {
  fundamentals: async () => ({ symbol: "AAPL", pe_ttm: 30.5, net_margin_pct: 25.1, roe_pct: 45 }),
});
stubModule("providers/whales.js", {
  insiderTrades: async () => ({ symbol: "AAPL", summary: "2 buy / 1 sell filings in the recent window", trades: [{ insider: "T. Cook", action: "sell" }] }),
  congressFeed: async () => [{ ticker: "AAPL", politician: "Nancy Pelosi", action: "buy", amount: "$1K-$15K", traded_at: "2026-08-01" }],
});
stubModule("engine/regime.js", { marketRegime: async () => ({ regime: "risk_on", note: "stub regime" }) });
stubModule("engine/predict.js", {
  projectionCone: async () => ({
    at_horizon: { p10: 105, p50: 122, p90: 141 }, band_width_pct: 30,
    params: { sigma_annual_pct: 28 }, note: "stub cone",
  }),
});
stubModule("resolve.js", {
  resolveAsset: async (raw) => ({ yahoo: String(raw).toUpperCase(), display: String(raw).toUpperCase(), name: "Apple Inc", asset_type: "stock" }),
});

const db = require("../src/db");
const settings = require("../src/settings");
settings.getSync = () => ({
  ai: { base_url: "http://127.0.0.1:18437/v1", api_key: "", model: "stub", temperature: 0, max_tokens: 4000,
        task_models: { scan: "", light: "" }, scan_batching: "single", failover: { enabled: false } },
  preferences: samplePrefs(),
  indicators: { rsi: { enabled: true, period: 14, buy_below: 35, sell_above: 70 }, sma: { enabled: true, fast: 50, slow: 200 }, atr: { enabled: true, period: 14 } },
});

const NOTE = "## Summary & thesis\n**AAPL** looks constructive.\n\n## Projection\np10 105 – p90 141 (30% band).\n\nResearch, not financial advice.";
let srv;
before(async () => {
  await db.init();
  await new Promise((resolve) => {
    srv = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: NOTE } }], usage: { total_tokens: 50 }, model: "stub" }));
      });
    });
    srv.listen(18437, resolve);
  });
});
after(async () => { await new Promise((r) => srv.close(r)); await db.close(); });

test("gatherContext composes every engine's read (and the system's own record)", async () => {
  // Seed a graded rec + an open trade so the self-record sections light up.
  await db.run(
    "INSERT INTO recommendations (created_at,asset_type,symbol,side,current_price,entry_low,entry_high,stop_loss,targets,confidence,status,outcome,expires_at) VALUES (?,'stock','AAPL','buy',100,98,102,92,'[]',0.7,'closed',?,?)",
    [Date.now(), JSON.stringify({ pnl_pct: 8.5 }), Date.now()]);
  await db.run(
    "INSERT INTO trades (created_at,entry_at,asset_type,symbol,side,qty,entry_price,status) VALUES (?,?,'stock','AAPL','buy',10,110,'open')",
    [Date.now(), Date.now()]);

  const research = require("../src/engine/research");
  const ctx = await research.gatherContext({ yahoo: "AAPL", display: "AAPL", name: "Apple Inc", asset_type: "stock" });
  assert.strictEqual(ctx.quote.price, 120);
  assert.ok(ctx.technicals && ctx.technicals.price != null, "technicals computed from candles");
  assert.strictEqual(ctx.fundamentals.pe_ttm, 30.5);
  assert.ok(/2 buy/.test(ctx.insiders.summary));
  assert.strictEqual(ctx.congress_activity[0].who, "Nancy Pelosi");
  assert.strictEqual(ctx.options_posture.dte, sampleChain().dte);
  assert.strictEqual(ctx.projection_3m.band_width_pct, 30);
  assert.strictEqual(ctx.market_regime.regime, "risk_on");
  assert.deepStrictEqual(ctx.headlines, ["Apple beats on earnings"]);
  assert.strictEqual(ctx.own_track_record_here[0].pnl_pct, 8.5);
  assert.strictEqual(ctx.user_holds_position.entry_price, 110);
});

test("generateReport writes the note and it round-trips through the library", async () => {
  const research = require("../src/engine/research");
  const r = await research.generateReport("aapl");
  assert.strictEqual(r.symbol, "AAPL");
  assert.ok(r.text.includes("Summary & thesis"));
  assert.ok(r.id, "report gets an id");

  const list = await research.listReports();
  assert.strictEqual(list[0].id, r.id, "newest first");
  const got = await research.getReport(r.id);
  assert.strictEqual(got.text, NOTE);

  const del = await research.deleteReport(r.id);
  assert.strictEqual(del.removed, 1);
  assert.strictEqual(await research.getReport(r.id), null);
});

test("the library keeps only the newest 15 notes", async () => {
  const research = require("../src/engine/research");
  for (let i = 0; i < 17; i++) await research.generateReport("AAPL");
  assert.strictEqual((await research.listReports()).length, 15);
});
