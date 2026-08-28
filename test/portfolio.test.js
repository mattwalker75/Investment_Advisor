"use strict";
// Equity-curve math against a real (throwaway) SQLite database.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { useTempDb } = require("./helpers");

useTempDb();
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

test("equityCurves: what-if sizes by risk distance, capped at equity, sequential", async () => {
  const e = await require("../src/engine/portfolio").equityCurves();
  assert.strictEqual(e.what_if.series.length, 2);
  // rec 1: entry 100, stop 92 → risk dist 8; position = eq × 1% × (100/8) = 12.5% of
  // equity; +8% on that = +1.0% of equity → 10100.
  assert.ok(Math.abs(e.what_if.series[0].value - 10100) < 1, String(e.what_if.series[0].value));
  assert.ok(e.what_if.series[1].value < e.what_if.series[0].value, "loss must follow");
});
