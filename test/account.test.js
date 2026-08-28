"use strict";
// Multi-account tagging: the risk panel filters by account label ("none" = untagged),
// always reports which labels exist, and skips the portfolio-wide correlation read
// under a filter instead of showing it mislabeled.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { useTempDb, stubModule, samplePrefs } = require("./helpers");

useTempDb();

stubModule("providers/yahoo.js", {
  quotes: async (syms) => Object.fromEntries(syms.map((s) => [s, { price: 110 }])),
  history: async () => [],
});

const db = require("../src/db");
const settings = require("../src/settings");
settings.getSync = () => ({ preferences: samplePrefs() });

before(async () => {
  await db.init();
  const ins = (sym, account, stop) => db.run(
    "INSERT INTO trades (created_at, entry_at, asset_type, symbol, side, qty, entry_price, stop_loss, status, account) VALUES (?,?,'stock',?,'buy',10,100,?,'open',?)",
    [Date.now(), Date.now(), sym, stop, account]);
  await ins("AAA", "ira", 95);        // risk 50
  await ins("BBB", "taxable", 90);    // risk 100
  await ins("CCC", null, 80);         // untagged, risk 200
});
after(async () => { await db.close(); });

test("unfiltered panel lists the labels and totals everything", async () => {
  const { riskPanel } = require("../src/engine/portfolio");
  const r = await riskPanel();
  assert.deepStrictEqual(r.accounts, ["ira", "taxable"]);
  assert.strictEqual(r.account_filter, null);
  assert.strictEqual(r.positions.length, 3);
  assert.strictEqual(r.total_risk, 350);
});

test("account filter narrows the panel; correlation is omitted (portfolio-wide only)", async () => {
  const { riskPanel } = require("../src/engine/portfolio");
  const r = await riskPanel({ account: "ira" });
  assert.strictEqual(r.account_filter, "ira");
  assert.strictEqual(r.positions.length, 1);
  assert.strictEqual(r.positions[0].symbol, "AAA");
  assert.strictEqual(r.total_risk, 50);
  assert.ok(r.correlation == null, "no mislabeled portfolio-wide correlation under a filter");
  assert.deepStrictEqual(r.accounts, ["ira", "taxable"], "label list stays complete for the UI");
});

test("'none' selects the untagged trades", async () => {
  const { riskPanel } = require("../src/engine/portfolio");
  const r = await riskPanel({ account: "none" });
  assert.strictEqual(r.positions.length, 1);
  assert.strictEqual(r.positions[0].symbol, "CCC");
  assert.strictEqual(r.total_risk, 200);
});
