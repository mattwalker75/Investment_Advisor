"use strict";
// First-class OPTIONS recommendations: a dedicated AI pass over stock candidates with a
// live chain, producing standalone option ideas that ride the SAME rails as stock and
// crypto recommendations. The design choice that makes everything reuse cleanly:
//
//   AN OPTION REC'S TRACKED PRICE IS THE PREMIUM (per share, net for spreads).
//
// A debit play (long call/put, debit spread) is side='buy' on the premium — entry zone,
// stop, and targets are premium levels below/above exactly like a stock long. A credit
// play (covered call, cash-secured put) is side='sell' — you WANT the premium to decay,
// so targets sit below entry (buy-back cheap / expire worthless) and the stop above
// (buy-back if the short premium doubles). The shadow-tracker's state machine, the
// ladder-P&L rule, and the performance stats then grade options with zero special
// cases beyond fetching premiums instead of quotes.
//
// Data honesty: chains are CBOE keyless delayed quotes (one expiry per fetch, ±15%
// strikes). There is NO free historical options data, so option ideas are graded
// forward from creation — and at expiry they SETTLE at intrinsic value.
const llm = require("../ai/llm");
const settings = require("../settings");
const { J } = require("../util");
const { normalizeTargets, compactMarket, compactCandidate, duplicateOf } = require("./recommender");

// Which configured strategies are premium-CREDIT (side='sell' on the premium).
const CREDIT = new Set(["covered_call", "cash_secured_put"]);
// Leg blueprints per strategy: how many strikes and what each leg is.
//   sign +1 = long (bought), -1 = short (sold). Net premium = Σ sign×mid.
const LEGS = {
  long_call: [{ type: "call", sign: 1 }],
  long_put: [{ type: "put", sign: 1 }],
  call_spread: [{ type: "call", sign: 1 }, { type: "call", sign: -1 }],   // bull call debit: buy lower, sell higher
  put_spread: [{ type: "put", sign: 1 }, { type: "put", sign: -1 }],      // bear put debit: buy higher, sell lower
  covered_call: [{ type: "call", sign: -1 }],
  cash_secured_put: [{ type: "put", sign: -1 }],
};

const midOf = (leg) => (leg && leg.bid && leg.ask ? (leg.bid + leg.ask) / 2 : (leg && leg.last) || null);
function legAt(chain, type, strike) {
  return ((type === "put" ? chain.puts : chain.calls) || []).find((o) => Math.abs(o.strike - strike) < 0.01) || null;
}

// At-the-money IV: average of the call+put legs nearest the spot. Null when unknown.
function atmIv(chain, spot) {
  const near = (legs) => (legs || []).slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
  const ivs = [near(chain.calls), near(chain.puts)].map((l) => l && l.iv).filter((v) => v != null);
  return ivs.length ? +(ivs.reduce((s, v) => s + v, 0) / ivs.length).toFixed(1) : null;
}

// Net premium (per share, absolute) + resolved legs for a strategy at given strikes.
// Returns null when any leg is missing from the chain or the net is not positive.
function netPremium(strategy, chain, strikes) {
  const blueprint = LEGS[strategy];
  if (!blueprint || !Array.isArray(strikes) || strikes.length !== blueprint.length) return null;
  const legs = [];
  let net = 0;
  for (const [i, spec] of blueprint.entries()) {
    const leg = legAt(chain, spec.type, strikes[i]);
    const mid = midOf(leg);
    if (!leg || mid == null || mid <= 0) return null;
    legs.push({ ...spec, strike: strikes[i], mid: +mid.toFixed(2), iv: leg.iv ?? null, oi: leg.open_interest ?? 0 });
    net += spec.sign * mid;
  }
  const abs = Math.abs(net);
  if (abs < 0.05) return null;                       // sub-nickel nets aren't tradable advice
  return { net: +abs.toFixed(2), legs };
}

// Strategy economics per contract (×100): breakeven, max loss, max gain (null = open-ended).
function economics(strategy, strikes, net, spot) {
  const round2 = (v) => (v == null ? null : +v.toFixed(2));
  switch (strategy) {
    case "long_call": return { breakeven: round2(strikes[0] + net), max_loss_per_contract: round2(net * 100), max_gain_per_contract: null };
    case "long_put": return { breakeven: round2(strikes[0] - net), max_loss_per_contract: round2(net * 100), max_gain_per_contract: round2((strikes[0] - net) * 100) };
    case "call_spread": {
      const width = strikes[1] - strikes[0];
      return { breakeven: round2(strikes[0] + net), max_loss_per_contract: round2(net * 100), max_gain_per_contract: round2((width - net) * 100) };
    }
    case "put_spread": {
      const width = strikes[0] - strikes[1];
      return { breakeven: round2(strikes[0] - net), max_loss_per_contract: round2(net * 100), max_gain_per_contract: round2((width - net) * 100) };
    }
    case "covered_call": return { breakeven: round2(spot != null ? spot - net : null), max_loss_per_contract: null, max_gain_per_contract: round2(net * 100), note: "downside is the stock position; max gain = premium (+ upside to the strike)" };
    case "cash_secured_put": return { breakeven: round2(strikes[0] - net), max_loss_per_contract: round2((strikes[0] - net) * 100), max_gain_per_contract: round2(net * 100), note: "collateral = strike ×100; max loss if the stock goes to zero" };
    default: return {};
  }
}

// Settlement value of the position's premium at expiry, given the underlying's price.
// (What the option is worth per share when time runs out — intrinsic only.)
function settlementPremium(strategy, strikes, spot) {
  const callIv = (k) => Math.max(0, spot - k);
  const putIv = (k) => Math.max(0, k - spot);
  switch (strategy) {
    case "long_call": return callIv(strikes[0]);
    case "long_put": return putIv(strikes[0]);
    case "call_spread": return Math.max(0, Math.min(strikes[1] - strikes[0], spot - strikes[0]));
    case "put_spread": return Math.max(0, Math.min(strikes[0] - strikes[1], strikes[0] - spot));
    case "covered_call": return callIv(strikes[0]);       // cost to buy the short call back
    case "cash_secured_put": return putIv(strikes[0]);    // cost to buy the short put back
    default: return 0;
  }
}

// --- Validation gauntlet for an AI-proposed options play. Same philosophy as
// validateRec: no model number reaches the database unchecked. Returns a rec object in
// the standard recommendation shape (premium-denominated) or null.
function validateOptionRec(r, candidateMap, prefs) {
  const c = candidateMap[String(r.symbol || "").toUpperCase()];
  const chain = c && c.options_chain;
  if (!c || !chain) return null;                                    // unknown symbol / no live chain
  const strategy = String(r.strategy || "");
  if (!prefs.options.strategies[strategy] || !LEGS[strategy]) return null;   // not in the user's allowed set

  const num = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);
  let strikes = (Array.isArray(r.strikes) ? r.strikes : []).map(num).filter(Boolean);
  if (strikes.length !== LEGS[strategy].length) return null;
  // Spread leg order is part of the contract: call spreads buy the LOWER strike,
  // put spreads buy the HIGHER — a zero/negative width is a malformed idea.
  if (strategy === "call_spread" && !(strikes[1] > strikes[0])) return null;
  if (strategy === "put_spread" && !(strikes[0] > strikes[1])) return null;

  const priced = netPremium(strategy, chain, strikes);
  if (!priced) return null;                                         // strike not in chain / no market
  const mid = priced.net;
  const side = CREDIT.has(strategy) ? "sell" : "buy";

  // Premium entry zone: the model's numbers if they're sane (±30% of the live net mid),
  // else a tight band around the mid.
  let entryLow = num(r.entry_low), entryHigh = num(r.entry_high);
  const sane = (v) => v != null && v >= mid * 0.7 && v <= mid * 1.3;
  if (!sane(entryLow) || !sane(entryHigh) || entryLow > entryHigh) {
    entryLow = +(mid * 0.97).toFixed(2); entryHigh = +(mid * 1.03).toFixed(2);
  }
  const entryMid = (entryLow + entryHigh) / 2;

  // Premium stop. Debit plays: below entry (default −50%, clamp 20–90% of entry).
  // Credit plays: above entry (buy back if the short premium roughly doubles).
  let stop = num(r.stop_loss);
  if (side === "buy") {
    if (!stop || stop >= entryLow || stop < entryLow * 0.1) stop = +(entryMid * 0.5).toFixed(2);
  } else {
    if (!stop || stop <= entryHigh || stop > entryMid * 4) stop = +(entryMid * 2).toFixed(2);
  }

  // Premium targets: model's ladder normalized, or honest defaults (debit: +100%/+200%;
  // credit: buy back at 50% decay, then let the rest ride toward worthless).
  let targets = normalizeTargets(r.targets, side, entryLow, entryHigh);
  if (!targets.length) {
    targets = side === "buy"
      ? [{ price: +(entryMid * 2).toFixed(2), sell_pct: 60 }, { price: +(entryMid * 3).toFixed(2), sell_pct: 40 }]
      : [{ price: +(entryMid * 0.5).toFixed(2), sell_pct: 60 }, { price: +(Math.max(0.05, entryMid * 0.1)).toFixed(2), sell_pct: 40 }];
  }

  const conf = Math.max(0, Math.min(1, Number(r.confidence) || 0));
  if (conf < prefs.risk.min_confidence) return null;

  // Reward:risk on the premium ladder — gated for DEBIT plays (same rule as stocks).
  // Credit plays are income strategies (reward is capped at the credit by construction),
  // so the ratio is reported but not gated.
  const risk = Math.abs(entryMid - stop);
  const reward = targets.reduce((s, t) => s + (t.sell_pct / 100) * Math.abs(t.price - entryMid), 0);
  const rr = risk > 0 ? +(reward / risk).toFixed(2) : null;
  if (side === "buy" && (rr == null || rr < (prefs.risk.min_risk_reward || 0))) return null;

  const eco = economics(strategy, strikes, mid, c.price);
  return {
    symbol: c.symbol, asset_type: "option", name: c.name, side,
    current_price: mid,                                   // the tracked price IS the premium
    entry_low: +entryLow.toFixed(2), entry_high: +entryHigh.toFixed(2),
    stop_loss: +stop.toFixed(2),
    targets,
    horizon_min_days: Math.max(1, Math.min(Math.round(r.horizon_min_days || 5), chain.dte || 30)),
    // DTE is the hard ceiling — even for a 1-DTE chain (the old Math.max(2,…) could exceed it).
    horizon_max_days: Math.min(Math.max(1, chain.dte || 30), Math.max(2, Math.round(r.horizon_max_days || chain.dte || 30))),
    confidence: +conf.toFixed(2),
    risk_reward: rr,
    rationale: String(r.rationale || "").slice(0, 2000),
    options_play: {
      strategy, expiry: chain.expiry, dte: chain.dte, strikes,
      est_premium: mid, legs: priced.legs, iv: priced.legs[0].iv ?? null,
      atm_iv_pct: atmIv(chain, c.price), underlying_price: c.price,
      credit: side === "sell" || undefined,
      ...eco,
      note: String(r.note || "").slice(0, 400),
    },
  };
}

// --- The options AI pass ---
const SCHEMA_EXAMPLE = `{
  "market_outlook": "one line",
  "plays": [
    {
      "symbol": "NVDA",
      "strategy": "long_call",
      "strikes": [130],
      "entry_low": 3.2, "entry_high": 3.5,
      "stop_loss": 1.7,
      "targets": [ { "price": 6.5, "sell_pct": 60 }, { "price": 10.0, "sell_pct": 40 } ],
      "horizon_min_days": 10, "horizon_max_days": 30,
      "confidence": 0.65,
      "rationale": "2-4 sentences citing the indicators/chain data provided.",
      "note": "one-line play summary for the card"
    }
  ]
}`;

function optionsSystemPrompt(prefs) {
  const allowed = Object.entries(prefs.options.strategies).filter(([, v]) => v).map(([k]) => k);
  return `You are a disciplined options strategist. From the candidates provided (each with real
technical indicators and a LIVE near-the-money option chain), propose your best standalone OPTIONS
plays. Everything is denominated in PREMIUM per share: entry zone, stop, and targets are premium
levels for the whole position (net premium for spreads).

RULES:
- Strategies allowed (ONLY these): ${allowed.join(", ")}. ${prefs.options.notes ? "User guidance: " + prefs.options.notes : ""}
- Strikes MUST come from the provided chain. Spreads: call_spread = [buy lower, sell higher]; put_spread = [buy higher, sell lower].
- DEBIT plays (long_call/long_put/spreads): premium stop BELOW entry (cut the loss), premium targets ABOVE (take profit); reward:risk on the premium ladder must clear ${prefs.risk.min_risk_reward}:1.
- CREDIT plays (covered_call/cash_secured_put): you are selling premium — targets BELOW entry (buy back cheap / near-worthless), stop ABOVE (buy back if the premium ~doubles).
- USE THE IV: atm_iv_pct is provided per candidate. Prefer debit strategies when IV is modest; prefer selling premium when IV is rich. Say which in the rationale.
- Time is a cost: the chain expiry caps the horizon; avoid long premium when the setup needs more time than the DTE allows.
- Respect the user's risk tolerance (${prefs.risk.risk_tolerance}) and earnings dates (a long-premium play INTO earnings must be called out explicitly).
- confidence: honest 0-1. Quality over quantity — at most 3 plays, only your best; an empty array is a fine answer.

Respond with ONLY a JSON object matching this schema (no prose, no fences):
${SCHEMA_EXAMPLE}`;
}

// context: the SAME scan context recommend() gets. Candidates without a chain are
// skipped. opts.viewHint (chat tool): a requested direction — bullish / bearish /
// neutral_income — appended to the prompt.
async function recommendOptions(context, onProgress = () => {}, { viewHint } = {}) {
  const prefs = settings.getSync().preferences;
  const cands = context.candidates.filter((c) => c.asset_type === "stock" && c.options_chain &&
    ((c.options_chain.calls || []).length || (c.options_chain.puts || []).length));
  if (!cands.length) return { recs: [], model: null };
  const candidateMap = {};
  for (const c of cands) candidateMap[c.symbol.toUpperCase()] = c;
  const hint = viewHint ? `\n\nThe user's requested view: ${viewHint}${viewHint === "neutral_income" ? " (premium-selling / income)" : ""}. Design the play for that view.` : "";
  const { data, model, usage } = await llm.chatJSON([
    { role: "system", content: optionsSystemPrompt(prefs) },
    { role: "user", content: `## Market context\n${JSON.stringify(compactMarket(context.market))}\n\n## Candidates (indicators + live chain with atm_iv_pct)\n${JSON.stringify(cands.map(compactCandidate))}\n\nJSON only; strikes only from the chains.${hint}` },
  ], { task: "scan" });
  const recs = (Array.isArray(data.plays) ? data.plays : [])
    .map((p) => validateOptionRec(p, candidateMap, prefs))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
  onProgress(`options pass: ${recs.length ? recs.map((r) => `${r.options_play.strategy} ${r.symbol}`).join(", ") : "no plays cleared validation"}`);
  return { recs, model, usage };
}

// Persist a validated option rec (used by the scanner pass and the chat tool).
// expires_at = the earlier of the normal rec window and the option's own expiry.
async function saveOptionRec(rec, { runId = null, inputs = null } = {}) {
  const db = require("../db");
  const s = settings.getSync();
  const windowMs = (s.schedule.rec_expiry_days || 10) * 86400000;
  const expiryMs = Date.parse(rec.options_play.expiry + "T21:00:00Z");
  const expiresAt = Math.min(Date.now() + windowMs, isFinite(expiryMs) ? expiryMs : Infinity);
  const res = await db.run(
    `INSERT INTO recommendations
     (run_id, created_at, asset_type, symbol, name, side, current_price, entry_low, entry_high,
      stop_loss, targets, horizon_min_days, horizon_max_days, confidence, risk_reward, rationale,
      options_play, inputs, status, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [runId, Date.now(), "option", rec.symbol, rec.name, rec.side, rec.current_price, rec.entry_low, rec.entry_high,
     rec.stop_loss, JSON.stringify(rec.targets), rec.horizon_min_days, rec.horizon_max_days, rec.confidence,
     rec.risk_reward, rec.rationale, JSON.stringify(rec.options_play),
     inputs ? JSON.stringify(inputs) : null, "open", expiresAt]);
  return res.lastID;
}

// --- Premium pricing + expiry settlement for the shadow-tracker ---

// Live net premium for an option rec (per share). When a leg has drifted outside the
// fetched near-money strike window (deep ITM winners do exactly this), fall back to
// INTRINSIC value off the spot — otherwise winners silently stopped tracking right as
// they hit their targets.
async function optionPremium(rec) {
  const yahoo = require("../providers/yahoo");
  const play = typeof rec.options_play === "string" ? J(rec.options_play, null) : rec.options_play;
  if (!play || !play.strategy || !Array.isArray(play.strikes)) return null;
  try {
    const chain = await yahoo.optionsChain(rec.symbol, 365, play.expiry);
    if (!chain) return null;
    const priced = netPremium(play.strategy, chain, play.strikes);
    if (priced) return { premium: priced.net, underlying: chain.spot ?? null };
    if (chain.spot != null) {
      const intrinsic = settlementPremium(play.strategy, play.strikes, chain.spot);
      return { premium: +Math.max(0.01, intrinsic).toFixed(2), underlying: chain.spot, approx: "intrinsic (leg outside the fetched strike window)" };
    }
    return null;
  } catch (_) { return null; }
}

// Same, for a TRADE row's option_details (used by the trades route + tracker for
// positions taken from first-class option recs — spreads price NET, never one leg).
async function tradePremium(t) {
  const od = typeof t.option_details === "string" ? J(t.option_details, null) : t.option_details;
  if (!od) return null;
  const strategy = od.strategy && LEGS[od.strategy] ? od.strategy : (od.type === "put" ? "long_put" : "long_call");
  const strikes = Array.isArray(od.strikes) && od.strikes.length ? od.strikes : (od.strike != null ? [od.strike] : null);
  if (!strikes) return null;
  return optionPremium({ symbol: t.symbol, options_play: { strategy, strikes, expiry: od.expiry } });
}

// True once the option's expiry day is over (chains settle ~21:00 UTC).
function isExpired(play, nowMs = Date.now()) {
  const t = Date.parse(String(play.expiry) + "T21:00:00Z");
  return isFinite(t) && nowMs > t;
}

module.exports = {
  validateOptionRec, recommendOptions, saveOptionRec, optionPremium, tradePremium,
  netPremium, economics, settlementPremium, atmIv, isExpired, CREDIT, LEGS,
};
