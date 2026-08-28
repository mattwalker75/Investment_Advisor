"use strict";
// Asset resolution with the CoinGecko universe stubbed (network-free).
const { test } = require("node:test");
const assert = require("node:assert");
const { stubModule } = require("./helpers");

stubModule("providers/coingecko.js", {
  topCoins: async () => [
    { id: "bitcoin", symbol: "BTC", yahoo: "BTC-USD", name: "Bitcoin" },
    { id: "chainlink", symbol: "LINK", yahoo: "LINK-USD", name: "Chainlink" },
    { id: "solana", symbol: "SOL", yahoo: "SOL-USD", name: "Solana" },
  ],
  resolve: async (xs) => xs,
});
const { resolveAsset } = require("../src/resolve");

test("crypto in any spelling maps to the -USD pair", async () => {
  for (const raw of ["BTC", "bitcoin", "btc-usd"]) {
    const a = await resolveAsset(raw);
    assert.strictEqual(a.yahoo, "BTC-USD", raw);
    assert.strictEqual(a.asset_type, "crypto", raw);
  }
});

test("well-known equities beat same-lettered coins; hints force the side", async () => {
  const noHint = await resolveAsset("LINK");        // LINK is not in the popular-stock list
  assert.strictEqual(noHint.asset_type, "crypto");
  const stock = await resolveAsset("LINK", "stock");
  assert.strictEqual(stock.asset_type, "stock");
  const aapl = await resolveAsset("AAPL");          // known equity wins with no hint
  assert.strictEqual(aapl.asset_type, "stock");
  const forced = await resolveAsset("SOL", "crypto");
  assert.strictEqual(forced.yahoo, "SOL-USD");
});

test("indexes and unknowns", async () => {
  assert.strictEqual((await resolveAsset("^GSPC")).asset_type, "index");
  const unk = await resolveAsset("XYZQ");
  assert.strictEqual(unk.asset_type, "stock");      // unknown ticker defaults to stock
  assert.strictEqual(await resolveAsset(""), null);
});
