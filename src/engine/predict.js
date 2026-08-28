"use strict";
// Predictive analysis: a PROJECTION CONE for any stock or crypto — where the price is
// statistically likely to be at a chosen horizon, with ranges that honestly WIDEN with
// time. This is a probability range derived from realized volatility (lognormal
// quantiles under geometric Brownian motion, EWMA-weighted vol, drift shrunk hard
// toward zero because short-history drift is mostly noise). It is NOT a directional
// forecast — the AI layer (chat's get_prediction) adds the directional read separately
// and must state its confidence against these bands.
const yahoo = require("../providers/yahoo");

// horizon key → trading-day span + which candle timeframe estimates vol best.
const HORIZONS = {
  "1h": { days: 1 / 6.5, timeframe: "1h" },
  "4h": { days: 4 / 6.5, timeframe: "1h" },
  "1d": { days: 1, timeframe: "1h" },
  "1w": { days: 5, timeframe: "1d" },
  "1m": { days: 21, timeframe: "1d" },
  "3m": { days: 63, timeframe: "1d" },
  "6m": { days: 126, timeframe: "1d" },
  "1y": { days: 252, timeframe: "1d" },
};
const QUANTILES = { p10: -1.2816, p25: -0.6745, p50: 0, p75: 0.6745, p90: 1.2816 };

// EWMA (RiskMetrics λ=0.94) annualized volatility + mean drift from log returns.
function estimateParams(closes, perYear) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 20) return null;
  const lambda = 0.94;
  let v = rets[0] * rets[0];
  for (let i = 1; i < rets.length; i++) v = lambda * v + (1 - lambda) * rets[i] * rets[i];
  const sigma = Math.sqrt(v * perYear);
  const meanDrift = (rets.reduce((s, r) => s + r, 0) / rets.length) * perYear;
  // Drift shrinkage: sample drift is mostly noise at these history lengths — keep 25%
  // of it and clamp to ±30%/yr so the cone never bakes in a heroic trend.
  const drift = Math.max(-0.3, Math.min(0.3, meanDrift * 0.25));
  return { sigma, drift, samples: rets.length };
}

// Quantile price after t years: S·exp((μ − σ²/2)t + σ√t·z)
const quantilePrice = (S, drift, sigma, tYears, z) =>
  S * Math.exp((drift - sigma * sigma / 2) * tYears + sigma * Math.sqrt(tYears) * z);

// Future time axis: daily horizons → calendar-date strings (weekends skipped),
// intraday → epoch seconds — matching what the chart's current interval uses.
function futureTimes(lastTime, steps, horizonDays, timeframe) {
  const out = [];
  if (timeframe === "1h") {
    const t0 = typeof lastTime === "number" ? lastTime : Math.floor(Date.parse(lastTime + "T21:00:00Z") / 1000);
    const totalSec = horizonDays * 6.5 * 3600;
    for (let k = 1; k <= steps; k++) out.push(Math.round(t0 + (totalSec * k) / steps));
    return out;
  }
  let d = new Date(typeof lastTime === "number" ? lastTime * 1000 : Date.parse(lastTime + "T00:00:00Z"));
  const perStep = Math.max(1, Math.round(horizonDays / steps));
  let added = 0;
  while (added < steps) {
    let tradingDays = 0;
    while (tradingDays < perStep) {
      d = new Date(d.getTime() + 86400000);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) tradingDays++;
    }
    out.push(d.toISOString().slice(0, 10));
    added++;
  }
  return out;
}

// The cone. `interval` = the CHART's candle interval ('1d' or '1h') so band timestamps
// match the axis they'll be drawn on.
async function projectionCone(symbol, horizon, { interval = "1d" } = {}) {
  const h = HORIZONS[horizon];
  if (!h) throw new Error(`unknown horizon "${horizon}" — use one of: ${Object.keys(HORIZONS).join(" ")}`);
  // Vol estimation: prefer the horizon's natural timeframe, fall back to daily scaled.
  let candles = null, perYear, timeframe = h.timeframe;
  if (timeframe === "1h") {
    candles = await yahoo.history(symbol, 12, "1h").catch(() => null);
    perYear = 252 * 6.5;
    if (!candles || candles.length < 40) { timeframe = "1d"; candles = null; }
  }
  if (!candles) {
    candles = await yahoo.history(symbol, 365, "1d");
    perYear = 252;
  }
  const closes = candles.map((c) => c.close);
  const S = closes[closes.length - 1];
  const params = estimateParams(closes, perYear);
  if (!params) throw new Error("not enough history to estimate volatility for " + symbol);

  const steps = 24;
  const times = futureTimes(candles[candles.length - 1].time, steps, h.days, interval);
  const bands = {};
  for (const [q, z] of Object.entries(QUANTILES)) {
    bands[q] = times.map((time, k) => {
      const tYears = (h.days * ((k + 1) / steps)) / 252;
      return { time, value: +quantilePrice(S, params.drift, params.sigma, tYears, z).toFixed(S >= 100 ? 2 : 4) };
    });
  }
  const tEnd = h.days / 252;
  const at_horizon = Object.fromEntries(Object.entries(QUANTILES).map(([q, z]) =>
    [q, +quantilePrice(S, params.drift, params.sigma, tEnd, z).toFixed(S >= 100 ? 2 : 4)]));

  return {
    symbol, horizon, price: S,
    params: {
      sigma_annual_pct: +(params.sigma * 100).toFixed(1),
      drift_annual_pct: +(params.drift * 100).toFixed(1),
      vol_timeframe: timeframe, samples: params.samples,
    },
    bands, at_horizon,
    band_width_pct: +(((at_horizon.p90 - at_horizon.p10) / S) * 100).toFixed(1),
    note: "Probability range from realized volatility (lognormal quantiles, EWMA vol, drift shrunk toward zero) — the range WIDENS with the horizon by design. Not a directional forecast: at this horizon there is a ~10% chance of being below p10 and ~10% above p90.",
  };
}

module.exports = { projectionCone, estimateParams, quantilePrice, HORIZONS };
