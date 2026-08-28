"use strict";
// AI-engine routes: scans, the advisor chat, briefings, the backtester, and the
// performance/success-rate stats. Mounted at /api by server.js.
const express = require("express");

const db = require("../db");
const scanner = require("../engine/scanner");
const { J } = require("../util");

const router = express.Router();

// ---------- Scanning ----------
router.post("/scan", (req, res) => {
  if (scanner.status().running) return res.status(409).json({ error: "a scan is already running" });
  scanner.runScan("manual").catch(() => {});    // runs in background; UI polls status
  res.json({ started: true });
});
router.get("/scan/status", async (_req, res) => {
  const st = scanner.status();
  const last = await db.get("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1");
  res.json({ ...st, last: last ? { ...last, log: J(last.log, []) } : null });
});
router.get("/runs", async (_req, res) => {
  const rows = await db.all("SELECT id, trigger_type, status, started_at, finished_at, universe_count, shortlist_count, recs_count, error FROM scan_runs ORDER BY id DESC LIMIT 25");
  res.json(rows);
});

// ---------- Daily briefing ----------
router.get("/briefing", async (_req, res) => {
  res.json((await require("../engine/briefing").latest()) || {});
});
router.post("/briefing", async (_req, res) => {
  try { res.json(await require("../engine/briefing").run("manual")); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Weekly AI review ----------
router.get("/review/weekly", async (_req, res) => {
  res.json((await require("../engine/briefing").latestWeekly()) || {});
});
router.post("/review/weekly", async (_req, res) => {
  try { res.json(await require("../engine/briefing").runWeekly("manual")); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Threshold backtester ----------
router.post("/backtest", async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await require("../engine/backtest").run(
      Array.isArray(b.symbols) && b.symbols.length ? b.symbols : null,
      { min_signals: Number(b.min_signals) || 2, slippage_pct: b.slippage_pct, fee_pct: b.fee_pct,
        exit_model: b.exit_model, oos_split_pct: b.oos_split_pct }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Strategy Lab ----------
// Compile plain English → spec (shown to the user before running — nothing hidden).
router.post("/strategy/compile", async (req, res) => {
  try {
    const description = String((req.body && req.body.description) || "").trim();
    if (!description) return res.status(400).json({ error: "description required" });
    res.json(await require("../engine/strategylab").compileStrategy(description));
  } catch (e) { res.status(422).json({ error: e.message }); }
});
// Run a spec; ?critique=1 adds the AI feedback (a second model call).
router.post("/strategy/run", async (req, res) => {
  try {
    const lab = require("../engine/strategylab");
    const results = await lab.runStrategy(req.body && req.body.spec);
    if (req.query.critique && results.total_trades > 0) {
      try { results.critique = await lab.critiqueStrategy(results.spec, results); }
      catch (e) { results.critique = "(AI feedback unavailable: " + e.message + ")"; }
    }
    res.json(results);
  } catch (e) { res.status(422).json({ error: e.message }); }
});
router.get("/strategies", async (_req, res) => {
  res.json(await require("../engine/strategylab").listStrategies());
});
router.put("/strategies", async (req, res) => {
  try { res.json(await require("../engine/strategylab").saveStrategy(req.body && req.body.spec)); }
  catch (e) { res.status(422).json({ error: e.message }); }
});
router.delete("/strategies/:name", async (req, res) => {
  res.json(await require("../engine/strategylab").deleteStrategy(String(req.params.name)));
});

// ---------- Predictive analysis: the projection cone ----------
router.get("/predict/:symbol", async (req, res) => {
  try {
    const a = await require("../resolve").resolveAsset(req.params.symbol, req.query.asset_type);
    if (!a) return res.status(400).json({ error: "symbol required" });
    const cone = await require("../engine/predict").projectionCone(a.yahoo, String(req.query.horizon || "1m"),
      { interval: req.query.interval === "1h" ? "1h" : "1d" });
    res.json({ ...cone, display: a.display, asset_type: a.asset_type });
  } catch (e) { res.status(422).json({ error: e.message }); }
});

// ---------- Advisor chat (tool-calling conversation over all the tool's data) ----------
router.post("/advisor-chat", async (req, res) => {
  try {
    // The client re-sends its full localStorage history each turn — bound it server-side
    // so a huge history can't balloon model cost/latency: keep the newest 40 turns, clip
    // each to 8k chars (24k for the live user turn, which may be a long paste).
    const msgs = (Array.isArray(req.body && req.body.messages) ? req.body.messages : [])
      .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
      .slice(-40)
      .map((m, i, arr) => ({ role: m.role, content: m.content.slice(0, i === arr.length - 1 ? 24000 : 8000) }));
    if (!msgs.length || msgs[msgs.length - 1].role !== "user")
      return res.status(400).json({ error: "messages must end with a user turn" });
    const advisorChat = require("../ai/chat");

    // ?stream=1 → newline-delimited JSON events over a chunked response:
    //   {type:'tools'|'token'|'reset'|'done'|'error', ...}
    if (req.query.stream) {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no");
      const send = (ev) => { try { res.write(JSON.stringify(ev) + "\n"); } catch (_) {} };
      try { await advisorChat.converseStream(msgs, send); }
      catch (e) { send({ type: "error", error: e.message }); }
      return res.end();
    }
    res.json(await advisorChat.converse(msgs));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Performance attribution: where does the edge actually come from? ----------
router.get("/performance/attribution", async (_req, res) => {
  try {
    const recs = await db.all("SELECT asset_type, status, confidence, created_at, outcome, inputs FROM recommendations ORDER BY id");
    const fin = recs
      .map((r) => ({ ...r, o: J(r.outcome, {}) || {}, inp: J(r.inputs, {}) || {} }))
      .filter((r) => (["stopped", "target_hit"].includes(r.status) || (r.status === "closed" && r.o.result === "expired_settled")) && r.o.pnl_pct != null);
    const grp = (rows) => {
      const wins = rows.filter((r) => r.o.pnl_pct > 0);
      return { n: rows.length, win_rate: rows.length ? +((wins.length / rows.length) * 100).toFixed(1) : null,
        avg_pnl_pct: rows.length ? +(rows.reduce((s, r) => s + r.o.pnl_pct, 0) / rows.length).toFixed(2) : null };
    };
    const sourceOf = (r) => r.inp.source === "advisor_chat" ? "chat"
      : r.inp.source === "strategy_signal" ? "your strategies"
      : r.asset_type === "option" ? "options scan" : "scan";
    const regimeOf = (r) => (r.inp.market && r.inp.market.regime && r.inp.market.regime.regime) || "unknown";
    const groupBy = (fn) => {
      const m = {};
      for (const r of fin) (m[fn(r)] = m[fn(r)] || []).push(r);
      return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, grp(v)]));
    };
    // Calibration drift: the earlier half of finished recs vs the later half.
    const half = Math.floor(fin.length / 2);
    const drift = fin.length >= 8 ? {
      early: { ...grp(fin.slice(0, half)), avg_confidence: +(fin.slice(0, half).reduce((s, r) => s + (r.confidence || 0), 0) / half).toFixed(2) },
      late: { ...grp(fin.slice(half)), avg_confidence: +(fin.slice(half).reduce((s, r) => s + (r.confidence || 0), 0) / (fin.length - half)).toFixed(2) },
    } : null;
    // Realized trade dollars by asset class.
    const closed = await db.all("SELECT asset_type, pnl FROM trades WHERE status='closed'");
    const tradeDollars = {};
    for (const t of closed) tradeDollars[t.asset_type] = +((tradeDollars[t.asset_type] || 0) + (t.pnl || 0)).toFixed(2);
    res.json({
      finished: fin.length,
      by_source: groupBy(sourceOf),
      by_regime_at_entry: groupBy(regimeOf),
      by_asset: groupBy((r) => r.asset_type),
      calibration_drift: drift,
      realized_trade_pnl_by_asset: tradeDollars,
      note: "Shadow-graded recommendation outcomes split by origin, market regime at entry, and asset class — plus realized trade dollars. Small groups (n<10) are noise, not signal.",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Performance / success rate ----------
router.get("/performance", async (_req, res) => {
  const recs = await db.all("SELECT id, symbol, asset_type, side, status, confidence, created_at, outcome, taken FROM recommendations ORDER BY id DESC LIMIT 1000");
  const parsed = recs.map((r) => ({ ...r, outcome: J(r.outcome, {}) || {} }));
  // Finished = graded against real prices: stopped, full ladder, or an option settled
  // at expiry (status closed + result expired_settled).
  const finished = parsed.filter((r) =>
    (["stopped", "target_hit"].includes(r.status) || (r.status === "closed" && r.outcome.result === "expired_settled"))
    && r.outcome.pnl_pct != null);
  const wins = finished.filter((r) => r.outcome.pnl_pct > 0);
  const trades = await db.all("SELECT * FROM trades WHERE status='closed' ORDER BY id DESC LIMIT 500");
  const tWins = trades.filter((t) => (t.pnl || 0) > 0);
  const avg = (arr, f) => (arr.length ? +(arr.reduce((s, x) => s + f(x), 0) / arr.length).toFixed(2) : null);
  res.json({
    recommendations: {
      total: parsed.length,
      open: parsed.filter((r) => r.status === "open").length,
      tracking: parsed.filter((r) => r.status === "tracking").length,
      finished: finished.length,
      expired: parsed.filter((r) => r.status === "expired").length,
      wins: wins.length,
      win_rate: finished.length ? +((wins.length / finished.length) * 100).toFixed(1) : null,
      avg_pnl_pct: avg(finished, (r) => r.outcome.pnl_pct),
      by_asset: {
        stock: finished.filter((r) => r.asset_type === "stock").length,
        crypto: finished.filter((r) => r.asset_type === "crypto").length,
        option: finished.filter((r) => r.asset_type === "option").length,
      },
      recent_finished: finished.slice(0, 25).map((r) => ({ id: r.id, symbol: r.symbol, side: r.side, status: r.status, pnl_pct: r.outcome.pnl_pct, taken: r.taken })),
    },
    trades: {
      closed: trades.length,
      wins: tWins.length,
      win_rate: trades.length ? +((tWins.length / trades.length) * 100).toFixed(1) : null,
      total_pnl: +trades.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2),
      avg_pnl_pct: avg(trades, (t) => t.pnl_pct || 0),
      // Tax view: realized P&L split by holding period (≥365 days = long-term).
      by_term: (() => {
        const term = (t) => (t.closed_at && t.entry_at && (Number(t.closed_at) - Number(t.entry_at)) >= 365 * 86400000 ? "long" : "short");
        const sum = (which) => trades.filter((t) => term(t) === which);
        const mk = (arr) => ({ count: arr.length, pnl: +arr.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2) });
        return { short: mk(sum("short")), long: mk(sum("long")) };
      })(),
    },
  });
});

module.exports = router;
