"use strict";
// Shared test utilities. Tests are NETWORK-FREE: provider modules get stubbed into the
// require cache BEFORE the modules under test load them, and DB-backed suites run
// against a throwaway SQLite file in a temp directory. Each *.test.js file runs in its
// own process under `node --test`, so stubs and env never leak between files.
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Point src/db at a fresh throwaway SQLite database. MUST be called before requiring
// any src/ module that touches the DB. Returns the temp dir (auto-deleted on exit).
function useTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-test-"));
  const cfg = { db: { dialect: "sqlite", sqlite: { file: path.join(dir, "test.db") } } };
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg));
  process.env.ADVISOR_CONFIG = file;
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return dir;
}

// Replace a src module with a stub in the require cache. Call before anything requires
// the real one. `rel` is relative to the repo's src/ (e.g. "providers/yahoo.js").
function stubModule(rel, exports) {
  const full = require.resolve(path.join(ROOT, "src", rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return exports;
}

// Deterministic daily candle series: gentle uptrend with a sine wave (fires oversold
// signals on dips, recovers after) — the standard fixture for backtest/indicator tests.
function syntheticCandles(n = 400, { start = "2025-01-01", base = 100, trend = 0.08, amp = 6 } = {}) {
  const t0 = Date.parse(start + "T00:00:00Z");
  const out = [];
  for (let i = 0; i < n; i++) {
    const px = base + i * trend + Math.sin(i / 7) * amp;
    out.push({
      time: new Date(t0 + i * 86400000).toISOString().slice(0, 10),
      open: px - 0.4, high: px + 1.6, low: px - 1.8, close: px, volume: 1e6,
    });
  }
  return out;
}

// A small realistic option chain fixture (NVDA-ish, spot 120).
function sampleChain() {
  return {
    symbol: "NVDA", spot: 120, expiry: "2099-10-16", dte: 45,
    calls: [
      { strike: 115, bid: 8.8, ask: 9.2, iv: 42, open_interest: 500, last: 9.0, volume: 10 },
      { strike: 120, bid: 5.9, ask: 6.1, iv: 40, open_interest: 900, last: 6.0, volume: 30 },
      { strike: 125, bid: 3.4, ask: 3.6, iv: 41, open_interest: 700, last: 3.5, volume: 22 },
      { strike: 130, bid: 1.9, ask: 2.1, iv: 43, open_interest: 400, last: 2.0, volume: 12 },
    ],
    puts: [
      { strike: 110, bid: 1.4, ask: 1.6, iv: 44, open_interest: 300, last: 1.5, volume: 8 },
      { strike: 115, bid: 2.4, ask: 2.6, iv: 43, open_interest: 350, last: 2.5, volume: 9 },
      { strike: 120, bid: 4.4, ask: 4.6, iv: 42, open_interest: 600, last: 4.5, volume: 15 },
    ],
  };
}

// Standard prefs fixture for validator tests.
function samplePrefs(over = {}) {
  return {
    risk: { min_confidence: 0.55, min_risk_reward: 1.5, risk_tolerance: "moderate", allow_shorts: true,
      max_recommendations_per_scan: 5, avoid_earnings_days: 3, account_size: 10000, risk_per_trade_pct: 1,
      stops: { breakeven_after_target1: true, atr_trailing: true, atr_multiple: 3 }, ...over.risk },
    options: { enabled: true, max_dte: 60, notes: "",
      strategies: { long_call: true, long_put: true, call_spread: true, put_spread: false, covered_call: false, cash_secured_put: true },
      ...over.options },
  };
}

module.exports = { ROOT, useTempDb, stubModule, syntheticCandles, sampleChain, samplePrefs };
