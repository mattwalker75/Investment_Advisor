"use strict";
// AI cost telemetry: every llm call lands in ai_usage (endpoint-reported tokens for
// non-streamed calls, honest estimates for streams that report nothing), the summary
// aggregates by task/model with a cost line only when prices are configured, and old
// rows are pruned at the retention window.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { useTempDb } = require("./helpers");

useTempDb();

const db = require("../src/db");
const settings = require("../src/settings");
const COST = { per_mtok_input: 0, per_mtok_output: 0 };
settings.getSync = () => ({
  ai: { base_url: "http://127.0.0.1:18441/v1", api_key: "", model: "stub", temperature: 0, max_tokens: 500,
        task_models: { scan: "", light: "" }, scan_batching: "single", failover: { enabled: false }, cost: COST },
});

let srv;
before(async () => {
  await db.init();
  await new Promise((resolve) => {
    srv = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const stream = JSON.parse(b).stream;
        if (stream) {
          // SSE stream WITHOUT usage — forces the estimate path.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"hello streamed world"}}]}\n\n');
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
        }));
      });
    });
    srv.listen(18441, resolve);
  });
});
after(async () => { await new Promise((r) => srv.close(r)); await db.close(); });

test("chat records endpoint-reported usage with the task tag", async () => {
  const llm = require("../src/ai/llm");
  await llm.chat([{ role: "user", content: "hi" }], { task: "scan" });
  await llm.chat([{ role: "user", content: "hi" }]);   // untagged → 'chat'
  const rows = await db.all("SELECT * FROM ai_usage ORDER BY id");
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].task, "scan");
  assert.strictEqual(rows[0].total_tokens, 140);
  assert.strictEqual(rows[0].estimated, 0);
  assert.strictEqual(rows[1].task, "chat");
});

test("streamed call with no reported usage records an ESTIMATE, flagged", async () => {
  const llm = require("../src/ai/llm");
  const r = await llm.chatStream([{ role: "user", content: "hi" }], { task: "chat" }, () => {});
  assert.strictEqual(r.content, "hello streamed world");
  const row = await db.get("SELECT * FROM ai_usage WHERE estimated=1 ORDER BY id DESC LIMIT 1");
  assert.ok(row, "estimated row written");
  assert.ok(row.completion_tokens >= 4 && row.completion_tokens <= 10, `~5 tokens for 20 chars, got ${row.completion_tokens}`);
});

test("summary aggregates by task and adds a cost line only when prices are set", async () => {
  const usage = require("../src/ai/usage");
  let s = await usage.summary();
  assert.strictEqual(s.total.calls, 3);
  assert.strictEqual(s.by_task.scan.calls, 1);
  assert.strictEqual(s.by_task.chat.calls, 2);
  assert.strictEqual(s.total.estimated_calls, 1);
  assert.strictEqual(s.est_cost_usd, undefined, "no prices → no cost line");
  COST.per_mtok_input = 3; COST.per_mtok_output = 15;
  s = await usage.summary();
  assert.ok(s.est_cost_usd >= 0, "cost line appears once prices are set");
  assert.ok(/estimated/.test(s.cost_note), "cost note stays honest about estimated counts");
  COST.per_mtok_input = 0; COST.per_mtok_output = 0;
});

test("retention: rows older than 90 days are pruned by the occasional sweep", async () => {
  const usage = require("../src/ai/usage");
  await db.run("INSERT INTO ai_usage (at, task, total_tokens) VALUES (?,?,?)", [Date.now() - 100 * 86400000, "ancient", 1]);
  for (let i = 0; i < 51; i++) usage.record({ task: "test", model: "stub", usage: { total_tokens: 1 } });
  await new Promise((r) => setTimeout(r, 50));   // fire-and-forget inserts/prune settle
  const old = await db.get("SELECT COUNT(*) AS n FROM ai_usage WHERE task='ancient'");
  assert.strictEqual(old.n, 0, "100-day-old row swept");
});
