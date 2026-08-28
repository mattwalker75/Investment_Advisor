"use strict";
// AI usage telemetry: one row per model call, so scans, chats, briefings, and health
// checks stop being invisible costs. Endpoint-reported token counts when available;
// streamed calls whose endpoint sends no usage get an ESTIMATE (~4 chars/token),
// flagged estimated=1 and reported separately — never passed off as exact.
// Recording is fire-and-forget: telemetry must never break an AI call.
const DAY = 86400000;
const KEEP_DAYS = 90;

let sinceProne = 0;

function record({ task, model, usage, estimated = false, via_failover = false }) {
  const db = require("../db");
  const u = usage || {};
  db.run(
    "INSERT INTO ai_usage (at, task, model, prompt_tokens, completion_tokens, total_tokens, estimated, via_failover) VALUES (?,?,?,?,?,?,?,?)",
    [Date.now(), String(task || "chat").slice(0, 32), model || null,
     u.prompt_tokens ?? null, u.completion_tokens ?? null,
     u.total_tokens ?? ((u.prompt_tokens != null || u.completion_tokens != null) ? (u.prompt_tokens || 0) + (u.completion_tokens || 0) : null),
     estimated ? 1 : 0, via_failover ? 1 : 0]
  ).catch(() => {});
  // Occasional retention prune — telemetry, not an archive.
  if (++sinceProne >= 50) {
    sinceProne = 0;
    db.run("DELETE FROM ai_usage WHERE at < ?", [Date.now() - KEEP_DAYS * DAY]).catch(() => {});
  }
}

// ~4 chars per token: the standard rough cut. Only used when the endpoint reports
// nothing (streamed chat on some servers) — rows carry estimated=1.
const estimateTokens = (text) => Math.max(1, Math.ceil(String(text || "").length / 4));

// Last-30-days summary: totals, by task, by model, by day — plus an estimated cost
// when the user has configured per-Mtok prices (Settings → AI). Local models cost $0;
// leave the prices at 0 and the cost line stays absent.
async function summary(days = 30) {
  const db = require("../db");
  const since = Date.now() - days * DAY;
  const rows = await db.all("SELECT at, task, model, prompt_tokens, completion_tokens, total_tokens, estimated FROM ai_usage WHERE at >= ?", [since]);
  const mk = () => ({ calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls_without_usage: 0, estimated_calls: 0 });
  const add = (b, r) => {
    b.calls++;
    if (r.total_tokens == null) b.calls_without_usage++;
    else {
      b.prompt_tokens += r.prompt_tokens || 0;
      b.completion_tokens += r.completion_tokens || 0;
      b.total_tokens += r.total_tokens || 0;
    }
    if (r.estimated) b.estimated_calls++;
  };
  const total = mk(), byTask = {}, byModel = {}, byDay = {};
  for (const r of rows) {
    add(total, r);
    add(byTask[r.task] = byTask[r.task] || mk(), r);
    const m = r.model || "unknown";
    add(byModel[m] = byModel[m] || mk(), r);
    const d = new Date(r.at).toISOString().slice(0, 10);
    add(byDay[d] = byDay[d] || mk(), r);
  }
  const out = { window_days: days, total, by_task: byTask, by_model: byModel, by_day: byDay };
  const cost = require("../settings").getSync().ai.cost || {};
  const pin = Number(cost.per_mtok_input) || 0, pout = Number(cost.per_mtok_output) || 0;
  if (pin > 0 || pout > 0) {
    out.est_cost_usd = +((total.prompt_tokens / 1e6) * pin + (total.completion_tokens / 1e6) * pout).toFixed(2);
    out.cost_note = `At $${pin}/Mtok in + $${pout}/Mtok out${total.estimated_calls ? ` — ${total.estimated_calls} call(s) carry estimated counts` : ""}${total.calls_without_usage ? `; ${total.calls_without_usage} call(s) reported no usage at all` : ""}.`;
  }
  return out;
}

module.exports = { record, estimateTokens, summary };
