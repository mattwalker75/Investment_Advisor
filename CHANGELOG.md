# Changelog

All notable changes to Investment Advisor are tracked here.

## [Unreleased]

### Added
- 2026-07-14: **Trade-class badges + type filter on Recommendations.** Every rec card
  (and dashboard rec row) now carries a prominent colored badge saying what you'd
  actually trade: 📈 STOCK (cyan), 🧾 OPTION (purple — any rec with an options play),
  ₿ CRYPTO (amber). New toolbar filter All types / Stocks / Options / Crypto combines
  with the Active/All/Finished filter. Replaces the faint grey `· stock` hint and the
  small purple "options" chip.

### Fixed (same day)
- 2026-07-12: FMP integration migrated to their **stable API** — FMP retired the v3/v4
  endpoints for accounts created after Aug 2025 (candles `historical-price-eod/full`,
  `quote`, `profile`, congress `senate-latest`/`house-latest`; free tier caps `limit` at
  25). Verified with a real key: stock charts (AAPL 250 candles), full 82-symbol scan
  (52 analyzed incl. stocks), 40 live congressional trades.

### Added
- 2026-07-12: **Keyed-first market-data source chains — Yahoo out of the hot path.**
  Yahoo's aggressive throttling (hours-long IP blocks) made it unusable as a primary.
  New priority chains: crypto quotes CoinGecko→Yahoo and candles Coinbase→Yahoo (fully
  keyless — verified live); stock quotes Finnhub→FMP→Yahoo→AlphaVantage and daily
  candles FMP→Yahoo (two free keys recommended: FMP 250/day + Finnhub 60/min — no credit
  card); sector lookups FMP→Yahoo. Market strip/briefing/chat overview switched from
  ^GSPC/^IXIC/^DJI to SPY/QQQ/DIA ETF proxies so keyed sources can serve them. Yahoo
  remains sole source only where no free alternative exists (options chains, earnings
  dates, intraday, symbol search) — those degrade gracefully behind the circuit breaker.
- 2026-07-12: **Chat-created recommendations** (`save_recommendation` tool). Asking the
  advisor to "create/track a trade idea" now actually saves it: the idea passes the SAME
  validation gates as scan recommendations (entry sanity vs live price, stop side, ladder
  renormalized to 100%, confidence + reward:risk minimums — rejection reasons are fed
  back so the model can adjust), lands in the Recommendations tab, and is shadow-tracked.
  System prompt now forbids claiming an idea is saved unless the tool confirmed it
  (fixes: advisor previously SAID it would track an idea but had no tool to do so, and
  the idea silently vanished). Verified live: XRP idea saved with R:R 2.16, validated
  against a CoinGecko-fallback price while Yahoo was throttled.
- 2026-07-12: **Tier 2 + Tier 3 — the full backlog** (11 features):
  - **Plan on the chart**: 📈 buttons on recommendation cards and open-trade rows open the
    Charts tab with the trade plan drawn on the candles — entry zone (cyan), stop (red),
    target rungs (green with sell %).
  - **Watchlist** (new tab + table): watch any symbol (any spelling) with optional
    above/below price alerts (re-armable); watched symbols always join scans with a
    shortlist priority boost.
  - **Daily AI briefing**: scheduled (or on-demand) morning read — market, your positions
    vs plan, active ideas, what to watch — on the dashboard + notifications
    (`schedule.briefing_enabled/briefing_hour`, `notify_on.briefing`).
  - **♻ Re-validate**: one click asks the AI to re-check an open recommendation against
    current data → valid / adjust (levels updated in place) / withdraw (closed).
  - **Confidence calibration** (Performance): finished recs bucketed by stated confidence
    with per-bucket win rate and average outcome.
  - **🧪 Threshold backtester** (Performance): replays the past year, entering when ≥N of
    YOUR buy signals fire (trend-filtered) with a 2×ATR stop and min-R:R target bracket —
    win rate + per-symbol results for tuning thresholds before trusting them.
  - **Quote failover**: Yahoo throttled/down → stocks fall back to Finnhub then Alpha
    Vantage (keys in Settings), crypto to CoinGecko (keyless, verified live during a
    Yahoo cooldown).
  - **Intraday charts**: new 5D range with hourly candles.
  - **Portfolio concentration warnings**: banner in Trades when ≥50% of open positions
    share one sector (Yahoo company profiles) or are all crypto.
  - **CSV export**: trades + recommendations downloads (Performance tab).
  - **Streaming chat**: advisor replies now stream token-by-token with live tool-activity
    chips (`/api/advisor-chat?stream=1`, NDJSON events).
  - Schema: new `watchlist` table (both dialects + drop list); scan universe de-dup.
- 2026-07-12: **Docs/ directory.** Detailed documentation split out of the README
  (architecture, configuration, scanning & recommendations, trades & position
  management, advisor chat, indicators, data sources, database, API); README.md
  rewritten as a high-level overview with links.
- 2026-07-11: **Tier 1 — full trade-lifecycle advisory** (six features):
  - **Risk/reward gate + position sizing.** Every recommendation now computes a
    ladder-weighted reward:risk ratio; ideas below the configurable minimum (default
    1.5:1) are dropped in validation regardless of model confidence. New risk settings
    (account size, risk-per-trade %) drive suggested position sizes on rec cards and
    prefill the take-trade dialog. Verified: 5/5 scan recs passed with R:R 2.16–3.05.
  - **Dynamic stop management.** The tracker now suggests stop raises on open trades:
    breakeven once target 1 hits, and/or an ATR chandelier trail (configurable multiple)
    — surfaced in the Trades table with one-click **Apply** (plus manual stop editing via
    `PATCH /api/trades/:id`). Verified: rising synthetic trade produced a correct
    140→192.37 trail suggestion.
  - **🩺 AI position health checks.** Batched AI review of every open position → verdict
    per trade (hold / tighten_stop / take_partial / sell_now + urgency + reasoning),
    shown as a chip in the Trades table; non-hold verdicts raise events/notifications.
    Scheduled (`schedule.health_check_hours`, default 12h) + on-demand button + endpoint.
    Verified live: qwen3:8b issued a sound TAKE_PARTIAL on an overextended position.
  - **Earnings awareness.** New `nextEarnings()` provider (Yahoo calendarEvents); scan
    candidates carry days-to-earnings, the AI is instructed to avoid/flag entries within
    the configurable buffer (default 3 days), rec cards show a "⚠ earnings Nd" chip when
    the date falls inside the trade horizon, and chat `get_analysis` includes it.
  - **Notifications.** New `src/notify.js` + shared event logger: one webhook URL
    (ntfy.sh / Discord / Slack auto-detected) with per-category gates (stops & targets,
    stop suggestions, health verdicts, scans), a send-test button, plus browser desktop
    notifications via event polling while the page is open. Verified: real delivery
    through ntfy.sh.
  - **Options as first-class positions.** Options plays are enriched from the live chain
    (estimated premium, breakeven, max loss/contract, IV); "🧾 Took the option" logs a
    contracts+premium position (also manual option logging with type/strike/expiry);
    open options price off the current chain mid with the ×100 contract multiplier
    (verified exit math: +$350/50% on a 2-contract test); expiry countdown alerts at
    7/2/0 days.
  - Schema: `recommendations.risk_reward`; `trades.suggested_stop/health/option_details`
    — added to both schema files + auto-migration for existing DBs (SQLite + MySQL).
- 2026-07-11: **Crypto-first-class symbol resolution** (`src/resolve.js`). Every
  symbol-taking surface — the chat tools (get_quote/get_analysis/get_news), the Charts
  tab, and the quote API — now accepts crypto in any spelling ("BTC", "bitcoin",
  "solana", "ETH-USD") and auto-maps it to the Yahoo -USD candle pipeline via the
  CoinGecko top-100. Ticker collisions (LINK the coin vs LINK the stock) default to
  well-known equities and can be forced with an asset_type hint; "-USD" always means
  crypto. Options chains and smart-money remain stock-only (correctly refused for
  crypto). Verified: 12-case resolver matrix + a live crypto chat turn.
- 2026-07-11: **💬 Advisor chat.** A conversation drawer (button next to ⚡ Scan market)
  where the AI has **live tool-calling access** to all of the tool's data: market
  overview, quotes, per-symbol indicator analysis (with the user's thresholds), options
  chains, the recommendation log with tracked outcomes, the user's trades + live P&L,
  performance stats, news, sentiment gauges, smart-money data, the crypto universe, the
  user's preferences — and it can launch a market scan. 13 tools total
  (`src/ai/chat.js`); the model fetches exactly what each question needs (verified:
  qwen3:8b correctly picks tools per question). Slash-command skills: `/help` (commands +
  example questions), `/analyze SYM`, `/market`, `/recs`, `/portfolio`, `/performance`,
  `/news [SYM]`, `/whales`, `/ideas`, `/scan`, `/clear`. Conversation persists in the
  browser (localStorage, capped); tool calls are shown as chips above each answer.
  New endpoint `POST /api/advisor-chat`; `src/ai/llm.js` gained OpenAI tools support.
- 2026-07-11: Settings → AI model: **provider picker** (Ollama / OpenAI / LM Studio /
  custom) that presets the endpoint URL, plus a **model dropdown** populated live from
  the endpoint's `/models` (OpenAI catalog filtered to chat-capable; embeddings hidden)
  via `POST /api/ai/models`, with manual free-text still available.
- 2026-07-11: Friendlier market-data errors: Yahoo's raw "Too Many Requests" throttle
  response is translated into a human explanation (it self-clears; cache serves stale).

- 2026-07-11: **Initial build — the full v0.1 system.**
  - **Stack**: Node.js + Express (localhost:8210), SQLite (default, zero-setup) or MySQL —
    one DB abstraction, two first-class schema files (`database/schema.sqlite.sql`,
    `database/schema.mysql.sql`), `ADVISOR.sh` control script (`--setup/--start/--stop/
    --status/--logs/--init-db/--reset-db`).
  - **AI layer**: any OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, LiteLLM),
    configured in Settings with a Test-connection button; robust strict-JSON extraction
    (handles `<think>` blocks and markdown fences from local models) with one retry.
  - **Market scanner**: preference-driven universe (stocks: built-in popular list or
    custom-only; crypto: CoinGecko top-N or custom-only; exclusions) → 1y daily OHLCV →
    all enabled indicators (RSI, MACD, SMA, EMA, Bollinger, Stochastic, ATR, ADX, OBV,
    VWAP with user buy/sell thresholds) → setup scoring + shortlist → context (RSS news,
    stock+crypto Fear & Greed, congressional trades via CapitolTrades, recent 13F filers
    via EDGAR, options chains when enabled) → AI recommendations.
  - **Recommendations**: side, entry zone, stop loss, laddered profit targets
    (sell X% at each rung, renormalized to 100%), estimated time-in-trade, confidence,
    data-grounded rationale, optional options play limited to user-approved strategies +
    max DTE. Every rec stored with its full input snapshot. Every number validated/
    clamped server-side before persisting (entry sanity vs. real price, stop on the
    correct side, ladder sums to 100).
  - **Honest scorekeeping**: recommendations are shadow-tracked against live prices even
    when not taken — entry-hit → tracking → stopped/target_hit/expired with weighted-
    ladder P&L, so the Performance tab grades everything the system ever said.
  - **Trade tracking**: "I took this trade" converts a rec into a tracked position;
    tight polling loop fires events when price crosses the stop or any target rung;
    partial exits supported (trade closes when quantity reaches zero); manual trades too.
  - **Web UI** (dark trading-terminal theme): Dashboard (market strip, Fear & Greed
    gauges, success tiles, latest recs, headlines, activity), Recommendations (filter,
    expandable cards with levels ladder + rationale + take/dismiss), Charts
    (lightweight-charts candlesticks, symbol search, 3M–2Y ranges, opt-in overlays:
    SMA/EMA/BB/VWAP/Volume + RSI/MACD sub-panes — indicators always feed the AI, charts
    draw only what's toggled), Trades (open positions with live unrealized P&L, exit
    dialog, closed table), Performance, Settings (AI, database, preferences, options
    comfort, per-indicator thresholds, schedule, data feeds).
  - **Scheduler**: optional scheduled scans (every N hours or daily at an hour) +
    tracking cadences, all hot-reload from settings.
  - **Politeness/resilience**: DB-backed fetch cache with stale-on-failure, Yahoo call
    pacing (serialized, 300ms min gap), per-symbol failure tolerance — a dead feed or
    throttled endpoint never kills a scan.
  - Verified: providers live (CoinGecko, RSS news, CNN + alternative.me sentiment,
    CapitolTrades, EDGAR), recommender end-to-end against local Ollama qwen3:8b
    (valid strict JSON, correctly validated ladder), UI serving, DB init on SQLite.

### Notes
- yahoo-finance2 pinned to **2.13.3** — v2.14+ is a transitional ESM rewrite missing
  most modules (only quote/autoc migrated); do not upgrade until feature parity.
- Not financial advice; single-user local tool by design.

### Fixed
- 2026-07-11: Modal backdrop rendered on page load (a grey overlay + empty box) —
  explicit `display:flex` was overriding the `hidden` attribute; added
  `.modal-backdrop[hidden]{display:none}`.
- 2026-07-11: Moved the DB-connection config from `data/config.json` to
  **`ADVISOR_CONFIG.json`** at the project root (JARVIS-style), with a committed
  `ADVISOR_CONFIG_template.json`; the real file is gitignored (may hold MySQL creds).
- 2026-07-11: Pinned `yahoo-finance2` to 2.13.3 (2.14 is a transitional ESM rewrite
  missing chart/options/search); added call pacing (serialized, 300ms gap) and
  stale-cache fallback.
