# Data Sources

Free-first and pluggable: the tool works out of the box with keyless sources; optional
keys unlock or upgrade specific data. Every fetch is cached in the database and degrades
gracefully — a dead feed or throttled endpoint never kills a scan.

| Data | Priority chain | Key? |
| --- | --- | --- |
| Crypto quotes | **CoinGecko → Yahoo** | no |
| Crypto candles | **Coinbase Exchange → Yahoo** (Yahoo only for coins Coinbase lacks) | no |
| Stock quotes | **Finnhub → FMP → Yahoo → Alpha Vantage** | free keys recommended |
| Stock candles (daily) | **FMP → Yahoo** | free key recommended |
| Options chains | **CBOE delayed quotes → Yahoo** (15-min delayed; fine for advisory) | no |
| Earnings dates, symbol search | Yahoo only (no free alternative; degrade gracefully) | no |
| Crypto universe (top-N by mcap) | CoinGecko | no |
| News headlines | Your RSS list (MarketWatch, CNBC, Yahoo, CoinDesk, Cointelegraph… editable) | no |
| Stock sentiment | CNN Fear & Greed | no |
| Crypto sentiment | alternative.me Fear & Greed | no |
| Institutional 13F filers | SEC EDGAR "latest filings" (official) | no |
| Congressional trades | Financial Modeling Prep | **yes — free key** (`fmp_key`) |

## Recommended setup: two free keys

Yahoo throttles hard (hours-long IP blocks) — with these two free keys it drops out of
the hot path entirely and becomes a background fallback:

- **FMP** (financialmodelingprep.com, 250 req/day): stock daily candles + quote fallback
  + company profiles + **congressional trades**.
- **Finnhub** (finnhub.io, 60 req/min): high-frequency stock quotes (market strip, trade
  tracking).

Crypto needs no keys at all (CoinGecko + Coinbase). The market strip uses SPY/QQQ/DIA
ETF proxies so keyed sources can serve it. Alpha Vantage remains a last-resort quote
fallback (its free tier is 25 req/day — too small to be a primary).

## Caching & politeness

- All provider responses cache in the DB (`cache` table) with per-kind TTLs
  (Settings → Data feeds → cache minutes: quotes 5, history 60, news 30, sentiment 60,
  whales 720 by default).
- On a fetch failure the **stale cache is served** rather than erroring.
- Yahoo calls are **serialized with a 300 ms minimum gap** (it throttles bursts hard).
  If Yahoo does rate-limit the machine, you'll see a clear message; it clears on its own
  (minutes to an hour) and cached data keeps working meanwhile.

## Notes & caveats

- **Yahoo is unofficial** — stable for years but no SLA. `yahoo-finance2` is pinned to
  2.13.3 (v2.14+ is a transitional rewrite missing most modules — don't upgrade until it
  reaches parity).
- **Congressional trades**: the keyless aggregators (CapitolTrades, the Stock Watcher S3
  buckets) block server-side fetches or are defunct — hence the free FMP key. Without
  it, scans simply run without congress data (13F still works).
- **Crypto symbol resolution** (`src/resolve.js`): "BTC" / "bitcoin" / "BTC-USD" all map
  to the Yahoo `-USD` pair via the CoinGecko top-100. Ticker collisions (LINK the coin
  vs LINK the stock) default to well-known equities; `-USD` always forces crypto; the
  chat AI can pass an explicit asset_type hint.
- **Failover chains** (when Yahoo errors/throttles — it rate-limits aggressively and
  blocks can last hours):
  - Crypto candles → **Coinbase Exchange** (keyless, real OHLCV). Crypto quotes → CoinGecko.
  - Stock candles → **FMP** (`fmp_key` — the same free key that enables congressional
    trades). Stock quotes → Finnhub → FMP → Alpha Vantage (whichever keys are set).
  - A **circuit breaker** pauses all Yahoo calls for 5 minutes after a 429 so retries
    never keep the block alive; cached data serves meanwhile.
  - Options chains, earnings dates, and intraday candles remain Yahoo-only (no free
    alternative).
- **Intraday**: the 5D chart range uses hourly candles (`interval=1h`).
