# Trades & Position Management

The advisor covers the **whole lifecycle**: in (entries + sizing), managed (alerts,
dynamic stops, health checks), out (laddered exits, P&L). It never places orders —
you act at your broker; it makes sure you know *when*.

## Taking a trade

- **From a recommendation** — **✅ I took this trade** (shares/coins; quantity prefilled
  from your sizing settings, entry prefilled with the current price), or
  **🧾 Took the option** when the rec carries an options play (contracts + premium,
  prefilled with the chain's estimated premium).
- **Manual** — **＋ Log a manual trade**: stock, crypto, or option (call/put, strike,
  expiry; quantity = contracts; entry = premium per share).

Open positions show live last price, unrealized P&L, stop (with edit ✎), health chip,
and options show days-to-expiry.

## Alerts while you're in

The tight tracking loop (default 5 min) fires events/notifications when:
- price crosses your **stop** (⚠️) or any **target rung** (🎯 with the planned sell %),
- an option approaches **expiry** (7 / 2 / 0 days — theta is a schedule, not a surprise).

## Dynamic stop suggestions

Two advisors on your stop (Settings → risk → stops):
- **Breakeven after target 1** — once T1 hits, protect the entry.
- **ATR chandelier trail** — highest close since entry − `atr_multiple`×ATR(14) (mirrored
  for shorts); ratchets up as price runs.

The best (most protective) suggestion that meaningfully improves your current stop
appears in the Trades table (↑ price + basis) with one-click **Apply** — which updates
the tracked plan and logs a `stop_moved` event. You still move the real order at your
broker.

## 🩺 AI health checks — "when to sell"

Scheduled (default every 12 h) and on-demand (**Run health check**), the AI reviews every
open position with fresh indicators, price-vs-plan, days-in-trade vs horizon, news, and
(for options) days to expiry. Verdict per position:

| Verdict | Meaning |
| --- | --- |
| 🟢 `hold` | Thesis intact; plan unchanged. |
| 🟠 `tighten_stop` | Keep it, but move the stop (suggested level included). |
| 🟠 `take_partial` | De-risk: sell part here (note says how much). |
| 🔴 `sell_now` | Thesis broken or risk unacceptable; exit. |

Non-hold verdicts raise events/notifications; the chip + note live on the trade row.

## Options positions

- Suggested plays come **priced from the live chain**: estimated premium, breakeven,
  max loss per contract, IV.
- Logged option positions are **marked to market** off the current chain mid at their
  strike/expiry, with the ×100 contract multiplier applied to P&L.
- Health checks weigh theta explicitly (a losing option near expiry gets told the truth).

## Seeing the plan

Every recommendation card and open-trade row has a **📈 chart** button that opens the
Charts tab with the plan drawn on the candles: entry zone (cyan), stop (red), and each
target rung (green, with its sell %).

## Concentration warnings

With 2+ open positions, the Trades tab warns when ≥50% of them share one sector (via
Yahoo company profiles) or are all crypto — correlated risk you might not notice
position-by-position.

## Exits & P&L

**Exit…** records partial or full exits (price, quantity, reason). The trade closes when
quantity reaches zero; realized P&L and % are computed (×100 for options) and feed the
Performance tab. Closing a rec-linked trade also closes the recommendation.
