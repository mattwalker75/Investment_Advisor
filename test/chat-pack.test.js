"use strict";
// packResult: tool results must never be blunt-cut mid-JSON (regression for the old
// 14k slice) — structural shrink first, marked partial only as a last resort.
const { test } = require("node:test");
const assert = require("node:assert");
const { useTempDb } = require("./helpers");

useTempDb();   // chat.js pulls the db module chain at require time
const { packResult, TOOL_DEFS } = require("../src/ai/chat");

test("small results pass through byte-identical", () => {
  assert.strictEqual(packResult({ a: 1, b: "x" }), JSON.stringify({ a: 1, b: "x" }));
});

test("large `inputs` snapshots are summarized away, siblings survive", () => {
  const big = { id: 5, symbol: "NVDA", inputs: { candidate: { blob: "x".repeat(20000) } }, outcome: { pnl_pct: 3 } };
  const out = JSON.parse(packResult(big));
  assert.match(out.inputs, /omitted/);
  assert.strictEqual(out.outcome.pnl_pct, 3);
});

test("long arrays cap at 20 with an omission marker", () => {
  const arr = { rows: Array.from({ length: 200 }, (_, i) => ({ i, pad: "y".repeat(120) })) };
  const out = JSON.parse(packResult(arr));
  assert.strictEqual(out.rows.length, 21);
  assert.match(out.rows[20], /more items omitted/);
});

test("pathological payloads fall back to VALID JSON (marked partial), never a mid-cut", () => {
  const huge = { blob: Array.from({ length: 30 }, () => "z".repeat(1900)) };
  const s = packResult(huge);
  const out = JSON.parse(s);            // must parse — that's the whole point
  assert.ok(out.truncated || out.blob);
  assert.ok(s.length <= 14100, "stays near the limit: " + s.length);
});

test("tool surface: the expected tools are registered exactly once", () => {
  const names = TOOL_DEFS.map((t) => t.function.name);
  assert.strictEqual(new Set(names).size, names.length, "duplicate tool names");
  for (const expected of ["get_analysis", "save_recommendation", "run_backtest", "check_position_health",
    "revalidate_recommendation", "get_portfolio_concentration", "compare_symbols", "manage_watchlist",
    "update_trade", "get_economic_calendar", "manage_memory", "suggest_options_play"])
    assert.ok(names.includes(expected), "missing tool: " + expected);
});
