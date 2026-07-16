"use strict";
// Asset resolution: turn whatever a human (or the model) says — "AAPL", "BTC",
// "bitcoin", "BTC-USD", "solana" — into the right instrument:
//   { yahoo, display, name, asset_type: 'stock'|'crypto'|'index' }
// Crypto quotes/candles flow through Yahoo's SYMBOL-USD pairs, so the job here is
// recognizing crypto in any spelling and mapping it. Collisions (a ticker that is both
// a stock and a coin, e.g. LINK) default to the stock when it's a well-known equity;
// callers can force with an explicit asset_type hint, and "-USD" always means crypto.
const coingecko = require("./providers/coingecko");

// Well-known equities take precedence over same-lettered coins when there's no hint.
const KNOWN_STOCKS = new Set(require("./engine/scanner").POPULAR_STOCKS);

async function resolveAsset(raw, hint) {
  const s = String(raw || "").trim();
  const up = s.toUpperCase();
  if (!s) return null;

  if (up.startsWith("^")) return { yahoo: up, display: up, name: up, asset_type: "index" };
  if (/-(USD)$/.test(up)) {
    const base = up.replace(/-USD$/, "");
    return { yahoo: up, display: base, name: base, asset_type: "crypto" };
  }

  const coins = await coingecko.topCoins(100).catch(() => []);
  const coin = coins.find((c) => c.symbol === up || c.id === s.toLowerCase() || c.name.toUpperCase() === up);

  if (hint === "crypto") {
    if (coin) return { yahoo: coin.yahoo, display: coin.symbol, name: coin.name, asset_type: "crypto" };
    return { yahoo: `${up}-USD`, display: up, name: up, asset_type: "crypto" };
  }
  if (hint === "stock") return { yahoo: up, display: up, name: up, asset_type: "stock" };

  // No hint: a well-known equity ticker wins; otherwise a top-100 coin match means crypto;
  // otherwise assume it's a stock ticker we just don't have in the popular list.
  if (KNOWN_STOCKS.has(up)) return { yahoo: up, display: up, name: up, asset_type: "stock" };
  if (coin) return { yahoo: coin.yahoo, display: coin.symbol, name: coin.name, asset_type: "crypto" };
  return { yahoo: up, display: up, name: up, asset_type: "stock" };
}

module.exports = { resolveAsset };
