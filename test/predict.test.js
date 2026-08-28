"use strict";
// The projection cone: quantile math, honest widening, and the API shape. Network-free.
const { test } = require("node:test");
const assert = require("node:assert");
const { stubModule, syntheticCandles } = require("./helpers");

const daily = syntheticCandles(300);
stubModule("providers/yahoo.js", {
  history: async (_sym, _days, interval) => {
    if (interval === "1h") throw new Error("no intraday in this test");   // forces the daily fallback
    return daily;
  },
});
const predict = require("../src/engine/predict");

test("estimateParams: vol positive, drift shrunk into the clamp", () => {
  const closes = daily.map((c) => c.close);
  const p = predict.estimateParams(closes, 252);
  assert.ok(p.sigma > 0 && p.sigma < 3, "sigma " + p.sigma);
  assert.ok(Math.abs(p.drift) <= 0.3, "drift clamped: " + p.drift);
});

test("quantilePrice: median below-ish drift path, p90 > p50 > p10, widens with sqrt(t)", () => {
  const S = 100, sigma = 0.3, drift = 0.05;
  const q = (t, z) => predict.quantilePrice(S, drift, sigma, t, z);
  assert.ok(q(0.25, 1.2816) > q(0.25, 0) && q(0.25, 0) > q(0.25, -1.2816));
  const widthShort = q(0.1, 1.2816) - q(0.1, -1.2816);
  const widthLong = q(1, 1.2816) - q(1, -1.2816);
  assert.ok(widthLong > widthShort * 2, `long horizon must be much wider: ${widthShort.toFixed(1)} vs ${widthLong.toFixed(1)}`);
});

test("projectionCone: bands are ordered, ascending in time, and WIDEN with the horizon", async () => {
  const cone = await predict.projectionCone("TEST", "3m");
  assert.strictEqual(cone.horizon, "3m");
  for (const b of ["p10", "p25", "p50", "p75", "p90"]) {
    assert.strictEqual(cone.bands[b].length, 24);
    const times = cone.bands[b].map((p) => p.time);
    assert.deepStrictEqual([...times].sort(), times, "times ascending for " + b);
  }
  const last = cone.bands;
  const end = last.p10.length - 1;
  assert.ok(last.p10[end].value < last.p50[end].value && last.p50[end].value < last.p90[end].value, "band order");
  // widening: the p10–p90 spread at the end must exceed the spread at the first step
  const spread = (k) => last.p90[k].value - last.p10[k].value;
  assert.ok(spread(end) > spread(0) * 2, "cone must widen with time");
  // and a longer horizon must be wider than a shorter one
  const short = await predict.projectionCone("TEST", "1w");
  assert.ok(cone.band_width_pct > short.band_width_pct, "3m wider than 1w");
  assert.match(cone.note, /not a directional forecast/i);
  // axis honesty (regression): a 1-week cone's x-extent must be ~1 week, not stretched
  assert.strictEqual(short.bands.p50.length, 5, "1w = 5 daily steps");
  const lastCandle = Date.parse(daily[daily.length - 1].time);
  const lastPoint = Date.parse(short.bands.p50[4].time);
  assert.ok((lastPoint - lastCandle) / 86400000 <= 10, "1w cone must end within ~10 calendar days");
});

test("projectionCone: intraday horizon falls back to daily-scaled vol when hourly is unavailable", async () => {
  const cone = await predict.projectionCone("TEST", "1h");
  assert.strictEqual(cone.params.vol_timeframe, "1d");
  assert.ok(cone.band_width_pct < 8, "a 1-hour range should be narrow: " + cone.band_width_pct + "%");
});

test("projectionCone: unknown horizon is a clean error", async () => {
  await assert.rejects(() => predict.projectionCone("TEST", "5y"), /unknown horizon/);
});
