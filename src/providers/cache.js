"use strict";
// DB-backed fetch cache: cached(key, ttlMs, fetchFn) returns the cached JSON value when
// fresh, otherwise runs fetchFn, stores, and returns. Keeps us polite with the free data
// providers and makes scans fast to re-run. On fetch failure a STALE cache entry (if any)
// is served rather than failing the whole scan.
const db = require("../db");

async function cached(key, ttlMs, fetchFn, { allowStale = true } = {}) {
  const row = await db.get("SELECT value, fetched_at FROM cache WHERE `key`=?", [key]);
  if (row && Date.now() - Number(row.fetched_at) < ttlMs) {
    try { return JSON.parse(row.value); } catch (_) {}
  }
  try {
    const fresh = await fetchFn();
    const val = JSON.stringify(fresh);
    await db.run(db.upsertSql("cache", ["key", "value", "fetched_at"], "key"), [key, val, Date.now()]);
    return fresh;
  } catch (e) {
    // Stale beats nothing for background analysis — but callers that must never show
    // outdated data (charts) pass allowStale:false and get the honest failure instead.
    if (allowStale && row) { try { return JSON.parse(row.value); } catch (_) {} }
    throw e;
  }
}

module.exports = { cached };
