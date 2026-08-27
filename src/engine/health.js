"use strict";
// Position health checks — the "when to SELL" engine. Periodically (and on demand) the
// AI re-evaluates every OPEN position with fresh indicators, price action vs the plan,
// and recent news, and issues a verdict per trade:
//   hold | tighten_stop | take_partial | sell_now
// Verdicts are stored on the trade (UI chip) and non-hold verdicts raise an event/alert.
// Advisory only — the user acts (or doesn't) at their broker.
const db = require("../db");
const llm = require("../ai/llm");
const settings = require("../settings");
const yahoo = require("../providers/yahoo");
const news = require("../providers/news");
const indicators = require("../indicators");
const { logEvent } = require("../events");

const { J, yahooSym } = require("../util");
const now = () => Date.now();

async function positionFacts(t, heads) {
  const q = await yahoo.quote(yahooSym(t)).catch(() => null);
  const price = q && q.price;
  let ind = null;
  try {
    const candles = await yahoo.history(yahooSym(t), 365);
    ind = indicators.computeAll(candles, settings.getSync().indicators).latest;
  } catch (_) {}
  const dir = t.side === "sell" ? -1 : 1;
  const od = J(t.option_details, null);
  const exits = (J(t.exits, []) || []).filter((e) => !e.alert);
  const soldQty = exits.reduce((s, e) => s + (e.qty || 0), 0);
  return {
    trade_id: t.id,
    symbol: t.symbol, asset_type: t.asset_type, side: t.side,
    option: od ? { type: od.type, strike: od.strike, expiry: od.expiry, days_to_expiry: od.expiry ? Math.round((Date.parse(od.expiry) - now()) / 86400000) : null } : null,
    entry_price: t.entry_price, current_price: price,
    unrealized_pct: price != null ? +(((price - t.entry_price) / t.entry_price) * 100 * dir).toFixed(2) : null,
    stop_loss: t.stop_loss,
    stop_distance_pct: price != null && t.stop_loss ? +((Math.abs(price - t.stop_loss) / price) * 100).toFixed(2) : null,
    targets: J(t.targets, []),
    remaining_qty: t.qty - soldQty, original_qty: t.qty,
    days_in_trade: Math.round((now() - Number(t.entry_at)) / 86400000),
    indicators: ind,
    recent_headlines: news.matching(heads, t.symbol.replace(/-USD$/, ""), "").map((h) => h.title).slice(0, 4),
  };
}

const VERDICT_PROMPT = `You are reviewing the health of the user's OPEN positions. For each, judge the CURRENT
setup honestly against the plan: is the thesis intact, deteriorating, or done?

Actions (pick ONE per position):
- "hold"          — thesis intact; plan unchanged.
- "tighten_stop"  — keep the position but the stop should move (give suggested_stop).
- "take_partial"  — de-risk: sell part here (say how much in the note).
- "sell_now"      — thesis broken or risk unacceptable; exit.
Consider: price vs stop/targets, indicator deterioration or confirmation, days in trade
vs plan, news risk, and for OPTIONS the days to expiry (theta! a losing option near
expiry usually deserves sell_now or take_partial, not hope).

Respond ONLY with JSON:
{"verdicts":[{"trade_id":1,"action":"hold","urgency":"low|medium|high","suggested_stop":null,"note":"1-2 sentences of WHY, grounded in the data"}]}`;

// Check all open trades (or one, if tradeId given). Returns the verdict list.
async function checkPositions(tradeId = null) {
  const trades = tradeId
    ? await db.all("SELECT * FROM trades WHERE id=? AND status='open'", [tradeId])
    : await db.all("SELECT * FROM trades WHERE status='open'");
  if (!trades.length) return { checked: 0, verdicts: [] };

  const heads = await news.headlines(48, 60).catch(() => []);
  const facts = [];
  for (const t of trades) facts.push(await positionFacts(t, heads));

  const { data } = await llm.chatJSON([
    { role: "system", content: VERDICT_PROMPT },
    { role: "user", content: `Positions (as of ${new Date().toISOString()}):\n${JSON.stringify(facts, null, 1)}` },
  ]);

  const verdicts = [];
  for (const v of (Array.isArray(data.verdicts) ? data.verdicts : [])) {
    const t = trades.find((x) => x.id === Number(v.trade_id));
    if (!t) continue;
    const action = ["hold", "tighten_stop", "take_partial", "sell_now"].includes(v.action) ? v.action : "hold";
    const health = {
      action,
      urgency: ["low", "medium", "high"].includes(v.urgency) ? v.urgency : "low",
      suggested_stop: typeof v.suggested_stop === "number" && v.suggested_stop > 0 ? +v.suggested_stop.toFixed(6) : null,
      note: String(v.note || "").slice(0, 600),
      checked_at: now(),
    };
    await db.run("UPDATE trades SET health=? WHERE id=?", [JSON.stringify(health), t.id]);
    if (action !== "hold") {
      const icon = action === "sell_now" ? "🔴" : "🟠";
      await logEvent("health", "trade", t.id, t.symbol,
        `${icon} Health check ${t.symbol}: ${action.replace(/_/g, " ").toUpperCase()}${health.suggested_stop ? ` (stop → ${health.suggested_stop})` : ""} — ${health.note}`);
    }
    verdicts.push({ trade_id: t.id, symbol: t.symbol, ...health });
  }
  return { checked: trades.length, verdicts };
}

module.exports = { checkPositions };
