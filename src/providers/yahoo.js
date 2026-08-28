"use strict";
// Market-data provider with KEYED-FIRST source chains. Yahoo throttles aggressively
// (IP blocks that last hours), so it is deliberately NOT in the hot path when
// alternatives exist:
//
//   crypto quotes   CoinGecko (keyless)  -> Yahoo
//   crypto candles  Coinbase  (keyless)  -> Yahoo (coins Coinbase lacks, e.g. BNB)
//   stock quotes    Finnhub(key) -> FMP(key) -> Yahoo -> AlphaVantage(key)
//   stock candles   FMP(key) -> Yahoo
//   indexes (^…)    Yahoo only (prefer SPY/QQQ/DIA proxies instead)
//   options chains, earnings dates, intraday, search, sector: Yahoo only (no free
//   alternative) — callers degrade gracefully when it's throttled.
//
// Every result is cached in the DB (stale served on failure), Yahoo calls are paced
// (300ms gap) behind a circuit breaker (5-min cooldown after any 429).
const { cached } = require("./cache");
const settings = require("../settings");

// ---------------------------------------------------------------- yahoo core
// Pinned to yahoo-finance2@2.13.3: the last full-featured release with clean CJS
// support. v2.14+ is a transitional ESM rewrite missing most modules — do not upgrade
// until it reaches feature parity.
let _yf = null;
async function yf() {
  if (!_yf) {
    _yf = require("yahoo-finance2").default;
    try { _yf.suppressNotices(["yahooSurvey", "ripHistorical"]); } catch (_) {}
    // Yahoo serves the same API from query1/query2 and throttles them independently —
    // rewrite query1 -> query2 at the lib's injectable fetch seam.
    try {
      if (_yf._env && typeof _yf._env.fetch === "function") {
        const orig = _yf._env.fetch.bind(_yf._env);
        _yf._env.fetch = (url, opts) =>
          orig(String(url).replace("query1.finance.yahoo.com", "query2.finance.yahoo.com"), opts);
      }
    } catch (_) { /* structure changed — plain routing still works */ }
  }
  return _yf;
}

const ttl = (kind) => {
  const m = settings.getSync().providers.cache_minutes;
  return (m[kind] || 5) * 60 * 1000;
};

// Circuit breaker + pacing: hammering a throttled host keeps the block alive.
let yahooCooldownUntil = 0;
const COOLDOWN_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 300;
let queue = Promise.resolve(), lastCall = 0;
function paced(fn) {
  const run = queue.then(async () => {
    if (Date.now() < yahooCooldownUntil)
      throw new Error("Yahoo Finance is rate-limiting this machine (cooling down; keyed/keyless sources and cache serve meanwhile).");
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    try { return await fn(); }
    catch (e) {
      if (/Too Many Requests|status 429|429/i.test(e.message || "")) {
        yahooCooldownUntil = Date.now() + COOLDOWN_MS;
        throw new Error("Yahoo Finance is rate-limiting this machine — pausing Yahoo for 5 minutes. Configure FMP + Finnhub keys (Settings → Data feeds) to make stock data independent of Yahoo.");
      }
      throw e;
    }
  });
  queue = run.catch(() => {});   // an error never wedges the queue
  return run;
}

const isCrypto = (s) => /-USD$/.test(s);
const isIndex = (s) => s.startsWith("^");
const keys = () => settings.getSync().providers;
const j = (url, ms = 12000, headers = {}) =>
  fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(ms) })
    .then((r) => { if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`); return r.json(); });

// ---------------------------------------------------------------- quote sources
async function yahooQuote(symbol) {
  const q = await paced(async () => (await yf()).quote(symbol));
  return {
    symbol, name: q.shortName || q.longName || symbol,
    price: q.regularMarketPrice, change_pct: q.regularMarketChangePercent,
    volume: q.regularMarketVolume, market_cap: q.marketCap || null,
    currency: q.currency, market_state: q.marketState, source: "yahoo",
  };
}
async function coingeckoQuote(symbol) {
  const coingecko = require("./coingecko");
  const top = await coingecko.topCoins(100);
  const c = top.find((x) => x.yahoo === symbol);
  if (!c) throw new Error("not in coingecko top-100");
  return { symbol, name: c.name, price: c.price, change_pct: c.change_24h_pct, market_cap: c.market_cap, source: "coingecko" };
}
async function finnhubQuote(symbol) {
  const k = keys().finnhub_key;
  if (!k) throw new Error("no finnhub key");
  const d = await j(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(k)}`);
  if (!d.c) throw new Error("finnhub: no price");
  return { symbol, name: symbol, price: d.c, change_pct: d.dp, source: "finnhub" };
}
const fmpLimit = (e) => { if (/429/.test(e.message || "")) throw new Error("FMP daily request limit reached (free tier: 250/day, resets overnight) — stock data resumes after reset"); throw e; };
async function fmpQuote(symbol) {
  const k = keys().fmp_key;
  if (!k) throw new Error("no fmp key");
  const d = (await j(`https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(k)}`).catch(fmpLimit))[0] || {};
  if (!d.price) throw new Error("fmp: no price");
  return { symbol, name: d.name || symbol, price: d.price, change_pct: d.changePercentage ?? null, market_cap: d.marketCap || null, source: "fmp" };
}
async function alphaQuote(symbol) {
  const k = keys().alpha_vantage_key;
  if (!k) throw new Error("no alphavantage key");
  const d = (await j(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(k)}`))["Global Quote"] || {};
  const price = Number(d["05. price"]);
  if (!price) throw new Error("alphavantage: no price");
  return { symbol, name: symbol, price, change_pct: Number((d["10. change percent"] || "").replace("%", "")) || null, source: "alphavantage" };
}

// Live quote through the source chain for the asset type. When EVERY source fails, the
// error names each one — so "primary hit its limit, fallback is throttled" reads as
// exactly that, not as a mystery about the last source tried.
async function quote(symbol) {
  return cached(`yq:${symbol}`, ttl("quotes"), async () => {
    const chain = isIndex(symbol) ? [["yahoo", yahooQuote]]
      : isCrypto(symbol) ? [["coingecko", coingeckoQuote], ["yahoo", yahooQuote]]
      : [["finnhub", finnhubQuote], ["yahoo", yahooQuote], ["fmp", fmpQuote], ["alphavantage", alphaQuote]];
    const errs = [];
    for (const [name, src] of chain) {
      try { return await src(symbol); } catch (e) { errs.push(`${name}: ${String(e.message).slice(0, 90)}`); }
    }
    throw new Error("all quote sources failed — " + errs.join(" · "));
  });
}

// Batched quotes with per-symbol failure tolerance.
async function quotes(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (s) => {
    try { out[s] = await quote(s); } catch (_) { out[s] = null; }
  }));
  return out;
}

// ---------------------------------------------------------------- candle sources
async function yahooHistory(symbol, days, interval) {
  const period1 = new Date(Date.now() - days * 24 * 3600 * 1000);
  const r = await paced(async () => (await yf()).chart(symbol, { period1, interval }));
  const out = (r.quotes || [])
    .filter((c) => c.close != null && c.open != null)
    .map((c) => ({
      time: interval === "1d" ? new Date(c.date).toISOString().slice(0, 10) : Math.floor(new Date(c.date).getTime() / 1000),
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
    }));
  if (!out.length) throw new Error("yahoo: empty candle set");
  return out;
}
// Coinbase Exchange: real crypto OHLCV, products already named BTC-USD. 300-candle cap
// per request (covers SMA200 comfortably).
async function coinbaseHistory(symbol, days) {
  const span = Math.min(days, 300);
  const end = new Date(), start = new Date(Date.now() - span * 86400000);
  const rows = await j(
    `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=86400&start=${start.toISOString()}&end=${end.toISOString()}`,
    15000, { "user-agent": "InvestmentAdvisor/0.1" });
  if (!Array.isArray(rows) || !rows.length) throw new Error("coinbase: no data");
  return rows.reverse().map((c) => ({
    time: new Date(c[0] * 1000).toISOString().slice(0, 10),
    open: c[3], high: c[2], low: c[1], close: c[4], volume: c[5] || 0,
  }));
}
// FMP daily history (free key; also powers congressional trades + quote fallback).
async function fmpHistory(symbol, days) {
  const k = keys().fmp_key;
  if (!k) throw new Error("no fmp key");
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  // FMP retired the v3 API for accounts created after Aug 2025 — use the stable API.
  const rows = await j(`https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${from}&apikey=${encodeURIComponent(k)}`, 15000).catch(fmpLimit);
  if (!Array.isArray(rows) || !rows.length) throw new Error("fmp: no data");
  return rows.reverse().map((c) => ({
    time: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
  })).filter((c) => c.close > 0);
}

// Coinbase hourly candles (crypto intraday; 300-candle cap ≈ 12 days of 1h bars).
async function coinbaseIntraday(symbol, days) {
  const span = Math.min(days, 12);
  const end = new Date(), start = new Date(Date.now() - span * 86400000);
  const rows = await j(
    `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=3600&start=${start.toISOString()}&end=${end.toISOString()}`,
    15000, { "user-agent": "InvestmentAdvisor/0.1" });
  if (!Array.isArray(rows) || !rows.length) throw new Error("coinbase: no intraday");
  return rows.reverse().map((c) => ({ time: c[0], open: c[3], high: c[2], low: c[1], close: c[4], volume: c[5] || 0 }));
}
// FMP hourly candles (stock intraday — included in the free tier). FMP stamps intraday
// bars in US-Eastern time; convert with a DST-aware offset (minor edge weeks tolerated).
async function fmpIntraday(symbol, days) {
  const k = keys().fmp_key;
  if (!k) throw new Error("no fmp key");
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = await j(`https://financialmodelingprep.com/stable/historical-chart/1hour?symbol=${encodeURIComponent(symbol)}&from=${from}&apikey=${encodeURIComponent(k)}`, 15000).catch(fmpLimit);
  if (!Array.isArray(rows) || !rows.length) throw new Error("fmp: no intraday");
  const etOffset = (dstr) => { const m = Number(dstr.slice(5, 7)); return (m >= 4 && m <= 10) ? "-04:00" : "-05:00"; };
  return rows.reverse().map((c) => ({
    time: Math.floor(Date.parse(c.date.replace(" ", "T") + etOffset(c.date)) / 1000),
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
  })).filter((c) => c.time > 0 && c.close > 0);
}

// OHLCV candles, oldest -> newest. interval '1d' (time = 'YYYY-MM-DD') or intraday
// '1h' (time = epoch seconds; Coinbase/FMP first, Yahoo fallback).
async function history(symbol, days = 365, interval = "1d", { allowStale = true } = {}) {
  const ttlMs = interval === "1d" ? ttl("history") : ttl("quotes");
  return cached(`yh:${symbol}:${days}:${interval}`, ttlMs, async () => {
    const chain = interval !== "1d"
      ? (isCrypto(symbol) ? [["coinbase", () => coinbaseIntraday(symbol, days)], ["yahoo", () => yahooHistory(symbol, days, interval)]]
         : isIndex(symbol) ? [["yahoo", () => yahooHistory(symbol, days, interval)]]
         : [["fmp", () => fmpIntraday(symbol, days)], ["yahoo", () => yahooHistory(symbol, days, interval)]])
      : isCrypto(symbol) ? [["coinbase", () => coinbaseHistory(symbol, days)], ["yahoo", () => yahooHistory(symbol, days, "1d")]]
      : isIndex(symbol) ? [["yahoo", () => yahooHistory(symbol, days, "1d")]]
      : [["fmp", () => fmpHistory(symbol, days)], ["yahoo", () => yahooHistory(symbol, days, "1d")]];
    const errs = [];
    for (const [name, src] of chain) {
      try { return await src(); } catch (e) { errs.push(`${name}: ${String(e.message).slice(0, 90)}`); }
    }
    throw new Error("all candle sources failed — " + errs.join(" · "));
  }, { allowStale });
}

// ---------------------------------------------------------------- options chains
// CBOE delayed quotes: the last FREE keyless options-chain source (15-min delayed —
// fine for advisory use). Option symbols encode UNDERLYING+YYMMDD+C/P+strike*1000.
async function cboeOptionsChain(symbol, maxDte = 60, exactExpiry = null) {
  const d = await j(`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`,
    15000, { "user-agent": "Mozilla/5.0 (InvestmentAdvisor personal research)" });
  const all = (d.data && d.data.options) || [];
  const spot = (d.data && d.data.current_price) || null;
  if (!all.length) throw new Error("cboe: no options");
  const re = new RegExp(`^${symbol}(\\d{6})([CP])(\\d{8})$`);
  const parsed = [];
  for (const o of all) {
    const m = re.exec(o.option || "");
    if (!m) continue;
    const expiry = `20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`;
    parsed.push({ expiry, type: m[2], strike: Number(m[3]) / 1000, o });
  }
  const now = Date.now();
  const expiries = [...new Set(parsed.map((p) => p.expiry))].map((e) => new Date(e + "T21:00:00Z")).filter((e) => e > now).sort((a, b) => a - b);
  let pick;
  if (exactExpiry) {
    const want = Date.parse(exactExpiry);
    pick = expiries.slice().sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
  } else {
    const within = expiries.filter((e) => (e - now) / 86400000 <= maxDte);
    pick = within.length ? within[within.length - 1] : expiries[0];
  }
  if (!pick) throw new Error("cboe: no usable expiry");
  const pickStr = pick.toISOString().slice(0, 10);
  const legs = parsed.filter((p) => p.expiry === pickStr && (spot == null || Math.abs(p.strike - spot) / spot <= 0.15));
  const shape = (p) => ({
    strike: p.strike, last: p.o.last_trade_price ?? null, bid: p.o.bid ?? null, ask: p.o.ask ?? null,
    volume: p.o.volume || 0, open_interest: p.o.open_interest || 0,
    iv: p.o.iv != null ? +(p.o.iv * 100).toFixed(1) : null,
  });
  return {
    symbol, spot, expiry: pickStr, dte: Math.round((pick - now) / 86400000),
    calls: legs.filter((p) => p.type === "C").sort((a, b) => a.strike - b.strike).map(shape),
    puts: legs.filter((p) => p.type === "P").sort((a, b) => a.strike - b.strike).map(shape),
    source: "cboe",
  };
}

// Options chain for the expiry nearest (but not exceeding) maxDte days out — or the
// chain closest to exactExpiry ('YYYY-MM-DD') when pricing a held option.
// CBOE (keyless) first; Yahoo fallback.
async function optionsChain(symbol, maxDte = 60, exactExpiry = null) {
  return cached(`yo:${symbol}:${maxDte}:${exactExpiry || ""}`, ttl("quotes"), async () => {
    try { return await cboeOptionsChain(symbol, maxDte, exactExpiry); } catch (_) { /* fall through to yahoo */ }
    const base = await paced(async () => (await yf()).options(symbol, {}));
    const expiries = (base.expirationDates || []).map((d) => new Date(d));
    const now = Date.now();
    let pick;
    if (exactExpiry) {
      const want = Date.parse(exactExpiry);
      pick = expiries.slice().sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
    } else {
      const within = expiries.filter((d) => (d - now) / 86400000 <= maxDte && d > now);
      pick = within.length ? within[within.length - 1] : expiries[0];
    }
    if (!pick) return null;
    const r = await paced(async () => (await yf()).options(symbol, { date: pick }));
    const chain = (r.options && r.options[0]) || {};
    const spot = (r.quote && r.quote.regularMarketPrice) || null;
    const near = (list) => (list || [])
      .filter((o) => spot == null || Math.abs(o.strike - spot) / spot <= 0.15)
      .map((o) => ({
        strike: o.strike, last: o.lastPrice, bid: o.bid, ask: o.ask,
        volume: o.volume || 0, open_interest: o.openInterest || 0,
        iv: o.impliedVolatility != null ? +(o.impliedVolatility * 100).toFixed(1) : null,
      }));
    return {
      symbol, spot,
      expiry: pick.toISOString().slice(0, 10),
      dte: Math.round((pick - now) / 86400000),
      calls: near(chain.calls),
      puts: near(chain.puts),
    };
  });
}

// Next earnings date for a STOCK (null when unknown — degrade, never error).
async function nextEarnings(symbol) {
  return cached(`ye:${symbol}`, ttl("history"), async () => {
    try {
      const r = await paced(async () => (await yf()).quoteSummary(symbol, { modules: ["calendarEvents"] }));
      const dates = (r.calendarEvents && r.calendarEvents.earnings && r.calendarEvents.earnings.earningsDate) || [];
      const next = dates.map((d) => new Date(d)).filter((d) => d >= new Date(Date.now() - 86400000)).sort((a, b) => a - b)[0];
      if (!next) return null;
      return { date: next.toISOString().slice(0, 10), days_away: Math.max(0, Math.round((next - Date.now()) / 86400000)) };
    } catch (_) { return null; }
  });
}

// Company sector/industry (concentration warnings). FMP profile first (keyed), Yahoo after.
async function sector(symbol) {
  return cached(`ys:${symbol}`, 7 * 24 * 3600 * 1000, async () => {
    const k = keys().fmp_key;
    if (k) {
      try {
        const d = (await j(`https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(k)}`))[0] || {};
        if (d.sector) return { sector: d.sector, industry: d.industry || null };
      } catch (_) {}
    }
    try {
      const r = await paced(async () => (await yf()).quoteSummary(symbol, { modules: ["assetProfile"] }));
      const p = r.assetProfile || {};
      return { sector: p.sector || null, industry: p.industry || null };
    } catch (_) { return { sector: null, industry: null }; }
  });
}

// Symbol/company search (Charts + Watchlist pickers).
async function search(query) {
  const r = await paced(async () => (await yf()).search(query, { quotesCount: 8, newsCount: 0 }));
  return (r.quotes || [])
    .filter((q) => q.symbol)
    .map((q) => ({ symbol: q.symbol, name: q.shortname || q.longname || "", exchange: q.exchDisp || "", type: q.quoteType || "" }));
}

// Data-source health for the UI indicator: is the Yahoo breaker open, and which keys
// are set (keyless stock data = throttle-prone, worth surfacing to the user).
function providerHealth() {
  const k = keys();
  return {
    yahoo_cooling_down: Date.now() < yahooCooldownUntil,
    yahoo_cooldown_seconds_left: Math.max(0, Math.round((yahooCooldownUntil - Date.now()) / 1000)),
    keys_set: { fmp: !!k.fmp_key, finnhub: !!k.finnhub_key, alpha_vantage: !!k.alpha_vantage_key },
  };
}

module.exports = { quote, quotes, history, optionsChain, nextEarnings, sector, search, providerHealth };
