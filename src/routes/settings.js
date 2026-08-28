"use strict";
// Settings & configuration routes: the settings blocks, AI endpoint test/model listing,
// DB connection config, and the webhook test. Mounted at /api by server.js.
const express = require("express");
const fs = require("fs");

const db = require("../db");
const settings = require("../settings");
const llm = require("../ai/llm");

const router = express.Router();

router.get("/settings", async (_req, res) => {
  res.json(settings.publicView(await settings.getAll()));
});
router.put("/settings/:block", async (req, res) => {
  try {
    const block = req.params.block;
    const incoming = req.body || {};
    // Masked secrets: '•••' means "keep what's stored" — never overwrite with the mask.
    const cur = await settings.getAll();
    if (block === "ai") {
      if (incoming.api_key === "•••") incoming.api_key = cur.ai.api_key;
      if (incoming.failover && incoming.failover.api_key === "•••")
        incoming.failover.api_key = (cur.ai.failover && cur.ai.failover.api_key) || "";
    }
    if (block === "providers") {
      if (incoming.alpha_vantage_key === "•••") incoming.alpha_vantage_key = cur.providers.alpha_vantage_key;
      if (incoming.finnhub_key === "•••") incoming.finnhub_key = cur.providers.finnhub_key;
      if (incoming.fmp_key === "•••") incoming.fmp_key = cur.providers.fmp_key;
    }
    if (block === "notifications" && incoming.webhook_url === "•••") incoming.webhook_url = cur.notifications.webhook_url;
    await settings.setBlock(block, incoming);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post("/ai/test", async (req, res) => {
  try {
    const cfg = req.body || {};
    if (cfg.api_key === "•••") cfg.api_key = (await settings.getAll()).ai.api_key;
    res.json(await llm.test(cfg));
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
// List models from an OpenAI-compatible endpoint (GET {base}/models) — works for
// OpenAI's catalog AND a local Ollama/LM Studio (returns installed models). Feeds the
// model dropdown in Settings. OpenAI's list is filtered down to chat-capable families.
router.post("/ai/models", async (req, res) => {
  try {
    const cfg = req.body || {};
    let key = cfg.api_key;
    if (key === "•••") key = (await settings.getAll()).ai.api_key;
    const base = String(cfg.base_url || (await settings.getAll()).ai.base_url || "").replace(/\/+$/, "");
    if (!base) return res.status(400).json({ error: "base_url required" });
    const headers = { accept: "application/json" };
    if (key) headers.Authorization = "Bearer " + key;
    const r = await fetch(base + "/models", { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(502).json({ error: `${r.status} from ${base}/models — check the URL${r.status === 401 ? " and API key" : ""}` });
    const d = await r.json();
    let ids = (d.data || []).map((m) => m.id).filter(Boolean)
      .filter((id) => !/embed/i.test(id));   // embedding models can't chat, any provider
    if (/openai\.com/.test(base)) {
      // Chat-capable families only — hide audio/image/moderation/etc. models.
      ids = ids.filter((id) => /^(gpt-|chatgpt|o[0-9])/.test(id) &&
        !/(audio|tts|whisper|dall-e|image|realtime|moderation|transcribe|search)/.test(id));
    }
    res.json({ models: ids.sort() });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// AI live self-test: prove every AI pipeline against the configured model in miniature.
// Can take a few minutes on slow local models — the UI shows per-check progress text.
router.post("/ai/selftest", async (_req, res) => {
  try { res.json(await require("../engine/selftest").runSelfTest()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// DB connection config (ADVISOR_CONFIG.json — the one file-based setting). Password masked.
router.get("/db/config", (_req, res) => {
  try {
    const cfg = db.loadConfig();
    if (cfg.mysql) cfg.mysql = { ...cfg.mysql, password: cfg.mysql.password ? "•••" : "" };
    res.json({ ...cfg, dialect_active: db.dialect });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put("/db/config", (req, res) => {
  try {
    const incoming = req.body || {};
    // Shape validation: only known fields, correct types — a malformed write here would
    // brick the next boot (this file is read before anything else).
    if (incoming.dialect !== undefined && !["sqlite", "mysql"].includes(incoming.dialect))
      return res.status(400).json({ error: "dialect must be 'sqlite' or 'mysql'" });
    if (incoming.sqlite !== undefined && (typeof incoming.sqlite !== "object" || incoming.sqlite === null || (incoming.sqlite.file !== undefined && typeof incoming.sqlite.file !== "string")))
      return res.status(400).json({ error: "sqlite must be an object like { file: 'data/advisor.db' }" });
    if (incoming.mysql !== undefined) {
      const m = incoming.mysql;
      if (typeof m !== "object" || m === null) return res.status(400).json({ error: "mysql must be an object" });
      for (const f of ["host", "user", "password", "database"]) if (m[f] !== undefined && typeof m[f] !== "string")
        return res.status(400).json({ error: `mysql.${f} must be a string` });
      if (m.port !== undefined && !(Number.isInteger(m.port) && m.port > 0 && m.port < 65536))
        return res.status(400).json({ error: "mysql.port must be a valid port number" });
    }
    const raw = JSON.parse(fs.readFileSync(db.CONFIG_FILE, "utf8"));
    if (!raw.db || typeof raw.db !== "object") raw.db = {};
    if (incoming.mysql && incoming.mysql.password === "•••")
      incoming.mysql.password = (raw.db.mysql && raw.db.mysql.password) || "";
    raw.db = { ...raw.db, ...incoming };
    fs.writeFileSync(db.CONFIG_FILE, JSON.stringify(raw, null, 2));
    res.json({ ok: true, note: "Saved. Run ./ADVISOR.sh --init-db to create the schema, then --restart to switch." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Back up the database on demand (SQLite; MySQL returns a mysqldump note).
router.post("/db/backup", async (_req, res) => {
  try { res.json(await db.backupNow((await settings.getAll()).schedule.backup_keep || 14)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a test notification. A URL from the form is tested as an OVERRIDE — it is never
// persisted here (a failed test used to leave the broken URL saved as the webhook).
router.post("/notify/test", async (req, res) => {
  try {
    const { sendWebhook } = require("../notify");
    const url = (req.body && req.body.webhook_url) || undefined;
    const ok = await sendWebhook("Investment Advisor", "🔔 Test notification — your webhook works.",
      { url: url && url !== "•••" ? url : undefined });
    res.json({ ok, note: ok && url && url !== "•••" ? "URL works — click Save to keep it." : undefined });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

module.exports = router;
