# Architecture

A single Node.js process (no Docker required): Express server + REST API + scheduler,
bound to `127.0.0.1:8210`, with a SQLite (default) or MySQL database and a static web UI.
Controlled by `./ADVISOR.sh` (`--setup/--start/--stop/--status/--logs/--init-db/--reset-db`).

```
ADVISOR.sh                     control script (start/stop/db init)
ADVISOR_CONFIG.json            DB connection (the one file-based setting; gitignored)
server.js                      Express bootstrap: middleware, router mounting, boot
database/schema.{sqlite,mysql}.sql   first-class DDL, one file per dialect
src/
├── db/index.js                one async interface over better-sqlite3 / mysql2 (+ auto-migrations, upsert helper)
├── settings.js                all other settings, stored in the DB, deep-merged over defaults
├── security.js                Host/Origin guard (CSRF & DNS-rebinding) + webhook SSRF guard
├── util.js                    shared helpers: JSON parse, crypto→Yahoo mapping, ladder P&L, CSV
├── resolve.js                 "AAPL" / "BTC" / "bitcoin" / "ETH-USD" -> the right instrument
├── events.js                  event log + notification fan-out
├── notify.js                  webhook delivery (ntfy / Discord / Slack auto-detected)
├── scheduler.js               scan / tracking / health-check / briefing loops (settings-driven)
├── routes/                    the REST API, one module per domain
│   ├── settings.js            settings blocks, AI endpoint test/models, DB config, webhook test
│   ├── recommendations.js     recommendation lifecycle + CSV export
│   ├── trades.js              trades, health checks, concentration + CSV export
│   ├── market.js              charts, quotes, search, dashboard snapshot, watchlist, events
│   └── engine.js              scans, advisor chat, briefing, backtester, performance stats
├── providers/
│   ├── yahoo.js               quotes, OHLCV, options chains, earnings dates (paced + cached)
│   ├── coingecko.js           crypto universe (top-N by mcap) + symbol mapping
│   ├── news.js                RSS headlines (+ per-symbol matching)
│   ├── sentiment.js           stock & crypto Fear-and-Greed gauges
│   ├── whales.js              SEC EDGAR 13F filers + congressional trades (FMP key)
│   └── cache.js               DB-backed fetch cache with stale-on-failure
├── indicators/index.js        RSI, MACD, SMA/EMA, Bollinger, Stochastic, ATR, ADX, OBV, VWAP
│                              + derived reads: ATR percentile, RSI divergence, relative strength
├── ai/
│   ├── llm.js                 OpenAI-compatible client (chat + tools + strict-JSON extraction)
│   └── chat.js                the Advisor chat: 14-tool conversation loop
└── engine/
    ├── scanner.js             universe -> indicators -> shortlist -> AI -> validated recs
    ├── recommender.js         prompt contract + number validation (R:R gate, ladder rules)
    ├── regime.js              market-wide risk_on/neutral/risk_off read (SPY trend + sentiment)
    ├── tracker.js             shadow-tracks recs; watches trades (alerts, stop suggestions)
    ├── health.js              AI position health checks (hold/tighten/partial/sell verdicts)
    ├── briefing.js            daily AI morning briefing
    ├── options.js             first-class options recs: premium pricing, gauntlet, settlement
    └── backtest.js            threshold backtester (gap-aware fills, ladder+trail model, walk-forward)
public/                        dark terminal UI (vanilla JS + lightweight-charts)
test/                          unit suite (node --test; network-free) — run via ./UNIT_TEST.sh
UNIT_TEST.sh                   hand-run test runner (optional name-pattern argument)
```

## Data-flow at a glance

```
                              ┌────────────────────── SCAN PIPELINE ──────────────────────┐
 preferences ─► universe ─► OHLCV history ─► indicators ─► setup scores ─► shortlist (12)
 (watchlist      (stocks +    (Yahoo, cached)  (+ SPY rel.     (confluence-     │
  always in)      crypto)                       strength)       weighted)       ▼
                                                              news · sentiment · whales ·
                                                              earnings · options chains
                                                                                │
     market regime (SPY vs 200-DMA + F&G) ──────────────────────────────────────┤
     calibration (own shadow-graded track record) ──────────────────────────────┤
                                                                                ▼
                                                                        AI (strict JSON)
                                                                                │
                                                                                ▼
                                                    validateRec: clamp/gate every number
                                                    (see "The validation gauntlet" in
                                                     scanning.md) + duplicate guard
                                                                                │
                                                                                ▼
                                              recommendations table (+ full input snapshot)

                              ┌───────────────────── TRACKING (two cadences) ─────────────┐
 every 30 min   shadow-track ALL recs:  open ─entry-touch─► tracking ─stop─► stopped
                (gap backfill replays          │                      └final target─► target_hit
                 candles after downtime)       └never entered in time─► expired
 every 5 min    watch TAKEN trades: stop/target-cross alerts, option expiry countdown,
                dynamic stop suggestions (breakeven after T1, ATR chandelier trail)
```

## How a recommendation is born

1. **Universe** — built strictly from your preferences (stocks: popular list or your
   custom list; crypto: CoinGecko top-N or your list; exclusions honored).
2. **Analysis** — ~1y of daily OHLCV per symbol; every enabled indicator computed.
3. **Shortlist** — symbols scored against *your* thresholds (signals, volume, momentum,
   proximity to highs/lows); top ~12 proceed.
4. **Context** — headlines (global + per-symbol), Fear & Greed gauges, smart-money
   activity, earnings dates, and options chains (if enabled).
5. **AI** — one strict-JSON request: side, entry zone, stop, laddered targets with sell
   percentages, horizon, confidence, rationale, optional options play.
6. **Validation** — every number checked server-side: entry sanity vs the real price,
   stop on the correct side, ladder renormalized to 100%, confidence and
   **reward:risk gates** applied, options plays restricted to allowed strategies and
   enriched with chain economics. Hallucinations die here.
7. **Persistence** — the rec is stored *with its full input snapshot* (auditability).

## How it's tracked after that

- **Shadow tracking** (all recs, taken or not): entry-zone touch → `tracking`; stop
  crossed → `stopped`; full ladder → `target_hit`; entry never hit → `expired`. Weighted
  ladder P&L is computed so the Performance tab grades the system honestly.
- **Taken trades** (tight loop): alerts the moment price crosses your stop or a target
  rung; **dynamic stop suggestions** (breakeven after T1, ATR trail) with one-click apply;
  options get expiry countdowns; scheduled **AI health checks** issue
  hold/tighten/partial/sell verdicts.

## Scheduler loops

| Loop | Default cadence | Setting |
| --- | --- | --- |
| Market scan | off (manual) | `schedule.scan_enabled`, `scan_every_hours` / `scan_at_hour` |
| Taken-trades watch | 5 min | `schedule.track_open_trades_minutes` |
| Rec shadow-tracking | 30 min | `schedule.track_recommendations_minutes` |
| AI health checks | 12 h | `schedule.health_check_hours` (0 = manual only) |

All loops re-read settings each tick — changes apply without a restart.
