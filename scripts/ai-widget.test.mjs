#!/usr/bin/env node
/**
 * Инструменты, добавленные по тест-батарее: веб-виджет (create_bot WEB, web_widget_snippet), база знаний
 * (kb_*), карточка/журнал/диалог подписчика (bot_user_*, dialog_*), проверка UUID в графах.
 * Аргументы → метод, путь и тело; ошибки — до запроса. API подменяется локальным сервером. Выход 0 — ок, 1 — провал.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seen = [];
const CHAT = "7110953144424190"; // > 2^53 — должен дойти до API без округления

const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    seen.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: "x1" }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-aiw-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { RETENSY_MCP_CATALOG: "off", ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_bt",
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
const last = (method, url) => seen.filter((s) => s.method === method && s.url === url).at(-1);

const tools = (await rpc("tools/list", {}))?.result?.tools ?? [];
for (const n of ["ai_widget_get", "ai_widget_enable", "ai_widget_external"]) check(`tools/list содержит ${n}`, tools.some((t) => t.name === n));
check("agent_update описывает shop", /shop: \{enabled/.test(tools.find((t) => t.name === "agent_update")?.description ?? ""));

await call("ai_widget_get", { siteId: "s1" });
check("ai_widget_get → GET /api/bots/ai-widget/site/s1", !!last("GET", "/api/bots/ai-widget/site/s1"));
await call("ai_widget_enable", { siteId: "s1", enabled: true, shopAnswers: true, template: "shop", position: "bottom-left" });
const put = last("PUT", "/api/bots/ai-widget/site/s1");
check("ai_widget_enable → PUT с телом без siteId", put?.body?.enabled === true && put.body.shopAnswers === true && put.body.template === "shop" && put.body.siteId === undefined);
const bad = await call("ai_widget_enable", { siteId: "s1" });
check("ai_widget_enable без enabled → ошибка до запроса", isErr(bad));
await call("ai_widget_external", { enabled: true, agentId: "a1", shopAnswers: false });
check("ai_widget_external → POST /api/bots/ai-widget", last("POST", "/api/bots/ai-widget")?.body?.agentId === "a1");

child.kill(); srv.close();
if (failed) { console.error(`ai-widget: провалов ${failed}`); process.exit(1); }
console.log("ai-widget OK");
