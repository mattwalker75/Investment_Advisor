# Technical Indicators

All enabled indicators are computed on ~1 year of daily candles for every scanned
symbol and **fed to the AI as decision inputs**; your buy/sell thresholds also drive the
scan shortlist scoring. Charts draw only the overlays you toggle — hiding an overlay
never hides it from the AI.

Configure in **Settings → 📐 Technical indicators** (enable + parameters + thresholds).

| Indicator | Parameters | Thresholds / signal produced |
| --- | --- | --- |
| **RSI** | period (14) | `buy_below` (35) / `sell_above` (70) — momentum exhaustion zones. |
| **MACD** | fast 12 / slow 26 / signal 9 | Bullish/bearish histogram cross (momentum shift). |
| **SMA** | fast 50 / slow 200 | Trend regime (fast above/below slow) + price distance from each. |
| **EMA** | period (21) | Short-term dynamic support/resistance level. |
| **Bollinger** | period 20 / stddev 2 | %B ≤ 0.05 oversold, ≥ 0.95 overbought (band extremes). |
| **Stochastic** | %K 14 / %D 3 | `buy_below` (20) / `sell_above` (80). |
| **ATR** | period (14) | Volatility (absolute + % of price) — sizes stops and the chandelier trail. |
| **ADX** | period 14 / `trend_min` 20 | Trend strength: trending vs range-bound filter. |
| **OBV** | — | 20-day volume-flow trend (rising/falling/flat) — confirmation. |
| **VWAP** | — | Long-run volume-weighted anchor (off by default; per-series, not intraday). |

Also always computed as context: 1/5/20-day % change, % off period high/low, and
volume vs 20-day average.

## How thresholds are used

1. **Shortlisting** — each threshold hit ("RSI 31 ≤ 35 (user buy zone)", "MACD bullish
   cross", "price at lower Bollinger band") scores points; the most signal-rich charts
   go to the AI.
2. **AI input** — the exact signal strings appear in each candidate's data, so the model
   reasons with *your* rules, and its rationale cites them.
3. **Dynamic stops** — ATR feeds the chandelier trailing-stop suggestions on open trades.

## Chart overlays

In the Charts tab, toggle chips: SMA, EMA, BB, VWAP, Volume (main pane) and RSI, MACD
(sub-panes with 70/30 guides and histogram). Symbol box accepts stocks and crypto in any
spelling; ranges 3M–2Y.
