"use strict";
// The Strategy Lab: spec validation, the condition evaluator, the direction-aware
// simulator (long/short/option), and Black-Scholes model pricing. Network-free.
const { test } = require("node:test");
const assert = require("node:assert");
const { stubModule, syntheticCandles } = require("./helpers");

const candles = syntheticCandles(400);
// hourly fixture: epoch-second times (as real intraday candles use)
const hourly = candles.slice(0, 350).map((c, i) => ({ ...c, time: 1720000000 + i * 3600 }));
stubModule("providers/yahoo.js", { history: async (_s, _d, interval) => (interval === "1h" ? hourly : candles) });
stubModule("providers/coingecko.js", { topCoins: async () => [{ yahoo: "BTC-USD" }, { yahoo: "ETH-USD" }] });
const lab = require("../src/engine/strategylab");

const BASE = {
  name: "dip buyer", timeframe: "1d", direction: "long", universe: ["T1", "T2"],
  entry: { logic: "all", conditions: [{ left: "rsi", op: "<", right: 45 }] },
  exit: { stop: { type: "atr", multiple: 2 }, targets: [{ rr: 1, sell_pct: 50 }, { rr: 2, sell_pct: 50 }],
    trail: { atr_multiple: 3, breakeven_after_target1: true }, max_hold_bars: 40 },
};

test("validateSpec: whitelists operands/ops, renormalizes ladders, rejects nonsense", () => {
  const s = lab.validateSpec({ ...BASE, exit: { ...BASE.exit, targets: [{ rr: 1, sell_pct: 30 }, { rr: 2, sell_pct: 60 }] } });
  assert.strictEqual(s.exit.targets.reduce((a, t) => a + t.sell_pct, 0), 100);
  assert.throws(() => lab.validateSpec({ ...BASE, entry: { conditions: [{ left: "magic", op: "<", right: 1 }] } }), /unknown operand/);
  assert.throws(() => lab.validateSpec({ ...BASE, entry: { conditions: [{ left: "rsi", op: "~=", right: 1 }] } }), /unknown op/);
  assert.throws(() => lab.validateSpec({ ...BASE, entry: { conditions: [] } }), /entry.conditions is empty/);
  assert.throws(() => lab.validateSpec({ ...BASE, timeframe: "1h", instrument: { type: "option", strategy: "long_call" } }), /daily-timeframe only/);
});

test("condition evaluator: comparisons, crosses, rising/falling", () => {
  const ops = { a: [1, 2, 3, 2, 1], b: [2, 2, 2, 2, 2] };
  const at = (c, i) => lab.condTrue(c, ops, i);
  assert.strictEqual(at({ left: "a", op: "<", right: "b" }, 0), true);
  assert.strictEqual(at({ left: "a", op: ">", right: 2.5 }, 2), true);
  assert.strictEqual(at({ left: "a", op: "crosses_above", right: "b" }, 2), true);    // 2→3 across 2
  assert.strictEqual(at({ left: "a", op: "crosses_above", right: "b" }, 1), false);   // touch, no cross
  assert.strictEqual(at({ left: "a", op: "crosses_below", right: "b" }, 4), true);    // 2→1 across 2
  assert.strictEqual(at({ left: "a", op: "rising", right: 1 }, 2), true);
  assert.strictEqual(at({ left: "a", op: "falling", right: 2 }, 4), true);            // vs 2 bars back
});

test("bsPrice: intrinsic at expiry, put-call parity, sane ATM value", () => {
  assert.strictEqual(lab.bsPrice("call", 110, 100, 0, 0.4), 10);
  assert.strictEqual(lab.bsPrice("put", 90, 100, 0, 0.4), 10);
  const c = lab.bsPrice("call", 100, 100, 0.25, 0.4);
  const p = lab.bsPrice("put", 100, 100, 0.25, 0.4);
  assert.ok(c > 6 && c < 10, "ATM call " + c);
  assert.ok(Math.abs((c - p) - (100 - 100 * Math.exp(-0.04 * 0.25))) < 1e-9, "put-call parity");
});

test("runStrategy: long strategy simulates with full metrics + walk-forward", async () => {
  const r = await lab.runStrategy(BASE);
  assert.ok(r.total_trades > 0);
  assert.ok(isFinite(r.overall.expectancy_pct));
  assert.ok(r.walk_forward, "expected a walk-forward split");
  assert.strictEqual(r.walk_forward.in_sample.trades + r.walk_forward.out_of_sample.trades, r.total_trades);
});

test("runStrategy: short direction inverts the machinery", async () => {
  const r = await lab.runStrategy({ ...BASE, direction: "short",
    entry: { logic: "all", conditions: [{ left: "rsi", op: ">", right: 55 }] } });
  assert.ok(r.total_trades > 0, "short strategy should fire on an oscillating series");
  // shorting a net-uptrend series must underperform the long version of the mirror
  const long = await lab.runStrategy(BASE);
  assert.ok(r.overall.expectancy_pct < long.overall.expectancy_pct, "short < long on an uptrend");
});

test("runStrategy: option instrument is model-priced and labeled", async () => {
  const r = await lab.runStrategy({ ...BASE, instrument: { type: "option", strategy: "long_call", dte: 30, moneyness_pct: 0 } });
  assert.ok(r.total_trades > 0);
  assert.ok(r.model_priced_note, "model-priced label required");
  const t = r.by_symbol[0].last_trades[0];
  assert.ok(t.model_priced && t.premium_entry > 0, "trades carry premium metadata");
});

test("runStrategy: 1h strategies get a walk-forward split too (epoch-second dates)", async () => {
  const r = await lab.runStrategy({ ...BASE, timeframe: "1h", days: 60,
    exit: { ...BASE.exit, max_hold_bars: 20 } });
  assert.ok(r.total_trades > 0, "1h run should trade");
  if (r.total_trades >= 10) {
    assert.ok(r.walk_forward, "walk-forward must not silently vanish on intraday timestamps");
    assert.strictEqual(r.walk_forward.in_sample.trades + r.walk_forward.out_of_sample.trades, r.total_trades);
  }
});

test("runStrategy: crypto universe resolves through the coin provider", async () => {
  const r = await lab.runStrategy({ ...BASE, universe: "crypto" });
  assert.strictEqual(r.symbols_tested, 2);
});
