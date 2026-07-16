# Advisor Chat

The **💬 Advisor** button (next to ⚡ Scan market) opens a conversation drawer where the
AI has **live tool access to everything the tool knows**. It fetches exactly what each
question needs — never guessing prices or portfolio facts — and shows 🔧 chips revealing
which tools it consulted. Conversation persists in the browser (🗑 clears it).

## The AI's tools

| Tool | What it returns |
| --- | --- |
| `get_market_overview` | Index + BTC/ETH quotes, both Fear & Greed gauges, top headlines. |
| `get_quote` | Live quote — stocks or crypto, any spelling (`NVDA`, `BTC`, `bitcoin`). |
| `get_analysis` | Full indicator read with *your* thresholds + signals + next earnings. |
| `get_options_chain` | Near-the-money chain (stocks only): strikes, bid/ask, OI, IV. |
| `list_recommendations` / `get_recommendation` | The rec log with outcomes; full detail incl. the input snapshot. |
| `list_trades` | Your positions with live unrealized P&L. |
| `get_performance` | The honest track record (shadow-tracked outcomes + your trade P&L). |
| `get_news` | Headlines, optionally filtered to one symbol. |
| `get_smart_money` | Congressional trades (FMP key) + latest 13F filers. |
| `get_crypto_universe` | Top coins by market cap with prices and 24h/7d change. |
| `get_preferences` | Your preferences + indicator settings (it respects them). |
| `start_market_scan` | Launches a scan in the background. |
| `save_recommendation` | **Saves a chat-created trade idea** as a real, validated, shadow-tracked recommendation (same gates as scan recs: entry sanity, stop side, ladder = 100%, min R:R). |

## Slash commands

| Command | Does |
| --- | --- |
| `/help` | Commands + example questions. |
| `/analyze SYMBOL` | Full technical read — stocks or crypto (`/analyze NVDA`, `/analyze BTC`). |
| `/market` | Market overview: indexes, sentiment, headlines. |
| `/recs` | Review active recommendations vs their zones/targets. |
| `/portfolio` | Open trades vs their plans — what needs attention. |
| `/performance` | The system's track record, honestly. |
| `/news [SYMBOL]` | Market-moving headlines, optionally per symbol. |
| `/whales` | Smart-money activity. |
| `/ideas` | Fresh trade ideas within your preferences (full structure). |
| `/scan` | Launch a market scan. |
| `/clear` | Clear the conversation. |

## Example questions

- "What do you think of **AAPL** right now — worth an entry?"
- "Which of my open trades is closest to its stop?"
- "Is there anything oversold in my crypto universe?"
- "Why did you recommend that last NVDA trade, and how did it play out?"
- "Suggest an options play on MSFT within my comfort settings."
- "Create and track a trade idea for XRP with a buy zone, stop, and phased targets."
- "Given the fear index today, should I be cautious this week?"

The chat uses whatever model Settings points at. A bigger model (e.g. `qwen3-next:80b`
locally, or GPT-4-class) gives noticeably deeper reasoning for `/ideas`-style questions,
at the cost of slower replies. Replies **stream token-by-token**, with tool activity shown live as it consults data.
