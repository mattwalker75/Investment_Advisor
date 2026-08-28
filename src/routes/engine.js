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

// ---------- Performance / success rate ----------
router.get("/performance", async (_req, res) => {
  const recs = await db.all("SELECT id, symbol, asset_type, side, status, confidence, created_at, outcome, taken FROM recommendations ORDER BY id DESC LIMIT 1000");
  const parsed = recs.map((r) => ({ ...r, outcome: J(r.outcome, {}) || {} }));
  const finished = parsed.filter((r) => ["stopped", "target_hit"].includes(r.status) && r.outcome.pnl_pct != null);
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
