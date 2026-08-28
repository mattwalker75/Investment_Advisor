"use strict";
// Settings store: everything user-configurable lives in the DB `settings` table as JSON
// blocks, deep-merged over the DEFAULTS below (so new options appear automatically after
// upgrades). Edited from the web UI Settings tab via GET/PUT /api/settings.
// The only exception is the DB connection itself — that's ADVISOR_CONFIG.json.
const db = require("./db");

const DEFAULTS = {
  // --- The AI brain: any OpenAI-compatible /chat/completions endpoint. ---
  ai: {
    base_url: "http://localhost:11434/v1",   // Ollama default; or https://api.openai.com/v1
    api_key: "",                              // required by OpenAI; ignored by local servers
    model: "qwen3:8b",
    temperature: 0.3,
    max_tokens: 4000,
    // Per-task model overrides (empty = use `model`). 'scan' runs the recommender,
    // revalidation, and health checks (the hard reasoning); 'light' runs headline
    // grading and the daily briefing (cheap/fast is fine). Chat always uses `model`.
    task_models: { scan: "", light: "" },
    // How the scan recommender batches the shortlist: 'single' = one call for all
    // candidates (fastest/cheapest), 'grouped' = ~4 per call, 'per_candidate' = one
    // call each (slowest, most rigorous — no cross-candidate bleed, no truncation risk).
    scan_batching: "single",
    // Optional failover tried once when the primary endpoint hard-fails (network error,
    // 5xx, timeout). Empty base_url/api_key inherit the primary's values.
    failover: { enabled: false, base_url: "", api_key: "", model: "" },
    // Optional $/million-token prices for the usage telemetry's cost estimate.
    // Leave at 0 for local models (free) — the cost line simply stays hidden.
    cost: { per_mtok_input: 0, per_mtok_output: 0 },
  },

  // --- What the user is willing to trade. The scanner NEVER strays outside this. ---
  preferences: {
    asset_classes: { stocks: true, crypto: true },  // untick one to go stocks-only / crypto-only
    stocks: {
      universe: "popular",       // 'popular' (built-in liquid large-caps) | 'custom' (only my list)
      custom_symbols: [],        // e.g. ["AAPL","NVDA","TSLA"] — the ONLY stocks scanned when universe='custom'
      exclude_symbols: [],       // never recommend these
    },
    crypto: {
      universe: "top",           // 'top' (top N by market cap) | 'custom'
      top_n: 25,
      custom_symbols: [],        // CoinGecko ids or tickers, e.g. ["bitcoin","ethereum","solana"]
      exclude_symbols: [],
    },
    risk: {
      max_recommendations_per_scan: 5,
      min_confidence: 0.55,      // drop AI recs below this confidence
      risk_tolerance: "moderate", // 'conservative' | 'moderate' | 'aggressive' — passed to the AI
      allow_shorts: true,        // include SELL-side (short) ideas; off = long ideas only
      // Position sizing (advisory only): "risk X% of the account per trade" — suggested
      // share/coin counts are derived from the entry-to-stop distance.
      account_size: 10000,
      risk_per_trade_pct: 1.0,
      // Recs whose weighted reward:risk falls below this are DROPPED in validation.
      min_risk_reward: 1.5,
      // Flag (and penalize) new stock entries within N days of an earnings report. 0 = off.
      avoid_earnings_days: 3,
      // Dynamic stop suggestions on OPEN trades: move to breakeven once target 1 hits,
      // and/or trail with an ATR chandelier (highest close since entry - mult*ATR).
      stops: { breakeven_after_target1: true, atr_trailing: true, atr_multiple: 3 },
    },
    options: {
      enabled: false,            // master switch: suggest options plays alongside stock recs
      strategies: {              // which option trade types the user is comfortable with
        long_call: true, long_put: true,
        covered_call: false, cash_secured_put: false,
        call_spread: false, put_spread: false,
      },
      max_dte: 60,               // don't suggest expiries further out than this many days
      notes: "",                 // free-form guidance passed to the AI (e.g. 'small premium only')
    },
  },

  // --- Technical indicators: enable + the user's preferred buy/sell ranges. ---
  // ALL enabled indicators are computed and fed to the AI as decision inputs; the chart
  // only DRAWS the ones the user toggles on. buy/sell values also drive the pre-filter
  // that shortlists scan candidates.
  indicators: {
    rsi:        { enabled: true,  period: 14, buy_below: 35, sell_above: 70 },
    macd:       { enabled: true,  fast: 12, slow: 26, signal: 9 },            // bullish/bearish cross
    sma:        { enabled: true,  fast: 50, slow: 200 },                       // golden/death cross + price vs MA
    ema:        { enabled: true,  period: 21 },
    bollinger:  { enabled: true,  period: 20, stddev: 2 },                     // %B near 0 = oversold
    stochastic: { enabled: true,  k: 14, d: 3, buy_below: 20, sell_above: 80 },
    atr:        { enabled: true,  period: 14 },                                // volatility (sizes stops)
    adx:        { enabled: true,  period: 14, trend_min: 20 },                 // trend strength filter
    obv:        { enabled: true },                                             // volume flow confirmation
    vwap:       { enabled: false },                                            // intraday anchor (off by default)
  },

  // --- Data providers. Free/keyless defaults work out of the box; keys upgrade quality. ---
  providers: {
    news_feeds: [
      "https://feeds.content.dowjones.io/public/rss/mw_topstories",  // MarketWatch top
      "https://www.cnbc.com/id/100003114/device/rss/rss.html",       // CNBC markets
      "https://finance.yahoo.com/news/rssindex",                      // Yahoo Finance
      "https://www.coindesk.com/arc/outboundfeeds/rss/",              // CoinDesk (crypto)
      "https://cointelegraph.com/rss",                                // Cointelegraph (crypto)
    ],
    alpha_vantage_key: "",     // optional
    finnhub_key: "",           // optional
    fmp_key: "",               // optional — enables congressional-trade tracking (free key at financialmodelingprep.com)
    cache_minutes: { quotes: 5, history: 360, news: 30, sentiment: 60, whales: 720 },
  },

  // --- Scheduling: scans + how tightly to watch things. ---
  schedule: {
    scan_enabled: false,
    scan_every_hours: 24,
    scan_at_hour: 8,             // local hour for the daily scan when every_hours >= 24
    track_open_trades_minutes: 5,   // trades you TOOK: tight tracking loop
    track_recommendations_minutes: 30, // shadow-tracking of all open recs
    rec_expiry_days: 10,         // entry never hit within N days -> recommendation expires
    health_check_hours: 12,      // AI position health checks on open trades (0 = manual only)
    briefing_enabled: false,     // daily AI briefing (market + your positions + active ideas)
    briefing_hour: 8,            // local hour it generates
    // Daily SQLite backup into data/backups/ (the DB is the whole track record).
    backup_enabled: true,
    backup_keep: 14,             // newest N backups retained
    // Weekly AI review: a candid retrospective (what fired, what worked, what to change)
    // generated on the chosen day at briefing_hour.
    weekly_review_enabled: false,
    weekly_review_day: 0,        // 0 = Sunday … 6 = Saturday
  },

  // --- View: which tabs/cards the UI SHOWS. Display-only — hiding something never
  // affects the AI analysis, scanning, or tracking (those all run server-side). ---
  view: {
    tabs: { recommendations: true, charts: true, watchlist: true, trades: true, performance: true },
    dashboard: { briefing: true, sentiment: true, success: true, latest_recs: true, headlines: true, figures: true, activity: true },
    performance: { rec_performance: true, your_trades: true, equity: true, calibration: true, backtest: true, strategy_lab: true, attribution: true },
  },

  // --- Notifications: how timing alerts reach you beyond the Activity feed. ---
  notifications: {
    browser: true,               // desktop notifications while the page is open
    webhook_url: "",             // ntfy.sh topic URL, Discord or Slack webhook — auto-detected
    notify_on: { stops_targets: true, health: true, scans: true, stop_suggestions: true, briefing: true, custom_alerts: true },
    // Quiet hours: webhook delivery pauses in this local-time window — EXCEPT crossed
    // stops, which always break through. Events still land in the Activity feed.
    quiet_hours: { enabled: false, start_hour: 22, end_hour: 7 },
  },
};

let cache = null;   // in-memory settings (merged), reloaded on every write

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== "object" || base === null ||
      typeof over !== "object" || over === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

async function load() {
  const rows = await db.all("SELECT `key`, value FROM settings");
  const stored = {};
  for (const r of rows) { try { stored[r.key] = JSON.parse(r.value); } catch (_) {} }
  cache = {};
  for (const k of Object.keys(DEFAULTS)) cache[k] = deepMerge(DEFAULTS[k], stored[k] || {});
  return cache;
}

async function getAll() { return cache || load(); }
function getSync() { return cache || JSON.parse(JSON.stringify(DEFAULTS)); }

// Replace one top-level block (ai | preferences | indicators | providers | schedule).
async function setBlock(key, value) {
  if (!(key in DEFAULTS)) throw new Error("unknown settings block: " + key);
  const merged = deepMerge(DEFAULTS[key], value || {});
  await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"),
    [key, JSON.stringify(merged), Date.now()]);
  await load();
  return cache[key];
}

// Safe copy for the browser: API keys are masked (shown as boolean presence only).
function publicView(s) {
  const c = JSON.parse(JSON.stringify(s));
  c.ai.api_key_set = !!c.ai.api_key; c.ai.api_key = c.ai.api_key ? "•••" : "";
  if (c.ai.failover) c.ai.failover.api_key = c.ai.failover.api_key ? "•••" : "";
  c.providers.alpha_vantage_key = c.providers.alpha_vantage_key ? "•••" : "";
  c.providers.finnhub_key = c.providers.finnhub_key ? "•••" : "";
  c.providers.fmp_key = c.providers.fmp_key ? "•••" : "";
  // Webhook URLs are credentials (a Discord webhook grants post access) — mask them too.
  c.notifications.webhook_url = c.notifications.webhook_url ? "•••" : "";
  return c;
}

module.exports = { DEFAULTS, load, getAll, getSync, setBlock, publicView, deepMerge };
