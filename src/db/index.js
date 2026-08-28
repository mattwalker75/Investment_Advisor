"use strict";
// Database layer: ONE async interface over SQLite (default, zero-setup) or MySQL.
// Which dialect + connection details live in ADVISOR_CONFIG.json at the project root
// (the single setting that can't live in the DB itself). Schema DDL lives in
// database/schema.<dialect>.sql.
//
//   const db = require("./src/db");
//   await db.init();                 // connect + apply schema (CREATE IF NOT EXISTS)
//   await db.all(sql, params)        // -> rows
//   await db.get(sql, params)       // -> first row or undefined
//   await db.run(sql, params)       // -> { lastID, changes }
//
// Write portable SQL: '?' placeholders work in both drivers, and backtick-quoted
// identifiers (`key`) are accepted by BOTH MySQL and SQLite — use them for any
// reserved-word column.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const CONFIG_FILE = process.env.ADVISOR_CONFIG || path.join(ROOT, "ADVISOR_CONFIG.json");

let dialect = "sqlite";
let sqlite = null;   // better-sqlite3 Database
let pool = null;     // mysql2 pool

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  if (!raw.db || !raw.db.dialect) throw new Error("ADVISOR_CONFIG.json: missing db.dialect");
  return raw.db;
}

function schemaFile(d) { return path.join(ROOT, "database", `schema.${d}.sql`); }

// Columns added after the initial release: CREATE TABLE IF NOT EXISTS won't add them to
// an existing DB, so ensure them here (cheap no-op when already present).
const MIGRATIONS = [
  ["recommendations", "risk_reward", "REAL", "DOUBLE"],
  ["trades", "suggested_stop", "TEXT", "LONGTEXT"],
  ["trades", "health", "TEXT", "LONGTEXT"],
  ["trades", "option_details", "TEXT", "LONGTEXT"],
];
async function migrate() {
  for (const [table, col, sqliteType, mysqlType] of MIGRATIONS) {
    try {
      if (dialect === "sqlite") {
        const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes(col)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${sqliteType};`);
      } else {
        const [rows] = await pool.query(
          "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?", [table, col]);
        if (!rows.length) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${mysqlType};`);
      }
    } catch (e) { console.error(`[db] migration ${table}.${col} failed:`, e.message); }
  }
}

async function init() {
  const cfg = loadConfig();
  dialect = cfg.dialect === "mysql" ? "mysql" : "sqlite";
  if (dialect === "sqlite") {
    const Database = require("better-sqlite3");
    const file = path.resolve(ROOT, (cfg.sqlite && cfg.sqlite.file) || "data/advisor.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqlite = new Database(file);
    sqlite.pragma("journal_mode = WAL");      // sane concurrent reads while the app writes
    sqlite.exec(fs.readFileSync(schemaFile("sqlite"), "utf8"));
  } else {
    const mysql = require("mysql2/promise");
    const m = cfg.mysql || {};
    pool = mysql.createPool({
      host: m.host || "127.0.0.1", port: m.port || 3306,
      user: m.user, password: m.password, database: m.database,
      waitForConnections: true, connectionLimit: 5, multipleStatements: true,
    });
    await pool.query(fs.readFileSync(schemaFile("mysql"), "utf8"));
  }
  await migrate();
  return module.exports;
}

async function all(sql, params = []) {
  if (dialect === "sqlite") return sqlite.prepare(sql).all(...params);
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function get(sql, params = []) {
  if (dialect === "sqlite") return sqlite.prepare(sql).get(...params);
  const [rows] = await pool.execute(sql, params);
  return rows[0];
}

async function run(sql, params = []) {
  if (dialect === "sqlite") {
    const r = sqlite.prepare(sql).run(...params);
    return { lastID: Number(r.lastInsertRowid), changes: r.changes };
  }
  const [r] = await pool.execute(sql, params);
  return { lastID: r.insertId || 0, changes: r.affectedRows || 0 };
}

// ---- Automatic backups (SQLite): the DB holds the entire accumulated track record —
// trades, every recommendation and outcome, settings — in one file. backupNow() uses
// better-sqlite3's online backup API (safe while the app is writing) into
// data/backups/, pruning to the newest `keep`. MySQL users schedule mysqldump instead.
const BACKUP_DIR = path.join(ROOT, "data", "backups");
async function backupNow(keep = 14) {
  if (dialect !== "sqlite") return { skipped: true, note: "MySQL backend — schedule mysqldump outside the app for backups" };
  if (!sqlite) throw new Error("database not initialized");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // Millisecond stamp: a pre-restore snapshot taken in the same SECOND as the backup
  // being restored must never collide with (and overwrite) it.
  const stamp = new Date().toISOString().replace(/[:T.]/g, "-").replace(/Z$/, "");
  const dest = path.join(BACKUP_DIR, `advisor-${stamp}.db`);
  await sqlite.backup(dest);
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^advisor-.*\.db$/.test(f)).sort();
  while (files.length > Math.max(1, keep)) {
    const f = files.shift();
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
  }
  return { file: path.relative(ROOT, dest), size_bytes: fs.statSync(dest).size, backups_kept: files.length };
}
// List available backups, newest first.
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^advisor-[\w.-]+\.db$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, size_bytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) { return []; }
}

// SQLite integrity check of one backup file (read-only open, PRAGMA quick_check).
function verifyBackup(file) {
  const safe = String(file);
  if (!/^advisor-[\w.-]+\.db$/.test(safe)) throw new Error("invalid backup filename");
  const full = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(full)) throw new Error("backup not found: " + safe);
  const Database = require("better-sqlite3");
  const bdb = new Database(full, { readonly: true });
  try {
    const r = bdb.pragma("quick_check");
    const ok = Array.isArray(r) && r.length === 1 && (r[0].quick_check === "ok" || r[0] === "ok");
    return { file: safe, ok, detail: ok ? "ok" : JSON.stringify(r).slice(0, 200) };
  } finally { bdb.close(); }
}

// Restore a backup over the live database (SQLite only). Safety order: verify the
// SOURCE's integrity → snapshot the CURRENT database → close → copy → reopen.
// A brief window of in-flight query errors during the swap is expected; the UI
// reloads afterward.
async function restoreBackup(file) {
  if (dialect !== "sqlite") throw new Error("restore supports the SQLite backend");
  if (!sqlite) throw new Error("database not initialized");
  const check = verifyBackup(file);
  if (!check.ok) throw new Error(`backup failed its integrity check (${check.detail}) — not restoring`);
  const pre = await backupNow(Math.max(14, 2));            // pre-restore snapshot of the CURRENT db
  const full = path.join(BACKUP_DIR, String(file));
  const liveFile = sqlite.name;                            // better-sqlite3 exposes the open path
  sqlite.close();
  try {
    for (const suffix of ["-wal", "-shm"]) { try { fs.unlinkSync(liveFile + suffix); } catch (_) {} }
    fs.copyFileSync(full, liveFile);
  } finally {
    const Database = require("better-sqlite3");
    sqlite = new Database(liveFile);
    sqlite.pragma("journal_mode = WAL");
  }
  await migrate();                                         // an older backup may predate columns
  return { ok: true, restored: String(file), pre_restore_snapshot: pre.file, note: "Restored. Reload the page; a restart is recommended." };
}

// Newest backup's mtime (0 when none) — the scheduler uses this to fire once per day.
function lastBackupAt() {
  try {
    let newest = 0;
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (/^advisor-.*\.db$/.test(f)) newest = Math.max(newest, fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs);
    }
    return newest;
  } catch (_) { return 0; }
}

// Dialect-correct INSERT ... upsert statement: inserts `cols`, and on a `keyCol`
// conflict updates every non-key column. Callers bind values in `cols` order. Keeps the
// MySQL-vs-SQLite conflict-clause fork in ONE place.
function upsertSql(table, cols, keyCol) {
  const q = (c) => `\`${c}\``;
  const insert = `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(",")})`;
  const updates = cols.filter((c) => c !== keyCol);
  if (dialect === "mysql")
    return `${insert} ON DUPLICATE KEY UPDATE ${updates.map((c) => `${q(c)}=VALUES(${q(c)})`).join(", ")}`;
  return `${insert} ON CONFLICT(${q(keyCol)}) DO UPDATE SET ${updates.map((c) => `${q(c)}=excluded.${q(c)}`).join(", ")}`;
}

// Drop every app table (used by --reset-db). Order respects foreign keys.
async function dropAll() {
  const tables = ["trades", "recommendations", "scan_runs", "events", "cache", "settings", "watchlist"];
  for (const t of tables) {
    if (dialect === "sqlite") sqlite.exec(`DROP TABLE IF EXISTS ${t};`);
    else await pool.query(`DROP TABLE IF EXISTS ${t};`);
  }
}

async function close() {
  if (sqlite) { try { sqlite.close(); } catch (_) {} sqlite = null; }
  if (pool) { try { await pool.end(); } catch (_) {} pool = null; }
}

module.exports = {
  init, all, get, run, upsertSql, backupNow, lastBackupAt, listBackups, verifyBackup, restoreBackup, dropAll, close, loadConfig,
  get dialect() { return dialect; },
  CONFIG_FILE,
};
