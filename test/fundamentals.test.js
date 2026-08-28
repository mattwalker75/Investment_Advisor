"use strict";
// The fundamentals composer: FMP payloads → the compact prompt block (pure, offline).
const { test } = require("node:test");
const assert = require("node:assert");
const { compose } = require("../src/providers/fundamentals");

test("compose: maps profile + ratios into the compact block, percentages scaled", () => {
  const out = compose("NVDA",
    { companyName: "NVIDIA Corp", sector: "Technology", industry: "Semiconductors", marketCap: 3.2e12, beta: 1.68 },
    { priceToEarningsRatioTTM: 38.4, priceToSalesRatioTTM: 22.1, netProfitMarginTTM: 0.489, returnOnEquityTTM: 0.912, debtToEquityRatioTTM: 0.41, dividendYieldTTM: 0.0003 });
  assert.strictEqual(out.company, "NVIDIA Corp");
  assert.strictEqual(out.pe_ttm, 38.4);
  assert.strictEqual(out.net_margin_pct, 48.9, "margins scale to percent");
  assert.strictEqual(out.roe_pct, 91.2);
  assert.strictEqual(out.debt_to_equity, 0.41);
  assert.strictEqual(out.dividend_yield_pct, 0.03);
  assert.strictEqual(out.beta, 1.68);
});

test("compose: nulls are DROPPED so absence reads as absence in the prompt", () => {
  const out = compose("XYZ", { companyName: "XYZ Inc" }, null);
  assert.strictEqual(out.company, "XYZ Inc");
  assert.ok(!("pe_ttm" in out), "missing ratios never appear as null keys");
  assert.ok(!("net_margin_pct" in out));
});

test("compose: garbage values are rejected, not passed through", () => {
  const out = compose("BAD", { marketCap: "not-a-number", beta: Infinity }, { priceToEarningsRatioTTM: NaN });
  assert.ok(!("market_cap" in out));
  assert.ok(!("beta" in out));
  assert.ok(!("pe_ttm" in out));
});
