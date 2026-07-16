"use strict";
// Investment Advisor — Express server + REST API. Local-first: binds 127.0.0.1 only.
// Start with ./ADVISOR.sh --start (or `npm start`). UI at http://localhost:8210.
const express = require("express");
const path = require("path");
const fs = require("fs");

const db = require("./src/db");
const settings = require("./src/settings");
const llm = require("./src/ai/llm");
const yahoo = require("./src/providers/yahoo");
const news = require("./src/providers/news");
const sentiment = require("./src/providers/sentiment");
const whales = require("./src/providers/whales");
const indicators = require("./src/indicators");
const scanner = require("./src/engine/scanner");
const tracker = require("./src/engine/tracker");
const scheduler = require("./src/scheduler");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
// The charting library, served straight from node_modules (no CDN, works offline).
app.use("/vendor/lightweight-charts", express.static(path.join(__dirname, "node_modules", "lightweight-charts", "dist")));

const J = (s, fb) => { try { return JSON.parse(s); } catch (_) { return fb; } };
const rowRec = (r) => {
  const inp = J(r.inputs, null);
  return {
    ...r, targets: J(r.targets, []), options_play: J(r.options_play, null), outcome: J(r.outcome, null),
    // Slim extracts for the card (full snapshot stays behind /api/recommendations/:id):
    earnings: (inp && inp.candidate && inp.candidate.next_earnings) || null,
    signals: (inp && inp.candidate && inp.candidate.indicators && inp.candidate.indicators.signals) || [],
    source: inp && inp.source === "advisor_chat" ? "chat" : "scan",
    inputs: undefined,
  };
};
const rowTrade = (t) => ({
  ...t, targets: J(t.targets, []), exits: (J(t.exits, []) || []).filter((e) => !e.alert),
  suggested_stop: J(t.suggested_stop, null), health: J(t.health, null), option_details: J(t.option_details, null),
});

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// ---------- Settings ----------
app.get("/api/settings", async (_req, res) => {
  res.json(settings.publicView(await settings.getAll()));
});
app.put("/api/settings/:block", async (req, res) => {
  try {
    const block = req.params.block;
    const incoming = req.body || {};
    // Masked secrets: '•••' means "keep what's stored" — never overwrite with the mask.
    const cur = await settings.getAll();
    if (block === "ai" && incoming.api_key === "•••") incoming.api_key = cur.ai.api_key;
    if (block === "providers") {
      if (incoming.alpha_vantage_key === "•••") incoming.alpha_vantage_key = cur.providers.alpha_vantage_key;
      if (incoming.finnhub_key === "•••") incoming.finnhub_key = cur.providers.finnhub_key;
      if (incoming.fmp_key === "•••") incoming.fmp_key = cur.providers.fmp_key;
    }
    if (block === "notifications" && incoming.webhook_url === "•••") incoming.webhook_url = cur.notifications.webhook_url;
    await settings.setBlock(block, incoming);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/ai/test", async (req, res) => {
  try {
    const cfg = req.body || {};
    if (cfg.api_key === "•••") cfg.api_key = (await settings.getAll()).ai.api_key;
    res.json(await llm.test(cfg));
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
// List models from an OpenAI-compatible endpoint (GET {base}/models) — works for
// OpenAI's catalog AND a local Ollama/LM Studio (returns installed models). Feeds the
// model dropdown in Settings. OpenAI's list is filtered down to chat-capable families.
app.post("/api/ai/models", async (req, res) => {
  try {
    const cfg = req.body || {};
    let key = cfg.api_key;
    if (key === "•••") key = (await settings.getAll()).ai.api_key;
    const base = String(cfg.base_url || (await settings.getAll()).ai.base_url || "").replace(/\/+$/, "");
    if (!base) return res.status(400).json({ error: "base_url required" });
    const headers = { accept: "application/json" };
    if (key) headers.Authorization = "Bearer " + key;
    const r = await fetch(base + "/models", { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(502).json({ error: `${r.status} from ${base}/models — check the URL${r.status === 401 ? " and API key" : ""}` });
    const d = await r.json();
    let ids = (d.data || []).map((m) => m.id).filter(Boolean)
      .filter((id) => !/embed/i.test(id));   // embedding models can't chat, any provider
    if (/openai\.com/.test(base)) {
      // Chat-capable families only — hide audio/image/moderation/etc. models.
      ids = ids.filter((id) => /^(gpt-|chatgpt|o[0-9])/.test(id) &&
        !/(audio|tts|whisper|dall-e|image|realtime|moderation|transcribe|search)/.test(id));
    }
    res.json({ models: ids.sort() });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// DB connection config (ADVISOR_CONFIG.json — the one file-based setting). Password masked.
app.get("/api/db/config", (_req, res) => {
  try {
    const cfg = db.loadConfig();
    if (cfg.mysql) cfg.mysql = { ...cfg.mysql, password: cfg.mysql.password ? "•••" : "" };
    res.json({ ...cfg, dialect_active: db.dialect });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/db/config", (req, res) => {
  try {
    const incoming = req.body || {};
    const raw = JSON.parse(fs.readFileSync(db.CONFIG_FILE, "utf8"));
    if (incoming.mysql && incoming.mysql.password === "•••") incoming.mysql.password = raw.db.mysql.password;
    raw.db = { ...raw.db, ...incoming };
    fs.writeFileSync(db.CONFIG_FILE, JSON.stringify(raw, null, 2));
    res.json({ ok: true, note: "Saved. Run ./ADVISOR.sh --init-db to create the schema, then --restart to switch." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Watchlist ----------
app.get("/api/watchlist", async (_req, res) => {
  const rows = await db.all("SELECT * FROM watchlist ORDER BY id DESC");
  // live quotes for the list
  const quotes = rows.length ? await yahoo.quotes([...new Set(rows.map((w) => w.yahoo_symbol))]).catch(() => ({})) : {};
  res.json(rows.map((w) => {
    const q = quotes[w.yahoo_symbol];
    return { ...w, alerts_fired: J(w.alerts_fired, {}), price: q ? q.price : null, change_pct: q ? q.change_pct : null };
  }));
});
app.post("/api/watchlist", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.symbol) return res.status(400).json({ error: "symbol required" });
    const a = await require("./src/resolve").resolveAsset(b.symbol, b.asset_type);
    const r = await db.run(
      "INSERT INTO watchlist (created_at, symbol, yahoo_symbol, asset_type, name, note, alert_above, alert_below) VALUES (?,?,?,?,?,?,?,?)",
      [Date.now(), a.display, a.yahoo, a.asset_type === "index" ? "stock" : a.asset_type, a.name, b.note || null,
       b.alert_above ? Number(b.alert_above) : null, b.alert_below ? Number(b.alert_below) : null]);
    res.json({ ok: true, id: r.lastID, resolved: a });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/watchlist/:id", async (req, res) => {
  try {
    const b = req.body || {};
    // Changing an alert level re-arms it (clears the fired marker).
    await db.run("UPDATE watchlist SET alert_above=?, alert_below=?, note=?, alerts_fired=NULL WHERE id=?",
      [b.alert_above ? Number(b.alert_above) : null, b.alert_below ? Number(b.alert_below) : null, b.note || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/watchlist/:id", async (req, res) => {
  await db.run("DELETE FROM watchlist WHERE id=?", [req.params.id]);
  res.json({ ok: true });
});

// ---------- Re-validate a recommendation against current data ----------
app.post("/api/recommendations/:id/revalidate", async (req, res) => {
  try { res.json(await require("./src/engine/recommender").revalidate(Number(req.params.id))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Daily briefing ----------
app.get("/api/briefing", async (_req, res) => {
  res.json((await require("./src/engine/briefing").latest()) || {});
});
app.post("/api/briefing", async (_req, res) => {
  try { res.json(await require("./src/engine/briefing").run("manual")); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Threshold backtester ----------
app.post("/api/backtest", async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await require("./src/engine/backtest").run(Array.isArray(b.symbols) && b.symbols.length ? b.symbols : null, Number(b.min_signals) || 2));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- AI headline-sentiment review ----------
// The dashboard's default sentiment is a fast keyword lexicon; this endpoint has the AI
// re-grade the current 24h headline set for MARKET sentiment. Grades are stored in an
// overlay (keyed by title) so they persist across news-cache refreshes.
app.post("/api/news/ai-review", async (_req, res) => {
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

// ---------- Portfolio concentration ----------
app.get("/api/portfolio/concentration", async (_req, res) => {
  try {
    const open = await db.all("SELECT symbol, asset_type FROM trades WHERE status='open'");
    if (open.length < 2) return res.json({ positions: open.length, warnings: [] });
    const buckets = {};
    for (const t of open) {
      let key;
      if (t.asset_type === "crypto") key = "Crypto";
      else {
        const s = await yahoo.sector(t.symbol).catch(() => ({ sector: null }));
        key = s.sector || "Unknown sector";
      }
      buckets[key] = buckets[key] || []; buckets[key].push(t.symbol);
    }
    const warnings = [];
    for (const [sector, syms] of Object.entries(buckets)) {
      const share = syms.length / open.length;
      if (syms.length >= 2 && share >= 0.5)
        warnings.push(`⚠ ${Math.round(share * 100)}% of your open positions are ${sector} (${syms.join(", ")}) — correlated risk.`);
    }
    res.json({ positions: open.length, by_sector: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])), warnings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- CSV export ----------
function toCsv(rows, cols) {
  const escape = (v) => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => escape(r[c])).join(","))].join("\n");
}
app.get("/api/export/trades.csv", async (_req, res) => {
  const rows = await db.all("SELECT * FROM trades ORDER BY id");
  const out = rows.map((t) => ({
    id: t.id, symbol: t.symbol, asset_type: t.asset_type, side: t.side, qty: t.qty,
    entry_price: t.entry_price, entry_date: new Date(Number(t.entry_at)).toISOString().slice(0, 10),
    stop_loss: t.stop_loss, status: t.status, pnl: t.pnl, pnl_pct: t.pnl_pct,
    closed_date: t.closed_at ? new Date(Number(t.closed_at)).toISOString().slice(0, 10) : "",
    option: t.option_details || "", exits: (J(t.exits, []) || []).filter((e) => !e.alert).map((e) => `${e.qty}@${e.price}`).join("; "),
  }));
  res.setHeader("Content-Disposition", "attachment; filename=trades.csv");
  res.type("text/csv").send(toCsv(out, ["id", "symbol", "asset_type", "side", "qty", "entry_price", "entry_date", "stop_loss", "status", "pnl", "pnl_pct", "closed_date", "option", "exits"]));
});
app.get("/api/export/recommendations.csv", async (_req, res) => {
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

// ---------- Advisor chat (tool-calling conversation over all the tool's data) ----------
app.post("/api/advisor-chat", async (req, res) => {
  try {
    const msgs = (Array.isArray(req.body && req.body.messages) ? req.body.messages : [])
      .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string");
    if (!msgs.length || msgs[msgs.length - 1].role !== "user")
      return res.status(400).json({ error: "messages must end with a user turn" });
    const advisorChat = require("./src/ai/chat");

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

// ---------- Scanning ----------
app.post("/api/scan", (req, res) => {
  if (scanner.status().running) return res.status(409).json({ error: "a scan is already running" });
  scanner.runScan("manual").catch(() => {});    // runs in background; UI polls status
  res.json({ started: true });
});
app.get("/api/scan/status", async (_req, res) => {
  const st = scanner.status();
  const last = await db.get("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1");
  res.json({ ...st, last: last ? { ...last, log: J(last.log, []) } : null });
});
app.get("/api/runs", async (_req, res) => {
  const rows = await db.all("SELECT id, trigger_type, status, started_at, finished_at, universe_count, shortlist_count, recs_count, error FROM scan_runs ORDER BY id DESC LIMIT 25");
  res.json(rows);
});

// ---------- Recommendations ----------
app.get("/api/recommendations", async (req, res) => {
  const status = req.query.status;
  const rows = status
    ? await db.all("SELECT * FROM recommendations WHERE status=? ORDER BY id DESC LIMIT 200", [status])
    : await db.all("SELECT * FROM recommendations ORDER BY id DESC LIMIT 200");
  const out = rows.map(rowRec);
  // Live context for ACTIONABLE recs: current price (in-zone math) + sector for stocks.
  const act = out.filter((r) => ["open", "tracking"].includes(r.status));
  if (act.length) {
    const ysym = (r) => (r.asset_type === "crypto" && !r.symbol.includes("-") ? r.symbol + "-USD" : r.symbol);
    const qs = await yahoo.quotes([...new Set(act.map(ysym))]).catch(() => ({}));
    for (const r of act) {
      const q = qs[ysym(r)];
      if (q && q.price != null) r.live_price = q.price;
      if (r.asset_type === "stock") {
        try { r.sector = (await yahoo.sector(r.symbol)).sector || null; } catch (_) {}
      }
    }
  }
  res.json(out);
});
app.get("/api/recommendations/:id", async (req, res) => {
  const r = await db.get("SELECT * FROM recommendations WHERE id=?", [req.params.id]);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json({ ...rowRec(r), inputs: J(r.inputs, null) });
});
// "I took this trade" — creates the tracked trade from the recommendation. Two forms:
//   shares (default):      { qty, entry_price }
//   the rec's options play: { instrument:'option', qty(contracts), entry_price(premium/share) }
app.post("/api/recommendations/:id/take", async (req, res) => {
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
app.post("/api/recommendations/:id/complete", async (req, res) => {
  try {
    const r = await db.get("SELECT * FROM recommendations WHERE id=?", [req.params.id]);
    if (!r) return res.status(404).json({ error: "not found" });
    if (!["open", "tracking"].includes(r.status)) return res.status(400).json({ error: "already finished" });
    const outcome = J(r.outcome, {}) || {};
    outcome.result = "completed_by_user"; outcome.exit_at = Date.now();
    if (r.status === "tracking" && outcome.entry_price != null) {
      const ysym = r.asset_type === "crypto" && !r.symbol.includes("-") ? r.symbol + "-USD" : r.symbol;
      const q = await yahoo.quote(ysym).catch(() => null);
      const price = (q && q.price) ?? outcome.last_price ?? outcome.entry_price;
      const targets = J(r.targets, []);
      const hit = outcome.targets_hit || [];
      const dir = r.side === "sell" ? -1 : 1;
      let pnl = 0, used = 0;
      for (const t of targets) if (hit.includes(t.price)) { pnl += (t.sell_pct / 100) * (((t.price - outcome.entry_price) / outcome.entry_price) * 100 * dir); used += t.sell_pct; }
      if (used < 100) pnl += ((100 - used) / 100) * (((price - outcome.entry_price) / outcome.entry_price) * 100 * dir);
      outcome.pnl_pct = +pnl.toFixed(2); outcome.exit_price = price;
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
app.post("/api/recommendations/refresh", async (_req, res) => {
  try {
    const act = await db.all("SELECT DISTINCT symbol, asset_type FROM recommendations WHERE status IN ('open','tracking')");
    for (const r of act) {
      const ysym = r.asset_type === "crypto" && !r.symbol.includes("-") ? r.symbol + "-USD" : r.symbol;
      await db.run("DELETE FROM cache WHERE `key`=?", ["yq:" + ysym]);
    }
    await tracker.trackRecommendations();
    res.json({ ok: true, refreshed: act.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/recommendations/:id/dismiss", async (req, res) => {
  await db.run("UPDATE recommendations SET status='closed', outcome=? WHERE id=? AND status IN ('open','tracking')",
    [JSON.stringify({ result: "dismissed", at: Date.now() }), req.params.id]);
  res.json({ ok: true });
});

// ---------- Trades ----------
app.get("/api/trades", async (req, res) => {
  const status = req.query.status;
  const rows = status
    ? await db.all("SELECT * FROM trades WHERE status=? ORDER BY id DESC LIMIT 200", [status])
    : await db.all("SELECT * FROM trades ORDER BY id DESC LIMIT 200");
  const out = rows.map(rowTrade);
  // Live unrealized P&L for open trades. Shares/coins price off the quote; OPTIONS price
  // off the current chain premium at their strike/expiry (contract multiplier 100).
  const open = out.filter((t) => t.status === "open");
  if (open.length) {
    const syms = [...new Set(open.filter((t) => t.asset_type !== "option").map((t) => (t.asset_type === "crypto" && !t.symbol.includes("-") ? `${t.symbol}-USD` : t.symbol)))];
    const quotes = syms.length ? await yahoo.quotes(syms).catch(() => ({})) : {};
    for (const t of open) {
      const soldQty = t.exits.reduce((s, e) => s + (e.qty || 0), 0);
      const remaining = t.qty - soldQty;
      const dir = t.side === "sell" ? -1 : 1;
      if (t.asset_type === "option" && t.option_details) {
        try {
          const od = t.option_details;
          const chain = await yahoo.optionsChain(t.symbol, 365, od.expiry);
          const leg = chain && (od.type === "put" ? chain.puts : chain.calls || []).find((o) => Math.abs(o.strike - od.strike) < 0.01);
          if (leg) {
            const mid = leg.bid && leg.ask ? (leg.bid + leg.ask) / 2 : leg.last;
            if (mid != null) {
              t.last_price = +mid.toFixed(2);   // premium per share
              const realized = t.exits.reduce((s, e) => s + dir * (e.price - t.entry_price) * (e.qty || 0) * 100, 0);
              t.unrealized_pnl = +(realized + dir * (mid - t.entry_price) * remaining * 100).toFixed(2);
              t.unrealized_pnl_pct = +((t.unrealized_pnl / (t.entry_price * t.qty * 100)) * 100).toFixed(2);
            }
          }
          if (od.expiry) t.days_to_expiry = Math.round((Date.parse(od.expiry) - Date.now()) / 86400000);
        } catch (_) {}
        continue;
      }
      const q = quotes[t.asset_type === "crypto" && !t.symbol.includes("-") ? `${t.symbol}-USD` : t.symbol];
      if (q && q.price != null) {
        t.last_price = q.price;
        const realized = t.exits.reduce((s, e) => s + dir * (e.price - t.entry_price) * (e.qty || 0), 0);
        t.unrealized_pnl = +(realized + dir * (q.price - t.entry_price) * remaining).toFixed(2);
        t.unrealized_pnl_pct = +((t.unrealized_pnl / (t.entry_price * t.qty)) * 100).toFixed(2);
      }
    }
  }
  res.json(out);
});
// Manual trade (not from a recommendation). For options: asset_type='option',
// qty=contracts, entry_price=premium per share, option_details={type,strike,expiry}.
app.post("/api/trades", async (req, res) => {
  try {
    const b = req.body || {};
    for (const f of ["symbol", "asset_type", "side", "qty", "entry_price"]) if (!b[f]) return res.status(400).json({ error: f + " required" });
    let od = null;
    if (b.asset_type === "option") {
      od = b.option_details || {};
      if (!od.type || !od.strike || !od.expiry) return res.status(400).json({ error: "option trades need option_details {type, strike, expiry}" });
      od = { type: od.type === "put" ? "put" : "call", strike: Number(od.strike), expiry: String(od.expiry) };
    }
    const t = await db.run(
      "INSERT INTO trades (rec_id, created_at, asset_type, symbol, side, qty, entry_price, entry_at, stop_loss, targets, option_details, status, notes) VALUES (NULL,?,?,?,?,?,?,?,?,?,?,'open',?)",
      [Date.now(), b.asset_type, String(b.symbol).toUpperCase(), b.side === "sell" ? "sell" : "buy",
       Number(b.qty), Number(b.entry_price), Date.now(), b.stop_loss ? Number(b.stop_loss) : null,
       JSON.stringify(b.targets || []), od ? JSON.stringify(od) : null, b.notes || null]
    );
    res.json({ ok: true, trade_id: t.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// AI health check of open positions — all of them, or one (?id=). Synchronous: waits
// for the verdicts so the UI can show them immediately.
app.post("/api/trades/health-check", async (req, res) => {
  try { res.json(await require("./src/engine/health").checkPositions(req.query.id || null)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Update the plan on an open trade: stop loss and/or targets (used to apply the
// advisor's suggested stop, or for manual adjustments). Advisory tool — the user owns
// the actual order changes at their broker.
app.patch("/api/trades/:id", async (req, res) => {
  try {
    const t = await db.get("SELECT * FROM trades WHERE id=?", [req.params.id]);
    if (!t || t.status !== "open") return res.status(404).json({ error: "open trade not found" });
    const b = req.body || {};
    const stop = b.stop_loss != null ? Number(b.stop_loss) : t.stop_loss;
    const targets = Array.isArray(b.targets) ? JSON.stringify(b.targets) : t.targets;
    // Applying a suggestion clears it (it's been acted on).
    await db.run("UPDATE trades SET stop_loss=?, targets=?, suggested_stop=NULL WHERE id=?", [stop, targets, t.id]);
    if (b.stop_loss != null && b.stop_loss !== t.stop_loss)
      await db.run("INSERT INTO events (at, type, ref_type, ref_id, symbol, message) VALUES (?,?,?,?,?,?)",
        [Date.now(), "stop_moved", "trade", t.id, t.symbol, `Stop moved: ${t.symbol} ${t.stop_loss ?? "—"} → ${stop}`]);
    res.json({ ok: true, stop_loss: stop });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record an exit (partial or full). Auto-closes when all quantity is exited.
app.post("/api/trades/:id/exit", async (req, res) => {
  try {
    const t = await db.get("SELECT * FROM trades WHERE id=?", [req.params.id]);
    if (!t || t.status !== "open") return res.status(404).json({ error: "open trade not found" });
    const { price, qty, reason } = req.body || {};
    if (!price || !qty) return res.status(400).json({ error: "price and qty are required" });
    const exits = (J(t.exits, []) || []);
    exits.push({ at: Date.now(), price: Number(price), qty: Number(qty), reason: reason || "manual" });
    const realExits = exits.filter((e) => !e.alert);
    const soldQty = realExits.reduce((s, e) => s + e.qty, 0);
    const dir = t.side === "sell" ? -1 : 1;
    const mult = t.asset_type === "option" ? 100 : 1;   // option premiums are per share; contracts are 100
    let status = t.status, pnl = null, pnlPct = null, closedAt = null;
    if (soldQty >= t.qty - 1e-9) {
      status = "closed"; closedAt = Date.now();
      pnl = +realExits.reduce((s, e) => s + dir * (e.price - t.entry_price) * e.qty * mult, 0).toFixed(2);
      pnlPct = +((pnl / (t.entry_price * t.qty * mult)) * 100).toFixed(2);
    }
    await db.run("UPDATE trades SET exits=?, status=?, pnl=?, pnl_pct=?, closed_at=? WHERE id=?",
      [JSON.stringify(exits), status, pnl, pnlPct, closedAt, t.id]);
    if (status === "closed") {
      await db.run("INSERT INTO events (at, type, ref_type, ref_id, symbol, message) VALUES (?,?,?,?,?,?)",
        [Date.now(), "trade_close", "trade", t.id, t.symbol, `Trade closed: ${t.symbol} ${pnl >= 0 ? "+" : ""}$${pnl} (${pnlPct}%)`]);
      if (t.rec_id) await db.run("UPDATE recommendations SET status='closed' WHERE id=? AND status IN ('open','tracking')", [t.rec_id]);
    }
    res.json({ ok: true, status, pnl, pnl_pct: pnlPct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Market data for the UI ----------
// Both accept stocks AND crypto in any spelling ("NVDA", "BTC", "bitcoin", "ETH-USD") —
// the resolver maps crypto to its Yahoo -USD pair automatically.
app.get("/api/chart/:symbol", async (req, res) => {
  try {
    const a = await require("./src/resolve").resolveAsset(req.params.symbol, req.query.asset_type);
    const days = Math.min(1825, Number(req.query.days) || 365);
    // Short ranges get intraday candles (hourly ≤ 10 days) for a tighter view.
    const interval = req.query.interval || (days <= 10 ? "1h" : "1d");
    // Charts are fresh-or-nothing: never render stale candles as if they were current.
    const candles = await yahoo.history(a.yahoo, days, interval, { allowStale: false });
    const s = settings.getSync();
    const { series, latest } = indicators.computeAll(candles, s.indicators);
    res.json({ symbol: a.yahoo, display: a.display, name: a.name, asset_type: a.asset_type, interval, candles, series, latest });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/api/quote/:symbol", async (req, res) => {
  try {
    const a = await require("./src/resolve").resolveAsset(req.params.symbol, req.query.asset_type);
    res.json(await yahoo.quote(a.yahoo));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/api/search", async (req, res) => {
  try { res.json(await yahoo.search(String(req.query.q || ""))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
// Dashboard market snapshot: indexes + BTC/ETH + sentiment + headlines.
app.get("/api/market", async (_req, res) => {
  const [quotes, senti, heads] = await Promise.all([
    yahoo.quotes(["SPY", "QQQ", "DIA", "BTC-USD", "ETH-USD"]).catch(() => ({})),
    sentiment.snapshot().catch(() => ({})),
    news.headlines(24, 20).catch(() => []),
  ]);
  res.json({ quotes, sentiment: senti, headlines: heads });
});
app.get("/api/whales", async (_req, res) => {
  try { res.json(await whales.snapshot()); } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Performance / success rate ----------
app.get("/api/performance", async (_req, res) => {
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
    },
  });
});

// Send a test notification through the configured webhook.
app.post("/api/notify/test", async (req, res) => {
  try {
    const { sendWebhook } = require("./src/notify");
    const url = (req.body && req.body.webhook_url) || undefined;
    if (url && url !== "•••") {
      // Test the URL from the form before it's saved.
      const s = require("./src/settings");
      const cur = (await s.getAll()).notifications;
      await s.setBlock("notifications", { ...cur, webhook_url: url });
    }
    const ok = await sendWebhook("Investment Advisor", "🔔 Test notification — your webhook works.");
    res.json({ ok });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- Events feed ----------
app.get("/api/events", async (req, res) => {
  const rows = await db.all("SELECT * FROM events ORDER BY id DESC LIMIT ?", [Math.min(200, Number(req.query.limit) || 50)]);
  res.json(rows);
});

// ---------- Boot ----------
const PORT = Number(process.env.PORT || 8210);
(async () => {
  await db.init();
  await settings.load();
  scheduler.start();
  // Kick one tracking pass shortly after boot so statuses are fresh.
  setTimeout(() => { tracker.trackRecommendations().catch(() => {}); tracker.trackTrades().catch(() => {}); }, 5000);
  app.listen(PORT, "127.0.0.1", () => console.log(`Investment Advisor listening on http://localhost:${PORT} (db: ${db.dialect})`));
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
