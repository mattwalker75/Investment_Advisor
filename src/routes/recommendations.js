"use strict";
// Recommendation routes: listing, detail, take/complete/dismiss/refresh/revalidate, and
// the CSV export. Mounted at /api by server.js.
const express = require("express");

const db = require("../db");
const yahoo = require("../providers/yahoo");
const tracker = require("../engine/tracker");
const { J, yahooSym, ladderPnl, toCsv } = require("../util");

const router = express.Router();

// Row shaping for the UI card: JSON columns parsed, slim extracts pulled from the input
// snapshot (the full snapshot stays behind /api/recommendations/:id).
const rowRec = (r) => {
  const inp = J(r.inputs, null);
  return {
    ...r, targets: J(r.targets, []), options_play: J(r.options_play, null), outcome: J(r.outcome, null),
    earnings: (inp && inp.candidate && inp.candidate.next_earnings) || null,
    signals: (inp && inp.candidate && inp.candidate.indicators && inp.candidate.indicators.signals) || [],
    source: inp && inp.source === "advisor_chat" ? "chat" : "scan",
    inputs: undefined,
  };
};

router.get("/recommendations", async (req, res) => {
  const status = req.query.status;
  const rows = status
    ? await db.all("SELECT * FROM recommendations WHERE status=? ORDER BY id DESC LIMIT 200", [status])
    : await db.all("SELECT * FROM recommendations ORDER BY id DESC LIMIT 200");
  const out = rows.map(rowRec);
  // Live context for ACTIONABLE recs: current price (in-zone math) + sector for stocks.
  const act = out.filter((r) => ["open", "tracking"].includes(r.status));
  if (act.length) {
    // Quotes in one batch; sector lookups fan out in parallel per UNIQUE stock symbol.
    const stockSyms = [...new Set(act.filter((r) => r.asset_type === "stock").map((r) => r.symbol))];
    const [qs, sectorPairs] = await Promise.all([
      yahoo.quotes([...new Set(act.map(yahooSym))]).catch(() => ({})),
      Promise.all(stockSyms.map((sym) => yahoo.sector(sym).then((s) => [sym, s.sector || null]).catch(() => [sym, null]))),
    ]);
    const sectors = Object.fromEntries(sectorPairs);
    for (const r of act) {
      const q = qs[yahooSym(r)];
      if (q && q.price != null) r.live_price = q.price;
      if (r.asset_type === "stock") r.sector = sectors[r.symbol] ?? null;
    }
  }
  res.json(out);
});

router.get("/recommendations/:id", async (req, res) => {
  const r = await db.get("SELECT * FROM recommendations WHERE id=?", [req.params.id]);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json({ ...rowRec(r), inputs: J(r.inputs, null) });
});

// "I took this trade" — creates the tracked trade from the recommendation. Two forms:
//   shares (default):      { qty, entry_price }
//   the rec's options play: { instrument:'option', qty(contracts), entry_price(premium/share) }
router.post("/recommendations/:id/take", async (req, res) => {
  try {
    const r = await db.get("SELECT * FROM recommendations WHERE id=?", [req.params.id]);
    if (!r) return res.status(404).json({ error: "not found" });
    const b = req.body || {};
    if (!b.qty || !b.entry_price) return res.status(400).json({ error: "qty and entry_price are required" });
    let assetType = r.asset_type, optionDetails = null;
    if (b.instrument === "option") {
      const play = J(r.options_play, null);
      if (!play) return res.status(400).json({ error: "this recommendation has no options play" });
      assetType = "option";
      optionDetails = {
        type: /put/.test(play.strategy) ? "put" : "call",
        strategy: play.strategy,
        strike: (play.strikes && play.strikes[0]) || null,
        expiry: play.chain_expiry || play.expiry || null,
      };
    }
    const t = await db.run(
      "INSERT INTO trades (rec_id, created_at, asset_type, symbol, side, qty, entry_price, entry_at, stop_loss, targets, option_details, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,'open')",
      [r.id, Date.now(), assetType, r.symbol, r.side, Number(b.qty), Number(b.entry_price), Date.now(), r.stop_loss, r.targets,
       optionDetails ? JSON.stringify(optionDetails) : null]
    );
    await db.run("UPDATE recommendations SET taken=1 WHERE id=?", [r.id]);
    const desc = optionDetails ? `${b.qty} contract(s) ${r.symbol} ${optionDetails.strike}${optionDetails.type === "put" ? "P" : "C"} ${optionDetails.expiry} @ ${b.entry_price}` : `${b.qty} ${r.symbol} @ ${b.entry_price}`;
    await db.run("INSERT INTO events (at, type, ref_type, ref_id, symbol, message) VALUES (?,?,?,?,?,?)",
      [Date.now(), "trade_open", "trade", t.lastID, r.symbol, `Trade opened: ${r.side.toUpperCase()} ${desc}`]);
    res.json({ ok: true, trade_id: t.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark a recommendation COMPLETE (user's call). A tracking rec is graded at the live
// price (hit targets earn their rungs, remainder exits at current) so it still counts
// in the honest stats; an open (never-entered) rec just closes.
router.post("/recommendations/:id/complete", async (req, res) => {
  try {
    const r = await db.get("SELECT * FROM recommendations WHERE id=?", [req.params.id]);
    if (!r) return res.status(404).json({ error: "not found" });
    if (!["open", "tracking"].includes(r.status)) return res.status(400).json({ error: "already finished" });
    const outcome = J(r.outcome, {}) || {};
    outcome.result = "completed_by_user"; outcome.exit_at = Date.now();
    if (r.status === "tracking" && outcome.entry_price != null) {
      const q = await yahoo.quote(yahooSym(r)).catch(() => null);
      const price = (q && q.price) ?? outcome.last_price ?? outcome.entry_price;
      outcome.pnl_pct = ladderPnl(outcome.entry_price, outcome.targets_hit || [], J(r.targets, []), price, r.side);
      outcome.exit_price = price;
    }
    await db.run("UPDATE recommendations SET status='closed', outcome=? WHERE id=?", [JSON.stringify(outcome), r.id]);
    await db.run("INSERT INTO events (at, type, ref_type, ref_id, symbol, message) VALUES (?,?,?,?,?,?)",
      [Date.now(), "rec_expired", "recommendation", r.id, r.symbol,
       `✔ ${r.symbol} marked complete${outcome.pnl_pct != null ? ` — shadow ${outcome.pnl_pct > 0 ? "+" : ""}${outcome.pnl_pct}%` : ""}`]);
    res.json({ ok: true, pnl_pct: outcome.pnl_pct ?? null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Refresh: pull FRESH prices for active recs (bypassing the quote cache) and run a
// shadow-tracking pass — updates statuses/phases WITHOUT touching any strategy levels.
router.post("/recommendations/refresh", async (_req, res) => {
  try {
    const act = await db.all("SELECT DISTINCT symbol, asset_type FROM recommendations WHERE status IN ('open','tracking')");
    for (const r of act) await db.run("DELETE FROM cache WHERE `key`=?", ["yq:" + yahooSym(r)]);
    await tracker.trackRecommendations();
    res.json({ ok: true, refreshed: act.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/recommendations/:id/dismiss", async (req, res) => {
  await db.run("UPDATE recommendations SET status='closed', outcome=? WHERE id=? AND status IN ('open','tracking')",
    [JSON.stringify({ result: "dismissed", at: Date.now() }), req.params.id]);
  res.json({ ok: true });
});

// Re-validate a recommendation against current data (AI verdict: valid/adjust/withdraw).
router.post("/recommendations/:id/revalidate", async (req, res) => {
  try { res.json(await require("../engine/recommender").revalidate(Number(req.params.id))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get("/export/recommendations.csv", async (_req, res) => {
  const rows = await db.all("SELECT * FROM recommendations ORDER BY id");
  const out = rows.map((r) => {
    const o = J(r.outcome, {}) || {};
    return { id: r.id, date: new Date(Number(r.created_at)).toISOString().slice(0, 10), symbol: r.symbol,
      asset_type: r.asset_type, side: r.side, price_at_rec: r.current_price, entry_low: r.entry_low, entry_high: r.entry_high,
      stop_loss: r.stop_loss, targets: r.targets, confidence: r.confidence, risk_reward: r.risk_reward,
      status: r.status, taken: r.taken, outcome_pnl_pct: o.pnl_pct ?? "" };
  });
  res.setHeader("Content-Disposition", "attachment; filename=recommendations.csv");
  res.type("text/csv").send(toCsv(out, ["id", "date", "symbol", "asset_type", "side", "price_at_rec", "entry_low", "entry_high", "stop_loss", "targets", "confidence", "risk_reward", "status", "taken", "outcome_pnl_pct"]));
});

module.exports = router;
