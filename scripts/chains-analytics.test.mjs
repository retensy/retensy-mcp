#!/usr/bin/env node
/**
 * wave/audit-1014 (R2): цепочки публикаций (chain_*), дашборд аналитики (site_analytics*,
 * bot_subscriber_analytics, scenario_timeseries), проверка инструмента ИИ-агента (agent_tool_test),
 * метаданные файла заявки сайта (site_lead_file_download). Аргументы → метод/путь/тело/заголовки —
 * до реального запроса. API подменяется локальным сервером. Выход 0 — ок, 1 — провал.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seen = [];

const CHAIN_ID = "11111111-2222-4333-8444-555555555555";
const JOB_ID = "22222222-2222-4333-8444-555555555555";
const SITE_ID = "33333333-2222-4333-8444-555555555555";
const BOT_ID = "44444444-2222-4333-8444-555555555555";
const GRAPH_ID = "55555555-2222-4333-8444-555555555555";
const LEAD_ID = "66666666-2222-4333-8444-555555555555";
const FILE_ID = "77777777-2222-4333-8444-555555555555";
const MISSING_FILE_ID = "88888888-2222-4333-8444-555555555555";

const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = raw.toString("utf8"); } }
    seen.push({ method: req.method, url: req.url, body, headers: req.headers });
    if (req.method === "HEAD" && req.url.includes("/files/")) {
      if (req.url.includes(MISSING_FILE_ID)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": "12345",
        "Content-Disposition": 'attachment; filename="photo.png"',
      });
      return res.end();
    }
    if (req.method === "GET" && req.url === "/api/bots/chains") return json(200, [{ id: CHAIN_ID, name: "TG→VK" }]);
    if (req.method === "GET" && req.url === `/api/bots/chains/${CHAIN_ID}/runs`) {
      return json(200, Array.from({ length: 5 }, (_, i) => ({ id: `job-${i}`, status: "DONE" })));
    }
    json(200, { ok: true, id: "x1" });
    function json(code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_ca",
    RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0" },
  stdio: ["pipe", "pipe", "ignore"],
});
const waiting = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  waiting.get(m?.id)?.(m);
});
let nextId = 1;
const rpc = (method, params) => {
  const id = nextId++;
  const reply = new Promise((resolve) => waiting.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return Promise.race([reply, new Promise((r) => setTimeout(() => r(null), 8000))]);
};
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const textOf = (r) => (r?.result?.content ?? []).map((c) => c.text).join("\n");
const isErr = (r) => r?.result?.isError === true;
const req = (method, url) => seen.find((s) => s.method === method && s.url === url);
const reqStarts = (method, prefix) => seen.find((s) => s.method === method && s.url.startsWith(prefix));

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "  ok " : "  FAIL"} ${name}`); if (!cond) failed++; };

const tl = await rpc("tools/list", {});
const toolNames = (tl?.result?.tools ?? []).map((t) => t.name);
const NEW_TOOLS = [
  "chain_list", "chain_get", "chain_create", "chain_update", "chain_delete", "chain_enable", "chain_pause",
  "chain_runs", "chain_approve", "chain_reject", "chain_retry",
  "site_analytics", "site_analytics_events", "bot_subscriber_analytics", "scenario_timeseries",
  "agent_tool_test", "site_lead_file_download",
];
for (const n of NEW_TOOLS) check(`tools/list содержит ${n}`, toolNames.includes(n));

// ---- chains ----
await call("chain_list", {});
check("chain_list → GET /api/bots/chains", !!req("GET", "/api/bots/chains"));
await call("chain_get", { chainId: CHAIN_ID });
check("chain_get → GET /api/bots/chains/{id}", !!req("GET", `/api/bots/chains/${CHAIN_ID}`));
const draft = { name: "TG→VK", source: { type: "TELEGRAM", chatId: "1" }, destinations: [{ type: "VK", accountId: "a1" }] };
await call("chain_create", { chain: draft });
check("chain_create → POST /api/bots/chains с телом chain", req("POST", "/api/bots/chains")?.body?.name === "TG→VK");
check("chain_create без chain — ошибка до запроса", isErr(await call("chain_create", {})));
await call("chain_update", { chainId: CHAIN_ID, chain: draft });
check("chain_update → PUT /api/bots/chains/{id}", req("PUT", `/api/bots/chains/${CHAIN_ID}`)?.body?.name === "TG→VK");
check("chain_delete без confirm — ошибка до запроса", isErr(await call("chain_delete", { chainId: CHAIN_ID })));
await call("chain_delete", { chainId: CHAIN_ID, confirm: true });
check("chain_delete с confirm:true → DELETE /api/bots/chains/{id}", !!req("DELETE", `/api/bots/chains/${CHAIN_ID}`));
await call("chain_enable", { chainId: CHAIN_ID });
check("chain_enable → POST .../enable", !!req("POST", `/api/bots/chains/${CHAIN_ID}/enable`));
await call("chain_pause", { chainId: CHAIN_ID });
check("chain_pause → POST .../pause", !!req("POST", `/api/bots/chains/${CHAIN_ID}/pause`));
const runsAll = await call("chain_runs", { chainId: CHAIN_ID });
check("chain_runs без page/size → полный список", JSON.parse(textOf(runsAll)).length === 5);
const runsPaged = await call("chain_runs", { chainId: CHAIN_ID, page: 0, size: 2 });
const paged = JSON.parse(textOf(runsPaged));
check("chain_runs с page/size → режет на стороне MCP", paged.content.length === 2 && paged.totalElements === 5);
await call("chain_approve", { jobId: JOB_ID });
check("chain_approve → POST jobs/{id}/approve", !!req("POST", `/api/bots/chains/jobs/${JOB_ID}/approve`));
await call("chain_reject", { jobId: JOB_ID });
check("chain_reject → POST jobs/{id}/reject", !!req("POST", `/api/bots/chains/jobs/${JOB_ID}/reject`));
await call("chain_retry", { jobId: JOB_ID });
check("chain_retry → POST jobs/{id}/retry", !!req("POST", `/api/bots/chains/jobs/${JOB_ID}/retry`));

// ---- analytics ----
await call("site_analytics", { siteId: SITE_ID, from: "2026-09-01", to: "2026-09-30" });
check("site_analytics → GET .../analytics?from&to", !!req("GET", `/api/bots/pages/${SITE_ID}/analytics?from=2026-09-01&to=2026-09-30`));
await call("site_analytics", { siteId: SITE_ID });
check("site_analytics без дат → GET .../analytics без qs", !!req("GET", `/api/bots/pages/${SITE_ID}/analytics`));
await call("site_analytics_events", { siteId: SITE_ID, page: 1, size: 10 });
check("site_analytics_events → GET .../analytics/events?page&size", !!req("GET", `/api/bots/pages/${SITE_ID}/analytics/events?page=1&size=10`));
check("bot_subscriber_analytics без from/to — ошибка до запроса", isErr(await call("bot_subscriber_analytics", { botId: BOT_ID })));
await call("bot_subscriber_analytics", { botId: BOT_ID, from: "2026-09-01", to: "2026-09-30" });
check("bot_subscriber_analytics → GET .../analytics/subscribers?from&to", !!req("GET", `/api/bots/${BOT_ID}/analytics/subscribers?from=2026-09-01&to=2026-09-30`));
check("scenario_timeseries без from/to — ошибка до запроса", isErr(await call("scenario_timeseries", { graphId: GRAPH_ID })));
await call("scenario_timeseries", { graphId: GRAPH_ID, from: "2026-09-01", to: "2026-09-30" });
check("scenario_timeseries → GET graphs/{id}/analytics/timeseries?from&to", !!req("GET", `/api/bots/graphs/${GRAPH_ID}/analytics/timeseries?from=2026-09-01&to=2026-09-30`));

// ---- ai agent tool test ----
await call("agent_tool_test", { agentId: "ag1", toolId: "amo_lookup", params: { leadId: "123" } });
check("agent_tool_test → POST agents/{id}/tools/{toolId}/test с params", req("POST", "/api/bots/agents/ag1/tools/amo_lookup/test")?.body?.params?.leadId === "123");

// ---- site lead file metadata ----
const fileRes = await call("site_lead_file_download", { siteId: SITE_ID, leadId: LEAD_ID, fileId: FILE_ID });
check("site_lead_file_download → HEAD-запрос, не GET", !!req("HEAD", `/api/bots/pages/${SITE_ID}/leads/${LEAD_ID}/files/${FILE_ID}`));
check("site_lead_file_download не попал в seen как GET (байты не скачиваются)", !req("GET", `/api/bots/pages/${SITE_ID}/leads/${LEAD_ID}/files/${FILE_ID}`));
const fileMeta = JSON.parse(textOf(fileRes));
check("site_lead_file_download вернул метаданные из заголовков", fileMeta.fileName === "photo.png" && fileMeta.contentType === "image/png" && fileMeta.sizeBytes === 12345);
check("site_lead_file_download вернул downloadUrl", typeof fileMeta.downloadUrl === "string" && fileMeta.downloadUrl.includes(`/files/${FILE_ID}`));
check("site_lead_file_download не вернул сырые байты файла", textOf(fileRes).length < 2000);
const missingRes = await call("site_lead_file_download", { siteId: SITE_ID, leadId: LEAD_ID, fileId: MISSING_FILE_ID });
check("site_lead_file_download HTTP 404 → ошибка инструмента", isErr(missingRes));

child.kill(); srv.close();
if (failed) { console.error(`chains-analytics: провалов ${failed}`); process.exit(1); }
console.log("chains-analytics OK");
