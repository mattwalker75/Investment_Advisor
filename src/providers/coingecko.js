"use strict";
// CoinGecko provider (free, keyless): supplies the CRYPTO UNIVERSE — top-N coins by
// market cap with names + 24h stats — and maps each coin to its Yahoo ticker
// (SYMBOL-USD) so candles/quotes flow through the same Yahoo pipeline as stocks.
const { cached } = require("./cache");
const settings = require("../settings");

const BASE = "https://api.coingecko.com/api/v3";

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  return r.json();
}

// Top N coins by market cap (stablecoins filtered out — you don't trade USDT for alpha).
const STABLES = new Set(["usdt", "usdc", "dai", "busd", "tusd", "usde", "fdusd", "usds", "pyusd", "usdp"]);

// In-process memo in front of the DB cache: topCoins() is hit by nearly every
// resolveAsset() call, so a scan or chat burst was paying a DB round-trip + JSON.parse
// of a ~100-coin array each time. 60s of process memory removes that without touching
// the DB cache's freshness semantics.
const MEMO_TTL_MS = 60 * 1000;
const topMemo = new Map();   // n -> { at, data }

async function topCoins(n = 25) {
  const hit = topMemo.get(n);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.data;
  const ttlMs = (settings.getSync().providers.cache_minutes.sentiment || 60) * 60 * 1000;
  const data = await topCoinsUncached(n, ttlMs);
  topMemo.set(n, { at: Date.now(), data });
  return data;
}

async function topCoinsUncached(n, ttlMs) {
  return cached(`cg:top:${n}`, ttlMs, async () => {
    const list = await fetchJson(`${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${Math.min(n + 15, 100)}&page=1&price_change_percentage=24h,7d`);
    return list
      .filter((c) => !STABLES.has((c.symbol || "").toLowerCase()))
      .slice(0, n)
      .map((c) => ({
        id: c.id,                                   // coingecko id, e.g. 'bitcoin'
        symbol: (c.symbol || "").toUpperCase(),     // 'BTC'
        yahoo: `${(c.symbol || "").toUpperCase()}-USD`,  // candle/quote ticker
        name: c.name,
        price: c.current_price,
        market_cap: c.market_cap,
        change_24h_pct: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
        change_7d_pct: c.price_change_percentage_7d_in_currency ?? null,
      }));
  });
}

// Resolve user-entered crypto identifiers (coingecko id, ticker, or Yahoo pair) to the
// same shape topCoins() returns. Unknown entries fall back to a plain Yahoo pair guess.
async function resolve(symbols) {
  const top = await topCoins(100).catch(() => []);
  return symbols.map((raw) => {
    const s = String(raw).trim();
    const low = s.toLowerCase(), up = s.toUpperCase();
    const hit = top.find((c) => c.id === low || c.symbol === up || c.yahoo === up);
    if (hit) return hit;
    const ticker = up.endsWith("-USD") ? up : `${up}-USD`;
    return { id: low, symbol: up.replace(/-USD$/, ""), yahoo: ticker, name: s, price: null, market_cap: null };
  });
}

module.exports = { topCoins, resolve };
