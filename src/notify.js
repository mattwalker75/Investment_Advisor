"use strict";
// Outbound notifications — how timing alerts reach you when the browser is closed.
// One webhook URL in Settings, format auto-detected:
//   - Discord webhook  (discord.com/api/webhooks/...)  -> {content}
//   - Slack webhook    (hooks.slack.com/...)           -> {text}
//   - ntfy.sh topic / anything else                    -> plain-text POST with Title header
// Browser desktop notifications are handled client-side (app.js polls /api/events).
const settings = require("./settings");

// Which event types pass which user gate (Settings → Notifications).
const GATES = {
  stop_hit: "stops_targets", target_hit: "stops_targets", entry_hit: "stops_targets",
  stop_suggest: "stop_suggestions",
  health: "health",
  scan: "scans", rec_new: "scans", rec_expired: "scans",
  briefing: "briefing",
};

// ntfy priority per event type: a crossed stop should buzz through a phone's focus
// mode; a daily briefing shouldn't. (Discord/Slack have no priority concept — ignored.)
const NTFY_PRIORITY = {
  stop_hit: "urgent",        // stop crossed / option expiring — act now
  health: "high",            // sell_now / tighten verdicts
  target_hit: "high",
  entry_hit: "default",
  stop_suggest: "default",
  scan: "low", rec_new: "default", rec_expired: "low", briefing: "low",
};
const NTFY_TAGS = { stop_hit: "rotating_light", target_hit: "dart", health: "stethoscope", briefing: "newspaper", rec_new: "bulb" };

async function sendWebhook(title, message, { type } = {}) {
  const cfg = settings.getSync().notifications || {};
  const url = (cfg.webhook_url || "").trim();
  if (!url) return false;
  // SSRF guard: only http(s), never loopback/link-local/metadata destinations (private
  // LAN hosts like a self-hosted ntfy stay allowed). Throws with the reason — the
  // /api/notify/test endpoint surfaces it; background notifies swallow it below.
  await require("./security").assertWebhookUrlAllowed(url);
  try {
    let init;
    if (/discord\.com\/api\/webhooks/.test(url)) {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: `**${title}**\n${message}`.slice(0, 1900) }) };
    } else if (/hooks\.slack\.com/.test(url)) {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `*${title}*\n${message}` }) };
    } else {
      const headers = { Title: title.replace(/[^\x20-\x7E]/g, ""), Priority: NTFY_PRIORITY[type] || "default" };
      if (NTFY_TAGS[type]) headers.Tags = NTFY_TAGS[type];
      init = { method: "POST", headers, body: message };
    }
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    return r.ok;
  } catch (_) { return false; }
}

// Fire-and-forget: called by the shared event logger for alert-worthy event types.
function eventNotify(type, symbol, message) {
  const cfg = settings.getSync().notifications || {};
  const gate = GATES[type];
  if (!gate || !(cfg.notify_on || {})[gate]) return;
  const title = `Investment Advisor${symbol ? " · " + symbol : ""}`;
  sendWebhook(title, message, { type }).catch(() => {});
}

module.exports = { sendWebhook, eventNotify };
