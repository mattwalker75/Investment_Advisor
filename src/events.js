"use strict";
// Shared event logger: writes to the events table (Activity feed) AND pushes a webhook
// notification for alert-worthy types (gated by Settings → Notifications).
const db = require("./db");
const { eventNotify } = require("./notify");

async function logEvent(type, refType, refId, symbol, message) {
  await db.run("INSERT INTO events (at, type, ref_type, ref_id, symbol, message) VALUES (?,?,?,?,?,?)",
    [Date.now(), type, refType, refId, symbol, message]);
  eventNotify(type, symbol, message);   // fire-and-forget
}

module.exports = { logEvent };
