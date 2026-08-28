# REST API

Local-only Express API (`127.0.0.1:8210`), no auth (single-user tool). All bodies JSON.

## Scanning
| Endpoint | Purpose |
| --- | --- |
| `POST /api/scan` | Start a market scan (background; 409 if one is running). |
| `GET /api/scan/status` | `{running, step?}` + the last run summary/log. |
| `GET /api/runs` | Recent scan runs. |

## Recommendations
| Endpoint | Purpose |
| --- | --- |
| `GET /api/recommendations[?status=]` | List (with targets, options play, outcome, R:R, earnings chip data). |
| `GET /api/recommendations/:id` | Full detail including the input snapshot. |
| `POST /api/recommendations/:id/take` | Shares: `{qty, entry_price}`. Options play: `{instrument:"option", qty(contracts), entry_price(premium/share)}`. |
| `POST /api/recommendations/:id/dismiss` | Close an open/tracking rec. |

## Trades
| Endpoint | Purpose |
| --- | --- |
| `GET /api/trades[?status=open|closed]` | List; open rows include live last price, unrealized P&L (options ×100 off the chain mid), days-to-expiry, suggested stop, health verdict. |
| `POST /api/trades` | Manual trade. Options: `asset_type:"option"` + `option_details:{type,strike,expiry}`. |
| `PATCH /api/trades/:id` | Update the plan: `{stop_loss?, targets?}` (used by Apply-suggested-stop). |
| `POST /api/trades/:id/exit` | Record a partial/full exit `{price, qty, reason}`; closes at zero qty. |
| `POST /api/trades/health-check[?id=]` | AI health verdicts for all (or one) open position(s). |

## Market data
| Endpoint | Purpose |
| --- | --- |
| `GET /api/chart/:symbol?days=` | Candles + indicator series + latest snapshot (accepts `BTC`, `bitcoin`, `AAPL`…). |
| `GET /api/quote/:symbol` | Live quote (same symbol resolution). |
| `GET /api/search?q=` | Symbol/company search. |
| `GET /api/market` | Dashboard snapshot: indexes, BTC/ETH, sentiment, headlines, and the market `regime` (risk_on / neutral / risk_off from SPY vs 200-DMA + Fear & Greed). |
| `GET /api/whales` | Smart-money snapshot. |

## Watchlist
| Endpoint | Purpose |
| --- | --- |
| `GET /api/watchlist` | Watched symbols with live prices + alert state. |
| `POST /api/watchlist` | Add: `{symbol, alert_above?, alert_below?, note?}` (any spelling — resolver applies). |
| `PATCH /api/watchlist/:id` | Update alert levels/note (re-arms fired alerts). |
| `DELETE /api/watchlist/:id` | Remove. |

## Analysis extras
| Endpoint | Purpose |
| --- | --- |
| `POST /api/recommendations/:id/revalidate` | AI re-checks an open rec against current data → valid / adjust / withdraw. |
| `GET /api/briefing` · `POST /api/briefing` | Latest daily AI briefing / generate one now. |
| `POST /api/ai/selftest` | AI live self-test: proves each pipeline (JSON contract, tool calling, scan gauntlet, options pass, strategy compile) against the configured model in miniature; per-check pass/fail with failure text. |
| `GET /api/portfolio/risk` | Risk panel: total $ lost if every stop hits, no-stop flags, biggest single risk, per-position rows. |
| `GET /api/performance/attribution` | Outcomes split by source (scan/chat/options/your strategies), regime at entry, asset class; calibration drift; realized trade dollars. |
| `GET/POST /api/review/weekly` | The weekly AI review (latest / generate): a candid retrospective with what-I'd-change suggestions. |
| `GET /api/db/backups` · `POST /api/db/restore` | List backups (`?verify=1` integrity-checks each) / verified restore with an automatic pre-restore snapshot. |
| `GET/PUT /api/alerts` | Notification rules ("tell me when…"): list with labels / replace the set (state and cooldowns preserved by id). Evaluated every ~5 min; per-rule delivery `instant` or `digest` (folded into the daily briefing). |
| `GET /api/figures` · `POST /api/figures/follow` | Congressional trades: most-active politicians + latest filings (`?name=` filters to one person, option plays parsed from descriptions); follow/unfollow creates a `figure_filing` alert rule. |
| `GET /api/insiders/:symbol` | SEC Form 4 insider filings for a stock (FMP; degrades to a note on free-tier limits). |
| `POST /api/strategy/compile` | Plain-English strategy → validated spec (`{description}` → `{spec, notes}`); the spec is what actually runs — show it to the user. |
| `POST /api/strategy/run` | Run a strategy spec through the direction-aware simulator (long/short, options model-priced, crypto); `?critique=1` adds the AI feedback. Full metrics + walk-forward. |
| `GET/PUT/DELETE /api/strategies` | Saved, named, re-runnable strategies (PUT body `{spec}`; DELETE by `/:name`). |
| `GET /api/predict/:symbol` | Projection cone: `?horizon=1h..1y&interval=1d|1h` → quantile bands (p10–p90) from EWMA realized volatility, shaped for the chart axis, plus `at_horizon` endpoints and honest params/notes. |
| `POST /api/backtest` | Simulate your indicator thresholds over the past year: `{symbols?, min_signals?, exit_model? ('bracket'\|'ladder_trail'), slippage_pct?, fee_pct?, oos_split_pct?}`. Gap-aware fills; response includes portfolio metrics (`overall`: win rate, expectancy, profit factor, max drawdown) and an in-sample vs out-of-sample `walk_forward` split. |
| `GET /api/portfolio/concentration` | Sector/asset concentration warnings for open positions. |
| `GET /api/portfolio/equity` | Equity curves: realized closed-trade account curve + the what-if-every-rec-was-taken paper curve (risk-sized, sequential, no leverage), each with return/max-drawdown stats. |
| `POST /api/trades/import` | Import positions from a broker CSV export: `{"csv": "..."}`. Loose header matching (ticker/shares/avg-cost variants), duplicates skipped, rows land as open trades. |
| `GET /api/health/providers` | Data-source health: Yahoo circuit-breaker state, which provider keys are set, and human-readable hints (drives the topbar indicator). |
| `POST /api/db/backup` | Snapshot the SQLite database into `data/backups/` now (MySQL returns a use-mysqldump note). |
| `GET /api/export/trades.csv` · `/api/export/recommendations.csv` | CSV downloads (trades include `holding_days` + `tax_term` short/long columns). |

## AI
| Endpoint | Purpose |
| --- | --- |
| `POST /api/advisor-chat[?stream=1]` | Tool-calling chat. Non-streamed → `{reply, trace}`; `?stream=1` → NDJSON events (`tools`/`token`/`reset`/`done`). |
| `POST /api/ai/test` | Round-trip test of endpoint/model/key. |
| `POST /api/ai/models` | List models from an OpenAI-compatible endpoint (chat-capable filtered). |

## Settings & system
| Endpoint | Purpose |
| --- | --- |
| `GET /api/settings` | All settings (secrets masked as `•••`). |
| `PUT /api/settings/:block` | Replace one block (`ai`, `preferences`, `indicators`, `providers`, `schedule`, `notifications`). Sending `•••` keeps the stored secret. |
| `GET/PUT /api/db/config` | DB connection (ADVISOR_CONFIG.json); requires `--init-db` + restart to switch. |
| `POST /api/notify/test` | Send a test webhook notification. |
| `GET /api/performance` | Success-rate stats (recs + your trades). |
| `GET /api/events?limit=` | Activity feed (also drives browser notifications). |
| `GET /healthz` | Liveness. |
