"use strict";
/* Investment Advisor — frontend. Plain JS, no framework.
 *
 * SECTION INDEX (search for the "----------" markers):
 *   helpers            $/esc/api/formatters/ago
 *   market strip       loadMarketStrip + provider-health indicator
 *   scan               scan button + status polling
 *   dashboard          loadDashboard, briefing, sentiment, news, advisor prompts
 *   position sizing    risk-based suggested size math
 *   recommendations    filters, loadRecs, recCard
 *   modal helpers      modal/closeModal/confirmDialog + take-trade/option modals
 *   watchlist          loadWatchlist + add/edit/delete
 *   trades             health check, manual trade, CSV import, exits, loadTrades
 *   performance        loadPerformance, equity curve, calibration, backtester
 *   charts             lightweight-charts setup, overlays, plan lines, compare,
 *                      user-drawn levels, symbol search
 *   settings           loadSettings (all forms) + save wiring
 *   view               applyView (tab/card visibility)
 *   events             refreshEvents (activity feed + desktop alerts, one loop)
 *   advisor chat       drawer, streaming, slash commands
 *   boot               init sequence + background intervals
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}
const fmtP = (v, dp) => v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: dp ?? (v >= 100 ? 2 : v >= 1 ? 2 : 4), maximumFractionDigits: dp ?? (v >= 100 ? 2 : v >= 1 ? 2 : 4) });
const fmtPct = (v) => v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%";
const cls = (v) => (v == null ? "" : v >= 0 ? "up" : "down");
const fmtDT = (ts) => new Date(Number(ts)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
};

/* ---------- tabs ---------- */
document.querySelectorAll("#tabs .tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#tabs .tab").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("main .panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + b.dataset.tab));
  const load = { dashboard: loadDashboard, recs: loadRecs, charts: ensureChart, watchlist: loadWatchlist, trades: loadTrades, performance: loadPerformance, settings: loadSettings }[b.dataset.tab];
  if (load) load();
}));

/* ---------- topbar: market strip + scan ---------- */
const MKT_LABELS = { SPY: "S&P 500", QQQ: "NASDAQ 100", DIA: "DOW", "BTC-USD": "BTC", "ETH-USD": "ETH" };
async function loadMarketStrip() {
  try {
    const d = await api("/api/market");
    $("market-strip").innerHTML = Object.entries(d.quotes).map(([s, q]) => q ? `
      <div class="mkt"><div class="s">${MKT_LABELS[s] || s}</div>
        <div class="p">${fmtP(q.price)}</div>
        <div class="c ${cls(q.change_pct)}">${fmtPct(q.change_pct)}</div></div>` : "").join("");
    window._market = d;
    renderSentiment(d.sentiment);
    renderNews(d.headlines);
  } catch (_) { /* strip is decorative — never block the app on it */ }
  loadProviderHealth();
}

// Data-source health indicator in the topbar: silent when everything is fine, a chip
// with the reason when degraded (Yahoo cooldown) or running keyless.
async function loadProviderHealth() {
  try {
    const h = await api("/api/health/providers");
    const el = $("src-badge");
    if (h.status === "ok") { el.textContent = ""; el.title = ""; return; }
    el.innerHTML = h.status === "degraded"
      ? ' · <span class="down">⛔ data throttled</span>'
      : ' · <span style="color:var(--amber,#fbbf24)">⚠ keyless data</span>';
    el.title = (h.hints || []).join("\n");
  } catch (_) {}
}

let scanPoll = null;
function setScanUI(running) {
  $("scan-btn").disabled = running;
  const d = $("dash-scan-link");
  if (d) { d.disabled = running; d.textContent = running ? "⏳ Scanning…" : "Scan now"; }
}
$("scan-btn").addEventListener("click", startScan);
async function startScan() {
  try { await api("/api/scan", { method: "POST" }); } catch (e) { alert(e.message); return; }
  setScanUI(true);
  pollScan();
}
function pollScan() {
  clearInterval(scanPoll);
  scanPoll = setInterval(async () => {
    try {
      const st = await api("/api/scan/status");
      if (st.running) {
        $("scan-sub").textContent = "⏳ scanning… " + (st.step || "");
        setScanUI(true);
      } else {
        clearInterval(scanPoll);
        setScanUI(false);
        const last = st.last;
        // NOTE: every rewrite must recreate BOTH badge spans (#db-badge, #src-badge) —
        // loadProviderHealth() writes into #src-badge and would silently die without it.
        $("scan-sub").innerHTML = (last
          ? (last.status === "done"
              ? `last scan: ${ago(last.finished_at)} · ${last.recs_count} rec(s) from ${last.universe_count} symbols · <span id="db-badge">${dbBadge}</span>`
              : `last scan <span class="down">failed</span>: ${esc((last.error || "").slice(0, 80))} · <span id="db-badge">${dbBadge}</span>`)
          : `AI market scanner · <span id="db-badge">${dbBadge}</span>`) + '<span id="src-badge"></span>';
        loadProviderHealth();   // repopulate the recreated badge
        loadRecs(); loadDashboard();
      }
    } catch (_) {}
  }, 1500);
}
$("dash-scan-link") && $("dash-scan-link").addEventListener("click", startScan);

/* ---------- dashboard ---------- */
function renderSentiment(s) {
  if (!s) return;
  const g = (label, fg) => fg ? `
    <div class="gauge"><div class="g-val">${fg.value}</div>
      <div class="g-lab">${label} — ${esc(fg.label || "")}${fg.yesterday != null ? ` (prev ${fg.yesterday})` : ""}</div>
      <div class="bar"><i style="left:${Math.min(98, Math.max(0, fg.value))}%"></i></div></div>`
    : `<div class="gauge"><div class="g-val">—</div><div class="g-lab">${label} unavailable</div></div>`;
  $("senti-row").innerHTML = g("Stocks Fear & Greed", s.stocks_fear_greed) + g("Crypto Fear & Greed", s.crypto_fear_greed);
}
$("news-ai-review").addEventListener("click", async () => {
  const btn = $("news-ai-review"), note = $("news-ai-note");
  btn.disabled = true; note.textContent = "AI grading…";
  try {
    const r = await api("/api/news/ai-review", { method: "POST" });
    renderNews(r.headlines);
    note.textContent = `✓ ${r.reviewed} graded, ${r.changed} changed`;
  } catch (e) { note.textContent = "✗ " + e.message.slice(0, 60); }
  finally { btn.disabled = false; setTimeout(() => { note.textContent = ""; }, 8000); }
});

function renderNews(headlines) {
  if (!headlines) return;
  $("dash-news").innerHTML = (headlines || []).slice(0, 12).map((h) =>
    `<a class="${h.sentiment || "neu"}" href="${esc(h.link)}" target="_blank" rel="noopener"><span class="src">${esc(h.source)} · ${ago(h.published_at)}${h.ai_reviewed ? " · 🤖" : ""}</span>${esc(h.title)}</a>`).join("") || '<div class="hint">No headlines.</div>';
}
async function loadBriefing() {
  try {
    const b = await api("/api/briefing");
    if (b && b.text) { $("briefing-body").innerHTML = mdLite(b.text); $("briefing-when").textContent = ago(b.at); }
  } catch (_) {}
}
$("weekly-run").addEventListener("click", async () => {
  $("weekly-run").disabled = true; $("briefing-when").textContent = "writing the weekly review…";
  try {
    // show the last one instantly if it's fresh (<20h), else generate
    const last = await api("/api/review/weekly").catch(() => ({}));
    const r = last.text && Date.now() - last.at < 20 * 3600 * 1000 ? last : await api("/api/review/weekly", { method: "POST" });
    $("briefing-body").innerHTML = mdLite(r.text);
    $("briefing-when").textContent = "weekly review · " + (r.at ? ago(r.at) : "just now");
  } catch (e) { $("briefing-when").textContent = "✗ " + e.message; }
  finally { $("weekly-run").disabled = false; }
});
$("briefing-run").addEventListener("click", async () => {
  $("briefing-run").disabled = true; $("briefing-when").textContent = "generating…";
  try { const r = await api("/api/briefing", { method: "POST" }); $("briefing-body").innerHTML = mdLite(r.text); $("briefing-when").textContent = "just now"; }
  catch (e) { $("briefing-when").textContent = "✗ " + e.message; }
  finally { $("briefing-run").disabled = false; }
});

async function loadDashboard() {
  loadMarketStrip();
  loadBriefing();
  try {
    const p = await api("/api/performance");
    const R = p.recommendations;
    $("success-tiles").innerHTML = R.finished ? `
      <div class="tile"><div class="v ${R.win_rate >= 50 ? "up" : "down"}">${R.win_rate}%</div><div class="l">win rate</div></div>
      <div class="tile"><div class="v ${cls(R.avg_pnl_pct)}">${fmtPct(R.avg_pnl_pct)}</div><div class="l">avg outcome</div></div>
      <div class="tile"><div class="v">${R.finished}</div><div class="l">graded</div></div>
      <div class="tile"><div class="v">${R.tracking}</div><div class="l">in progress</div></div>
      <div class="tile"><div class="v">${R.open}</div><div class="l">awaiting entry</div></div>`
      : '<div class="hint">No finished recommendations yet — the system grades itself as ideas play out.</div>';
  } catch (_) {}
  try {
    const recs = await api("/api/recommendations");
    const active = recs.filter((r) => ["open", "tracking"].includes(r.status));
    $("recs-badge").hidden = !active.length;
    $("recs-badge").textContent = active.length;
    $("dash-recs").innerHTML = recs.slice(0, 6).map(recRowSmall).join("") || '<div class="hint">No recommendations yet — run a scan.</div>';
  } catch (_) {}
  loadFigures($("fig-search").value.trim() || null);
  await refreshEvents();   // activity feed + desktop alerts share ONE events fetch
}
function recRowSmall(r) {
  return `<div class="ev"><span class="t">${ago(r.created_at)}</span>
    <span class="side ${r.side}">${r.side.toUpperCase()}</span>
    <b class="mono"> ${esc(r.symbol)}</b> ${assetBadge(r)} · entry ${fmtP(r.entry_low)}–${fmtP(r.entry_high)} · stop ${fmtP(r.stop_loss)}
    <span class="chipstat ${r.status}">${r.status}</span>${r.taken ? ' <span class="taken-flag">✓ taken</span>' : ""}</div>`;
}

/* ---------- notable figures (congress + Form 4 insiders) ---------- */
async function loadFigures(name) {
  try {
    const d = await api("/api/figures" + (name ? "?name=" + encodeURIComponent(name) : ""));
    $("fig-note").textContent = (d.politicians || []).length ? "" : d.note || "";
    $("fig-follow").hidden = !name || !(d.trades || []).length;
    if (name) $("fig-follow").textContent = (d.followed || []).some((f) => f.toLowerCase() === name.toLowerCase()) ? "✓ Following (unfollow)" : "➕ Follow";
    $("fig-followed").innerHTML = (d.followed || []).length
      ? "Following: " + d.followed.map((f) => `<span class="chipstat" title="click to view">${esc(f)}</span>`).join(" ") : "";
    $("fig-followed").querySelectorAll(".chipstat").forEach((c) => c.addEventListener("click", () => { $("fig-search").value = c.textContent; loadFigures(c.textContent); }));
    $("fig-list").innerHTML = (d.trades || []).length ? `<table class="grid"><thead><tr>
        <th>Who</th><th>Action</th><th>Ticker</th><th>Amount</th><th>Traded</th><th>Disclosed</th></tr></thead>
      <tbody>${d.trades.slice(0, 14).map((t) => `<tr>
        <td>${esc(t.politician)} <span class="hint">${esc(t.chamber || "")}</span></td>
        <td><span class="side ${t.action === "buy" ? "buy" : t.action === "sell" ? "sell" : ""}">${esc((t.action || "").toUpperCase())}</span>${t.option ? ` <span class="chipstat" title="${esc(t.option.raw || "")}">🧾 ${esc(t.option.kind)}s</span>` : ""}</td>
        <td class="mono"><b>${esc(t.ticker || "—")}</b>${!t.ticker && t.asset_name ? ` <span class="hint">${esc(t.asset_name.slice(0, 30))}</span>` : ""}</td>
        <td class="hint">${esc(t.amount || "—")}</td>
        <td class="hint">${esc(t.traded_at || "—")}</td>
        <td class="hint">${esc(t.disclosed_at || "—")}</td></tr>`).join("")}</tbody></table>`
      : `<div class="hint">${name ? "No recent filings matching “" + esc(name) + "” in the current window." : esc(d.note || "No data.")}</div>`;
  } catch (e) { $("fig-note").textContent = "⚠ " + e.message; }
}
$("fig-go").addEventListener("click", () => loadFigures($("fig-search").value.trim() || null));
$("fig-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); loadFigures($("fig-search").value.trim() || null); } });
$("fig-follow").addEventListener("click", async () => {
  const name = $("fig-search").value.trim();
  if (!name) return;
  const unfollow = $("fig-follow").textContent.includes("unfollow");
  await api("/api/figures/follow", { method: "POST", body: JSON.stringify({ name, unfollow }) }).catch(() => {});
  loadFigures(name);
});
$("ins-go").addEventListener("click", async () => {
  const sym = $("ins-symbol").value.trim().toUpperCase();
  if (!sym) return;
  $("fig-list").innerHTML = '<div class="hint">Loading Form 4 filings…</div>';
  try {
    const d = await api("/api/insiders/" + encodeURIComponent(sym));
    $("fig-list").innerHTML = (d.trades || []).length ? `<div class="hint" style="margin-bottom:4px"><b>${esc(sym)}</b> insiders — ${esc(d.summary || "")}</div>
      <table class="grid"><thead><tr><th>Insider</th><th>Role</th><th>Action</th><th>Shares</th><th>Price</th><th>Traded</th></tr></thead>
      <tbody>${d.trades.slice(0, 14).map((t) => `<tr>
        <td>${esc(t.insider)}</td><td class="hint">${esc(t.relation || "")}</td>
        <td><span class="side ${t.action === "buy" ? "buy" : "sell"}">${esc(t.action.toUpperCase())}</span></td>
        <td class="mono">${t.shares != null ? fmtP(t.shares, 0) : "—"}</td>
        <td class="mono">${t.price != null ? fmtP(t.price) : "—"}</td>
        <td class="hint">${esc(t.traded_at || "—")}</td></tr>`).join("")}</tbody></table>`
      : `<div class="hint">${esc(d.note || "No recent Form 4 filings for " + sym + ".")}</div>`;
  } catch (e) { $("fig-list").innerHTML = `<div class="hint">⚠ ${esc(e.message)}</div>`; }
});
$("ins-symbol").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("ins-go").click(); } });

/* ---------- position sizing (advisory): risk X% of account across entry->stop ---------- */
let appSettings = null;   // public settings snapshot (risk numbers for sizing math)
async function loadAppSettings() { try { appSettings = await api("/api/settings"); } catch (_) {} }
function positionSize(r) {
  if (!appSettings) return null;
  const risk = appSettings.preferences.risk;
  const entryMid = (r.entry_low + r.entry_high) / 2;
  // Option recs are premium-denominated: risk per CONTRACT = premium distance ×100.
  const mult = r.asset_type === "option" ? 100 : 1;
  const perUnit = Math.abs(entryMid - r.stop_loss) * mult;
  if (!perUnit || !entryMid) return null;
  const riskAmt = (risk.account_size * risk.risk_per_trade_pct) / 100;
  let qty = riskAmt / perUnit;
  qty = r.asset_type === "crypto" ? +qty.toFixed(4) : Math.floor(qty);
  if (!qty) return null;
  return { qty, cost: +(qty * entryMid * mult).toFixed(2), risk_amount: +riskAmt.toFixed(2), entry_mid: entryMid, mult };
}

/* ---------- recommendations ---------- */
let recsFilter = "active";
document.querySelectorAll("#recs-filter button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#recs-filter button").forEach((x) => x.classList.toggle("active", x === b));
  recsFilter = b.dataset.f; loadRecs();
}));
let recsTypeFilter = "all";   // 'all' | 'stock' | 'option' | 'crypto'
document.querySelectorAll("#recs-type-filter button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#recs-type-filter button").forEach((x) => x.classList.toggle("active", x === b));
  recsTypeFilter = b.dataset.t; loadRecs();
}));
// Refresh prices + shadow-tracking pass — never touches strategy levels.
async function refreshRecPrices() {
  const btn = $("recs-refresh");
  btn.disabled = true; btn.textContent = "↻ refreshing…";
  try { await api("/api/recommendations/refresh", { method: "POST" }); await loadRecs(); }
  catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.textContent = "↻ Refresh prices"; }
}

async function loadRecs() {
  if (!$("recs-list").childElementCount) $("recs-list").innerHTML = loadingHtml;
  let all;
  try { all = await api("/api/recommendations"); }
  catch (e) { errState($("recs-list"), "Couldn't load recommendations — " + e.message, loadRecs); $("recs-count").textContent = ""; return; }
  let list = recsFilter === "all" ? all
    : recsFilter === "finished" ? all.filter((r) => ["stopped", "target_hit", "expired", "closed"].includes(r.status))
    : all.filter((r) => ["open", "tracking"].includes(r.status));
  if (recsTypeFilter !== "all") list = list.filter((r) => tradeClass(r) === recsTypeFilter);
  $("recs-count").textContent = `${list.length} recommendation(s)`;
  // Preserve expanded cards across re-renders (the 60s auto-refresh was collapsing
  // whatever the user was reading).
  const openIds = new Set([...document.querySelectorAll("#recs-list .rec.open")].map((e) => e.id));
  $("recs-list").innerHTML = list.map(recCard).join("") || '<div class="hint">Nothing here. Run a market scan to generate ideas.</div>';
  openIds.forEach((id) => { const el = $(id); if (el) el.classList.add("open"); });
  list.forEach((r) => {
    const el = $("rec-" + r.id);
    el.querySelector(".rec-head").addEventListener("click", () => el.classList.toggle("open"));
    const takeBtn = el.querySelector(".take:not(.take-option)");
    if (takeBtn) takeBtn.addEventListener("click", (e) => { e.stopPropagation(); takeTradeModal(r); });
    const takeOpt = el.querySelector(".take-option");
    if (takeOpt) takeOpt.addEventListener("click", (e) => { e.stopPropagation(); takeOptionModal(r); });
    const dis = el.querySelector(".dismiss");
    if (dis) dis.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!await confirmDialog({ title: `Dismiss ${r.symbol}?`, message: "The idea closes as <b>dismissed</b> and stops being tracked. This can't be undone.", confirmText: "Dismiss" })) return;
      await api(`/api/recommendations/${r.id}/dismiss`, { method: "POST" }); loadRecs();
    });
    const ch = el.querySelector(".to-chart");
    if (ch) ch.addEventListener("click", (e) => { e.stopPropagation(); openChart(r.asset_type === "crypto" && !r.symbol.includes("-") ? r.symbol + "-USD" : r.symbol, { entry_low: r.entry_low, entry_high: r.entry_high, stop_loss: r.stop_loss, targets: r.targets }); });
    const cp = el.querySelector(".complete-btn");
    if (cp) cp.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!await confirmDialog({ title: `Mark ${r.symbol} complete?`, message: r.status === "tracking" ? "A tracking idea is graded at the <b>current price</b> (hit targets keep their rungs) and counts in the stats." : "The idea closes without a graded outcome.", confirmText: "Complete", danger: false })) return;
      try { const v = await api(`/api/recommendations/${r.id}/complete`, { method: "POST" });
        if (v.pnl_pct != null) alert(`Completed — shadow outcome ${v.pnl_pct > 0 ? "+" : ""}${v.pnl_pct}%`);
        loadRecs(); loadDashboard(); }
      catch (err) { alert(err.message); }
    });
    const rv = el.querySelector(".revalidate");
    if (rv) rv.addEventListener("click", async (e) => {
      e.stopPropagation(); rv.disabled = true; rv.textContent = "♻ checking…";
      try { const v = await api(`/api/recommendations/${r.id}/revalidate`, { method: "POST" });
        alert(`${v.verdict.toUpperCase()}: ${v.note}`); loadRecs(); }
      catch (err) { alert(err.message); rv.disabled = false; rv.textContent = "♻ Re-validate"; }
    });
  });
}
// Trade class: what you'd actually be trading. A stock rec with an options play is an OPTION idea.
function tradeClass(r) { return r.options_play ? "option" : r.asset_type === "crypto" ? "crypto" : "stock"; }
const TRADE_CLASS_LABEL = { stock: "📈 STOCK", option: "🧾 OPTION", crypto: "₿ CRYPTO" };
function assetBadge(r) { const c = tradeClass(r); return `<span class="asset-badge ${c}">${TRADE_CLASS_LABEL[c]}</span>`; }
function recCard(r) {
  const outcome = r.outcome || {};
  const pnl = outcome.pnl_pct;
  // Earnings-inside-horizon warning (extracted from the rec's input snapshot at scan time).
  const earn = r.earnings;
  const isOpt = r.asset_type === "option";      // first-class option rec: all levels are PREMIUM
  const lvl = (label) => isOpt ? "premium " + label : label;
  return `<div class="rec" id="rec-${r.id}">
    <div class="rec-head">
      <span class="sym">${esc(r.symbol)}</span>
      ${assetBadge(r)}
      <span class="hint">${esc(r.name || "")}${r.sector ? " · " + esc(r.sector) : ""}</span>
      <span class="chipstat" title="where this idea came from">${r.source === "chat" ? "💬 chat" : "🔍 scan"}</span>
      ${(r.outcome && r.outcome.revalidation) ? `<span class="chipstat ${r.outcome.revalidation.verdict === "valid" ? "tracking" : ""}" title="${esc(r.outcome.revalidation.note || "")}">♻ ${esc(r.outcome.revalidation.verdict)} · ${ago(r.outcome.revalidation.at)}</span>` : ""}
      ${earn && earn.days_away <= (r.horizon_max_days || 30) ? `<span class="chipstat" style="color:var(--amber)" title="earnings ${esc(earn.date)}">⚠ earnings ${earn.days_away}d</span>` : ""}
      <span class="side ${r.side}">${r.side.toUpperCase()}</span>
      <span class="chipstat ${r.status}">${r.status}${pnl != null ? ` ${fmtPct(pnl)}` : ""}</span>
      ${r.taken ? '<span class="taken-flag">✓ taken</span>' : ""}
      ${(() => {   // COMPLETE marker: stop hit, final target hit, expired, or user-completed
        if (!["stopped", "target_hit", "expired", "closed"].includes(r.status)) return "";
        const why = r.status === "stopped" ? "stop loss hit" : r.status === "target_hit" ? "final target hit"
          : r.status === "expired" ? "entry window expired"
          : (r.outcome && r.outcome.result === "completed_by_user") ? "completed by you"
          : (r.outcome && r.outcome.result === "withdrawn") ? "withdrawn (re-validation)" : "dismissed";
        return `<span class="chipstat complete ${r.status === "stopped" ? "stopped" : ""}" title="${why}">✔ COMPLETE · ${why}</span>`;
      })()}
      ${r.risk_reward ? `<span class="chipstat" title="ladder-weighted reward vs entry-to-stop risk">R:R ${r.risk_reward}</span>` : ""}
      <span class="conf">${fmtDT(r.created_at)} · Confidence: ${Math.round((r.confidence || 0) * 100)}%</span>
    </div>
    <div class="rec-body">
      <div class="levels">
        ${(() => {   // live price + in-zone status (the "can I act NOW?" box)
          if (isOpt) {   // option recs track the PREMIUM; latest tracked value lives in outcome.last_price
            const lastPrem = r.outcome && r.outcome.last_price;
            return `<div class="lvl"><div class="l">premium @ rec${lastPrem != null ? ' <span class="hint">· last tracked</span>' : ""}</div><div class="v">${fmtP(r.current_price)}${lastPrem != null ? ` → ${fmtP(lastPrem)}` : ""}</div></div>`;
          }
          if (r.live_price == null || !["open", "tracking"].includes(r.status)) return `<div class="lvl"><div class="l">price @ rec</div><div class="v">${fmtP(r.current_price)}</div></div>`;
          const lp = r.live_price, mid = (r.entry_low + r.entry_high) / 2;
          const inZone = r.side === "buy" ? lp <= r.entry_high * 1.002 && lp >= r.entry_low * 0.99 : lp >= r.entry_low * 0.998 && lp <= r.entry_high * 1.01;
          let zoneNote;
          if (inZone) zoneNote = '<span class="inzone">IN ENTRY ZONE</span>';
          else if (r.side === "buy" ? lp > r.entry_high : lp < r.entry_low) zoneNote = `<span class="hint">${fmtPct(Math.abs((lp - (r.side === "buy" ? r.entry_high : r.entry_low)) / mid) * 100).replace("+", "")} ${r.side === "buy" ? "above" : "below"} zone</span>`;
          else zoneNote = `<span class="hint">${fmtPct(Math.abs((lp - (r.side === "buy" ? r.entry_low : r.entry_high)) / mid) * 100).replace("+", "")} past zone</span>`;
          return `<div class="lvl"><div class="l">price now <span class="hint">(@rec ${fmtP(r.current_price)})</span></div><div class="v">${fmtP(lp)} ${zoneNote}</div></div>`;
        })()}
        <div class="lvl ${r.outcome && r.outcome.entry_hit_at ? "hit" : ""}"><div class="l">${lvl("entry zone")} ${r.outcome && r.outcome.entry_hit_at ? "✓" : ""}</div><div class="v">${fmtP(r.entry_low)} – ${fmtP(r.entry_high)}</div></div>
        ${(() => { const mid = (r.entry_low + r.entry_high) / 2; const pct = mid ? ((r.stop_loss - mid) / mid) * 100 : null;
          return `<div class="lvl stop ${r.status === "stopped" ? "hit-stop" : ""}"><div class="l">${lvl("stop")} ${r.status === "stopped" ? "✗ HIT" : ""}</div><div class="v">${fmtP(r.stop_loss)} <span class="hint">(${fmtPct(pct)})</span></div></div>`; })()}
        ${(r.targets || []).map((t, i) => { const mid = (r.entry_low + r.entry_high) / 2; const pct = mid ? ((t.price - mid) / mid) * 100 : null;
          const hit = r.outcome && (r.outcome.targets_hit || []).includes(t.price);
          return `<div class="lvl tgt ${hit ? "hit" : ""}"><div class="l">${lvl("target")} ${i + 1} · sell ${t.sell_pct}% ${hit ? "✓" : ""}</div><div class="v">${fmtP(t.price)} <span class="hint">(${fmtPct(pct)})</span></div></div>`; }).join("")}
        <div class="lvl"><div class="l">est. duration</div><div class="v">${r.horizon_min_days}–${r.horizon_max_days}d${(() => {
          if (r.status === "tracking" && r.outcome && r.outcome.entry_hit_at) { const d = Math.max(1, Math.round((Date.now() - r.outcome.entry_hit_at) / 86400000)); return ` <span class="hint">· day ${d}</span>`; }
          if (r.status === "open" && r.expires_at) { const d = Math.ceil((Number(r.expires_at) - Date.now()) / 86400000); return d > 0 ? ` <span class="${d <= 2 ? "down" : "hint"}">· window closes ${d}d</span>` : ""; }
          return ""; })()}</div></div>
        ${(() => { const ps = positionSize(r); if (!ps) return "";
          const reward = (r.targets || []).reduce((s2, t) => s2 + (t.sell_pct / 100) * Math.abs(t.price - ps.entry_mid) * ps.qty * (ps.mult || 1), 0);
          const unit = isOpt ? "contract(s)" : r.asset_type === "stock" ? "sh" : "units";
          return `<div class="lvl"><div class="l">suggested size · risk $${fmtP(ps.risk_amount, 0)}</div><div class="v">${ps.qty} ${unit} ≈ $${fmtP(ps.cost, 0)} <span class="up">→ reward ≈ $${fmtP(reward, 0)}</span></div></div>`; })()}
      </div>
      ${(r.signals || []).length ? `<div class="sig-chips" title="the indicator signals the AI saw at recommendation time">${r.signals.slice(0, 6).map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}
      ${r.options_play ? `<div class="opt-play"><span class="tag">OPTIONS PLAY</span> — <b>${esc(r.options_play.strategy.replace(/_/g, " "))}</b>
        ${r.options_play.strikes && r.options_play.strikes.length ? " strike " + r.options_play.strikes.join("/") : ""}
        exp ${esc(r.options_play.chain_expiry || r.options_play.expiry || "?")}
        ${r.options_play.est_premium ? `<br>est. premium <b>$${fmtP(r.options_play.est_premium, 2)}</b>/sh ($${fmtP(r.options_play.est_premium * 100, 0)}/contract)` : ""}
        ${r.options_play.breakeven ? ` · breakeven <b>${fmtP(r.options_play.breakeven)}</b>` : ""}
        ${r.options_play.max_loss_per_contract ? ` · max loss <b class="down">$${fmtP(r.options_play.max_loss_per_contract, 0)}</b>/contract` : ""}
        ${r.options_play.iv ? ` · IV ${r.options_play.iv}%` : ""}
        <br>${esc(r.options_play.note || "")}</div>` : ""}
      <div class="rationale">${esc(r.rationale)}</div>
      ${outcome.entry_price ? `<div class="hint">shadow entry ${fmtP(outcome.entry_price)} ${outcome.targets_hit && outcome.targets_hit.length ? "· targets hit: " + outcome.targets_hit.map((p) => fmtP(p)).join(", ") : ""} ${outcome.last_price ? "· last " + fmtP(outcome.last_price) : ""}</div>` : ""}
      <div class="rec-actions">
        <button class="ghost to-chart">📈 Chart</button>
        ${!r.taken && !isOpt && ["open", "tracking"].includes(r.status) ? '<button class="take">✅ I took this trade</button>' : ""}
        ${!r.taken && r.options_play && ["open", "tracking"].includes(r.status) ? '<button class="take take-option" style="background:linear-gradient(180deg,#8b5cf6,#6d28d9)">🧾 Took the option</button>' : ""}
        ${["open", "tracking"].includes(r.status) ? '<button class="ghost complete-btn" title="Mark this idea finished — a tracking idea is graded at the current price">✔ Complete</button>' : ""}
        ${["open", "tracking"].includes(r.status) ? '<button class="ghost revalidate" title="AI re-checks this idea against current data">♻ Re-validate</button>' : ""}
        ${["open", "tracking"].includes(r.status) ? '<button class="ghost dismiss">✖ Dismiss</button>' : ""}
      </div>
    </div>
  </div>`;
}

/* ---------- modal helpers ---------- */
function modal(html) { $("modal-box").innerHTML = html; $("modal").hidden = false; }
function closeModal() { $("modal").hidden = true; }

// Styled confirm dialog (replaces native confirm-less destructive clicks): resolves
// true only on explicit confirmation; backdrop click / Cancel resolve false.
function confirmDialog({ title = "Are you sure?", message = "", confirmText = "Confirm", danger = true } = {}) {
  return new Promise((resolve) => {
    modal(`<h3>${esc(title)}</h3>
      ${message ? `<div class="hint" style="margin-bottom:12px">${message}</div>` : ""}
      <div class="actions"><button class="ghost" id="m-cancel">Cancel</button>
      <button class="${danger ? "danger" : "primary"}" id="m-go">${esc(confirmText)}</button></div>`);
    const backdrop = (e) => { if (e.target === $("modal")) done(false); };
    const done = (v) => { $("modal").removeEventListener("click", backdrop); closeModal(); resolve(v); };
    $("modal").addEventListener("click", backdrop);
    $("m-cancel").addEventListener("click", () => done(false));
    $("m-go").addEventListener("click", () => done(true));
  });
}

// Async panel states: consistent loading + error-with-retry (no more silent blanks).
const loadingHtml = '<div class="hint">Loading…</div>';
function errState(el, msg, retry) {
  el.innerHTML = `<div class="err-state">⚠ ${esc(msg)}<button class="ghost small">Retry</button></div>`;
  el.querySelector("button").addEventListener("click", retry);
}
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });

function takeTradeModal(r) {
  const ps = positionSize(r);
  modal(`<h3>Take trade — ${esc(r.symbol)}</h3>
    <div class="hint">Log the fill you actually got; the advisor then tracks it against the plan (stop ${fmtP(r.stop_loss)}, ${(r.targets || []).length} target(s)).${ps ? `<br>Suggested size for your risk settings: <b>${ps.qty}</b> (risking ~$${fmtP(ps.risk_amount, 0)} if stopped).` : ""}</div>
    <div class="frow"><label>Quantity</label><input id="m-qty" type="number" step="any" min="0" value="${ps ? ps.qty : ""}"></div>
    <div class="frow"><label>Entry price</label><input id="m-price" type="number" step="any" value="${r.current_price || ""}"></div>
    <div class="actions"><button class="ghost" onclick="document.getElementById('modal').hidden=true">Cancel</button>
    <button class="primary" id="m-go">Open trade</button></div>`);
  $("m-go").addEventListener("click", async () => {
    try {
      await api(`/api/recommendations/${r.id}/take`, { method: "POST", body: JSON.stringify({ qty: Number($("m-qty").value), entry_price: Number($("m-price").value) }) });
      closeModal(); loadRecs(); loadTrades();
    } catch (e) { alert(e.message); }
  });
}

// Take the recommendation's OPTIONS play (contracts + premium per share).
function takeOptionModal(r) {
  const p = r.options_play || {};
  modal(`<h3>Take option — ${esc(r.symbol)}</h3>
    <div class="hint"><b>${esc((p.strategy || "").replace(/_/g, " "))}</b> · strike ${p.strikes && p.strikes[0] ? fmtP(p.strikes[0]) : "?"} · exp ${esc(p.chain_expiry || p.expiry || "?")}
      ${p.est_premium ? `<br>Est. premium $${fmtP(p.est_premium, 2)}/share ($${fmtP(p.est_premium * 100, 0)}/contract)` : ""}
      ${p.max_loss_per_contract ? ` · max loss $${fmtP(p.max_loss_per_contract, 0)}/contract` : ""}</div>
    <div class="frow"><label>Contracts</label><input id="m-qty" type="number" step="1" min="1" value="1"></div>
    <div class="frow"><label>Premium paid<br><span class="hint">per share</span></label><input id="m-price" type="number" step="any" value="${p.est_premium || ""}"></div>
    <div class="actions"><button class="ghost" onclick="document.getElementById('modal').hidden=true">Cancel</button>
    <button class="primary" id="m-go">Open option trade</button></div>`);
  $("m-go").addEventListener("click", async () => {
    try {
      await api(`/api/recommendations/${r.id}/take`, { method: "POST", body: JSON.stringify({ instrument: "option", qty: Number($("m-qty").value), entry_price: Number($("m-price").value) }) });
      closeModal(); loadRecs(); loadTrades();
    } catch (e) { alert(e.message); }
  });
}


/* ---------- watchlist ---------- */
async function loadWatchlist() {
  if (!$("wl-list").childElementCount) $("wl-list").innerHTML = loadingHtml;
  let rows;
  try { rows = await api("/api/watchlist"); }
  catch (e) { errState($("wl-list"), "Couldn't load the watchlist — " + e.message, loadWatchlist); return; }
  $("wl-list").innerHTML = rows.length ? `<table class="grid"><thead><tr>
      <th>Symbol</th><th>Name</th><th>Price</th><th>Day</th><th>Alert above</th><th>Alert below</th><th></th>
    </tr></thead><tbody>${rows.map((w) => `<tr>
      <td class="mono"><b>${esc(w.symbol)}</b> <span class="hint">${w.asset_type}</span></td>
      <td class="hint">${esc(w.name || "")}</td>
      <td class="mono">${fmtP(w.price)}</td>
      <td class="mono ${cls(w.change_pct)}">${fmtPct(w.change_pct)}</td>
      <td class="mono">${w.alert_above != null ? fmtP(w.alert_above) + (w.alerts_fired.above_at ? ' <span class="up">✓fired</span>' : "") : "—"}</td>
      <td class="mono">${w.alert_below != null ? fmtP(w.alert_below) + (w.alerts_fired.below_at ? ' <span class="down">✓fired</span>' : "") : "—"}</td>
      <td><button class="ghost small" data-wlchart="${esc(w.symbol)}">📈</button>
          <button class="ghost small" data-wledit="${w.id}" data-above="${w.alert_above ?? ""}" data-below="${w.alert_below ?? ""}">✎</button>
          <button class="ghost small" data-wldel="${w.id}">✖</button></td></tr>`).join("")}</tbody></table>`
    : '<div class="hint">Nothing watched yet. Add a symbol above — it will join every scan with priority and alert you at your levels.</div>';
  document.querySelectorAll("[data-wldel]").forEach((b) => b.addEventListener("click", async () => {
    const row = rows.find((w) => w.id === Number(b.dataset.wldel));
    if (!await confirmDialog({ title: `Remove ${row ? row.symbol : "this symbol"} from the watchlist?`, message: "It stops joining scans and its alerts are deleted.", confirmText: "Remove" })) return;
    await api("/api/watchlist/" + b.dataset.wldel, { method: "DELETE" }); loadWatchlist();
  }));
  document.querySelectorAll("[data-wlchart]").forEach((b) => b.addEventListener("click", () => openChart(b.dataset.wlchart)));
  document.querySelectorAll("[data-wledit]").forEach((b) => b.addEventListener("click", () => {
    modal(`<h3>Edit alerts</h3>
      <div class="frow"><label>Alert above</label><input id="m-above" type="number" step="any" value="${b.dataset.above}"></div>
      <div class="frow"><label>Alert below</label><input id="m-below" type="number" step="any" value="${b.dataset.below}"></div>
      <div class="hint">Changing a level re-arms its alert.</div>
      <div class="actions"><button class="ghost" onclick="document.getElementById('modal').hidden=true">Cancel</button>
      <button class="primary" id="m-go">Save</button></div>`);
    $("m-go").addEventListener("click", async () => {
      await api("/api/watchlist/" + b.dataset.wledit, { method: "PATCH", body: JSON.stringify({ alert_above: $("m-above").value || null, alert_below: $("m-below").value || null }) });
      closeModal(); loadWatchlist();
    });
  }));
}
$("wl-add").addEventListener("click", async () => {
  const sym = $("wl-symbol").value.trim();
  if (!sym) return;
  try {
    await api("/api/watchlist", { method: "POST", body: JSON.stringify({ symbol: sym, alert_above: $("wl-above").value || null, alert_below: $("wl-below").value || null }) });
    $("wl-symbol").value = ""; $("wl-above").value = ""; $("wl-below").value = "";
    loadWatchlist();
  } catch (e) { alert(e.message); }
});
$("wl-symbol").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("wl-add").click(); } });

/* ---------- trades ---------- */
// On-demand AI health check of every open position.
$("health-check-btn").addEventListener("click", async () => {
  const btn = $("health-check-btn"), noteEl = $("health-note");
  btn.disabled = true; noteEl.textContent = "AI reviewing positions…";
  try {
    const r = await api("/api/trades/health-check", { method: "POST" });
    const attention = r.verdicts.filter((v) => v.action !== "hold");
    noteEl.textContent = r.checked
      ? `✓ ${r.checked} reviewed — ${attention.length ? attention.length + " need attention" : "all healthy"}`
      : "no open positions to review";
    loadTrades(); loadDashboard();
  } catch (e) { noteEl.textContent = "✗ " + e.message; }
  finally { btn.disabled = false; setTimeout(() => { noteEl.textContent = ""; }, 8000); }
});

$("trade-add-btn").addEventListener("click", () => {
  modal(`<h3>Log a manual trade</h3>
    <div class="frow"><label>Symbol</label><input id="m-sym" placeholder="AAPL or BTC-USD" style="text-transform:uppercase"></div>
    <div class="frow"><label>Type</label><select id="m-type"><option value="stock">stock</option><option value="crypto">crypto</option><option value="option">option</option></select></div>
    <div id="m-optrows" hidden>
      <div class="frow"><label>Call / Put</label><select id="m-otype"><option value="call">call</option><option value="put">put</option></select></div>
      <div class="frow"><label>Strike</label><input id="m-strike" type="number" step="any"></div>
      <div class="frow"><label>Expiry</label><input id="m-expiry" type="date"></div>
    </div>
    <div class="frow"><label>Side</label><select id="m-side"><option value="buy">buy (long)</option><option value="sell">sell (short)</option></select></div>
    <div class="frow"><label id="m-qty-label">Quantity</label><input id="m-qty" type="number" step="any"></div>
    <div class="frow"><label id="m-price-label">Entry price</label><input id="m-price" type="number" step="any"></div>
    <div class="frow"><label>Stop loss</label><input id="m-stop" type="number" step="any" placeholder="optional (underlying price for options)"></div>
    <div class="actions"><button class="ghost" onclick="document.getElementById('modal').hidden=true">Cancel</button>
    <button class="primary" id="m-go">Log trade</button></div>`);
  $("m-type").addEventListener("change", () => {
    const isOpt = $("m-type").value === "option";
    $("m-optrows").hidden = !isOpt;
    $("m-qty-label").textContent = isOpt ? "Contracts" : "Quantity";
    $("m-price-label").textContent = isOpt ? "Premium (per share)" : "Entry price";
  });
  $("m-go").addEventListener("click", async () => {
    try {
      const body = {
        symbol: $("m-sym").value.trim().toUpperCase(), asset_type: $("m-type").value, side: $("m-side").value,
        qty: Number($("m-qty").value), entry_price: Number($("m-price").value),
        stop_loss: $("m-stop").value ? Number($("m-stop").value) : null,
      };
      if (body.asset_type === "option") body.option_details = { type: $("m-otype").value, strike: Number($("m-strike").value), expiry: $("m-expiry").value };
      await api("/api/trades", { method: "POST", body: JSON.stringify(body) });
      closeModal(); loadTrades();
    } catch (e) { alert(e.message); }
  });
});

// Import existing positions from a broker CSV export (paste or pick a file).
$("trade-import-btn").addEventListener("click", () => {
  modal(`<h3>Import positions from CSV</h3>
    <div class="hint">Paste a broker export (or choose a file). Needs at least <b>symbol</b>, <b>quantity</b>, and <b>price</b> columns — common header names are recognized (ticker, shares, avg cost…), extra columns are ignored. Rows become open trades so health checks, concentration, and tracking cover your whole portfolio.</div>
    <div class="frow"><input type="file" id="m-csvfile" accept=".csv,text/csv"></div>
    <textarea id="m-csv" style="width:100%;min-height:140px;font-family:monospace" placeholder="symbol,shares,avg_cost\nNVDA,10,121.50\nBTC-USD,0.25,61000"></textarea>
    <div class="actions"><button class="ghost" onclick="document.getElementById('modal').hidden=true">Cancel</button>
    <button class="primary" id="m-go">Import</button></div>
    <div class="hint" id="m-import-note"></div>`);
  $("m-csvfile").addEventListener("change", () => {
    const f = $("m-csvfile").files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $("m-csv").value = String(rd.result || ""); };
    rd.readAsText(f);
  });
  $("m-go").addEventListener("click", async () => {
    const csv = $("m-csv").value.trim();
    if (!csv) return;
    $("m-import-note").textContent = "importing…";
    try {
      const r = await api("/api/trades/import", { method: "POST", body: JSON.stringify({ csv }) });
      $("m-import-note").innerHTML = `✓ imported ${r.imported}${r.skipped_duplicates ? ` · ${r.skipped_duplicates} duplicate(s) skipped` : ""}${(r.errors || []).length ? `<br>⚠ ${r.errors.map(esc).join("<br>")}` : ""}`;
      loadTrades(); loadDashboard();
      if (!(r.errors || []).length) setTimeout(closeModal, 1800);
    } catch (e) { $("m-import-note").textContent = "✗ " + e.message; }
  });
});

function exitModal(t, remaining) {
  modal(`<h3>Exit — ${esc(t.symbol)}</h3>
    <div class="hint">Remaining position: ${remaining} @ entry ${fmtP(t.entry_price)}. Partial exits are fine — the trade closes when quantity reaches zero.</div>
    <div class="frow"><label>Exit price</label><input id="m-price" type="number" step="any" value="${t.last_price || ""}"></div>
    <div class="frow"><label>Quantity</label><input id="m-qty" type="number" step="any" value="${remaining}"></div>
    <div class="frow"><label>Reason</label><select id="m-reason"><option>target</option><option>stop</option><option>manual</option></select></div>
    <div class="actions"><button class="ghost" onclick="document.getElementById('modal').hidden=true">Cancel</button>
    <button class="primary" id="m-go">Record exit</button></div>`);
  $("m-go").addEventListener("click", async () => {
    try {
      await api(`/api/trades/${t.id}/exit`, { method: "POST", body: JSON.stringify({ price: Number($("m-price").value), qty: Number($("m-qty").value), reason: $("m-reason").value }) });
      closeModal(); loadTrades(); loadDashboard();
    } catch (e) { alert(e.message); }
  });
}

async function loadTrades() {
  if (!$("trades-open").childElementCount) $("trades-open").innerHTML = loadingHtml;
  let trades;
  try { trades = await api("/api/trades"); }
  catch (e) { errState($("trades-open"), "Couldn't load trades — " + e.message, loadTrades); return; }
  const open = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status === "closed");
  $("trades-badge").hidden = !open.length;
  $("trades-badge").textContent = open.length;

  $("trades-open").innerHTML = open.length ? `<table class="grid"><thead><tr>
      <th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Last</th><th>Stop</th><th>Health</th><th>Unrealized</th><th>Opened</th><th></th>
    </tr></thead><tbody>${open.map((t) => {
      const sold = (t.exits || []).reduce((s, e) => s + (e.qty || 0), 0);
      const remaining = t.qty - sold;
      const od = t.option_details;
      const sug = t.suggested_stop;
      const h = t.health;
      const hIcon = h ? ({ hold: "🟢", tighten_stop: "🟠", take_partial: "🟠", sell_now: "🔴" }[h.action] || "⚪") : "";
      return `<tr>
        <td class="mono"><b>${esc(t.symbol)}</b>${od ? ` <span class="hint">${fmtP(od.strike, 0)}${(od.type || "")[0] ? (od.type[0] || "").toUpperCase() : ""} ${esc(od.expiry || "")}</span>` : ""}${t.rec_id ? ' <span class="hint">· rec</span>' : ""}</td>
        <td><span class="side ${t.side}">${t.side.toUpperCase()}</span></td>
        <td class="mono">${remaining}${sold ? `<span class="hint">/${t.qty}</span>` : ""}</td>
        <td class="mono">${fmtP(t.entry_price)}</td>
        <td class="mono">${fmtP(t.last_price)}</td>
        <td class="mono">${fmtP(t.stop_loss)} <button class="ghost small" data-editstop="${t.id}" title="Edit stop">✎</button>
          ${sug ? `<br><span class="up" title="${esc(sug.basis)}">↑ ${fmtP(sug.price)}</span> <button class="ghost small" data-applystop="${t.id}" data-price="${sug.price}" title="Apply suggested stop (${esc(sug.basis)})">Apply</button>` : ""}</td>
        <td title="${h ? esc(h.note || "") : "no health check yet"}">${hIcon}${h ? ` <span class="hint">${esc((h.action || "").replace(/_/g, " "))}</span>` : '<span class="hint">—</span>'}</td>
        <td class="mono ${cls(t.unrealized_pnl)}">${t.unrealized_pnl != null ? `$${fmtP(t.unrealized_pnl, 2)} (${fmtPct(t.unrealized_pnl_pct)})` : "—"}</td>
        <td class="hint">${ago(t.entry_at)}</td>
        <td><button class="ghost small" data-tchart="${t.id}" title="Chart with your plan drawn">📈</button>
            <button class="ghost small" data-exit="${t.id}">Exit…</button></td></tr>`;
    }).join("")}</tbody></table>` : '<div class="hint">No open positions. Take a recommendation or log a manual trade.</div>';

  $("trades-closed").innerHTML = closed.length ? `<table class="grid"><thead><tr>
      <th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>P&L</th><th>Held</th><th>Closed</th>
    </tr></thead><tbody>${closed.map((t) => {
      const heldDays = t.closed_at ? Math.max(0, Math.round((t.closed_at - t.entry_at) / 86400000)) : null;
      const longTerm = heldDays != null && heldDays >= 365;
      return `<tr>
      <td class="mono"><b>${esc(t.symbol)}</b></td>
      <td><span class="side ${t.side}">${t.side.toUpperCase()}</span></td>
      <td class="mono">${t.qty}</td>
      <td class="mono">${fmtP(t.entry_price)}</td>
      <td class="mono ${cls(t.pnl)}">$${fmtP(t.pnl, 2)} (${fmtPct(t.pnl_pct)})</td>
      <td class="hint" title="holding period for tax purposes">${heldDays != null ? `${heldDays}d <span class="${longTerm ? "up" : ""}">${longTerm ? "long" : "short"}-term</span>` : "—"}</td>
      <td class="hint">${t.closed_at ? ago(t.closed_at) : "—"}</td></tr>`;
    }).join("")}</tbody></table>`
    : '<div class="hint">No closed trades yet.</div>';

  document.querySelectorAll("[data-exit]").forEach((b) => b.addEventListener("click", () => {
    const t = open.find((x) => x.id === Number(b.dataset.exit));
    const sold = (t.exits || []).reduce((s, e) => s + (e.qty || 0), 0);
    exitModal(t, t.qty - sold);
  }));
  document.querySelectorAll("[data-tchart]").forEach((b) => b.addEventListener("click", () => {
    const t = open.find((x) => x.id === Number(b.dataset.tchart));
    const sym = t.asset_type === "crypto" && !t.symbol.includes("-") ? t.symbol + "-USD" : t.symbol;
    openChart(sym, { entry: t.entry_price, stop_loss: t.stop_loss, targets: t.targets || [] });
  }));
  // Portfolio concentration warnings (correlated-risk check).
  api("/api/portfolio/concentration").then((c) => {
    $("concentration-banner").innerHTML = (c.warnings || []).length
      ? `<div class="warn-banner">${c.warnings.map((w) => esc(w)).join("<br>")}</div>` : "";
  }).catch(() => {});
  // Risk panel: "how much can today cost me?"
  api("/api/portfolio/risk").then((r) => {
    if (!r.positions || !r.positions.length) { $("risk-panel").innerHTML = ""; return; }
    $("risk-panel").innerHTML = `
      <div class="tiles" style="margin:4px 0 8px">
        <div class="tile"><div class="v down">$${fmtP(r.total_risk, 0)}</div><div class="l">at risk if all stops hit</div></div>
        <div class="tile"><div class="v ${r.risk_pct_of_account > 10 ? "down" : ""}">${r.risk_pct_of_account}%</div><div class="l">of $${fmtP(r.account_size, 0)} account</div></div>
        <div class="tile"><div class="v">$${fmtP(r.total_value, 0)}</div><div class="l">deployed</div></div>
        ${r.biggest ? `<div class="tile"><div class="v">${esc(r.biggest.symbol)}</div><div class="l">biggest risk · $${fmtP(r.biggest.risk, 0)}</div></div>` : ""}
        ${r.no_stop_count ? `<div class="tile"><div class="v down">${r.no_stop_count}</div><div class="l">position(s) with NO STOP</div></div>` : ""}
      </div>
      ${(r.warnings || []).length ? `<div class="warn-banner">${r.warnings.map(esc).join("<br>")}</div>` : ""}`;
  }).catch(() => { $("risk-panel").innerHTML = ""; });
  // Apply the advisor's suggested stop with one click.
  document.querySelectorAll("[data-applystop]").forEach((b) => b.addEventListener("click", async () => {
    try { await api(`/api/trades/${b.dataset.applystop}`, { method: "PATCH", body: JSON.stringify({ stop_loss: Number(b.dataset.price) }) }); loadTrades(); }
    catch (e) { alert(e.message); }
  }));
  // Manual stop edit.
  document.querySelectorAll("[data-editstop]").forEach((b) => b.addEventListener("click", () => {
    const t = open.find((x) => x.id === Number(b.dataset.editstop));
    modal(`<h3>Edit stop — ${esc(t.symbol)}</h3>
      <div class="hint">Entry ${fmtP(t.entry_price)} · last ${fmtP(t.last_price)}${t.suggested_stop ? ` · advisor suggests <b>${fmtP(t.suggested_stop.price)}</b> (${esc(t.suggested_stop.basis)})` : ""}</div>
      <div class="frow"><label>Stop loss</label><input id="m-stop" type="number" step="any" value="${t.stop_loss ?? ""}"></div>
      <div class="actions"><button class="ghost" onclick="document.getElementById('modal').hidden=true">Cancel</button>
      <button class="primary" id="m-go">Save</button></div>`);
    $("m-go").addEventListener("click", async () => {
      try { await api(`/api/trades/${t.id}`, { method: "PATCH", body: JSON.stringify({ stop_loss: Number($("m-stop").value) }) }); closeModal(); loadTrades(); }
      catch (e) { alert(e.message); }
    });
  }));
}

/* ---------- performance ---------- */
async function loadPerformance() {
  let p;
  try { p = await api("/api/performance"); }
  catch (e) { errState($("perf-rec-tiles"), "Couldn't load performance — " + e.message, loadPerformance); return; }
  const R = p.recommendations, T = p.trades;
  $("perf-rec-tiles").innerHTML = `
    <div class="tile"><div class="v">${R.total}</div><div class="l">total recs</div></div>
    <div class="tile"><div class="v ${R.win_rate >= 50 ? "up" : R.win_rate == null ? "" : "down"}">${R.win_rate != null ? R.win_rate + "%" : "—"}</div><div class="l">win rate</div></div>
    <div class="tile"><div class="v ${cls(R.avg_pnl_pct)}">${fmtPct(R.avg_pnl_pct)}</div><div class="l">avg outcome</div></div>
    <div class="tile"><div class="v up">${R.wins}</div><div class="l">wins</div></div>
    <div class="tile"><div class="v down">${R.finished - R.wins}</div><div class="l">losses</div></div>
    <div class="tile"><div class="v">${R.expired}</div><div class="l">expired</div></div>
    <div class="tile"><div class="v">${R.tracking}</div><div class="l">in progress</div></div>`;
  $("perf-rec-recent").innerHTML = R.recent_finished.length ? `<table class="grid"><thead><tr>
      <th>Symbol</th><th>Side</th><th>Result</th><th>Outcome</th><th>Taken?</th></tr></thead>
    <tbody>${R.recent_finished.map((r) => `<tr>
      <td class="mono"><b>${esc(r.symbol)}</b></td>
      <td><span class="side ${r.side}">${r.side.toUpperCase()}</span></td>
      <td><span class="chipstat ${r.status}">${r.status}</span></td>
      <td class="mono ${cls(r.pnl_pct)}">${fmtPct(r.pnl_pct)}</td>
      <td>${r.taken ? "✓" : ""}</td></tr>`).join("")}</tbody></table>` : "";
  // Confidence calibration: bucket finished recs by stated confidence.
  try {
    const all = await api("/api/recommendations");
    const fin = all.filter((r) => ["stopped", "target_hit"].includes(r.status) && r.outcome && r.outcome.pnl_pct != null);
    const buckets = [["< 60%", (c) => c < 0.6], ["60–70%", (c) => c >= 0.6 && c < 0.7], ["70–80%", (c) => c >= 0.7 && c < 0.8], ["80%+", (c) => c >= 0.8]];
    const rows = buckets.map(([label, test]) => {
      const grp = fin.filter((r) => test(r.confidence || 0));
      const wins = grp.filter((r) => r.outcome.pnl_pct > 0);
      return { label, n: grp.length, wr: grp.length ? Math.round((wins.length / grp.length) * 100) : null,
        avg: grp.length ? (grp.reduce((s2, r) => s2 + r.outcome.pnl_pct, 0) / grp.length).toFixed(2) : null };
    });
    $("perf-calibration").innerHTML = fin.length ? `<table class="grid"><thead><tr><th>Stated confidence</th><th>Graded</th><th>Win rate</th><th>Avg outcome</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${r.label}</td><td class="mono">${r.n}</td>
        <td class="mono ${r.wr != null ? (r.wr >= 50 ? "up" : "down") : ""}">${r.wr != null ? r.wr + "%" : "—"}</td>
        <td class="mono ${cls(Number(r.avg))}">${r.avg != null ? fmtPct(Number(r.avg)) : "—"}</td></tr>`).join("")}</tbody></table>`
      : '<div class="hint">Needs finished recommendations to grade.</div>';
  } catch (_) {}
  $("perf-trade-tiles").innerHTML = `
    <div class="tile"><div class="v">${T.closed}</div><div class="l">closed trades</div></div>
    <div class="tile"><div class="v ${T.win_rate >= 50 ? "up" : T.win_rate == null ? "" : "down"}">${T.win_rate != null ? T.win_rate + "%" : "—"}</div><div class="l">win rate</div></div>
    <div class="tile"><div class="v ${cls(T.total_pnl)}">$${fmtP(T.total_pnl, 2)}</div><div class="l">total P&L</div></div>
    <div class="tile"><div class="v ${cls(T.avg_pnl_pct)}">${fmtPct(T.avg_pnl_pct)}</div><div class="l">avg per trade</div></div>
    ${T.by_term ? `<div class="tile"><div class="v ${cls(T.by_term.short.pnl)}">$${fmtP(T.by_term.short.pnl, 0)}</div><div class="l">short-term P&L (${T.by_term.short.count})</div></div>
    <div class="tile"><div class="v ${cls(T.by_term.long.pnl)}">$${fmtP(T.by_term.long.pnl, 0)}</div><div class="l">long-term P&L (${T.by_term.long.count})</div></div>` : ""}`;
  loadEquityCurve();
  labRefreshSaved();
  loadAttribution();
}

// Attribution: the honest stats split so they teach something.
async function loadAttribution() {
  try {
    const a = await api("/api/performance/attribution");
    if (!a.finished) { $("attr-body").innerHTML = '<div class="hint">Builds as recommendations finish (shadow-graded, taken or not).</div>'; return; }
    const tbl = (title, obj, keyHead) => `
      <table class="grid" style="margin-top:6px"><thead><tr><th>${title}</th><th>Graded</th><th>Win rate</th><th>Avg outcome</th></tr></thead>
      <tbody>${Object.entries(obj).map(([k, g]) => `<tr>
        <td>${esc(k)}${g.n < 10 ? ' <span class="hint">(small sample)</span>' : ""}</td>
        <td class="mono">${g.n}</td>
        <td class="mono ${g.win_rate >= 50 ? "up" : "down"}">${g.win_rate ?? "—"}%</td>
        <td class="mono ${cls(g.avg_pnl_pct)}">${fmtPct(g.avg_pnl_pct)}</td></tr>`).join("")}</tbody></table>`;
    const drift = a.calibration_drift;
    $("attr-body").innerHTML = `
      ${tbl("By source", a.by_source)}
      ${tbl("By regime at entry", a.by_regime_at_entry)}
      ${tbl("By asset class", a.by_asset)}
      ${drift ? `<div class="hint" style="margin-top:8px"><b>Calibration drift:</b> early half ${drift.early.win_rate}% win @ avg conf ${drift.early.avg_confidence} → late half ${drift.late.win_rate}% win @ avg conf ${drift.late.avg_confidence}</div>` : ""}
      ${Object.keys(a.realized_trade_pnl_by_asset || {}).length ? `<div class="hint" style="margin-top:4px"><b>Realized trade P&L:</b> ${Object.entries(a.realized_trade_pnl_by_asset).map(([k, v]) => `${esc(k)} ${v >= 0 ? "+" : ""}$${fmtP(v, 0)}`).join(" · ")}</div>` : ""}
      <div class="hint" style="margin-top:4px">${esc(a.note)}</div>`;
  } catch (_) {}
}

// Equity curves: realized account curve + the "what if I took every rec" paper curve.
let equityChart = null;
async function loadEquityCurve() {
  const el = $("equity-chart");
  try {
    const e = await api("/api/portfolio/equity");
    const A = e.actual, W = e.what_if;
    if (!A.series.length && !W.series.length) {
      $("equity-tiles").innerHTML = "";
      el.style.display = "none";
      $("equity-note").textContent = "Builds as trades close and recommendations finish.";
      return;
    }
    el.style.display = "";
    const tile = (label, st, extra = "") => st ? `
      <div class="tile"><div class="v ${cls(st.pnl)}">$${fmtP(st.final_equity, 0)}</div><div class="l">${label} equity</div></div>
      <div class="tile"><div class="v ${cls(st.return_pct)}">${fmtPct(st.return_pct)}</div><div class="l">${label} return${extra}</div></div>` : "";
    $("equity-tiles").innerHTML = `
      <div class="tile"><div class="v">$${fmtP(e.starting_equity, 0)}</div><div class="l">starting size</div></div>
      ${tile("realized", A.stats)}
      ${tile("what-if", W.stats, ` · DD −${W.stats ? W.stats.max_drawdown_pct : 0}%`)}`;
    if (equityChart) { try { equityChart.remove(); } catch (_) {} equityChart = null; }
    equityChart = mkChart(el);
    if (A.series.length) {
      const s = equityChart.addAreaSeries({ lineColor: "#34d399", topColor: "rgba(52,211,153,.25)", bottomColor: "rgba(52,211,153,.02)", lineWidth: 2, title: "realized" });
      s.setData(A.series);
    }
    if (W.series.length) {
      const s = equityChart.addLineSeries({ color: "#38bdf8", lineWidth: 1.6, lineStyle: 2, title: "what-if" });
      s.setData(W.series);
    }
    equityChart.timeScale().fitContent();
    $("equity-note").textContent = `Dashed what-if line: ${W.note}. Risk sizing ${e.risk_per_trade_pct}%/trade on $${fmtP(e.starting_equity, 0)}.`;
  } catch (err) {
    $("equity-note").textContent = "⚠ " + err.message;
  }
}

// Threshold backtester.
$("bt-run").addEventListener("click", async () => {
  const btn = $("bt-run"); btn.disabled = true; $("bt-note").textContent = "replaying the past year… (~30-90s)";
  try {
    const r = await api("/api/backtest", { method: "POST", body: JSON.stringify({
      min_signals: Number($("bt-minsig").value) || 2,
      exit_model: $("bt-exit").value,
      slippage_pct: Number($("bt-slip").value),
    }) });
    $("bt-note").textContent = "";
    const O = r.overall || {};
    const wf = r.walk_forward;
    const wfRow = (label, m) => `<tr><td>${label}</td><td class="mono">${m.trades}</td>
      <td class="mono">${m.win_rate ?? "—"}%</td><td class="mono ${cls(m.expectancy_pct)}">${fmtPct(m.expectancy_pct)}</td>
      <td class="mono">${m.profit_factor ?? "—"}</td><td class="mono down">−${m.max_drawdown_pct ?? "—"}%</td></tr>`;
    $("bt-results").innerHTML = `
      <div class="tiles" style="margin-top:8px">
        <div class="tile"><div class="v">${r.total_trades}</div><div class="l">sim trades</div></div>
        <div class="tile"><div class="v ${O.win_rate >= 50 ? "up" : "down"}">${O.win_rate ?? "—"}%</div><div class="l">win rate</div></div>
        <div class="tile"><div class="v ${cls(O.expectancy_pct)}">${fmtPct(O.expectancy_pct)}</div><div class="l">expectancy / trade</div></div>
        <div class="tile"><div class="v">${O.profit_factor ?? "—"}</div><div class="l">profit factor</div></div>
        <div class="tile"><div class="v down">−${O.max_drawdown_pct ?? "—"}%</div><div class="l">max drawdown</div></div>
        <div class="tile"><div class="v">${r.symbols_with_trades}/${r.symbols_tested}</div><div class="l">symbols traded</div></div>
      </div>
      ${wf ? `<table class="grid" style="margin-top:8px"><thead><tr><th>Window</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>PF</th><th>Max DD</th></tr></thead>
        <tbody>${wfRow("In-sample (older)", wf.in_sample)}${wfRow(`Out-of-sample (since ${wf.cutoff_date})`, wf.out_of_sample)}</tbody></table>
        <div class="hint">${esc(wf.note)}</div>` : ""}
      <div class="hint">Rules: enter next open when ≥${r.config.min_signals} of your buy signals fire (trend-filtered); stop ${r.config.stop}; exit model <b>${r.config.exit_model}</b> (R:R ${r.config.rr}); max ${r.config.max_hold_bars} bars; slippage ${r.config.slippage_pct}%/fill${r.config.fee_pct_per_side ? `, fees ${r.config.fee_pct_per_side}%/side` : ""}. Gap-aware fills. Mechanical — tests your thresholds, not the AI.</div>
      <table class="grid" style="margin-top:8px"><thead><tr><th>Symbol</th><th>Trades</th><th>Win rate</th><th>Avg</th><th>Total</th></tr></thead>
      <tbody>${r.by_symbol.filter((x) => x.trades > 0).slice(0, 15).map((x) => `<tr>
        <td class="mono"><b>${esc(x.symbol)}</b></td><td class="mono">${x.trades}</td>
        <td class="mono">${x.win_rate ?? "—"}%</td>
        <td class="mono ${cls(x.avg_pnl_pct)}">${fmtPct(x.avg_pnl_pct)}</td>
        <td class="mono ${cls(x.total_pnl_pct)}">${fmtPct(x.total_pnl_pct)}</td></tr>`).join("")}</tbody></table>`;
  } catch (e) { $("bt-note").textContent = "✗ " + e.message; }
  finally { btn.disabled = false; }
});

/* ---------- strategy lab ---------- */
// Tiny markdown-lite renderer for the AI critique (bold + line breaks only, escaped).
function mdLite(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
}
async function labRefreshSaved() {
  try {
    const list = await api("/api/strategies");
    $("lab-saved").innerHTML = '<option value="">—</option>' + list.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("");
  } catch (_) {}
}
function labSpec() {
  const t = $("lab-spec").value.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) { throw new Error("spec JSON is invalid: " + e.message); }
}
async function labCompile() {
  const description = $("lab-desc").value.trim();
  if (!description) { $("lab-note").textContent = "describe the strategy first"; return null; }
  $("lab-note").textContent = "compiling…";
  const r = await api("/api/strategy/compile", { method: "POST", body: JSON.stringify({ description }) });
  $("lab-spec").value = JSON.stringify(r.spec, null, 2);
  $("lab-spec-box").open = true;
  $("lab-note").textContent = r.notes ? "⚠ " + r.notes : "✓ compiled — review the spec, then Run";
  return r.spec;
}
$("lab-compile").addEventListener("click", () => labCompile().catch((e) => { $("lab-note").textContent = "✗ " + e.message; }));
$("lab-run").addEventListener("click", async () => {
  const btn = $("lab-run");
  btn.disabled = true;
  try {
    let spec = labSpec();
    if (!spec) spec = await labCompile();
    if (!spec) return;
    $("lab-note").textContent = "running… (~5-60s)";
    const r = await api("/api/strategy/run" + ($("lab-critique").checked ? "?critique=1" : ""), { method: "POST", body: JSON.stringify({ spec }) });
    $("lab-note").textContent = "";
    $("lab-spec").value = JSON.stringify(r.spec, null, 2);
    const O = r.overall || {};
    const wf = r.walk_forward;
    const wfRow = (label, m) => `<tr><td>${label}</td><td class="mono">${m.trades}</td>
      <td class="mono">${m.win_rate ?? "—"}%</td><td class="mono ${cls(m.expectancy_pct)}">${fmtPct(m.expectancy_pct)}</td>
      <td class="mono">${m.profit_factor ?? "—"}</td><td class="mono down">−${m.max_drawdown_pct ?? "—"}%</td></tr>`;
    $("lab-results").innerHTML = r.total_trades ? `
      <div class="tiles" style="margin-top:8px">
        <div class="tile"><div class="v">${r.total_trades}</div><div class="l">sim trades</div></div>
        <div class="tile"><div class="v ${O.win_rate >= 50 ? "up" : "down"}">${O.win_rate ?? "—"}%</div><div class="l">win rate</div></div>
        <div class="tile"><div class="v ${cls(O.expectancy_pct)}">${fmtPct(O.expectancy_pct)}</div><div class="l">expectancy / trade</div></div>
        <div class="tile"><div class="v">${O.profit_factor ?? "—"}</div><div class="l">profit factor</div></div>
        <div class="tile"><div class="v down">−${O.max_drawdown_pct ?? "—"}%</div><div class="l">max drawdown</div></div>
        <div class="tile"><div class="v">${r.symbols_with_trades}/${r.symbols_tested}</div><div class="l">symbols traded</div></div>
      </div>
      ${wf ? `<table class="grid" style="margin-top:8px"><thead><tr><th>Window</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>PF</th><th>Max DD</th></tr></thead>
        <tbody>${wfRow("In-sample (older)", wf.in_sample)}${wfRow(`Out-of-sample (since ${wf.cutoff_date})`, wf.out_of_sample)}</tbody></table>` : ""}
      <div class="hint">Exits: ${Object.entries(r.exit_reasons || {}).map(([k, v]) => `${k} ×${v}`).join(" · ")}${r.model_priced_note ? "<br>⚠ " + esc(r.model_priced_note) : ""}${r.intraday_note ? "<br>⚠ " + esc(r.intraday_note) : ""}</div>
      <table class="grid" style="margin-top:8px"><thead><tr><th>Symbol</th><th>Trades</th><th>Win rate</th><th>Avg</th><th>Total</th></tr></thead>
      <tbody>${r.by_symbol.filter((x) => x.trades > 0).slice(0, 12).map((x) => `<tr>
        <td class="mono"><b>${esc(x.symbol)}</b></td><td class="mono">${x.trades}</td>
        <td class="mono">${x.win_rate ?? "—"}%</td>
        <td class="mono ${cls(x.avg_pnl_pct)}">${fmtPct(x.avg_pnl_pct)}</td>
        <td class="mono ${cls(x.total_pnl_pct)}">${fmtPct(x.total_pnl_pct)}</td></tr>`).join("")}</tbody></table>
      ${r.critique ? `<div class="briefing" style="margin-top:10px">${mdLite(r.critique)}</div>` : ""}`
      : '<div class="hint">No trades fired — the entry conditions never lined up on this universe/window. Loosen a threshold or widen the window.</div>';
  } catch (e) { $("lab-note").textContent = "✗ " + e.message; }
  finally { btn.disabled = false; }
});
$("lab-save").addEventListener("click", async () => {
  try {
    const spec = labSpec();
    if (!spec) { $("lab-note").textContent = "compile or paste a spec first"; return; }
    if ($("lab-name").value.trim()) spec.name = $("lab-name").value.trim();
    await api("/api/strategies", { method: "PUT", body: JSON.stringify({ spec }) });
    $("lab-note").textContent = `✓ saved "${spec.name}"`;
    labRefreshSaved();
  } catch (e) { $("lab-note").textContent = "✗ " + e.message; }
});
$("lab-load").addEventListener("click", async () => {
  const name = $("lab-saved").value;
  if (!name) return;
  const list = await api("/api/strategies").catch(() => []);
  const s = list.find((x) => x.name === name);
  if (s) { $("lab-spec").value = JSON.stringify(s, null, 2); $("lab-spec-box").open = true; $("lab-name").value = s.name; }
});
$("lab-del").addEventListener("click", async () => {
  const name = $("lab-saved").value;
  if (!name) return;
  if (!await confirmDialog({ title: `Delete strategy "${name}"?`, confirmText: "Delete" })) return;
  await api("/api/strategies/" + encodeURIComponent(name), { method: "DELETE" });
  labRefreshSaved();
});
// Live-signal flags on the selected saved strategy: ⚡ makes it a screener (alerts on
// fresh entry signals), 🎯 additionally turns each signal into a tracked recommendation.
async function labToggleFlag(flag) {
  const name = $("lab-saved").value;
  if (!name) { $("lab-flags").textContent = "select a saved strategy first"; return; }
  const list = await api("/api/strategies").catch(() => []);
  const s = list.find((x) => x.name === name);
  if (!s) return;
  s[flag] = !s[flag];
  if (flag === "signal_to_rec" && s.signal_to_rec) s.live = true;   // auto-rec implies live
  await api("/api/strategies", { method: "PUT", body: JSON.stringify({ spec: s }) });
  labShowFlags(s);
}
function labShowFlags(s) {
  $("lab-flags").textContent = s ? `${s.live ? "⚡ live" : "not live"}${s.signal_to_rec ? " · 🎯 auto-rec" : ""}` : "";
}
$("lab-live").addEventListener("click", () => labToggleFlag("live"));
$("lab-autorec").addEventListener("click", () => labToggleFlag("signal_to_rec"));
$("lab-saved").addEventListener("change", async () => {
  const list = await api("/api/strategies").catch(() => []);
  labShowFlags(list.find((x) => x.name === $("lab-saved").value));
});

/* ---------- charts ---------- */
let chart = null, candleSeries = null, volSeries = null, overlaySeries = [];
let planLines = [], pendingPlan = null;   // trade-plan price lines (entry/stop/targets)
let rsiChart = null, macdChart = null;
let curSymbol = "AAPL", curDays = 365, chartData = null;
const overlays = new Set();

function mkChart(el, h) {
  return LightweightCharts.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#7d8ea6" },
    grid: { vertLines: { color: "#141d30" }, horzLines: { color: "#141d30" } },
    rightPriceScale: { borderColor: "#1d2940" },
    timeScale: { borderColor: "#1d2940" },
    crosshair: { mode: 0 },
    autoSize: true,
  });
}
function ensureChart() {
  if (chart) return;
  chart = mkChart($("chart-main"));
  candleSeries = chart.addCandlestickSeries({ upColor: "#34d399", downColor: "#f87171", borderVisible: false, wickUpColor: "#34d399", wickDownColor: "#f87171" });
  // User-drawn levels: in ✏ mode, a click drops a horizontal line at that price.
  chart.subscribeClick((param) => {
    if (!drawMode || !param.point || !chartData) return;
    const price = candleSeries.coordinateToPrice(param.point.y);
    if (price == null || !isFinite(price)) return;
    const p = +Number(price).toFixed(price >= 100 ? 2 : 4);
    const saved = userLevels();
    saved.push(p);
    localStorage.setItem("adv_levels_" + curSymbol, JSON.stringify(saved));
    drawUserLevels();
  });
  loadChart(curSymbol);
}

/* ---------- chart tools: relative comparison + user-drawn levels ---------- */
let compareSeries = null, compareSym = null, drawMode = false, userLines = [];
const userLevels = () => { try { return JSON.parse(localStorage.getItem("adv_levels_" + curSymbol)) || []; } catch (_) { return []; } };
function drawUserLevels() {
  userLines.forEach((l) => { try { candleSeries.removePriceLine(l); } catch (_) {} });
  userLines = userLevels().map((p) =>
    candleSeries.createPriceLine({ price: p, color: "#fbbf24", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "level" }));
}
// Compare mode: overlay another symbol's closes and flip the price scale to PERCENT so
// both series read as relative performance from the visible start.
async function setCompare(sym) {
  if (compareSeries) { try { chart.removeSeries(compareSeries); } catch (_) {} compareSeries = null; }
  compareSym = (sym || "").toUpperCase().trim() || null;
  const PSM = (window.LightweightCharts && LightweightCharts.PriceScaleMode) || { Normal: 0, Percentage: 2 };
  if (!compareSym) {
    chart.priceScale("right").applyOptions({ mode: PSM.Normal });
    $("chart-compare").value = "";
    return;
  }
  try {
    const d = await api(`/api/chart/${encodeURIComponent(compareSym)}?days=${curDays}`);
    compareSeries = chart.addLineSeries({ color: "#e879f9", lineWidth: 1.6, priceLineVisible: false, title: d.display || compareSym });
    compareSeries.setData(d.candles.map((c) => ({ time: c.time, value: c.close })));
    chart.priceScale("right").applyOptions({ mode: PSM.Percentage });
    $("chart-info").textContent += ` · vs ${d.display || compareSym} (% scale)`;
  } catch (e) {
    compareSym = null;
    chart.priceScale("right").applyOptions({ mode: PSM.Normal });
    $("chart-info").textContent = "⚠ compare failed — " + e.message;
  }
}
$("chart-compare").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  setCompare($("chart-compare").value);
});
$("chart-drawline").addEventListener("click", () => {
  drawMode = !drawMode;
  $("chart-drawline").classList.toggle("on", drawMode);
  $("chart-main").style.cursor = drawMode ? "crosshair" : "";
});
$("chart-clearlines").addEventListener("click", () => {
  localStorage.removeItem("adv_levels_" + curSymbol);
  drawUserLevels();
});

/* ---------- projection cone (predictive analysis) ---------- */
// Quantile bands from realized volatility, drawn beyond the last candle. The bands
// WIDEN with the horizon by design — this is a probability range, not a forecast.
let predSeries = [];
function predOptions() {
  const intraday = curDays <= 10;
  const opts = intraday ? ["1h", "4h", "1d"] : ["1w", "1m", "3m", "6m", "1y"];
  $("pred-h").innerHTML = '<option value="">🔮 cone…</option>' + opts.map((h) => `<option value="${h}">🔮 ${h}</option>`).join("");
}
function clearPrediction() {
  predSeries.forEach((s) => { try { chart.removeSeries(s); } catch (_) {} });
  predSeries = [];
}
$("pred-h").addEventListener("change", async () => {
  clearPrediction();
  const h = $("pred-h").value;
  if (!h || !chartData) return;
  try {
    const interval = curDays <= 10 ? "1h" : "1d";
    const cone = await api(`/api/predict/${encodeURIComponent(curSymbol)}?horizon=${h}&interval=${interval}`);
    const draw = (band, color, w, style) => {
      const s = chart.addLineSeries({ color, lineWidth: w, lineStyle: style ?? 0, priceLineVisible: false, lastValueVisible: false });
      s.setData(cone.bands[band]); predSeries.push(s);
    };
    draw("p10", "rgba(56,189,248,.35)", 1); draw("p90", "rgba(56,189,248,.35)", 1);
    draw("p25", "rgba(56,189,248,.65)", 1); draw("p75", "rgba(56,189,248,.65)", 1);
    draw("p50", "#fbbf24", 1.4, 2);
    $("chart-info").textContent = `${curSymbol} · 🔮 ${h} cone: p10 ${fmtP(cone.at_horizon.p10)} · median ${fmtP(cone.at_horizon.p50)} · p90 ${fmtP(cone.at_horizon.p90)} (80% range spans ${cone.band_width_pct}%) · vol ${cone.params.sigma_annual_pct}%/yr — probability range, not a forecast`;
  } catch (e) { $("chart-info").textContent = "⚠ cone failed — " + e.message; }
});

async function loadChart(symbol) {
  curSymbol = symbol.toUpperCase();
  $("chart-symbol").value = curSymbol;
  $("chart-info").textContent = "loading…";
  clearPrediction(); predOptions();          // cone is per-symbol/range — reset it
  try {
    chartData = await api(`/api/chart/${encodeURIComponent(curSymbol)}?days=${curDays}`);
  } catch (e) {
    // Fresh data unavailable -> BLANK chart (never leave old candles looking current).
    chartData = null;
    candleSeries.setData([]);
    clearOverlaySeries();
    drawPlan(null);
    if (rsiChart) { try { rsiChart.remove(); } catch (_) {} rsiChart = null; $("chart-rsi").hidden = true; }
    if (macdChart) { try { macdChart.remove(); } catch (_) {} macdChart = null; $("chart-macd").hidden = true; }
    $("chart-info").textContent = "⚠ no fresh data — " + e.message;
    return;
  }
  const { candles, latest } = chartData;
  candleSeries.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
  chart.timeScale().fitContent();
  drawPlan(pendingPlan);
  const lastBar = candles[candles.length - 1];
  const lastLabel = typeof lastBar.time === "string" ? lastBar.time : new Date(lastBar.time * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  $("chart-info").textContent = `${curSymbol} · ${fmtP(latest.price)} · RSI ${latest.rsi ?? "—"} · ${candles.length} bars · last bar ${lastLabel}`;
  drawOverlays();
  drawUserLevels();                              // restore saved levels for this symbol
  if (compareSym) setCompare(compareSym);        // re-fetch the comparison at the new symbol/range
}
// Draw a trade plan on the chart: entry zone (two dashed cyan lines), stop (red),
// targets (green). Cleared automatically when the symbol changes without a plan.
function drawPlan(plan) {
  planLines.forEach((l) => { try { candleSeries.removePriceLine(l); } catch (_) {} });
  planLines = [];
  if (!plan) return;
  const add = (price, color, title, style) => { if (price != null) planLines.push(candleSeries.createPriceLine({ price, color, lineWidth: 1.5, lineStyle: style ?? 2, axisLabelVisible: true, title })); };
  add(plan.entry_low, "#38bdf8", "entry low");
  add(plan.entry_high, "#38bdf8", "entry high");
  add(plan.entry, "#38bdf8", "entry", 0);
  add(plan.stop_loss, "#f87171", "stop", 0);
  (plan.targets || []).forEach((t, i) => add(t.price, "#34d399", `T${i + 1} (${t.sell_pct}%)`));
}

function clearOverlaySeries() {
  overlaySeries.forEach((s) => { try { chart.removeSeries(s); } catch (_) {} });
  overlaySeries = [];
  if (volSeries) { try { chart.removeSeries(volSeries); } catch (_) {} volSeries = null; }
}
function lineData(candles, arr) {
  const out = [];
  for (let i = 0; i < candles.length; i++) if (arr[i] != null) out.push({ time: candles[i].time, value: arr[i] });
  return out;
}
function drawOverlays() {
  if (!chartData) return;
  const { candles, series } = chartData;
  clearOverlaySeries();
  const addLine = (arr, color, w = 1.6) => { const s = chart.addLineSeries({ color, lineWidth: w, priceLineVisible: false, lastValueVisible: false }); s.setData(lineData(candles, arr)); overlaySeries.push(s); };

  if (overlays.has("sma") && series.sma_fast) { addLine(series.sma_fast, "#38bdf8"); addLine(series.sma_slow, "#a78bfa"); }
  if (overlays.has("ema") && series.ema) addLine(series.ema, "#fbbf24");
  if (overlays.has("bollinger") && series.bollinger) { addLine(series.bollinger.upper, "#64748b", 1); addLine(series.bollinger.mid, "#64748b", 1); addLine(series.bollinger.lower, "#64748b", 1); }
  if (overlays.has("vwap") && series.vwap) addLine(series.vwap, "#f472b6");
  if (overlays.has("volume")) {
    volSeries = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? "rgba(52,211,153,.45)" : "rgba(248,113,113,.45)" })));
  }

  // Sub-panes: RSI / MACD get their own small charts, time-synced to the main one.
  $("chart-rsi").hidden = !overlays.has("rsi");
  if (overlays.has("rsi") && series.rsi) {
    if (!rsiChart) rsiChart = mkChart($("chart-rsi"));
    rsiChart.timeScale().applyOptions({ visible: false });
    // wipe + redraw
    try { rsiChart.remove(); } catch (_) {}
    rsiChart = mkChart($("chart-rsi"));
    const s = rsiChart.addLineSeries({ color: "#38bdf8", lineWidth: 1.6 });
    s.setData(lineData(candles, series.rsi));
    s.createPriceLine({ price: 70, color: "#f87171", lineWidth: 1, lineStyle: 2, title: "70" });
    s.createPriceLine({ price: 30, color: "#34d399", lineWidth: 1, lineStyle: 2, title: "30" });
    rsiChart.timeScale().fitContent();
  } else if (rsiChart) { try { rsiChart.remove(); } catch (_) {} rsiChart = null; }

  $("chart-macd").hidden = !overlays.has("macd");
  if (overlays.has("macd") && series.macd) {
    if (macdChart) { try { macdChart.remove(); } catch (_) {} }
    macdChart = mkChart($("chart-macd"));
    const h = macdChart.addHistogramSeries({});
    h.setData(lineData(candles, series.macd.hist).map((p) => ({ ...p, color: p.value >= 0 ? "rgba(52,211,153,.6)" : "rgba(248,113,113,.6)" })));
    const l1 = macdChart.addLineSeries({ color: "#38bdf8", lineWidth: 1.4 }); l1.setData(lineData(candles, series.macd.line));
    const l2 = macdChart.addLineSeries({ color: "#fbbf24", lineWidth: 1.2 }); l2.setData(lineData(candles, series.macd.signal));
    macdChart.timeScale().fitContent();
  } else if (macdChart) { try { macdChart.remove(); } catch (_) {} macdChart = null; }
}

document.querySelectorAll("#overlay-chips .chip").forEach((c) => c.addEventListener("click", () => {
  const k = c.dataset.ov;
  overlays.has(k) ? overlays.delete(k) : overlays.add(k);
  c.classList.toggle("on", overlays.has(k));
  drawOverlays();
}));
document.querySelectorAll("#chart-range button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#chart-range button").forEach((x) => x.classList.toggle("active", x === b));
  curDays = Number(b.dataset.d); loadChart(curSymbol);
}));
function openChart(symbol, plan = null) {
  pendingPlan = plan;
  document.querySelector('[data-tab="charts"]').click();
  loadChart(symbol);
}
// symbol search with suggestions
let sugT = null;
$("chart-symbol").addEventListener("input", () => {
  clearTimeout(sugT);
  const q = $("chart-symbol").value.trim();
  if (q.length < 2) { $("sym-suggest").hidden = true; return; }
  sugT = setTimeout(async () => {
    try {
      const list = await api("/api/search?q=" + encodeURIComponent(q));
      $("sym-suggest").innerHTML = list.map((s) => `<div data-s="${esc(s.symbol)}"><span class="s">${esc(s.symbol)}</span>${esc(s.name)} <span class="hint">${esc(s.exchange)}</span></div>`).join("");
      $("sym-suggest").hidden = !list.length;
      $("sym-suggest").querySelectorAll("div").forEach((d) => d.addEventListener("mousedown", () => { $("sym-suggest").hidden = true; loadChart(d.dataset.s); }));
    } catch (_) {}
  }, 250);
});
$("chart-symbol").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("sym-suggest").hidden = true; pendingPlan = null; loadChart($("chart-symbol").value.trim()); } });
document.addEventListener("click", (e) => { if (!e.target.closest(".sym-search")) $("sym-suggest").hidden = true; });

/* ---------- settings ---------- */
let dbBadge = "…";
async function loadSettings() {
  const [s, dbc] = await Promise.all([api("/api/settings"), api("/api/db/config").catch(() => null)]);
  const root = $("settings-root");
  const strat = s.preferences.options.strategies;
  root.innerHTML = `
  <div class="sform" id="sf-ai">
    <h3>🤖 AI model</h3>
    <div class="hint">Pick a provider (or any custom OpenAI-compatible endpoint), then choose from its available models.</div>
    <div class="frow"><label>Provider</label><select id="ai-provider">
      <option value="ollama">Ollama (local)</option>
      <option value="openai">OpenAI</option>
      <option value="lmstudio">LM Studio (local)</option>
      <option value="custom">Custom endpoint…</option>
    </select></div>
    <div class="frow"><label>Endpoint URL</label><input type="text" id="ai-url" value="${esc(s.ai.base_url)}"></div>
    <div class="frow"><label>API key</label><input type="password" id="ai-key" value="${esc(s.ai.api_key)}" placeholder="required for OpenAI · empty for local"></div>
    <div class="frow"><label>Model</label>
      <select id="ai-model-sel" style="flex:1;min-width:120px"><option value="${esc(s.ai.model)}" selected>${esc(s.ai.model)}</option></select>
      <button class="ghost small" id="ai-models-load" title="Fetch the model list from the endpoint">↻ Load models</button></div>
    <div class="frow"><label></label><input type="text" id="ai-model" value="${esc(s.ai.model)}" placeholder="or type a model name manually"></div>
    <div class="frow"><label>Temperature</label><input type="number" class="short" id="ai-temp" step="0.1" min="0" max="2" value="${s.ai.temperature}">
      <label style="width:auto">Max tokens</label><input type="number" class="short" id="ai-maxtok" step="500" value="${s.ai.max_tokens}"></div>
    <div class="hint" style="margin-top:10px"><b>Per-task models</b> (optional): route heavy scan analysis and cheap tasks to different models. Empty = use the main model.</div>
    <div class="frow"><label>Scan / health model</label><input type="text" id="ai-tier-scan" value="${esc((s.ai.task_models && s.ai.task_models.scan) || "")}" placeholder="e.g. a stronger reasoning model"></div>
    <div class="frow"><label>Light-task model</label><input type="text" id="ai-tier-light" value="${esc((s.ai.task_models && s.ai.task_models.light) || "")}" placeholder="headline grading + briefing — fast/cheap is fine"></div>
    <div class="frow"><label>Scan batching</label><select id="ai-batching">
      <option value="single" ${s.ai.scan_batching === "single" || !s.ai.scan_batching ? "selected" : ""}>One call for the whole shortlist (default)</option>
      <option value="grouped" ${s.ai.scan_batching === "grouped" ? "selected" : ""}>Groups of ~4 (steadier on local models)</option>
      <option value="per_candidate" ${s.ai.scan_batching === "per_candidate" ? "selected" : ""}>One call per candidate (deepest, slowest)</option>
    </select></div>
    <div class="hint" style="margin-top:10px"><b>Failover</b> (optional): when the main endpoint hard-fails (network / 5xx / timeout), retry once here. Empty URL/key inherit the main settings.</div>
    <div class="frow check"><input type="checkbox" id="ai-fo-on" ${s.ai.failover && s.ai.failover.enabled ? "checked" : ""}><label for="ai-fo-on"><b>Enable failover</b></label></div>
    <div class="frow"><label>Failover URL</label><input type="text" id="ai-fo-url" value="${esc((s.ai.failover && s.ai.failover.base_url) || "")}" placeholder="empty = same endpoint"></div>
    <div class="frow"><label>Failover key</label><input type="password" id="ai-fo-key" value="${esc((s.ai.failover && s.ai.failover.api_key) || "")}" placeholder="empty = same key"></div>
    <div class="frow"><label>Failover model</label><input type="text" id="ai-fo-model" value="${esc((s.ai.failover && s.ai.failover.model) || "")}" placeholder="e.g. a cloud model as backup"></div>
    <div class="save-row"><button class="primary" id="save-ai">Save</button><button class="ghost" id="test-ai">Test connection</button>
      <button class="ghost" id="selftest-ai" title="Prove every AI pipeline (JSON contract, tool calling, scan, options, strategy compile) against the saved model — run after any model change">🧪 Test AI features</button><span id="note-ai"></span></div>
    <div id="selftest-results"></div>
  </div>

  <div class="sform" id="sf-db">
    <h3>🗄️ Database</h3>
    <div class="hint">Active: <b>${esc(dbc ? dbc.dialect_active : "?")}</b>. Changing dialect requires <code>./ADVISOR.sh --init-db</code> then <code>--restart</code>.</div>
    <div class="frow"><label>Dialect</label><select id="db-dialect">
      <option value="sqlite" ${dbc && dbc.dialect === "sqlite" ? "selected" : ""}>SQLite (zero setup)</option>
      <option value="mysql" ${dbc && dbc.dialect === "mysql" ? "selected" : ""}>MySQL</option></select></div>
    <div id="db-mysql" ${dbc && dbc.dialect === "mysql" ? "" : "hidden"}>
      <div class="frow"><label>Host</label><input type="text" id="db-host" value="${esc(dbc && dbc.mysql ? dbc.mysql.host : "127.0.0.1")}">
        <label style="width:auto">Port</label><input type="number" class="short" id="db-port" value="${dbc && dbc.mysql ? dbc.mysql.port : 3306}"></div>
      <div class="frow"><label>User</label><input type="text" id="db-user" value="${esc(dbc && dbc.mysql ? dbc.mysql.user : "advisor")}"></div>
      <div class="frow"><label>Password</label><input type="password" id="db-pass" value="${esc(dbc && dbc.mysql ? dbc.mysql.password : "")}"></div>
      <div class="frow"><label>Database</label><input type="text" id="db-name" value="${esc(dbc && dbc.mysql ? dbc.mysql.database : "investment_advisor")}"></div>
    </div>
    <div class="save-row"><button class="primary" id="save-db">Save</button>
      <button class="ghost" id="db-backup-now" title="Snapshot the database into data/backups/ right now">💾 Back up now</button><span id="note-db"></span></div>
    <div id="db-backups"></div>
  </div>

  <div class="sform" id="sf-prefs">
    <h3>🎯 Investment preferences</h3>
    <div class="frow check"><input type="checkbox" id="p-stocks" ${s.preferences.asset_classes.stocks ? "checked" : ""}><label for="p-stocks"><b>Stocks</b></label>
      <input type="checkbox" id="p-crypto" ${s.preferences.asset_classes.crypto ? "checked" : ""}><label for="p-crypto"><b>Crypto</b></label></div>
    <div class="frow"><label>Stock universe</label><select id="p-stock-uni">
      <option value="popular" ${s.preferences.stocks.universe === "popular" ? "selected" : ""}>Popular large caps (built-in)</option>
      <option value="custom" ${s.preferences.stocks.universe === "custom" ? "selected" : ""}>Only my custom list</option></select></div>
    <div class="frow"><label>Custom stocks</label><textarea id="p-stock-list" placeholder="AAPL, NVDA, TSLA…">${esc((s.preferences.stocks.custom_symbols || []).join(", "))}</textarea></div>
    <div class="frow"><label>Exclude stocks</label><textarea id="p-stock-excl" placeholder="never recommend these">${esc((s.preferences.stocks.exclude_symbols || []).join(", "))}</textarea></div>
    <div class="frow"><label>Crypto universe</label><select id="p-crypto-uni">
      <option value="top" ${s.preferences.crypto.universe === "top" ? "selected" : ""}>Top coins by market cap</option>
      <option value="custom" ${s.preferences.crypto.universe === "custom" ? "selected" : ""}>Only my custom list</option></select>
      <label style="width:auto">Top N</label><input type="number" class="short" id="p-crypto-n" min="5" max="100" value="${s.preferences.crypto.top_n}"></div>
    <div class="frow"><label>Custom crypto</label><textarea id="p-crypto-list" placeholder="bitcoin, ethereum, SOL…">${esc((s.preferences.crypto.custom_symbols || []).join(", "))}</textarea></div>
    <div class="frow"><label>Exclude crypto</label><textarea id="p-crypto-excl">${esc((s.preferences.crypto.exclude_symbols || []).join(", "))}</textarea></div>
    <div class="frow check"><input type="checkbox" id="p-shorts" ${s.preferences.risk.allow_shorts !== false ? "checked" : ""}><label for="p-shorts">Include <b>short ideas</b> (SELL-side recommendations) — untick for long ideas only</label></div>
    <div class="frow"><label>Risk tolerance</label><select id="p-risk">
      ${["conservative", "moderate", "aggressive"].map((r) => `<option ${s.preferences.risk.risk_tolerance === r ? "selected" : ""}>${r}</option>`).join("")}</select>
      <label style="width:auto">Max recs/scan</label><input type="number" class="short" id="p-maxrecs" min="1" max="15" value="${s.preferences.risk.max_recommendations_per_scan}"></div>
    <div class="frow"><label>Min confidence</label><input type="number" class="short" id="p-minconf" step="0.05" min="0" max="1" value="${s.preferences.risk.min_confidence}">
      <label style="width:auto">Min reward:risk</label><input type="number" class="short" id="p-minrr" step="0.1" min="0" value="${s.preferences.risk.min_risk_reward}"></div>
    <div class="frow"><label>Account size $</label><input type="number" class="short" id="p-account" step="500" min="0" value="${s.preferences.risk.account_size}">
      <label style="width:auto">Risk per trade %</label><input type="number" class="short" id="p-riskpct" step="0.25" min="0" max="100" value="${s.preferences.risk.risk_per_trade_pct}"></div>
    <div class="frow"><label>Earnings buffer (days)</label><input type="number" class="short" id="p-earnbuf" min="0" max="30" value="${s.preferences.risk.avoid_earnings_days}"><span class="hint">flag stock entries this close to earnings (0 = off)</span></div>
    <div class="frow check"><input type="checkbox" id="p-be" ${s.preferences.risk.stops.breakeven_after_target1 ? "checked" : ""}><label for="p-be">Suggest breakeven stop after target 1</label></div>
    <div class="frow check"><input type="checkbox" id="p-trail" ${s.preferences.risk.stops.atr_trailing ? "checked" : ""}><label for="p-trail">Suggest ATR trailing stop</label>
      <label style="width:auto">× ATR</label><input type="number" class="short" id="p-atrmult" step="0.5" min="1" max="6" value="${s.preferences.risk.stops.atr_multiple}"></div>
    <div class="save-row"><button class="primary" id="save-prefs">Save</button><span id="note-prefs"></span></div>
  </div>

  <div class="sform" id="sf-options">
    <h3>🧾 Options trading</h3>
    <div class="frow check"><input type="checkbox" id="o-enabled" ${s.preferences.options.enabled ? "checked" : ""}><label for="o-enabled"><b>Suggest options plays</b> (alongside stock ideas)</label></div>
    <div class="hint">Tick only the strategies you're comfortable trading:</div>
    ${Object.keys(strat).map((k) => `<div class="frow check"><input type="checkbox" id="o-${k}" ${strat[k] ? "checked" : ""}><label for="o-${k}">${k.replace(/_/g, " ")}</label></div>`).join("")}
    <div class="frow"><label>Max days to expiry</label><input type="number" class="short" id="o-dte" min="1" max="365" value="${s.preferences.options.max_dte}"></div>
    <div class="frow"><label>Guidance for AI</label><textarea id="o-notes" placeholder="e.g. small premium only, no earnings weeks">${esc(s.preferences.options.notes)}</textarea></div>
    <div class="save-row"><button class="primary" id="save-options">Save</button><span id="note-options"></span></div>
  </div>

  <div class="sform" id="sf-ind">
    <h3>📐 Technical indicators <span class="hint-inline">— all enabled ones feed the AI; charts draw only what you toggle</span></h3>
    ${indRow("rsi", s.indicators.rsi, ["period", "buy_below", "sell_above"])}
    ${indRow("macd", s.indicators.macd, ["fast", "slow", "signal"])}
    ${indRow("sma", s.indicators.sma, ["fast", "slow"])}
    ${indRow("ema", s.indicators.ema, ["period"])}
    ${indRow("bollinger", s.indicators.bollinger, ["period", "stddev"])}
    ${indRow("stochastic", s.indicators.stochastic, ["k", "d", "buy_below", "sell_above"])}
    ${indRow("atr", s.indicators.atr, ["period"])}
    ${indRow("adx", s.indicators.adx, ["period", "trend_min"])}
    ${indRow("obv", s.indicators.obv, [])}
    ${indRow("vwap", s.indicators.vwap, [])}
    <div class="save-row"><button class="primary" id="save-ind">Save</button><span id="note-ind"></span></div>
  </div>

  <div class="sform" id="sf-sched">
    <h3>⏰ Scanning & tracking</h3>
    <div class="frow check"><input type="checkbox" id="sc-on" ${s.schedule.scan_enabled ? "checked" : ""}><label for="sc-on"><b>Scheduled scans</b></label></div>
    <div class="frow"><label>Scan every (hours)</label><input type="number" class="short" id="sc-every" min="1" max="168" value="${s.schedule.scan_every_hours}">
      <label style="width:auto">Daily at hour</label><input type="number" class="short" id="sc-hour" min="0" max="23" value="${s.schedule.scan_at_hour}"></div>
    <div class="frow"><label>Track open trades (min)</label><input type="number" class="short" id="sc-trades" min="1" value="${s.schedule.track_open_trades_minutes}"></div>
    <div class="frow"><label>Track recs (min)</label><input type="number" class="short" id="sc-recs" min="5" value="${s.schedule.track_recommendations_minutes}"></div>
    <div class="frow"><label>Rec entry expiry (days)</label><input type="number" class="short" id="sc-expiry" min="1" value="${s.schedule.rec_expiry_days}"></div>
    <div class="frow"><label>Health checks (hours)</label><input type="number" class="short" id="sc-health" min="0" value="${s.schedule.health_check_hours}"><span class="hint">0 = manual only</span></div>
    <div class="frow check"><input type="checkbox" id="sc-brief" ${s.schedule.briefing_enabled ? "checked" : ""}><label for="sc-brief"><b>Daily AI briefing</b></label>
      <label style="width:auto">at hour</label><input type="number" class="short" id="sc-briefhour" min="0" max="23" value="${s.schedule.briefing_hour}"></div>
    <div class="frow check"><input type="checkbox" id="sc-backup" ${s.schedule.backup_enabled !== false ? "checked" : ""}><label for="sc-backup"><b>Daily database backup</b> <span class="hint">(SQLite → data/backups/)</span></label>
      <label style="width:auto">keep</label><input type="number" class="short" id="sc-backupkeep" min="1" max="60" value="${s.schedule.backup_keep ?? 14}"></div>
    <div class="frow check"><input type="checkbox" id="sc-weekly" ${s.schedule.weekly_review_enabled ? "checked" : ""}><label for="sc-weekly"><b>Weekly AI review</b> <span class="hint">(candid retrospective at briefing hour)</span></label>
      <label style="width:auto">on</label><select id="sc-weeklyday">${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => `<option value="${i}" ${(s.schedule.weekly_review_day ?? 0) === i ? "selected" : ""}>${d}</option>`).join("")}</select></div>
    <div class="save-row"><button class="primary" id="save-sched">Save</button><span id="note-sched"></span></div>
  </div>

  <div class="sform" id="sf-view">
    <h3>👁 View</h3>
    <div class="hint">Show or hide parts of the UI. Display-only — the AI's analysis, scanning, and tracking are never affected.</div>
    <div class="frow check vgroup"><b>Dashboard</b><span class="hint">(always shown)</span></div>
    ${Object.entries({ briefing: "Daily briefing", sentiment: "Market sentiment", success: "System success rate", latest_recs: "Latest recommendations", headlines: "Headlines", figures: "Notable figures", activity: "Activity" }).map(([k, label]) =>
      `<div class="frow check sub-check"><input type="checkbox" id="v-dash-${k}" ${s.view.dashboard[k] !== false ? "checked" : ""}><label for="v-dash-${k}">${label}</label></div>`).join("")}
    <div class="frow check vgroup"><input type="checkbox" id="v-tab-recommendations" ${s.view.tabs.recommendations !== false ? "checked" : ""}><label for="v-tab-recommendations"><b>Recommendations</b></label></div>
    <div class="frow check vgroup"><input type="checkbox" id="v-tab-charts" ${s.view.tabs.charts !== false ? "checked" : ""}><label for="v-tab-charts"><b>Charts</b></label></div>
    <div class="frow check vgroup"><input type="checkbox" id="v-tab-watchlist" ${s.view.tabs.watchlist !== false ? "checked" : ""}><label for="v-tab-watchlist"><b>Watchlist</b></label></div>
    <div class="frow check vgroup"><input type="checkbox" id="v-tab-trades" ${s.view.tabs.trades !== false ? "checked" : ""}><label for="v-tab-trades"><b>Trades</b></label></div>
    <div class="frow check vgroup"><input type="checkbox" id="v-tab-performance" ${s.view.tabs.performance !== false ? "checked" : ""}><label for="v-tab-performance"><b>Performance</b></label></div>
    ${Object.entries({ rec_performance: "Recommendation performance", your_trades: "Your trades", equity: "Equity curve", calibration: "Confidence calibration", backtest: "Threshold backtest", strategy_lab: "Strategy Lab", attribution: "Attribution" }).map(([k, label]) =>
      `<div class="frow check sub-check"><input type="checkbox" id="v-perf-${k}" ${s.view.performance[k] !== false ? "checked" : ""}><label for="v-perf-${k}">${label}</label></div>`).join("")}
    <div class="save-row"><button class="primary" id="save-view">Save</button><span id="note-view"></span></div>
  </div>

  <div class="sform" id="sf-notif">
    <h3>🔔 Notifications</h3>
    <div class="hint">How timing alerts (stop crossed, target hit, health verdicts) reach you.</div>
    <div class="frow check"><input type="checkbox" id="n-browser" ${s.notifications.browser ? "checked" : ""}><label for="n-browser"><b>Browser notifications</b> (while this page is open)</label></div>
    <div class="frow"><label>Webhook URL</label><input type="password" id="n-webhook" value="${esc(s.notifications.webhook_url)}" placeholder="ntfy.sh/your-topic · Discord · Slack webhook"></div>
    <div class="hint" style="margin:-4px 0 8px 160px">Free & easy: create a topic at ntfy.sh, put the URL here, install the ntfy app on your phone.</div>
    <div class="frow check"><input type="checkbox" id="n-stops" ${s.notifications.notify_on.stops_targets ? "checked" : ""}><label for="n-stops">stops & targets</label>
      <input type="checkbox" id="n-sugg" ${s.notifications.notify_on.stop_suggestions ? "checked" : ""}><label for="n-sugg">stop suggestions</label>
      <input type="checkbox" id="n-health" ${s.notifications.notify_on.health ? "checked" : ""}><label for="n-health">health verdicts</label>
      <input type="checkbox" id="n-scans" ${s.notifications.notify_on.scans ? "checked" : ""}><label for="n-scans">scans & new recs</label>
      <input type="checkbox" id="n-brief" ${s.notifications.notify_on.briefing ? "checked" : ""}><label for="n-brief">daily briefing</label>
      <input type="checkbox" id="n-custom" ${s.notifications.notify_on.custom_alerts !== false ? "checked" : ""}><label for="n-custom">custom alert rules</label></div>
    <div class="frow check"><input type="checkbox" id="n-quiet" ${s.notifications.quiet_hours && s.notifications.quiet_hours.enabled ? "checked" : ""}><label for="n-quiet"><b>Quiet hours</b> <span class="hint">(webhooks pause; crossed stops still break through)</span></label>
      <label style="width:auto">from</label><input type="number" class="short" id="n-quiet-start" min="0" max="23" value="${(s.notifications.quiet_hours && s.notifications.quiet_hours.start_hour) ?? 22}">
      <label style="width:auto">to</label><input type="number" class="short" id="n-quiet-end" min="0" max="23" value="${(s.notifications.quiet_hours && s.notifications.quiet_hours.end_hour) ?? 7}"></div>
    <div class="save-row"><button class="primary" id="save-notif">Save</button><button class="ghost" id="test-notif">Send test</button><span id="note-notif"></span></div>
    <div class="hint" style="margin-top:14px"><b>Alert rules</b> — "tell me when…", evaluated every ~5 minutes. Delivery <i>digest</i> folds hits into the daily briefing instead of buzzing. (The advisor can manage these too: "ping me if BTC breaks 70k".)</div>
    <div id="rules-list"></div>
    <div class="frow" style="margin-top:6px">
      <select id="rule-type">
        <option value="price_above">price above</option>
        <option value="price_below">price below</option>
        <option value="pct_move_day">daily move &gt; %</option>
        <option value="rec_entry_zone">rec enters entry zone</option>
        <option value="earnings_upcoming">earnings upcoming (positions)</option>
        <option value="macro_event_soon">macro event soon</option>
        <option value="figure_filing">figure files a trade</option>
        <option value="portfolio_drawdown">portfolio drawdown &gt; %</option>
        <option value="provider_degraded">data source degraded</option>
        <option value="headline_mention">headline mentions…</option>
      </select>
      <span id="rule-params"></span>
      <button id="rule-add" class="ghost">＋ Add rule</button>
      <span class="hint" id="rules-note"></span>
    </div>
  </div>

  <div class="sform" id="sf-prov">
    <h3>📡 Data feeds</h3>
    <div class="frow"><label>News RSS feeds<br><span class="hint">one per line</span></label><textarea id="pr-feeds" style="min-height:110px">${esc((s.providers.news_feeds || []).join("\n"))}</textarea></div>
    <div class="frow"><label>FMP key</label><input type="password" id="pr-fmp" value="${esc(s.providers.fmp_key)}" placeholder="free key — stock candles + quotes + congress trades"></div>
    <div class="hint" style="margin:-4px 0 8px 160px">Congressional trades need a free key from financialmodelingprep.com (keyless sources block servers).</div>
    <div class="frow"><label>Alpha Vantage key</label><input type="password" id="pr-av" value="${esc(s.providers.alpha_vantage_key)}" placeholder="optional"></div>
    <div class="frow"><label>Finnhub key</label><input type="password" id="pr-fh" value="${esc(s.providers.finnhub_key)}" placeholder="free key — primary stock quotes (60/min)"></div>
    <div class="hint" style="margin:-4px 0 8px 160px">Recommended: free FMP + Finnhub keys make stock data independent of Yahoo (which throttles hard). Crypto needs no keys.</div>
    <div class="save-row"><button class="primary" id="save-prov">Save</button><span id="note-prov"></span></div>
  </div>`;

  // --- wire saves ---
  const note = (id, msg, ok = true) => { const el = $(id); el.className = ok ? "saved-note" : "err-note"; el.textContent = msg; setTimeout(() => { el.textContent = ""; }, 4000); };
  const listOf = (v) => v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

  // Provider presets fill the endpoint URL; "custom" leaves it alone.
  const AI_PRESETS = { ollama: "http://localhost:11434/v1", openai: "https://api.openai.com/v1", lmstudio: "http://localhost:1234/v1" };
  const urlToProvider = (u) => /openai\.com/.test(u) ? "openai" : /:11434/.test(u) ? "ollama" : /:1234/.test(u) ? "lmstudio" : "custom";
  $("ai-provider").value = urlToProvider(s.ai.base_url);
  $("ai-provider").addEventListener("change", () => {
    const p = $("ai-provider").value;
    if (AI_PRESETS[p]) $("ai-url").value = AI_PRESETS[p];
    loadAiModels();   // repopulate the dropdown from the new endpoint
  });
  // Model dropdown <-> manual text field stay in sync (dropdown wins on selection).
  $("ai-model-sel").addEventListener("change", () => { $("ai-model").value = $("ai-model-sel").value; });
  async function loadAiModels() {
    const sel = $("ai-model-sel");
    sel.innerHTML = "<option>loading…</option>";
    try {
      const r = await api("/api/ai/models", { method: "POST", body: JSON.stringify({ base_url: $("ai-url").value.trim(), api_key: $("ai-key").value }) });
      const cur = $("ai-model").value.trim();
      sel.innerHTML = r.models.map((m) => `<option value="${esc(m)}" ${m === cur ? "selected" : ""}>${esc(m)}</option>`).join("") || `<option value="">(no models found)</option>`;
      if (!r.models.includes(cur) && cur) sel.insertAdjacentHTML("afterbegin", `<option value="${esc(cur)}" selected>${esc(cur)} (current)</option>`);
      note("note-ai", `✓ ${r.models.length} model(s) available`);
    } catch (e) {
      sel.innerHTML = `<option value="${esc($("ai-model").value)}" selected>${esc($("ai-model").value)}</option>`;
      note("note-ai", "couldn't list models: " + e.message, false);
    }
  }
  $("ai-models-load").addEventListener("click", loadAiModels);
  loadAiModels();   // auto-populate on opening Settings
  $("save-ai").addEventListener("click", async () => {
    try {
      await api("/api/settings/ai", { method: "PUT", body: JSON.stringify({
        base_url: $("ai-url").value.trim(), api_key: $("ai-key").value, model: $("ai-model").value.trim(),
        temperature: Number($("ai-temp").value), max_tokens: Number($("ai-maxtok").value),
        task_models: { scan: $("ai-tier-scan").value.trim(), light: $("ai-tier-light").value.trim() },
        scan_batching: $("ai-batching").value,
        failover: { enabled: $("ai-fo-on").checked, base_url: $("ai-fo-url").value.trim(), api_key: $("ai-fo-key").value, model: $("ai-fo-model").value.trim() },
      }) });
      note("note-ai", "Saved ✓");
    } catch (e) { note("note-ai", e.message, false); }
  });
  // AI live self-test: exercises the real pipelines in miniature against the SAVED model.
  $("selftest-ai").addEventListener("click", async () => {
    const btn = $("selftest-ai");
    btn.disabled = true;
    $("selftest-results").innerHTML = '<div class="hint">Running the AI pipelines against your saved model… (slow local models can take a few minutes)</div>';
    try {
      const r = await api("/api/ai/selftest", { method: "POST" });
      $("selftest-results").innerHTML = `
        <div class="hint" style="margin:6px 0"><b>${r.summary.passed}/${r.summary.total} passed</b> — ${esc(r.summary.verdict)}${r.aborted ? " · ⚠ " + esc(r.aborted) : ""}</div>
        <table class="grid"><thead><tr><th>Check</th><th></th><th>Time</th><th>Detail</th></tr></thead>
        <tbody>${r.results.map((t) => `<tr>
          <td>${esc(t.name)}</td>
          <td>${t.ok ? '<span class="up">✓</span>' : '<span class="down">✗</span>'}</td>
          <td class="mono hint">${(t.ms / 1000).toFixed(1)}s</td>
          <td class="hint">${esc(t.ok ? t.note : t.error)}</td></tr>`).join("")}</tbody></table>`;
    } catch (e) { $("selftest-results").innerHTML = `<div class="err-state">⚠ ${esc(e.message)}</div>`; }
    finally { btn.disabled = false; }
  });
  $("test-ai").addEventListener("click", async () => {
    note("note-ai", "testing…");
    try {
      const r = await api("/api/ai/test", { method: "POST", body: JSON.stringify({ base_url: $("ai-url").value.trim(), api_key: $("ai-key").value, model: $("ai-model").value.trim() }) });
      note("note-ai", `✓ ${r.model} replied: "${r.reply}"`);
    } catch (e) { note("note-ai", "✗ " + e.message, false); }
  });
  $("db-dialect").addEventListener("change", () => { $("db-mysql").hidden = $("db-dialect").value !== "mysql"; });
  $("db-backup-now").addEventListener("click", async () => {
    note("note-db", "backing up…");
    try {
      const r = await api("/api/db/backup", { method: "POST" });
      note("note-db", r.skipped ? r.note : `✓ ${r.file} (${Math.round(r.size_bytes / 1024)} KB, ${r.backups_kept} kept)`);
      loadDbBackups();
    } catch (e) { note("note-db", "✗ " + e.message, false); }
  });
  // Backups list + one-click verified restore (current DB snapshotted first).
  async function loadDbBackups() {
    try {
      const d = await api("/api/db/backups?verify=1");
      if (d.dialect !== "sqlite" || !(d.backups || []).length) { $("db-backups").innerHTML = ""; return; }
      $("db-backups").innerHTML = `<div class="hint" style="margin-top:8px"><b>Backups</b> — each verified with a SQLite integrity check; Restore snapshots the current database first.</div>
        <table class="grid"><thead><tr><th>Backup</th><th>Size</th><th>Integrity</th><th></th></tr></thead>
        <tbody>${d.backups.map((b) => `<tr>
          <td class="mono">${esc(b.file)}</td>
          <td class="hint">${Math.round(b.size_bytes / 1024)} KB</td>
          <td>${b.verified ? '<span class="up">✓ ok</span>' : '<span class="down">✗ FAILED</span>'}</td>
          <td>${b.verified ? `<button class="ghost small" data-restore="${esc(b.file)}">↩ Restore</button>` : ""}</td></tr>`).join("")}</tbody></table>`;
      document.querySelectorAll("[data-restore]").forEach((btn) => btn.addEventListener("click", async () => {
        const file = btn.dataset.restore;
        if (!await confirmDialog({
          title: "Restore " + file + "?",
          message: "The CURRENT database (all trades, recommendations, settings) is snapshotted first, then <b>replaced</b> by this backup. The page reloads afterward; a restart is recommended.",
          confirmText: "Restore backup",
        })) return;
        note("note-db", "restoring…");
        try {
          const r = await api("/api/db/restore", { method: "POST", body: JSON.stringify({ file }) });
          note("note-db", `✓ restored (pre-restore snapshot: ${r.pre_restore_snapshot}) — reloading…`);
          setTimeout(() => location.reload(), 1800);
        } catch (e) { note("note-db", "✗ " + e.message, false); }
      }));
    } catch (_) { $("db-backups").innerHTML = ""; }
  }
  loadDbBackups();
  $("save-db").addEventListener("click", async () => {
    try {
      const body = { dialect: $("db-dialect").value };
      if (body.dialect === "mysql") body.mysql = { host: $("db-host").value.trim(), port: Number($("db-port").value), user: $("db-user").value.trim(), password: $("db-pass").value, database: $("db-name").value.trim() };
      const r = await api("/api/db/config", { method: "PUT", body: JSON.stringify(body) });
      note("note-db", r.note || "Saved ✓");
    } catch (e) { note("note-db", e.message, false); }
  });
  $("save-prefs").addEventListener("click", async () => {
    try {
      await api("/api/settings/preferences", { method: "PUT", body: JSON.stringify({
        asset_classes: { stocks: $("p-stocks").checked, crypto: $("p-crypto").checked },
        stocks: { universe: $("p-stock-uni").value, custom_symbols: listOf($("p-stock-list").value), exclude_symbols: listOf($("p-stock-excl").value) },
        crypto: { universe: $("p-crypto-uni").value, top_n: Number($("p-crypto-n").value), custom_symbols: listOf($("p-crypto-list").value), exclude_symbols: listOf($("p-crypto-excl").value) },
        risk: {
          risk_tolerance: $("p-risk").value, allow_shorts: $("p-shorts").checked, max_recommendations_per_scan: Number($("p-maxrecs").value),
          min_confidence: Number($("p-minconf").value), min_risk_reward: Number($("p-minrr").value),
          account_size: Number($("p-account").value), risk_per_trade_pct: Number($("p-riskpct").value),
          avoid_earnings_days: Number($("p-earnbuf").value),
          stops: { breakeven_after_target1: $("p-be").checked, atr_trailing: $("p-trail").checked, atr_multiple: Number($("p-atrmult").value) },
        },
        options: curOptions(),
      }) });
      note("note-prefs", "Saved ✓");
      loadAppSettings();   // refresh the sizing math
    } catch (e) { note("note-prefs", e.message, false); }
  });
  const curOptions = () => ({
    enabled: $("o-enabled").checked,
    strategies: Object.fromEntries(Object.keys(strat).map((k) => [k, $("o-" + k).checked])),
    max_dte: Number($("o-dte").value), notes: $("o-notes").value,
  });
  $("save-options").addEventListener("click", async () => {
    try {
      const cur = await api("/api/settings");
      await api("/api/settings/preferences", { method: "PUT", body: JSON.stringify({ ...stripMask(cur.preferences), options: curOptions() }) });
      note("note-options", "Saved ✓");
    } catch (e) { note("note-options", e.message, false); }
  });
  const stripMask = (o) => JSON.parse(JSON.stringify(o));
  $("save-ind").addEventListener("click", async () => {
    try {
      const body = {};
      document.querySelectorAll("#sf-ind .ind-row").forEach((row) => {
        const k = row.dataset.ind;
        body[k] = { enabled: row.querySelector("input[type=checkbox]").checked };
        row.querySelectorAll("input[data-p]").forEach((inp) => { body[k][inp.dataset.p] = Number(inp.value); });
      });
      await api("/api/settings/indicators", { method: "PUT", body: JSON.stringify(body) });
      note("note-ind", "Saved ✓");
    } catch (e) { note("note-ind", e.message, false); }
  });
  $("save-sched").addEventListener("click", async () => {
    try {
      await api("/api/settings/schedule", { method: "PUT", body: JSON.stringify({
        scan_enabled: $("sc-on").checked, scan_every_hours: Number($("sc-every").value), scan_at_hour: Number($("sc-hour").value),
        track_open_trades_minutes: Number($("sc-trades").value), track_recommendations_minutes: Number($("sc-recs").value),
        rec_expiry_days: Number($("sc-expiry").value), health_check_hours: Number($("sc-health").value),
        briefing_enabled: $("sc-brief").checked, briefing_hour: Number($("sc-briefhour").value),
        backup_enabled: $("sc-backup").checked, backup_keep: Number($("sc-backupkeep").value) || 14,
        weekly_review_enabled: $("sc-weekly").checked, weekly_review_day: Number($("sc-weeklyday").value) || 0,
      }) });
      note("note-sched", "Saved ✓");
    } catch (e) { note("note-sched", e.message, false); }
  });
  $("save-view").addEventListener("click", async () => {
    try {
      const pick = (prefix, keysList) => Object.fromEntries(keysList.map((k) => [k, $(prefix + k).checked]));
      await api("/api/settings/view", { method: "PUT", body: JSON.stringify({
        tabs: pick("v-tab-", ["recommendations", "charts", "watchlist", "trades", "performance"]),
        dashboard: pick("v-dash-", ["briefing", "sentiment", "success", "latest_recs", "headlines", "figures", "activity"]),
        performance: pick("v-perf-", ["rec_performance", "your_trades", "equity", "calibration", "backtest", "strategy_lab", "attribution"]),
      }) });
      await loadAppSettings(); applyView();
      note("note-view", "Saved ✓ — view updated");
    } catch (e) { note("note-view", e.message, false); }
  });
  $("save-notif").addEventListener("click", async () => {
    try {
      await api("/api/settings/notifications", { method: "PUT", body: JSON.stringify({
        quiet_hours: { enabled: $("n-quiet").checked, start_hour: Number($("n-quiet-start").value), end_hour: Number($("n-quiet-end").value) },
        browser: $("n-browser").checked, webhook_url: $("n-webhook").value,
        notify_on: { stops_targets: $("n-stops").checked, stop_suggestions: $("n-sugg").checked, health: $("n-health").checked, scans: $("n-scans").checked, briefing: $("n-brief").checked, custom_alerts: $("n-custom").checked },
      }) });
      if ($("n-browser").checked && window.Notification && Notification.permission === "default") Notification.requestPermission();
      note("note-notif", "Saved ✓"); loadAppSettings();
    } catch (e) { note("note-notif", e.message, false); }
  });
  // --- alert-rules editor ("tell me when…") ---
  const RULE_FIELDS = {
    price_above: [["symbol", "text", "BTC-USD / NVDA"], ["level", "number", "level"]],
    price_below: [["symbol", "text", "BTC-USD / NVDA"], ["level", "number", "level"]],
    pct_move_day: [["scope", "select", "positions,watchlist,symbol"], ["symbol", "text", "symbol (if scope=symbol)"], ["threshold", "number", "%"]],
    rec_entry_zone: [],
    earnings_upcoming: [["days", "number", "days"]],
    macro_event_soon: [["days", "number", "days"]],
    figure_filing: [["name", "text", "e.g. Pelosi"]],
    portfolio_drawdown: [["threshold_pct", "number", "%"]],
    provider_degraded: [],
    headline_mention: [["scope", "select", "positions,watchlist,symbol"], ["symbol", "text", "symbol (if scope=symbol)"]],
  };
  let rulesCache = [];
  function renderRuleParams() {
    const t = $("rule-type").value;
    $("rule-params").innerHTML = (RULE_FIELDS[t] || []).map(([k, kind, ph]) =>
      kind === "select"
        ? `<select data-rp="${k}">${ph.split(",").map((o) => `<option>${o}</option>`).join("")}</select>`
        : `<input data-rp="${k}" type="${kind}" step="any" placeholder="${ph}" class="short-in" style="width:140px">`
    ).join(" ");
  }
  async function loadRules() {
    try {
      const d = await api("/api/alerts");
      rulesCache = d.rules || [];
      $("rules-list").innerHTML = rulesCache.length ? `<table class="grid"><thead><tr><th>Rule</th><th>On</th><th>Delivery</th><th>Cooldown (min)</th><th></th></tr></thead>
        <tbody>${rulesCache.map((r, i) => `<tr>
          <td>${esc(r.label || r.type)}</td>
          <td><input type="checkbox" data-ren="${i}" ${r.enabled !== false ? "checked" : ""}></td>
          <td><select data-rdel="${i}"><option ${r.delivery !== "digest" ? "selected" : ""}>instant</option><option ${r.delivery === "digest" ? "selected" : ""}>digest</option></select></td>
          <td><input type="number" data-rcd="${i}" class="short" value="${r.cooldown_min}"></td>
          <td><button class="ghost small" data-rx="${i}" title="Delete rule">✖</button></td></tr>`).join("")}</tbody></table>`
        : '<div class="hint">No rules yet — add one below, or ask the advisor.</div>';
      const push = async () => {
        try { await api("/api/alerts", { method: "PUT", body: JSON.stringify({ rules: rulesCache }) }); note("rules-note", "Saved ✓"); }
        catch (e) { note("rules-note", e.message, false); }
        loadRules();
      };
      document.querySelectorAll("[data-rx]").forEach((b) => b.addEventListener("click", () => { rulesCache.splice(Number(b.dataset.rx), 1); push(); }));
      document.querySelectorAll("[data-ren]").forEach((b) => b.addEventListener("change", () => { rulesCache[Number(b.dataset.ren)].enabled = b.checked; push(); }));
      document.querySelectorAll("[data-rdel]").forEach((b) => b.addEventListener("change", () => { rulesCache[Number(b.dataset.rdel)].delivery = b.value; push(); }));
      document.querySelectorAll("[data-rcd]").forEach((b) => b.addEventListener("change", () => { rulesCache[Number(b.dataset.rcd)].cooldown_min = Number(b.value) || 240; push(); }));
    } catch (_) {}
  }
  $("rule-type").addEventListener("change", renderRuleParams);
  renderRuleParams();
  $("rule-add").addEventListener("click", async () => {
    const params = {};
    document.querySelectorAll("[data-rp]").forEach((el) => { if (el.value !== "") params[el.dataset.rp] = el.type === "number" ? Number(el.value) : el.value; });
    try {
      rulesCache.push({ type: $("rule-type").value, params });
      await api("/api/alerts", { method: "PUT", body: JSON.stringify({ rules: rulesCache }) });
      note("rules-note", "Rule added ✓");
    } catch (e) { rulesCache.pop(); note("rules-note", e.message, false); }
    loadRules();
  });
  loadRules();

  $("test-notif").addEventListener("click", async () => {
    note("note-notif", "sending…");
    try {
      const r = await api("/api/notify/test", { method: "POST", body: JSON.stringify({ webhook_url: $("n-webhook").value }) });
      note("note-notif", r.ok ? (r.note || "✓ webhook delivered") : "✗ webhook failed — check the URL (not saved)", r.ok);
      if ($("n-browser").checked && window.Notification) {
        if (Notification.permission === "default") await Notification.requestPermission();
        if (Notification.permission === "granted") new Notification("Investment Advisor", { body: "🔔 Browser notifications work." });
      }
    } catch (e) { note("note-notif", "✗ " + e.message, false); }
  });
  $("save-prov").addEventListener("click", async () => {
    try {
      await api("/api/settings/providers", { method: "PUT", body: JSON.stringify({
        news_feeds: $("pr-feeds").value.split("\n").map((x) => x.trim()).filter(Boolean),
        alpha_vantage_key: $("pr-av").value, finnhub_key: $("pr-fh").value, fmp_key: $("pr-fmp").value,
      }) });
      note("note-prov", "Saved ✓");
    } catch (e) { note("note-prov", e.message, false); }
  });
}
function indRow(key, cfg, params) {
  return `<div class="ind-row" data-ind="${key}">
    <input type="checkbox" ${cfg.enabled ? "checked" : ""}>
    <span class="nm">${key.toUpperCase()}</span>
    <span class="ind-params">${params.map((p) => `<label>${p.replace(/_/g, " ")}</label><input type="number" step="any" data-p="${p}" value="${cfg[p]}">`).join("")}</span>
  </div>`;
}

/* ---------- advisor chat drawer ---------- */
const chatDrawer = $("chat-drawer"), chatMsgs = $("chat-msgs"), chatText = $("chat-text");
let chatHistory = JSON.parse(localStorage.getItem("advisor_chat") || "[]");   // [{role, content}]
let chatBusy = false;

function chatOpen() {
  chatDrawer.classList.add("open"); $("drawer-backdrop").hidden = false;
  if (!chatMsgs.childElementCount) {
    if (chatHistory.length) chatHistory.forEach((m) => renderMsg(m.role === "user" ? "user" : "ai", m.content));
    else renderMsg("ai", "Hi — I'm your advisor. I can see **everything this tool sees**: live quotes, technical analysis with *your* thresholds, the recommendation log and its track record, your trades and P&L, news, sentiment, and smart-money data.\n\nAsk me anything about the market or your positions — or type `/help` for commands and example questions.");
  }
  chatText.focus();
}
function chatClose() { chatDrawer.classList.remove("open"); $("drawer-backdrop").hidden = true; }
$("chat-btn").addEventListener("click", chatOpen);
$("chat-close").addEventListener("click", chatClose);
// Dashboard "Ask the Advisor" prompt chips: open the drawer and send the question.
document.querySelectorAll("#card-advisor .chip").forEach((c) => c.addEventListener("click", () => {
  chatOpen();
  sendChat(c.dataset.q);
}));
$("drawer-backdrop").addEventListener("click", chatClose);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && chatDrawer.classList.contains("open")) chatClose(); });
$("chat-clear").addEventListener("click", () => { chatHistory = []; localStorage.removeItem("advisor_chat"); chatMsgs.innerHTML = ""; renderMsg("ai", "Conversation cleared. What shall we look at?"); });

// Markdown-lite: escape first, then bold/italic/code/headers. pre-wrap keeps lists/breaks.
function mdLite(text) {
  let t = esc(text);
  t = t.replace(/```([\s\S]*?)```/g, (_, c) => `<code>${c.trim()}</code>`);
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|\n)#{1,4}\s*([^\n]+)/g, '$1<span class="h">$2</span>');
  t = t.replace(/(^|\n)\s*[-*]\s/g, "$1 • ");
  return t;
}
function renderMsg(kind, text, extraClass = "") {
  const div = document.createElement("div");
  div.className = `cmsg ${kind} ${extraClass}`.trim();
  div.innerHTML = mdLite(text);
  chatMsgs.appendChild(div);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  return div;
}
function renderTrace(trace) {
  if (!trace || !trace.length) return;
  const div = document.createElement("div");
  div.className = "ctrace";
  div.innerHTML = trace.map((t) => `<span>🔧 ${esc(t.tool)}${t.args && t.args.symbol ? ":" + esc(t.args.symbol) : ""}</span>`).join("");
  chatMsgs.appendChild(div);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
}

// --- Slash commands: quick skills. Most expand into a rich prompt; a few act locally. ---
const HELP_TEXT = `# Advisor commands
\`/help\` — this help
\`/analyze SYMBOL\` — full technical read of a stock/crypto (e.g. \`/analyze NVDA\`)
\`/market\` — market overview: indexes, sentiment, headlines
\`/recs\` — review the current active recommendations
\`/portfolio\` — review your open trades vs their plans
\`/performance\` — the system's honest track record
\`/news [SYMBOL]\` — latest headlines (optionally for one symbol)
\`/whales\` — smart-money activity (congress trades, 13F filers)
\`/ideas\` — ask for fresh trade ideas within your preferences
\`/scan\` — launch a full market scan (background)
\`/clear\` — clear this conversation

# Example questions
• "What do you think of **AAPL** right now — worth an entry?"
• "Which of my open trades is closest to its stop?"
• "Is there anything oversold in my crypto universe?"
• "Why did the system recommend that last NVDA trade, and how did it play out?"
• "Given the fear index today, should I be cautious this week?"
• "Suggest an options play on MSFT within my comfort settings."

*Research tool — not financial advice. You decide; it analyzes.*`;

const SLASH = {
  help: () => { renderMsg("ai", HELP_TEXT, "help"); },
  clear: () => $("chat-clear").click(),
  scan: async () => {
    try { await api("/api/scan", { method: "POST" }); renderMsg("ai", "⚡ **Scan launched.** Results will appear in the Recommendations tab in a minute or two — ask me `/recs` after."); pollScan(); }
    catch (e) { renderMsg("ai", "Couldn't start a scan: " + e.message); }
  },
  analyze: (arg) => arg ? sendChat(`Give me a full technical analysis of ${arg.toUpperCase()}: pull the indicators and recent news, tell me where it stands against my thresholds, and whether an entry looks attractive (entry zone / stop / targets if so).`) : renderMsg("ai", "Usage: `/analyze SYMBOL` — stocks or crypto, e.g. `/analyze NVDA`, `/analyze BTC`, `/analyze solana`"),
  market: () => sendChat("Give me a market overview: index levels, stock & crypto sentiment gauges, and the headlines that matter today. Keep it tight."),
  recs: () => sendChat("Review the current active recommendations (open + tracking): status vs their entry zones and targets, and which still look valid right now."),
  portfolio: () => sendChat("Review my open trades: current price vs entry, distance to stop and next target, unrealized P&L, and anything that needs my attention."),
  performance: () => sendChat("How has the system performed? Give the honest track record — win rate, average outcome, and what it suggests about trusting these recommendations."),
  news: (arg) => sendChat(arg ? `What's in the news for ${arg.toUpperCase()}? Summarize what matters for the trade.` : "What are today's most market-moving headlines? Summarize the themes."),
  whales: () => sendChat("What's the smart money doing? Check congressional trades and recent 13F filers, and flag anything relevant to my universe."),
  ideas: () => sendChat("Scan your knowledge of my preferences, then propose 2-3 fresh trade ideas within them — full structure: entry zone, stop, laddered targets, horizon, confidence, and rationale grounded in current data."),
};

async function sendChat(text) {
  if (chatBusy) return;
  renderMsg("user", text);
  chatHistory.push({ role: "user", content: text });
  chatBusy = true; $("chat-send").disabled = true;
  let bubble = renderMsg("ai", "consulting the data<i>…</i>", "thinking");
  let streamedText = "", gotReply = false;
  try {
    // Streamed NDJSON: tokens render live; tool rounds show as chips.
    const resp = await fetch("/api/advisor-chat?stream=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: chatHistory.slice(-16) }) });
    if (!resp.ok || !resp.body) throw new Error((await resp.json().catch(() => ({}))).error || `${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "tools") {
          bubble.classList.add("thinking");
          bubble.innerHTML = mdLite("🔧 " + ev.tools.map((t) => t.tool + (t.args && t.args.symbol ? ":" + t.args.symbol : "")).join(" · ") + "<i>…</i>");
          streamedText = "";
        } else if (ev.type === "reset") { streamedText = ""; }
        else if (ev.type === "token") {
          streamedText += ev.text;
          bubble.classList.remove("thinking");
          bubble.innerHTML = mdLite(streamedText);
          chatMsgs.scrollTop = chatMsgs.scrollHeight;
        } else if (ev.type === "done") {
          gotReply = true;
          bubble.classList.remove("thinking");
          bubble.innerHTML = mdLite(ev.reply);
          bubble.insertAdjacentHTML("beforebegin", ev.trace && ev.trace.length ? `<div class="ctrace">${ev.trace.map((t) => `<span>🔧 ${esc(t.tool)}${t.args && t.args.symbol ? ":" + esc(t.args.symbol) : ""}</span>`).join("")}</div>` : "");
          chatHistory.push({ role: "assistant", content: ev.reply });
          localStorage.setItem("advisor_chat", JSON.stringify(chatHistory.slice(-40)));
        } else if (ev.type === "error") throw new Error(ev.error);
      }
    }
    if (!gotReply) throw new Error("stream ended without a reply");
  } catch (e) {
    bubble.classList.remove("thinking");
    bubble.innerHTML = mdLite("⚠ " + e.message + (/(LLM|endpoint)/i.test(e.message) ? " — check Settings → AI model." : ""));
    chatHistory.pop();   // failed turn doesn't pollute history
  } finally { chatBusy = false; $("chat-send").disabled = false; chatText.focus(); chatMsgs.scrollTop = chatMsgs.scrollHeight; }
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = chatText.value.trim();
  if (!raw) return;
  chatText.value = "";
  if (raw.startsWith("/")) {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const fn = SLASH[cmd.toLowerCase()];
    // Local commands render the raw command as the user bubble; prompt-expanding ones
    // let sendChat() render the expanded question instead (no double bubbles).
    if (fn) { if (["help", "scan", "clear"].includes(cmd.toLowerCase())) renderMsg("user", raw); fn(rest.join(" ")); return; }
    renderMsg("user", raw);
    renderMsg("ai", `Unknown command \`/${esc(cmd)}\` — type \`/help\` to see what I know.`);
    return;
  }
  sendChat(raw);
});
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chat-form").requestSubmit(); }
});

/* ---------- view visibility: user-chosen tabs/cards (display-only) ---------- */
const VIEW_MAP = {
  tabs: { recommendations: "recs", charts: "charts", watchlist: "watchlist", trades: "trades", performance: "performance" },
  dashboard: { briefing: "card-briefing", sentiment: "card-sentiment", success: "card-success", latest_recs: "card-latest", headlines: "card-news", figures: "card-figures", activity: "card-events" },
  performance: { rec_performance: "card-perf-recs", your_trades: "card-perf-trades", equity: "card-perf-equity", calibration: "card-perf-cal", backtest: "card-perf-bt", strategy_lab: "card-perf-lab", attribution: "card-perf-attr" },
};
function applyView() {
  const v = appSettings && appSettings.view;
  if (!v) return;
  for (const [key, tabName] of Object.entries(VIEW_MAP.tabs)) {
    const btn = document.querySelector(`#tabs .tab[data-tab="${tabName}"]`);
    if (btn) btn.style.display = v.tabs[key] === false ? "none" : "";
    // If the currently-active tab was just hidden, land back on the dashboard.
    if (v.tabs[key] === false && btn && btn.classList.contains("active"))
      document.querySelector('#tabs .tab[data-tab="dashboard"]').click();
  }
  for (const group of ["dashboard", "performance"]) {
    for (const [key, id] of Object.entries(VIEW_MAP[group])) {
      const el = $(id);
      if (el) el.style.display = (v[group] && v[group][key] === false) ? "none" : "";
    }
  }
}

/* ---------- events: ONE poll loop feeds the activity feed AND desktop alerts ----------
   (previously two independent intervals each fetched /api/events; consolidated so the
   dashboard activity also stays live between visits instead of only refreshing on load) */
const ALERT_TYPES = new Set(["stop_hit", "target_hit", "entry_hit", "stop_suggest", "health"]);
let lastEventId = Number(localStorage.getItem("advisor_last_event") || 0);
async function refreshEvents() {
  let evs;
  try { evs = await api("/api/events?limit=20"); } catch (_) { return; }
  // Dashboard activity feed — render whenever the dashboard is on screen.
  if ($("panel-dashboard").classList.contains("active") && !document.hidden)
    $("dash-events").innerHTML = evs.slice(0, 12).map((e) => `<div class="ev"><span class="t">${ago(e.at)}</span>${esc(e.message)}</div>`).join("") || '<div class="hint">Nothing yet.</div>';
  // Desktop notifications for new alert-worthy events (while enabled + permitted).
  if (appSettings && appSettings.notifications && appSettings.notifications.browser &&
      window.Notification && Notification.permission === "granted") {
    const fresh = evs.filter((e) => e.id > lastEventId && ALERT_TYPES.has(e.type));
    if (lastEventId > 0) {
      for (const e of fresh.slice(0, 5)) new Notification("Investment Advisor" + (e.symbol ? " · " + e.symbol : ""), { body: e.message, tag: "adv-" + e.id });
    }
    if (evs.length) { lastEventId = Math.max(lastEventId, ...evs.map((e) => e.id)); localStorage.setItem("advisor_last_event", String(lastEventId)); }
  }
}

/* ---------- boot ---------- */
(async () => {
  try {
    const dbc = await api("/api/db/config");
    dbBadge = "db: " + dbc.dialect_active;
    $("db-badge").textContent = dbBadge;
  } catch (_) {}
  await loadAppSettings();          // risk numbers for position-sizing math
  applyView();                      // user-chosen tab/card visibility
  loadDashboard();
  pollScan();                       // reflects an in-flight scheduled scan on load
  setInterval(loadMarketStrip, 5 * 60 * 1000);   // keep the strip fresh
  if (appSettings && appSettings.notifications && appSettings.notifications.browser &&
      window.Notification && Notification.permission === "default") Notification.requestPermission();
  setInterval(refreshEvents, 45 * 1000);   // activity feed + desktop alerts, one loop
  // Live "price now" on the Recommendations tab: refresh every 60s while it's visible.
  setInterval(() => { if ($("panel-recs").classList.contains("active") && !document.hidden) loadRecs(); }, 60 * 1000);
})();
