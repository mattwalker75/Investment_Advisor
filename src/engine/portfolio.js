"use strict";
// Portfolio-level analysis shared by the REST API and the advisor-chat tools.
//   concentration(): are open positions clustered in one sector (correlated risk)?
//   equityCurves():  what trading actually did to the account (realized closed-trade
//                    P&L over time) next to the WHAT-IF curve — "if I'd taken every
//                    finished recommendation with my risk sizing".
const db = require("../db");
const settings = require("../settings");
const yahoo = require("../providers/yahoo");
const { J } = require("../util");

async function concentration() {
  const open = await db.all("SELECT symbol, asset_type FROM trades WHERE status='open'");
  if (open.length < 2) return { positions: open.length, warnings: [] };
  // Sector lookups in parallel per unique non-crypto symbol.
  const stockSyms = [...new Set(open.filter((t) => t.asset_type !== "crypto").map((t) => t.symbol))];
  const sectors = Object.fromEntries(await Promise.all(
    stockSyms.map((sym) => yahoo.sector(sym).then((s) => [sym, s.sector || null]).catch(() => [sym, null]))));
  const buckets = {};
  for (const t of open) {
    const key = t.asset_type === "crypto" ? "Crypto" : (sectors[t.symbol] || "Unknown sector");
    buckets[key] = buckets[key] || []; buckets[key].push(t.symbol);
  }
  const warnings = [];
  for (const [sector, syms] of Object.entries(buckets)) {
    const share = syms.length / open.length;
    if (syms.length >= 2 && share >= 0.5)
      warnings.push(`⚠ ${Math.round(share * 100)}% of your open positions are ${sector} (${syms.join(", ")}) — correlated risk.`);
  }
  return { positions: open.length, by_sector: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])), warnings };
}

// ---- Equity curves ----
const dayIso = (ts) => new Date(Number(ts)).toISOString().slice(0, 10);
// Last value per day, ascending — lightweight-charts needs unique ascending times.
function toDaily(points) {
  const m = new Map();
  for (const p of points) m.set(p.time, p.value);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([time, value]) => ({ time, value }));
}
function curveStats(series, startEquity) {
  if (!series.length) return null;
  let peak = startEquity, maxDd = 0;
  for (const p of series) { peak = Math.max(peak, p.value); maxDd = Math.max(maxDd, (peak - p.value) / peak); }
  const final = series[series.length - 1].value;
  return {
    final_equity: +final.toFixed(2),
    pnl: +(final - startEquity).toFixed(2),
    return_pct: +(((final - startEquity) / startEquity) * 100).toFixed(2),
    max_drawdown_pct: +(maxDd * 100).toFixed(1),
    points: series.length,
  };
}

async function equityCurves() {
  const risk = settings.getSync().preferences.risk;
  const start = risk.account_size || 10000;
  const riskPct = risk.risk_per_trade_pct || 1;

  // ACTUAL: realized P&L of closed trades applied to the configured account size in
  // close order — "here's what this actually did to your account", not just a win rate.
  const closed = await db.all("SELECT closed_at, pnl FROM trades WHERE status='closed' AND closed_at IS NOT NULL ORDER BY closed_at, id");
  let eq = start;
  const actualPts = [];
  for (const t of closed) { eq += Number(t.pnl) || 0; actualPts.push({ time: dayIso(t.closed_at), value: +eq.toFixed(2) }); }
  const actual = toDaily(actualPts);

  // WHAT-IF (paper mode): every finished recommendation taken at its shadow entry with
  // the user's risk sizing — position sized so entry→stop risk = risk_per_trade_pct of
  // running equity, value capped at equity (no leverage), applied sequentially by exit
  // date. A hands-off honesty metric: "what if I'd taken them all?"
  const recs = await db.all("SELECT stop_loss, outcome FROM recommendations WHERE status IN ('stopped','target_hit','closed') ORDER BY id");
  const fin = recs
    .map((r) => ({ stop: r.stop_loss, o: J(r.outcome, {}) || {} }))
    .filter((r) => r.o.pnl_pct != null && r.o.entry_price != null)
    .map((r) => ({ ...r, at: r.o.exit_at || r.o.entry_hit_at }))
    .filter((r) => r.at)
    .sort((a, b) => a.at - b.at);
  let weq = start;
  const wPts = [];
  for (const r of fin) {
    const entry = r.o.entry_price, riskDist = Math.abs(entry - r.stop);
    if (!riskDist || !isFinite(riskDist)) continue;
    const posVal = Math.min(weq, weq * (riskPct / 100) * (entry / riskDist));
    weq += posVal * (r.o.pnl_pct / 100);
    wPts.push({ time: dayIso(r.at), value: +weq.toFixed(2) });
  }
  const what_if = toDaily(wPts);

  return {
    starting_equity: start,
    risk_per_trade_pct: riskPct,
    actual: { series: actual, stats: curveStats(actual, start) },
    what_if: {
      series: what_if, stats: curveStats(what_if, start),
      note: "every finished recommendation taken at its shadow entry with your risk sizing (sequential, no leverage)",
    },
  };
}

module.exports = { concentration, equityCurves };
