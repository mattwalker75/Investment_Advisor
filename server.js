"use strict";
// Investment Advisor — Express server bootstrap. Local-first: binds 127.0.0.1 only.
// Start with ./ADVISOR.sh --start (or `npm start`). UI at http://localhost:8210.
//
// The HTTP surface lives in src/routes/ (one module per domain); this file only wires
// middleware, mounts the routers, and boots the scheduler + first tracking pass:
//   src/routes/settings.js         settings blocks, AI endpoint test/models, DB config, webhook test
//   src/routes/recommendations.js  recommendation lifecycle + CSV export
//   src/routes/trades.js           trades, health checks, concentration + CSV export
//   src/routes/market.js           charts, quotes, search, dashboard snapshot, watchlist, events
//   src/routes/engine.js           scans, advisor chat, briefing, backtester, performance stats
const express = require("express");
const path = require("path");

const db = require("./src/db");
const settings = require("./src/settings");
const tracker = require("./src/engine/tracker");
const scheduler = require("./src/scheduler");

const app = express();
// Host/Origin guard FIRST: blocks cross-site requests (CSRF) and DNS-rebinding reads
// from malicious web pages before anything else runs. See src/security.js.
app.use(require("./src/security").localGuard);
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
// The charting library, served straight from node_modules (no CDN, works offline).
app.use("/vendor/lightweight-charts", express.static(path.join(__dirname, "node_modules", "lightweight-charts", "dist")));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.use("/api", require("./src/routes/settings"));
app.use("/api", require("./src/routes/recommendations"));
app.use("/api", require("./src/routes/trades"));
app.use("/api", require("./src/routes/market"));
app.use("/api", require("./src/routes/engine"));

// ---------- Boot ----------
const PORT = Number(process.env.PORT || 8210);
(async () => {
  await db.init();
  await settings.load();
  scheduler.start();
  // Kick one tracking pass shortly after boot so statuses are fresh.
  setTimeout(() => { tracker.trackRecommendations().catch(() => {}); tracker.trackTrades().catch(() => {}); }, 5000);
  app.listen(PORT, "127.0.0.1", () => console.log(`Investment Advisor listening on http://localhost:${PORT} (db: ${db.dialect})`));
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
