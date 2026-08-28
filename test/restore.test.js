"use strict";
// Backup restore + integrity: snapshot, mutate, restore, verify the data came back.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { useTempDb } = require("./helpers");

useTempDb();
const db = require("../src/db");

before(async () => { await db.init(); await require("../src/settings").load(); });
after(async () => { await db.close(); });

test("backup → mutate → restore round-trip brings the data back (with a pre-restore snapshot)", async () => {
  await db.run("INSERT INTO watchlist (created_at, symbol, yahoo_symbol, asset_type, name) VALUES (?,?,?,?,?)",
    [Date.now(), "KEEPME", "KEEPME", "stock", "Keep Me Inc"]);
  const b = await db.backupNow(5);
  assert.ok(b.file, "backup created");
  const file = b.file.split("/").pop();

  assert.strictEqual(db.verifyBackup(file).ok, true, "fresh backup passes integrity");

  await db.run("DELETE FROM watchlist WHERE symbol='KEEPME'");
  assert.strictEqual(await db.get("SELECT COUNT(*) AS n FROM watchlist WHERE symbol='KEEPME'").then((r) => r.n), 0);

  const r = await db.restoreBackup(file);
  assert.strictEqual(r.ok, true);
  assert.ok(r.pre_restore_snapshot, "current DB snapshotted before the swap");
  assert.strictEqual(await db.get("SELECT COUNT(*) AS n FROM watchlist WHERE symbol='KEEPME'").then((x) => x.n), 1, "data restored");
  await db.run("DELETE FROM watchlist WHERE symbol='KEEPME'");
});

test("restore refuses path traversal and unknown files", async () => {
  await assert.rejects(() => db.restoreBackup("../../etc/passwd"), /invalid backup filename/);
  await assert.rejects(() => db.restoreBackup("advisor-nope.db"), /not found/);
});
