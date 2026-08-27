"use strict";
// Trade routes: listing with live P&L, manual entry, plan updates, exits, AI health
// checks, portfolio concentration, and the CSV export. Mounted at /api by server.js.
const express = require("express");

const db = require("../db");
const yahoo = require("../providers/yahoo");
const { J, yahooSym, toCsv } = require("../util");

const router = express.Router();

const rowTrade = (t) => ({
  ...t, targets: J(t.targets, []), exits: (J(t.exits, []) || []).filter((e) => !e.alert),
  suggested_stop: J(t.suggested_stop, null), health: J(t.health, null), option_details: J(t.option_details, null),
});

router.get("/trades", async (req, res) => {
  const status = req.query.status;
  const rows = status
    ? await db.all("SELECT * FROM trades WHERE status=? ORDER BY id DESC LIMIT 200", [status])
    : await db.all("SELECT * FROM trades ORDER BY id DESC LIMIT 200");
  const out = rows.map(rowTrade);
  // Live unrealized P&L for open trades. Shares/coins price off the quote; OPTIONS price
  // off the current chain premium at their strike/expiry (contract multiplier 100).
  const open = out.filter((t) => t.status === "open");
  if (open.length) {
    const syms = [...new Set(open.filter((t) => t.asset_type !== "option").map(yahooSym))];
    // Option chains: fetch once per unique {symbol, expiry} in parallel — multiple
    // contracts on the same underlying/expiry were each refetching the chain serially.
    const optTrades = open.filter((t) => t.asset_type === "option" && t.option_details);
    const chainKeys = [...new Set(optTrades.map((t) => `${t.symbol} ${t.option_details.expiry || ""}`))];
    const [quotes, chainPairs] = await Promise.all([
      syms.length ? yahoo.quotes(syms).catch(() => ({})) : {},
      Promise.all(chainKeys.map((k) => {
        const [sym, expiry] = k.split(" ");
        return yahoo.optionsChain(sym, 365, expiry || undefined).then((c) => [k, c]).catch(() => [k, null]);
      })),
    ]);
    const chains = Object.fromEntries(chainPairs);
    for (const t of open) {
      const soldQty = t.exits.reduce((s, e) => s + (e.qty || 0), 0);
      const remaining = t.qty - soldQty;
      const dir = t.side === "sell" ? -1 : 1;
      if (t.asset_type === "option" && t.option_details) {
        try {
          const od = t.option_details;
          const chain = chains[`${t.symbol} ${od.expiry || ""}`];
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
      const q = quotes[yahooSym(t)];
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
router.post("/trades", async (req, res) => {
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
router.post("/trades/health-check", async (req, res) => {
  try { res.json(await require("../engine/health").checkPositions(req.query.id || null)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Update the plan on an open trade: stop loss and/or targets (used to apply the
// advisor's suggested stop, or for manual adjustments). Advisory tool — the user owns
// the actual order changes at their broker.
router.patch("/trades/:id", async (req, res) => {
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
router.post("/trades/:id/exit", async (req, res) => {
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

// Portfolio concentration: warn when open positions cluster in one sector.
router.get("/portfolio/concentration", async (_req, res) => {
  try {
    const open = await db.all("SELECT symbol, asset_type FROM trades WHERE status='open'");
    if (open.length < 2) return res.json({ positions: open.length, warnings: [] });
    // Sector lookups in parallel per unique non-crypto symbol.
    const stockSyms = [...new Set(open.filter((t) => t.asset_type !== "crypto").map((t) => t.symbol))];
    const sectors = Object.fromEntries(await Promise.all(
      stockSyms.map((sym) => yahoo.sector(sym).then((s) => [sym, s.sector || null]).catch(() => [sym, null]))));
    const buckets = {};
    for (const t of open) {
      const key = t.asset_type === "crypto" ? "Crypto" : (sectors[t.symbol] || "Unknown sector");
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

router.get("/export/trades.csv", async (_req, res) => {
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

module.exports = router;
