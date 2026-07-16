"use strict";
// Initialize (or reset) the database: applies database/schema.<dialect>.sql for the
// dialect configured in ADVISOR_CONFIG.json. Called by ./ADVISOR.sh --setup / --init-db /
// --reset-db. Safe to re-run — the schema files only CREATE TABLE IF NOT EXISTS.
const db = require("../src/db");

(async () => {
  const reset = process.argv.includes("--reset");
  await db.init();
  if (reset) {
    console.log(`[init-db] RESET: dropping all tables (${db.dialect})...`);
    await db.dropAll();
    await db.close();
    await db.init();   // re-applies the schema fresh
  }
  const rows = db.dialect === "sqlite"
    ? await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    : await db.all("SHOW TABLES");
  const names = rows.map((r) => Object.values(r)[0]);
  console.log(`[init-db] dialect=${db.dialect}  tables: ${names.join(", ")}`);
  await db.close();
  console.log(`[init-db] ${reset ? "Reset" : "Init"} complete.`);
})().catch((e) => { console.error("[init-db] FAILED:", e.message); process.exit(1); });
