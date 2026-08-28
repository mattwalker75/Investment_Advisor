"use strict";
// The scanner's INTRADAY mode, end-to-end against stubbed providers and a scripted
// model: hourly candles are requested (never daily), the recommender is told it's an
// intraday scan, the options/fundamentals passes are skipped, and the persisted rec is
// tagged inputs.timeframe="1h" with a 2-day expiry (not rec_expiry_days).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { useTempDb, stubModule, samplePrefs } = require("./helpers");

useTempDb();

// Hourly synthetic candles: epoch-second times, gentle uptrend (enough bars to analyze).
function hourlyCandles(n = 90, base = 100) {
  const t0 = Math.floor(Date.parse("2026-08-01T14:00:00Z") / 1000);
  const out = [];
  for (let i = 0; i < n; i++) {
    const px = base + i * 0.05 + Math.sin(i / 5) * 1.5;
    out.push({ time: t0 + i * 3600, open: px - 0.2, high: px + 0.5, low: px - 0.6, close: px, volume: 5e5 });
  }
  return out;
}

const calls = { history: [], optionsChain: 0, fundamentals: 0 };
stubModule("providers/yahoo.js", {
  history: async (sym, days, interval) => { calls.history.push({ sym, days, interval }); return hourlyCandles(); },
  quote: async () => ({ price: 104, name: "Test Co" }),
  nextEarnings: async () => null,
  optionsChain: async () => { calls.optionsChain++; return null; },
});
stubModule("providers/fundamentals.js", { fundamentals: async () => { calls.fundamentals++; return null; } });
stubModule("providers/coingecko.js", { topCoins: async () => [], resolve: async () => [] });
stubModule("providers/news.js", { headlines: async () => [], matching: () => [] });
stubModule("providers/sentiment.js", { snapshot: async () => ({}) });
stubModule("providers/whales.js", { snapshot: async () => ({ congress_by_ticker: [], recent_13f_filers: [] }) });
stubModule("engine/regime.js", { marketRegime: async () => ({ regime: "neutral", note: "stub" }) });

const db = require("../src/db");
const settings = require("../src/settings");
settings.getSync = () => ({
  ai: { base_url: "http://127.0.0.1:18439/v1", api_key: "", model: "stub", temperature: 0, max_tokens: 4000,
        task_models: { scan: "", light: "" }, scan_batching: "single", failover: { enabled: false } },
  preferences: {
    ...samplePrefs(),
    options: { ...samplePrefs().options, enabled: true },   // enabled — intraday must STILL skip the passes
    asset_classes: { stocks: true, crypto: false },
    stocks: { universe: "custom", custom_symbols: ["TT"], exclude_symbols: [] },
    crypto: { universe: "top", top_n: 0, custom_symbols: [], exclude_symbols: [] },
  },
  indicators: { rsi: { enabled: true, period: 14, buy_below: 35, sell_above: 70 }, sma: { enabled: true, fast: 20, slow: 50 }, atr: { enabled: true, period: 14 } },
  schedule: { rec_expiry_days: 10 },
  notifications: {},
});

let srv, lastSys = "";
before(async () => {
  await db.init();
  await new Promise((resolve) => {
    srv = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const body = JSON.parse(b);
        lastSys = (body.messages.find((m) => m.role === "system") || {}).content || "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            market_outlook: "quiet tape",
            recommendations: [{
              symbol: "TT", asset_type: "stock", name: "Test Co", side: "buy",
              current_price: 104, entry_low: 102, entry_high: 105, stop_loss: 99,
              targets: [{ price: 115, sell_pct: 100 }],
              horizon_min_days: 1, horizon_max_days: 3, confidence: 0.7,
              rationale: "hourly momentum with volume",
            }],
          }) } }],
          usage: { total_tokens: 42 },
        }));
      });
    });
    srv.listen(18439, resolve);
  });
});
after(async () => { await new Promise((r) => srv.close(r)); await db.close(); });

test("intraday scan: hourly bars, intraday prompt, skipped passes, tagged 2-day rec", async () => {
  const scanner = require("../src/engine/scanner");
  const r = await scanner.runScan("intraday", { timeframe: "1h" });
  assert.strictEqual(r.recs_count, 1);

  // Every history request was hourly (20 calendar days for stocks) — never the 365d daily pull.
  assert.ok(calls.history.length > 0);
  for (const h of calls.history) assert.strictEqual(h.interval, "1h", `daily fetch leaked: ${JSON.stringify(h)}`);
  assert.ok(calls.history.some((h) => h.sym === "TT" && h.days === 20));
  assert.ok(!calls.history.some((h) => h.sym === "SPY"), "no SPY benchmark on hourly bars");

  // Options + fundamentals passes are daily-native — skipped even though options are enabled.
  assert.strictEqual(calls.optionsChain, 0);
  assert.strictEqual(calls.fundamentals, 0);

  // The model was told, and the persisted rec carries the tag + the short expiry.
  assert.ok(/INTRADAY MODE/.test(lastSys), "recommender prompt gains the intraday block");
  const rec = await db.get("SELECT * FROM recommendations WHERE symbol='TT' ORDER BY id DESC LIMIT 1");
  const inputs = JSON.parse(rec.inputs);
  assert.strictEqual(inputs.timeframe, "1h");
  assert.strictEqual(inputs.market.scan_mode, "intraday");
  const lifeDays = (rec.expires_at - rec.created_at) / 86400000;
  assert.ok(Math.abs(lifeDays - 2) < 0.01, `expiry should be 2 days, got ${lifeDays}`);
});
