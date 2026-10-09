#!/usr/bin/env node
/**
 * Паритет MCP с платформой: журнал вызовов, передача оператору, статус заявки, правка подключения,
 * настройки виджета, импорт меток/полей, журнал прогонов бота, удаление бота.
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
    seen.push({ method: req.method, url: req.url, body, raw });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url.endsWith("/settings") && req.method === "GET" ? { settings: { color: "#000", title: "Чат" } } : { ok: true, id: "x1" }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-pt-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_pt",
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

const B = "11111111-2222-4333-8444-555555555555";
const none = (frag) => !seen.some((s) => s.url.includes(frag));

await call("integration_calls", { connectionId: "c_1", ok: false, limit: 50 });
check("integration_calls → GET с фильтрами", !!req("GET", "/api/bots/integrations/calls?connectionId=c_1&ok=false&limit=50"));
await call("integration_calls", {});
check("integration_calls без фильтров", !!req("GET", "/api/bots/integrations/calls"));
check("integration_calls limit вне 1–200 — ошибка", isErr(await call("integration_calls", { limit: 500 })));
check("integration_calls кривой connectionId — ошибка до запроса", isErr(await call("integration_calls", { connectionId: "../x" })) && none("../x"));

await call("dialog_handoff", { botId: B, chatId: CHAT, active: true });
check("dialog_handoff → POST {active:true}, chatId без округления", req("POST", `/api/bots/${B}/users/${CHAT}/handoff`)?.body?.active === true);
check("dialog_handoff без active — ошибка", isErr(await call("dialog_handoff", { botId: B, chatId: CHAT })));
check("dialog_handoff botId не UUID — ошибка", isErr(await call("dialog_handoff", { botId: "b1", chatId: CHAT, active: false })) && none("/api/bots/b1/"));

await call("site_lead_status", { siteId: "s1", leadId: "l1", status: "in_progress" });
check("site_lead_status → PATCH {status} в верхнем регистре", req("PATCH", "/api/bots/pages/s1/leads/l1")?.body?.status === "IN_PROGRESS");
check("site_lead_status неизвестный статус — ошибка", isErr(await call("site_lead_status", { siteId: "s1", leadId: "l1", status: "WON" })));

await call("integration_update", { connectionId: "c_1", title: " CRM ", creds: { apiKey: 123 } });
const upd = req("PUT", "/api/bots/integrations/c_1")?.body;
check("integration_update → PUT {title, creds строками}", upd?.title === "CRM" && upd?.creds?.apiKey === "123");
check("integration_update без полей — ошибка", isErr(await call("integration_update", { connectionId: "c_2" })) && none("c_2"));

await call("web_widget_settings", { botId: B });
check("web_widget_settings чтение → GET", !!req("GET", `/api/bots/web/${B}/settings`));
await call("web_widget_settings", { botId: B, settings: { color: "#fff" } });
const ws = req("PUT", `/api/bots/web/${B}/settings`)?.body;
check("web_widget_settings правка → PUT с наложением на текущие", ws?.color === "#fff" && ws?.title === "Чат");

await call("bot_users_import", { botId: B, rows: [{ chatId: CHAT, tags: ["vip"], variables: { city: "Москва" } }] });
const imp = req("POST", `/api/bots/${B}/users/import`);
check("bot_users_import → chatId числом без округления", imp?.raw?.includes(`"chatId":${CHAT}`) && imp?.raw?.includes('"tags":["vip"]'));
check("bot_users_import chatId не число — ошибка", isErr(await call("bot_users_import", { botId: B, rows: [{ chatId: "-5" }] })));
check("bot_users_import пустые rows — ошибка", isErr(await call("bot_users_import", { botId: B, rows: [] })));

await call("bot_runs", { botId: B, page: 1, size: 10 });
check("bot_runs список → GET runs?page&size", !!req("GET", `/api/bots/${B}/runs?page=1&size=10`));
await call("bot_runs", { runId: "r1" });
check("bot_runs по runId → GET /api/bots/runs/r1", !!req("GET", "/api/bots/runs/r1"));

const noConfirm = await call("bot_delete", { botId: B });
check("bot_delete без confirm — ошибка до запроса", isErr(noConfirm) && !req("DELETE", `/api/bots/${B}`));
await call("bot_delete", { botId: B, confirm: true });
check("bot_delete confirm:true → DELETE", !!req("DELETE", `/api/bots/${B}`));

child.kill(); srv.close();
if (failed) { console.error(`parity-tools: провалов ${failed}`); process.exit(1); }
console.log("parity-tools OK");
