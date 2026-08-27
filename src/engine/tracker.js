"use strict";
// The tracker — two jobs, two cadences:
//
//  1. SHADOW-TRACK every recommendation against real prices (even ones the user skipped):
//     entry zone touched -> 'tracking'; stop crossed -> 'stopped'; final target -> 'target_hit';
//     entry never touched in time -> 'expired'. This is what makes the success-rate stats
//     honest — the system is graded on EVERYTHING it said, not just what the user took.
//
//  2. WATCH TAKEN TRADES tightly: emit events the moment price crosses the stop or any
//     target ladder rung. Closing/partial exits stay a USER action (they own the position);
//     the tracker's job is to make sure they never miss the moment.
const db = require("../db");
const settings = require("../settings");
const yahoo = require("../providers/yahoo");
const indicators = require("../indicators");

const now = () => Date.now();
const { logEvent } = require("../events");
const { J, yahooSym, ladderPnl } = require("../util");

// ---- Gap backfill: nothing may be missed while the app was OFF. ----
// Live tracking spot-checks current prices, so a multi-day shutdown would blind us to a
// stop pierced and recovered in between. On any pass that follows a big gap (>45 min
// since the last pass — e.g. server restart after days), we replay CANDLES covering the
// downtime chronologically and process entry/targets/stop exactly as live tracking
// would have. Same-bar ambiguity (stop AND target inside one bar's range) resolves
// conservatively: the stop counts first.
const LAST_PASS_KEY = "tracker:last_pass";
async function getLastPass() {
  const row = await db.get("SELECT value FROM cache WHERE `key`=?", [LAST_PASS_KEY]).catch(() => null);
  return row ? Number(row.value) : 0;
}
async function saveLastPass(ts) {
  await db.run(db.upsertSql("cache", ["key", "value", "fetched_at"], "key"),
    [LAST_PASS_KEY, String(ts), ts]).catch(() => {});
}
// Bar time -> [startMs, endMs] (daily bars are date strings; intraday are epoch seconds).
function barSpan(bar, interval) {
  if (typeof bar.time === "number") return [bar.time * 1000, bar.time * 1000 + 3600 * 1000];
  const start = Date.parse(bar.time + "T00:00:00Z");
  return [start, start + 86400 * 1000];
}

async function backfillGaps() {
  const last = await getLastPass();
  const now0 = now();
  if (last && now0 - last < 45 * 60 * 1000) return { skipped: true };   // no meaningful gap
  await saveLastPass(now0);
  if (!last) return { first_run: true };                                 // nothing to replay yet

  const recs = await db.all("SELECT * FROM recommendations WHERE status IN ('open','tracking')");
  const trades = await db.all("SELECT * FROM trades WHERE status='open'");
  if (!recs.length && !trades.length) return { backfilled: 0 };

  const gapDays = Math.min(90, Math.ceil((now0 - last) / 86400000) + 1);
  const interval = gapDays <= 5 ? "1h" : "1d";
  const symbols = [...new Set([...recs.map(yahooSym), ...trades.map(yahooSym)])];
  const barsBySym = {};
  for (const sym of symbols) {
    try { barsBySym[sym] = (await yahoo.history(sym, gapDays + 2, interval)).filter((b) => barSpan(b, interval)[1] > last); }
    catch (_) { barsBySym[sym] = null; }   // no candles for the gap — live checks resume anyway
  }
  let events = 0;

  // Recommendations: run the same state machine bar-by-bar.
  for (const r of recs) {
    const bars = barsBySym[yahooSym(r)];
    if (!bars || !bars.length) continue;
    const targets = J(r.targets, []);
    const outcome = J(r.outcome, {}) || {};
    let status = r.status;
    const startTs = Math.max(last, Number(r.created_at));
    for (const bar of bars) {
      if (barSpan(bar, interval)[1] <= startTs) continue;
      if (status === "open") {
        const hit = r.side === "buy" ? bar.low <= r.entry_high : bar.high >= r.entry_low;
        if (hit) {
          outcome.entry_price = r.side === "buy" ? Math.min(bar.open, r.entry_high) : Math.max(bar.open, r.entry_low);
          outcome.entry_hit_at = barSpan(bar, interval)[0]; outcome.targets_hit = outcome.targets_hit || [];
          status = "tracking"; events++;
          await logEvent("entry_hit", "recommendation", r.id, r.symbol, `${r.symbol} entered its ${r.side} zone @ ${outcome.entry_price} (caught up — happened while the app was offline)`);
        } else continue;
      }
      // tracking: stop FIRST (conservative), then targets in ladder order
      const stopCrossed = r.side === "buy" ? bar.low <= r.stop_loss : bar.high >= r.stop_loss;
      if (stopCrossed) {
        outcome.result = "stopped"; outcome.exit_at = barSpan(bar, interval)[0];
        outcome.pnl_pct = ladderPnl(outcome.entry_price, outcome.targets_hit || [], targets, r.stop_loss, r.side);
        status = "stopped"; events++;
        await logEvent("stop_hit", "recommendation", r.id, r.symbol, `⚠️ ${r.symbol} (shadow) STOPPED OUT while the app was offline — ${outcome.pnl_pct > 0 ? "+" : ""}${outcome.pnl_pct}%`);
        break;
      }
      outcome.targets_hit = outcome.targets_hit || [];
      for (const t of targets) {
        const crossed = r.side === "buy" ? bar.high >= t.price : bar.low <= t.price;
        if (crossed && !outcome.targets_hit.includes(t.price)) {
          outcome.targets_hit.push(t.price); events++;
          await logEvent("target_hit", "recommendation", r.id, r.symbol, `🎯 ${r.symbol} (shadow) hit target ${t.price} while the app was offline`);
        }
      }
      const finalT = targets.length ? targets[targets.length - 1].price : null;
      if (finalT != null && outcome.targets_hit.includes(finalT)) {
        outcome.result = "target_hit"; outcome.exit_at = barSpan(bar, interval)[0];
        outcome.pnl_pct = ladderPnl(outcome.entry_price, outcome.targets_hit, targets, null, r.side);
        status = "target_hit";
        await logEvent("target_hit", "recommendation", r.id, r.symbol, `${r.symbol} (shadow) completed the full ladder while the app was offline — +${outcome.pnl_pct}%`);
        break;
      }
    }
    if (status !== r.status || events) await db.run("UPDATE recommendations SET status=?, outcome=? WHERE id=?", [status, JSON.stringify(outcome), r.id]);
  }

  // Taken trades: fire the alerts that would have fired (closing stays the user's call).
  for (const t of trades) {
    const bars = barsBySym[yahooSym(t)];
    if (!bars || !bars.length || t.asset_type === "option") continue;
    const targets = J(t.targets, []);
    const exits = J(t.exits, []) || [];
    const alerted = new Set(exits.filter((e) => e.alert).map((e) => e.alert));
    const mark = async (key, msg, type) => {
      if (alerted.has(key)) return;
      alerted.add(key); exits.push({ alert: key, at: now() }); events++;
      await db.run("UPDATE trades SET exits=? WHERE id=?", [JSON.stringify(exits), t.id]);
      await logEvent(type, "trade", t.id, t.symbol, msg);
    };
    const startTs = Math.max(last, Number(t.entry_at));
    for (const bar of bars) {
      if (barSpan(bar, interval)[1] <= startTs) continue;
      if (t.stop_loss && (t.side === "buy" ? bar.low <= t.stop_loss : bar.high >= t.stop_loss))
        await mark("stop", `⚠️ ${t.symbol} crossed your STOP ${t.stop_loss} WHILE THE APP WAS OFFLINE (bar low ${bar.low}) — review the position now`, "stop_hit");
      for (const [i, tg] of targets.entries()) {
        if (t.side === "buy" ? bar.high >= tg.price : bar.low <= tg.price)
          await mark(`target${i}`, `🎯 ${t.symbol} reached target ${i + 1} @ ${tg.price} while the app was offline (sell ${tg.sell_pct}% per plan)`, "target_hit");
      }
    }
  }
  if (events) console.log(`[tracker] gap backfill: replayed ${gapDays}d of candles, ${events} missed event(s) recovered`);
  return { backfilled: events, gap_days: gapDays };
}

// --- 1. Shadow-track recommendations ---
async function trackRecommendations() {
  await backfillGaps().catch((e) => console.error("[tracker] backfill failed:", e.message));
  const recs = await db.all("SELECT * FROM recommendations WHERE status IN ('open','tracking')");
  if (!recs.length) return { checked: 0 };
  const symbols = [...new Set(recs.map(yahooSym))];
  const quotes = await yahoo.quotes(symbols);

  for (const r of recs) {
    const q = quotes[yahooSym(r)];
    if (!q || q.price == null) continue;
    const price = q.price;
    const targets = J(r.targets, []);
    const outcome = J(r.outcome, {}) || {};

    if (r.status === "open") {
      // Entry-zone touch: for a buy, trading at/below entry_high fills the zone order.
      const hit = r.side === "buy" ? price <= r.entry_high : price >= r.entry_low;
      if (hit) {
        const entry = r.side === "buy" ? Math.min(price, r.entry_high) : Math.max(price, r.entry_low);
        outcome.entry_price = entry; outcome.entry_hit_at = now(); outcome.targets_hit = [];
        await db.run("UPDATE recommendations SET status='tracking', outcome=? WHERE id=?", [JSON.stringify(outcome), r.id]);
        await logEvent("entry_hit", "recommendation", r.id, r.symbol, `${r.symbol} entered its ${r.side} zone @ ${entry}`);
      } else if (r.expires_at && now() > Number(r.expires_at) && !r.taken) {
        outcome.result = "expired"; outcome.expired_at = now();
        await db.run("UPDATE recommendations SET status='expired', outcome=? WHERE id=?", [JSON.stringify(outcome), r.id]);
        await logEvent("rec_expired", "recommendation", r.id, r.symbol, `${r.symbol} idea expired — entry never hit`);
      }
      continue;
    }

    // status === 'tracking'
    const entry = outcome.entry_price;
    if (entry == null) continue;
    outcome.targets_hit = outcome.targets_hit || [];
    outcome.last_price = price;

    // Target rungs crossed?
    for (const t of targets) {
      const crossed = r.side === "buy" ? price >= t.price : price <= t.price;
      if (crossed && !outcome.targets_hit.includes(t.price)) {
        outcome.targets_hit.push(t.price);
        await logEvent("target_hit", "recommendation", r.id, r.symbol, `${r.symbol} (shadow) hit target ${t.price} (${t.sell_pct}%)`);
      }
    }
    const finalTarget = targets.length ? targets[targets.length - 1].price : null;
    const stopCrossed = r.side === "buy" ? price <= r.stop_loss : price >= r.stop_loss;
    const finalHit = finalTarget != null && outcome.targets_hit.includes(finalTarget);

    if (finalHit) {
      outcome.result = "target_hit"; outcome.exit_at = now();
      outcome.pnl_pct = ladderPnl(entry, outcome.targets_hit, targets, null, r.side);
      await db.run("UPDATE recommendations SET status='target_hit', outcome=? WHERE id=?", [JSON.stringify(outcome), r.id]);
      await logEvent("target_hit", "recommendation", r.id, r.symbol, `${r.symbol} (shadow) completed the full target ladder — ${outcome.pnl_pct > 0 ? "+" : ""}${outcome.pnl_pct}%`);
    } else if (stopCrossed) {
      outcome.result = "stopped"; outcome.exit_at = now();
      outcome.pnl_pct = ladderPnl(entry, outcome.targets_hit, targets, r.stop_loss, r.side);
      await db.run("UPDATE recommendations SET status='stopped', outcome=? WHERE id=?", [JSON.stringify(outcome), r.id]);
      await logEvent("stop_hit", "recommendation", r.id, r.symbol, `${r.symbol} (shadow) stopped out — ${outcome.pnl_pct > 0 ? "+" : ""}${outcome.pnl_pct}%`);
    } else {
      await db.run("UPDATE recommendations SET outcome=? WHERE id=?", [JSON.stringify(outcome), r.id]);
    }
  }
  return { checked: recs.length };
}

// Dynamic stop suggestion for an open trade (advisory — the user applies it):
//  - breakeven: once target 1 has been hit, the stop should protect the entry.
//  - ATR chandelier trail: extreme close since entry -/+ mult*ATR(14) ratchets with price.
// Returns {price, basis} for the BEST (tightest protective) suggestion that improves on
// the current stop by a meaningful margin, else null.
function suggestStop(t, candles, targetsHitCount) {
  const cfg = settings.getSync().preferences.risk.stops || {};
  const dir = t.side === "sell" ? -1 : 1;
  const cur = t.stop_loss;
  const candidates = [];

  if (cfg.breakeven_after_target1 && targetsHitCount > 0) {
    candidates.push({ price: t.entry_price, basis: "breakeven (target 1 hit)" });
  }
  if (cfg.atr_trailing && candles && candles.length > 20) {
    const entryDate = new Date(Number(t.entry_at)).toISOString().slice(0, 10);
    const since = candles.filter((c) => c.time >= entryDate);
    if (since.length >= 2) {
      const atrArr = indicators.atr(candles, 14);
      const atrNow = atrArr[atrArr.length - 1];
      if (atrNow) {
        const mult = cfg.atr_multiple || 3;
        const extreme = dir === 1 ? Math.max(...since.map((c) => c.close)) : Math.min(...since.map((c) => c.close));
        candidates.push({ price: dir === 1 ? extreme - mult * atrNow : extreme + mult * atrNow, basis: `${mult}×ATR trail` });
      }
    }
  }
  if (!candidates.length) return null;
  // Best = the most protective (highest for longs, lowest for shorts).
  const best = candidates.reduce((a, b) => (dir === 1 ? (b.price > a.price ? b : a) : (b.price < a.price ? b : a)));
  // Must actually improve on the current stop by >0.3% (avoid nagging over noise), and
  // never suggest a stop past the current price (that's an exit, not a stop).
  if (cur != null && dir === 1 && best.price <= cur * 1.003) return null;
  if (cur != null && dir === -1 && best.price >= cur * 0.997) return null;
  return { price: +best.price.toFixed(6), basis: best.basis };
}

// --- 2. Watch taken trades (alerts only; exits are recorded by the user) ---
async function trackTrades() {
  const trades = await db.all("SELECT * FROM trades WHERE status='open'");
  if (!trades.length) return { checked: 0 };
  const quotes = await yahoo.quotes([...new Set(trades.map(yahooSym))]);

  for (const t of trades) {
    const q = quotes[yahooSym(t)];
    if (!q || q.price == null) continue;
    const price = q.price;
    const targets = J(t.targets, []);
    // Alert de-dup: fired alerts are recorded as {alert} marker entries in `exits`.
    const exits = J(t.exits, []) || [];
    const alerted = new Set(exits.filter((e) => e.alert).map((e) => e.alert));

    const pushAlert = async (key, msg, type) => {
      if (alerted.has(key)) return;
      exits.push({ alert: key, at: now() });   // marker entries record which alerts fired
      await db.run("UPDATE trades SET exits=? WHERE id=?", [JSON.stringify(exits), t.id]);
      await logEvent(type || (key.startsWith("stop") ? "stop_hit" : "target_hit"), "trade", t.id, t.symbol, msg);
    };

    const stopCrossed = t.side === "buy" ? price <= t.stop_loss : price >= t.stop_loss;
    if (t.stop_loss && stopCrossed) await pushAlert("stop", `⚠️ ${t.symbol} crossed your STOP ${t.stop_loss} (now ${price}) — review the position`);
    let targetsHit = 0;
    for (const [i, tg] of targets.entries()) {
      const crossed = t.side === "buy" ? price >= tg.price : price <= tg.price;
      if (crossed) { targetsHit++; await pushAlert(`target${i}`, `🎯 ${t.symbol} reached target ${i + 1} @ ${tg.price} (sell ${tg.sell_pct}% per plan) — now ${price}`); }
    }

    // Options: expiry countdown alerts (theta is a schedule, not a surprise).
    if (t.asset_type === "option") {
      const od = J(t.option_details, null);
      if (od && od.expiry) {
        const dte = Math.round((Date.parse(od.expiry) - now()) / 86400000);
        if (dte <= 0) await pushAlert("expiry0", `⏳ ${t.symbol} ${od.strike}${od.type === "put" ? "P" : "C"} EXPIRES TODAY — act now or it settles`, "stop_hit");
        else if (dte <= 2) await pushAlert("expiry2", `⏳ ${t.symbol} ${od.strike}${od.type === "put" ? "P" : "C"} expires in ${dte} day(s) — decide: close, roll, or exercise`, "stop_hit");
        else if (dte <= 7) await pushAlert("expiry7", `⏳ ${t.symbol} option expires in ${dte} days (${od.expiry}) — theta decay accelerates from here`, "stop_suggest");
      }
    }

    // Dynamic stop suggestion (options positions are managed by premium, skip them).
    if (t.asset_type !== "option") {
      try {
        const candles = await yahoo.history(yahooSym(t), 180);
        const sug = suggestStop(t, candles, targetsHit || exits.filter((e) => e.alert && /^target/.test(e.alert)).length);
        const prev = J(t.suggested_stop, null);
        if (sug && (!prev || (t.side === "buy" ? sug.price > prev.price * 1.005 : sug.price < prev.price * 0.995))) {
          await db.run("UPDATE trades SET suggested_stop=? WHERE id=?", [JSON.stringify({ ...sug, at: now() }), t.id]);
          await logEvent("stop_suggest", "trade", t.id, t.symbol,
            `📐 ${t.symbol}: consider raising your stop ${t.stop_loss != null ? `from ${t.stop_loss} ` : ""}to ${sug.price} (${sug.basis})`);
        } else if (!sug && prev) {
          // No longer applicable (e.g. user already applied it).
          await db.run("UPDATE trades SET suggested_stop=NULL WHERE id=?", [t.id]);
        }
      } catch (_) { /* history unavailable — suggestion just waits for the next pass */ }
    }
  }
  return { checked: trades.length };
}

// --- 3. Watchlist price alerts: notify when a watched symbol crosses your level ---
async function trackWatchlist() {
  const rows = await db.all("SELECT * FROM watchlist WHERE alert_above IS NOT NULL OR alert_below IS NOT NULL");
  if (!rows.length) return { checked: 0 };
  const quotes = await yahoo.quotes([...new Set(rows.map((w) => w.yahoo_symbol))]);
  for (const w of rows) {
    const q = quotes[w.yahoo_symbol];
    if (!q || q.price == null) continue;
    const fired = J(w.alerts_fired, {}) || {};
    let changed = false;
    if (w.alert_above != null && q.price >= w.alert_above && !fired.above_at) {
      fired.above_at = now(); changed = true;
      await logEvent("target_hit", "watchlist", w.id, w.symbol, `👀 ${w.symbol} crossed ABOVE your ${w.alert_above} alert (now ${q.price})`);
    }
    if (w.alert_below != null && q.price <= w.alert_below && !fired.below_at) {
      fired.below_at = now(); changed = true;
      await logEvent("stop_hit", "watchlist", w.id, w.symbol, `👀 ${w.symbol} crossed BELOW your ${w.alert_below} alert (now ${q.price})`);
    }
    if (changed) await db.run("UPDATE watchlist SET alerts_fired=? WHERE id=?", [JSON.stringify(fired), w.id]);
  }
  return { checked: rows.length };
}

module.exports = { trackRecommendations, trackTrades, trackWatchlist, backfillGaps };
