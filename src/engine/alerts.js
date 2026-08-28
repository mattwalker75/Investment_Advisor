"use strict";
// Notification RULES: programmable "tell me when…" alerts, evaluated on a scheduler
// cadence and delivered through the channels that already exist (events feed, browser,
// priority-mapped webhook). "Follow a politician" is just a rule (type figure_filing) —
// one engine covers both features.
//
// Rule: { id, type, params: {...}, enabled: true, cooldown_min: 240,
//         delivery: "instant" | "digest", state: { fired: { subKey: ts }, seen: [...] } }
//
// Types (params):
//   price_above / price_below   { symbol, level }
//   pct_move_day                { scope: "symbol"|"watchlist"|"positions", symbol?, threshold }
//   rec_entry_zone              { }            — an active rec's live price is inside its entry zone
//   earnings_upcoming           { days }       — an open position reports within N days
//   macro_event_soon            { days }       — high-impact US macro event within N days (needs FMP key)
//   figure_filing               { name }       — a followed politician filed new trades
//   portfolio_drawdown          { threshold_pct } — realized equity curve is off its peak by more
//   provider_degraded           { }            — Yahoo circuit breaker is open
//
// delivery "digest": the hit is logged to the feed and queued for the daily briefing
// instead of pushing a webhook immediately (see drainDigest / briefing.js).
const db = require("../db");
const settings = require("../settings");
const { J, yahooSym } = require("../util");
const { logEvent } = require("../events");

const KEY = "alert_rules";
const DIGEST_KEY = "alert_digest_queue";
const RULE_TYPES = ["price_above", "price_below", "pct_move_day", "rec_entry_zone",
  "earnings_upcoming", "macro_event_soon", "figure_filing", "portfolio_drawdown", "provider_degraded"];

async function listRules() {
  const row = await db.get("SELECT value FROM settings WHERE `key`=?", [KEY]).catch(() => null);
  const list = row ? J(row.value, []) : [];
  return Array.isArray(list) ? list : [];
}
async function saveRules(rules) {
  await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"),
    [KEY, JSON.stringify(rules.slice(0, 50)), Date.now()]);
}

// Normalize/validate one rule (throws with the reason). Used by the API and chat tool.
function validateRule(raw) {
  const type = String(raw.type || "");
  if (!RULE_TYPES.includes(type)) throw new Error(`unknown rule type "${type}" — allowed: ${RULE_TYPES.join(", ")}`);
  const p = raw.params || {};
  const num = (v, lo, hi, dflt) => { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  const params = {};
  if (type === "price_above" || type === "price_below") {
    params.symbol = String(p.symbol || "").toUpperCase().trim();
    params.level = Number(p.level);
    if (!params.symbol || !isFinite(params.level) || params.level <= 0) throw new Error(type + " needs {symbol, level}");
  } else if (type === "pct_move_day") {
    params.scope = ["symbol", "watchlist", "positions"].includes(p.scope) ? p.scope : "positions";
    if (params.scope === "symbol") {
      params.symbol = String(p.symbol || "").toUpperCase().trim();
      if (!params.symbol) throw new Error("pct_move_day with scope=symbol needs a symbol");
    }
    params.threshold = num(p.threshold, 0.5, 90, 5);
  } else if (type === "earnings_upcoming" || type === "macro_event_soon") {
    params.days = Math.round(num(p.days, 1, 30, type === "earnings_upcoming" ? 5 : 2));
  } else if (type === "figure_filing") {
    params.name = String(p.name || "").trim();
    if (!params.name) throw new Error("figure_filing needs {name} (e.g. \"Pelosi\")");
  } else if (type === "portfolio_drawdown") {
    params.threshold_pct = num(p.threshold_pct, 1, 90, 10);
  }
  return {
    id: raw.id || Date.now().toString(36) + Math.abs((JSON.stringify(params) + type).split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0)).toString(36),
    type, params,
    enabled: raw.enabled !== false,
    cooldown_min: Math.round(num(raw.cooldown_min, 5, 10080, 240)),
    delivery: raw.delivery === "digest" ? "digest" : "instant",
    state: raw.state && typeof raw.state === "object" ? raw.state : {},
  };
}

function label(rule) {
  const p = rule.params;
  switch (rule.type) {
    case "price_above": return `${p.symbol} above ${p.level}`;
    case "price_below": return `${p.symbol} below ${p.level}`;
    case "pct_move_day": return `${p.scope === "symbol" ? p.symbol : p.scope} daily move > ${p.threshold}%`;
    case "rec_entry_zone": return "recommendation enters its entry zone";
    case "earnings_upcoming": return `earnings within ${p.days}d on a position`;
    case "macro_event_soon": return `macro event within ${p.days}d`;
    case "figure_filing": return `${p.name} files a trade`;
    case "portfolio_drawdown": return `portfolio drawdown > ${p.threshold_pct}%`;
    case "provider_degraded": return "data source degraded";
    default: return rule.type;
  }
}

// ---- Firing: per-(rule, subject) cooldown; digest rules queue instead of webhooking.
async function fire(rule, subKey, message) {
  const now = Date.now();
  rule.state.fired = rule.state.fired || {};
  const last = rule.state.fired[subKey] || 0;
  if (now - last < rule.cooldown_min * 60 * 1000) return false;
  rule.state.fired[subKey] = now;
  // keep state small
  const keys = Object.keys(rule.state.fired);
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete rule.state.fired[k];
  if (rule.delivery === "digest") {
    // feed-only event type (no webhook gate, no desktop alert) + the briefing queue
    await logEvent("alert_digest", "alert", null, null, `🔕 ${message} (queued for the daily briefing)`);
    const row = await db.get("SELECT value FROM settings WHERE `key`=?", [DIGEST_KEY]).catch(() => null);
    const q = (row ? J(row.value, []) : []) || [];
    q.push({ at: now, message });
    await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"), [DIGEST_KEY, JSON.stringify(q.slice(-40)), now]);
  } else {
    await logEvent("alert_rule", "alert", null, null, `🔔 ${message}`);
  }
  return true;
}

// The daily briefing PEEKS at queued digest hits while composing, and clears them only
// AFTER a successful generation — a failed LLM call must never lose queued alerts.
async function peekDigest() {
  const row = await db.get("SELECT value FROM settings WHERE `key`=?", [DIGEST_KEY]).catch(() => null);
  const q = (row ? J(row.value, []) : []) || [];
  return Array.isArray(q) ? q : [];
}
async function clearDigest() {
  await db.run(db.upsertSql("settings", ["key", "value", "updated_at"], "key"), [DIGEST_KEY, "[]", Date.now()]);
}
async function drainDigest() {   // peek + clear in one step (tests / manual use)
  const q = await peekDigest();
  if (q.length) await clearDigest();
  return q;
}

// ---- Evaluation pass (scheduler, ~5 min). Each type gathers its own data lazily and
// tolerates provider failures — a rule that can't evaluate just waits for the next pass.
async function evaluateRules() {
  const rules = (await listRules()).filter((r) => r.enabled !== false);
  if (!rules.length) return { evaluated: 0, fired: 0 };
  const yahoo = require("../providers/yahoo");
  let fired = 0;

  // batch quotes for all symbol-ish rules in one call. Bare crypto-looking symbols also
  // fetch their -USD pair — a "BTC" rule should track Bitcoin, not the same-lettered
  // NYSE ticker (qOf prefers the -USD quote when both exist).
  const wantQuotes = new Set();
  const addSym = (s) => { if (!s) return; wantQuotes.add(s); if (!s.includes("-")) wantQuotes.add(s + "-USD"); };
  for (const r of rules) {
    if ((r.type === "price_above" || r.type === "price_below") && r.params.symbol) addSym(r.params.symbol);
    if (r.type === "pct_move_day" && r.params.scope === "symbol") addSym(r.params.symbol);
  }
  let watchRows = null, posRows = null;
  const needWatch = rules.some((r) => r.type === "pct_move_day" && r.params.scope === "watchlist");
  const needPos = rules.some((r) => (r.type === "pct_move_day" && r.params.scope === "positions") || r.type === "earnings_upcoming");
  if (needWatch) watchRows = await db.all("SELECT symbol, yahoo_symbol FROM watchlist").catch(() => []);
  if (needPos) posRows = await db.all("SELECT symbol, asset_type FROM trades WHERE status='open'").catch(() => []);
  for (const w of watchRows || []) wantQuotes.add(w.yahoo_symbol);
  for (const t of posRows || []) if (t.asset_type !== "option") wantQuotes.add(yahooSym(t));
  const quotes = wantQuotes.size ? await yahoo.quotes([...wantQuotes]).catch(() => ({})) : {};
  const qOf = (sym) => (!sym.includes("-") && quotes[sym + "-USD"]) || quotes[sym] || null;

  for (const rule of rules) {
    try {
      const p = rule.params;
      switch (rule.type) {
        case "price_above": case "price_below": {
          const q = qOf(p.symbol);
          if (!q || q.price == null) break;
          const hit = rule.type === "price_above" ? q.price >= p.level : q.price <= p.level;
          if (hit) fired += await fire(rule, p.symbol, `${p.symbol} is ${rule.type === "price_above" ? "above" : "below"} your ${p.level} alert (now ${q.price})`);
          break;
        }
        case "pct_move_day": {
          const subjects = p.scope === "symbol" ? [{ sym: p.symbol, disp: p.symbol }]
            : p.scope === "watchlist" ? (watchRows || []).map((w) => ({ sym: w.yahoo_symbol, disp: w.symbol }))
            : (posRows || []).filter((t) => t.asset_type !== "option").map((t) => ({ sym: yahooSym(t), disp: t.symbol }));
          for (const s of subjects) {
            const q = qOf(s.sym);
            if (!q || q.change_pct == null) continue;
            if (Math.abs(q.change_pct) >= p.threshold)
              fired += await fire(rule, s.sym, `${s.disp} moved ${q.change_pct > 0 ? "+" : ""}${(+q.change_pct).toFixed(1)}% today (your ${p.threshold}% rule)`);
          }
          break;
        }
        case "rec_entry_zone": {
          const recs = await db.all("SELECT id, symbol, asset_type, side, entry_low, entry_high FROM recommendations WHERE status='open'").catch(() => []);
          const std = recs.filter((r) => r.asset_type !== "option");
          if (!std.length) break;
          const zq = await yahoo.quotes([...new Set(std.map(yahooSym))]).catch(() => ({}));
          for (const r of std) {
            const q = zq[yahooSym(r)];
            if (!q || q.price == null) continue;
            if (q.price >= r.entry_low && q.price <= r.entry_high)
              fired += await fire(rule, "rec" + r.id, `${r.symbol} is IN its ${r.side} entry zone ${r.entry_low}–${r.entry_high} (now ${q.price}) — actionable`);
          }
          break;
        }
        case "earnings_upcoming": {
          for (const t of (posRows || []).filter((x) => x.asset_type === "stock")) {
            const e = await yahoo.nextEarnings(t.symbol).catch(() => null);
            if (e && e.days_away <= p.days)
              fired += await fire(rule, t.symbol + e.date, `${t.symbol} (open position) reports earnings in ${e.days_away}d (${e.date})`);
          }
          break;
        }
        case "macro_event_soon": {
          const cal = await require("../providers/calendar").economicCalendar(p.days).catch(() => null);
          for (const e of (cal && cal.events) || []) {
            fired += await fire(rule, e.date + e.event, `Macro: ${e.event} on ${String(e.date).slice(0, 10)}`);
          }
          break;
        }
        case "figure_filing": {
          const whales = require("../providers/whales");
          const trades = await whales.politicianTrades(p.name);
          rule.state.seen = Array.isArray(rule.state.seen) ? rule.state.seen : null;
          const keys = trades.map((t) => `${t.ticker}|${t.action}|${t.traded_at}|${t.amount}`);
          // First pass with REAL data baselines silently (no spam for old filings). An
          // empty/failed feed must NOT baseline — it would make every existing filing
          // look "new" once the provider recovers.
          if (rule.state.seen === null) { if (trades.length) rule.state.seen = keys.slice(0, 100); break; }
          const fresh = trades.filter((t, i) => !rule.state.seen.includes(keys[i]));
          for (const t of fresh.slice(0, 5)) {
            fired += await fire(rule, keys[trades.indexOf(t)],
              `🏛 ${t.politician} ${t.action === "buy" ? "bought" : t.action === "sell" ? "sold" : "traded"} ${t.ticker || t.asset_name}${t.option ? ` (${t.option.kind}s)` : ""} ${t.amount ? `(${t.amount})` : ""} — traded ${t.traded_at}, disclosed ${t.disclosed_at || "recently"}`);
          }
          rule.state.seen = [...new Set([...keys, ...rule.state.seen])].slice(0, 200);
          break;
        }
        case "portfolio_drawdown": {
          const e = await require("./portfolio").equityCurves();
          const st = e.actual && e.actual.stats;
          if (st && st.max_drawdown_pct >= p.threshold_pct && e.actual.series.length) {
            const last = e.actual.series[e.actual.series.length - 1].value;
            const peak = Math.max(e.starting_equity, ...e.actual.series.map((x) => x.value));
            const cur = ((peak - last) / peak) * 100;
            if (cur >= p.threshold_pct)
              fired += await fire(rule, "dd", `Portfolio is ${cur.toFixed(1)}% off its peak (your ${p.threshold_pct}% drawdown rule)`);
          }
          break;
        }
        case "provider_degraded": {
          const h = yahoo.providerHealth();
          if (h.yahoo_cooling_down)
            fired += await fire(rule, "yahoo", "Data source degraded: Yahoo is rate-limiting this machine (cache + keyed sources serve meanwhile)");
          break;
        }
      }
    } catch (_) { /* a rule that can't evaluate waits for the next pass */ }
  }
  // Persist state/cooldowns by MERGING into the current list (re-read): a rule the user
  // added, removed, or toggled while this pass ran must survive — only evaluation state
  // is written back, keyed by id.
  const evaluated = new Map(rules.map((r) => [r.id, r]));
  const current = await listRules();
  await saveRules(current.map((r) => (evaluated.has(r.id) ? { ...r, state: evaluated.get(r.id).state } : r)));
  return { evaluated: rules.length, fired };
}

module.exports = { listRules, saveRules, validateRule, evaluateRules, fire, drainDigest, peekDigest, clearDigest, label, RULE_TYPES };
