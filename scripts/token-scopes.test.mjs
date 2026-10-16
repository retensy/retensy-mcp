#!/usr/bin/env node
/**
 * feat/token-scopes: бэкенд проверяет права (scopes) MCP-токена и на нехватку отвечает
 * 403 {error:"insufficient_scope", requiredScope, message}. Инструмент должен вернуть понятную
 * ошибку «токену не хватает права X», а не «чужой бот / токен не действует».
 * API подменяется локальным сервером. Выход 0 — ок, 1 — провал.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOT_ID = "22222222-2222-4333-8444-555555555555";
const GRAPH_ID = "33333333-2222-4333-8444-555555555555";

const scopeDenied = (scope) => ({
  error: "insufficient_scope",
  requiredScope: scope,
  tokenScopes: ["read"],
  message: `Токену не хватает права «${scope}». Добавьте это право токену или выпустите новый на странице /bots/mcp-tokens.`,
});

const srv = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && req.url === `/api/bots/${BOT_ID}/graphs`) return json(403, scopeDenied("write:bots"));
    if (req.method === "DELETE" && req.url === `/api/bots/graphs/${GRAPH_ID}`) return json(403, scopeDenied("destructive"));
    if (req.method === "POST" && req.url === "/api/bots/vk/post") return json(403, { error: "insufficient_scope", requiredScope: null, tokenScopes: ["read"], message: "Этот запрос недоступен токену с ограниченными правами." });
    if (req.method === "GET" && req.url === `/api/bots/graphs/${GRAPH_ID}`) return json(403, { error: "Forbidden" }); // чужой граф
    json(200, { ok: true });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_scopes",
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

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "  ok " : "  FAIL"} ${name}`); if (!cond) failed++; };

const create = await call("create_graph", { botId: BOT_ID, name: "Воронка" });
check("create_graph на read-only токене → ошибка инструмента", isErr(create));
check("сообщение называет недостающее право write:bots", /не хватает права «write:bots»/.test(textOf(create)));
check("сообщение подсказывает, где добавить право", textOf(create).includes("/bots/mcp-tokens"));
check("сообщение не путает с чужим ботом", !textOf(create).includes("чужой бот"));

const del = await call("delete_graph", { graphId: GRAPH_ID, confirm: true });
check("delete_graph → «не хватает права «destructive»»", isErr(del) && /не хватает права «destructive»/.test(textOf(del)));

const vk = await call("vk_post", { accountId: "a1", text: "hi", confirm: true });
check("неразмеченный эндпоинт → понятная ошибка про ограниченные права", isErr(vk) && /ограниченными правами|не хватает прав/.test(textOf(vk)));

const foreign = await call("get_graph", { graphId: GRAPH_ID });
check("обычный 403 (чужой граф) — прежнее сообщение без «не хватает права»", isErr(foreign) && !/не хватает права/.test(textOf(foreign)));

child.kill(); srv.close();
if (failed) { console.log(`\n${failed} проверок упало`); process.exit(1); }
console.log("\ntoken-scopes: ok");
