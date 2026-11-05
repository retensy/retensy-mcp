#!/usr/bin/env node
// Динамический каталог действий (GET /api/agent-tools/catalog → POST /api/agent-tools/invoke):
// новые инструменты из каталога появляются в tools/list без релиза, совпавшие имена берутся из каталога,
// служебные (setup/set_token) не перекрываются, подтверждение 409 превращается в просьбу спросить человека,
// о смене набора клиенту приходит notifications/tools/list_changed.

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { mergeTools, validCatalogTool } from "../src/catalog.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const check = (name, cond) => { console.log(`  ${cond ? "ok" : "FAIL"}  ${name}`); if (!cond) failed++; };

// ---- чистые функции ----
const stat = [{ name: "setup", description: "s", inputSchema: { type: "object" } }, { name: "list_bots", description: "old", inputSchema: { type: "object" } }];
const merged = mergeTools(stat, [
  { name: "list_bots", description: "new", inputSchema: { type: "object", properties: {} } },
  { name: "setup", description: "hijack", inputSchema: { type: "object" } },
  { name: "Bad Name", description: "x", inputSchema: { type: "object" } },
  { name: "fresh_tool", description: "fresh", inputSchema: { type: "object" } },
  { name: "no_schema", description: "x" },
]);
check("совпавшее имя берётся из каталога", merged.find((t) => t.name === "list_bots").description === "new");
check("setup не перекрывается каталогом", merged.find((t) => t.name === "setup").description === "s");
check("новый инструмент добавлен в конец", merged.at(-1).name === "fresh_tool");
check("невалидные записи отброшены", !merged.some((t) => t.name === "Bad Name" || t.name === "no_schema"));
check("validCatalogTool требует схему-объект", !validCatalogTool({ name: "abc", description: "d", inputSchema: { type: "string" } }));

// ---- живой сервер ----
const CATALOG = [
  { name: "list_bots", description: "Список ботов (из каталога)", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "brand_new_tool", description: "Новое действие без релиза", inputSchema: { type: "object", properties: { x: { type: "string", description: "x" } }, required: [] } },
  { name: "bot_delete", description: "Удалить бота. Требует подтверждения", inputSchema: { type: "object", properties: { botId: { type: "string", description: "id" }, confirm: { type: "boolean", description: "c" } }, required: ["botId"] }, requiresConfirmation: true },
];
const invokes = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/agent-tools/catalog") {
      if (req.headers.authorization !== "Bearer zmcp_test_cat") { res.statusCode = 401; return res.end("{}"); }
      return res.end(JSON.stringify({ version: 1, tools: CATALOG }));
    }
    if (req.url === "/api/agent-tools/invoke" && req.method === "POST") {
      const b = JSON.parse(body || "{}");
      invokes.push(b);
      if (b.name === "bot_delete" && b.args?.confirm !== true) {
        res.statusCode = 409;
        return res.end(JSON.stringify({ needsConfirmation: true, tool: "bot_delete", message: "Спроси пользователя и повтори с confirm:true." }));
      }
      return res.end(JSON.stringify({ ok: true, name: b.name }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rmcp-cat-"));

const child = spawn(process.execPath, [path.join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_cat",
    RETENSY_MCP_AUTOUPDATE: "0", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_CATALOG: "on" },
  stdio: ["pipe", "pipe", "ignore"],
});
const waiters = new Map();
const notes = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  else if (m.method) notes.push(m.method);
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiters.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const until = async (cond, ms = 5000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 30)); return cond(); };

const timer = setTimeout(() => { console.log("  FAIL  таймаут"); process.exit(1); }, 20000);
try {
  const init = await rpc("initialize", {});
  check("capability listChanged", init.result?.capabilities?.tools?.listChanged === true);
  check("после загрузки каталога — notifications/tools/list_changed", await until(() => notes.includes("notifications/tools/list_changed")));

  const list = (await rpc("tools/list", {})).result.tools;
  const names = list.map((t) => t.name);
  check("новый инструмент каталога в tools/list", names.includes("brand_new_tool"));
  check("имена без дублей", new Set(names).size === names.length);
  check("list_bots — версия каталога", list.find((t) => t.name === "list_bots").description === "Список ботов (из каталога)");
  check("захардкоженные инструменты на месте", names.includes("setup") && names.includes("create_bot"));

  const call = await rpc("tools/call", { name: "brand_new_tool", arguments: { x: "1" } });
  check("вызов идёт через invoke", invokes.at(-1)?.name === "brand_new_tool" && invokes.at(-1)?.args?.x === "1");
  check("ответ invoke возвращён", /"ok": true/.test(call.result.content[0].text));

  const del = await rpc("tools/call", { name: "bot_delete", arguments: { botId: "b1" } });
  check("без confirm — просьба спросить пользователя, не ошибка", !del.result.isError && /подтверждение/i.test(del.result.content[0].text));

  // кэш на диске: следующий старт знает каталог до сети
  check("каталог закэширован на диск", fs.readdirSync(path.join(home, ".retensy-bot-graph")).some((f) => f.startsWith("catalog-")));
} finally {
  clearTimeout(timer);
  child.kill();
  server.close();
}
console.log(failed ? `catalog FAIL: ${failed}` : "catalog OK");
process.exit(failed ? 1 : 0);
