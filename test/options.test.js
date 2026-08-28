"use strict";
// The options engine: premium pricing, economics, settlement, and the validation
// gauntlet for first-class option recommendations.
const { test } = require("node:test");
const assert = require("node:assert");
const opt = require("../src/engine/options");
const { sampleChain, samplePrefs } = require("./helpers");

const chain = sampleChain();
const prefs = samplePrefs();
const cmap = { NVDA: { symbol: "NVDA", asset_type: "stock", name: "NVIDIA", price: 120, options_chain: chain } };

test("netPremium: singles and spreads price off bid/ask mids", () => {
  assert.strictEqual(opt.netPremium("long_call", chain, [125]).net, 3.5);
  assert.strictEqual(opt.netPremium("long_put", chain, [115]).net, 2.5);
  assert.strictEqual(opt.netPremium("call_spread", chain, [120, 130]).net, 4);    // 6.0 − 2.0 debit
  assert.strictEqual(opt.netPremium("cash_secured_put", chain, [115]).net, 2.5);
  assert.strictEqual(opt.netPremium("long_call", chain, [999]), null, "strike not in chain");
  assert.strictEqual(opt.netPremium("call_spread", chain, [120]), null, "spread needs two strikes");
});

test("economics: breakeven and per-contract max loss/gain", () => {
  const lc = opt.economics("long_call", [125], 3.5, 120);
  assert.strictEqual(lc.breakeven, 128.5);
  assert.strictEqual(lc.max_loss_per_contract, 350);
  const cs = opt.economics("call_spread", [120, 130], 4, 120);
  assert.strictEqual(cs.breakeven, 124);
  assert.strictEqual(cs.max_gain_per_contract, 600);
  assert.strictEqual(cs.max_loss_per_contract, 400);
  const csp = opt.economics("cash_secured_put", [115], 2.5, 120);
  assert.strictEqual(csp.breakeven, 112.5);
  assert.strictEqual(csp.max_gain_per_contract, 250);
});

test("settlementPremium: intrinsic value at expiry, spreads clamp at width", () => {
  assert.strictEqual(opt.settlementPremium("long_call", [125], 132), 7);
  assert.strictEqual(opt.settlementPremium("long_call", [125], 118), 0);
  assert.strictEqual(opt.settlementPremium("long_put", [115], 100), 15);
  assert.strictEqual(opt.settlementPremium("call_spread", [120, 130], 140), 10);
  assert.strictEqual(opt.settlementPremium("put_spread", [120, 110], 100), 10);
  assert.strictEqual(opt.settlementPremium("cash_secured_put", [115], 100), 15);
});

test("atmIv + isExpired", () => {
  assert.strictEqual(opt.atmIv(chain, 120), 41);   // (40 + 42) / 2
  assert.strictEqual(opt.isExpired({ expiry: "2000-01-01" }), true);
  assert.strictEqual(opt.isExpired({ expiry: "2099-01-01" }), false);
});

test("validateOptionRec: a sane debit play passes with real economics", () => {
  const r = opt.validateOptionRec({
    symbol: "NVDA", strategy: "long_call", strikes: [125], confidence: 0.7,
    entry_low: 3.4, entry_high: 3.6, stop_loss: 1.8,
    targets: [{ price: 7, sell_pct: 60 }, { price: 10.5, sell_pct: 40 }], rationale: "t",
  }, cmap, prefs);
  assert.ok(r);
  assert.strictEqual(r.asset_type, "option");
  assert.strictEqual(r.side, "buy");
  assert.strictEqual(r.current_price, 3.5);                 // the tracked price IS the premium
  assert.strictEqual(r.options_play.breakeven, 128.5);
  assert.ok(r.risk_reward >= prefs.risk.min_risk_reward);
  assert.ok(r.horizon_max_days <= chain.dte, "horizon capped by DTE");
});

test("validateOptionRec: credit play flips to side=sell with decay targets, rr not gated", () => {
  const r = opt.validateOptionRec({ symbol: "NVDA", strategy: "cash_secured_put", strikes: [115], confidence: 0.6, rationale: "income" }, cmap, prefs);
  assert.ok(r);
  assert.strictEqual(r.side, "sell");
  assert.ok(r.stop_loss > r.entry_high, "credit stop sits ABOVE the entry premium");
  assert.ok(r.targets.every((t) => t.price < r.entry_low), "credit targets decay BELOW entry");
});

test("validateOptionRec: insane model numbers get replaced with sane defaults", () => {
  const r = opt.validateOptionRec({
    symbol: "NVDA", strategy: "long_call", strikes: [125], confidence: 0.7,
    entry_low: 30, entry_high: 40, stop_loss: 90,           // nonsense vs a 3.50 mid
    targets: [{ price: 200, sell_pct: 100 }], rationale: "t",
  }, cmap, prefs);
  assert.ok(r);
  assert.ok(r.entry_low > 3 && r.entry_high < 4, "entry re-anchored to the live mid");
  assert.ok(r.stop_loss < r.entry_low, "stop re-anchored below entry");
});

test("optionPremium: intrinsic fallback when a leg left the near-money window (deep-ITM winners keep tracking)", async () => {
  const { stubModule } = require("./helpers");
  const state = { chain: sampleChain() };
  stubModule("providers/yahoo.js", { optionsChain: async () => state.chain });
  // leg present → chain-mid pricing
  const live = await opt.optionPremium({ symbol: "NVDA", options_play: { strategy: "long_call", strikes: [125], expiry: "2099-10-16" } });
  assert.strictEqual(live.premium, 3.5);
  // underlying rallied: 125C no longer in the ±15% window, spot 160 → intrinsic 35
  state.chain = { ...sampleChain(), spot: 160, calls: [{ strike: 155, bid: 9, ask: 9.4, iv: 40, open_interest: 10 }], puts: [] };
  const deep = await opt.optionPremium({ symbol: "NVDA", options_play: { strategy: "long_call", strikes: [125], expiry: "2099-10-16" } });
  assert.strictEqual(deep.premium, 35, "must fall back to intrinsic, not null");
  assert.match(deep.approx || "", /intrinsic/);
  state.chain = sampleChain();
});

test("tradePremium: spreads price NET across all legs, single-leg trades still work", async () => {
  const spread = await opt.tradePremium({ symbol: "NVDA", option_details: { strategy: "call_spread", strikes: [120, 130], type: "call", strike: 120, expiry: "2099-10-16" } });
  assert.strictEqual(spread.premium, 4, "net debit 6.0 − 2.0, never the long leg alone");
  const single = await opt.tradePremium({ symbol: "NVDA", option_details: { type: "call", strike: 125, expiry: "2099-10-16" } });
  assert.strictEqual(single.premium, 3.5);
});

test("validateOptionRec: horizon is hard-capped by DTE even on a 1-DTE chain", () => {
  const shortChain = { ...sampleChain(), dte: 1 };
  const m = { NVDA: { symbol: "NVDA", asset_type: "stock", name: "NVIDIA", price: 120, options_chain: shortChain } };
  const r = opt.validateOptionRec({ symbol: "NVDA", strategy: "long_call", strikes: [125], confidence: 0.7, horizon_max_days: 30, rationale: "t" }, m, prefs);
  assert.ok(r && r.horizon_max_days <= 1, "horizon_max " + (r && r.horizon_max_days));
});

test("validateOptionRec: the gauntlet rejects", () => {
  const cases = [
    [{ symbol: "NVDA", strategy: "covered_call", strikes: [125], confidence: 0.9 }, "disallowed strategy"],
    [{ symbol: "NVDA", strategy: "call_spread", strikes: [130, 120], confidence: 0.9 }, "inverted spread"],
    [{ symbol: "NVDA", strategy: "long_call", strikes: [125], confidence: 0.3 }, "confidence below floor"],
    [{ symbol: "ZZZZ", strategy: "long_call", strikes: [125], confidence: 0.9 }, "unknown symbol"],
    [{ symbol: "NVDA", strategy: "long_call", strikes: [999], confidence: 0.9 }, "strike not in chain"],
  ];
  for (const [play, why] of cases) assert.strictEqual(opt.validateOptionRec(play, cmap, prefs), null, why);
});
