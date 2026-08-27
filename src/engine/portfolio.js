"use strict";
// Portfolio-level analysis shared by the REST API and the advisor-chat tools.
// concentration(): are open positions clustered in one sector (correlated risk)?
const db = require("../db");
const yahoo = require("../providers/yahoo");

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

module.exports = { concentration };
