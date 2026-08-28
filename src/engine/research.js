"use strict";
// Research report generator: one command runs EVERY engine — technicals, fundamentals,
// news, insiders, congress activity, options posture, the projection cone, the market
// regime, and the system's own shadow-graded history on the name — and the AI writes a
// structured research note from that data and nothing else. Notes are saved to a small
// library (settings KV), retrievable and deletable.
//
// Honesty rules are baked into the prompt: cite only supplied data, call missing data
// missing, quote the projection's band width instead of a point target, and close with
// what would change the thesis. Research, not advice.
const settings = require("../settings");
const llm = require("../ai/llm");
const { J } = require("../util");

const KEY = "research_reports";
const MAX_REPORTS = 15;

// Gather everything the engines know about one symbol. Every source is optional —
// failures become absent keys, and the prompt treats absence as absence.
async function gatherContext(asset) {
  const db = require("../db");
  const yahoo = require("../providers/yahoo");
  const indicators = require("../indicators");
  const s = settings.getSync();
  const isStock = asset.asset_type === "stock";

  const [quote, candles, bench, heads, regime, cone] = await Promise.all([
    yahoo.quote(asset.yahoo).catch(() => null),
    yahoo.history(asset.yahoo, 365).catch(() => null),
    isStock ? yahoo.history("SPY", 365).then((c) => c.map((b) => b.close)).catch(() => null) : null,
    require("../providers/news").headlines(72, 60).catch(() => []),
    require("./regime").marketRegime().catch(() => null),
    require("./predict").projectionCone(asset.yahoo, "3m").catch(() => null),
  ]);
  const ctx = { symbol: asset.display, name: asset.name, asset_type: asset.asset_type, as_of: new Date().toISOString() };
  if (quote) ctx.quote = { price: quote.price, change_pct: quote.change_pct, market_cap: quote.market_cap ?? undefined };
  if (candles && candles.length >= 60) {
    ctx.technicals = indicators.computeAllCached(`res:${asset.yahoo}`, candles, s.indicators, bench ? { benchCloses: bench } : {}).latest;
  }
  const news = require("../providers/news");
  ctx.headlines = news.matching(heads, asset.display, asset.name).map((h) => h.title).slice(0, 8);
  if (regime) ctx.market_regime = { regime: regime.regime, note: regime.note };
  if (cone) ctx.projection_3m = { at_horizon: cone.at_horizon, band_width_pct: cone.band_width_pct, sigma_annual_pct: cone.params.sigma_annual_pct, note: cone.note };

  if (isStock) {
    const [fundamentals, insiders, earnings, chain] = await Promise.all([
      require("../providers/fundamentals").fundamentals(asset.display).catch(() => null),
      require("../providers/whales").insiderTrades(asset.display).catch(() => null),
      yahoo.nextEarnings(asset.yahoo).catch(() => null),
      yahoo.optionsChain(asset.yahoo, s.preferences.options.max_dte || 60).catch(() => null),
    ]);
    if (fundamentals && !fundamentals.note) ctx.fundamentals = fundamentals;
    if (insiders && insiders.trades && insiders.trades.length) ctx.insiders = { summary: insiders.summary, recent: insiders.trades.slice(0, 6) };
    if (earnings) ctx.next_earnings = earnings;
    if (chain) ctx.options_posture = { expiry: chain.expiry, dte: chain.dte, atm_iv_pct: require("./options").atmIv(chain, (quote && quote.price) ?? chain.spot) };
    const congress = await require("../providers/whales").congressFeed().catch(() => []);
    const mine = congress.filter((t) => t.ticker === asset.display).slice(0, 5);
    if (mine.length) ctx.congress_activity = mine.map((t) => ({ who: t.politician, action: t.action, amount: t.amount, traded: t.traded_at }));
  }

  // The system's own history on this name — shadow-graded, honest.
  const past = await db.all("SELECT side, status, confidence, created_at, outcome FROM recommendations WHERE symbol=? ORDER BY id DESC LIMIT 10", [asset.display]).catch(() => []);
  const graded = past.map((r) => ({ ...r, o: J(r.outcome, {}) || {} }))
    .filter((r) => r.o.pnl_pct != null)
    .map((r) => ({ side: r.side, status: r.status, confidence: r.confidence, pnl_pct: r.o.pnl_pct }));
  if (graded.length) ctx.own_track_record_here = graded;
  const open = await db.get("SELECT side, qty, entry_price, stop_loss FROM trades WHERE symbol=? AND status='open' LIMIT 1", [asset.display]).catch(() => null);
  if (open) ctx.user_holds_position = open;
  return ctx;
}

const REPORT_PROMPT = `You write a RESEARCH NOTE for the user's personal investment-advisor tool, from the
supplied data and NOTHING else. Markdown, ~450 words max, these sections:

## Summary & thesis — 2-3 sentences: what this is and your read.
## Technical picture — trend, momentum, key levels, relative strength; cite the numbers.
## Valuation & fundamentals — only if fundamentals are supplied; otherwise one line saying they're unavailable (or N/A for crypto).
## Catalysts & risks — earnings dates, headlines, macro regime; what could break the thesis either way.
## Smart money — insiders/congress activity if supplied; skip the section entirely if absent.
## Projection — quote the 3-month band HONESTLY (p10–p90 and its width); never a point target.
## Trade plan — a full structure (entry zone, stop, laddered targets, horizon) ONLY if the setup genuinely warrants one; otherwise say "no trade here" and what you'd wait for.
## Confidence & what would change my mind — an honest 0-1 confidence, the system's own track record on this name if supplied, and the specific observation that would flip your view.

RULES: cite only supplied data; say "not available" rather than inventing; if the user holds a position, address it directly; end with one line: research, not financial advice.`;

async function generateReport(symbolRaw, assetTypeHint) {
  const { resolveAsset } = require("../resolve");
  const asset = await resolveAsset(symbolRaw, assetTypeHint);
  if (!asset) throw new Error("symbol required");
  const ctx = await gatherContext(asset);
  const { content, model } = await llm.chat([
    { role: "system", content: REPORT_PROMPT },
    { role: "user", content: JSON.stringify(ctx) },
  ], { max_tokens: 2200, task: "scan" });
  const text = (content || "").trim();
  if (!text) throw new Error("empty report from model");
  const report = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    symbol: asset.display, asset_type: asset.asset_type,
    at: Date.now(), model,
    title: `${asset.display} — research note`,
    text,
  };
  const db = require("../db");
  const list = await listReports();
  list.unshift(report);
  await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"),
    [KEY, JSON.stringify(list.slice(0, MAX_REPORTS)), Date.now()]);
  return report;
}

async function listReports() {
  const db = require("../db");
  const row = await db.get("SELECT value FROM settings WHERE `key`=?", [KEY]).catch(() => null);
  const list = row ? J(row.value, []) : [];
  return Array.isArray(list) ? list : [];
}
async function getReport(id) {
  return (await listReports()).find((r) => r.id === String(id)) || null;
}
async function deleteReport(id) {
  const db = require("../db");
  const list = await listReports();
  const next = list.filter((r) => r.id !== String(id));
  await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"), [KEY, JSON.stringify(next), Date.now()]);
  return { removed: list.length - next.length };
}

module.exports = { generateReport, gatherContext, listReports, getReport, deleteReport };
