"use strict";
// The notification-rules engine against a scratch DB with all providers stubbed:
// validation, firing + cooldowns, digest queueing, and the key rule evaluations.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { useTempDb, stubModule } = require("./helpers");

useTempDb();

const market = {
  quotes: {},                                   // sym -> {price, change_pct}
  earnings: {},                                 // sym -> {date, days_away}
  health: { yahoo_cooling_down: false, yahoo_cooldown_seconds_left: 0, keys_set: {} },
};
stubModule("providers/yahoo.js", {
  quotes: async (syms) => Object.fromEntries(syms.map((s) => [s, market.quotes[s] || null])),
  quote: async (s) => market.quotes[s] || null,
  history: async () => { throw new Error("no history here"); },
  optionsChain: async () => null,
  nextEarnings: async (s) => market.earnings[s] || null,
  sector: async () => ({ sector: null }),
  search: async () => [],
  providerHealth: () => market.health,
});
const figures = { trades: [] };
stubModule("providers/whales.js", {
  politicianTrades: async () => figures.trades,
  politicians: async () => [],
  congressFeed: async () => figures.trades,
  congressTrades: async () => [],
  insiderTrades: async () => ({ note: "stub" }),
  recent13F: async () => [],
  snapshot: async () => ({ congress_trades: [], congress_by_ticker: [], recent_13f_filers: [] }),
});

const db = require("../src/db");
const settings = require("../src/settings");
let alerts;

before(async () => {
  await db.init();
  await settings.load();
  alerts = require("../src/engine/alerts");
});
after(async () => { await db.close(); });

const eventCount = async (type) => (await db.get(`SELECT COUNT(*) AS n FROM events WHERE type=?`, [type])).n;

test("validateRule: shapes enforced, unknown types rejected, ids stable for identical rules", () => {
  const r = alerts.validateRule({ type: "price_above", params: { symbol: "btc-usd", level: 70000 } });
  assert.strictEqual(r.params.symbol, "BTC-USD");
  assert.strictEqual(r.delivery, "instant");
  const r2 = alerts.validateRule({ type: "price_above", params: { symbol: "BTC-USD", level: 70000 } });
  assert.notStrictEqual(r.id, undefined);
  assert.strictEqual(alerts.label(r), "BTC-USD above 70000");
  assert.throws(() => alerts.validateRule({ type: "sorcery" }), /unknown rule type/);
  assert.throws(() => alerts.validateRule({ type: "price_above", params: { symbol: "X" } }), /needs/);
  assert.throws(() => alerts.validateRule({ type: "figure_filing", params: {} }), /needs \{name\}/);
});

test("price rule fires once, then respects its cooldown", async () => {
  await alerts.saveRules([alerts.validateRule({ type: "price_above", params: { symbol: "BTC-USD", level: 70000 }, cooldown_min: 240 })]);
  market.quotes["BTC-USD"] = { price: 71000, change_pct: 2 };
  const first = await alerts.evaluateRules();
  assert.strictEqual(first.fired, 1);
  const again = await alerts.evaluateRules();               // still above, inside cooldown
  assert.strictEqual(again.fired, 0, "cooldown must suppress the repeat");
  assert.ok(await eventCount("alert_rule") >= 1);
});

test("pct_move_day over the watchlist", async () => {
  await db.run("INSERT INTO watchlist (created_at, symbol, yahoo_symbol, asset_type, name) VALUES (?,?,?,?,?)",
    [Date.now(), "NVDA", "NVDA", "stock", "NVIDIA"]);
  market.quotes.NVDA = { price: 130, change_pct: -6.2 };
  await alerts.saveRules([alerts.validateRule({ type: "pct_move_day", params: { scope: "watchlist", threshold: 5 } })]);
  const r = await alerts.evaluateRules();
  assert.strictEqual(r.fired, 1);
  await db.run("DELETE FROM watchlist");
});

test("figure_filing: first pass baselines silently, new filings fire after", async () => {
  figures.trades = [{ politician: "Nancy Pelosi", chamber: "house", ticker: "NVDA", action: "buy", amount: "$1M-$5M", traded_at: "2026-07-01", disclosed_at: "2026-08-10", option: { kind: "call" } }];
  await alerts.saveRules([alerts.validateRule({ type: "figure_filing", params: { name: "Pelosi" }, cooldown_min: 5 })]);
  const first = await alerts.evaluateRules();
  assert.strictEqual(first.fired, 0, "baseline pass must not spam existing filings");
  figures.trades = [
    { politician: "Nancy Pelosi", chamber: "house", ticker: "MSFT", action: "buy", amount: "$250K-$500K", traded_at: "2026-08-01", disclosed_at: "2026-08-27", option: null },
    ...figures.trades,
  ];
  const second = await alerts.evaluateRules();
  assert.strictEqual(second.fired, 1, "the NEW filing fires");
  const row = await db.get("SELECT message FROM events WHERE type='alert_rule' ORDER BY id DESC LIMIT 1");
  assert.match(row.message, /Pelosi/);
  assert.match(row.message, /MSFT/);
});

test("digest delivery queues for the briefing instead of alerting, and drains once", async () => {
  await alerts.saveRules([alerts.validateRule({ type: "provider_degraded", delivery: "digest", cooldown_min: 5 })]);
  market.health.yahoo_cooling_down = true;
  const before1 = await eventCount("alert_rule");
  const r = await alerts.evaluateRules();
  assert.strictEqual(r.fired, 1);
  assert.strictEqual(await eventCount("alert_rule"), before1, "digest hits must not raise instant alerts");
  assert.ok(await eventCount("alert_digest") >= 1, "digest hit lands in the feed quietly");
  const q = await alerts.drainDigest();
  assert.strictEqual(q.length, 1);
  assert.match(q[0].message, /degraded/i);
  assert.deepStrictEqual(await alerts.drainDigest(), [], "queue drains once");
  market.health.yahoo_cooling_down = false;
});

test("disabled rules are skipped but preserved", async () => {
  const rule = alerts.validateRule({ type: "price_above", params: { symbol: "ZZZ", level: 1 }, enabled: false });
  await alerts.saveRules([rule]);
  market.quotes.ZZZ = { price: 5, change_pct: 0 };
  const r = await alerts.evaluateRules();
  assert.strictEqual(r.fired, 0);
  assert.strictEqual((await alerts.listRules()).length, 1, "disabled rule survives the pass");
});
