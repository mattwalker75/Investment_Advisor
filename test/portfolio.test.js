"use strict";
// Equity-curve math against a real (throwaway) SQLite database.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { useTempDb, stubModule } = require("./helpers");

useTempDb();
// portfolio.js binds the yahoo module at load time — stub BEFORE anything requires it.
const priceSeries = {};   // sym -> candles (for the correlation tests)
stubModule("providers/yahoo.js", {
  quotes: async (syms) => Object.fromEntries(syms.map((s) => [s, { price: 100 }])),
  sector: async () => ({ sector: null }),
  history: async (sym) => priceSeries[sym] || [],
});
const db = require("../src/db");
const settings = require("../src/settings");

const day = 86400000;
const t0 = Date.now() - 40 * day;

before(async () => {
  await db.init();
  await settings.load();
  await db.run("INSERT INTO trades (rec_id,created_at,asset_type,symbol,side,qty,entry_price,entry_at,targets,status,pnl,closed_at) VALUES (NULL,?,'stock','AAA','buy',10,100,?,'[]','closed',300,?)", [t0, t0, t0 + 5 * day]);
  await db.run("INSERT INTO trades (rec_id,created_at,asset_type,symbol,side,qty,entry_price,entry_at,targets,status,pnl,closed_at) VALUES (NULL,?,'stock','BBB','buy',5,50,?,'[]','closed',-120,?)", [t0, t0, t0 + 12 * day]);
  const out = (entry, pnl, at) => JSON.stringify({ entry_price: entry, pnl_pct: pnl, exit_at: at, entry_hit_at: at - 3 * day });
  await db.run("INSERT INTO recommendations (created_at,asset_type,symbol,side,current_price,entry_low,entry_high,stop_loss,targets,confidence,status,outcome) VALUES (?,'stock','CCC','buy',100,98,102,92,'[]',0.7,'target_hit',?)", [t0, out(100, 8, t0 + 8 * day)]);
  await db.run("INSERT INTO recommendations (created_at,asset_type,symbol,side,current_price,entry_low,entry_high,stop_loss,targets,confidence,status,outcome) VALUES (?,'stock','DDD','buy',60,58,62,55,'[]',0.6,'stopped',?)", [t0, out(60, -4, t0 + 15 * day)]);
});
after(async () => { await db.close(); });

test("equityCurves: realized curve compounds closed-trade P&L in close order", async () => {
  const e = await require("../src/engine/portfolio").equityCurves();
  assert.strictEqual(e.starting_equity, 10000);
  assert.strictEqual(e.actual.series.length, 2);
  assert.strictEqual(e.actual.series[0].value, 10300);
  assert.strictEqual(e.actual.series[1].value, 10180);
  assert.strictEqual(e.actual.stats.pnl, 180);
  assert.ok(e.actual.stats.max_drawdown_pct > 1 && e.actual.stats.max_drawdown_pct < 1.4);
});

test("riskPanel: stop-distance risk, no-stop flagged at full value, long options cap at premium", async () => {
  const now = Date.now();
  await db.run("INSERT INTO trades (rec_id,created_at,asset_type,symbol,side,qty,entry_price,entry_at,stop_loss,targets,status) VALUES (NULL,?,'stock','RISK1','buy',10,100,?,95,'[]','open')", [now, now]);
  await db.run("INSERT INTO trades (rec_id,created_at,asset_type,symbol,side,qty,entry_price,entry_at,stop_loss,targets,status) VALUES (NULL,?,'stock','RISK2','buy',5,100,?,NULL,'[]','open')", [now, now]);
  await db.run("INSERT INTO trades (rec_id,created_at,asset_type,symbol,side,qty,entry_price,entry_at,stop_loss,targets,option_details,status) VALUES (NULL,?,'option','RISK3','buy',2,3.5,?,NULL,'[]',?,'open')", [now, now, JSON.stringify({ type: "call", strike: 105, expiry: "2099-01-01" })]);
  const r = await require("../src/engine/portfolio").riskPanel();
  const by = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
  assert.strictEqual(by.RISK1.risk, 50, "10 × (100−95)");
  assert.strictEqual(by.RISK2.no_stop, true);
  assert.strictEqual(by.RISK2.risk, 500, "no stop → full value 5×100");
  assert.strictEqual(by.RISK3.risk, 700, "long option → premium 2×3.50×100, no stop needed");
  assert.strictEqual(by.RISK3.no_stop, false, "defined-risk options are not flagged");
  assert.strictEqual(r.no_stop_count, 1, "only the stock without a stop is flagged");
  assert.strictEqual(r.total_risk, 1250);
  assert.ok(r.warnings.some((w) => /RISK2.*NO STOP/.test(w)));
  await db.run("DELETE FROM trades WHERE symbol LIKE 'RISK%'");
});

test("pearson + effectiveBets: known values", () => {
  const { pearson, effectiveBets } = require("../src/engine/portfolio");
  const a = Array.from({ length: 60 }, (_, i) => Math.sin(i / 3) + i * 0.01);
  assert.ok(Math.abs(pearson(a, a) - 1) < 1e-9, "self-correlation = 1");
  assert.ok(Math.abs(pearson(a, a.map((x) => -x)) + 1) < 1e-9, "inverse = -1");
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  assert.ok(Math.abs(effectiveBets([1, 1, 1], I) - 3) < 1e-9, "3 uncorrelated equal bets = 3");
  const ONES = [[1, 1, 1], [1, 1, 1], [1, 1, 1]];
  assert.ok(Math.abs(effectiveBets([1, 1, 1], ONES) - 1) < 1e-9, "perfectly correlated = 1 bet");
});

test("correlation(): identical movers collapse toward one effective position", async () => {
  const mk = (seed) => Array.from({ length: 120 }, (_, i) => {
    const px = 100 + Math.sin((i + seed) / 4) * 8 + i * 0.05;
    return { time: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: px, high: px + 1, low: px - 1, close: px, volume: 1 };
  });
  priceSeries.CORR1 = mk(0);
  priceSeries.CORR2 = mk(0);          // identical → ρ 1
  const now = Date.now();
  await db.run("INSERT INTO trades (rec_id,created_at,asset_type,symbol,side,qty,entry_price,entry_at,stop_loss,targets,status) VALUES (NULL,?,'stock','CORR1','buy',10,100,?,95,'[]','open')", [now, now]);
  await db.run("INSERT INTO trades (rec_id,created_at,asset_type,symbol,side,qty,entry_price,entry_at,stop_loss,targets,status) VALUES (NULL,?,'stock','CORR2','buy',10,100,?,95,'[]','open')", [now, now]);
  const corr = await require("../src/engine/portfolio").correlation();
  assert.ok(corr, "correlation computed");
  assert.ok(corr.effective_positions <= 1.1, "two identical movers ≈ 1 bet, got " + corr.effective_positions);
  assert.ok(corr.high_pairs.length === 1 && corr.high_pairs[0].rho >= 0.99);
  const risk = await require("../src/engine/portfolio").riskPanel();
  assert.ok(risk.warnings.some((w) => /CORR1 & CORR2 move together/.test(w)), "risk panel surfaces the pair");
  await db.run("DELETE FROM trades WHERE symbol LIKE 'CORR%'");
});

test("equityCurves: what-if sizes by risk distance, capped at equity, sequential", async () => {
  const e = await require("../src/engine/portfolio").equityCurves();
  assert.strictEqual(e.what_if.series.length, 2);
  // rec 1: entry 100, stop 92 → risk dist 8; position = eq × 1% × (100/8) = 12.5% of
  // equity; +8% on that = +1.0% of equity → 10100.
  assert.ok(Math.abs(e.what_if.series[0].value - 10100) < 1, String(e.what_if.series[0].value));
  assert.ok(e.what_if.series[1].value < e.what_if.series[0].value, "loss must follow");
});
