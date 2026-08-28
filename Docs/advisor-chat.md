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
| `run_backtest` | Backtests *your* thresholds mechanically (ladder+trail exit by default): win rate, expectancy, profit factor, max drawdown, in-sample vs out-of-sample. |
| `check_position_health` | Runs the real health-check engine on open positions (hold / tighten_stop / take_partial / sell_now). |
| `revalidate_recommendation` | Re-validates an open idea against current data (valid / adjust / withdraw) via the real engine. |
| `get_portfolio_concentration` | Sector concentration of your open positions + correlated-risk warnings. |
| `compare_symbols` | 2–5 symbols side-by-side on your indicators, incl. relative strength vs SPY. |
| `manage_watchlist` | List / add / remove watchlist entries and set price alerts (removal is confirm-first). |
| `update_trade` | Updates an open trade's stop/targets plan — **always confirms the exact levels with you first**. |
| `get_economic_calendar` | High-impact US macro events (FOMC, CPI, jobs…) for the coming days (needs the free FMP key). |
| `suggest_options_play` | Designs ONE options play within your allowed strategies, validated against the live chain (real strikes, premium from bid/ask mids, breakeven, max loss, IV); `save:true` tracks it as a premium-based shadow recommendation. |
| `manage_memory` | Durable notes that persist across conversations (see below). |

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

## Durable memory

The advisor can **remember things across conversations**. When you state a stable
preference or standing view ("I prefer 3–6 month holds", "don't pitch me airlines"), it
saves a short note with `manage_memory`; every future conversation starts with those
notes in context. Ask it to "list what you remember" or "forget the note about X" any
time. Notes live in your database (never sent anywhere but your configured model), are
capped at 40, and the chat history itself still lives only in your browser.

## Example questions

- "What do you think of **AAPL** right now — worth an entry?"
- "Which of my open trades is closest to its stop?"
- "Is there anything oversold in my crypto universe?"
- "Why did you recommend that last NVDA trade, and how did it play out?"
- "Suggest an options play on MSFT within my comfort settings."
- "Create and track a trade idea for XRP with a buy zone, stop, and phased targets."
- "Given the fear index today, should I be cautious this week?"
- "Should I still be holding my NVDA position?" *(runs the real health check)*
- "Compare NVDA, AMD and AVGO on my indicators."
- "Backtest my thresholds on the semis." · "Anything big on the macro calendar this week?"
- "Add SOL to my watchlist with an alert at 150." · "Raise the stop on trade 12 to 118." *(confirm-first)*
- "Remember that I want to keep at least 30% cash."

The chat uses whatever model Settings points at. A bigger model (e.g. `qwen3-next:80b`
locally, or GPT-4-class) gives noticeably deeper reasoning for `/ideas`-style questions,
at the cost of slower replies. Replies **stream token-by-token**, with tool activity shown live as it consults data.
