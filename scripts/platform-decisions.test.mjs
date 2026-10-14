#!/usr/bin/env node
/**
 * feat/sync-decisions-1015: вебхук-сценарии (scenario_*, /api/scenarios — PAT-доступ открыт
 * решением владельца 14.10), API-ключи публичного чата агента (agent_api_key_*), пакеты
 * ответов ИИ (ai_packs/ai_pack_purchase). Аргументы → метод/путь/тело — до реального запроса.
 * API подменяется локальным сервером. Выход 0 — ок, 1 — провал.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seen = [];

const SCENARIO_ID = "11111111-2222-4333-8444-555555555555";
const BOT_SCENARIO_ID = "99999999-2222-4333-8444-555555555555";
const BOT_ID = "22222222-2222-4333-8444-555555555555";
const AGENT_ID = "ag-507f1f77bcf86cd799439011";
const KEY_ID = "key-507f1f77bcf86cd799439011";

const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = raw.toString("utf8"); } }
    seen.push({ method: req.method, url: req.url, body, headers: req.headers });

    if (req.method === "POST" && req.url === `/api/scenarios/${BOT_SCENARIO_ID}/source`) { res.writeHead(409); return res.end(); }
    if (req.method === "PUT" && req.url === `/api/scenarios/${BOT_SCENARIO_ID}/source`) { res.writeHead(409); return res.end(); }
    if (req.method === "POST" && req.url === `/api/scenarios/${BOT_SCENARIO_ID}/publish`) { res.writeHead(409); return res.end(); }
    if (req.method === "POST" && req.url === `/api/bots/agents/${AGENT_ID}/api-keys` && seenTooMany) { res.writeHead(409); return res.end(); }
    if (req.method === "GET" && req.url === "/api/scenarios") return json(200, [{ id: SCENARIO_ID, name: "Вход заявки", status: "DRAFT", active: false, sourceType: "WEBHOOK", botId: null }]);
    if (req.method === "GET" && req.url === "/api/bots/ai-packs") return json(200, [{ sku: "ai_pack_1000", answers: 1000, priceRub: 490, kopecks: 10000 }]);
    if (req.method === "GET" && req.url === "/api/bots/subscription") return json(200, { aiPackAnswersLeft: 42, aiPackTokensLeft: 12345 });
    json(200, { id: SCENARIO_ID, ok: true });
    function json(code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
  });
});
let seenTooMany = false;
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_pd",
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

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "  ok " : "  FAIL"} ${name}`); if (!cond) failed++; };

const tl = await rpc("tools/list", {});
const toolNames = (tl?.result?.tools ?? []).map((t) => t.name);
const NEW_TOOLS = [
  "scenario_list", "scenario_create", "scenario_get", "scenario_update_source", "scenario_publish", "scenario_rotate_secret",
  "agent_api_key_create", "agent_api_key_list", "agent_api_key_revoke", "ai_packs", "ai_pack_purchase",
];
for (const n of NEW_TOOLS) check(`tools/list содержит ${n}`, toolNames.includes(n));

// ---- webhook scenarios ----
await call("scenario_list", {});
check("scenario_list → GET /api/scenarios", !!req("GET", "/api/scenarios"));

await call("scenario_create", { name: "Вход заявки" });
check("scenario_create без botId → source.type WEBHOOK", req("POST", "/api/scenarios")?.body?.source?.type === "WEBHOOK");

await call("scenario_create", { name: "Бот-сценарий", botId: BOT_ID });
const botCreateReq = seen.filter((s) => s.method === "POST" && s.url === "/api/scenarios").pop();
check("scenario_create с botId → source.type BOT + config.botId", botCreateReq?.body?.source?.type === "BOT" && botCreateReq?.body?.source?.config?.botId === BOT_ID);
check("scenario_create без name — ошибка до запроса", isErr(await call("scenario_create", {})));

await call("scenario_get", { scenarioId: SCENARIO_ID });
check("scenario_get → GET /api/scenarios/{id}", !!req("GET", `/api/scenarios/${SCENARIO_ID}`));

await call("scenario_update_source", { scenarioId: SCENARIO_ID, botId: BOT_ID, channel: "TG_BOT_API", recipientFrom: "CHAT" });
const srcReq = req("PUT", `/api/scenarios/${SCENARIO_ID}/source`);
check("scenario_update_source → PUT .../source с botId/channel/recipientFrom", srcReq?.body?.botId === BOT_ID && srcReq?.body?.channel === "TG_BOT_API" && srcReq?.body?.recipientFrom === "CHAT");

await call("scenario_update_source", { scenarioId: SCENARIO_ID });
const srcReq2 = seen.filter((s) => s.method === "PUT" && s.url === `/api/scenarios/${SCENARIO_ID}/source`).pop();
check("scenario_update_source без botId → снимает привязку (botId:null)", srcReq2?.body?.botId === null);

check("scenario_update_source на BOT-сценарии → 409 с понятной ошибкой", isErr(await call("scenario_update_source", { scenarioId: BOT_SCENARIO_ID, botId: BOT_ID })));

await call("scenario_publish", { scenarioId: SCENARIO_ID });
check("scenario_publish → POST .../publish", !!req("POST", `/api/scenarios/${SCENARIO_ID}/publish`));
check("scenario_publish на BOT-сценарии → 409 с понятной ошибкой", isErr(await call("scenario_publish", { scenarioId: BOT_SCENARIO_ID })));

await call("scenario_rotate_secret", { scenarioId: SCENARIO_ID });
check("scenario_rotate_secret → POST .../rotate-secret", !!req("POST", `/api/scenarios/${SCENARIO_ID}/rotate-secret`));

// ---- agent api keys ----
await call("agent_api_key_list", { agentId: AGENT_ID });
check("agent_api_key_list → GET agents/{id}/api-keys", !!req("GET", `/api/bots/agents/${AGENT_ID}/api-keys`));

await call("agent_api_key_create", { agentId: AGENT_ID, name: "Виджет" });
check("agent_api_key_create → POST agents/{id}/api-keys с name", req("POST", `/api/bots/agents/${AGENT_ID}/api-keys`)?.body?.name === "Виджет");

seenTooMany = true;
check("agent_api_key_create 409 TOO_MANY_KEYS → понятная ошибка", isErr(await call("agent_api_key_create", { agentId: AGENT_ID })));
seenTooMany = false;

check("agent_api_key_revoke без confirm — ошибка до запроса", isErr(await call("agent_api_key_revoke", { agentId: AGENT_ID, keyId: KEY_ID })));
await call("agent_api_key_revoke", { agentId: AGENT_ID, keyId: KEY_ID, confirm: true });
check("agent_api_key_revoke с confirm:true → DELETE agents/{id}/api-keys/{keyId}", !!req("DELETE", `/api/bots/agents/${AGENT_ID}/api-keys/${KEY_ID}`));

// ---- ai packs ----
const packsRes = await call("ai_packs", {});
check("ai_packs → GET /api/bots/ai-packs", !!req("GET", "/api/bots/ai-packs"));
check("ai_packs → GET /api/bots/subscription (баланс)", !!req("GET", "/api/bots/subscription"));
const packs = JSON.parse(textOf(packsRes));
check("ai_packs вернул skus и balance", Array.isArray(packs.skus) && packs.skus[0]?.sku === "ai_pack_1000" && packs.balance?.aiPackAnswersLeft === 42);

check("ai_pack_purchase без confirm — ошибка до запроса, без платежа", isErr(await call("ai_pack_purchase", { sku: "ai_pack_1000" })));
check("ai_pack_purchase без sku — ошибка до запроса", isErr(await call("ai_pack_purchase", { confirm: true })));
await call("ai_pack_purchase", { sku: "ai_pack_1000", confirm: true });
check("ai_pack_purchase с confirm:true → POST ai-packs/purchase", req("POST", "/api/bots/ai-packs/purchase")?.body?.sku === "ai_pack_1000");

child.kill(); srv.close();
if (failed) { console.error(`platform-decisions: провалов ${failed}`); process.exit(1); }
console.log("platform-decisions OK");
