"use strict";
// Threshold backtester: replays the past ~400 days of daily candles and simulates
// entering whenever YOUR indicator buy-thresholds fire — so you can sanity-check your
// settings before trusting them. It tests YOUR THRESHOLDS, not the AI.
//
// ENTRY (both exit models): >= `min_signals` buy signals fire on a close (RSI/Stoch at
// buy zone, close at/below lower Bollinger, MACD hist flips +) while SMA fast > slow if
// the SMA indicator is enabled. Enter at NEXT OPEN, paying `slippage_pct`.
//
// EXIT MODELS:
//   'bracket' (simple): stop = entry − 2×ATR, single target = entry + min_RR × 2×ATR,
//     time exit after 30 bars.
//   'ladder_trail' (mirrors how the LIVE system manages trades): three laddered targets
//     (1R / minRR·R / 1.75·minRR·R at 30/40/30%), stop moves to breakeven after rung 1
//     and trails with the ATR chandelier — both per your Preferences → stops settings.
//     Time exit after 60 bars (ladders need room). This is the model to trust: it tests
//     the exit management the tool actually recommends.
//
// REALISM: fills are gap-aware (a bar that OPENS beyond the stop/target fills at the
// open, not the level — no fantasy fills), every exit pays `slippage_pct`, and
// `fee_pct` is charged per round trip. Long-only (the signal set is buy-side).
//
// REPORTING: per-symbol stats plus portfolio-level risk metrics (profit factor,
// expectancy, avg win/loss, max drawdown of the compounded sequence) — and everything is
// split in-sample vs OUT-OF-SAMPLE (the most recent `oos_split_pct`% of the window), so
// you can see whether a threshold set generalizes or was curve-fit to old data.
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

// Gap-aware SELL fill at a level: a bar opening beyond it fills at the open.
const fillStop = (bar, level) => (bar.open <= level ? bar.open : bar.low <= level ? level : null);
const fillTarget = (bar, level) => (bar.open >= level ? bar.open : bar.high >= level ? level : null);

async function backtestSymbol(symbol, cfg, opt) {
  const candles = await yahoo.history(symbol, 400);
  if (!candles || candles.length < 120) return null;
  const closes = candles.map((c) => c.close);
  const { series } = indicators.computeAllCached(`bt:${symbol}`, candles, cfg);
  const atr = series.atr || indicators.atr(candles, 14);
  const slip = opt.slippage_pct / 100;
  const sell = (px) => px * (1 - slip);                  // exits give up slippage
  const roundTripFee = opt.fee_pct * 2;
  const stopsCfg = opt.stops || {};

  const trades = [];
  let pos = null;
  const closeTrade = (i, exitInfo) => {
    trades.push({
      entry: +pos.entry.toFixed(4), exit: +exitInfo.avg.toFixed(4), reason: exitInfo.reason,
      pnl_pct: +(exitInfo.pnl_pct - roundTripFee).toFixed(2),
      bars_held: i - pos.entry_i, signals: pos.signals, date: candles[i].time,
    });
    pos = null;
  };

  for (let i = 60; i < candles.length - 1; i++) {
    if (!pos) {
      const sig = signalsAt(i, series, cfg, closes);
      if (sig.length >= opt.min_signals && trendOk(i, series, cfg) && atr[i]) {
        const entry = candles[i + 1].open * (1 + slip);  // pay up on entry
        const risk = 2 * atr[i];
        pos = { entry_i: i + 1, entry, risk, stop: entry - risk, signals: sig, maxClose: entry, filled: [] };
        if (opt.exit_model === "ladder_trail") {
          const rr = opt.min_rr;
          pos.rungs = [
            { price: entry + 1.0 * risk, sell_pct: 30 },
            { price: entry + rr * risk, sell_pct: 40 },
            { price: entry + rr * 1.75 * risk, sell_pct: 30 },
          ];
        } else {
          pos.target = entry + opt.min_rr * risk;
        }
      }
      continue;
    }
    const c = candles[i];

    if (opt.exit_model === "ladder_trail") {
      // Live-style management: ratchet the stop (breakeven after rung 1, ATR chandelier
      // trail), then check stop FIRST (conservative on same-bar ambiguity), then rungs.
      pos.maxClose = Math.max(pos.maxClose, c.close);
      if (stopsCfg.breakeven_after_target1 !== false && pos.filled.length >= 1) pos.stop = Math.max(pos.stop, pos.entry);
      if (stopsCfg.atr_trailing !== false && atr[i]) pos.stop = Math.max(pos.stop, pos.maxClose - (stopsCfg.atr_multiple || 3) * atr[i]);

      const stopPx = fillStop(c, pos.stop);
      if (stopPx != null) {
        const pctLeft = 100 - pos.filled.reduce((s, f) => s + f.sell_pct, 0);
        // Already-filled rungs settle at their ACTUAL fill (r.fill: gap/slippage-adjusted),
        // never the raw rung level.
        const fills = [...pos.filled.map((r) => ({ price: r.fill, sell_pct: r.sell_pct })), { price: sell(stopPx), sell_pct: pctLeft }];
        finishLadder(i, fills, pos, closeTrade, pos.filled.length ? "trail_stop" : "stop");
        continue;
      }
      for (const r of pos.rungs) {
        if (pos.filled.includes(r)) continue;
        const px = fillTarget(c, r.price);
        if (px != null) { pos.filled.push(r); r.fill = sell(px); }
      }
      if (pos.filled.length === pos.rungs.length) {
        finishLadder(i, pos.filled.map((r) => ({ price: r.fill, sell_pct: r.sell_pct })), pos, closeTrade, "ladder_complete");
        continue;
      }
      if (i - pos.entry_i >= 60) {
        const pctLeft = 100 - pos.filled.reduce((s, f) => s + f.sell_pct, 0);
        const fills = [...pos.filled.map((r) => ({ price: r.fill, sell_pct: r.sell_pct })), { price: sell(c.close), sell_pct: pctLeft }];
        finishLadder(i, fills, pos, closeTrade, "time");
      }
      continue;
    }

    // bracket model — stop first (conservative), gap-aware fills
    const stopPx = fillStop(c, pos.stop);
    const tgtPx = stopPx == null ? fillTarget(c, pos.target) : null;
    let exitPx = null, reason = null;
    if (stopPx != null) { exitPx = sell(stopPx); reason = "stop"; }
    else if (tgtPx != null) { exitPx = sell(tgtPx); reason = "target"; }
    else if (i - pos.entry_i >= 30) { exitPx = sell(c.close); reason = "time"; }
    if (exitPx != null) closeTrade(i, { avg: exitPx, pnl_pct: ((exitPx - pos.entry) / pos.entry) * 100, reason });
  }

  if (!trades.length) return { symbol, trades: 0 };
  const wins = trades.filter((t) => t.pnl_pct > 0);
  return {
    symbol, trades: trades.length, wins: wins.length,
    win_rate: +((wins.length / trades.length) * 100).toFixed(1),
    avg_pnl_pct: +(trades.reduce((s, t) => s + t.pnl_pct, 0) / trades.length).toFixed(2),
    total_pnl_pct: +trades.reduce((s, t) => s + t.pnl_pct, 0).toFixed(2),
    exit_reasons: trades.reduce((m, t) => ((m[t.reason] = (m[t.reason] || 0) + 1), m), {}),
    last_trades: trades.slice(-5),
    all_trades: trades,           // consumed (and stripped) by the aggregate step
  };
}

// Weighted ladder close: each fill earns its sell_pct of the position.
function finishLadder(i, fills, pos, closeTrade, reason) {
  const pnl = fills.reduce((s, f) => s + (f.sell_pct / 100) * (((f.price - pos.entry) / pos.entry) * 100), 0);
  const avg = fills.reduce((s, f) => s + (f.sell_pct / 100) * f.price, 0);
  closeTrade(i, { avg, pnl_pct: pnl, reason });
}

// Portfolio-level risk metrics over a chronologically-sorted trade list. Drawdown is on
// the compounded sequence (each trade's pnl% applied to the running equity in exit-date
// order) — a proxy, since real concurrency/position-sizing isn't modeled here.
function metrics(trades) {
  if (!trades.length) return { trades: 0 };
  const wins = trades.filter((t) => t.pnl_pct > 0), losses = trades.filter((t) => t.pnl_pct <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl_pct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_pct, 0));
  let eq = 1, peak = 1, maxDd = 0;
  for (const t of trades) {
    eq *= 1 + t.pnl_pct / 100;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  return {
    trades: trades.length,
    win_rate: +((wins.length / trades.length) * 100).toFixed(1),
    expectancy_pct: +(trades.reduce((s, t) => s + t.pnl_pct, 0) / trades.length).toFixed(2),
    avg_win_pct: wins.length ? +(grossWin / wins.length).toFixed(2) : null,
    avg_loss_pct: losses.length ? +(-grossLoss / losses.length).toFixed(2) : null,
    profit_factor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,   // null = no losses in sample
    max_drawdown_pct: +(maxDd * 100).toFixed(1),
    compounded_return_pct: +((eq - 1) * 100).toFixed(1),
  };
}

// Run over a symbol list (default: the stock universe or its first 25).
// opts: { min_signals, slippage_pct, fee_pct, exit_model: 'bracket'|'ladder_trail',
//         oos_split_pct } — a bare number is accepted as min_signals for back-compat.
async function run(symbols, opts = {}) {
  if (typeof opts === "number") opts = { min_signals: opts };
  const s = settings.getSync();
  const cfg = s.indicators;
  const opt = {
    min_signals: Number(opts.min_signals) || 2,
    min_rr: s.preferences.risk.min_risk_reward || 1.5,
    slippage_pct: opts.slippage_pct != null && isFinite(opts.slippage_pct) ? Math.max(0, Number(opts.slippage_pct)) : 0.1,
    fee_pct: opts.fee_pct != null && isFinite(opts.fee_pct) ? Math.max(0, Number(opts.fee_pct)) : 0,
    exit_model: opts.exit_model === "ladder_trail" ? "ladder_trail" : "bracket",
    oos_split_pct: opts.oos_split_pct != null ? Math.min(60, Math.max(10, Number(opts.oos_split_pct))) : 30,
    stops: s.preferences.risk.stops || {},
  };
  if (!symbols || !symbols.length) {
    const prefs = s.preferences;
    const scanner = require("./scanner");
    symbols = (prefs.stocks.universe === "custom" && prefs.stocks.custom_symbols.length
      ? prefs.stocks.custom_symbols : scanner.POPULAR_STOCKS).slice(0, 25);
  }
  symbols = symbols.slice(0, 30);   // keep runtime + provider load sane
  const results = [];
  for (const sym of symbols) {
    try { const r = await backtestSymbol(String(sym).toUpperCase(), cfg, opt); if (r) results.push(r); }
    catch (_) { /* per-symbol tolerance */ }
  }

  // Aggregate: pool every trade, sort chronologically, compute portfolio metrics and the
  // in-sample vs out-of-sample split (last oos_split_pct% of the DATE SPAN is OOS).
  const all = results.flatMap((r) => r.all_trades || []).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const r of results) delete r.all_trades;
  let split = null;
  if (all.length >= 10) {
    const t0 = Date.parse(all[0].date), t1 = Date.parse(all[all.length - 1].date);
    if (isFinite(t0) && isFinite(t1) && t1 > t0) {
      const cutoff = t0 + (t1 - t0) * (1 - opt.oos_split_pct / 100);
      const inS = all.filter((t) => Date.parse(t.date) < cutoff);
      const oos = all.filter((t) => Date.parse(t.date) >= cutoff);
      if (inS.length && oos.length) {
        split = {
          cutoff_date: new Date(cutoff).toISOString().slice(0, 10),
          in_sample: metrics(inS),
          out_of_sample: metrics(oos),
          note: "If out-of-sample is much worse than in-sample, the thresholds are curve-fit — don't trust the headline numbers.",
        };
      }
    }
  }

  const traded = results.filter((r) => r.trades > 0);
  return {
    config: {
      min_signals: opt.min_signals, rr: opt.min_rr, exit_model: opt.exit_model,
      stop: "2×ATR" + (opt.exit_model === "ladder_trail" ? " + breakeven/ATR-trail per your stops settings" : ""),
      max_hold_bars: opt.exit_model === "ladder_trail" ? 60 : 30,
      slippage_pct: opt.slippage_pct, fee_pct_per_side: opt.fee_pct,
    },
    symbols_tested: results.length,
    symbols_with_trades: traded.length,
    total_trades: all.length,
    overall: metrics(all),
    walk_forward: split,
    by_symbol: results.sort((a, b) => (b.total_pnl_pct || 0) - (a.total_pnl_pct || 0)),
  };
}

module.exports = { run, metrics };
