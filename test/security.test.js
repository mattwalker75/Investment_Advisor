"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const sec = require("../src/security");

test("hostAllowed: localhost variants pass, everything else fails", () => {
  for (const ok of ["localhost", "localhost:8210", "127.0.0.1:8210", "[::1]:8210", "127.0.0.1"])
    assert.strictEqual(sec.hostAllowed(ok), true, ok);
  for (const bad of ["evil.example.com", "attacker.rebind.net:8210", "", null, "localhost.evil.com"])
    assert.strictEqual(sec.hostAllowed(bad), false, String(bad));
});

test("isForbiddenIp: loopback/link-local/metadata refused, LAN + public allowed", () => {
  for (const bad of ["127.0.0.1", "127.9.9.9", "0.0.0.0", "169.254.169.254", "::1", "::", "fe80::1", "::ffff:127.0.0.1"])
    assert.strictEqual(sec.isForbiddenIp(bad), true, bad);
  for (const ok of ["192.168.1.50", "10.0.0.5", "172.16.0.9", "8.8.8.8", "::ffff:8.8.8.8"])
    assert.strictEqual(sec.isForbiddenIp(ok), false, ok);
});

test("assertWebhookUrlAllowed: schemes + destinations", async () => {
  await sec.assertWebhookUrlAllowed("https://ntfy.sh/topic");          // public ok
  await sec.assertWebhookUrlAllowed("http://192.168.1.10/ntfy");       // LAN ok
  for (const bad of ["http://127.0.0.1:8210/x", "http://localhost/x", "http://169.254.169.254/latest", "ftp://ntfy.sh/x", "not-a-url"]) {
    await assert.rejects(() => sec.assertWebhookUrlAllowed(bad), undefined, "should refuse: " + bad);
  }
});
