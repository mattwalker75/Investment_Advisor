"use strict";
// News provider: pulls the user's configured RSS feeds (business/financial/market/crypto
// press) and returns recent headlines. The scanner feeds these to the AI as market
// context; per-symbol headline matching highlights news about scan candidates.
const Parser = require("rss-parser");
const { cached } = require("./cache");
const settings = require("../settings");

const parser = new Parser({ timeout: 15000, headers: { "user-agent": "InvestmentAdvisor/0.1 (personal research tool)" } });

// Headline sentiment: a finance-tuned keyword lexicon (instant + deterministic — no AI
// round-trip). Score = bullish hits − bearish hits → 'pos' | 'neg' | 'neu'.
const POS_RE = /\b(beats?|surges?|soars?|rall(y|ies)|records?|jumps?|gains?|rises?|climbs?|upgrades?|bullish|profits?|strong|tops|boosts?|booms?|wins?|approv\w+|breakthrough|expands?|outperforms?|recovers?|rebounds?|raises guidance|all-time high|inflows?)\b/i;
const NEG_RE = /\b(miss(es)?|falls?|drops?|plunges?|crash\w*|sinks?|slumps?|tumbles?|cuts?|layoffs?|downgrades?|bearish|losses|weak\w*|fears?|warn\w*|recession|lawsuits?|probes?|fraud|bankrupt\w*|defaults?|declines?|sell-?offs?|tariffs?|war|strikes?|attacks?|slides?|halts?|outflows?|shutdown|crisis)\b/i;
function sentiment(title) {
  const pos = (title.match(new RegExp(POS_RE.source, "gi")) || []).length;
  const neg = (title.match(new RegExp(NEG_RE.source, "gi")) || []).length;
  return pos > neg ? "pos" : neg > pos ? "neg" : "neu";
}

// Title normalization used for de-dup AND the AI-sentiment overlay keys.
const titleKey = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60);

// AI-review overlay: sentiments the model assigned (via the 🤖 AI review button),
// stored by title key so they survive the 30-minute news cache refresh.
const db = require("../db");
async function getOverlay() {
  const row = await db.get("SELECT value FROM cache WHERE `key`='news:ai-overlay'").catch(() => null);
  try { return row ? JSON.parse(row.value) : {}; } catch (_) { return {}; }
}
async function saveOverlay(entries) {
  const cur = await getOverlay();
  const now = Date.now();
  for (const [k, s] of Object.entries(entries)) cur[k] = { s, at: now };
  for (const k of Object.keys(cur)) if (now - cur[k].at > 72 * 3600 * 1000) delete cur[k];  // prune stale
  await db.run(
    db.dialect === "mysql"
      ? "INSERT INTO cache (`key`, value, fetched_at) VALUES ('news:ai-overlay',?,?) ON DUPLICATE KEY UPDATE value=VALUES(value), fetched_at=VALUES(fetched_at)"
      : "INSERT INTO cache (`key`, value, fetched_at) VALUES ('news:ai-overlay',?,?) ON CONFLICT(`key`) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at",
    [JSON.stringify(cur), now]);
}

// All headlines across feeds, newest first: [{title, link, source, published_at, sentiment}]
// AI-reviewed sentiments (overlay) take precedence over the keyword classifier.
async function headlines(maxAgeHours = 48, maxItems = 80) {
  const cfg = settings.getSync().providers;
  const ttlMs = (cfg.cache_minutes.news || 30) * 60 * 1000;
  const list = await cached(`news:v2:${maxAgeHours}h`, ttlMs, async () => {
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    const all = [];
    await Promise.all((cfg.news_feeds || []).map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        const source = (feed.title || new URL(url).hostname).slice(0, 40);
        for (const item of (feed.items || []).slice(0, 30)) {
          const at = item.isoDate ? Date.parse(item.isoDate) : (item.pubDate ? Date.parse(item.pubDate) : Date.now());
          if (at >= cutoff && item.title) all.push({ title: item.title.trim(), link: item.link || "", source, published_at: at, sentiment: sentiment(item.title) });
        }
      } catch (_) { /* one dead feed never kills the scan */ }
    }));
    all.sort((a, b) => b.published_at - a.published_at);
    // De-dup near-identical titles across feeds.
    const seen = new Set(), out = [];
    for (const h of all) {
      const k = h.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60);
      if (!seen.has(k)) { seen.add(k); out.push(h); }
      if (out.length >= maxItems) break;
    }
    return out;
  });
  // Apply AI-reviewed sentiments on top of the keyword grades.
  const overlay = await getOverlay().catch(() => ({}));
  return list.map((h) => {
    const o = overlay[titleKey(h.title)];
    return o ? { ...h, sentiment: o.s, ai_reviewed: true } : h;
  });
}

// Headlines mentioning a symbol or company name (crude but effective matching).
function matching(all, symbol, name) {
  // Escape regex metacharacters — symbols like BRK.B or ^GSPC would otherwise mis-match.
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sym = reEsc(symbol.replace(/-USD$/, ""));
  const symRe = new RegExp(`(^|[^A-Za-z])\\$?${sym}([^A-Za-z]|$)`, "i");
  const nameWord = (name || "").split(/\s+/)[0];
  const nameRe = nameWord && nameWord.length >= 3 ? new RegExp(`\\b${reEsc(nameWord)}`, "i") : null;
  return all.filter((h) => symRe.test(h.title) || (nameRe && nameRe.test(h.title))).slice(0, 6);
}

module.exports = { headlines, matching, titleKey, saveOverlay };
