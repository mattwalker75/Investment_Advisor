"use strict";
// Technical indicators — pure functions over OHLCV candle arrays.
// Input: candles = [{ time, open, high, low, close, volume }] oldest -> newest.
// Each function returns an array aligned to candles (null until enough data exists),
// and computeAll() produces the compact "latest snapshot" the scanner feeds to the AI.

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      let s = 0; for (let j = 0; j < period; j++) s += values[j];
      prev = s / period; out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k); out[i] = prev;
    }
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(0, ch), l = Math.max(0, -ch);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) { const rs = loss === 0 ? Infinity : gain / loss; out[i] = 100 - 100 / (1 + rs); gain /= period; loss /= period; }
    } else {
      gain = (gain * (period - 1) + g) / period;      // Wilder smoothing
      loss = (loss * (period - 1) + l) / period;
      const rs = loss === 0 ? Infinity : gain / loss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalP = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  // Signal = EMA of the MACD line over its non-null region.
  const start = line.findIndex((v) => v != null);
  const valid = start >= 0 ? line.slice(start) : [];
  const sigValid = ema(valid, signalP);
  const signal = new Array(closes.length).fill(null);
  for (let i = 0; i < sigValid.length; i++) signal[start + i] = sigValid[i];
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

function bollinger(closes, period = 20, stddev = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null), lower = new Array(closes.length).fill(null), pctB = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + stddev * sd; lower[i] = mid[i] - stddev * sd;
    pctB[i] = upper[i] === lower[i] ? 0.5 : (closes[i] - lower[i]) / (upper[i] - lower[i]);
  }
  return { mid, upper, lower, pctB };
}

function stochastic(candles, kP = 14, dP = 3) {
  const k = new Array(candles.length).fill(null);
  for (let i = kP - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kP + 1; j <= i; j++) { hh = Math.max(hh, candles[j].high); ll = Math.min(ll, candles[j].low); }
    k[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const start = k.findIndex((v) => v != null);
  const dValid = sma(start >= 0 ? k.slice(start) : [], dP);
  const d = new Array(candles.length).fill(null);
  for (let i = 0; i < dValid.length; i++) d[start + i] = dValid[i];
  return { k, d };
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  let prev = null;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    if (i <= period) {
      prev = (prev || 0) + tr;
      if (i === period) { prev /= period; out[i] = prev; }
    } else { prev = (prev * (period - 1) + tr) / period; out[i] = prev; }
  }
  return out;
}

function adx(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;
  let trS = 0, pdmS = 0, ndmS = 0, dxs = [];
  let prevTr = null, prevPdm = null, prevNdm = null;
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    const pdm = up > dn && up > 0 ? up : 0;
    const ndm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close));
    if (i <= period) { trS += tr; pdmS += pdm; ndmS += ndm; if (i === period) { prevTr = trS; prevPdm = pdmS; prevNdm = ndmS; } }
    else { prevTr = prevTr - prevTr / period + tr; prevPdm = prevPdm - prevPdm / period + pdm; prevNdm = prevNdm - prevNdm / period + ndm; }
    if (i >= period && prevTr > 0) {
      const pdi = (prevPdm / prevTr) * 100, ndi = (prevNdm / prevTr) * 100;
      const dx = pdi + ndi === 0 ? 0 : (Math.abs(pdi - ndi) / (pdi + ndi)) * 100;
      dxs.push(dx);
      if (dxs.length === period) out[i] = dxs.reduce((a, b) => a + b, 0) / period;
      else if (dxs.length > period) out[i] = (out[i - 1] * (period - 1) + dx) / period;
    }
  }
  return out;
}

function obv(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const dir = candles[i].close > candles[i - 1].close ? 1 : candles[i].close < candles[i - 1].close ? -1 : 0;
    out[i] = out[i - 1] + dir * (candles[i].volume || 0);
  }
  return out;
}

function vwap(candles) {
  // Cumulative VWAP over the series (classic VWAP is per-session; over a daily series
  // this acts as a long-run volume-weighted anchor).
  const out = new Array(candles.length).fill(null);
  let pv = 0, vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    pv += typical * (candles[i].volume || 0); vol += candles[i].volume || 0;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
const round = (v, dp = 4) => (v == null || Number.isNaN(v) ? null : +v.toFixed(dp));

// Compute every ENABLED indicator (per user settings) and return:
//  - series: full arrays for charting overlays
//  - latest: the compact snapshot (numbers + human-readable signals) fed to the AI
function computeAll(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const price = last(closes);
  const series = {}, latest = { price: round(price, 4) };
  const signals = [];

  if (cfg.rsi && cfg.rsi.enabled) {
    series.rsi = rsi(closes, cfg.rsi.period);
    const v = round(last(series.rsi), 2);
    latest.rsi = v;
    if (v != null && v <= cfg.rsi.buy_below) signals.push(`RSI ${v} <= ${cfg.rsi.buy_below} (user buy zone)`);
    if (v != null && v >= cfg.rsi.sell_above) signals.push(`RSI ${v} >= ${cfg.rsi.sell_above} (user sell zone)`);
  }
  if (cfg.macd && cfg.macd.enabled) {
    const m = macd(closes, cfg.macd.fast, cfg.macd.slow, cfg.macd.signal);
    series.macd = m;
    const h = last(m.hist), hPrev = m.hist.length > 1 ? m.hist[m.hist.length - 2] : null;
    latest.macd = { line: round(last(m.line)), signal: round(last(m.signal)), hist: round(h) };
    if (h != null && hPrev != null && hPrev <= 0 && h > 0) signals.push("MACD bullish cross (hist flipped +)");
    if (h != null && hPrev != null && hPrev >= 0 && h < 0) signals.push("MACD bearish cross (hist flipped -)");
  }
  if (cfg.sma && cfg.sma.enabled) {
    const f = sma(closes, cfg.sma.fast), s = sma(closes, cfg.sma.slow);
    series.sma_fast = f; series.sma_slow = s;
    const lf = last(f), ls = last(s);
    latest.sma = { [`sma${cfg.sma.fast}`]: round(lf), [`sma${cfg.sma.slow}`]: round(ls) };
    if (lf != null && price != null) latest.sma.price_vs_fast_pct = round(((price - lf) / lf) * 100, 2);
    if (ls != null && price != null) latest.sma.price_vs_slow_pct = round(((price - ls) / ls) * 100, 2);
    if (lf != null && ls != null) signals.push(lf > ls ? `SMA${cfg.sma.fast} above SMA${cfg.sma.slow} (uptrend)` : `SMA${cfg.sma.fast} below SMA${cfg.sma.slow} (downtrend)`);
  }
  if (cfg.ema && cfg.ema.enabled) {
    series.ema = ema(closes, cfg.ema.period);
    latest[`ema${cfg.ema.period}`] = round(last(series.ema));
  }
  if (cfg.bollinger && cfg.bollinger.enabled) {
    const b = bollinger(closes, cfg.bollinger.period, cfg.bollinger.stddev);
    series.bollinger = b;
    const pb = last(b.pctB);
    latest.bollinger = { upper: round(last(b.upper)), lower: round(last(b.lower)), pctB: round(pb, 3) };
    if (pb != null && pb <= 0.05) signals.push("Price at/below lower Bollinger band (oversold)");
    if (pb != null && pb >= 0.95) signals.push("Price at/above upper Bollinger band (overbought)");
  }
  if (cfg.stochastic && cfg.stochastic.enabled) {
    const s = stochastic(candles, cfg.stochastic.k, cfg.stochastic.d);
    series.stochastic = s;
    const kv = round(last(s.k), 2), dv = round(last(s.d), 2);
    latest.stochastic = { k: kv, d: dv };
    if (kv != null && kv <= cfg.stochastic.buy_below) signals.push(`Stochastic %K ${kv} <= ${cfg.stochastic.buy_below} (user buy zone)`);
    if (kv != null && kv >= cfg.stochastic.sell_above) signals.push(`Stochastic %K ${kv} >= ${cfg.stochastic.sell_above} (user sell zone)`);
  }
  if (cfg.atr && cfg.atr.enabled) {
    series.atr = atr(candles, cfg.atr.period);
    const v = last(series.atr);
    latest.atr = round(v);
    if (v != null && price) latest.atr_pct = round((v / price) * 100, 2);
  }
  if (cfg.adx && cfg.adx.enabled) {
    series.adx = adx(candles, cfg.adx.period);
    const v = round(last(series.adx), 2);
    latest.adx = v;
    if (v != null) signals.push(v >= cfg.adx.trend_min ? `ADX ${v} (trending)` : `ADX ${v} (weak/rangebound)`);
  }
  if (cfg.obv && cfg.obv.enabled) {
    series.obv = obv(candles);
    const o = series.obv, n = o.length;
    if (n > 21) {
      const slope = o[n - 1] - o[n - 21];
      latest.obv_20d_trend = slope > 0 ? "rising" : slope < 0 ? "falling" : "flat";
    }
  }
  if (cfg.vwap && cfg.vwap.enabled) {
    series.vwap = vwap(candles);
    latest.vwap = round(last(series.vwap));
  }

  // Context stats every analysis wants regardless of indicator selection.
  const n = closes.length;
  if (n >= 2) latest.change_1d_pct = round(((closes[n - 1] - closes[n - 2]) / closes[n - 2]) * 100, 2);
  if (n >= 6) latest.change_5d_pct = round(((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100, 2);
  if (n >= 21) latest.change_20d_pct = round(((closes[n - 1] - closes[n - 21]) / closes[n - 21]) * 100, 2);
  const hi = Math.max(...candles.map((c) => c.high)), lo = Math.min(...candles.map((c) => c.low));
  latest.pct_off_period_high = round(((price - hi) / hi) * 100, 2);
  latest.pct_off_period_low = round(((price - lo) / lo) * 100, 2);
  const vols = candles.map((c) => c.volume || 0);
  if (n >= 21) {
    const avg20 = vols.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20;
    if (avg20 > 0) latest.volume_vs_20d_avg = round(vols[n - 1] / avg20, 2);
  }

  latest.signals = signals;
  return { series, latest };
}

module.exports = { sma, ema, rsi, macd, bollinger, stochastic, atr, adx, obv, vwap, computeAll };
