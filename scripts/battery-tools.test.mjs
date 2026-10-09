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

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-bt-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_bt",
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

await call("create_bot", { platform: "web", name: "Виджет" });
check("create_bot WEB → POST /api/bots/web с именем, без токена", req("POST", "/api/bots/web")?.body?.name === "Виджет");
await call("web_widget_snippet", { botId: "b1" });
check("web_widget_snippet → GET snippet", !!req("GET", "/api/bots/web/b1/snippet"));

await call("kb_list", {});
check("kb_list → GET /api/bots/kb", !!req("GET", "/api/bots/kb"));
await call("kb_create", { name: "  Клиника  " });
check("kb_create → POST с обрезанным name", req("POST", "/api/bots/kb")?.body?.name === "Клиника");
const noName = await call("kb_create", { name: " " });
check("kb_create без name — ошибка до запроса", isErr(noName) && seen.filter((s) => s.url === "/api/bots/kb" && s.method === "POST").length === 1);
await call("kb_add_qa", { kbId: "k1", pairs: [{ question: "Цена?", answer: "1500" }] });
check("kb_add_qa → тело-массив пар", Array.isArray(req("POST", "/api/bots/kb/k1/docs/qa")?.body));
check("kb_add_qa пустые pairs — ошибка", isErr(await call("kb_add_qa", { kbId: "k1", pairs: [] })));
await call("kb_add_site", { kbId: "k1", url: "https://example.com", schedule: "WEEKLY" });
check("kb_add_site → url+schedule", req("POST", "/api/bots/kb/k1/docs/site")?.body?.schedule === "WEEKLY");
await call("kb_delete_doc", { kbId: "k1", docId: "d1" });
check("kb_delete_doc → DELETE", !!req("DELETE", "/api/bots/kb/k1/docs/d1"));

await call("bot_user_get", { botId: "b1", chatId: CHAT });
check("bot_user_get: большой chatId без округления", !!req("GET", `/api/bots/b1/users/${CHAT}`));
await call("bot_user_runs", { botId: "b1", chatId: CHAT, page: 0, size: 5 });
check("bot_user_runs: page/size в query", !!req("GET", `/api/bots/b1/users/${CHAT}/runs?page=0&size=5`));
await call("dialog_messages", { botId: "b1", chatId: CHAT });
check("dialog_messages → GET messages", !!req("GET", `/api/bots/b1/users/${CHAT}/messages`));
const badChat = await call("bot_user_get", { botId: "b1", chatId: "../../admin" });
check("chatId не число — ошибка до запроса", isErr(badChat) && !seen.some((s) => s.url.includes("admin")));
await call("dialog_reply", { botId: "b1", chatId: CHAT, text: " Здравствуйте " });
check("dialog_reply → POST {text}", req("POST", `/api/bots/b1/users/${CHAT}/messages`)?.body?.text === "Здравствуйте");
check("dialog_reply пустой text — ошибка", isErr(await call("dialog_reply", { botId: "b1", chatId: CHAT, text: "" })));

const before = seen.length;
const badIds = await call("update_graph", { graphId: "g1", nodes: [{ id: "n1", type: "TRIGGER_TEXT", config: {} }], edges: [] });
check("update_graph с не-UUID id — понятная ошибка до PUT", isErr(badIds) && /UUID/.test(textOf(badIds)) && seen.length === before);
const U = "11111111-2222-4333-8444-555555555555";
await call("update_graph", { graphId: "g1", nodes: [{ id: U, type: "TRIGGER_TEXT", config: {} }], edges: [] });
check("update_graph с UUID — уходит PUT", !!req("PUT", "/api/bots/graphs/g1"));

child.kill(); srv.close();
if (failed) { console.error(`battery-tools: провалов ${failed}`); process.exit(1); }
console.log("battery-tools OK");
