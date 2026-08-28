"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { J, yahooSym, pctChange, ladderPnl, toCsv, parseCsv } = require("../src/util");

test("J: lenient JSON parse with fallback", () => {
  assert.deepStrictEqual(J('{"a":1}', null), { a: 1 });
  assert.strictEqual(J("not json", "fb"), "fb");
  assert.strictEqual(J(undefined, 7), 7);
  // Documented quirk: JSON.parse coerces null → "null" → parses to null (no throw),
  // so a NULL db column yields null, not the fallback. Callers use `|| {}` guards.
  assert.strictEqual(J(null, 7), null);
});

test("yahooSym: crypto maps to -USD, stocks/pairs pass through", () => {
  assert.strictEqual(yahooSym({ asset_type: "crypto", symbol: "BTC" }), "BTC-USD");
  assert.strictEqual(yahooSym({ asset_type: "crypto", symbol: "BTC-USD" }), "BTC-USD");
  assert.strictEqual(yahooSym({ asset_type: "stock", symbol: "NVDA" }), "NVDA");
  assert.strictEqual(yahooSym({ asset_type: "option", symbol: "NVDA" }), "NVDA");
});

test("pctChange: sign flips for shorts", () => {
  assert.strictEqual(pctChange(100, 110, "buy"), 10);
  assert.strictEqual(pctChange(100, 110, "sell"), -10);
  assert.strictEqual(pctChange(100, 90, "sell"), 10);
});

test("ladderPnl: hit rungs earn their pct, residual exits at residualPrice", () => {
  const targets = [{ price: 110, sell_pct: 50 }, { price: 120, sell_pct: 50 }];
  // T1 hit (50% at +10%), remainder stopped at 95 (-5% on 50%) => 5 - 2.5 = 2.5
  assert.strictEqual(ladderPnl(100, [110], targets, 95, "buy"), 2.5);
  // full ladder, no residual: 5 + 10 = 15
  assert.strictEqual(ladderPnl(100, [110, 120], targets, null, "buy"), 15);
  // nothing hit, stopped at 92: -8
  assert.strictEqual(ladderPnl(100, [], targets, 92, "buy"), -8);
  // sell side: premium decays 100 -> 50 residual = +50 for a short
  assert.strictEqual(ladderPnl(100, [], targets, 50, "sell"), 50);
});

test("ladderPnl is the single P&L rule (regression: same result at every call site shape)", () => {
  const targets = [{ price: 12, sell_pct: 25 }, { price: 15, sell_pct: 50 }, { price: 20, sell_pct: 25 }];
  const viaStop = ladderPnl(10, [12, 15], targets, 9, "buy");
  // 25%*20 + 50%*50 + 25%*(-10) = 5 + 25 - 2.5 = 27.5
  assert.strictEqual(viaStop, 27.5);
});

test("toCsv: RFC-4180 quoting", () => {
  const csv = toCsv([{ a: 'x"y', b: "1,2", c: null }], ["a", "b", "c"]);
  assert.strictEqual(csv, 'a,b,c\n"x""y","1,2",');
});

test("parseCsv: quotes, escaped quotes, CRLF, trailing rows", () => {
  const rows = parseCsv('sym,qty,price\r\nNVDA,10,"1,234.50"\n"BRK.B",5,"say ""hi"""\n');
  assert.deepStrictEqual(rows[0], ["sym", "qty", "price"]);
  assert.deepStrictEqual(rows[1], ["NVDA", "10", "1,234.50"]);
  assert.deepStrictEqual(rows[2], ["BRK.B", "5", 'say "hi"']);
  assert.strictEqual(rows.length, 3);
});

test("parseCsv round-trips toCsv", () => {
  const cols = ["a", "b"];
  const data = [{ a: "plain", b: 'tricky,"quoted"\nline' }];
  const rows = parseCsv(toCsv(data, cols));
  assert.deepStrictEqual(rows[1], ["plain", 'tricky,"quoted"\nline']);
});
