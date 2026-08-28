"use strict";
// Fundamentals: the compact valuation/quality context the AI was missing — P/E,
// margins, growth, leverage, beta — attached to stock scan candidates and exposed as a
// chat tool. Sources: FMP profile (known-good on the free tier; already powers sector
// lookups) plus ratios-ttm where the tier allows, both degrading gracefully to
// whatever subset is available. Cached 24h — fundamentals don't move intraday.
//
// HONEST FRAME (carried into the prompts): fundamentals TEMPER a swing-trade thesis,
// they don't turn this into a value screener.
const { cached } = require("./cache");
const settings = require("../settings");

const TTL = 24 * 3600 * 1000;
const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const round = (v, dp = 2) => (v == null ? null : +v.toFixed(dp));

// Pure composer (unit-tested): FMP profile + ratios rows → the compact block.
function compose(symbol, profile, ratios) {
  const p = profile || {}, r = ratios || {};
  const out = {
    symbol,
    company: p.companyName || null,
    sector: p.sector || null,
    industry: p.industry || null,
    market_cap: num(p.marketCap ?? p.mktCap),
    beta: round(num(p.beta)),
    // valuation
    pe_ttm: round(num(r.priceToEarningsRatioTTM ?? r.peRatioTTM)),
    ps_ttm: round(num(r.priceToSalesRatioTTM)),
    pb_ttm: round(num(r.priceToBookRatioTTM)),
    // profitability & quality
    net_margin_pct: round(num(r.netProfitMarginTTM) != null ? r.netProfitMarginTTM * 100 : null, 1),
    gross_margin_pct: round(num(r.grossProfitMarginTTM) != null ? r.grossProfitMarginTTM * 100 : null, 1),
    roe_pct: round(num(r.returnOnEquityTTM) != null ? r.returnOnEquityTTM * 100 : null, 1),
    // balance sheet & income
    debt_to_equity: round(num(r.debtToEquityRatioTTM ?? r.debtEquityRatioTTM)),
    current_ratio: round(num(r.currentRatioTTM)),
    dividend_yield_pct: round(num(r.dividendYieldTTM) != null ? r.dividendYieldTTM * 100 : null, 2),
  };
  // Drop nulls so prompts stay lean and absence is visible as absence.
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

async function fundamentals(symbol) {
  const key = (settings.getSync().providers.fmp_key || "").trim();
  const raw = String(symbol || "").toUpperCase().trim();
  if (!raw) return { note: "symbol required" };
  if (/-USD$/.test(raw)) return { symbol: raw, note: "fundamentals apply to stocks — crypto has no income statement" };
  const sym = raw;
  if (!key) return { symbol: sym, note: "fundamentals need the free FMP key — Settings → Data feeds" };
  try {
    return await cached(`fund:${sym}`, TTL, async () => {
      const j = async (path) => {
        const r = await fetch(`https://financialmodelingprep.com/stable/${path}?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(key)}`,
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`FMP ${path} ${r.status}`);
        const d = await r.json();
        return Array.isArray(d) ? d[0] : d;
      };
      const profile = await j("profile").catch(() => null);
      const ratios = await j("ratios-ttm").catch(() => null);   // may be tier-gated — degrade
      if (!profile && !ratios) throw new Error("no fundamentals available");
      const out = compose(sym, profile, ratios);
      if (!ratios) out.note = "ratios unavailable on this FMP tier — profile-level data only";
      return out;
    });
  } catch (e) {
    return { symbol: sym, note: `fundamentals unavailable (${String(e.message).slice(0, 80)})` };
  }
}

module.exports = { fundamentals, compose };
