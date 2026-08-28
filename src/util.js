"use strict";
// Small shared helpers used across the server, engines, and AI modules. Pure functions
// only — this module must never require db/settings (it is imported everywhere).

// Lenient JSON parse: DB columns storing JSON may be NULL or (historically) malformed —
// always fall back instead of throwing mid-request.
const J = (s, fb) => { try { return JSON.parse(s); } catch (_) { return fb; } };

// Yahoo ticker for a rec/trade/watch row: crypto display symbols map to SYMBOL-USD
// (BTC -> BTC-USD); stocks and already-paired symbols pass through unchanged.
function yahooSym(row) {
  return row.asset_type === "crypto" && !row.symbol.includes("-") ? `${row.symbol}-USD` : row.symbol;
}

// Percent change from entry to exit, sign-adjusted for shorts.
function pctChange(entry, exit, side) {
  const raw = ((exit - entry) / entry) * 100;
  return side === "sell" ? -raw : raw;
}

// Weighted ladder P&L: hit targets earn their rung's sell_pct, the remaining position
// exits at `residualPrice` (the stop, the live price on manual completion, or the last
// price on expiry-while-tracking). This is THE P&L rule — every place that grades a
// recommendation (tracker, backfill, manual complete) must use it, not reimplement it.
function ladderPnl(entry, targetsHit, targets, residualPrice, side) {
  let pnl = 0, pctUsed = 0;
  for (const t of targets) {
    if (targetsHit.includes(t.price)) { pnl += (t.sell_pct / 100) * pctChange(entry, t.price, side); pctUsed += t.sell_pct; }
  }
  if (pctUsed < 100 && residualPrice != null) pnl += ((100 - pctUsed) / 100) * pctChange(entry, residualPrice, side);
  return +pnl.toFixed(2);
}

// Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CR/LF) → array of rows.
// Used by the broker-CSV trade import.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

// Minimal CSV writer for the export endpoints (RFC-4180 quoting).
function toCsv(rows, cols) {
  const escape = (v) => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => escape(r[c])).join(","))].join("\n");
}

module.exports = { J, yahooSym, pctChange, ladderPnl, toCsv, parseCsv };
