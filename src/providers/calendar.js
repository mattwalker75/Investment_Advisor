"use strict";
// Economic calendar: upcoming macro events (FOMC, CPI, jobs report…) so the advisor can
// warn about binary-event risk beyond per-stock earnings dates. Source: FMP's economic
// calendar (the same free key that powers congressional trades) — there is no reliable
// keyless source, so without a key this degrades to an explanatory note.
const settings = require("../settings");
const { cached } = require("./cache");

// Event names that actually move markets — used to rank when the feed lacks an
// impact field and to keep the list focused.
const MAJOR = /fomc|fed |federal funds|interest rate|cpi|inflation|ppi|nonfarm|non-farm|payroll|unemployment|jobless|gdp|retail sales|pce|consumer confidence|ism |treasury/i;

async function economicCalendar(days = 7) {
  const key = (settings.getSync().providers.fmp_key || "").trim();
  if (!key) return { note: "Economic calendar needs the free FMP key (Settings → Data feeds) — the same key that enables congressional trades. Without it, only per-stock earnings dates are available." };
  const d = Math.min(30, Math.max(1, Number(days) || 7));
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  return cached(`ecal:${from}:${to}`, 6 * 3600 * 1000, async () => {
    const url = `https://financialmodelingprep.com/stable/economic-calendar?from=${from}&to=${to}&apikey=${key}`;
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`FMP economic calendar ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error("unexpected calendar response");
    const events = rows
      .filter((e) => (e.country === "US" || e.country === "USA"))
      .filter((e) => /high/i.test(e.impact || "") || MAJOR.test(e.event || ""))
      .map((e) => ({
        date: e.date, event: e.event, impact: e.impact || (MAJOR.test(e.event || "") ? "Major" : null),
        estimate: e.estimate ?? null, previous: e.previous ?? null,
      }))
      .slice(0, 25);
    return { from, to, events, note: events.length ? undefined : "no high-impact US events found in this window" };
  });
}

module.exports = { economicCalendar };
