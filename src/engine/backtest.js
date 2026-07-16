"use strict";
// Threshold backtester: replays the past year of daily candles and simulates entering
// whenever YOUR indicator buy-thresholds fire, with a mechanical bracket exit — so you
// can sanity-check your settings before trusting them.
//
// Simulation rules (deliberately simple and mechanical — this tests YOUR THRESHOLDS,
// not the AI):
//   ENTER long at next open when >= `min_signals` buy signals fire on a close
//     (RSI <= buy_below, Stoch %K <= buy_below, price <= lower Bollinger band,
//      MACD hist flips positive) while SMA fast > slow if the SMA indicator is enabled.
//   STOP  = entry − 2×ATR(14).  TARGET = entry + min_risk_reward × 2×ATR (your R:R).
//   EXIT at stop/target touch (stop checked first on the same bar), or after 30 bars.
// One position per symbol at a time. No fees/slippage — treat results as directional.
const settings = require("../settings");
const yahoo = require("../providers/yahoo");
const indicators = require("../indicators");

function signalsAt(i, series, cfg, closes) {
  const sig = [];
  const rsi = series.rsi && series.rsi[i];
  if (cfg.rsi && cfg.rsi.enabled && rsi != null && rsi <= cfg.rsi.buy_below) sig.push("rsi");
  const st = series.stochastic && series.stochastic.k[i];
  if (cfg.stochastic && cfg.stochastic.enabled && st != null && st <= cfg.stochastic.buy_below) sig.push("stoch");
  if (cfg.bollinger && cfg.bollinger.enabled && series.bollinger && series.bollinger.lower[i] != null && closes[i] <= series.bollinger.lower[i]) sig.push("bb");
  if (cfg.macd && cfg.macd.enabled && series.macd && i > 0) {
    const h = series.macd.hist[i], hp = series.macd.hist[i - 1];
    if (h != null && hp != null && hp <= 0 && h > 0) sig.push("macd");
  }
  return sig;
}

function trendOk(i, series, cfg) {
  if (!cfg.sma || !cfg.sma.enabled || !series.sma_fast) return true;
  const f = series.sma_fast[i], s = series.sma_slow[i];
  return f == null || s == null ? true : f > s;
}

async function backtestSymbol(symbol, cfg, minRR, minSignals) {
  const candles = await yahoo.history(symbol, 400);
  if (!candles || candles.length < 120) return null;
  const closes = candles.map((c) => c.close);
  const { series } = indicators.computeAll(candles, cfg);
  const atr = series.atr || indicators.atr(candles, 14);

  const trades = [];
  let pos = null;
  for (let i = 60; i < candles.length - 1; i++) {
    if (!pos) {
      const sig = signalsAt(i, series, cfg, closes);
      if (sig.length >= minSignals && trendOk(i, series, cfg) && atr[i]) {
        const entry = candles[i + 1].open;
        const risk = 2 * atr[i];
        pos = { entry_i: i + 1, entry, stop: entry - risk, target: entry + minRR * risk, signals: sig };
      }
      continue;
    }
    const c = candles[i];
    let exit = null;
    if (c.low <= pos.stop) exit = { price: pos.stop, reason: "stop" };
    else if (c.high >= pos.target) exit = { price: pos.target, reason: "target" };
    else if (i - pos.entry_i >= 30) exit = { price: c.close, reason: "time" };
    if (exit) {
      trades.push({ entry: +pos.entry.toFixed(4), exit: +exit.price.toFixed(4), reason: exit.reason,
        pnl_pct: +(((exit.price - pos.entry) / pos.entry) * 100).toFixed(2),
        bars_held: i - pos.entry_i, signals: pos.signals, date: c.time });
      pos = null;
    }
  }
  if (!trades.length) return { symbol, trades: 0 };
  const wins = trades.filter((t) => t.pnl_pct > 0);
  return {
    symbol, trades: trades.length, wins: wins.length,
    win_rate: +((wins.length / trades.length) * 100).toFixed(1),
    avg_pnl_pct: +(trades.reduce((s, t) => s + t.pnl_pct, 0) / trades.length).toFixed(2),
    total_pnl_pct: +trades.reduce((s, t) => s + t.pnl_pct, 0).toFixed(2),
    last_trades: trades.slice(-5),
  };
}

// Run over a symbol list (default: the stock universe or its first 25). min_signals: how
// many buy-thresholds must fire together (2 = default).
async function run(symbols, minSignals = 2) {
  const s = settings.getSync();
  const cfg = s.indicators;
  const minRR = s.preferences.risk.min_risk_reward || 1.5;
  if (!symbols || !symbols.length) {
    const prefs = s.preferences;
    const scanner = require("./scanner");
    symbols = (prefs.stocks.universe === "custom" && prefs.stocks.custom_symbols.length
      ? prefs.stocks.custom_symbols : scanner.POPULAR_STOCKS).slice(0, 25);
  }
  symbols = symbols.slice(0, 30);   // keep runtime + provider load sane
  const results = [];
  for (const sym of symbols) {
    try { const r = await backtestSymbol(String(sym).toUpperCase(), cfg, minRR, minSignals); if (r) results.push(r); }
    catch (_) { /* per-symbol tolerance */ }
  }
  const traded = results.filter((r) => r.trades > 0);
  const allTrades = traded.reduce((s2, r) => s2 + r.trades, 0);
  const allWins = traded.reduce((s2, r) => s2 + (r.wins || 0), 0);
  return {
    config: { min_signals: minSignals, rr: minRR, stop: "2×ATR", max_hold_bars: 30 },
    symbols_tested: results.length,
    symbols_with_trades: traded.length,
    total_trades: allTrades,
    overall_win_rate: allTrades ? +((allWins / allTrades) * 100).toFixed(1) : null,
    avg_pnl_pct: allTrades ? +(traded.reduce((s2, r) => s2 + r.avg_pnl_pct * r.trades, 0) / allTrades).toFixed(2) : null,
    by_symbol: results.sort((a, b) => (b.total_pnl_pct || 0) - (a.total_pnl_pct || 0)),
  };
}

module.exports = { run };
