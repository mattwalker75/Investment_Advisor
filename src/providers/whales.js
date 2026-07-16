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

// Recent congressional trades (Senate + House) via FMP: [{politician, chamber, ticker, action, amount, traded_at}]
async function congressTrades(limit = 60) {
  const key = settings.getSync().providers.fmp_key;
  if (!key) return [];   // no key -> feature quietly off (shown in Settings)
  try {
    return await cached("whale:congress", ttlMs(), async () => {
      const pull = async (path, chamber) => {
        const r = await fetch(`https://financialmodelingprep.com/stable/${path}?page=0&limit=25&apikey=${encodeURIComponent(key)}`,
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
        })).filter((t) => t.ticker);
      };
      const [senate, house] = await Promise.all([
        pull("senate-latest", "senate").catch(() => []),
        pull("house-latest", "house").catch(() => []),
      ]);
      return [...senate, ...house]
        .sort((a, b) => String(b.traded_at).localeCompare(String(a.traded_at)))
        .slice(0, limit);
    });
  } catch (_) { return []; }
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

module.exports = { snapshot, congressTrades, recent13F };
