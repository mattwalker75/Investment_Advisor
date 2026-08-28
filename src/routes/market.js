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

// Data-source health: drives the topbar indicator so degradation is legible instead of
// silent ("why does everything feel stale?" → "Yahoo is cooling down / no keys set").
router.get("/health/providers", (_req, res) => {
  const h = yahoo.providerHealth();
  const hints = [];
  if (h.yahoo_cooling_down) hints.push(`Yahoo is rate-limiting this machine — paused ~${Math.max(1, Math.ceil(h.yahoo_cooldown_seconds_left / 60))} more min. Cached data and keyed sources serve meanwhile.`);
  if (!h.keys_set.fmp && !h.keys_set.finnhub) hints.push("Stock data is running keyless on Yahoo alone (throttle-prone). Two free keys fix it — Settings → Data feeds.");
  res.json({ ...h, status: h.yahoo_cooling_down ? "degraded" : (!h.keys_set.fmp && !h.keys_set.finnhub) ? "keyless" : "ok", hints });
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
    ], { max_tokens: 2000, task: "light" });
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
    const row = await db.get("SELECT * FROM watchlist WHERE id=?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "watchlist entry not found" });
    const b = req.body || {};
    // Partial update: only fields PRESENT in the body change — an alert-only edit must
    // never erase the stored note. Changing a level re-arms its alert.
    const above = b.alert_above !== undefined ? (b.alert_above ? Number(b.alert_above) : null) : row.alert_above;
    const below = b.alert_below !== undefined ? (b.alert_below ? Number(b.alert_below) : null) : row.alert_below;
    const note = b.note !== undefined ? (b.note || null) : row.note;
    await db.run("UPDATE watchlist SET alert_above=?, alert_below=?, note=?, alerts_fired=NULL WHERE id=?",
      [above, below, note, row.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/watchlist/:id", async (req, res) => {
  await db.run("DELETE FROM watchlist WHERE id=?", [req.params.id]);
  res.json({ ok: true });
});

// ---------- Notification rules ----------
router.get("/alerts", async (_req, res) => {
  const alerts = require("../engine/alerts");
  res.json({ rules: (await alerts.listRules()).map((r) => ({ ...r, label: alerts.label(r), state: undefined })), types: alerts.RULE_TYPES });
});
// Replace the whole rule list (the editor sends it complete). Existing rules keep their
// evaluation state (seen filings, cooldowns) by id.
router.put("/alerts", async (req, res) => {
  try {
    const alerts = require("../engine/alerts");
    const existing = await alerts.listRules();
    const incoming = Array.isArray(req.body && req.body.rules) ? req.body.rules : [];
    const rules = incoming.map((r) => {
      const v = alerts.validateRule(r);
      const prev = existing.find((x) => x.id === v.id);
      if (prev) v.state = prev.state;
      return v;
    });
    await alerts.saveRules(rules);
    res.json({ ok: true, rules: rules.map((r) => ({ ...r, label: alerts.label(r), state: undefined })) });
  } catch (e) { res.status(422).json({ error: e.message }); }
});

// ---------- Notable figures (congress) + company insiders (Form 4) ----------
// ?name= filters to one person; follows are figure_filing rules under the hood.
router.get("/figures", async (req, res) => {
  try {
    const whales = require("../providers/whales");
    const alerts = require("../engine/alerts");
    const name = String(req.query.name || "").trim();
    const [people, trades, rules] = await Promise.all([
      whales.politicians(),
      name ? whales.politicianTrades(name) : whales.congressFeed().then((f) => f.slice(0, 40)),
      alerts.listRules(),
    ]);
    const followed = rules.filter((r) => r.type === "figure_filing").map((r) => r.params.name);
    res.json({
      politicians: people.slice(0, 40), trades, followed,
      note: people.length ? "Disclosures lag 30–45 days by law; amounts are ranges; options show in descriptions; crypto is essentially absent from congressional disclosures."
        : "Congressional data needs the free FMP key — Settings → Data feeds.",
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Follow/unfollow = add/remove a figure_filing rule (instant delivery by default).
router.post("/figures/follow", async (req, res) => {
  try {
    const alerts = require("../engine/alerts");
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    const rules = await alerts.listRules();
    const i = rules.findIndex((r) => r.type === "figure_filing" && r.params.name.toLowerCase() === name.toLowerCase());
    if (req.body.unfollow) {
      if (i >= 0) rules.splice(i, 1);
    } else if (i < 0) {
      rules.push(alerts.validateRule({ type: "figure_filing", params: { name }, cooldown_min: 60 }));
    }
    await alerts.saveRules(rules);
    res.json({ ok: true, followed: rules.filter((r) => r.type === "figure_filing").map((r) => r.params.name) });
  } catch (e) { res.status(422).json({ error: e.message }); }
});
router.get("/insiders/:symbol", async (req, res) => {
  try { res.json(await require("../providers/whales").insiderTrades(req.params.symbol)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Events feed ----------
router.get("/events", async (req, res) => {
  // LIMIT is inlined (server-clamped int): a bound `LIMIT ?` breaks mysql2's execute().
  const lim = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = await db.all(`SELECT * FROM events ORDER BY id DESC LIMIT ${lim}`);
  res.json(rows);
});

module.exports = router;
