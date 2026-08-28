"use strict";
// The backtest simulator, network-free: the Yahoo provider is stubbed with a
// deterministic synthetic series before the engine loads it.
const { test } = require("node:test");
const assert = require("node:assert");
const { stubModule, syntheticCandles } = require("./helpers");

const candles = syntheticCandles(400);
stubModule("providers/yahoo.js", { history: async () => candles });
const bt = require("../src/engine/backtest");

const RUN = (opts) => bt.run(["T1", "T2"], { min_signals: 1, slippage_pct: 0.1, ...opts });

test("bracket model: trades simulate with sane invariants", async () => {
  const r = await RUN({ exit_model: "bracket" });
  assert.ok(r.total_trades > 0, "no trades simulated");
  assert.strictEqual(r.config.exit_model, "bracket");
  for (const s of r.by_symbol.filter((x) => x.trades > 0)) {
    for (const t of s.last_trades) {
      assert.ok(isFinite(t.entry) && isFinite(t.exit) && isFinite(t.pnl_pct));
      assert.ok(["stop", "target", "time"].includes(t.reason), t.reason);
    }
  }
  assert.ok(r.overall.max_drawdown_pct != null);
});

test("ladder_trail model: exits come from the ladder machinery", async () => {
  const r = await RUN({ exit_model: "ladder_trail" });
  assert.ok(r.total_trades > 0);
  const reasons = Object.keys(r.by_symbol[0].exit_reasons);
  assert.ok(reasons.every((x) => ["stop", "trail_stop", "ladder_complete", "time"].includes(x)), reasons.join(","));
});

test("slippage costs money: higher slippage strictly lowers expectancy on identical data", async () => {
  const cheap = await RUN({ exit_model: "bracket", slippage_pct: 0 });
  const costly = await RUN({ exit_model: "bracket", slippage_pct: 1 });
  assert.strictEqual(cheap.total_trades > 0, true);
  assert.ok(costly.overall.expectancy_pct < cheap.overall.expectancy_pct,
    `expected ${costly.overall.expectancy_pct} < ${cheap.overall.expectancy_pct}`);
});

test("fees charge per round trip", async () => {
  const free = await RUN({ exit_model: "bracket", slippage_pct: 0, fee_pct: 0 });
  const feed = await RUN({ exit_model: "bracket", slippage_pct: 0, fee_pct: 0.5 });
  const diff = free.overall.expectancy_pct - feed.overall.expectancy_pct;
  assert.ok(Math.abs(diff - 1.0) < 0.05, "round-trip fee should cost ~1.0%, cost " + diff.toFixed(3));
});

test("walk-forward split appears with enough trades and partitions them all", async () => {
  const r = await RUN({ exit_model: "bracket", oos_split_pct: 30 });
  if (r.total_trades >= 10) {
    assert.ok(r.walk_forward, "expected a walk-forward split");
    assert.strictEqual(r.walk_forward.in_sample.trades + r.walk_forward.out_of_sample.trades, r.total_trades);
  }
});

test("regression (FIX-8): trail-stop trades settle filled rungs at actual fills, not rung levels", async () => {
  // With slippage on, a trail_stop trade whose rungs filled must NOT be worth more than
  // the same ladder valued at raw rung levels — actual fills give up slippage.
  const r = await RUN({ exit_model: "ladder_trail", slippage_pct: 2 });
  const zero = await RUN({ exit_model: "ladder_trail", slippage_pct: 0 });
  assert.ok(r.overall.expectancy_pct < zero.overall.expectancy_pct, "slippage must reduce ladder expectancy");
});

test("back-compat: numeric second argument still means min_signals", async () => {
  const r = await bt.run(["T1"], 1);
  assert.strictEqual(r.config.min_signals, 1);
  assert.ok(r.total_trades > 0);
});
