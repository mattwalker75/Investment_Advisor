"use strict";
// The money-safety gate: validateRec + normalizeTargets. Every number the model emits
// must be clamped or rejected — these tests pin that contract.
const { test } = require("node:test");
const assert = require("node:assert");
const { validateRec, normalizeTargets } = require("../src/engine/recommender");
const { samplePrefs } = require("./helpers");

const prefs = samplePrefs();
const cmap = { NVDA: { symbol: "NVDA", asset_type: "stock", name: "NVIDIA", price: 100 } };
const base = {
  symbol: "NVDA", side: "buy", entry_low: 98, entry_high: 102, stop_loss: 92,
  targets: [{ price: 115, sell_pct: 50 }, { price: 130, sell_pct: 50 }],
  confidence: 0.7, rationale: "test",
};

test("a sane rec passes and keeps its numbers", () => {
  const r = validateRec(base, cmap, prefs);
  assert.ok(r);
  assert.strictEqual(r.entry_low, 98);
  assert.strictEqual(r.stop_loss, 92);
  assert.ok(r.risk_reward >= prefs.risk.min_risk_reward);
});

test("hallucinated symbol → dropped", () => {
  assert.strictEqual(validateRec({ ...base, symbol: "ZZZZ" }, cmap, prefs), null);
});

test("entry zone beyond ±25% of the real price → dropped", () => {
  assert.strictEqual(validateRec({ ...base, entry_low: 60, entry_high: 65 }, cmap, prefs), null);
  assert.strictEqual(validateRec({ ...base, entry_low: 130, entry_high: 140, targets: [{ price: 170, sell_pct: 100 }] }, cmap, prefs), null);
});

test("stop on the wrong side gets FIXED below a long entry", () => {
  const r = validateRec({ ...base, stop_loss: 105 }, cmap, prefs);
  assert.ok(r && r.stop_loss < r.entry_low, "stop " + (r && r.stop_loss));
});

test("swapped entry bounds get un-swapped", () => {
  const r = validateRec({ ...base, entry_low: 102, entry_high: 98 }, cmap, prefs);
  assert.ok(r && r.entry_low === 98 && r.entry_high === 102);
});

test("no valid target (all on the wrong side) → dropped", () => {
  assert.strictEqual(validateRec({ ...base, targets: [{ price: 90, sell_pct: 100 }] }, cmap, prefs), null);
});

test("ladder renormalizes to exactly 100", () => {
  const r = validateRec({ ...base, targets: [{ price: 110, sell_pct: 30 }, { price: 120, sell_pct: 30 }, { price: 130, sell_pct: 30 }] }, cmap, prefs);
  assert.strictEqual(r.targets.reduce((s, t) => s + t.sell_pct, 0), 100);
});

test("confidence below the user's floor → dropped", () => {
  assert.strictEqual(validateRec({ ...base, confidence: 0.4 }, cmap, prefs), null);
});

test("reward:risk below the user's minimum → dropped, no matter the confidence", () => {
  const weak = { ...base, confidence: 0.95, stop_loss: 80, targets: [{ price: 104, sell_pct: 100 }] };
  assert.strictEqual(validateRec(weak, cmap, prefs), null);
});

test("sell idea while shorts are disabled → dropped", () => {
  const noShorts = samplePrefs({ risk: { allow_shorts: false } });
  const sellRec = { ...base, side: "sell", entry_low: 98, entry_high: 102, stop_loss: 108, targets: [{ price: 85, sell_pct: 100 }] };
  assert.strictEqual(validateRec(sellRec, cmap, noShorts), null);
  assert.ok(validateRec(sellRec, cmap, prefs), "same rec passes when shorts allowed");
});

test("options play with a disallowed strategy is stripped, rec survives", () => {
  const r = validateRec({ ...base, options_play: { strategy: "covered_call", expiry: "2099-01-01", strikes: [105] } }, cmap, prefs);
  assert.ok(r);
  assert.strictEqual(r.options_play, null);
});

test("normalizeTargets: filters wrong side, sorts, caps at 3, sums to 100", () => {
  const t = normalizeTargets(
    [{ price: 90, sell_pct: 50 }, { price: 130, sell_pct: 10 }, { price: 110, sell_pct: 10 }, { price: 120, sell_pct: 10 }, { price: 140, sell_pct: 10 }],
    "buy", 98, 102);
  assert.strictEqual(t.length, 3);
  assert.deepStrictEqual(t.map((x) => x.price), [110, 120, 130]);
  assert.strictEqual(t.reduce((s, x) => s + x.sell_pct, 0), 100);
});

test("normalizeTargets: sell side keeps rungs BELOW entry, descending", () => {
  const t = normalizeTargets([{ price: 80, sell_pct: 60 }, { price: 60, sell_pct: 40 }, { price: 120, sell_pct: 50 }], "sell", 98, 102);
  assert.deepStrictEqual(t.map((x) => x.price), [80, 60]);
  assert.strictEqual(t.reduce((s, x) => s + x.sell_pct, 0), 100);
});
