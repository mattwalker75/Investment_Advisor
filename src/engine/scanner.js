"use strict";
// The market scanner: universe -> data gathering -> indicators -> shortlist -> AI ->
// validated recommendations, all logged to the database.
//
//   1. Build the scan universe from the user's preferences (never outside it).
//   2. Pull OHLCV history per symbol (cached, concurrency-limited) + compute indicators.
//   3. Score setups against the user's indicator thresholds; shortlist the most notable.
//   4. Gather context: news headlines, sentiment gauges, smart-money activity,
//      options chains (when options trading is enabled).
//   5. Ask the AI for recommendations (strict JSON, validated in recommender.js).
//   6. Persist the scan run + every recommendation WITH its full input snapshot.
const db = require("../db");
const settings = require("../settings");
const yahoo = require("../providers/yahoo");
const coingecko = require("../providers/coingecko");
const news = require("../providers/news");
const sentiment = require("../providers/sentiment");
const whales = require("../providers/whales");
const indicators = require("../indicators");
const recommender = require("./recommender");

// Built-in "popular" stock universe: liquid, optionable large caps across sectors.
// Used when preferences.stocks.universe = 'popular'; 'custom' scans ONLY the user's list.
const POPULAR_STOCKS = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AVGO", "AMD", "INTC",
  "CRM", "ORCL", "ADBE", "NFLX", "QCOM", "MU", "PLTR", "SMCI", "ARM", "SHOP",
  "JPM", "BAC", "GS", "V", "MA", "BRK-B", "WFC", "SCHW", "COIN", "PYPL",
  "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV",
  "XOM", "CVX", "COP", "OXY",
  "WMT", "COST", "HD", "MCD", "NKE", "SBUX", "DIS", "UBER", "ABNB",
  "CAT", "BA", "GE", "LMT", "DE", "UPS", "F", "GM",
];

let running = null;   // single-flight: one scan at a time

const now = () => Date.now();
const { logEvent } = require("../events");

// Small concurrency pool so we hit data providers politely.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx).catch(() => null); }
  }));
  return out;
}

// Build the scan universe from preferences: [{symbol(yahoo), display, asset_type, name}]
// Watchlist symbols are ALWAYS included (and get a scoring boost — you said you care).
async function buildUniverse(prefs) {
  const out = [];
  try {
    const watch = await db.all("SELECT symbol, yahoo_symbol, asset_type, name FROM watchlist");
    for (const w of watch) out.push({ symbol: w.yahoo_symbol, display: w.symbol, asset_type: w.asset_type, name: w.name || w.symbol, watched: true });
  } catch (_) {}
  if (prefs.asset_classes.stocks) {
    const list = prefs.stocks.universe === "custom"
      ? prefs.stocks.custom_symbols
      : POPULAR_STOCKS;
    const excl = new Set((prefs.stocks.exclude_symbols || []).map((s) => s.toUpperCase()));
    for (const s of list) {
      const sym = String(s).toUpperCase().trim();
      if (sym && !excl.has(sym)) out.push({ symbol: sym, display: sym, asset_type: "stock", name: sym });
    }
  }
  if (prefs.asset_classes.crypto) {
    const coins = prefs.crypto.universe === "custom"
      ? await coingecko.resolve(prefs.crypto.custom_symbols)
      : await coingecko.topCoins(prefs.crypto.top_n);
    const excl = new Set((prefs.crypto.exclude_symbols || []).map((s) => s.toUpperCase()));
    for (const c of coins) {
      if (excl.has(c.symbol) || excl.has(c.id.toUpperCase()) || excl.has(c.yahoo)) continue;
      out.push({ symbol: c.yahoo, display: c.symbol, asset_type: "crypto", name: c.name });
    }
  }
  // De-dup (watchlist first, so its `watched` flag survives).
  const seen = new Set();
  return out.filter((u) => (seen.has(u.symbol) ? false : (seen.add(u.symbol), true)));
}

// Setup score: how "notable" a chart is per the USER'S indicator thresholds.
// Confluence-weighted: three signals from INDEPENDENT families (trend + momentum +
// volume agreeing) outrank three flavors of the same oversold reading, so the shortlist
// favors setups with corroboration over one-dimensional extremes.
function setupScore(latest) {
  const sigs = latest.signals || [];
  const families = new Set();
  for (const s of sigs) {
    if (/uptrend|downtrend|\(trending\)/.test(s)) families.add("trend");
    if (/^RSI |MACD|Stochastic/.test(s)) families.add("momentum");
    if (/Bollinger|Volatility compression/.test(s)) families.add("meanrev");
    if (/divergence/.test(s)) families.add("divergence");
    if (/Relative-strength/.test(s)) families.add("rel_strength");
  }
  let score = sigs.length * 2;
  if (latest.volume_vs_20d_avg && latest.volume_vs_20d_avg > 1.5) { score += 1; families.add("volume"); }  // volume spike
  else if (latest.obv_20d_trend === "rising") families.add("volume");
  if (families.size >= 2) score += 2;                   // confluence bonus: independent
  if (families.size >= 3) score += 3;                   // families agreeing compound
  if (latest.change_5d_pct != null && Math.abs(latest.change_5d_pct) >= 5) score += 1;  // in motion
  if (latest.pct_off_period_low != null && latest.pct_off_period_low <= 5) score += 1;  // near lows
  if (latest.pct_off_period_high != null && latest.pct_off_period_high >= -2) score += 1; // near highs
  return score;
}

async function runScan(trigger = "manual") {
  if (running) throw new Error("a scan is already running");
  const s = settings.getSync();
  const prefs = s.preferences;
  const log = [];
  const say = (m) => { log.push(`[${new Date().toISOString().slice(11, 19)}] ${m}`); console.log("[scan]", m); };

  // Claim the single-flight slot SYNCHRONOUSLY (before any await): two near-simultaneous
  // runScan() calls both passed the `if (running)` check during the INSERT await.
  running = { id: null, started_at: now(), step: "starting" };
  let runId = null;

  try {
    const ins = await db.run(
      "INSERT INTO scan_runs (trigger_type, status, started_at) VALUES (?,?,?)",
      [trigger, "running", now()]
    );
    runId = ins.lastID;
    running.id = runId;
    // 1. Universe
    running.step = "building universe";
    const universe = await buildUniverse(prefs);
    if (!universe.length) throw new Error("scan universe is empty — check Preferences");
    say(`universe: ${universe.length} symbols (stocks:${universe.filter(u => u.asset_type === "stock").length}, crypto:${universe.filter(u => u.asset_type === "crypto").length})`);

    // 2. History + indicators (SPY closes fetched once as the relative-strength benchmark)
    running.step = `fetching history for ${universe.length} symbols`;
    const benchCloses = await yahoo.history("SPY", 365).then((c) => c.map((b) => b.close)).catch(() => null);
    const enriched = (await pool(universe, 4, async (u) => {
      const candles = await yahoo.history(u.symbol, 365);
      if (!candles || candles.length < 60) return null;    // not enough data to analyze
      const { latest } = indicators.computeAllCached(`scan:${u.symbol}`, candles, s.indicators, benchCloses ? { benchCloses } : {});
      const q = await yahoo.quote(u.symbol).catch(() => null);
      return {
        ...u,
        name: (q && q.name) || u.name,
        price: (q && q.price) || latest.price,
        indicators: latest,
        score: setupScore(latest) + (u.watched ? 3 : 0),   // watchlist priority boost
      };
    })).filter(Boolean);
    say(`analyzed ${enriched.length}/${universe.length} symbols with >=60 candles`);

    // 3. Shortlist the most notable setups (cap what we send to the model).
    running.step = "shortlisting";
    const SHORTLIST = 12;
    const shortlist = enriched.sort((a, b) => b.score - a.score).slice(0, SHORTLIST);
    say(`shortlist (${shortlist.length}): ${shortlist.map((c) => `${c.display}(${c.score})`).join(", ")}`);

    // 4. Context: news, sentiment, whales (+ options chains for stock candidates).
    running.step = "gathering news/sentiment/smart-money";
    const [heads, senti, whale] = await Promise.all([
      news.headlines().catch(() => []),
      sentiment.snapshot().catch(() => ({})),
      whales.snapshot().catch(() => ({ congress_by_ticker: [], recent_13f_filers: [] })),
    ]);
    say(`context: ${heads.length} headlines, sentiment ${senti.stocks_fear_greed ? "stocks:" + senti.stocks_fear_greed.value : "stocks:n/a"} ${senti.crypto_fear_greed ? "crypto:" + senti.crypto_fear_greed.value : "crypto:n/a"}, congress tickers:${(whale.congress_by_ticker || []).length}`);

    const candidates = await pool(shortlist, 3, async (c) => {
      const cand = {
        symbol: c.display, yahoo_symbol: c.symbol, asset_type: c.asset_type, name: c.name,
        price: c.price, indicators: c.indicators,
        headlines: news.matching(heads, c.display, c.name).map((h) => h.title),
        smart_money: (whale.congress_by_ticker || []).find((t) => t.ticker === c.display) || null,
      };
      if (c.asset_type === "stock") {
        // Binary-event risk: the AI must know if earnings land inside the trade horizon.
        cand.next_earnings = await yahoo.nextEarnings(c.symbol).catch(() => null);
        if (prefs.options.enabled) cand.options_chain = await yahoo.optionsChain(c.symbol, prefs.options.max_dte).catch(() => null);
        // Valuation/quality context (24h-cached; note-only without an FMP key).
        const f = await require("../providers/fundamentals").fundamentals(c.symbol).catch(() => null);
        if (f && !f.note) cand.fundamentals = f;
      }
      return cand;
    });

    // 5. AI analysis
    running.step = "AI analysis";
    say(`asking ${s.ai.model} for recommendations...`);
    const regime = await require("./regime").marketRegime().catch(() => null);
    if (regime) say(`market regime: ${regime.regime}${regime.spy_vs_200dma_pct != null ? ` (SPY ${regime.spy_vs_200dma_pct > 0 ? "+" : ""}${regime.spy_vs_200dma_pct}% vs 200-DMA)` : ""}`);
    const activeRecs = await db.all("SELECT symbol, side, entry_low, entry_high, status FROM recommendations WHERE status IN ('open','tracking')");
    const context = {
      market: {
        as_of: new Date().toISOString(),
        regime,
        active_recommendations: activeRecs,
        sentiment: senti,
        top_headlines: heads.slice(0, 15).map((h) => h.title),
        recent_13f_filers: (whale.recent_13f_filers || []).slice(0, 10),
        congress_most_traded: (whale.congress_by_ticker || []).slice(0, 10),
      },
      candidates: candidates.filter(Boolean),
    };
    const { recs, market_outlook, model } = await recommender.recommend(context, say);
    say(`model ${model} returned ${recs.length} validated recommendation(s)`);

    // 6. Persist
    running.step = "saving";
    const expiryMs = (s.schedule.rec_expiry_days || 10) * 86400000;
    let skippedDupes = 0;
    for (const r of recs) {
      const dup = await recommender.duplicateOf(r);
      if (dup) { skippedDupes++; say(`skipped ${r.symbol} — duplicate of active recommendation #${dup.id} (similar ${r.side} levels)`); continue; }
      const cand = context.candidates.find((c) => c.symbol === r.symbol);
      const res = await db.run(
        `INSERT INTO recommendations
         (run_id, created_at, asset_type, symbol, name, side, current_price, entry_low, entry_high,
          stop_loss, targets, horizon_min_days, horizon_max_days, confidence, risk_reward, rationale,
          options_play, inputs, status, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [runId, now(), r.asset_type, r.symbol, r.name, r.side, r.current_price, r.entry_low, r.entry_high,
         r.stop_loss, JSON.stringify(r.targets), r.horizon_min_days, r.horizon_max_days, r.confidence,
         r.risk_reward, r.rationale, r.options_play ? JSON.stringify(r.options_play) : null,
         JSON.stringify({ candidate: cand, market: context.market, market_outlook }),
         "open", now() + expiryMs]
      );
      await logEvent("rec_new", "recommendation", res.lastID, r.symbol,
        `New ${r.side.toUpperCase()} idea: ${r.symbol} @ ${r.entry_low}-${r.entry_high} (conf ${Math.round(r.confidence * 100)}%)`);
    }

    // 6b. OPTIONS pass: standalone option plays over the chain-bearing candidates,
    // premium-denominated and shadow-tracked like any other rec. Failure never kills
    // the scan — stock/crypto recs above are already persisted.
    let optSaved = 0;
    if (prefs.options.enabled && prefs.asset_classes.stocks) {
      const optionsEngine = require("./options");
      running.step = "options analysis";
      try {
        const { recs: optRecs } = await optionsEngine.recommendOptions(context, say);
        for (const r of optRecs) {
          const dup = await recommender.duplicateOf(r);
          if (dup) { say(`skipped ${r.options_play.strategy} ${r.symbol} — duplicate of active recommendation #${dup.id}`); continue; }
          const cand = context.candidates.find((c) => c.symbol === r.symbol);
          const id = await optionsEngine.saveOptionRec(r, { runId, inputs: { candidate: cand, market: context.market } });
          optSaved++;
          await logEvent("rec_new", "recommendation", id, r.symbol,
            `New OPTIONS idea: ${r.options_play.strategy.replace(/_/g, " ")} ${r.symbol} ${r.options_play.strikes.join("/")} exp ${r.options_play.expiry} @ ~${r.current_price} premium (conf ${Math.round(r.confidence * 100)}%)`);
        }
      } catch (e) { say(`options pass failed: ${e.message}`); }
    }

    await db.run(
      "UPDATE scan_runs SET status='done', finished_at=?, universe_count=?, shortlist_count=?, recs_count=?, log=? WHERE id=?",
      [now(), universe.length, shortlist.length, recs.length - skippedDupes + optSaved, JSON.stringify(log), runId]
    );
    await logEvent("scan", "scan", runId, null, `Scan complete: ${recs.length - skippedDupes + optSaved} recommendation(s) from ${universe.length} symbols${optSaved ? ` (incl. ${optSaved} options play${optSaved > 1 ? "s" : ""})` : ""}`);
    return { run_id: runId, recs_count: recs.length + optSaved, market_outlook };
  } catch (e) {
    await db.run("UPDATE scan_runs SET status='error', finished_at=?, error=?, log=? WHERE id=?",
      [now(), e.message, JSON.stringify(log), runId]).catch(() => {});
    await logEvent("error", "scan", runId, null, `Scan failed: ${e.message}`).catch(() => {});
    throw e;
  } finally {
    running = null;
  }
}

function status() { return running ? { running: true, ...running } : { running: false }; }

module.exports = { runScan, status, POPULAR_STOCKS };
