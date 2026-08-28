"use strict";
// Scheduler: three simple loops driven by the schedule settings (all editable live).
//   - scheduled market scans (daily at a chosen hour, or every N hours)
//   - tight tracking of taken trades
//   - slower shadow-tracking of open recommendations
// Uses plain setInterval ticks that re-read settings each pass, so changes apply
// without a restart.
const settings = require("./settings");
const scanner = require("./engine/scanner");
const tracker = require("./engine/tracker");

let lastScanAt = 0;
let timers = [];

function shouldScanNow(sch) {
  if (!sch.scan_enabled) return false;
  const since = Date.now() - lastScanAt;
  if (sch.scan_every_hours < 24) return since >= sch.scan_every_hours * 3600 * 1000;
  // Daily+: fire in the configured local hour, at most once per 20h.
  return new Date().getHours() === sch.scan_at_hour && since >= 20 * 3600 * 1000;
}

function start() {
  stop();
  // Scan tick: check once a minute whether a scheduled scan is due.
  timers.push(setInterval(async () => {
    const sch = settings.getSync().schedule;
    if (!shouldScanNow(sch)) return;
    lastScanAt = Date.now();
    try {
      console.log("[scheduler] launching scheduled scan");
      await scanner.runScan("scheduled");
    } catch (e) { console.error("[scheduler] scheduled scan failed:", e.message); }
  }, 60 * 1000));

  // Taken-trades tick (tight).
  let lastTrades = 0;
  timers.push(setInterval(async () => {
    const sch = settings.getSync().schedule;
    const every = Math.max(1, sch.track_open_trades_minutes) * 60 * 1000;
    if (Date.now() - lastTrades < every) return;
    lastTrades = Date.now();
    try { await tracker.trackTrades(); } catch (e) { console.error("[scheduler] trade tracking failed:", e.message); }
    try { await tracker.trackWatchlist(); } catch (e) { console.error("[scheduler] watchlist tracking failed:", e.message); }
  }, 30 * 1000));

  // Recommendations shadow tick (slower).
  let lastRecs = 0;
  timers.push(setInterval(async () => {
    const sch = settings.getSync().schedule;
    const every = Math.max(5, sch.track_recommendations_minutes) * 60 * 1000;
    if (Date.now() - lastRecs < every) return;
    lastRecs = Date.now();
    try { await tracker.trackRecommendations(); } catch (e) { console.error("[scheduler] rec tracking failed:", e.message); }
  }, 60 * 1000));

  // AI position health checks (the "when to sell" pass) — 0 hours disables scheduling.
  let lastHealth = Date.now();   // don't fire immediately on boot; first pass after the interval
  timers.push(setInterval(async () => {
    const sch = settings.getSync().schedule;
    if (!sch.health_check_hours) return;
    const every = Math.max(1, sch.health_check_hours) * 3600 * 1000;
    if (Date.now() - lastHealth < every) return;
    lastHealth = Date.now();
    try {
      const r = await require("./engine/health").checkPositions();
      if (r.checked) console.log(`[scheduler] health check: ${r.checked} position(s), ${r.verdicts.filter((v) => v.action !== "hold").length} need attention`);
    } catch (e) { console.error("[scheduler] health check failed:", e.message); }
  }, 5 * 60 * 1000));

  // Notification rules: evaluate the user's "tell me when…" rules every 5 minutes.
  timers.push(setInterval(async () => {
    try {
      const r = await require("./engine/alerts").evaluateRules();
      if (r.fired) console.log(`[scheduler] alert rules: ${r.fired} fired (${r.evaluated} evaluated)`);
    } catch (e) { console.error("[scheduler] alert rules failed:", e.message); }
  }, 5 * 60 * 1000));

  // Daily DB backup (SQLite): the database is the entire accumulated track record.
  // Fires when the newest backup is >24h old — checked every 30 min, plus once shortly
  // after boot so a long-stopped instance catches up immediately.
  const backupTick = async () => {
    const sch = settings.getSync().schedule;
    if (sch.backup_enabled === false) return;
    const db = require("./db");
    if (Date.now() - db.lastBackupAt() < 24 * 3600 * 1000) return;
    try {
      const r = await db.backupNow(sch.backup_keep || 14);
      if (!r.skipped) console.log(`[scheduler] DB backup: ${r.file} (${Math.round(r.size_bytes / 1024)} KB, ${r.backups_kept} kept)`);
    } catch (e) { console.error("[scheduler] backup failed:", e.message); }
  };
  timers.push(setInterval(backupTick, 30 * 60 * 1000));
  timers.push(setTimeout(backupTick, 90 * 1000));   // clearInterval clears timeouts too — stop() covers it

  // Daily AI briefing at the configured local hour.
  let lastBriefing = 0;
  timers.push(setInterval(async () => {
    const sch = settings.getSync().schedule;
    if (!sch.briefing_enabled) return;
    if (new Date().getHours() !== sch.briefing_hour) return;
    if (Date.now() - lastBriefing < 20 * 3600 * 1000) return;   // once per day
    lastBriefing = Date.now();
    try { await require("./engine/briefing").run("scheduled"); }
    catch (e) { console.error("[scheduler] briefing failed:", e.message); }
  }, 60 * 1000));

  console.log("[scheduler] started");
}

function stop() { for (const t of timers) clearInterval(t); timers = []; }

module.exports = { start, stop };
