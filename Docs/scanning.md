# Scanning & Recommendations

The scanner turns your preferences + live market data into concrete, validated,
fully-logged trade recommendations. Trigger: **⚡ Scan market**, `/scan` in chat,
`POST /api/scan`, or the schedule.

## The pipeline

1. **Universe** — from preferences only, **plus your Watchlist** (watched symbols always
   join the scan and get a shortlist priority boost). Stocks: the built-in "popular" large-cap list or
   *only* your custom list. Crypto: CoinGecko top-N by market cap (stablecoins filtered)
   or your list. Exclusions honored. Both classes flow through the same Yahoo OHLCV
   pipeline (crypto as `SYMBOL-USD`).
2. **Indicator analysis** — ~1 year of daily candles per symbol; every enabled indicator
   computed with your parameters.
3. **Shortlist (~12)** — setup score per symbol: 2 pts per threshold signal you defined
   (e.g. RSI under your buy level, MACD cross, Bollinger extremes), plus volume spikes,
   5-day momentum, proximity to period high/low.
4. **Context gathering** — recent headlines (global + matched per candidate), stock &
   crypto Fear-and-Greed, congressional trades (with FMP key) + fresh 13F filers,
   **next earnings date** per stock, options chains (if options enabled).
5. **AI analysis** — one strict-JSON request against your configured model with rules:
   respect asset classes and risk tolerance, entries near the real price, stops on the
   correct side, 1–3 laddered targets summing to 100%, honest confidence, options plays
   only from your allowed strategies, and earnings-risk rules (below).
6. **Validation** — the recommender clamps/rejects: symbols not in candidates, entry
   zones >±25% from the real price, stop on the wrong side, empty ladders, ladder
   percentages renormalized to 100, confidence below `min_confidence`, and
   **reward:risk below `min_risk_reward`** (ladder-weighted reward vs entry→stop risk).
   Single-leg option plays are enriched with chain economics (premium/breakeven/max loss).

## Anatomy of a recommendation

| Field | Meaning |
| --- | --- |
| side | `buy` (long idea) or `sell` (exit/avoid/short signal). |
| entry zone | Realistic limit-order band (`entry_low`–`entry_high`). |
| stop loss | Risk line; sized with ATR/support by the AI, validated server-side. |
| targets | Laddered exits: sell X% at each rung (e.g. 25/50/25). |
| horizon | Rough estimated days-in-trade (min–max). An estimate, not a promise. |
| confidence | Model's honest 0–1; gated by your minimum. |
| R:R | Ladder-weighted reward vs risk; gated by your minimum. |
| rationale | Why — grounded in the indicators/news/sentiment it was shown. |
| options play | Optional; enriched with est. premium, breakeven, max loss, IV. |
| ⚠ earnings | Chip shown when earnings land inside the trade horizon. |
| inputs | Full snapshot of everything the AI saw (auditability). |

**Suggested position size** is computed from your account size and risk-per-trade %:
`qty = (account × risk%) / |entry_mid − stop|` — shown on the card and prefilled in the
take-trade dialog.

## Earnings rules

Stock candidates carry `next_earnings` (date + days away). With
`avoid_earnings_days = N` (default 3), the AI must not recommend a new entry within N
days of earnings (unless explicitly framed as an earnings play within your risk
tolerance) and must state the earnings date in the rationale when it falls inside the
horizon. The rec card shows an **⚠ earnings Nd** chip.

## Lifecycle & honest scoring

```
open ──(entry zone touched)──> tracking ──> target_hit  (full ladder; weighted P&L)
  │                                  └────> stopped     (stop crossed; weighted P&L)
  └──(entry never hit in rec_expiry_days)──> expired
Any open/tracking rec can also be dismissed (closed).
```

Any open recommendation can be **♻ Re-validated** — one click asks the AI to re-check the
idea against current data: **valid** (stands), **adjust** (entry/stop updated in place), or
**withdraw** (closed as stale).

Every recommendation is **shadow-tracked against real prices even if you never take
it** — targets hit earn their rung, the remainder exits at the stop. The Performance tab
therefore reflects *everything the system said*, not just your picks: win rate, average
outcome, per-asset breakdown, and whether each graded rec was actually taken.
