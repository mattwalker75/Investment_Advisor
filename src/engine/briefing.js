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
  return {
    as_of: new Date().toString(),
    market: { quotes, sentiment: senti, headlines: heads.map((h) => h.title) },
    open_positions: positions,
    active_recommendations: recs,
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
4. **Watch today**: 1-3 bullets max.
Be specific with numbers. No fluff, no disclaimers, no greetings.` },
    { role: "user", content: JSON.stringify(data) },
  ], { max_tokens: 1200, task: "light" });
  const text = (content || "").trim();
  if (!text) throw new Error("empty briefing from model");
  await logEvent("briefing", "briefing", null, null, text);
  console.log(`[briefing] generated (${trigger}), ${text.length} chars`);
  return { text };
}

async function latest() {
  const row = await db.get("SELECT at, message FROM events WHERE type='briefing' ORDER BY id DESC LIMIT 1");
  return row ? { at: Number(row.at), text: row.message } : null;
}

module.exports = { run, latest };
