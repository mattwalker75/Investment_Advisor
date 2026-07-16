# Investment Advisor

An AI-powered **stock, options & crypto trading advisor** that runs entirely on your
machine. It scans the market, analyzes technicals + news + sentiment + smart-money
activity, and tells you **when to buy, when to sell, and where your stop loss belongs** —
with every recommendation logged and honestly graded. It never places orders; it makes
sure *you* never miss the moment.

> **Research tool — not financial advice.** You decide, you trade, you own the outcomes.

## What it does

- **⚡ Scans the market** within *your* preferences (stocks/crypto/both, your universe,
  your indicator thresholds, your risk tolerance) and produces complete trade ideas:
  entry zone · stop loss · **phased sell targets** (e.g. 25/50/25%) · estimated duration
  · confidence · **reward:risk** (weak ideas auto-rejected) · rationale grounded in real
  data · earnings-risk flags · optional options play with breakeven and max loss.
- **📏 Sizes positions** for your account: "risk 1% of $10k → 83 shares."
- **📐 Manages the ride**: alerts when price crosses your stop or a target rung, suggests
  stop raises (breakeven after target 1, ATR trailing), counts down option expiries.
- **🩺 Tells you when to sell**: scheduled AI health checks on every open position —
  HOLD / TIGHTEN STOP / TAKE PARTIAL / SELL NOW, with reasoning.
- **📈 Charts** with opt-in indicator overlays; **💬 Advisor chat** with live access to
  all your data (`/help` for commands); **🔔 notifications** to your phone via ntfy /
  Discord / Slack.
- **📊 Grades itself honestly** — every recommendation is shadow-tracked against real
  prices *even if you skip it*; the Performance tab shows the true win rate, confidence
  calibration, and a **backtester** for your indicator thresholds.
- **👀 Watchlist** with price alerts and scan priority; **📰 daily AI briefing**;
  **♻ re-validate** any idea against current data; plans drawn right on the charts;
  CSV export; quote failover when the free data source throttles.

Runs on **any OpenAI-compatible AI** (OpenAI, or fully local via Ollama / LM Studio) and
**SQLite (default) or MySQL** — all configurable in the web UI.

## Quick start

```bash
./ADVISOR.sh --setup     # install deps + create config + initialize the DB
./ADVISOR.sh --start     # → http://localhost:8210
```

Then in the UI: **Settings → AI model** (pick provider + model, Test connection) →
**Settings → Preferences** (what you trade, risk, sizing) → **⚡ Scan market**.

```
./ADVISOR.sh --setup | --start | --stop | --restart | --status | --logs
             --init-db | --reset-db
```

## Documentation

Detailed docs live in [**Docs/**](Docs/README.md):

| | |
| --- | --- |
| [Architecture](Docs/architecture.md) | Modules, the scan pipeline, tracking loops. |
| [Configuration](Docs/configuration.md) | Every setting: AI, preferences, risk & sizing, schedule, notifications. |
| [Scanning & Recommendations](Docs/scanning.md) | How ideas are generated, validated, and honestly scored. |
| [Trades & Position Management](Docs/trades.md) | Sizing, dynamic stops, health checks, options, exits. |
| [Advisor Chat](Docs/advisor-chat.md) | The AI's tools, slash commands, examples. |
| [Indicators](Docs/indicators.md) | Every indicator and how your thresholds drive decisions. |
| [Data Sources](Docs/data-sources.md) | Free-first providers, caching, optional keys. |
| [Database](Docs/database.md) | SQLite/MySQL, schema, migrations, backup. |
| [API](Docs/api.md) | REST endpoints. |

Changes are tracked in [CHANGELOG.md](CHANGELOG.md).
