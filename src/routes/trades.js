"use strict";
// Trade routes: listing with live P&L, manual entry, plan updates, exits, AI health
// checks, portfolio concentration, and the CSV export. Mounted at /api by server.js.
const express = require("express");

const db = require("../db");
const yahoo = require("../providers/yahoo");
const { J, yahooSym, toCsv, parseCsv } = require("../util");

const router = express.Router();

const rowTrade = (t) => ({
  ...t, targets: J(t.targets, []), exits: (J(t.exits, []) || []).filter((e) => !e.alert),
  suggested_stop: J(t.suggested_stop, null), health: J(t.health, null), option_details: J(t.option_details, null),
  journal: J(t.journal, []) || [],
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
          // NET premium across ALL legs — a spread priced at its long leg alone showed
          // wildly overstated P&L. Deep-ITM legs missing from the near-money chain
          // window fall back to intrinsic value.
          let mid = null;
          if (chain) {
            const optionsEngine = require("../engine/options");
            const strategy = od.strategy && optionsEngine.LEGS[od.strategy] ? od.strategy : (od.type === "put" ? "long_put" : "long_call");
            const strikes = Array.isArray(od.strikes) && od.strikes.length ? od.strikes : (od.strike != null ? [od.strike] : null);
            if (strikes) {
              const priced = optionsEngine.netPremium(strategy, chain, strikes);
              if (priced) mid = priced.net;
              else if (chain.spot != null) mid = Math.max(0.01, optionsEngine.settlementPremium(strategy, strikes, chain.spot));
            }
          }
          if (mid != null) {
            t.last_price = +mid.toFixed(2);   // net premium per share
            const realized = t.exits.reduce((s, e) => s + dir * (e.price - t.entry_price) * (e.qty || 0) * 100, 0);
            t.unrealized_pnl = +(realized + dir * (mid - t.entry_price) * remaining * 100).toFixed(2);
            t.unrealized_pnl_pct = +((t.unrealized_pnl / (t.entry_price * t.qty * 100)) * 100).toFixed(2);
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

// Import existing positions from a broker CSV export: POST {"csv": "..."}.
// Header names are matched loosely (symbol/ticker, qty/shares/quantity,
// price/avg_cost/cost_basis…), extra columns are ignored, rows land as OPEN trades so
// health checks, concentration, tracking, and the briefing cover the whole portfolio.
const IMPORT_ALIASES = {
  symbol: ["symbol", "ticker", "instrument", "asset", "security"],
  qty: ["qty", "quantity", "shares", "units", "amount", "position", "position_size"],
  entry_price: ["entry_price", "price", "avg_cost", "avg_price", "average_cost", "average_price", "cost", "cost_basis", "purchase_price", "entry"],
  side: ["side", "direction", "position_side"],
  asset_type: ["asset_type", "type", "class", "asset_class"],
  entry_date: ["entry_date", "date", "opened", "open_date", "purchase_date", "acquired", "trade_date"],
  stop_loss: ["stop_loss", "stop"],
  notes: ["notes", "note", "description", "account"],
};
router.post("/trades/import", async (req, res) => {
  try {
    const csv = String((req.body && req.body.csv) || "");
    if (!csv.trim()) return res.status(400).json({ error: 'csv text required — POST {"csv": "..."}' });
    const rows = parseCsv(csv);
    if (rows.length < 2) return res.status(400).json({ error: "need a header row plus at least one data row" });
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
    const col = {};
    for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
      const idx = header.findIndex((h) => aliases.includes(h));
      if (idx >= 0) col[field] = idx;
    }
    if (col.symbol == null || col.qty == null || col.entry_price == null)
      return res.status(400).json({ error: "couldn't find symbol, quantity, and price columns", detected_headers: header });
    const { resolveAsset } = require("../resolve");
    const openExisting = await db.all("SELECT symbol, qty, entry_price FROM trades WHERE status='open'");
    const num = (v) => Number(String(v).replace(/[$,]/g, ""));
    let imported = 0, skipped = 0;
    const errors = [];
    for (const [n, raw] of rows.slice(1).entries()) {
      try {
        const get = (f) => (col[f] != null ? String(raw[col[f]] ?? "").trim() : "");
        const sym = get("symbol").toUpperCase();
        const qty = num(get("qty"));
        const price = num(get("entry_price"));
        if (!sym || !isFinite(qty) || qty <= 0 || !isFinite(price) || price <= 0) { errors.push(`row ${n + 2}: needs symbol, positive qty and price`); continue; }
        const hint = /crypto/i.test(get("asset_type")) ? "crypto" : /stock|equity/i.test(get("asset_type")) ? "stock" : undefined;
        const a = await resolveAsset(sym, hint);
        // Duplicate guard: an identical open position (symbol+qty+price) is skipped.
        if (openExisting.some((t) => t.symbol === a.display && Math.abs(t.qty - qty) < 1e-9 && Math.abs(t.entry_price - price) < 1e-6)) { skipped++; continue; }
        const side = /short|sell/i.test(get("side")) ? "sell" : "buy";
        const when = Date.parse(get("entry_date")) || Date.now();
        const stop = num(get("stop_loss"));
        await db.run(
          "INSERT INTO trades (rec_id, created_at, asset_type, symbol, side, qty, entry_price, entry_at, stop_loss, targets, option_details, status, notes) VALUES (NULL,?,?,?,?,?,?,?,?,?,NULL,'open',?)",
          [Date.now(), a.asset_type === "index" ? "stock" : a.asset_type, a.display, side, qty, price, when,
           isFinite(stop) && stop > 0 ? stop : null, JSON.stringify([]), get("notes") || "imported"]);
        openExisting.push({ symbol: a.display, qty, entry_price: price });   // in-file dupes too
        imported++;
      } catch (e) { errors.push(`row ${n + 2}: ${e.message}`); }
    }
    res.json({ imported, skipped_duplicates: skipped, errors: errors.slice(0, 20),
      note: imported ? "Imported positions are open trades — health checks, concentration warnings, tracking, and the daily briefing now cover them. Add stops via the ✎ button or ask the advisor." : undefined });
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

// Journal: append a timestamped note to a trade — open OR closed ("why I took it",
// "why I bailed early"). The weekly AI review reads these and coaches from them.
router.post("/trades/:id/journal", async (req, res) => {
  try {
    const t = await db.get("SELECT id, journal FROM trades WHERE id=?", [req.params.id]);
    if (!t) return res.status(404).json({ error: "trade not found" });
    const note = String((req.body && req.body.note) || "").trim().slice(0, 1000);
    if (!note) return res.status(400).json({ error: "note required" });
    const journal = (J(t.journal, []) || []);
    journal.push({ at: Date.now(), note });
    await db.run("UPDATE trades SET journal=? WHERE id=?", [JSON.stringify(journal.slice(-50)), t.id]);
    res.json({ ok: true, entries: journal.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record an exit (partial or full). Auto-closes when all quantity is exited.
router.post("/trades/:id/exit", async (req, res) => {
  try {
    const t = await db.get("SELECT * FROM trades WHERE id=?", [req.params.id]);
    if (!t || t.status !== "open") return res.status(404).json({ error: "open trade not found" });
    const { price, qty, reason, note } = req.body || {};
    if (!price || !qty) return res.status(400).json({ error: "price and qty are required" });
    const exits = (J(t.exits, []) || []);
    const exit = { at: Date.now(), price: Number(price), qty: Number(qty), reason: reason || "manual" };
    if (note && String(note).trim()) exit.note = String(note).trim().slice(0, 500);   // journal-worthy context
    exits.push(exit);
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
// (Logic shared with the advisor chat's get_portfolio_concentration tool.)
router.get("/portfolio/concentration", async (_req, res) => {
  try { res.json(await require("../engine/portfolio").concentration()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Portfolio risk panel: total $ at risk if every stop hits, no-stop flags, biggest risk.
router.get("/portfolio/risk", async (_req, res) => {
  try { res.json(await require("../engine/portfolio").riskPanel()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Equity curves: realized account curve + the what-if-every-rec-was-taken paper curve.
router.get("/portfolio/equity", async (_req, res) => {
  try { res.json(await require("../engine/portfolio").equityCurves()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/export/trades.csv", async (_req, res) => {
  const rows = await db.all("SELECT * FROM trades ORDER BY id");
  const out = rows.map((t) => {
    // Holding period for tax: short-term under 365 days, long-term at/over.
    const held = t.closed_at ? Math.max(0, Math.round((Number(t.closed_at) - Number(t.entry_at)) / 86400000)) : "";
    return {
      id: t.id, symbol: t.symbol, asset_type: t.asset_type, side: t.side, qty: t.qty,
      entry_price: t.entry_price, entry_date: new Date(Number(t.entry_at)).toISOString().slice(0, 10),
      stop_loss: t.stop_loss, status: t.status, pnl: t.pnl, pnl_pct: t.pnl_pct,
      closed_date: t.closed_at ? new Date(Number(t.closed_at)).toISOString().slice(0, 10) : "",
      holding_days: held, tax_term: t.closed_at ? (held >= 365 ? "long" : "short") : "",
      option: t.option_details || "", exits: (J(t.exits, []) || []).filter((e) => !e.alert).map((e) => `${e.qty}@${e.price}`).join("; "),
    };
  });
  res.setHeader("Content-Disposition", "attachment; filename=trades.csv");
  res.type("text/csv").send(toCsv(out, ["id", "symbol", "asset_type", "side", "qty", "entry_price", "entry_date", "stop_loss", "status", "pnl", "pnl_pct", "closed_date", "holding_days", "tax_term", "option", "exits"]));
});

module.exports = router;
