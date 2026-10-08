#!/usr/bin/env node
/**
 * Integration Core (integration_catalog / integration_status / integration_test), пост в канал (channel_post)
 * и доставка заявки coreDelivery (site_lead_settings): аргументы → метод, путь и тело запроса.
 * Плюс правило кредов: даже если API по ошибке вернёт секрет, в вывод инструмента он не попадает.
 * API подменяется локальным сервером (RETENSY_BASE_URL). Выход 0 — ок, 1 — провал.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "sk_live_SUPERSECRET_9f8e7d";
const seen = [];

const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    seen.push({ method: req.method, url: req.url, body });
    const json = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const k = `${req.method} ${req.url}`;
    // Ответы намеренно «протекают» секретами — инструмент обязан их вычистить.
    if (k === "GET /api/integrations/catalog") {
      return json(200, [{ provider: "demo", name: "Demo CRM", category: "CRM", authType: "API_KEY", healthCheck: true,
        configSchema: [{ key: "apiKey", label: "Ключ", hint: "из кабинета", secret: true }],
        actions: [{ kind: "demo_send", label: "Отправить", inputs: [{ key: "phone", label: "Телефон", hint: "" }] }],
        credsEnc: SECRET }]);
    }
    if (k === "GET /api/integrations/c1/status") return json(200, { status: "OK", lastCheckedAt: "2026-10-08T10:00:00Z", lastError: null, supported: true, creds: { apiKey: SECRET } });
    if (k === "POST /api/integrations/c1/test") return json(200, { status: "NEEDS_REAUTH", lastError: "401", supported: true, secretKey: SECRET, accessToken: SECRET });
    if (k === "GET /api/integrations/other/status") return json(403, { error: "connection not owned" });
    if (k === "POST /api/bots/b1/linked-chats/-1001234567890/post") return json(200, { ok: true, messageId: 77 });
    if (k === "GET /api/bots/integrations") return json(200, [{ id: "c1", provider: "AMOCRM", title: "amo", hint: "…1234", credsEnc: SECRET, creds: { longToken: SECRET } }]);
    if (k === "POST /api/bots/integrations") return json(200, { id: "c2", provider: "AMOCRM", title: "amo", hint: "…5678", creds: { longToken: SECRET }, longToken: SECRET });
    if (req.url === "/api/bots/pages/s1/lead-settings") {
      return json(200, { settings: { notifyBot: true, coreDelivery: req.method === "PUT" ? body?.coreDelivery : null },
        scenarios: [], amoConnections: [], coreConnections: [{ id: "c1", name: "Demo", provider: "demo", credsEnc: SECRET }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-ic-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: {
    ...process.env, HOME: home, USERPROFILE: home,
    RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_ic",
    RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0",
  },
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
const req = (method, url) => seen.find((s) => s.method === method && s.url === url);

const catalog = await call("integration_catalog", {});
const status = await call("integration_status", { connectionId: "c1" });
const test = await call("integration_test", { connectionId: "c1" });
const foreign = await call("integration_status", { connectionId: "other" });
const noId = await call("integration_test", {});
const post = await call("channel_post", { botId: "b1", chatId: -1001234567890, text: "Новый пост", mediaUrl: "https://bots.retensy.com/media/x.jpg" });
const empty = await call("channel_post", { botId: "b1", chatId: -1001234567890, text: "  " });
const badChat = await call("channel_post", { botId: "b1", chatId: "abc", text: "x" });
const list = await call("list_integrations", {});
const conn = await call("connect_integration", { provider: "amocrm", creds: { subdomain: "acme", longToken: SECRET } });
const leadGet = await call("site_lead_settings", { siteId: "s1" });
const cd = { connectionId: "c1", kind: "demo_send", params: { phone: "{{var.phone}}" } };
const leadPut = await call("site_lead_settings", { siteId: "s1", settings: { notifyBot: true, coreDelivery: cd } });
const tools = (await rpc("tools/list", {}))?.result?.tools ?? [];

child.kill();
srv.close();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows lock */ }

const outputs = [catalog, status, test, foreign, post, list, conn, leadGet, leadPut].map(textOf);
const toolDesc = (n) => JSON.stringify(tools.find((t) => t.name === n) ?? {});
const checks = [
  ["catalog: GET /api/integrations/catalog", !!req("GET", "/api/integrations/catalog") && textOf(catalog).includes("demo_send")],
  ["catalog: флаг secret:true в схеме сохранён", textOf(catalog).includes('"secret": true')],
  ["status: GET /api/integrations/c1/status", !!req("GET", "/api/integrations/c1/status") && textOf(status).includes('"status": "OK"')],
  ["test: POST /api/integrations/c1/test", !!req("POST", "/api/integrations/c1/test") && textOf(test).includes("NEEDS_REAUTH")],
  ["status/test: без тела запроса", req("GET", "/api/integrations/c1/status")?.body === null && req("POST", "/api/integrations/c1/test")?.body === null],
  ["чужое подключение: 403 → ошибка", foreign?.result?.isError === true && textOf(foreign).includes("403")],
  ["test без connectionId: ошибка до запроса", noId?.result?.isError === true && !seen.some((s) => s.url === "/api/integrations//test")],
  ["channel_post: POST linked-chats/{chatId}/post", post?.result?.isError !== true && textOf(post).includes('"messageId": 77')],
  ["channel_post: тело {text, mediaUrl}", JSON.stringify(req("POST", "/api/bots/b1/linked-chats/-1001234567890/post")?.body) === JSON.stringify({ text: "Новый пост", mediaUrl: "https://bots.retensy.com/media/x.jpg" })],
  ["channel_post: пустой пост — ошибка до запроса", empty?.result?.isError === true && seen.filter((s) => s.url.endsWith("/post")).length === 1],
  ["channel_post: нечисловой chatId — ошибка", badChat?.result?.isError === true],
  ["connect: connectionId и маска на месте", textOf(conn).includes('"connectionId": "c2"') && textOf(conn).includes("…5678")],
  ["connect: креды ушли в POST", req("POST", "/api/bots/integrations")?.body?.creds?.longToken === SECRET],
  ["lead-settings GET: coreConnections видны", textOf(leadGet).includes("coreConnections") && textOf(leadGet).includes('"provider": "demo"')],
  ["lead-settings PUT: coreDelivery в теле как есть", JSON.stringify(req("PUT", "/api/bots/pages/s1/lead-settings")?.body?.coreDelivery) === JSON.stringify(cd)],
  ["вывод инструментов без секретов", outputs.every((t) => !t.includes(SECRET) && !t.includes("credsEnc") && !/"creds"/.test(t))],
  ["описания: новые инструменты в tools/list", ["integration_catalog", "integration_status", "integration_test", "channel_post"].every((n) => tools.some((t) => t.name === n))],
  ["описание integration_test: живая проверка от имени владельца", toolDesc("integration_test").includes("ЖИВУЮ") && toolDesc("integration_test").includes("от имени владельца")],
  ["описание connect_integration: зашифрованы, не возвращаются", toolDesc("connect_integration").includes("зашифрованными") && toolDesc("connect_integration").includes("НИКОГДА не возвращаются")],
  ["схема site_lead_settings: coreDelivery", toolDesc("site_lead_settings").includes("coreDelivery")],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? `  ok  ${name}` : `  FAIL  ${name}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`integration-core FAIL: провалено проверок — ${failed}\n${outputs.join("\n---\n")}`);
  process.exit(1);
}
console.log("integration-core OK");
process.exit(0);
