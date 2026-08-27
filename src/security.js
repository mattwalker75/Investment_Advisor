"use strict";
// Security guards for a localhost-only app. Binding 127.0.0.1 stops direct remote
// connections, but a malicious WEB PAGE in your own browser can still POST to
// http://127.0.0.1:8210 (CSRF), and DNS-rebinding can even read responses by pointing
// an attacker hostname at 127.0.0.1. Both classes are closed here by validating the
// browser-controlled Host and Origin headers on every request.
const net = require("net");
const dns = require("dns").promises;

// Hostnames allowed to address this server. Extend via ADVISOR_ALLOWED_HOSTS
// (comma-separated, e.g. "advisor.local,my-mac.tailnet-1234.ts.net") if you ever front
// it with a proxy/tailnet — but add authentication before exposing it beyond localhost.
const EXTRA_HOSTS = (process.env.ADVISOR_ALLOWED_HOSTS || "")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ...EXTRA_HOSTS]);

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  // Strip the port: "localhost:8210" -> "localhost", "[::1]:8210" -> "[::1]".
  const host = String(hostHeader).toLowerCase().replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(host);
}

// Express middleware: reject requests whose Host isn't local (DNS rebinding) or whose
// Origin, when the browser sends one, isn't a local page (cross-site request forgery).
// Same-origin fetches from the app's own UI always pass; curl/scripts (no Origin) pass.
function localGuard(req, res, next) {
  if (!hostAllowed(req.headers.host)) {
    return res.status(403).json({ error: "blocked: unexpected Host header (DNS-rebinding protection). Set ADVISOR_ALLOWED_HOSTS to allow additional hostnames." });
  }
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let o;
    try { o = new URL(origin); } catch (_) { return res.status(403).json({ error: "blocked: malformed Origin header" }); }
    if (!hostAllowed(o.host)) {
      return res.status(403).json({ error: "blocked: cross-site request from " + o.host + " (CSRF protection)" });
    }
  }
  next();
}

// ---- Webhook destination guard (partial-SSRF protection) ----
// The webhook URL is user-set, but a hijacked settings write (or a typo) shouldn't be
// able to aim POSTs at this app itself, the loopback, or a cloud metadata service.
// Private LAN ranges (10/8, 172.16/12, 192.168/16) stay ALLOWED — self-hosted ntfy on
// your own network is a first-class use case. Loopback can be re-enabled with
// ADVISOR_WEBHOOK_ALLOW_LOCAL=1 (e.g. ntfy running on this same machine).
function isForbiddenIp(ip) {
  if (process.env.ADVISOR_WEBHOOK_ALLOW_LOCAL === "1") return false;
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 0) return true;               // loopback / unspecified
    if (a === 169 && b === 254) return true;             // link-local + cloud metadata
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;      // loopback / unspecified
    if (low.startsWith("fe80")) return true;             // link-local
    if (low.startsWith("::ffff:")) return isForbiddenIp(low.slice(7));  // v4-mapped
    return false;
  }
  return true;   // not an IP at all — caller resolves hostnames first
}

// Throws with a human-readable reason when the URL must not be used; resolves otherwise.
async function assertWebhookUrlAllowed(url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { throw new Error("webhook URL is not a valid URL"); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("webhook URL must be http(s), got " + u.protocol);
  const host = u.hostname;
  if (net.isIP(host)) {
    if (isForbiddenIp(host)) throw new Error(`webhook host ${host} is loopback/link-local — refused (set ADVISOR_WEBHOOK_ALLOW_LOCAL=1 to allow local delivery)`);
    return;
  }
  if (LOCAL_HOSTS.has(host.toLowerCase()) && process.env.ADVISOR_WEBHOOK_ALLOW_LOCAL !== "1")
    throw new Error("webhook host resolves to this machine — refused (set ADVISOR_WEBHOOK_ALLOW_LOCAL=1 to allow local delivery)");
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch (_) { throw new Error("webhook host does not resolve: " + host); }
  for (const a of addrs) {
    if (isForbiddenIp(a.address))
      throw new Error(`webhook host ${host} resolves to ${a.address} (loopback/link-local) — refused`);
  }
}

module.exports = { localGuard, assertWebhookUrlAllowed, isForbiddenIp, hostAllowed };
