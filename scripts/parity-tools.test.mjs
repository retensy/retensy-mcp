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
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url.endsWith("/settings")) return json(200, { settings: { color: "#000", title: "Чат" } });
    if (req.method === "GET" && /\/booking\/calendars\/[0-9a-f-]{36}$/.test(req.url)) {
      return json(200, { id: "cal", name: "Клиника", zone: "Europe/Moscow", slotMinutes: 30, hours: [{ day: 1, from: "09:00", to: "18:00" }], exceptions: [] });
    }
    if (req.method === "POST" && req.url.endsWith("/bookings") && body?.slotAt?.startsWith("2026-10-12T16")) return json(409, { error: "CONFLICT: слот уже занят" });
    json(200, { ok: true, id: "x1" });
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

const S = "22222222-2222-4333-8444-555555555555", L = "33333333-2222-4333-8444-555555555555";
await call("site_lead_status", { siteId: S, leadId: L, status: "in_progress" });
check("site_lead_status → PATCH {status} в верхнем регистре", req("PATCH", `/api/bots/pages/${S}/leads/${L}`)?.body?.status === "IN_PROGRESS");
check("site_lead_status неизвестный статус — ошибка", isErr(await call("site_lead_status", { siteId: S, leadId: L, status: "WON" })));
await call("site_leads", { siteId: S, status: "done" });
check("site_leads status → ?status=DONE", !!req("GET", `/api/bots/pages/${S}/leads?status=DONE`));

const C = "44444444-2222-4333-8444-555555555555", K = "55555555-2222-4333-8444-555555555555";
const calPath = `/api/bots/booking/calendars/${C}`;
await call("booking_calendar_list", {});
check("booking_calendar_list → GET", !!req("GET", "/api/bots/booking/calendars"));
await call("booking_calendar_get", { calendarId: C });
check("booking_calendar_get → GET по id", !!req("GET", calPath));
check("booking_calendar_get не UUID — ошибка до запроса", isErr(await call("booking_calendar_get", { calendarId: "../x" })) && none("../x"));
await call("booking_calendar_create", { name: " Клиника ", slotMinutes: 30, hours: [{ day: 1, from: "09:00", to: "13:00" }, { day: 1, from: "14:00", to: "18:00" }], exceptions: [{ date: "2026-12-31" }] });
const cc = req("POST", "/api/bots/booking/calendars")?.body;
check("booking_calendar_create → POST с окнами и выходным", cc?.name === "Клиника" && cc?.hours?.length === 2 && cc?.exceptions?.[0]?.date === "2026-12-31" && !("from" in cc.exceptions[0]));
check("booking_calendar_create без name — ошибка", isErr(await call("booking_calendar_create", { slotMinutes: 30 })));
check("booking_calendar_create day=8 — ошибка", isErr(await call("booking_calendar_create", { name: "x", hours: [{ day: 8, from: "09:00", to: "10:00" }] })));
check("booking_calendar_create время 9:00 — ошибка", isErr(await call("booking_calendar_create", { name: "x", hours: [{ day: 1, from: "9:00", to: "10:00" }] })));
check("booking_calendar_create slotMinutes=1 — ошибка", isErr(await call("booking_calendar_create", { name: "x", slotMinutes: 1 })));
await call("booking_calendar_update", { calendarId: C, slotMinutes: 45 });
const cu = req("PUT", calPath)?.body;
check("booking_calendar_update → PUT: новое поле + прежние hours/zone", cu?.slotMinutes === 45 && cu?.hours?.length === 1 && cu?.zone === "Europe/Moscow" && cu?.name === "Клиника");
check("booking_calendar_update без полей — ошибка", isErr(await call("booking_calendar_update", { calendarId: C })));
check("booking_calendar_delete без confirm — ошибка", isErr(await call("booking_calendar_delete", { calendarId: C })) && !req("DELETE", calPath));
await call("booking_calendar_delete", { calendarId: C, confirm: true });
check("booking_calendar_delete confirm → DELETE", !!req("DELETE", calPath));
await call("booking_slots", { calendarId: C, from: "2026-10-12", to: "2026-10-14", limit: 10 });
check("booking_slots → GET ?from&to&limit", !!req("GET", `${calPath}/slots?from=2026-10-12&to=2026-10-14&limit=10`));
check("booking_slots кривая дата — ошибка", isErr(await call("booking_slots", { calendarId: C, from: "12.10.2026" })));
await call("booking_list", { calendarId: C, from: "2026-10-01" });
check("booking_list → GET ?from", !!req("GET", `${calPath}/bookings?from=2026-10-01`));
await call("booking_create", { calendarId: C, slotAt: "2026-10-12T15:00:00+03:00", name: "Анна", phone: "+79990000000" });
check("booking_create → POST {slotAt,name,phone}", req("POST", `${calPath}/bookings`)?.body?.phone === "+79990000000");
const taken = await call("booking_create", { calendarId: C, slotAt: "2026-10-12T16:00:00+03:00" });
check("booking_create 409 → «уже занят»", isErr(taken) && /занят/.test(textOf(taken)));
check("booking_create slotAt без зоны — ошибка", isErr(await call("booking_create", { calendarId: C, slotAt: "2026-10-12T15:00" })));
await call("booking_cancel", { calendarId: C, bookingId: K });
check("booking_cancel → POST cancel", !!req("POST", `${calPath}/bookings/${K}/cancel`));

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
