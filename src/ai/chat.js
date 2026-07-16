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

const J = (s, fb) => { try { return JSON.parse(s); } catch (_) { return fb; } };
const T = (name, description, params = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: params, required } },
});

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
      const { latest } = indicators.computeAll(candles, s.indicators);
      const next_earnings = a.asset_type === "stock" ? await yahoo.nextEarnings(a.yahoo).catch(() => null) : null;
      return { symbol: a.display, name: a.name, asset_type: a.asset_type, candles_analyzed: candles.length, next_earnings, ...latest };
    }
    case "get_options_chain": {
      const a = await resolveAsset(args.symbol, "stock");
      const asCrypto = await resolveAsset(args.symbol);
      if (asCrypto && asCrypto.asset_type === "crypto") return { error: "options chains are stock-only — " + asCrypto.display + " is crypto (no listed options here)" };
      return (await yahoo.optionsChain(a.yahoo, s.preferences.options.max_dte)) || { error: "no options chain available" };
    }
    case "list_recommendations": {
      const lim = Math.min(50, args.limit || 15);
      const rows = args.status
        ? await db.all("SELECT * FROM recommendations WHERE status=? ORDER BY id DESC LIMIT ?", [args.status, lim])
        : await db.all("SELECT * FROM recommendations ORDER BY id DESC LIMIT ?", [lim]);
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
      const out = rows.map((t) => ({ ...t, targets: J(t.targets, []), exits: (J(t.exits, []) || []).filter((e) => !e.alert) }));
      const open = out.filter((t) => t.status === "open");
      if (open.length) {
        const quotes = await yahoo.quotes([...new Set(open.map((t) => t.asset_type === "crypto" && !t.symbol.includes("-") ? `${t.symbol}-USD` : t.symbol))]).catch(() => ({}));
        for (const t of open) {
          const q = quotes[t.asset_type === "crypto" && !t.symbol.includes("-") ? `${t.symbol}-USD` : t.symbol];
          if (q && q.price != null) {
            t.last_price = q.price;
            const dir = t.side === "sell" ? -1 : 1;
            t.unrealized_pnl_pct = +(((q.price - t.entry_price) / t.entry_price) * 100 * dir).toFixed(2);
          }
        }
      }
      return out;
    }
    case "get_performance": {
      const recs = await db.all("SELECT status, outcome, taken, asset_type FROM recommendations");
      const fin = recs.map((r) => ({ ...r, o: J(r.outcome, {}) || {} })).filter((r) => ["stopped", "target_hit"].includes(r.status) && r.o.pnl_pct != null);
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
    default: return { error: "unknown tool: " + name };
  }
}

function systemPrompt() {
  const s = settings.getSync();
  return `You are the analyst behind this Investment Advisor tool — a sharp, honest trading assistant with LIVE tool access to everything the tool knows: quotes, technical analysis with the user's own indicator thresholds, options chains, the full recommendation log with tracked outcomes, the user's trades and P&L, news, sentiment gauges, and smart-money data.

HOW TO WORK:
- USE YOUR TOOLS. Never guess a price, indicator value, or portfolio fact — fetch it. For "what do you think of X?" call get_analysis (and usually get_news + get_quote) first.
- STOCKS AND CRYPTO are both first-class. get_quote/get_analysis/get_news accept either ("NVDA", "BTC", "bitcoin", "SOL"...) — pass asset_type to disambiguate colliding tickers. Options are stock-only; smart-money (congress/13F) is stock-only; get_crypto_universe lists the top coins.
- Respect the user's preferences (get_preferences) — asset classes, risk tolerance (currently: ${s.preferences.risk.risk_tolerance}), options comfort${s.preferences.risk.allow_shorts === false ? ", and the user does NOT short — long ideas only (save_recommendation will reject side:'sell')" : ""}. Don't suggest what they've excluded.
- When you recommend a trade idea, give the full structure: entry zone, stop loss, laddered targets with sell percentages, rough time horizon, and WHY — grounded in the data you fetched.
- When the user asks you to CREATE/LOG/TRACK a trade idea, you MUST call save_recommendation — that is the ONLY way an idea reaches the Recommendations tab and gets tracked. NEVER claim an idea is saved or "being tracked" unless the tool returned saved:true. If validation rejects it, fix the levels (usually the reward:risk ratio) and try once more, or tell the user why it can't stand.
- Be honest about uncertainty and about the system's own track record (get_performance). If the data is mixed, say so.
- Keep answers tight: short paragraphs, bullet lists, bold key numbers. You're in a chat panel, not writing a report.
- You may check the recommendation log to explain or critique past calls.
- Reminder to weave in when giving actionable ideas: this is research, not financial advice — the user decides.

Today is ${new Date().toDateString()}.`;
}

// One conversational turn with a tool loop. messages = [{role:'user'|'assistant', content}]
// Returns { reply, trace: [{tool, args}] } — trace lets the UI show what was consulted.
async function converse(messages, opts = {}) {
  const convo = [{ role: "system", content: systemPrompt() }, ...messages.slice(-16)];
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
        const clipped = JSON.stringify(result);
        convo.push({ role: "tool", tool_call_id: tc.id, content: clipped.length > 14000 ? clipped.slice(0, 14000) + "…[truncated]" : clipped });
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
  const convo = [{ role: "system", content: systemPrompt() }, ...messages.slice(-16)];
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
        const clipped = JSON.stringify(result);
        convo.push({ role: "tool", tool_call_id: tc.id, content: clipped.length > 14000 ? clipped.slice(0, 14000) + "…[truncated]" : clipped });
      }
      continue;
    }
    emit({ type: "done", reply: r.content || "(no reply)", trace });
    return;
  }
  emit({ type: "done", reply: "(stopped after the maximum number of tool steps — try a narrower question)", trace });
}

module.exports = { converse, converseStream, TOOL_DEFS };
