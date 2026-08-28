"use strict";
// The recommender: turns gathered market data into validated trade recommendations.
// Builds the analysis prompt (user preferences + indicators + news + sentiment + whales),
// demands STRICT JSON from the model, then validates/clamps every number so a
// hallucinated price can never reach the database unchecked.
const llm = require("../ai/llm");
const settings = require("../settings");
const { J, yahooSym } = require("../util");

const SCHEMA_EXAMPLE = `{
  "market_outlook": "1-3 sentence read of current conditions.",
  "recommendations": [
    {
      "symbol": "NVDA",
      "asset_type": "stock",
      "side": "buy",
      "entry_low": 120.0,
      "entry_high": 124.5,
      "stop_loss": 112.0,
      "targets": [
        { "price": 135.0, "sell_pct": 25 },
        { "price": 150.0, "sell_pct": 50 },
        { "price": 165.0, "sell_pct": 25 }
      ],
      "horizon_min_days": 10,
      "horizon_max_days": 45,
      "confidence": 0.7,
      "rationale": "2-5 sentences citing the SPECIFIC indicators/news/whale data provided.",
      "options_play": null
    }
  ]
}`;

function systemPrompt(prefs) {
  const allowed = Object.entries(prefs.options.strategies).filter(([, v]) => v).map(([k]) => k);
  return `You are a disciplined, risk-aware trading analyst producing actionable swing-trade ideas.
You are given REAL current market data: technical indicator values (with the user's own buy/sell
thresholds), recent news headlines, market sentiment gauges, and recent "smart money" activity
(congressional trades, institutional 13F filers). Ground every judgment in that data — never invent
prices, news, or filings.

RULES:
- Recommend ONLY symbols from the provided candidates list.
- The market context includes a top-level "regime" read (SPY vs its 200-DMA + sentiment).
  In risk_off, long ideas face a market-wide headwind: demand extra confirmation (relative
  strength, volume, divergence), lower your confidence accordingly, and prefer fewer/no
  ideas over forced ones. In risk_on the tailwind favors longs. Cite the regime when it
  shapes your call.
- The market context includes active_recommendations (ideas already being tracked). Do NOT
  repeat them: skip those symbols unless your idea is MATERIALLY different (opposite side,
  or an entry zone that does not overlap and sits ≥5% away). Prefer fresh symbols.
- Respect the user's risk tolerance: ${prefs.risk.risk_tolerance}.
${prefs.risk.allow_shorts !== false
    ? '- side "buy" = long idea. side "sell" = exit/avoid/short signal on that symbol.'
    : '- The user does NOT take short positions: side must ALWAYS be "buy". If a candidate looks bearish, simply OMIT it — never emit a sell idea.'}
- entry_low/entry_high define a realistic limit-order zone near the current price (not a fantasy dip).
- stop_loss: below entry for buys (use ATR/support to size it), above entry for sells.
- targets: 1-3 laddered take-profit levels; sell_pct MUST sum to 100. Phase exits when it makes sense
  (e.g. 25% early, 50% core, 25% runner).
- horizon_min_days/horizon_max_days: rough estimate of time in the trade (it's an estimate, say so in rationale if unclear).
- REWARD:RISK — the ladder-weighted reward vs the entry-to-stop risk MUST be at least ${prefs.risk.min_risk_reward}:1. Ideas below that are auto-rejected; size targets and stops accordingly.
${prefs.risk.avoid_earnings_days > 0 ? `- EARNINGS RISK: candidates include next_earnings when known. Do NOT recommend a new stock entry within ${prefs.risk.avoid_earnings_days} days of its earnings date unless the idea explicitly IS an earnings play the user's risk tolerance supports — and ALWAYS state the earnings date in the rationale when it falls inside the trade horizon.` : `- Earnings dates are provided per candidate — mention them in the rationale when they fall inside the trade horizon.`}
- confidence: honest 0-1. If nothing is attractive, return an EMPTY recommendations array — never force ideas.
- Quality over quantity: at most ${prefs.risk.max_recommendations_per_scan} recommendations, only your best.
${prefs.options.enabled && allowed.length ? `- options_play: when an options expression is clearly better, you MAY attach one using ONLY these strategies: ${allowed.join(", ")}. Max ${prefs.options.max_dte} days to expiry. Use the provided option-chain strikes/IV. ${prefs.options.notes ? "User guidance: " + prefs.options.notes : ""} Format: {"strategy":"long_call","expiry":"YYYY-MM-DD","strikes":[130],"note":"..."}. Otherwise null.`
    : `- options_play: ALWAYS null (user has options trading disabled).`}

Respond with ONLY a JSON object exactly matching this schema (no prose, no markdown fences):
${SCHEMA_EXAMPLE}`;
}

// --- Prompt compaction: the model gets everything decision-relevant, none of the bulk.
// The FULL candidate/market objects still go into the stored input snapshot — only the
// prompt is compacted (a 12-candidate prompt was large enough to slow local models and
// risk truncation).
function compactMarket(m) {
  return {
    as_of: m.as_of,
    regime: m.regime ? { regime: m.regime.regime, spy_vs_200dma_pct: m.regime.spy_vs_200dma_pct, note: m.regime.note } : undefined,
    active_recommendations: (m.active_recommendations || []).map((r) => ({ symbol: r.symbol, side: r.side, entry: [r.entry_low, r.entry_high], status: r.status })),
    sentiment: m.sentiment,
    top_headlines: (m.top_headlines || []).slice(0, 12),
    congress_most_traded: (m.congress_most_traded || []).slice(0, 8),
    recent_13f_filers: (m.recent_13f_filers || []).slice(0, 8),
  };
}
function compactCandidate(c) {
  const out = {
    symbol: c.symbol, asset_type: c.asset_type, name: c.name, price: c.price,
    indicators: c.indicators,                       // `latest` is already the compact snapshot
    headlines: (c.headlines || []).slice(0, 4),
  };
  if (c.smart_money) out.smart_money = c.smart_money;
  if (c.next_earnings) out.next_earnings = c.next_earnings;
  if (c.options_chain) {
    // ≤8 strikes per side nearest the money, essential leg fields only, plus an
    // at-the-money IV read so the model can judge rich vs modest premium.
    const near = (legs) => (legs || [])
      .slice().sort((a, b) => Math.abs(a.strike - c.price) - Math.abs(b.strike - c.price)).slice(0, 8)
      .sort((a, b) => a.strike - b.strike)
      .map((l) => ({ strike: l.strike, bid: l.bid, ask: l.ask, iv: l.iv, oi: l.open_interest }));
    out.options_chain = {
      expiry: c.options_chain.expiry, dte: c.options_chain.dte,
      atm_iv_pct: require("./options").atmIv(c.options_chain, c.price),
      calls: near(c.options_chain.calls), puts: near(c.options_chain.puts),
    };
  }
  return out;
}

function userPrompt(marketCompact, candidatesCompact) {
  return `Analyze the following live market data and produce your recommendations.

## Market context
${JSON.stringify(marketCompact)}

## Candidates (each with current price, computed indicators, the user's threshold signals, related headlines, and smart-money activity)
${JSON.stringify(candidatesCompact)}

Remember: JSON only, symbols only from candidates, sell_pct sums to 100.`;
}

// Normalize a target ladder: numeric rungs beyond the entry on the correct side, max 3,
// sell_pct renormalized to exactly 100. Returns [] when no valid rung remains. Shared
// with the options validator (premium ladders follow the same rules).
function normalizeTargets(raw, side, entryLow, entryHigh) {
  const num = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);
  let targets = Array.isArray(raw) ? raw
    .map((t) => ({ price: num(t.price), sell_pct: Math.max(1, Math.min(100, Math.round(t.sell_pct || 0))) }))
    .filter((t) => t.price) : [];
  if (side === "buy") targets = targets.filter((t) => t.price > entryHigh).sort((a, b) => a.price - b.price);
  else targets = targets.filter((t) => t.price < entryLow).sort((a, b) => b.price - a.price);
  targets = targets.slice(0, 3);
  const pctSum = targets.reduce((s, t) => s + t.sell_pct, 0);
  if (targets.length && pctSum !== 100) {
    let acc = 0;
    targets = targets.map((t, i) => {
      const pct = i === targets.length - 1 ? 100 - acc : Math.max(1, Math.round((t.sell_pct / pctSum) * 100));
      acc += pct; return { ...t, sell_pct: pct };
    });
  }
  return targets;
}

// --- Validation: never trust a model number blindly. ---
function validateRec(r, candidateMap, prefs) {
  const c = candidateMap[String(r.symbol || "").toUpperCase()];
  if (!c) return null;                                     // hallucinated symbol -> drop
  const price = c.price;
  const num = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);
  const side = r.side === "sell" ? "sell" : "buy";
  if (side === "sell" && prefs.risk.allow_shorts === false) return null;   // longs-only account

  let entryLow = num(r.entry_low), entryHigh = num(r.entry_high), stop = num(r.stop_loss);
  if (!entryLow || !entryHigh) { entryLow = entryLow || price; entryHigh = entryHigh || price; }
  if (entryLow > entryHigh) [entryLow, entryHigh] = [entryHigh, entryLow];
  // Entry zone must be within ±25% of the real price or the model is dreaming.
  if (price && (entryLow < price * 0.75 || entryHigh > price * 1.25)) return null;
  if (!stop) stop = side === "buy" ? entryLow * 0.93 : entryHigh * 1.07;
  if (side === "buy" && stop >= entryLow) stop = entryLow * 0.95;   // stop must be below a long entry
  if (side === "sell" && stop <= entryHigh) stop = entryHigh * 1.05;

  const targets = normalizeTargets(r.targets, side, entryLow, entryHigh);
  if (!targets.length) return null;                        // a trade idea with no exit is not an idea

  const conf = Math.max(0, Math.min(1, Number(r.confidence) || 0));
  if (conf < prefs.risk.min_confidence) return null;

  // Reward:risk gate — a trade idea must pay for its risk. Reward = ladder-weighted
  // average target distance from entry mid; risk = entry mid to stop. Below the user's
  // minimum -> the rec is dropped, no matter how confident the model sounds.
  const entryMid = (entryLow + entryHigh) / 2;
  const risk = Math.abs(entryMid - stop);
  const reward = targets.reduce((s2, t) => s2 + (t.sell_pct / 100) * Math.abs(t.price - entryMid), 0);
  const rr = risk > 0 ? +(reward / risk).toFixed(2) : null;
  if (rr == null || rr < (prefs.risk.min_risk_reward || 0)) return null;

  let options_play = null;
  if (prefs.options.enabled && r.options_play && typeof r.options_play === "object") {
    const strat = String(r.options_play.strategy || "");
    if (prefs.options.strategies[strat]) {
      options_play = {
        strategy: strat,
        expiry: String(r.options_play.expiry || ""),
        strikes: Array.isArray(r.options_play.strikes) ? r.options_play.strikes.filter((s) => num(s)) : [],
        note: String(r.options_play.note || "").slice(0, 400),
      };
      // Enrich single-leg plays with real chain economics: premium (mid), breakeven,
      // max loss per contract — so "when to buy the option" comes with the full picture.
      const chain = c.options_chain;
      if (chain && options_play.strikes.length === 1) {
        const strike = options_play.strikes[0];
        const isCall = /call/.test(strat);
        const leg = (isCall ? chain.calls : chain.puts || []).find((o) => Math.abs(o.strike - strike) < 0.01);
        if (leg) {
          const mid = leg.bid && leg.ask ? +((leg.bid + leg.ask) / 2).toFixed(2) : (leg.last || null);
          if (mid) {
            options_play.est_premium = mid;                       // per share
            options_play.iv = leg.iv || null;
            options_play.chain_expiry = chain.expiry;
            if (strat === "long_call") { options_play.breakeven = +(strike + mid).toFixed(2); options_play.max_loss_per_contract = +(mid * 100).toFixed(2); }
            if (strat === "long_put") { options_play.breakeven = +(strike - mid).toFixed(2); options_play.max_loss_per_contract = +(mid * 100).toFixed(2); }
            if (strat === "covered_call" || strat === "cash_secured_put") { options_play.premium_received_per_contract = +(mid * 100).toFixed(2); }
          }
        }
      }
    }
  }

  return {
    symbol: c.symbol, asset_type: c.asset_type, name: c.name, side,
    current_price: price,
    entry_low: +entryLow.toFixed(6), entry_high: +entryHigh.toFixed(6),
    stop_loss: +stop.toFixed(6),
    targets,
    horizon_min_days: Math.max(1, Math.round(r.horizon_min_days || 5)),
    horizon_max_days: Math.max(2, Math.round(r.horizon_max_days || 30)),
    confidence: +conf.toFixed(2),
    risk_reward: rr,
    rationale: String(r.rationale || "").slice(0, 2000),
    options_play,
  };
}

// Duplicate guard: is there already an ACTIVE (open/tracking) recommendation this new
// idea would just repeat? Rules:
//   - different side           -> allowed (a short after a long is a different strategy)
//   - options play vs options play -> allowed UNLESS same strategy+strike+expiry
//   - equity idea vs equity idea (same side) -> DUPLICATE if entry zones overlap or the
//     entry midpoints are within 5% (a "new" idea must be materially different)
async function duplicateOf(rec) {
  const db = require("../db");
  const rows = await db.all("SELECT id, side, entry_low, entry_high, options_play, taken FROM recommendations WHERE symbol=? AND status IN ('open','tracking')", [rec.symbol]);
  for (const ex of rows) {
    const exPlay = J(ex.options_play, null);
    if (rec.options_play) {   // options exception: multiple strategies per ticker are fine
      if (exPlay && exPlay.strategy === rec.options_play.strategy &&
          String(exPlay.expiry) === String(rec.options_play.expiry) &&
          JSON.stringify(exPlay.strikes || []) === JSON.stringify(rec.options_play.strikes || [])) return ex;
      continue;
    }
    if (exPlay) continue;                    // equity idea vs existing options idea: different instruments
    if (ex.side !== rec.side) continue;      // opposite side = genuinely different strategy
    const overlap = rec.entry_low <= ex.entry_high && rec.entry_high >= ex.entry_low;
    const midEx = (ex.entry_low + ex.entry_high) / 2;
    const midNew = (rec.entry_low + rec.entry_high) / 2;
    if (overlap || Math.abs(midNew - midEx) / midEx < 0.05) return ex;
  }
  return null;
}

// Calibration loop-back: the shadow-tracked outcomes grade every past recommendation,
// so the model can be shown ITS OWN track record per confidence bucket and correct a
// miscalibrated confidence scale (e.g. "your 0.7s only win 45%"). Returns a one-line
// summary for the scan prompt, or null when there isn't enough finished history.
async function calibrationSummary() {
  const db = require("../db");
  const rows = await db.all("SELECT confidence, status, outcome FROM recommendations WHERE status IN ('stopped','target_hit','closed')").catch(() => []);
  const fin = rows.map((r) => ({ conf: Number(r.confidence), status: r.status, o: J(r.outcome, {}) || {} }))
    .filter((r) => (r.status !== "closed" || r.o.result === "expired_settled") && r.o.pnl_pct != null && isFinite(r.conf));
  if (fin.length < 8) return null;                       // too little history to mean anything
  const buckets = [[0, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]];
  const parts = [];
  for (const [lo, hi] of buckets) {
    const b = fin.filter((r) => r.conf >= lo && r.conf < hi);
    if (b.length < 3) continue;
    const winRate = Math.round((b.filter((r) => r.o.pnl_pct > 0).length / b.length) * 100);
    const avg = b.reduce((s, r) => s + r.o.pnl_pct, 0) / b.length;
    parts.push(`conf ${lo.toFixed(1)}–${hi > 1 ? "1.0" : hi.toFixed(1)}: ${winRate}% win, avg ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}% (n=${b.length})`);
  }
  if (!parts.length) return null;
  return `YOUR TRACK RECORD (all past recommendations, shadow-graded against real prices): ${parts.join("; ")}. ` +
    "Calibrate confidence honestly against this — if a bucket underperforms its number, your scale needs correcting downward.";
}

// context = { market: {...}, candidates: [{symbol, asset_type, name, price, indicators, headlines, smart_money, options_chain?}] }
// onProgress(message): live progress line per AI call — the scanner wires it into the
// scan log, so grouped/per-candidate runs are watchable instead of opaque.
// Batching (Settings → AI → Scan batching): 'single' = one call for the whole
// shortlist; 'grouped' = ~4 candidates per call; 'per_candidate' = one each. Smaller
// batches trade cost/latency for rigor: no cross-candidate bleed, no truncation risk.
async function recommend(context, onProgress = () => {}) {
  const s = settings.getSync();
  const prefs = s.preferences;
  const calib = await calibrationSummary().catch(() => null);
  const sys = systemPrompt(prefs) + (calib ? `\n\n${calib}` : "");
  const marketC = compactMarket(context.market);
  const candsC = context.candidates.map(compactCandidate);
  const mode = s.ai.scan_batching || "single";
  const size = mode === "per_candidate" ? 1 : mode === "grouped" ? 4 : Math.max(1, candsC.length);
  const groups = [];
  for (let i = 0; i < candsC.length; i += size) groups.push(candsC.slice(i, i + size));

  const candidateMap = {};
  for (const c of context.candidates) candidateMap[c.symbol.toUpperCase()] = c;
  const all = [], outlooks = [];
  let usage = null, model = null;
  for (const [gi, g] of groups.entries()) {
    if (groups.length > 1) onProgress(`AI ${gi + 1}/${groups.length}: ${g.map((c) => c.symbol).join(", ")}`);
    const r = await llm.chatJSON([
      { role: "system", content: sys },
      { role: "user", content: userPrompt(marketC, g) },
    ], { task: "scan" });
    model = r.model;
    if (r.usage && r.usage.total_tokens != null) usage = { total_tokens: (usage ? usage.total_tokens : 0) + r.usage.total_tokens };
    const recs = (Array.isArray(r.data.recommendations) ? r.data.recommendations : [])
      .map((x) => validateRec(x, candidateMap, prefs))
      .filter(Boolean);
    if (groups.length > 1) onProgress(`  → ${recs.length ? recs.map((x) => `${x.side} ${x.symbol}`).join(", ") : "no ideas"}`);
    all.push(...recs);
    if (r.data.market_outlook) outlooks.push(String(r.data.market_outlook));
  }
  // Best ideas win the per-scan cap when groups produced more than the limit.
  all.sort((a, b) => b.confidence - a.confidence);
  const recs = all.slice(0, prefs.risk.max_recommendations_per_scan);
  const market_outlook = (outlooks.sort((a, b) => b.length - a.length)[0] || "").slice(0, 1500);
  return { recs, market_outlook, usage, model };
}

// Re-validate an OPEN/TRACKING recommendation against CURRENT data: is the idea still
// good? Returns {verdict: 'valid'|'adjust'|'withdraw', note, updated?} and records it on
// the rec (outcome.revalidation). 'withdraw' closes the rec.
async function revalidate(recId) {
  const db = require("../db");
  const yahoo = require("../providers/yahoo");
  const news = require("../providers/news");
  const indicators = require("../indicators");
  const { logEvent } = require("../events");
  const s = settings.getSync();

  const r = await db.get("SELECT * FROM recommendations WHERE id=?", [recId]);
  if (!r) throw new Error("recommendation not found");
  if (!["open", "tracking"].includes(r.status)) throw new Error("only open/tracking recommendations can be re-validated");
  if (r.asset_type === "option") throw new Error("re-validation supports stock/crypto recommendations — option ideas are premium-tracked and settle at expiry instead");

  const ySym = yahooSym(r);
  const [q, candles, heads] = await Promise.all([
    yahoo.quote(ySym).catch(() => null),
    yahoo.history(ySym, 365),
    news.headlines(48, 60).catch(() => []),
  ]);
  const { latest } = indicators.computeAllCached(`an:${ySym}`, candles, s.indicators);
  const earnings = r.asset_type === "stock" ? await yahoo.nextEarnings(ySym).catch(() => null) : null;

  const llm = require("../ai/llm");
  const { data } = await llm.chatJSON([
    { role: "system", content: `You re-assess an existing trade recommendation against CURRENT market data.
Verdicts: "valid" (thesis intact, plan stands) | "adjust" (still good but levels should change — provide updated) | "withdraw" (thesis broken/stale — kill it).
Respond ONLY with JSON: {"verdict":"valid","note":"2-3 sentences grounded in the data","updated":{"entry_low":0,"entry_high":0,"stop_loss":0}|null}` },
    { role: "user", content: JSON.stringify({
      recommendation: { symbol: r.symbol, side: r.side, made_at: new Date(Number(r.created_at)).toISOString().slice(0, 10),
        price_then: r.current_price, entry: [r.entry_low, r.entry_high], stop: r.stop_loss,
        targets: JSON.parse(r.targets || "[]"), rationale_then: r.rationale, status: r.status },
      current: { price: q && q.price, indicators: latest, headlines: news.matching(heads, r.symbol.replace(/-USD$/, ""), r.name || "").map((h) => h.title), next_earnings: earnings },
    }) },
  ], { task: "scan" });

  const verdict = ["valid", "adjust", "withdraw"].includes(data.verdict) ? data.verdict : "valid";
  const note = String(data.note || "").slice(0, 600);
  const outcome = JSON.parse(r.outcome || "{}") || {};
  outcome.revalidation = { verdict, note, at: Date.now() };
  let updated = null;
  if (verdict === "adjust" && data.updated && typeof data.updated === "object") {
    const u = data.updated, num = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);
    updated = { entry_low: num(u.entry_low) || r.entry_low, entry_high: num(u.entry_high) || r.entry_high, stop_loss: num(u.stop_loss) || r.stop_loss };
    await db.run("UPDATE recommendations SET entry_low=?, entry_high=?, stop_loss=?, outcome=? WHERE id=?",
      [updated.entry_low, updated.entry_high, updated.stop_loss, JSON.stringify(outcome), r.id]);
  } else if (verdict === "withdraw") {
    if (r.taken) {
      // The user is IN this trade — never auto-close a taken recommendation. Record the
      // verdict as advice and keep tracking; exiting is the user's decision.
      outcome.revalidation.note = "(kept active — you have taken this trade; treat this as a SELL/EXIT suggestion) " + note;
      await db.run("UPDATE recommendations SET outcome=? WHERE id=?", [JSON.stringify(outcome), r.id]);
    } else {
      outcome.result = "withdrawn";
      await db.run("UPDATE recommendations SET status='closed', outcome=? WHERE id=?", [JSON.stringify(outcome), r.id]);
    }
  } else {
    await db.run("UPDATE recommendations SET outcome=? WHERE id=?", [JSON.stringify(outcome), r.id]);
  }
  await logEvent("rec_new", "recommendation", r.id, r.symbol,
    `♻ Re-validated ${r.symbol}: ${verdict.toUpperCase()}${updated ? ` (entry ${updated.entry_low}-${updated.entry_high}, stop ${updated.stop_loss})` : ""} — ${note.slice(0, 140)}`);
  return { verdict, note, updated };
}

module.exports = { recommend, revalidate, validateRec, duplicateOf, calibrationSummary, normalizeTargets, compactMarket, compactCandidate };
