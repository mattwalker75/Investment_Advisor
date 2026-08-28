"use strict";
// The Strategy Lab: "here's MY strategy — test it and tell me if it works."
//
// A strategy is a small declarative SPEC (below). The user writes it directly, or
// describes it in plain English and the AI compiles it to the spec (always shown back —
// nothing hidden). The runner replays it bar-by-bar through a direction-aware simulator
// built on the same honesty rules as the threshold backtester: gap-aware fills,
// slippage on every fill, fees per round trip, walk-forward split, full metrics.
//
// SPEC:
// {
//   name, description?,
//   timeframe: "1d" | "1h",            // 1h is capped by what free intraday sources return (~2-3 months)
//   direction: "long" | "short",
//   universe: ["NVDA", ...] | "stocks" | "crypto",
//   entry: { logic: "all"|"any", conditions: [ { left, op, right } ... ] },
//     // left/right: an OPERAND name (below) or a number (right only)
//     // op: < <= > >= crosses_above crosses_below rising falling
//   exit: {
//     stop: { type: "atr", multiple: 2 } | { type: "pct", pct: 5 },
//     targets: [ { rr: 1, sell_pct: 50 }, { rr: 2, sell_pct: 50 } ],   // R-multiples of the stop distance
//     trail: { atr_multiple: 3, breakeven_after_target1: true } | null,
//     max_hold_bars: 30,
//   },
//   instrument: null | { type: "option", strategy: "long_call"|"long_put", dte: 30, moneyness_pct: 0 },
//     // options are MODEL-PRICED (Black-Scholes from realized volatility) — no free
//     // historical chains exist. Results carry a clear model-priced label.
//   days: 400,
// }
//
// OPERANDS: close open high low volume rsi stoch_k stoch_d adx atr atr_pct sma_fast
// sma_slow ema vwap bb_upper bb_mid bb_lower bb_pctb macd_line macd_signal macd_hist
const settings = require("../settings");
const yahoo = require("../providers/yahoo");
const indicators = require("../indicators");
const { metrics } = require("./backtest");
const { J } = require("../util");

const OPS = new Set(["<", "<=", ">", ">=", "crosses_above", "crosses_below", "rising", "falling"]);
const OPERANDS = new Set(["close", "open", "high", "low", "volume", "rsi", "stoch_k", "stoch_d", "adx",
  "atr", "atr_pct", "sma_fast", "sma_slow", "ema", "vwap", "bb_upper", "bb_mid", "bb_lower", "bb_pctb",
  "macd_line", "macd_signal", "macd_hist"]);

// ---- Spec validation: whitelist everything, clamp all numbers. Throws with a
// human-readable reason (surfaced to the UI / the compiling model for a retry). ----
function validateSpec(raw) {
  if (!raw || typeof raw !== "object") throw new Error("spec must be an object");
  const spec = {
    name: String(raw.name || "unnamed strategy").slice(0, 60),
    description: String(raw.description || "").slice(0, 400),
    timeframe: raw.timeframe === "1h" ? "1h" : "1d",
    direction: raw.direction === "short" ? "short" : "long",
    universe: raw.universe,
    entry: { logic: raw.entry && raw.entry.logic === "any" ? "any" : "all", conditions: [] },
    exit: {},
    instrument: null,
    days: 0,
  };
  if (Array.isArray(raw.universe)) {
    spec.universe = raw.universe.map((s) => String(s).toUpperCase().trim()).filter(Boolean).slice(0, 30);
    if (!spec.universe.length) throw new Error("universe list is empty");
  } else if (raw.universe === "crypto") spec.universe = "crypto";
  else spec.universe = "stocks";

  const conds = (raw.entry && Array.isArray(raw.entry.conditions)) ? raw.entry.conditions : [];
  if (!conds.length) throw new Error("entry.conditions is empty — a strategy needs at least one entry condition");
  for (const c of conds.slice(0, 8)) {
    const left = String(c.left || "");
    const op = String(c.op || "");
    if (!OPERANDS.has(left)) throw new Error(`unknown operand "${left}" — allowed: ${[...OPERANDS].join(" ")}`);
    if (!OPS.has(op)) throw new Error(`unknown op "${op}" — allowed: ${[...OPS].join(" ")}`);
    let right = c.right;
    if (op === "rising" || op === "falling") right = Math.max(1, Math.min(50, Math.round(Number(right) || 1)));
    else if (typeof right === "number" && isFinite(right)) right = +right;
    else if (OPERANDS.has(String(right))) right = String(right);
    else throw new Error(`condition right side must be a number or an operand name (got ${JSON.stringify(c.right)})`);
    spec.entry.conditions.push({ left, op, right });
  }

  const ex = raw.exit || {};
  const stop = ex.stop || {};
  spec.exit.stop = stop.type === "pct"
    ? { type: "pct", pct: Math.max(0.2, Math.min(50, Number(stop.pct) || 5)) }
    : { type: "atr", multiple: Math.max(0.5, Math.min(10, Number(stop.multiple) || 2)) };
  let targets = Array.isArray(ex.targets) ? ex.targets
    .map((t) => ({ rr: Math.max(0.2, Math.min(20, Number(t.rr) || 0)), sell_pct: Math.max(1, Math.min(100, Math.round(t.sell_pct || 0))) }))
    .filter((t) => t.rr > 0).slice(0, 3) : [];
  if (!targets.length) targets = [{ rr: 2, sell_pct: 100 }];
  targets.sort((a, b) => a.rr - b.rr);
  const sum = targets.reduce((s, t) => s + t.sell_pct, 0);
  if (sum !== 100) {
    let acc = 0;
    targets = targets.map((t, i) => { const pct = i === targets.length - 1 ? 100 - acc : Math.max(1, Math.round((t.sell_pct / sum) * 100)); acc += pct; return { ...t, sell_pct: pct }; });
  }
  spec.exit.targets = targets;
  spec.exit.trail = ex.trail ? {
    atr_multiple: Math.max(0.5, Math.min(10, Number(ex.trail.atr_multiple) || 3)),
    breakeven_after_target1: ex.trail.breakeven_after_target1 !== false,
  } : null;
  spec.exit.max_hold_bars = Math.max(2, Math.min(500, Math.round(ex.max_hold_bars || (spec.timeframe === "1h" ? 100 : 30))));

  if (raw.instrument && raw.instrument.type === "option") {
    spec.instrument = {
      type: "option",
      strategy: raw.instrument.strategy === "long_put" ? "long_put" : "long_call",
      dte: Math.max(5, Math.min(365, Math.round(raw.instrument.dte || 30))),
      moneyness_pct: Math.max(-20, Math.min(20, Number(raw.instrument.moneyness_pct) || 0)),
    };
    if (spec.timeframe !== "1d") throw new Error("option instruments are daily-timeframe only (model-priced per daily bar)");
  }
  spec.days = Math.max(60, Math.min(1825, Math.round(raw.days || (spec.timeframe === "1h" ? 60 : 400))));
  // Live-signal flags: `live` makes the strategy a SCREENER (entry conditions evaluated
  // on the freshest bar on a schedule); `signal_to_rec` additionally turns each signal
  // into a validated, shadow-tracked recommendation.
  spec.live = raw.live === true;
  spec.signal_to_rec = raw.signal_to_rec === true;
  return spec;
}

// ---- Black-Scholes model pricing for option instruments (no free historical chains
// exist, so option legs are model-priced from realized volatility — labeled as such). ----
function cnd(x) {   // standard normal CDF (Abramowitz–Stegun)
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function bsPrice(type, S, K, T, sigma, r = 0.04) {
  if (T <= 0 || sigma <= 0) return type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / sq;
  const d2 = d1 - sq;
  const call = S * cnd(d1) - K * Math.exp(-r * T) * cnd(d2);
  return type === "call" ? call : call - S + K * Math.exp(-r * T);
}
// Annualized realized volatility from the trailing `n` closes ending at index i.
function realizedVol(closes, i, n = 20, perYear = 252) {
  const from = Math.max(1, i - n + 1);
  const rets = [];
  for (let k = from; k <= i; k++) rets.push(Math.log(closes[k] / closes[k - 1]));
  if (rets.length < 5) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr * perYear);
}

// ---- Operand arrays + condition evaluation ----
function buildOperands(candles, series) {
  const n = candles.length;
  const arr = (get) => Array.from({ length: n }, (_, i) => get(i));
  const ratio = (a, b) => (a != null && b ? a / b : null);
  return {
    close: arr((i) => candles[i].close), open: arr((i) => candles[i].open),
    high: arr((i) => candles[i].high), low: arr((i) => candles[i].low),
    volume: arr((i) => candles[i].volume || 0),
    rsi: series.rsi || [], adx: series.adx || [], atr: series.atr || [],
    atr_pct: (series.atr || []).map((v, i) => ratio(v == null ? null : v * 100, candles[i].close)),
    stoch_k: (series.stochastic && series.stochastic.k) || [], stoch_d: (series.stochastic && series.stochastic.d) || [],
    sma_fast: series.sma_fast || [], sma_slow: series.sma_slow || [], ema: series.ema || [], vwap: series.vwap || [],
    bb_upper: (series.bollinger && series.bollinger.upper) || [], bb_mid: (series.bollinger && series.bollinger.mid) || [],
    bb_lower: (series.bollinger && series.bollinger.lower) || [], bb_pctb: (series.bollinger && series.bollinger.pctB) || [],
    macd_line: (series.macd && series.macd.line) || [], macd_signal: (series.macd && series.macd.signal) || [],
    macd_hist: (series.macd && series.macd.hist) || [],
  };
}
function operandAt(ops, name, i) {
  const a = ops[name];
  return a && a[i] != null ? a[i] : null;
}
function condTrue(c, ops, i) {
  const L = operandAt(ops, c.left, i);
  if (L == null) return false;
  if (c.op === "rising" || c.op === "falling") {
    const prev = operandAt(ops, c.left, i - c.right);
    if (prev == null) return false;
    return c.op === "rising" ? L > prev : L < prev;
  }
  const R = typeof c.right === "number" ? c.right : operandAt(ops, c.right, i);
  if (R == null) return false;
  switch (c.op) {
    case "<": return L < R;
    case "<=": return L <= R;
    case ">": return L > R;
    case ">=": return L >= R;
    case "crosses_above": {
      const Lp = operandAt(ops, c.left, i - 1);
      const Rp = typeof c.right === "number" ? c.right : operandAt(ops, c.right, i - 1);
      return Lp != null && Rp != null && Lp <= Rp && L > R;
    }
    case "crosses_below": {
      const Lp = operandAt(ops, c.left, i - 1);
      const Rp = typeof c.right === "number" ? c.right : operandAt(ops, c.right, i - 1);
      return Lp != null && Rp != null && Lp >= Rp && L < R;
    }
    default: return false;
  }
}
function entryAt(spec, ops, i) {
  const results = spec.entry.conditions.map((c) => condTrue(c, ops, i));
  return spec.entry.logic === "any" ? results.some(Boolean) : results.every(Boolean);
}

// ---- Direction-aware simulator (long AND short), gap-aware, slippage + fees. ----
const SLIP = 0.001, FEE_RT = 0;   // 0.1% per fill, fees settable later via opts
function simulateSymbol(symbol, candles, series, spec, opt = {}) {
  const slip = opt.slippage_pct != null ? opt.slippage_pct / 100 : SLIP;
  const feeRt = opt.fee_pct != null ? opt.fee_pct * 2 : FEE_RT;
  const ops = buildOperands(candles, series);
  const closes = ops.close;
  const dir = spec.direction === "short" ? -1 : 1;
  // gap-aware fills, direction-aware: an adverse level (stop) fills at the open when the
  // bar opens beyond it; a favorable level (target) likewise.
  const hitStop = (c, stop) => dir === 1 ? (c.open <= stop ? c.open : c.low <= stop ? stop : null)
                                          : (c.open >= stop ? c.open : c.high >= stop ? stop : null);
  const hitTarget = (c, tgt) => dir === 1 ? (c.open >= tgt ? c.open : c.high >= tgt ? tgt : null)
                                           : (c.open <= tgt ? c.open : c.low <= tgt ? tgt : null);
  const exitFill = (px) => px * (1 - dir * slip);           // exits give up slippage in the trade's favor-direction
  const perYear = spec.timeframe === "1h" ? 252 * 6.5 : 252;

  const trades = [];
  let pos = null;
  const priceMove = (from, to) => dir * ((to - from) / from) * 100;

  const closeTrade = (i, fills, reason) => {
    let pnlUnderlying = 0, avg = 0;
    for (const f of fills) { pnlUnderlying += (f.sell_pct / 100) * priceMove(pos.entry, f.price); avg += (f.sell_pct / 100) * f.price; }
    let pnl = pnlUnderlying;
    if (pos.opt) {   // option instrument: P&L on the MODEL premium, weighted like the ladder
      let p = 0;
      for (const f of fills) p += (f.sell_pct / 100) * ((f.premium - pos.opt.entryPremium) / pos.opt.entryPremium) * 100;
      pnl = p;
    }
    trades.push({ entry: +pos.entry.toFixed(4), exit: +avg.toFixed(4), reason,
      pnl_pct: +(pnl - feeRt).toFixed(2), bars_held: i - pos.entry_i, date: candles[i].time,
      ...(pos.opt ? { premium_entry: +pos.opt.entryPremium.toFixed(2), model_priced: true } : {}) });
    pos = null;
  };
  // model premium of the open option position as of bar i (uses that bar's close)
  const premiumAt = (i, S) => {
    const T = Math.max(0, (pos.opt.dte - (i - pos.entry_i)) / 365);
    return Math.max(0.01, bsPrice(pos.opt.kind, S, pos.opt.K, T, pos.opt.sigma));
  };

  const warmup = Math.min(60, Math.floor(candles.length / 3));
  for (let i = warmup; i < candles.length - 1; i++) {
    if (!pos) {
      if (!entryAt(spec, ops, i)) continue;
      const atrNow = ops.atr[i];
      const entry = candles[i + 1].open * (1 + dir * slip);
      const dist = spec.exit.stop.type === "pct" ? entry * (spec.exit.stop.pct / 100)
        : (atrNow != null ? atrNow * spec.exit.stop.multiple : null);
      if (!dist || !isFinite(dist) || dist <= 0) continue;
      pos = {
        entry_i: i + 1, entry, dist,
        stop: entry - dir * dist,
        rungs: spec.exit.targets.map((t) => ({ price: entry + dir * t.rr * dist, sell_pct: t.sell_pct, fill: null })),
        maxFav: entry, filled: 0, fills: [],
      };
      if (spec.instrument && spec.instrument.type === "option") {
        const sigma = realizedVol(closes, i, 20, perYear) || 0.4;
        const kind = spec.instrument.strategy === "long_put" ? "put" : "call";
        const K = +(entry * (1 + spec.instrument.moneyness_pct / 100)).toFixed(2);
        pos.opt = { kind, K, dte: spec.instrument.dte, sigma, entryPremium: Math.max(0.05, bsPrice(kind, entry, K, spec.instrument.dte / 365, sigma)) };
      }
      continue;
    }
    const c = candles[i];
    // trail / breakeven ratchet (direction-aware: the stop only tightens)
    pos.maxFav = dir === 1 ? Math.max(pos.maxFav, c.close) : Math.min(pos.maxFav, c.close);
    if (spec.exit.trail) {
      if (spec.exit.trail.breakeven_after_target1 && pos.filled >= 1)
        pos.stop = dir === 1 ? Math.max(pos.stop, pos.entry) : Math.min(pos.stop, pos.entry);
      const atrNow = ops.atr[i];
      if (atrNow) {
        const trail = pos.maxFav - dir * spec.exit.trail.atr_multiple * atrNow;
        pos.stop = dir === 1 ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
      }
    }
    const mkFill = (px) => ({ price: exitFill(px), sell_pct: 0, premium: pos.opt ? premiumAt(i, exitFill(px)) : null });

    const stopPx = hitStop(c, pos.stop);
    if (stopPx != null) {
      const residual = { ...mkFill(stopPx), sell_pct: 100 - pos.fills.reduce((s, f) => s + f.sell_pct, 0) };
      closeTrade(i, [...pos.fills, residual], pos.filled ? "trail_stop" : "stop");
      continue;
    }
    for (const r of pos.rungs) {
      if (r.fill != null) continue;
      const px = hitTarget(c, r.price);
      if (px != null) {
        r.fill = exitFill(px);
        pos.fills.push({ price: r.fill, sell_pct: r.sell_pct, premium: pos.opt ? premiumAt(i, r.fill) : null });
        pos.filled++;
      }
    }
    if (pos.filled === pos.rungs.length) { const fills = pos.fills; closeTrade(i, fills, "ladder_complete"); continue; }
    const optExpired = pos.opt && (i - pos.entry_i) >= pos.opt.dte;
    if (i - pos.entry_i >= spec.exit.max_hold_bars || optExpired) {
      const residual = { ...mkFill(c.close), sell_pct: 100 - pos.fills.reduce((s, f) => s + f.sell_pct, 0) };
      if (optExpired && pos.opt) residual.premium = Math.max(0.0, pos.opt.kind === "call" ? Math.max(0, c.close - pos.opt.K) : Math.max(0, pos.opt.K - c.close)) || 0.01;
      closeTrade(i, [...pos.fills, residual], optExpired ? "option_expiry" : "time");
    }
  }
  // A position still open when candles run out is excluded (same rule as the backtester).
  if (!trades.length) return { symbol, trades: 0 };
  const wins = trades.filter((t) => t.pnl_pct > 0);
  return {
    symbol, trades: trades.length, wins: wins.length,
    win_rate: +((wins.length / trades.length) * 100).toFixed(1),
    avg_pnl_pct: +(trades.reduce((s, t) => s + t.pnl_pct, 0) / trades.length).toFixed(2),
    total_pnl_pct: +trades.reduce((s, t) => s + t.pnl_pct, 0).toFixed(2),
    exit_reasons: trades.reduce((m, t) => ((m[t.reason] = (m[t.reason] || 0) + 1), m), {}),
    last_trades: trades.slice(-5),
    all_trades: trades,
  };
}

// ---- The runner ----
async function resolveUniverse(spec) {
  if (Array.isArray(spec.universe)) return spec.universe;
  const prefs = settings.getSync().preferences;
  if (spec.universe === "crypto") {
    const coingecko = require("../providers/coingecko");
    const coins = await coingecko.topCoins(Math.min(25, prefs.crypto.top_n || 25));
    return coins.map((c) => c.yahoo);
  }
  const scanner = require("./scanner");
  return (prefs.stocks.universe === "custom" && prefs.stocks.custom_symbols.length
    ? prefs.stocks.custom_symbols : scanner.POPULAR_STOCKS).slice(0, 25);
}

async function runStrategy(rawSpec, opt = {}) {
  const spec = validateSpec(rawSpec);
  const cfg = settings.getSync().indicators;
  const symbols = (await resolveUniverse(spec)).slice(0, 30);
  const results = [];
  for (const sym of symbols) {
    try {
      const candles = await yahoo.history(String(sym).toUpperCase(), spec.days, spec.timeframe);
      if (!candles || candles.length < 80) continue;
      const { series } = indicators.computeAllCached(`lab:${sym}:${spec.timeframe}:${spec.days}`, candles, cfg);
      const r = simulateSymbol(String(sym).toUpperCase(), candles, series, spec, opt);
      if (r) results.push(r);
    } catch (_) { /* per-symbol tolerance */ }
  }
  const all = results.flatMap((r) => r.all_trades || [])
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const r of results) delete r.all_trades;
  // walk-forward: most recent 30% of the traded date span is out-of-sample.
  // Intraday trades stamp epoch SECONDS (Date.parse would NaN on them and silently
  // drop the split for every 1h strategy).
  const ts = (d) => (typeof d === "number" ? d * 1000 : Date.parse(d));
  let walk_forward = null;
  if (all.length >= 10) {
    const t0 = ts(all[0].date), t1 = ts(all[all.length - 1].date);
    if (isFinite(t0) && isFinite(t1) && t1 > t0) {
      const cutoff = t0 + (t1 - t0) * 0.7;
      const inS = all.filter((t) => ts(t.date) < cutoff);
      const oos = all.filter((t) => ts(t.date) >= cutoff);
      if (inS.length && oos.length) walk_forward = {
        cutoff_date: new Date(cutoff).toISOString().slice(0, 10),
        in_sample: metrics(inS), out_of_sample: metrics(oos),
        note: "If out-of-sample is much worse than in-sample, the strategy is curve-fit to old data.",
      };
    }
  }
  return {
    spec,
    symbols_tested: results.length,
    symbols_with_trades: results.filter((r) => r.trades > 0).length,
    total_trades: all.length,
    overall: metrics(all),
    walk_forward,
    exit_reasons: all.reduce((m, t) => ((m[t.reason] = (m[t.reason] || 0) + 1), m), {}),
    by_symbol: results.sort((a, b) => (b.total_pnl_pct || 0) - (a.total_pnl_pct || 0)),
    ...(spec.instrument ? { model_priced_note: "Option legs are MODEL-PRICED (Black-Scholes from realized volatility) — no free historical chains exist. Treat results as directional; IV-crush effects (earnings) are not modeled." } : {}),
    ...(spec.timeframe === "1h" ? { intraday_note: "Hourly history from free sources covers roughly the last 2-3 months — short-term results are a small sample." } : {}),
  };
}

// ---- Plain-English → spec (AI compile) and results → critique (AI feedback) ----
const SPEC_DOC = `SPEC format (JSON):
{"name": str, "timeframe": "1d"|"1h", "direction": "long"|"short",
 "universe": ["SYM",...] | "stocks" | "crypto",
 "entry": {"logic": "all"|"any", "conditions": [{"left": OPERAND, "op": OP, "right": number|OPERAND}]},
 "exit": {"stop": {"type":"atr","multiple":2} | {"type":"pct","pct":5},
          "targets": [{"rr":1,"sell_pct":50},{"rr":2,"sell_pct":50}],
          "trail": {"atr_multiple":3,"breakeven_after_target1":true} | null,
          "max_hold_bars": 30},
 "instrument": null | {"type":"option","strategy":"long_call"|"long_put","dte":30,"moneyness_pct":0},
 "days": 400}
OPERANDS: close open high low volume rsi stoch_k stoch_d adx atr atr_pct sma_fast sma_slow ema vwap bb_upper bb_mid bb_lower bb_pctb macd_line macd_signal macd_hist
OPS: < <= > >= crosses_above crosses_below rising falling (rising/falling: right = lookback bars)
Targets are R-MULTIPLES of the stop distance. "sell half at 2R" => {"rr":2,"sell_pct":50}.`;

async function compileStrategy(description) {
  const llm = require("../ai/llm");
  const { data } = await llm.chatJSON([
    { role: "system", content: `You translate a user's plain-English trading strategy into a strict JSON spec for a backtesting engine. Use ONLY the documented operands/ops — map concepts honestly (e.g. "oversold" → rsi < 30; "in an uptrend" → sma_fast > sma_slow; "volume spike" → volume rising or volume > some multiple is NOT expressible, use volume rising). If a requested concept cannot be expressed with the available operands, leave it out and say so in "notes".\n\n${SPEC_DOC}\n\nRespond ONLY with JSON: {"spec": {...}, "notes": "anything you had to approximate or drop"}` },
    { role: "user", content: String(description).slice(0, 2000) },
  ], { task: "scan" });
  const spec = validateSpec(data.spec);                      // throws with the reason on a bad compile
  return { spec, notes: String(data.notes || "").slice(0, 500) };
}

async function critiqueStrategy(spec, results) {
  const llm = require("../ai/llm");
  const summary = {
    spec, total_trades: results.total_trades, overall: results.overall,
    walk_forward: results.walk_forward, exit_reasons: results.exit_reasons,
    best_symbols: results.by_symbol.slice(0, 5).map((s) => ({ symbol: s.symbol, trades: s.trades, win_rate: s.win_rate, total_pnl_pct: s.total_pnl_pct })),
    worst_symbols: results.by_symbol.slice(-5).map((s) => ({ symbol: s.symbol, trades: s.trades, win_rate: s.win_rate, total_pnl_pct: s.total_pnl_pct })),
    model_priced: !!spec.instrument,
  };
  const { content } = await llm.chat([
    { role: "system", content: `You are a blunt, rigorous trading-strategy reviewer. Given a strategy spec and its backtest results, write a SHORT structured critique in markdown:
**Verdict** — one line: is this tradable as-is, promising-with-changes, or not working (ground it in expectancy, profit factor, drawdown, and sample size — under ~30 trades is a weak sample, say so).
**What works / What hurts** — 2-4 bullets each, citing the exit-reason mix, per-symbol spread, and in-sample vs out-of-sample gap (a big gap = curve-fit; call it out).
**Try next** — 1-2 CONCRETE spec changes (exact parameter edits), each with the reasoning.
Be honest about limits: slippage is modeled, IV effects are not (if model_priced), and past performance predicts nothing. Max ~250 words.` },
    { role: "user", content: JSON.stringify(summary) },
  ], { max_tokens: 1200, task: "scan" });
  return String(content || "").trim();
}

// ---- Live signals: saved strategies as SCREENERS ----
// Edge-triggered: a signal fires when the entry conditions BECOME true on the freshest
// bar, then stays quiet while they remain true (no daily re-spam), re-arming once they
// go false. Per-strategy/symbol state lives in its own KV key.
const SIGNAL_STATE_KEY = "strategy_signal_state";

async function evaluateLiveSignals() {
  const db = require("../db");
  const { logEvent } = require("../events");
  const liveSpecs = (await listStrategies()).filter((s) => s.live);
  if (!liveSpecs.length) return { strategies: 0, signals: 0 };
  const cfg = settings.getSync().indicators;
  const row = await db.get("SELECT value FROM settings WHERE `key`=?", [SIGNAL_STATE_KEY]).catch(() => null);
  const state = (row ? J(row.value, {}) : {}) || {};
  let signals = 0;

  for (const spec of liveSpecs) {
    const st = (state[spec.name] = state[spec.name] || {});
    const symbols = (await resolveUniverse(spec).catch(() => [])).slice(0, 25);
    for (const sym of symbols) {
      try {
        const S = String(sym).toUpperCase();
        const candles = await yahoo.history(S, Math.min(spec.days, 200), spec.timeframe);
        if (!candles || candles.length < 80) continue;
        const { series } = indicators.computeAllCached(`lab:${S}:${spec.timeframe}:sig`, candles, cfg);
        const ops = buildOperands(candles, series);
        const i = candles.length - 1;
        const active = entryAt(spec, ops, i);
        const wasActive = !!(st[S] && st[S].active);
        st[S] = { active, bar: String(candles[i].time) };
        if (!active || wasActive) continue;                 // edge-trigger only
        signals++;
        const close = candles[i].close;
        const condStr = spec.entry.conditions.map((c) => `${c.left} ${c.op} ${c.right}`).join(spec.entry.logic === "any" ? " OR " : " AND ");
        await logEvent("strategy_signal", "strategy", null, S,
          `⚡ Strategy "${spec.name}" fired on ${S} @ ${close} (${condStr})`);
        if (spec.signal_to_rec) {
          const made = await signalToRec(spec, S, close, ops, i, condStr).catch((e) => ({ skipped: e.message }));
          if (made && made.skipped)
            await logEvent("strategy_signal", "strategy", null, S, `⚡ "${spec.name}" signal on ${S} not saved as a recommendation — ${made.skipped}`);
        }
      } catch (_) { /* per-symbol tolerance */ }
    }
  }
  await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"),
    [SIGNAL_STATE_KEY, JSON.stringify(state), Date.now()]);
  return { strategies: liveSpecs.length, signals };
}

// Turn a fired signal into a REAL recommendation: mechanical levels from the spec's
// exit model, pushed through the SAME validation gauntlet + duplicate guard as
// everything else — your strategies get shadow-tracked and honestly graded too.
async function signalToRec(spec, sym, close, ops, i, condStr) {
  const db = require("../db");
  const { logEvent } = require("../events");
  const recommender = require("./recommender");
  const prefs = settings.getSync().preferences;
  const side = spec.direction === "short" ? "sell" : "buy";
  if (side === "sell" && prefs.risk.allow_shorts === false) return { skipped: "shorts are disabled in preferences" };
  const atrNow = ops.atr[i];
  const dist = spec.exit.stop.type === "pct" ? close * (spec.exit.stop.pct / 100) : (atrNow ? atrNow * spec.exit.stop.multiple : null);
  if (!dist || !isFinite(dist)) return { skipped: "no ATR available to size the stop" };
  const sgn = side === "buy" ? 1 : -1;
  const barsPerDay = spec.timeframe === "1h" ? 6.5 : 1;
  const raw = {
    symbol: sym, side,
    entry_low: +(close * 0.995).toFixed(6), entry_high: +(close * 1.005).toFixed(6),
    stop_loss: +(close - sgn * dist).toFixed(6),
    targets: spec.exit.targets.map((t) => ({ price: +(close + sgn * t.rr * dist).toFixed(6), sell_pct: t.sell_pct })),
    confidence: Math.max(prefs.risk.min_confidence, 0.6),
    horizon_min_days: 1, horizon_max_days: Math.max(2, Math.ceil(spec.exit.max_hold_bars / barsPerDay)),
    rationale: `Mechanical signal from YOUR strategy "${spec.name}": ${condStr} on the latest ${spec.timeframe} bar (close ${close}). Levels from the spec's exit model (${spec.exit.stop.type} stop, R-multiple ladder). Not an AI judgment — your rules, executed and shadow-tracked.`,
  };
  const candidateMap = { [sym]: { symbol: sym, asset_type: /-USD$/.test(sym) ? "crypto" : "stock", name: sym, price: close } };
  const rec = recommender.validateRec(raw, candidateMap, prefs);
  if (!rec) return { skipped: `validation rejected it (usually the ladder's reward:risk vs your ${prefs.risk.min_risk_reward} minimum)` };
  const dup = await recommender.duplicateOf(rec);
  if (dup) return { skipped: `duplicate of active recommendation #${dup.id}` };
  const expiryMs = (settings.getSync().schedule.rec_expiry_days || 10) * 86400000;
  const res = await db.run(
    `INSERT INTO recommendations
     (run_id, created_at, asset_type, symbol, name, side, current_price, entry_low, entry_high,
      stop_loss, targets, horizon_min_days, horizon_max_days, confidence, risk_reward, rationale,
      options_play, inputs, status, expires_at)
     VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
    [Date.now(), rec.asset_type, rec.symbol, rec.name, rec.side, rec.current_price, rec.entry_low, rec.entry_high,
     rec.stop_loss, JSON.stringify(rec.targets), rec.horizon_min_days, rec.horizon_max_days, rec.confidence,
     rec.risk_reward, rec.rationale, JSON.stringify({ source: "strategy_signal", strategy: spec.name, saved_at: new Date().toISOString() }),
     "open", Date.now() + expiryMs]);
  await logEvent("rec_new", "recommendation", res.lastID, rec.symbol,
    `⚡ Strategy "${spec.name}" idea saved: ${rec.side.toUpperCase()} ${rec.symbol} @ ${rec.entry_low}-${rec.entry_high} (R:R ${rec.risk_reward})`);
  return { id: res.lastID };
}

// ---- Saved strategies (settings KV, like advisor memory) ----
const KEY = "strategies";
async function listStrategies() {
  const db = require("../db");
  const row = await db.get("SELECT value FROM settings WHERE `key`=?", [KEY]).catch(() => null);
  const list = row ? J(row.value, []) : [];
  return Array.isArray(list) ? list : [];
}
async function saveStrategy(spec) {
  const db = require("../db");
  const valid = validateSpec(spec);
  const list = await listStrategies();
  const i = list.findIndex((s) => s.name === valid.name);
  const entry = { ...valid, saved_at: Date.now() };
  if (i >= 0) list[i] = entry; else list.push(entry);
  while (list.length > 25) list.shift();
  await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"), [KEY, JSON.stringify(list), Date.now()]);
  return entry;
}
async function deleteStrategy(name) {
  const db = require("../db");
  const list = await listStrategies();
  const next = list.filter((s) => s.name !== name);
  await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"), [KEY, JSON.stringify(next), Date.now()]);
  return { removed: list.length - next.length };
}

module.exports = {
  validateSpec, runStrategy, compileStrategy, critiqueStrategy,
  listStrategies, saveStrategy, deleteStrategy,
  evaluateLiveSignals, signalToRec,
  simulateSymbol, buildOperands, condTrue, bsPrice, realizedVol, OPERANDS, OPS,
};
