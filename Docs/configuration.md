# Configuration

Two layers:

1. **`ADVISOR_CONFIG.json`** (project root, gitignored) — ONLY the database connection.
   Template: `ADVISOR_CONFIG_template.json`. After changing: `./ADVISOR.sh --init-db`
   then `--restart`.
2. **Everything else lives in the database** (`settings` table) and is edited from the
   web UI **Settings** tab. Stored values are deep-merged over defaults, so new options
   appear automatically after upgrades.

## ADVISOR_CONFIG.json

```jsonc
{
  "db": {
    "dialect": "sqlite",                          // or "mysql"
    "sqlite": { "file": "data/advisor.db" },
    "mysql":  { "host": "127.0.0.1", "port": 3306, "user": "advisor",
                "password": "...", "database": "investment_advisor" }
  }
}
```

## Environment variables (optional)

| Variable | Meaning |
| --- | --- |
| `PORT` | Listen port (default `8210`; always bound to `127.0.0.1`). |
| `ADVISOR_CONFIG` | Path to an alternate `ADVISOR_CONFIG.json` (useful for a scratch/test instance). |
| `ADVISOR_ALLOWED_HOSTS` | Comma-separated extra hostnames the Host/Origin security guard accepts (e.g. a tailnet name behind a proxy). Localhost is always allowed. Add authentication before exposing beyond localhost. |
| `ADVISOR_WEBHOOK_ALLOW_LOCAL` | `1` to let the notification webhook target loopback/link-local addresses (e.g. ntfy running on this same machine). Refused by default (SSRF guard). |

## Settings blocks (web UI → Settings)

### 🤖 AI (`ai`)
| Key | Meaning |
| --- | --- |
| `base_url` | Any OpenAI-compatible endpoint. Presets: Ollama `http://localhost:11434/v1`, OpenAI `https://api.openai.com/v1`, LM Studio `http://localhost:1234/v1`. |
| `api_key` | Required by OpenAI; empty for local. Masked in the UI once saved. |
| `model` | Pick from the live dropdown (↻ Load models queries the endpoint) or type one. |
| `temperature`, `max_tokens` | Generation knobs (0.3 / 4000 default). |
| `task_models.scan` | Optional model override for the heavy reasoning tasks: scan recommender, revalidation, health checks. Empty = `model`. |
| `task_models.light` | Optional cheap/fast model for headline grading + the daily briefing. Empty = `model`. |
| `scan_batching` | How the recommender batches the shortlist: `single` (one call, default), `grouped` (~4 candidates per call — steadier on local models), `per_candidate` (deepest: no cross-candidate bleed or truncation risk, slowest). Grouped/per-candidate runs show live per-group progress in the scan log. |
| `failover` | Optional `{enabled, base_url, api_key, model}` tried **once** when the primary endpoint hard-fails (network error, 5xx, timeout). Empty URL/key inherit the primary's. Off by default; the key is masked like the others. |

Structured output: JSON-producing calls request `response_format: json_object`
automatically; endpoints that reject it are detected and it's dropped for them (the
robust JSON extractor remains the safety net either way).

### 🎯 Preferences (`preferences`)
- `asset_classes` — `{stocks, crypto}`; untick one to go single-class. The scanner never
  strays outside this.
- `stocks.universe` — `popular` (built-in liquid large caps) or `custom` (scan ONLY
  `custom_symbols`); `exclude_symbols` are never recommended.
- `crypto.universe` — `top` (CoinGecko top `top_n` by market cap) or `custom`
  (`custom_symbols` accepts ids, tickers, or names: `bitcoin`, `SOL`, `ETH-USD`).
- `risk`:
  | Key | Default | Meaning |
  | --- | --- | --- |
  | `risk_tolerance` | moderate | conservative / moderate / aggressive — passed to the AI. |
  | `allow_shorts` | true | Include SELL-side (short) ideas. Off = long ideas only — enforced in the AI prompt AND validation (scan + chat-created recs). |
  | `max_recommendations_per_scan` | 5 | Quality over quantity cap. |
  | `min_confidence` | 0.55 | Recs below this are dropped. |
  | `min_risk_reward` | 1.5 | Ladder-weighted reward vs entry→stop risk; below = dropped. |
  | `account_size` | 10000 | For position-sizing suggestions (advisory only). |
  | `risk_per_trade_pct` | 1.0 | "Risk X% per trade" → suggested share/coin counts. |
  | `avoid_earnings_days` | 3 | Flag/avoid new stock entries this close to earnings (0 = off). |
  | `stops.breakeven_after_target1` | true | Suggest moving the stop to entry once T1 hits. |
  | `stops.atr_trailing` / `atr_multiple` | true / 3 | ATR chandelier trail suggestions. |

### 🧾 Options (`preferences.options`)
`enabled` master switch; per-strategy comfort checkboxes (`long_call`, `long_put`,
`covered_call`, `cash_secured_put`, `call_spread`, `put_spread`); `max_dte`; free-form
`notes` passed to the AI. Suggested plays are enriched with estimated premium, breakeven,
and max loss per contract from the live chain.

### 📐 Indicators (`indicators`)
Per indicator: `enabled` + parameters + your buy/sell thresholds. All enabled indicators
feed the AI and the shortlist scoring; charts draw only what you toggle. See
[Indicators](indicators.md).

### ⏰ Scanning & tracking (`schedule`)
`scan_enabled`, `scan_every_hours` (or daily `scan_at_hour`),
`track_open_trades_minutes` (5), `track_recommendations_minutes` (30),
`rec_expiry_days` (10 — entry never hit → expired), `health_check_hours` (12; 0 = manual),
`briefing_enabled` / `briefing_hour` (daily AI briefing at a local hour).
`backup_enabled` / `backup_keep` — daily SQLite backup into `data/backups/` (on by
default, newest 14 kept, fires when the newest backup is >24h old). The DB is the entire
accumulated track record; a **Back up now** button lives in Settings → Database. MySQL
users: schedule `mysqldump` externally instead.

### 👁 View (`view`)
Show/hide main tabs (Recommendations, Charts, Watchlist, Trades, Performance) and
individual cards on the Dashboard and Performance tabs. **Display-only** — the AI's
analysis, scanning, and tracking always run regardless of what's visible.

### 🔔 Notifications (`notifications`)
- `browser` — desktop notifications while the page is open.
- `webhook_url` — ONE URL, format auto-detected: `ntfy.sh/<topic>` (plain POST),
  Discord webhook (`{content}`), Slack webhook (`{text}`). Masked once saved.
- `notify_on` — gates per category: `stops_targets`, `stop_suggestions`, `health`, `scans`, `briefing`, `custom_alerts` (the rules engine).
- `quiet_hours` — `{enabled, start_hour, end_hour}` (local time; the window may wrap
  midnight). Webhook delivery pauses inside it — **except crossed stops**, which always
  break through. Events still land in the Activity feed.
- **Alert rules** (Settings → Notifications, or via chat's `manage_alerts`): programmable
  "tell me when…" triggers evaluated every ~5 minutes — price levels on any symbol,
  daily moves > X% (a symbol / your watchlist / your positions), a rec entering its
  entry zone, earnings within N days on a position, high-impact macro events, a followed
  politician filing a trade, portfolio drawdown, data-source degradation. Each rule has
  a cooldown and a delivery mode: `instant` (feed + browser + webhook) or `digest`
  (queued quietly and folded into the next daily briefing).

#### Phone push in 3 minutes (ntfy) — alerts with the browser CLOSED

The whole point of the tracker is catching a stop being crossed while you're away; the
webhook is what makes that reach your phone:

1. Install the **ntfy** app ([ntfy.sh](https://ntfy.sh) — iOS/Android, free).
2. In the app, **subscribe to a topic** — pick something unguessable, e.g.
   `matt-advisor-x7k2q` (the topic name is the only secret).
3. In the tool: **Settings → Notifications → Webhook URL** =
   `https://ntfy.sh/matt-advisor-x7k2q`, then **Send test** — your phone should buzz.
4. Tick the `notify_on` categories you want. Done — stops, targets, health verdicts, and
   option-expiry countdowns now reach your phone with the app closed.

Deliveries are **priority-mapped** so your phone treats them accordingly: a crossed stop
or expiring option sends as `urgent` (ntfy can break through Do-Not-Disturb if you allow
it), health verdicts and target hits as `high`, scans/briefings as `low`. Self-hosted
ntfy on your LAN works too (use its URL); ntfy on this same machine needs
`ADVISOR_WEBHOOK_ALLOW_LOCAL=1` (SSRF guard).

### 📡 Data feeds (`providers`)
`news_feeds` (RSS URLs, one per line), optional keys: `fmp_key` (enables congressional
trades), `alpha_vantage_key` / `finnhub_key` (stock-quote **failover** when Yahoo throttles; crypto
falls back to CoinGecko automatically), and
`cache_minutes` per data kind. See [Data Sources](data-sources.md).
