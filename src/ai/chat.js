"use strict";
// The Advisor chat: a tool-calling conversation loop that gives the AI live access to
// EVERYTHING the tool knows — quotes, full indicator analysis, options chains, the
// recommendation log (with outcomes), your trades, performance stats, news, sentiment,
// smart-money activity, and your preferences. The model pulls exactly what each
// question needs instead of being stuffed with everything.
const db = require("../db");
const llm = require("./llm");
const settings = require("../settings");
const yahoo = require("../providers/yahoo");
const coingecko = require("../providers/coingecko");
const news = require("../providers/news");
const sentiment = require("../providers/sentiment");
const whales = require("../providers/whales");
const indicators = require("../indicators");
const scanner = require("../engine/scanner");
const { resolveAsset } = require("../resolve");

const { J, yahooSym } = require("../util");
const { logEvent } = require("../events");
const T = (name, description, params = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: params, required } },
});

// ---- Durable chat memory: short notes persisted in the settings KV table, injected
// into every conversation's system prompt and managed by the manage_memory tool. ----
const MEMORY_KEY = "advisor_memory";
async function loadNotes() {
  const row = await db.get("SELECT value FROM settings WHERE `key`=?", [MEMORY_KEY]).catch(() => null);
  const notes = row ? J(row.value, []) : [];
  return Array.isArray(notes) ? notes : [];
}
async function saveNotes(notes) {
  await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"),
    [MEMORY_KEY, JSON.stringify(notes), Date.now()]);
}

// ---- Tool-result packing: keep results under ~14k chars WITHOUT blunt mid-JSON cuts.
// Passes: (1) as-is if small; (2) structural shrink — drop the huge `inputs` snapshot,
// cap long arrays and strings; (3) last resort: an explicitly-marked partial prefix so
// the model knows it's looking at an excerpt, not malformed data. ----
const RESULT_LIMIT = 14000;
function shrink(v) {
  if (Array.isArray(v)) {
    return v.length > 20 ? [...v.slice(0, 20).map(shrink), `…(${v.length - 20} more items omitted)`] : v.map(shrink);
  }
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "inputs" && val && typeof val === "object")
        o[k] = "(large input snapshot omitted — ask about specific parts if needed)";
      else if (typeof val === "string" && val.length > 2000) o[k] = val.slice(0, 2000) + "…";
      else o[k] = shrink(val);
    }
    return o;
  }
  return v;
}
function packResult(result) {
  try {
    let s = JSON.stringify(result);
    if (s.length <= RESULT_LIMIT) return s;
    s = JSON.stringify(shrink(result));
    if (s.length <= RESULT_LIMIT) return s;
    return JSON.stringify({
      truncated: true,
      note: "Result too large even after summarizing — this is a partial JSON prefix. Ask a narrower question or request specific fields.",
      partial: s.slice(0, RESULT_LIMIT - 2000),
    });
  } catch (_) { return JSON.stringify({ error: "tool result could not be serialized" }); }
}

const TOOL_DEFS = [
  T("get_market_overview", "Current market snapshot: index-ETF (SPY/QQQ/DIA) + BTC/ETH quotes, stock & crypto Fear-and-Greed sentiment gauges, and top headlines."),
  T("get_quote", "Live quote for one STOCK or CRYPTO (price, day change, volume, market cap). Accepts any spelling: 'NVDA', 'BTC', 'bitcoin', 'BTC-USD', 'solana'. Pass asset_type when the ticker is ambiguous (e.g. LINK the coin vs LINK the stock).",
    { symbol: { type: "string", description: "Ticker or coin name, e.g. NVDA, BTC, bitcoin, SOL" },
      asset_type: { type: "string", enum: ["stock", "crypto"], description: "optional disambiguation hint" } }, ["symbol"]),
  T("get_analysis", "Full technical analysis of one STOCK or CRYPTO: latest values of every enabled indicator (RSI, MACD, SMA/EMA, Bollinger, Stochastic, ATR, ADX, OBV...), threshold signals per the user's own settings, momentum/volume stats. Accepts 'NVDA', 'BTC', 'bitcoin', 'ETH-USD'...",
    { symbol: { type: "string" }, days: { type: "number", description: "history window, default 365" },
      asset_type: { type: "string", enum: ["stock", "crypto"], description: "optional disambiguation hint" } }, ["symbol"]),
  T("get_options_chain", "Near-the-money options chain summary — STOCKS ONLY (spot crypto has no listed options here): strikes, bid/ask, volume, open interest, IV at the expiry nearest the user's max DTE.",
    { symbol: { type: "string" } }, ["symbol"]),
  T("list_recommendations", "The system's logged recommendations, newest first. status filter: open|tracking|target_hit|stopped|expired|closed (omit for all).",
    { status: { type: "string" }, limit: { type: "number", description: "default 15" } }),
  T("get_recommendation", "Full detail of one recommendation by id: levels, rationale, options play, outcome so far, and the input snapshot it was based on.",
    { id: { type: "number" } }, ["id"]),
  T("list_trades", "The user's trades. status: open|closed (omit for all). Open trades include live unrealized P&L.",
    { status: { type: "string" } }),
  T("get_performance", "The system's honest success-rate stats: win rate and average outcome of ALL finished recommendations (shadow-tracked whether taken or not), plus the user's own closed-trade P&L."),
  T("get_news", "Recent business/market headlines from the user's configured feeds (includes crypto press). Pass symbol (stock or crypto, any spelling) to filter to headlines mentioning it.",
    { symbol: { type: "string" }, asset_type: { type: "string", enum: ["stock", "crypto"] } }),
  T("get_smart_money", "Recent 'smart money' activity: congressional stock trades (if configured) and the latest institutional 13F filers."),
  T("get_crypto_universe", "Top cryptocurrencies by market cap with prices and 24h/7d change.",
    { top_n: { type: "number", description: "default 25" } }),
  T("get_preferences", "The user's investment preferences and indicator settings: asset classes, universes, risk tolerance, options comfort, buy/sell thresholds. Respect these in every suggestion."),
  T("start_market_scan", "Kick off a full market scan in the background (universe -> indicators -> AI recommendations). Returns immediately; results appear in the Recommendations tab in ~1-2 minutes."),
  T("save_recommendation", "SAVE a trade idea as a tracked recommendation — it appears in the Recommendations tab, is validated (entry sanity, stop side, ladder sums to 100, min reward:risk), logged, and shadow-tracked against real prices like any scan recommendation. Call this whenever the user asks you to create/log/track a trade idea. Returns the saved levels or the exact reason validation rejected it (so you can adjust and retry).",
    {
      symbol: { type: "string", description: "e.g. NVDA, XRP, bitcoin" },
      asset_type: { type: "string", enum: ["stock", "crypto"] },
      side: { type: "string", enum: ["buy", "sell"] },
      entry_low: { type: "number" }, entry_high: { type: "number" },
      stop_loss: { type: "number", description: "single price level (below entry for buys)" },
      targets: { type: "array", items: { type: "object", properties: { price: { type: "number" }, sell_pct: { type: "number" } }, required: ["price", "sell_pct"] }, description: "1-3 rungs, sell_pct summing to 100" },
      horizon_min_days: { type: "number" }, horizon_max_days: { type: "number" },
      confidence: { type: "number", description: "honest 0-1" },
      rationale: { type: "string" },
    },
    ["symbol", "side", "entry_low", "entry_high", "stop_loss", "targets", "confidence", "rationale"]),
  T("run_backtest", "Backtest the USER'S indicator buy-thresholds mechanically over ~1 year of daily candles — this tests their threshold settings, NOT the AI. exit_model 'ladder_trail' (default) mirrors how the live system manages trades. Returns portfolio metrics (win rate, expectancy, profit factor, max drawdown) plus an in-sample vs out-of-sample split. Takes several seconds per symbol.",
    { symbols: { type: "array", items: { type: "string" }, description: "up to 10 symbols; omit to use the user's stock universe (first 10)" },
      min_signals: { type: "number", description: "buy signals that must fire together, default 2" },
      exit_model: { type: "string", enum: ["ladder_trail", "bracket"] } }),
  T("check_position_health", "Run the REAL AI health-check engine on the user's open positions — verdicts hold / tighten_stop / take_partial / sell_now, stored on each trade (same engine as the UI's Health check button). Pass trade_id for one position, omit for all. Use for 'should I still be holding X?'.",
    { trade_id: { type: "number" } }),
  T("revalidate_recommendation", "Re-validate an open/tracking recommendation against CURRENT data using the real revalidation engine: verdict valid | adjust (levels updated in place) | withdraw (closed, unless the user has taken the trade). Use for 'is that idea still good?'.",
    { id: { type: "number" } }, ["id"]),
  T("get_portfolio_concentration", "Sector-concentration check across the user's OPEN positions: position counts per sector plus correlated-risk warnings."),
  T("get_fundamentals", "Valuation/quality snapshot for a STOCK: market cap, beta, P/E, P/S, P/B (TTM), gross/net margins, ROE, debt-to-equity, dividend yield — from the user's FMP key (24h-cached; degrades to a note without the key or on tier limits). Use it to temper technical calls; crypto has no fundamentals.",
    { symbol: { type: "string" } }, ["symbol"]),
  T("get_portfolio_risk", "The risk panel: total $ lost if EVERY stop hits (no-stop positions count their full value and are flagged; long options cap at premium), % of account, biggest single risk, and per-position risk rows. Use for 'how much am I risking?' / 'review my risk'."),
  T("compare_symbols", "Side-by-side technical comparison of 2-5 symbols on the user's own indicators: price, RSI, trend posture, ATR%, volatility percentile, relative strength vs SPY, and fired signals. Stocks and crypto both accepted, any spelling.",
    { symbols: { type: "array", items: { type: "string" }, description: "2-5 symbols" },
      asset_type: { type: "string", enum: ["stock", "crypto"], description: "optional hint applied to all" } }, ["symbols"]),
  T("manage_watchlist", "Manage the user's watchlist. action: 'list' | 'add' (symbol + optional note/alert_above/alert_below) | 'remove' (id or symbol) | 'set_alerts' (id or symbol + levels; re-arms fired alerts). Confirm with the user before removing entries.",
    { action: { type: "string", enum: ["list", "add", "remove", "set_alerts"] },
      symbol: { type: "string" }, id: { type: "number" }, note: { type: "string" },
      alert_above: { type: "number" }, alert_below: { type: "number" },
      asset_type: { type: "string", enum: ["stock", "crypto"] } }, ["action"]),
  T("update_trade", "Update the PLAN on an OPEN trade (stop_loss and/or targets ladder — ADVISORY; ALWAYS confirm the exact new levels with the user BEFORE calling; clears any pending stop suggestion), and/or append a JOURNAL note in the user's words (journal_note — works on open AND closed trades; the weekly review coaches from these). When the user reflects on a trade ('I sold too early', 'took this on the earnings dip'), offer to journal it.",
    { trade_id: { type: "number" }, stop_loss: { type: "number" },
      targets: { type: "array", items: { type: "object", properties: { price: { type: "number" }, sell_pct: { type: "number" } }, required: ["price", "sell_pct"] } },
      journal_note: { type: "string", description: "the user's reflection, in their words (lightly cleaned)" } },
    ["trade_id"]),
  T("get_economic_calendar", "Upcoming high-impact US macro events (FOMC, CPI, jobs report, GDP…) over the next N days (default 7) — binary-event risk beyond per-stock earnings dates. Requires the user's free FMP key; returns an explanatory note if unset.",
    { days: { type: "number", description: "1-30, default 7" } }),
  T("suggest_options_play", "Design ONE options play on a STOCK within the user's ALLOWED strategies, validated against the LIVE chain: real strikes, net premium from bid/ask mids, breakeven, max loss/gain, and the at-the-money IV. The plan is PREMIUM-denominated (entry zone / stop / targets are premium levels). Pass save:true ONLY when the user asked to track it — that persists it as a shadow-tracked recommendation.",
    { symbol: { type: "string" },
      view: { type: "string", enum: ["bullish", "bearish", "neutral_income"], description: "your directional read; neutral_income = premium selling; omit to let the analysis decide" },
      save: { type: "boolean", description: "persist as a tracked recommendation (default false)" } }, ["symbol"]),
  T("run_strategy", "Test the USER'S OWN trading strategy: describe it in plain English (it is compiled to a strict spec — ALWAYS show the returned spec to the user so they can confirm the translation) or pass the name of a saved strategy. Runs a full simulation (gap-aware fills, slippage, walk-forward split) and returns the metrics — then YOU write the critique: verdict grounded in expectancy/profit factor/drawdown/sample size, what works vs hurts (exit-reason mix, per-symbol spread, in-sample vs out-of-sample gap = curve-fit warning), and 1-2 concrete parameter changes to try. save_as persists the compiled spec under that name. Takes several seconds per symbol.",
    { description: { type: "string", description: "the strategy in plain English (or omit and use name)" },
      name: { type: "string", description: "a saved strategy's name to run" },
      symbols: { type: "array", items: { type: "string" }, description: "optional universe override, up to 10 symbols" },
      save_as: { type: "string", description: "save the compiled spec under this name" },
      live: { type: "boolean", description: "with save_as: also enable LIVE screening — entry signals on fresh bars raise alerts (~30 min cadence)" } }),
  T("get_prediction", "PROJECTION CONE for a stock or crypto at a horizon (1h 4h 1d 1w 1m 3m 6m 1y): statistically likely price range from realized volatility — quantile bands (p10/p25/p50/p75/p90) that WIDEN with time. This is a probability range, NOT a directional forecast: when you add your directional lean, state it WITH your confidence and always cite the band width honestly (e.g. 'the 90% range at 3 months spans X–Y; my lean is mildly higher because…'). Consider get_analysis + get_news for the qualitative side.",
    { symbol: { type: "string" }, horizon: { type: "string", enum: ["1h", "4h", "1d", "1w", "1m", "3m", "6m", "1y"], description: "default 1m" },
      asset_type: { type: "string", enum: ["stock", "crypto"] } }, ["symbol"]),
  T("get_politician_trades", "Congressional trading disclosures (Senate + House). Pass name to see one person's recent filings ('Pelosi' works — options plays show in the descriptions); omit for the latest feed + most-active list. HONEST LIMITS to state when relevant: disclosures lag 30-45 days by law, amounts are ranges not exact counts, and crypto is essentially absent (BTC-ETF tickers at best). Needs the user's free FMP key.",
    { name: { type: "string", description: "politician name or part of it" } }),
  T("get_insider_trades", "Company-insider (SEC Form 4) filings for one stock — CEO/founder/officer buys and sells with a buy/sell summary. May be unavailable on the user's FMP tier (returns a note, not an error).",
    { symbol: { type: "string" } }, ["symbol"]),
  T("manage_alerts", "The user's notification RULES ('tell me when…'), delivered via their existing channels. action 'list' | 'add' | 'remove'. Types + params: price_above/price_below {symbol, level}; pct_move_day {scope: symbol|watchlist|positions, symbol?, threshold}; rec_entry_zone {}; earnings_upcoming {days}; macro_event_soon {days}; figure_filing {name}; portfolio_drawdown {threshold_pct}; provider_degraded {}; headline_mention {scope: symbol|positions|watchlist, symbol?} (news mentioning held/watched symbols). Optional: cooldown_min (default 240), delivery 'instant'|'digest' (digest = folded into the daily briefing instead of buzzing). 'Ping me if BTC breaks 70k' → add price_above {symbol:'BTC-USD', level:70000}. Confirm before removing.",
    { action: { type: "string", enum: ["list", "add", "remove"] },
      rule: { type: "object", description: "for add: {type, params, cooldown_min?, delivery?}" },
      id: { type: "string", description: "for remove" } }, ["action"]),
  T("manage_memory", "Durable memory across conversations. action 'add' saves a short note (stable user preferences, goals, standing context — e.g. 'prefers 3-6 month holds', 'wants out of airlines'); 'remove' deletes by id; 'list' shows all. Your current notes are already in the system prompt. Save sparingly — only stable, genuinely useful facts.",
    { action: { type: "string", enum: ["add", "remove", "list"] }, note: { type: "string" }, id: { type: "string" } }, ["action"]),
];

async function execTool(name, args = {}) {
  const s = settings.getSync();
  switch (name) {
    case "get_market_overview": {
      const [quotes, senti, heads] = await Promise.all([
        yahoo.quotes(["SPY", "QQQ", "DIA", "BTC-USD", "ETH-USD"]).catch(() => ({})),
        sentiment.snapshot().catch(() => ({})),
        news.headlines(24, 12).catch(() => []),
      ]);
      return { quotes, sentiment: senti, top_headlines: heads.map((h) => h.title) };
    }
    case "get_quote": {
      const a = await resolveAsset(args.symbol, args.asset_type);
      if (!a) return { error: "symbol required" };
      const q = await yahoo.quote(a.yahoo);
      return { ...q, resolved: { asked: args.symbol, symbol: a.display, name: a.name, asset_type: a.asset_type } };
    }
    case "get_analysis": {
      const a = await resolveAsset(args.symbol, args.asset_type);
      if (!a) return { error: "symbol required" };
      const candles = await yahoo.history(a.yahoo, Math.min(730, args.days || 365));
      if (!candles || candles.length < 30) return { error: "not enough price history for " + a.yahoo };
      const { latest } = indicators.computeAllCached(`an:${a.yahoo}:${args.days || 365}`, candles, s.indicators);
      const next_earnings = a.asset_type === "stock" ? await yahoo.nextEarnings(a.yahoo).catch(() => null) : null;
      return { symbol: a.display, name: a.name, asset_type: a.asset_type, candles_analyzed: candles.length, next_earnings, ...latest };
    }
    case "get_options_chain": {
      const a = await resolveAsset(args.symbol, "stock");
      if (!a) return { error: "symbol required" };
      const asCrypto = await resolveAsset(args.symbol);
      if (asCrypto && asCrypto.asset_type === "crypto") return { error: "options chains are stock-only — " + asCrypto.display + " is crypto (no listed options here)" };
      return (await yahoo.optionsChain(a.yahoo, s.preferences.options.max_dte)) || { error: "no options chain available" };
    }
    case "list_recommendations": {
      // LIMIT inlined (clamped int): a bound `LIMIT ?` breaks mysql2's execute().
      const lim = Math.min(50, Math.max(1, Number(args.limit) || 15));
      const rows = args.status
        ? await db.all(`SELECT * FROM recommendations WHERE status=? ORDER BY id DESC LIMIT ${lim}`, [args.status])
        : await db.all(`SELECT * FROM recommendations ORDER BY id DESC LIMIT ${lim}`);
      return rows.map((r) => ({
        id: r.id, created: new Date(Number(r.created_at)).toISOString().slice(0, 10),
        symbol: r.symbol, asset_type: r.asset_type, side: r.side, status: r.status, taken: !!r.taken,
        price_at_rec: r.current_price, entry: [r.entry_low, r.entry_high], stop: r.stop_loss,
        targets: J(r.targets, []), confidence: r.confidence,
        outcome_pnl_pct: (J(r.outcome, {}) || {}).pnl_pct ?? null,
      }));
    }
    case "get_recommendation": {
      const r = await db.get("SELECT * FROM recommendations WHERE id=?", [args.id]);
      if (!r) return { error: "recommendation not found" };
      return { ...r, targets: J(r.targets, []), options_play: J(r.options_play, null), outcome: J(r.outcome, null), inputs: J(r.inputs, null) };
    }
    case "list_trades": {
      const rows = args.status
        ? await db.all("SELECT * FROM trades WHERE status=? ORDER BY id DESC LIMIT 50", [args.status])
        : await db.all("SELECT * FROM trades ORDER BY id DESC LIMIT 50");
      const out = rows.map((t) => ({ ...t, targets: J(t.targets, []), exits: (J(t.exits, []) || []).filter((e) => !e.alert), option_details: J(t.option_details, null) }));
      // Quote-based P&L applies to shares/coins only: an OPTION trade's entry_price is
      // the premium per share — comparing it to the UNDERLYING's quote produced absurd
      // percentages. Options are premium-priced in the Trades tab / health checks.
      const open = out.filter((t) => t.status === "open" && t.asset_type !== "option");
      if (open.length) {
        const quotes = await yahoo.quotes([...new Set(open.map(yahooSym))]).catch(() => ({}));
        for (const t of open) {
          const q = quotes[yahooSym(t)];
          if (q && q.price != null) {
            t.last_price = q.price;
            const dir = t.side === "sell" ? -1 : 1;
            t.unrealized_pnl_pct = +(((q.price - t.entry_price) / t.entry_price) * 100 * dir).toFixed(2);
          }
        }
      }
      for (const t of out) {
        if (t.status === "open" && t.asset_type === "option") {
          t.note = "option position — entry_price is the premium/share; live premium P&L is chain-priced in the Trades tab (use check_position_health for a verdict)";
          if (t.option_details && t.option_details.expiry) t.days_to_expiry = Math.round((Date.parse(t.option_details.expiry) - Date.now()) / 86400000);
        }
      }
      return out;
    }
    case "get_performance": {
      const recs = await db.all("SELECT status, outcome, taken, asset_type FROM recommendations");
      const fin = recs.map((r) => ({ ...r, o: J(r.outcome, {}) || {} }))
        .filter((r) => (["stopped", "target_hit"].includes(r.status) || (r.status === "closed" && r.o.result === "expired_settled")) && r.o.pnl_pct != null);
      const wins = fin.filter((r) => r.o.pnl_pct > 0);
      const trades = await db.all("SELECT pnl, pnl_pct FROM trades WHERE status='closed'");
      return {
        recommendations: {
          total: recs.length, finished: fin.length, wins: wins.length,
          win_rate_pct: fin.length ? +((wins.length / fin.length) * 100).toFixed(1) : null,
          avg_outcome_pct: fin.length ? +(fin.reduce((a, r) => a + r.o.pnl_pct, 0) / fin.length).toFixed(2) : null,
        },
        user_trades: {
          closed: trades.length,
          total_pnl: +trades.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2),
          win_rate_pct: trades.length ? +((trades.filter((t) => (t.pnl || 0) > 0).length / trades.length) * 100).toFixed(1) : null,
        },
      };
    }
    case "get_news": {
      const heads = await news.headlines(48, 60);
      if (args.symbol) {
        const a = await resolveAsset(args.symbol, args.asset_type);
        if (!a) return { error: "symbol required" };
        // Match on both the ticker and the full name (matters for crypto: "BTC" + "Bitcoin").
        return news.matching(heads, a.display, a.name).map((h) => ({ title: h.title, source: h.source }));
      }
      return heads.slice(0, 20).map((h) => ({ title: h.title, source: h.source }));
    }
    case "get_smart_money": return await whales.snapshot();
    case "get_crypto_universe": return await coingecko.topCoins(Math.min(100, args.top_n || 25));
    case "get_preferences": return { preferences: s.preferences, indicators: s.indicators };
    case "start_market_scan": {
      if (scanner.status().running) return { started: false, note: "a scan is already running" };
      scanner.runScan("manual").catch(() => {});
      return { started: true, note: "Scan launched in the background — results land in the Recommendations tab in a minute or two." };
    }
    case "save_recommendation": {
      const { validateRec, duplicateOf } = require("../engine/recommender");
      const { logEvent } = require("../events");
      const a = await resolveAsset(args.symbol, args.asset_type);
      if (!a) return { error: "symbol required" };
      const q = await yahoo.quote(a.yahoo).catch(() => null);
      if (!q || q.price == null) return { error: `no live price available for ${a.yahoo} — cannot validate the idea right now` };
      // Same gauntlet as scan recommendations: sanity vs real price, stop side, ladder
      // renormalized, confidence + reward:risk gates.
      const candidateMap = { [a.display.toUpperCase()]: { symbol: a.display, asset_type: a.asset_type, name: a.name, price: q.price } };
      const rec = validateRec({ ...args, symbol: a.display, options_play: null }, candidateMap, s.preferences);
      if (!rec) {
        const mid = (Number(args.entry_low) + Number(args.entry_high)) / 2;
        const risk = Math.abs(mid - Number(args.stop_loss));
        const reward = (args.targets || []).reduce((s2, t) => s2 + ((t.sell_pct || 0) / 100) * Math.abs(t.price - mid), 0);
        return { error: "validation rejected the idea", details: {
          current_price: q.price,
          checks: `entry must be within ±25% of ${q.price}; stop on the correct side; ≥1 target beyond entry; confidence ≥ ${s.preferences.risk.min_confidence}; reward:risk ≥ ${s.preferences.risk.min_risk_reward} (yours ≈ ${risk > 0 ? (reward / risk).toFixed(2) : "n/a"})`,
        } };
      }
      const dup = await duplicateOf(rec);
      if (dup) return { error: `there is already an active recommendation for ${rec.symbol} with similar ${rec.side} levels (id ${dup.id}, entry ${dup.entry_low}-${dup.entry_high}) — a new idea must be materially different (opposite side, or a non-overlapping entry zone ≥5% away). Tell the user, or adjust the levels if genuinely intended.` };
      const expiryMs = (s.schedule.rec_expiry_days || 10) * 86400000;
      const res = await db.run(
        `INSERT INTO recommendations
         (run_id, created_at, asset_type, symbol, name, side, current_price, entry_low, entry_high,
          stop_loss, targets, horizon_min_days, horizon_max_days, confidence, risk_reward, rationale,
          options_play, inputs, status, expires_at)
         VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
        [Date.now(), rec.asset_type, rec.symbol, rec.name, rec.side, rec.current_price, rec.entry_low, rec.entry_high,
         rec.stop_loss, JSON.stringify(rec.targets), rec.horizon_min_days, rec.horizon_max_days, rec.confidence,
         rec.risk_reward, rec.rationale, JSON.stringify({ source: "advisor_chat", saved_at: new Date().toISOString() }),
         "open", Date.now() + expiryMs]);
      await logEvent("rec_new", "recommendation", res.lastID, rec.symbol,
        `💬 Chat idea saved: ${rec.side.toUpperCase()} ${rec.symbol} @ ${rec.entry_low}-${rec.entry_high} (R:R ${rec.risk_reward}, conf ${Math.round(rec.confidence * 100)}%)`);
      return { saved: true, id: res.lastID, note: "Now visible in the Recommendations tab and shadow-tracked like any scan idea.", levels: rec };
    }
    case "run_backtest": {
      const syms = Array.isArray(args.symbols) && args.symbols.length ? args.symbols.slice(0, 10).map(String) : null;
      const r = await require("../engine/backtest").run(syms || (require("../engine/scanner").POPULAR_STOCKS.slice(0, 10)),
        { min_signals: Number(args.min_signals) || 2, exit_model: args.exit_model === "bracket" ? "bracket" : "ladder_trail" });
      for (const b of r.by_symbol || []) delete b.last_trades;   // keep the tool result lean
      return r;
    }
    case "check_position_health": return await require("../engine/health").checkPositions(args.trade_id || null);
    case "revalidate_recommendation": return await require("../engine/recommender").revalidate(Number(args.id));
    case "get_portfolio_concentration": return await require("../engine/portfolio").concentration();
    case "get_portfolio_risk": return await require("../engine/portfolio").riskPanel();
    case "get_fundamentals": {
      const a = await resolveAsset(args.symbol, "stock");
      if (!a) return { error: "symbol required" };
      return await require("../providers/fundamentals").fundamentals(a.display);
    }
    case "compare_symbols": {
      const list = (Array.isArray(args.symbols) ? args.symbols : []).slice(0, 5);
      if (list.length < 2) return { error: "give 2-5 symbols to compare" };
      const bench = await yahoo.history("SPY", 365).then((c) => c.map((b) => b.close)).catch(() => null);
      const out = [];
      for (const sym of list) {
        try {
          const a = await resolveAsset(sym, args.asset_type);
          const candles = await yahoo.history(a.yahoo, 365);
          const { latest } = indicators.computeAllCached(`cmp:${a.yahoo}`, candles, s.indicators, bench ? { benchCloses: bench } : {});
          out.push({ symbol: a.display, name: a.name, asset_type: a.asset_type, ...latest });
        } catch (e) { out.push({ symbol: sym, error: e.message }); }
      }
      return out;
    }
    case "manage_watchlist": {
      const up = (v) => String(v || "").toUpperCase().trim();
      const find = async () => args.id
        ? db.get("SELECT * FROM watchlist WHERE id=?", [args.id])
        : db.get("SELECT * FROM watchlist WHERE symbol=? OR yahoo_symbol=?", [up(args.symbol), up(args.symbol)]);
      switch (args.action) {
        case "list": return await db.all("SELECT id, symbol, asset_type, name, note, alert_above, alert_below FROM watchlist ORDER BY id DESC");
        case "add": {
          if (!args.symbol) return { error: "symbol required" };
          const a = await resolveAsset(args.symbol, args.asset_type);
          const r = await db.run(
            "INSERT INTO watchlist (created_at, symbol, yahoo_symbol, asset_type, name, note, alert_above, alert_below) VALUES (?,?,?,?,?,?,?,?)",
            [Date.now(), a.display, a.yahoo, a.asset_type === "index" ? "stock" : a.asset_type, a.name, args.note || null,
             args.alert_above ? Number(args.alert_above) : null, args.alert_below ? Number(args.alert_below) : null]);
          return { ok: true, id: r.lastID, added: a.display, note: "On the watchlist — it now joins every scan with a priority boost." };
        }
        case "remove": {
          const row = await find();
          if (!row) return { error: "watchlist entry not found" };
          await db.run("DELETE FROM watchlist WHERE id=?", [row.id]);
          return { ok: true, removed: row.symbol };
        }
        case "set_alerts": {
          const row = await find();
          if (!row) return { error: "watchlist entry not found" };
          await db.run("UPDATE watchlist SET alert_above=?, alert_below=?, alerts_fired=NULL WHERE id=?",
            [args.alert_above != null ? Number(args.alert_above) : null, args.alert_below != null ? Number(args.alert_below) : null, row.id]);
          return { ok: true, symbol: row.symbol, alert_above: args.alert_above ?? null, alert_below: args.alert_below ?? null, note: "alerts re-armed" };
        }
        default: return { error: "unknown watchlist action" };
      }
    }
    case "update_trade": {
      const t = await db.get("SELECT * FROM trades WHERE id=?", [args.trade_id]);
      if (!t) return { error: "trade not found (id " + args.trade_id + ")" };
      const out = { ok: true, symbol: t.symbol };
      if (args.journal_note && String(args.journal_note).trim()) {
        const journal = (J(t.journal, []) || []);
        journal.push({ at: Date.now(), note: String(args.journal_note).trim().slice(0, 1000) });
        await db.run("UPDATE trades SET journal=? WHERE id=?", [JSON.stringify(journal.slice(-50)), t.id]);
        out.journaled = true;
      }
      if (args.stop_loss != null || Array.isArray(args.targets)) {
        if (t.status !== "open") return { ...out, error: "plan changes need an OPEN trade — only the journal note was saved" };
        const stop = args.stop_loss != null ? Number(args.stop_loss) : t.stop_loss;
        const targets = Array.isArray(args.targets) ? JSON.stringify(args.targets) : t.targets;
        await db.run("UPDATE trades SET stop_loss=?, targets=?, suggested_stop=NULL WHERE id=?", [stop, targets, t.id]);
        if (args.stop_loss != null && args.stop_loss !== t.stop_loss)
          await logEvent("stop_moved", "trade", t.id, t.symbol, `Stop moved (via chat): ${t.symbol} ${t.stop_loss ?? "—"} → ${stop}`);
        out.stop_loss = stop; out.targets = J(targets, []);
        out.note = "Plan updated here — remind the user to mirror it at their broker.";
      }
      return out;
    }
    case "suggest_options_play": {
      if (!s.preferences.options.enabled) return { error: "options trading is disabled — the user can enable it in Settings → Options trading" };
      const a = await resolveAsset(args.symbol, "stock");
      if (!a) return { error: "symbol required" };
      const asCrypto = await resolveAsset(args.symbol);
      if (asCrypto && asCrypto.asset_type === "crypto") return { error: asCrypto.display + " is crypto — options plays are stock-only here" };
      const [q, chain, candles] = await Promise.all([
        yahoo.quote(a.yahoo).catch(() => null),
        yahoo.optionsChain(a.yahoo, s.preferences.options.max_dte).catch(() => null),
        yahoo.history(a.yahoo, 365).catch(() => null),
      ]);
      if (!chain || !((chain.calls || []).length || (chain.puts || []).length)) return { error: "no live options chain available for " + a.yahoo };
      const latest = candles && candles.length >= 30 ? indicators.computeAllCached(`an:${a.yahoo}`, candles, s.indicators).latest : { price: chain.spot };
      const optionsEngine = require("../engine/options");
      const cand = { symbol: a.display, asset_type: "stock", name: a.name, price: (q && q.price) ?? chain.spot, indicators: latest, headlines: [], options_chain: chain };
      const { recs } = await optionsEngine.recommendOptions(
        { market: { as_of: new Date().toISOString(), sentiment: {}, top_headlines: [] }, candidates: [cand] },
        () => {}, { viewHint: args.view });
      if (!recs.length) return { error: "no play cleared validation for " + a.display + " — strikes may lack a market, or reward:risk fell short of the user's minimum. Try a different view, or explain why to the user." };
      const play = recs[0];
      if (args.save) {
        const dup = await require("../engine/recommender").duplicateOf(play);
        if (dup) return { error: `already tracking a similar play (recommendation ${dup.id})`, play };
        const id = await optionsEngine.saveOptionRec(play, { inputs: { source: "advisor_chat", candidate: cand, saved_at: new Date().toISOString() } });
        await logEvent("rec_new", "recommendation", id, play.symbol,
          `💬 Options idea saved: ${play.options_play.strategy.replace(/_/g, " ")} ${play.symbol} ${play.options_play.strikes.join("/")} exp ${play.options_play.expiry} @ ~${play.current_price} premium`);
        return { saved: true, id, play, note: "Now in the Recommendations tab, shadow-tracked on its live premium; it settles at intrinsic value if it reaches expiry." };
      }
      return { play, note: "NOT saved. If the user wants it tracked, call again with save:true." };
    }
    case "run_strategy": {
      const lab = require("../engine/strategylab");
      let spec;
      if (args.name) {
        const saved = (await lab.listStrategies()).find((x) => x.name === String(args.name));
        if (!saved) return { error: `no saved strategy named "${args.name}" — saved: ${(await lab.listStrategies()).map((x) => x.name).join(", ") || "(none)"}` };
        spec = saved;
      } else if (args.description) {
        const compiled = await lab.compileStrategy(String(args.description));
        spec = compiled.spec;
        spec._compile_notes = compiled.notes;
      } else return { error: "give either a plain-English description or a saved strategy name" };
      if (Array.isArray(args.symbols) && args.symbols.length) spec.universe = args.symbols.slice(0, 10).map(String);
      else if (spec.universe === "stocks") spec.universe = "stocks";   // runner caps at 25; chat stays snappy via override
      const notes = spec._compile_notes; delete spec._compile_notes;
      const results = await lab.runStrategy(spec);
      if (args.save_as) {
        await lab.saveStrategy({ ...results.spec, name: String(args.save_as).slice(0, 60), live: args.live === true });
        results.saved_as = String(args.save_as).slice(0, 60);
        if (args.live) results.live_note = "Live screening enabled — fresh entry signals will alert (~30 min cadence).";
      }
      if (notes) results.compile_notes = notes;
      // strip per-trade detail to keep the tool result lean; the model critiques from the aggregates
      for (const b of results.by_symbol || []) delete b.last_trades;
      return results;
    }
    case "get_prediction": {
      const a = await resolveAsset(args.symbol, args.asset_type);
      if (!a) return { error: "symbol required" };
      const cone = await require("../engine/predict").projectionCone(a.yahoo, String(args.horizon || "1m"));
      // The full band series is chart material; the model needs the endpoints + params.
      return { symbol: a.display, asset_type: a.asset_type, horizon: cone.horizon, price: cone.price,
        at_horizon: cone.at_horizon, band_width_pct: cone.band_width_pct, params: cone.params, note: cone.note };
    }
    case "get_politician_trades": {
      const whales2 = require("../providers/whales");
      if (args.name) {
        const trades = await whales2.politicianTrades(args.name);
        return trades.length ? { name: args.name, trades: trades.slice(0, 25), lag_note: "disclosures lag 30-45 days; amounts are ranges" }
          : { note: `no recent filings matching "${args.name}" in the current window — try get_politician_trades with no name to see who's active (needs the FMP key)` };
      }
      const [people, feed] = await Promise.all([whales2.politicians(), whales2.congressFeed()]);
      if (!people.length) return { note: "congressional data needs the user's free FMP key — Settings → Data feeds" };
      return { most_active: people.slice(0, 15), latest: feed.slice(0, 20), lag_note: "disclosures lag 30-45 days; amounts are ranges; crypto essentially absent" };
    }
    case "get_insider_trades": return await require("../providers/whales").insiderTrades(args.symbol);
    case "manage_alerts": {
      const alerts = require("../engine/alerts");
      const rules = await alerts.listRules();
      switch (args.action) {
        case "list": return rules.map((r) => ({ id: r.id, label: alerts.label(r), type: r.type, params: r.params, enabled: r.enabled, delivery: r.delivery, cooldown_min: r.cooldown_min }));
        case "add": {
          const v = alerts.validateRule(args.rule || {});
          // ids embed a timestamp — duplicates must be detected by type+params
          if (rules.some((r) => r.type === v.type && JSON.stringify(r.params) === JSON.stringify(v.params)))
            return { error: "an identical rule already exists: " + alerts.label(v) };
          rules.push(v);
          await alerts.saveRules(rules);
          return { ok: true, added: alerts.label(v), id: v.id, note: "Evaluated every ~5 minutes; fires through the feed, browser, and webhook (per the user's gates)." };
        }
        case "remove": {
          const i = rules.findIndex((r) => r.id === String(args.id));
          if (i < 0) return { error: "no rule with id " + args.id + " — use action:list first" };
          const [gone] = rules.splice(i, 1);
          await alerts.saveRules(rules);
          return { ok: true, removed: alerts.label(gone) };
        }
        default: return { error: "unknown alerts action" };
      }
    }
    case "get_economic_calendar": return await require("../providers/calendar").economicCalendar(args.days || 7);
    case "manage_memory": {
      const notes = await loadNotes();
      switch (args.action) {
        case "list": return notes;
        case "add": {
          const note = String(args.note || "").trim().slice(0, 300);
          if (!note) return { error: "note required" };
          notes.push({ id: Date.now().toString(36), at: new Date().toISOString().slice(0, 10), note });
          while (notes.length > 40) notes.shift();
          await saveNotes(notes);
          return { ok: true, saved: note, count: notes.length };
        }
        case "remove": {
          const i = notes.findIndex((n) => n.id === String(args.id));
          if (i < 0) return { error: "no note with id " + args.id };
          const [gone] = notes.splice(i, 1);
          await saveNotes(notes);
          return { ok: true, removed: gone.note };
        }
        default: return { error: "unknown memory action" };
      }
    }
    default: return { error: "unknown tool: " + name };
  }
}

async function systemPrompt() {
  const s = settings.getSync();
  const notes = await loadNotes().catch(() => []);
  const memBlock = notes.length
    ? `\n\nDURABLE MEMORY — notes you saved in past conversations (honor them; manage with manage_memory):\n${notes.map((n) => `- [${n.id}] (${n.at}) ${n.note}`).join("\n")}`
    : "";
  return `You are the analyst behind this Investment Advisor tool — a sharp, honest trading assistant with LIVE tool access to everything the tool knows: quotes, technical analysis with the user's own indicator thresholds, options chains, the full recommendation log with tracked outcomes, the user's trades and P&L, news, sentiment gauges, and smart-money data.

HOW TO WORK:
- USE YOUR TOOLS. Never guess a price, indicator value, or portfolio fact — fetch it. For "what do you think of X?" call get_analysis (and usually get_news + get_quote) first; for stocks add get_fundamentals so valuation tempers the technical read. For "X vs Y" use compare_symbols.
- STOCKS AND CRYPTO are both first-class. get_quote/get_analysis/get_news accept either ("NVDA", "BTC", "bitcoin", "SOL"...) — pass asset_type to disambiguate colliding tickers. Options are stock-only; smart-money (congress/13F) is stock-only; get_crypto_universe lists the top coins.
- Respect the user's preferences (get_preferences) — asset classes, risk tolerance (currently: ${s.preferences.risk.risk_tolerance}), options comfort${s.preferences.risk.allow_shorts === false ? ", and the user does NOT short — long ideas only (save_recommendation will reject side:'sell')" : ""}. Don't suggest what they've excluded.
- REAL ENGINES over ad-hoc opinion: "should I still hold X?" → check_position_health; "is that idea still good?" → revalidate_recommendation; "do my thresholds actually work?" → run_backtest; "am I too concentrated?" → get_portfolio_concentration; "anything big this week?" → get_economic_calendar; "what's a good options play on X?" → suggest_options_play (chain-validated, premium-denominated${s.preferences.options.enabled ? "" : " — currently DISABLED in the user's preferences"}); "test MY strategy: …" → run_strategy (show the compiled spec back, then critique the results yourself); "where will X be in 3 months?" → get_prediction (a probability cone — give your lean WITH confidence, never as certainty); "what did Pelosi buy?" → get_politician_trades; "are insiders buying X?" → get_insider_trades; "ping me when/if …" → manage_alerts (a real rule, evaluated every ~5 min).
- When you recommend a trade idea, give the full structure: entry zone, stop loss, laddered targets with sell percentages, rough time horizon, and WHY — grounded in the data you fetched.
- When the user asks you to CREATE/LOG/TRACK a trade idea, you MUST call save_recommendation — that is the ONLY way an idea reaches the Recommendations tab and gets tracked. NEVER claim an idea is saved or "being tracked" unless the tool returned saved:true. If validation rejects it, fix the levels (usually the reward:risk ratio) and try once more, or tell the user why it can't stand.
- WRITE ACTIONS need consent: confirm with the user before manage_watchlist remove and ALWAYS before update_trade (state the exact new levels first). Never claim a write happened unless the tool returned ok:true.
- MEMORY: when the user states a stable preference, goal, or standing view worth keeping ("I prefer 3-6 month holds", "don't pitch me airlines"), save it with manage_memory (briefly note that you did). Don't save transient chatter.
- Be honest about uncertainty and about the system's own track record (get_performance). If the data is mixed, say so.
- Keep answers tight: short paragraphs, bullet lists, bold key numbers. You're in a chat panel, not writing a report.
- You may check the recommendation log to explain or critique past calls.
- Reminder to weave in when giving actionable ideas: this is research, not financial advice — the user decides.

Today is ${new Date().toDateString()}.${memBlock}`;
}

// One conversational turn with a tool loop. messages = [{role:'user'|'assistant', content}]
// Returns { reply, trace: [{tool, args}] } — trace lets the UI show what was consulted.
async function converse(messages, opts = {}) {
  const convo = [{ role: "system", content: await systemPrompt() }, ...messages.slice(-16)];
  const trace = [];
  for (let i = 0; i < 6; i++) {
    const r = await llm.chat(convo, { tools: TOOL_DEFS, timeout_ms: opts.timeout_ms || 300000 });
    if (r.tool_calls && r.tool_calls.length) {
      convo.push({ role: "assistant", content: r.content || "", tool_calls: r.tool_calls });
      for (const tc of r.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        trace.push({ tool: tc.function.name, args });
        let result;
        try { result = await execTool(tc.function.name, args); }
        catch (e) { result = { error: e.message }; }
        convo.push({ role: "tool", tool_call_id: tc.id, content: packResult(result) });
      }
      continue;
    }
    return { reply: r.content || "(no reply)", trace };
  }
  return { reply: "(stopped after the maximum number of tool steps — try a narrower question)", trace };
}

// Streaming variant: emit(event) receives, in order:
//   {type:'tools', tools:[{tool,args}]}   — a tool round is starting (UI shows chips)
//   {type:'token', text}                  — content tokens as they stream
//   {type:'done', reply, trace}           — final assembled state
// Each round streams; if the round turns out to be a tool call, the UI gets a 'reset'
// so any partial pre-tool prose doesn't linger.
async function converseStream(messages, emit, opts = {}) {
  const convo = [{ role: "system", content: await systemPrompt() }, ...messages.slice(-16)];
  const trace = [];
  for (let i = 0; i < 6; i++) {
    let streamed = "";
    const r = await llm.chatStream(convo, { tools: TOOL_DEFS, timeout_ms: opts.timeout_ms || 300000 },
      (tok) => { streamed += tok; emit({ type: "token", text: tok }); });
    if (r.tool_calls && r.tool_calls.length) {
      if (streamed) emit({ type: "reset" });   // discard pre-tool prose
      convo.push({ role: "assistant", content: r.content || "", tool_calls: r.tool_calls });
      const round = [];
      for (const tc of r.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        round.push({ tool: tc.function.name, args });
        trace.push({ tool: tc.function.name, args });
      }
      emit({ type: "tools", tools: round });
      for (const tc of r.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        let result;
        try { result = await execTool(tc.function.name, args); }
        catch (e) { result = { error: e.message }; }
        convo.push({ role: "tool", tool_call_id: tc.id, content: packResult(result) });
      }
      continue;
    }
    emit({ type: "done", reply: r.content || "(no reply)", trace });
    return;
  }
  emit({ type: "done", reply: "(stopped after the maximum number of tool steps — try a narrower question)", trace });
}

module.exports = { converse, converseStream, TOOL_DEFS, packResult };
