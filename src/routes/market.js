"use strict";
// Market-data routes for the UI: charts, quotes, search, the dashboard snapshot,
// smart-money, the AI headline review, the watchlist, and the events feed. Mounted at
// /api by server.js. Both chart and quote accept stocks AND crypto in any spelling
// ("NVDA", "BTC", "bitcoin", "ETH-USD") — the resolver maps crypto to its -USD pair.
const express = require("express");

const db = require("../db");
const settings = require("../settings");
const llm = require("../ai/llm");
const yahoo = require("../providers/yahoo");
const news = require("../providers/news");
const sentiment = require("../providers/sentiment");
const whales = require("../providers/whales");
const indicators = require("../indicators");
const { resolveAsset } = require("../resolve");
const { J } = require("../util");

const router = express.Router();

router.get("/chart/:symbol", async (req, res) => {
  try {
    const a = await resolveAsset(req.params.symbol, req.query.asset_type);
    const days = Math.min(1825, Number(req.query.days) || 365);
    // Short ranges get intraday candles (hourly ≤ 10 days) for a tighter view.
    const interval = req.query.interval || (days <= 10 ? "1h" : "1d");
    // Charts are fresh-or-nothing: never render stale candles as if they were current.
    const candles = await yahoo.history(a.yahoo, days, interval, { allowStale: false });
    const s = settings.getSync();
    const { series, latest } = indicators.computeAllCached(`chart:${a.yahoo}:${days}:${interval}`, candles, s.indicators);
    res.json({ symbol: a.yahoo, display: a.display, name: a.name, asset_type: a.asset_type, interval, candles, series, latest });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get("/quote/:symbol", async (req, res) => {
  try {
    const a = await resolveAsset(req.params.symbol, req.query.asset_type);
    res.json(await yahoo.quote(a.yahoo));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get("/search", async (req, res) => {
  try { res.json(await yahoo.search(String(req.query.q || ""))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Dashboard market snapshot: indexes + BTC/ETH + sentiment + headlines + regime.
router.get("/market", async (_req, res) => {
  const [quotes, senti, heads, regime] = await Promise.all([
    yahoo.quotes(["SPY", "QQQ", "DIA", "BTC-USD", "ETH-USD"]).catch(() => ({})),
    sentiment.snapshot().catch(() => ({})),
    news.headlines(24, 20).catch(() => []),
    require("../engine/regime").marketRegime().catch(() => null),
  ]);
  res.json({ quotes, sentiment: senti, headlines: heads, regime });
});

router.get("/whales", async (_req, res) => {
  try { res.json(await whales.snapshot()); } catch (e) { res.status(502).json({ error: e.message }); }
});

// AI headline-sentiment review. The dashboard's default sentiment is a fast keyword
// lexicon; this has the AI re-grade the current 24h headline set for MARKET sentiment.
// Grades are stored in an overlay (keyed by title) so they persist across cache refreshes.
router.post("/news/ai-review", async (_req, res) => {
  try {
    const heads = await news.headlines(24, 20);
    if (!heads.length) return res.json({ reviewed: 0, headlines: [] });
    const { data } = await llm.chatJSON([
      { role: "system", content: `You grade financial news headlines by their MARKET sentiment — the likely impact on the referenced asset, sector, or market (not the emotional tone).
"pos" = bullish/supportive, "neg" = bearish/risk, "neu" = neutral/unclear/informational.
Respond ONLY with JSON: {"sentiments":[{"i":0,"s":"pos"}, ...]} — one entry per headline index.` },
      { role: "user", content: JSON.stringify(heads.map((h, i) => ({ i, title: h.title }))) },
    ], { max_tokens: 2000 });
    const overlay = {};
    let changed = 0;
    for (const v of (Array.isArray(data.sentiments) ? data.sentiments : [])) {
      const h = heads[Number(v.i)];
      const s = ["pos", "neg", "neu"].includes(v.s) ? v.s : null;
      if (!h || !s) continue;
      overlay[news.titleKey(h.title)] = s;
      if (h.sentiment !== s) changed++;
    }
    await news.saveOverlay(overlay);
    res.json({ reviewed: Object.keys(overlay).length, changed, headlines: await news.headlines(24, 20) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Watchlist ----------
router.get("/watchlist", async (_req, res) => {
  const rows = await db.all("SELECT * FROM watchlist ORDER BY id DESC");
  // live quotes for the list
  const quotes = rows.length ? await yahoo.quotes([...new Set(rows.map((w) => w.yahoo_symbol))]).catch(() => ({})) : {};
  res.json(rows.map((w) => {
    const q = quotes[w.yahoo_symbol];
    return { ...w, alerts_fired: J(w.alerts_fired, {}), price: q ? q.price : null, change_pct: q ? q.change_pct : null };
  }));
});
router.post("/watchlist", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.symbol) return res.status(400).json({ error: "symbol required" });
    const a = await resolveAsset(b.symbol, b.asset_type);
    const r = await db.run(
      "INSERT INTO watchlist (created_at, symbol, yahoo_symbol, asset_type, name, note, alert_above, alert_below) VALUES (?,?,?,?,?,?,?,?)",
      [Date.now(), a.display, a.yahoo, a.asset_type === "index" ? "stock" : a.asset_type, a.name, b.note || null,
       b.alert_above ? Number(b.alert_above) : null, b.alert_below ? Number(b.alert_below) : null]);
    res.json({ ok: true, id: r.lastID, resolved: a });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/watchlist/:id", async (req, res) => {
  try {
    const b = req.body || {};
    // Changing an alert level re-arms it (clears the fired marker).
    await db.run("UPDATE watchlist SET alert_above=?, alert_below=?, note=?, alerts_fired=NULL WHERE id=?",
      [b.alert_above ? Number(b.alert_above) : null, b.alert_below ? Number(b.alert_below) : null, b.note || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/watchlist/:id", async (req, res) => {
  await db.run("DELETE FROM watchlist WHERE id=?", [req.params.id]);
  res.json({ ok: true });
});

// ---------- Events feed ----------
router.get("/events", async (req, res) => {
  const rows = await db.all("SELECT * FROM events ORDER BY id DESC LIMIT ?", [Math.min(200, Number(req.query.limit) || 50)]);
  res.json(rows);
});

module.exports = router;
