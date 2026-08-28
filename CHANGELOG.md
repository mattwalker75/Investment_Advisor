# Changelog

All notable changes to Investment Advisor are tracked here.

## [Unreleased]

### Added (batch 3)
- 2026-08-28: **Automatic DB backups.** Daily SQLite snapshot into `data/backups/`
  (better-sqlite3 online backup — safe while writing), newest `backup_keep` retained
  (default 14), on by default, plus `POST /api/db/backup` and a **Back up now** button.
- 2026-08-28: **Broker/portfolio CSV import.** `POST /api/trades/import` + an Import CSV
  button (paste or file): loose header matching, RFC-4180 parsing, crypto auto-resolve,
  duplicate open positions skipped, per-row errors reported. Imported rows are open
  trades — health checks, concentration, tracking, and the briefing cover the whole
  portfolio from day one.
- 2026-08-28: **Equity curve + what-if paper mode.** `GET /api/portfolio/equity` and a
  Performance card: the realized account curve (closed-trade P&L on the configured
  account size) beside the dashed WHAT-IF curve — every finished recommendation taken at
  its shadow entry with the user's risk sizing (sequential, capped at equity). Tiles for
  final equity, return %, and max drawdown.
- 2026-08-28: **Tax holding-period awareness.** Closed trades show holding days + a
  short/long-term chip, the trades CSV gains `holding_days`/`tax_term` columns, and
  `/api/performance` splits realized P&L by term.
- 2026-08-28: **Data-source degradation indicator.** `GET /api/health/providers` + a
  topbar chip that appears only when something is off: "⛔ data throttled" during a
  Yahoo cooldown, "⚠ keyless data" when no stock keys are set — with the fix in the
  tooltip.
- 2026-08-28: **Chart tools.** "vs symbol" relative-comparison overlay (both series on a
  percentage scale, re-fetched on symbol/range change) and ✏ Level mode — click to drop
  horizontal price lines, persisted per symbol, ✖ clears.
- 2026-08-28: **UI polish.** Styled confirm dialogs on destructive/grading actions
  (dismiss/complete recommendations, watchlist removal) with consequences spelled out;
  consistent Loading… / error-with-Retry states on the recommendations, watchlist,
  trades, and performance panels; a section-index comment atop app.js; and a dashboard
  **Ask the Advisor** card with four prompt chips that open the chat prefilled.

### Added (batch 2)
- 2026-08-27: **AI plumbing upgrades.** JSON-producing calls now request structured
  output (`response_format: json_object`) with per-endpoint feature detection; optional
  **model failover** (Settings → AI): one retry against a configured fallback
  endpoint/model when the primary hard-fails (network/5xx/timeout), key masked, streams
  fail over only before the first token; **per-task model tiers** (`task_models.scan`
  for recommender/revalidation/health, `.light` for headline grading + briefing);
  **configurable scan batching** (`single` | `grouped` ~4 | `per_candidate`) with recs
  merged best-confidence-first and live per-group progress in the scan log.
- 2026-08-27: **Scan prompt compacted.** Market context slimmed (regime essentials, slim
  active recs, capped lists) and candidates capped (4 headlines, options chains reduced
  to ≤8 near-money strikes with essential leg fields), no pretty-printing — the full
  objects still go into the stored input snapshot.
- 2026-08-27: **Advisor chat: 9 new tools (23 total) + durable memory.** run_backtest,
  check_position_health, revalidate_recommendation (the real engines),
  get_portfolio_concentration (shared engine in `src/engine/portfolio.js`),
  compare_symbols (2–5 side-by-side incl. RS vs SPY), manage_watchlist, update_trade
  (confirm-first plan updates + stop_moved event), get_economic_calendar (new
  `src/providers/calendar.js`, FMP high-impact US macro events), manage_memory —
  short durable notes stored in the DB and injected into every conversation's system
  prompt. Tool results are no longer blunt-cut at 14k chars: structural shrink (drop the
  large input snapshot, cap arrays/strings) with a marked-partial last resort.
- 2026-08-27: **Notification bridge finished.** ntfy deliveries carry per-event
  priorities (stop crossed/option expiring = urgent, health + target hits = high,
  scans/briefings = low) and tags; docs gained a 3-minute phone-push walkthrough.
- 2026-08-27: **Dependencies bumped & tested**: express 4→5, better-sqlite3 11→13,
  mysql2 3.24 (full scratch-DB smoke green, `npm audit` 0). Deliberate pins kept:
  yahoo-finance2 2.13.3 (incomplete ESM rewrite upstream) and lightweight-charts 4.x
  (v5 is a series-API rewrite — bump alongside a chart-feature pass with browser
  verification).

### Security
- 2026-08-27: **Cross-site request guard.** New `src/security.js` middleware validates
  the `Host` header (DNS-rebinding protection) and, when present, the `Origin` header
  (CSRF protection) on every request — a malicious web page can no longer POST to
  `127.0.0.1:8210` or read API responses via a rebound hostname. Extra hostnames via
  `ADVISOR_ALLOWED_HOSTS`. Verified live (evil Host/Origin → 403, same-origin → passes).
- 2026-08-27: **Webhook SSRF guard.** Notification webhooks must be http(s) and may not
  target loopback/link-local/cloud-metadata addresses (LAN hosts like self-hosted ntfy
  stay allowed; `ADVISOR_WEBHOOK_ALLOW_LOCAL=1` opts back in). The test endpoint
  surfaces the refusal reason.
- 2026-08-27: **Advisor-chat history bounded server-side** (last 40 turns, 8k chars per
  message, 24k for the live turn) — the client's re-sent localStorage history can no
  longer balloon model cost. **`PUT /api/db/config` validates shape** (dialect/sqlite/
  mysql field types) and no longer 500s on a config file missing the mysql block.

### Added
- 2026-08-27: **Strategy engine deepened.** Three always-on derived indicator reads:
  ATR percentile (volatility regime: chop warning ≥80th, compression ≤15th), RSI
  divergence vs recent price extremes, and 63-day relative strength vs SPY (scanner
  fetches the benchmark once per scan). Setup scoring is now confluence-weighted —
  signals from independent families (trend/momentum/mean-reversion/volume/divergence/RS)
  earn a bonus over repeated same-family extremes. New market-regime gate
  (`src/engine/regime.js`): SPY vs its 200-DMA + Fear & Greed → risk_on/neutral/risk_off,
  logged per scan, exposed on `GET /api/market`, and fed to the AI with an explicit
  be-more-selective-in-risk_off rule. Calibration loop-back: once ≥8 recommendations
  have finished, the scan prompt includes the model's own shadow-graded win rate per
  confidence bucket so it can correct a miscalibrated confidence scale.
- 2026-08-27: **Backtester overhaul.** Gap-aware fills (bars opening beyond a level fill
  at the open), configurable slippage (default 0.1%/fill) and per-side fees, and a new
  `ladder_trail` exit model that mirrors live trade management (30/40/30 ladder at 1R /
  minRR·R / 1.75·minRR·R, breakeven after rung 1, ATR chandelier trail per your stops
  settings) — so the backtest validates the strategy the tool actually recommends.
  Portfolio-level metrics (profit factor, expectancy, avg win/loss, max drawdown,
  compounded return) plus an in-sample vs out-of-sample walk-forward split (default:
  last 30% of the window) to expose curve-fit thresholds. UI: exit-model + slippage
  controls and the new metric tiles/split table.

### Changed
- 2026-08-27: **server.js split into domain routers** (`src/routes/`: settings,
  recommendations, trades, market, engine) — the 690-line route file becomes a 46-line
  bootstrap; smoke-tested end-to-end on a scratch DB. Shared helpers dedup'd into
  `src/util.js` (JSON parse fallback ×7, crypto→Yahoo symbol mapping ×8, ladder-P&L
  math ×3, CSV writer) and `db.upsertSql()` (SQLite/MySQL conflict-clause fork ×3).
- 2026-08-27: **Performance pass.** Sector lookups in the recommendations list and the
  concentration endpoint batch in parallel (were serial N+1 awaits); open option trades
  fetch one chain per unique {symbol, expiry} instead of one per trade; an in-process
  memo fronts `computeAll` (scanner/backtest/chart/health/revalidate/chat) and
  `coingecko.topCoins` (60s); the UI's activity feed + desktop-alert watcher share one
  `/api/events` poll loop — and the dashboard activity feed now stays live (45s).
- 2026-08-27: **Docs refreshed**: architecture data-flow diagram + updated module tree,
  "The validation gauntlet" section documenting every clamp/gate in `validateRec`, a
  5-minute provider-key walkthrough, environment-variable reference, stronger README
  risk disclaimer, and API/indicator doc updates for the new surface.
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
