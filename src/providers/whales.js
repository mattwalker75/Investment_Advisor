"use strict";
// "Smart money" tracking (best-effort — this data is inherently delayed):
//  - Recent institutional 13F-HR filings from SEC EDGAR (free, official; which big funds
//    just disclosed an updated portfolio — 13Fs are quarterly, so this signals WHO is active).
//  - Congressional stock trades via Financial Modeling Prep (needs a FREE FMP API key in
//    Settings → Data feeds). The keyless aggregators (CapitolTrades, the Stock Watcher S3
//    buckets) block server-side fetches or are defunct, so this is the honest option.
// All wrapped so failures return empty data — whale info enriches a scan, never blocks it.
const { cached } = require("./cache");
const settings = require("../settings");

const ttlMs = () => (settings.getSync().providers.cache_minutes.whales || 720) * 60 * 1000;
// SEC requires a declared automated-tool UA with a contact — plain product UAs get 403'd.
const SEC_UA = { "user-agent": "InvestmentAdvisor personal-research admin@localhost.local" };

// Option plays hide in the free-text asset description ("call options", "put option",
// Pelosi's famous LEAPS…). Pull the hint out so per-person views can show it.
function optionHint(desc) {
  const d = String(desc || "");
  if (!/option|call|put|leap/i.test(d)) return null;
  const kind = /put/i.test(d) ? "put" : /call|leap/i.test(d) ? "call" : "option";
  const strike = (d.match(/strike (?:price of )?\$?([\d,.]+)/i) || [])[1] || null;
  const expiry = (d.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/) || [])[1] || null;
  return { kind, strike, expiry, raw: d.slice(0, 160) };
}

// The DEEP congressional feed (Senate + House, several pages — the free tier caps each
// request at 25 rows). Powers the per-person views, the follow alerts, and the scan's
// per-ticker aggregation. NOTE the honest limits: disclosures lag 30-45 days by law,
// amounts are ranges, and crypto is essentially absent (BTC-ETF tickers at best).
async function congressFeed(pages = 4) {
  const key = settings.getSync().providers.fmp_key;
  if (!key) return [];   // no key -> feature quietly off (shown in Settings)
  try {
    return await cached(`whale:congress-feed:${pages}`, ttlMs(), async () => {
      const pull = async (path, chamber, page) => {
        const r = await fetch(`https://financialmodelingprep.com/stable/${path}?page=${page}&limit=25&apikey=${encodeURIComponent(key)}`,
          { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return [];
        const d = await r.json();
        return (Array.isArray(d) ? d : []).map((t) => ({
          politician: `${t.firstName || ""} ${t.lastName || ""}`.trim() || t.office || "unknown",
          chamber,
          ticker: (t.symbol || t.ticker || "").toUpperCase(),
          asset_name: t.assetDescription || "",
          action: /purchase|buy/i.test(t.type || "") ? "buy" : /sale|sell/i.test(t.type || "") ? "sell" : (t.type || ""),
          amount: t.amount || "",
          traded_at: t.transactionDate || "",
          disclosed_at: t.disclosureDate || t.dateRecieved || "",
          option: optionHint(t.assetDescription),
        })).filter((t) => t.ticker || t.asset_name);
      };
      const jobs = [];
      for (let p = 0; p < pages; p++) {
        jobs.push(pull("senate-latest", "senate", p).catch(() => []));
        jobs.push(pull("house-latest", "house", p).catch(() => []));
      }
      const rows = (await Promise.all(jobs)).flat();
      // de-dup (same filing can appear across page pulls) + newest first
      const seen = new Set();
      return rows.filter((t) => {
        const k = `${t.politician}|${t.ticker}|${t.action}|${t.traded_at}|${t.amount}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).sort((a, b) => String(b.disclosed_at || b.traded_at).localeCompare(String(a.disclosed_at || a.traded_at)));
    });
  } catch (_) { return []; }
}

// Back-compat shim for the scanner: the newest slice of the deep feed.
async function congressTrades(limit = 60) {
  return (await congressFeed()).filter((t) => t.ticker).slice(0, limit);
}

// Everything one person filed recently (case-insensitive substring: "pelosi" works).
async function politicianTrades(name) {
  const q = String(name || "").trim().toLowerCase();
  if (!q) return [];
  return (await congressFeed()).filter((t) => t.politician.toLowerCase().includes(q));
}

// Distinct people in the current feed window, most active first.
async function politicians() {
  const by = {};
  for (const t of await congressFeed()) {
    by[t.politician] = by[t.politician] || { name: t.politician, chamber: t.chamber, filings: 0, latest: "" };
    by[t.politician].filings++;
    const d = String(t.disclosed_at || t.traded_at);
    if (d > by[t.politician].latest) by[t.politician].latest = d;
  }
  return Object.values(by).sort((a, b) => b.filings - a.filings);
}

// Company-insider (SEC Form 4) trades per symbol via FMP — CEO/founder buys and sells.
// The free tier may decline this endpoint: degrade to an explanatory note, never error.
async function insiderTrades(symbol) {
  const key = settings.getSync().providers.fmp_key;
  if (!key) return { note: "Insider (Form 4) tracking needs the free FMP key — Settings → Data feeds." };
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return { note: "symbol required" };
  try {
    return await cached(`whale:insider:${sym}`, ttlMs(), async () => {
      const r = await fetch(`https://financialmodelingprep.com/stable/insider-trading/search?symbol=${encodeURIComponent(sym)}&page=0&limit=40&apikey=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`FMP insider ${r.status}`);
      const d = await r.json();
      const rows = (Array.isArray(d) ? d : []).map((t) => ({
        insider: t.reportingName || t.name || "unknown",
        relation: t.typeOfOwner || t.position || "",
        action: /buy|purchase|award|grant/i.test(t.transactionType || t.acquisitionOrDisposition || "") || (t.acquisitionOrDisposition === "A") ? "buy" : "sell",
        shares: t.securitiesTransacted ?? t.shares ?? null,
        price: t.price ?? null,
        traded_at: t.transactionDate || "",
        filed_at: t.filingDate || "",
      })).slice(0, 40);
      const buys = rows.filter((x) => x.action === "buy").length;
      return { symbol: sym, trades: rows, summary: rows.length ? `${buys} buy / ${rows.length - buys} sell filings in the recent window` : "no recent Form 4 filings" };
    });
  } catch (e) {
    return { symbol: sym, note: `Insider data unavailable (${String(e.message).slice(0, 80)}) — FMP's free tier may not include the Form 4 endpoint; congressional data is unaffected.` };
  }
}

// Most recent 13F-HR filers from EDGAR's live "latest filings" feed (free, official).
async function recent13F(limit = 20) {
  try {
    return await cached("whale:13f", ttlMs(), async () => {
      const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=13F-HR&company=&dateb=&owner=include&count=40&output=atom";
      const r = await fetch(url, { headers: SEC_UA, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`edgar ${r.status}`);
      const xml = await r.text();
      const out = [];
      for (const e of xml.split("<entry>").slice(1)) {
        const title = (e.match(/<title>([^<]+)<\/title>/) || [])[1] || "";
        const updated = (e.match(/<updated>([^<]+)<\/updated>/) || [])[1] || "";
        // "13F-HR - Fund Name, LLC (0001234567) (Filer)" -> "Fund Name, LLC"
        const name = title.replace(/^13F-HR(\/A)?\s*-\s*/i, "").replace(/\s*\(\d{7,}\)\s*\(Filer\)\s*$/i, "").trim();
        if (name) out.push({ fund: name.replace(/&amp;/g, "&"), filed_at: updated.slice(0, 10) });
        if (out.length >= limit) break;
      }
      return out;
    });
  } catch (_) { return []; }
}

// One call for the scanner: congress trades summarized per ticker + active 13F filers.
async function snapshot() {
  const [congress, filings] = await Promise.all([congressTrades(), recent13F()]);
  const byTicker = {};
  for (const t of congress) {
    const k = t.ticker;
    byTicker[k] = byTicker[k] || { ticker: k, buys: 0, sells: 0, politicians: new Set() };
    if (t.action === "buy") byTicker[k].buys++;
    else if (t.action === "sell") byTicker[k].sells++;
    byTicker[k].politicians.add(t.politician);
  }
  const congress_by_ticker = Object.values(byTicker)
    .map((v) => ({ ticker: v.ticker, buys: v.buys, sells: v.sells, politicians: [...v.politicians].slice(0, 5) }))
    .sort((a, b) => (b.buys + b.sells) - (a.buys + a.sells))
    .slice(0, 25);
  return { congress_trades: congress.slice(0, 40), congress_by_ticker, recent_13f_filers: filings };
}

module.exports = { snapshot, congressTrades, congressFeed, politicianTrades, politicians, insiderTrades, recent13F };
