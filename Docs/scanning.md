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
   5-day momentum, proximity to period high/low — **confluence-weighted**: signals from
   independent families (trend / momentum / mean-reversion / volume / divergence /
   relative strength) earn a bonus, so three corroborating reads outrank three flavors of
   the same oversold extreme. Beyond your configured indicators, every symbol also gets
   three derived reads: **ATR percentile** (volatility regime), **RSI divergence** vs
   recent price extremes, and **63-day relative strength vs SPY**.
4. **Context gathering** — recent headlines (global + matched per candidate), stock &
   crypto Fear-and-Greed, congressional trades (with FMP key) + fresh 13F filers,
   **next earnings date** per stock, options chains (if options enabled).
5. **AI analysis** — one strict-JSON request against your configured model with rules:
   respect asset classes and risk tolerance, entries near the real price, stops on the
   correct side, 1–3 laddered targets summing to 100%, honest confidence, options plays
   only from your allowed strategies, and earnings-risk rules (below). The prompt also
   carries the **market regime** (SPY vs 200-DMA + Fear & Greed → risk_on / neutral /
   risk_off, with a be-more-selective rule for longs in risk_off) and — once at least ~8
   recommendations have finished — the model's **own shadow-graded track record per
   confidence bucket**, so it can correct a miscalibrated confidence scale.
6. **Validation** — the gauntlet below. Hallucinations die here.

## The validation gauntlet

This is the tool's core safety guarantee: **no AI-produced number reaches the database
unchecked.** Every recommendation — from a scan *or* saved via the advisor chat — passes
through `validateRec` (`src/engine/recommender.js`), which applies, in order:

| Check | Rule | On failure |
| --- | --- | --- |
| Symbol | Must be one of the candidates it was shown | dropped |
| Side | `sell` while shorts are disabled | dropped |
| Entry zone | Missing bounds default to the live price; low/high swapped if inverted | fixed |
| Entry sanity | Zone must sit within **±25% of the real current price** | dropped |
| Stop side | Below entry for buys, above for sells (defaults to ∓7% if missing) | fixed |
| Targets | Only rungs beyond the entry on the correct side count; max 3; **≥1 required** | dropped if none |
| Ladder sum | `sell_pct` values renormalized to exactly 100% | fixed |
| Confidence | Clamped 0–1; must be ≥ `risk.min_confidence` | dropped |
| Reward:risk | Ladder-weighted reward vs entry-mid→stop risk must be ≥ `risk.min_risk_reward` | dropped |
| Options play | Strategy must be in your allowed list; single-leg plays enriched with real chain economics (premium/breakeven/max loss/IV) | play removed |
| Duplicates | A same-side idea overlapping an active rec's entry zone (or within 5% of its midpoint) is refused | dropped |

The same P&L rule grades every finished recommendation everywhere (tracker, offline gap
backfill, manual complete): hit targets earn their rung's percentage, the remaining
position exits at the residual price (stop / live price / last price).

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
