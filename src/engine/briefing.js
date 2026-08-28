"use strict";
// Daily AI briefing: a concise morning read written by the model from live data —
// market conditions, your open positions vs their plans, active recommendations, and
// anything needing attention today. Stored as an event (type 'briefing'), shown on the
// dashboard, and pushed through notifications (gated by notify_on.briefing).
const db = require("../db");
const llm = require("../ai/llm");
const settings = require("../settings");
const yahoo = require("../providers/yahoo");
const news = require("../providers/news");
const sentiment = require("../providers/sentiment");
const { logEvent } = require("../events");

const { J, yahooSym } = require("../util");

async function gather() {
  const [quotes, senti, heads] = await Promise.all([
    yahoo.quotes(["SPY", "QQQ", "DIA", "BTC-USD", "ETH-USD"]).catch(() => ({})),
    sentiment.snapshot().catch(() => ({})),
    news.headlines(18, 12).catch(() => []),
  ]);
  const trades = await db.all("SELECT * FROM trades WHERE status='open'");
  const positions = [];
  for (const t of trades) {
    const q = t.asset_type === "option" ? null : await yahoo.quote(yahooSym(t)).catch(() => null);
    const od = J(t.option_details, null);
    positions.push({
      symbol: t.symbol, side: t.side, asset_type: t.asset_type,
      option: od ? `${od.strike}${od.type === "put" ? "P" : "C"} exp ${od.expiry}` : undefined,
      entry: t.entry_price, current: q ? q.price : undefined,
      stop: t.stop_loss, targets: J(t.targets, []),
      suggested_stop: J(t.suggested_stop, null),
      health: J(t.health, null),
      days_in: Math.round((Date.now() - Number(t.entry_at)) / 86400000),
    });
  }
  const recs = await db.all("SELECT symbol, side, status, entry_low, entry_high, stop_loss, confidence, created_at FROM recommendations WHERE status IN ('open','tracking') ORDER BY id DESC LIMIT 12");
  // Digest-delivery alert-rule hits queue up here instead of buzzing individually.
  // PEEK only — the queue clears after a SUCCESSFUL generation (see run()), so a failed
  // model call never loses queued alerts.
  const digest = await require("./alerts").peekDigest().catch(() => []);
  return {
    as_of: new Date().toString(),
    market: { quotes, sentiment: senti, headlines: heads.map((h) => h.title) },
    open_positions: positions,
    active_recommendations: recs,
    queued_alerts: digest.map((d) => d.message),
  };
}

async function run(trigger = "scheduled") {
  const data = await gather();
  const { content } = await llm.chat([
    { role: "system", content: `You write the user's DAILY TRADING BRIEFING for their personal investment advisor tool.
Given live data, produce a tight, skimmable morning read in markdown (max ~250 words):
1. **Market**: one-two lines — indexes, BTC, sentiment gauges, the headline that matters.
2. **Your positions**: per open position, one line — status vs plan (distance to stop/target), and flag anything needing action TODAY (health verdicts, stop suggestions, option expiries).
3. **Active ideas**: which open recommendations still look actionable.
4. **Watch today**: 1-3 bullets max. If queued_alerts is non-empty, fold those alert hits in here (they were held for this briefing).
Be specific with numbers. No fluff, no disclaimers, no greetings.` },
    { role: "user", content: JSON.stringify(data) },
  ], { max_tokens: 1200, task: "light" });
  const text = (content || "").trim();
  if (!text) throw new Error("empty briefing from model");
  await logEvent("briefing", "briefing", null, null, text);
  await require("./alerts").clearDigest().catch(() => {});   // delivered — now the queue may clear
  console.log(`[briefing] generated (${trigger}), ${text.length} chars`);
  return { text };
}

async function latest() {
  const row = await db.get("SELECT at, message FROM events WHERE type='briefing' ORDER BY id DESC LIMIT 1");
  return row ? { at: Number(row.at), text: row.message } : null;
}

// ---- Weekly AI review: how it's GOING, not just what's happening. ----
async function gatherWeekly() {
  const week = Date.now() - 7 * 86400000;
  const recs = await db.all("SELECT symbol, side, asset_type, status, confidence, created_at, outcome, inputs FROM recommendations");
  const parsed = recs.map((r) => ({ ...r, o: J(r.outcome, {}) || {}, inp: J(r.inputs, {}) || {} }));
  const madeThisWeek = parsed.filter((r) => Number(r.created_at) > week);
  const finishedThisWeek = parsed.filter((r) =>
    (["stopped", "target_hit"].includes(r.status) || (r.status === "closed" && r.o.result === "expired_settled"))
    && r.o.pnl_pct != null && Number(r.o.exit_at || 0) > week);
  const closedTrades = await db.all("SELECT symbol, pnl, pnl_pct, closed_at FROM trades WHERE status='closed' AND closed_at > ?", [week]);
  const eventCounts = await db.all("SELECT type, COUNT(*) AS n FROM events WHERE at > ? GROUP BY type", [week]);
  const notable = await db.all(`SELECT message FROM events WHERE at > ? AND type IN ('strategy_signal','alert_rule','health') ORDER BY id DESC LIMIT 12`, [week]);
  const calibration = await require("./recommender").calibrationSummary().catch(() => null);
  const equity = await require("./portfolio").equityCurves().catch(() => null);
  return {
    week_of: new Date(week).toISOString().slice(0, 10),
    recommendations: {
      made: madeThisWeek.length,
      finished: finishedThisWeek.map((r) => ({ symbol: r.symbol, side: r.side, asset_type: r.asset_type, status: r.status, pnl_pct: r.o.pnl_pct, confidence: r.confidence, source: r.inp.source || "scan" })),
      still_active: parsed.filter((r) => ["open", "tracking"].includes(r.status)).length,
    },
    your_closed_trades: closedTrades.map((t) => ({ symbol: t.symbol, pnl: t.pnl, pnl_pct: t.pnl_pct })),
    event_counts: Object.fromEntries(eventCounts.map((e) => [e.type, e.n])),
    notable_events: notable.map((e) => e.message),
    calibration_line: calibration,
    equity: equity ? { realized: equity.actual.stats, what_if: equity.what_if.stats } : null,
  };
}

async function runWeekly(trigger = "manual") {
  const data = await gatherWeekly();
  const { content } = await llm.chat([
    { role: "system", content: `You write the user's WEEKLY TRADING REVIEW for their personal investment advisor tool —
a candid retrospective, not a pep talk. Markdown, ~300 words max:
1. **The week** — recommendations made/finished with the real win/loss numbers; call out the best and worst call by name.
2. **Your trading** — closed trades and their P&L; note anything the user did differently from the system's plan if visible.
3. **System health** — the confidence-calibration read, strategy signals and alerts that fired, equity vs the what-if curve.
4. **What I'd change** — 1-2 CONCRETE, candid suggestions grounded in this week's data (a setting, a habit, a strategy tweak). If the sample is tiny, say so instead of inventing lessons.
Numbers over adjectives. No greetings, no disclaimers.` },
    { role: "user", content: JSON.stringify(data) },
  ], { max_tokens: 1400, task: "light" });
  const text = (content || "").trim();
  if (!text) throw new Error("empty weekly review from model");
  await logEvent("weekly_review", "briefing", null, null, text);
  console.log(`[weekly-review] generated (${trigger}), ${text.length} chars`);
  return { text };
}

async function latestWeekly() {
  const row = await db.get("SELECT at, message FROM events WHERE type='weekly_review' ORDER BY id DESC LIMIT 1");
  return row ? { at: Number(row.at), text: row.message } : null;
}

module.exports = { run, latest, runWeekly, latestWeekly };
