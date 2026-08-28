"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const ind = require("../src/indicators");
const { syntheticCandles } = require("./helpers");

const CFG = {
  rsi: { enabled: true, period: 14, buy_below: 35, sell_above: 70 },
  macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
  sma: { enabled: true, fast: 5, slow: 20 },
  bollinger: { enabled: true, period: 20, stddev: 2 },
  stochastic: { enabled: true, k: 14, d: 3, buy_below: 20, sell_above: 80 },
  atr: { enabled: true, period: 14 },
  adx: { enabled: true, period: 14, trend_min: 20 },
  obv: { enabled: true },
};

test("sma: exact arithmetic on a known series", () => {
  const out = ind.sma([1, 2, 3, 4, 5], 3);
  assert.deepStrictEqual(out, [null, null, 2, 3, 4]);
});

test("rsi: all-gains series saturates high, all-losses low", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const dn = Array.from({ length: 30 }, (_, i) => 100 - i);
  const rsiUp = ind.rsi(up, 14).at(-1), rsiDn = ind.rsi(dn, 14).at(-1);
  assert.ok(rsiUp > 95, "rsi up " + rsiUp);
  assert.ok(rsiDn < 5, "rsi down " + rsiDn);
});

test("atr: constant true range converges to that range", () => {
  const candles = Array.from({ length: 40 }, (_, i) => ({ high: 105, low: 95, close: 100, open: 100, time: "d" + i, volume: 1 }));
  const atr = ind.atr(candles, 14).at(-1);
  assert.ok(Math.abs(atr - 10) < 0.5, "atr " + atr);
});

test("computeAll: snapshot has the always-on context stats + derived reads", () => {
  const candles = syntheticCandles(200);
  const bench = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
  const { latest } = ind.computeAll(candles, CFG, { benchCloses: bench });
  assert.ok(latest.price > 0);
  assert.ok(typeof latest.change_20d_pct === "number");
  assert.ok(latest.atr_percentile >= 0 && latest.atr_percentile <= 100);
  assert.ok(typeof latest.rs_vs_benchmark_63d_pct === "number");
  assert.ok(Array.isArray(latest.signals));
});

test("relative strength: laggard vs a strong benchmark reads negative + signals it", () => {
  const flat = syntheticCandles(200, { trend: 0, amp: 1 });
  const bench = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.004, i));   // strong riser
  const { latest } = ind.computeAll(flat, CFG, { benchCloses: bench });
  assert.ok(latest.rs_vs_benchmark_63d_pct < -10, "rs " + latest.rs_vs_benchmark_63d_pct);
  assert.ok(latest.signals.some((s) => /laggard/.test(s)));
});

test("computeAllCached: memo hits on identical input, invalidates on cfg or candle change", () => {
  const candles = syntheticCandles(120);
  const a = ind.computeAllCached("t1", candles, CFG);
  const b = ind.computeAllCached("t1", candles, CFG);
  assert.strictEqual(a, b, "identical input should hit the memo");
  const c = ind.computeAllCached("t1", candles, { ...CFG, rsi: { ...CFG.rsi, period: 10 } });
  assert.notStrictEqual(a, c, "changed cfg must recompute");
  const d = ind.computeAllCached("t1", candles.slice(0, 100), { ...CFG, rsi: { ...CFG.rsi, period: 10 } });
  assert.notStrictEqual(c, d, "changed candles must recompute");
});
