"use strict";
// Market sentiment gauges (free, keyless):
//  - Crypto Fear & Greed index (alternative.me) — 0 extreme fear .. 100 extreme greed
//  - Stock-market Fear & Greed (CNN dataviz endpoint) — same scale
// Both are best-effort: a missing gauge is reported as null, never an error.
const { cached } = require("./cache");
const settings = require("../settings");

const ttlMs = () => (settings.getSync().providers.cache_minutes.sentiment || 60) * 60 * 1000;

async function cryptoFearGreed() {
  try {
    return await cached("sent:crypto_fng", ttlMs(), async () => {
      const r = await fetch("https://api.alternative.me/fng/?limit=2", { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`fng ${r.status}`);
      const d = await r.json();
      const now = d.data && d.data[0], prev = d.data && d.data[1];
      return now ? {
        value: Number(now.value), label: now.value_classification,
        yesterday: prev ? Number(prev.value) : null,
      } : null;
    });
  } catch (_) { return null; }
}

async function stockFearGreed() {
  try {
    return await cached("sent:stock_fng", ttlMs(), async () => {
      const r = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
        headers: { "user-agent": "Mozilla/5.0 (InvestmentAdvisor personal research tool)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`cnn ${r.status}`);
      const d = await r.json();
      const fg = d.fear_and_greed;
      return fg ? {
        value: Math.round(fg.score), label: fg.rating,
        yesterday: fg.previous_close != null ? Math.round(fg.previous_close) : null,
      } : null;
    });
  } catch (_) { return null; }
}

// Everything the AI wants in one call.
async function snapshot() {
  const [crypto, stocks] = await Promise.all([cryptoFearGreed(), stockFearGreed()]);
  return { stocks_fear_greed: stocks, crypto_fear_greed: crypto };
}

module.exports = { snapshot, cryptoFearGreed, stockFearGreed };
