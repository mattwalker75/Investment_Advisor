"use strict";
// Market regime read: a single top-level gate the scanner (and dashboard) consult before
// judging individual charts. Long setups in a market-wide downtrend have worse odds —
// this quantifies "which market are we in" from data the app already fetches:
//   - SPY vs its 200-day moving average (the classic trend line in the sand)
//   - the stock Fear & Greed gauge (crowd positioning)
// Verdict: 'risk_on' | 'neutral' | 'risk_off'. Advisory — it biases the AI's
// selectivity via the scan prompt; it never hard-blocks anything.
const yahoo = require("../providers/yahoo");
const sentiment = require("../providers/sentiment");

async function marketRegime() {
  const [candles, senti] = await Promise.all([
    yahoo.history("SPY", 365).catch(() => null),
    sentiment.snapshot().catch(() => ({})),
  ]);
  let spyVs200 = null;
  if (candles && candles.length >= 200) {
    const closes = candles.map((c) => c.close);
    const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
    spyVs200 = +(((closes[closes.length - 1] - sma200) / sma200) * 100).toFixed(2);
  }
  const fg = senti.stocks_fear_greed ? Number(senti.stocks_fear_greed.value) : null;

  let regime = "neutral";
  if (spyVs200 != null) {
    if (spyVs200 < -1 || (fg != null && fg <= 25)) regime = "risk_off";       // below trend or extreme fear
    else if (spyVs200 > 1 && (fg == null || fg >= 40)) regime = "risk_on";     // above trend, crowd not fearful
  } else if (fg != null) {
    regime = fg <= 25 ? "risk_off" : fg >= 60 ? "risk_on" : "neutral";
  }
  return {
    regime,
    spy_vs_200dma_pct: spyVs200,
    stocks_fear_greed: fg,
    note: regime === "risk_off" ? "market below trend / fearful — long setups face a headwind, be selective"
      : regime === "risk_on" ? "market above trend — the tailwind favors long setups"
      : "no strong market-wide bias either way",
  };
}

module.exports = { marketRegime };
