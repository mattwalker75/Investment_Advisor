"use strict";
// The shadow-tracker state machine against a throwaway DB, with the Yahoo provider
// stubbed: entry-zone touch → tracking → stop-out grading, and OPTION recs pricing off
// the chain premium + settling at intrinsic value at expiry.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { useTempDb, stubModule, sampleChain } = require("./helpers");

useTempDb();

// Mutable stub state the tests steer.
const market = { quotes: {}, chain: sampleChain(), quote: {} };
stubModule("providers/yahoo.js", {
  quotes: async (syms) => Object.fromEntries(syms.map((s) => [s, market.quotes[s] || null])),
  quote: async (s) => { if (!market.quote[s]) throw new Error("no quote"); return market.quote[s]; },
  history: async () => { throw new Error("no history in this test"); },
  optionsChain: async () => market.chain,
  sector: async () => ({ sector: null }),
  nextEarnings: async () => null,
  search: async () => [],
  providerHealth: () => ({}),
});

const db = require("../src/db");
const settings = require("../src/settings");
const { J } = require("../src/util");
let tracker;

before(async () => {
  await db.init();
  await settings.load();
  // Pretend a tracking pass just ran so backfillGaps skips (no candle replay).
  await db.run(db.upsertSql("cache", ["key", "value", "fetched_at"], "key"), ["tracker:last_pass", String(Date.now()), Date.now()]);
  tracker = require("../src/engine/tracker");
});
after(async () => { await db.close(); });

test("stock rec: entry-zone touch → tracking, then stop-out grades via the ladder rule", async () => {
  await db.run(
    "INSERT INTO recommendations (created_at,asset_type,symbol,side,current_price,entry_low,entry_high,stop_loss,targets,confidence,status,expires_at) VALUES (?,'stock','AAA','buy',100,98,102,92,?,0.7,'open',?)",
    [Date.now(), JSON.stringify([{ price: 115, sell_pct: 100 }]), Date.now() + 86400000]);
  const { id } = await db.get("SELECT id FROM recommendations WHERE symbol='AAA'");

  market.quotes.AAA = { price: 101 };                       // inside the entry zone
  await tracker.trackRecommendations();
  let r = await db.get("SELECT * FROM recommendations WHERE id=?", [id]);
  assert.strictEqual(r.status, "tracking");
  const entry = J(r.outcome, {}).entry_price;
  assert.ok(entry >= 98 && entry <= 102, "entry " + entry);

  market.quotes.AAA = { price: 91 };                        // through the stop
  await tracker.trackRecommendations();
  r = await db.get("SELECT * FROM recommendations WHERE id=?", [id]);
  assert.strictEqual(r.status, "stopped");
  const o = J(r.outcome, {});
  assert.ok(Math.abs(o.pnl_pct - ((92 - entry) / entry) * 100) < 0.01, "graded at the stop: " + o.pnl_pct);
});

test("option rec: prices off the live net premium, same state machine", async () => {
  // long_call 125 on the sample chain: net mid 3.5. Entry zone 3.4–3.6, stop 1.8.
  await db.run(
    "INSERT INTO recommendations (created_at,asset_type,symbol,side,current_price,entry_low,entry_high,stop_loss,targets,confidence,status,expires_at,options_play) VALUES (?,'option','NVDA','buy',3.5,3.4,3.6,1.8,?,0.7,'open',?,?)",
    [Date.now(), JSON.stringify([{ price: 7, sell_pct: 100 }]), Date.now() + 86400000,
     JSON.stringify({ strategy: "long_call", strikes: [125], expiry: "2099-10-16", underlying_price: 120 })]);
  const { id } = await db.get("SELECT id FROM recommendations WHERE asset_type='option'");

  await tracker.trackRecommendations();                     // premium 3.5 → in the entry zone
  let r = await db.get("SELECT * FROM recommendations WHERE id=?", [id]);
  assert.strictEqual(r.status, "tracking", "premium entry should have triggered");

  // Premium rallies through the target: chain mid → 7.5 (bid 7.4 / ask 7.6).
  market.chain = { ...sampleChain(), calls: sampleChain().calls.map((c) => c.strike === 125 ? { ...c, bid: 7.4, ask: 7.6 } : c) };
  await tracker.trackRecommendations();
  r = await db.get("SELECT * FROM recommendations WHERE id=?", [id]);
  assert.strictEqual(r.status, "target_hit");
  const o = J(r.outcome, {});
  assert.ok(o.pnl_pct > 90, "full ladder at 2x premium ≈ +100%, got " + o.pnl_pct);
  market.chain = sampleChain();
});

test("option TRADE with premium_levels: alerts price off the chain, never the underlying quote", async () => {
  await db.run(
    "INSERT INTO trades (rec_id,created_at,asset_type,symbol,side,qty,entry_price,entry_at,stop_loss,targets,option_details,status) VALUES (NULL,?,'option','NVDA','buy',1,3.5,?,1.8,?,?,'open')",
    [Date.now(), Date.now(), JSON.stringify([{ price: 7, sell_pct: 100 }]),
     JSON.stringify({ type: "call", strategy: "long_call", strike: 125, strikes: [125], expiry: "2099-10-16", premium_levels: true })]);
  const { id } = await db.get("SELECT id FROM trades WHERE asset_type='option' ORDER BY id DESC LIMIT 1");
  market.quotes.NVDA = { price: 130 };            // underlying 130 vs premium target 7.0 — must NOT fire
  await tracker.trackTrades();
  let t = await db.get("SELECT exits FROM trades WHERE id=?", [id]);
  assert.strictEqual((J(t.exits, []) || []).filter((e) => e.alert && /^(target|stop)/.test(e.alert)).length, 0,
    "premium-level plan must never be checked against the underlying quote");
  // net premium rallies to 7.5 → the premium target alert fires
  market.chain = { ...sampleChain(), calls: sampleChain().calls.map((c) => (c.strike === 125 ? { ...c, bid: 7.4, ask: 7.6 } : c)) };
  await tracker.trackTrades();
  t = await db.get("SELECT exits FROM trades WHERE id=?", [id]);
  assert.ok((J(t.exits, []) || []).some((e) => e.alert === "target0"), "premium target alert fires at chain mid 7.5");
  market.chain = sampleChain();
  await db.run("DELETE FROM trades");
});

test("option rec at expiry: tracking settles at intrinsic (expired_settled), open expires", async () => {
  const past = "2000-01-01";
  const mk = (sym, status, outcome) => db.run(
    "INSERT INTO recommendations (created_at,asset_type,symbol,side,current_price,entry_low,entry_high,stop_loss,targets,confidence,status,expires_at,options_play,outcome) VALUES (?,'option',?,'buy',3.5,3.4,3.6,1.8,?,0.7,?,?,?,?)",
    [Date.now(), sym, JSON.stringify([{ price: 7, sell_pct: 100 }]), status, Date.now() + 86400000,
     JSON.stringify({ strategy: "long_call", strikes: [125], expiry: past, underlying_price: 120 }),
     outcome ? JSON.stringify(outcome) : null]);
  await mk("SET1", "tracking", { entry_price: 3.5, targets_hit: [] });
  await mk("SET2", "open", null);
  market.quote.SET1 = { price: 132 };                       // intrinsic at expiry = 7

  await tracker.trackRecommendations();
  const settled = await db.get("SELECT * FROM recommendations WHERE symbol='SET1'");
  assert.strictEqual(settled.status, "closed");
  const o = J(settled.outcome, {});
  assert.strictEqual(o.result, "expired_settled");
  assert.strictEqual(o.exit_price, 7);
  assert.ok(o.pnl_pct === 100, "3.5 → 7.0 intrinsic = +100%, got " + o.pnl_pct);

  const dead = await db.get("SELECT * FROM recommendations WHERE symbol='SET2'");
  assert.strictEqual(dead.status, "expired", "never-entered option idea expires untriggered");
});
