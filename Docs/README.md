# Investment Advisor — Documentation

Detailed documentation for the Investment Advisor. Start with the top-level
[README](../README.md) for the elevator pitch and quick start.

| Doc | What's inside |
| --- | --- |
| [Architecture](architecture.md) | Modules, the scan pipeline, how a recommendation is born, tracked, and graded. |
| [Configuration](configuration.md) | `ADVISOR_CONFIG.json` + every Settings block: AI, preferences, risk & sizing, indicators, schedule, notifications, data feeds. |
| [Scanning & Recommendations](scanning.md) | Universe + watchlist, shortlisting, AI analysis, validation gates (R:R, confidence, earnings), re-validation, shadow tracking, success scoring. |
| [Trades & Position Management](trades.md) | Taking trades, position sizing, dynamic stop suggestions, AI health checks, options positions, exits & P&L. |
| [Advisor Chat](advisor-chat.md) | The 💬 drawer: the AI's 13 tools, slash commands, example questions. |
| [Indicators](indicators.md) | Every technical indicator, its parameters, and how your buy/sell thresholds are used. |
| [Data Sources](data-sources.md) | Where every kind of data comes from, caching, rate-limit behavior, optional API keys. |
| [Database](database.md) | SQLite/MySQL setup, the schema, migrations, backup. |
| [API](api.md) | Every REST endpoint. |

> **Research tool — not financial advice.** The advisor analyzes and recommends; it never
> places orders. You decide, you trade, you own the outcomes.
