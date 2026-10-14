#!/usr/bin/env node
/**
 * wave/audit-1014: аудитория (поиск/фильтр/теги/переменные/экспорт), поиск по диалогам, квота публикаций,
 * VK, миграция подписчиков, booking_confirm/reject, broadcast_group — аргументы → метод/путь/тело,
 * ошибки — до запроса. API подменяется локальным сервером. Выход 0 — ок, 1 — провал.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seen = [];

const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const ct = req.headers["content-type"] || "";
    let body = null;
    if (ct.includes("application/json")) {
      try { body = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch { body = raw.toString("utf8"); }
    } else if (ct.includes("multipart/form-data")) {
      body = { multipart: true, raw: raw.toString("latin1") }; // достаточно знать, что файл дошёл
    } else {
      body = raw.toString("utf8");
    }
    seen.push({ method: req.method, url: req.url, body });
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const bin = (code, type) => { res.writeHead(code, { "Content-Type": type }); res.end(Buffer.from("PK\x03\x04binary-xlsx-stub")); };
    if (req.method === "GET" && req.url === "/api/bots") {
      return json(200, [{ id: "11111111-2222-4333-8444-555555555555", name: "MyBot", platform: "TELEGRAM" }]);
    }
    if (req.method === "POST" && req.url.endsWith("/users/export") && body?.format === "xlsx") {
      return bin(200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }
    if (req.method === "POST" && req.url === "/api/bots/subscribers/export" && body?.format === "xlsx") {
      return bin(200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }
    if (req.method === "POST" && req.url.endsWith("/users/export")) {
      res.writeHead(200, { "Content-Type": "text/csv;charset=UTF-8" });
      return res.end("chatId;username\n1;ivan\n");
    }
    if (req.method === "POST" && req.url === "/api/bots/subscribers/export") {
      res.writeHead(200, { "Content-Type": "text/csv;charset=UTF-8" });
      return res.end("bot;chatId;username\nMyBot;1;ivan\n");
    }
    if (req.method === "POST" && /\/bookings\/[0-9a-f-]{36}\/confirm$/.test(req.url) && req.url.includes("NOTPENDING")) return json(409, { error: "not pending" });
    if (req.method === "POST" && /\/bookings\/[0-9a-f-]{36}\/(confirm|reject)$/.test(req.url) && req.url.includes("MISSING")) { res.writeHead(404); return res.end(); }
    if (req.method === "POST" && /\/bookings\/[0-9a-f-]{36}\/(confirm|reject)$/.test(req.url)) { res.writeHead(204); return res.end(); }
    if (req.method === "GET" && /\/broadcasts\/group\/[0-9a-f-]{36}\/?$/.test(req.url)) return json(200, { id: "g1", status: "RUNNING", perBot: [] });
    if (req.method === "POST" && req.url.endsWith("/broadcasts/group-preview")) return json(200, { totalRecipients: 10, uniqueRecipients: 8, perBot: [], limit: 50000 });
    if (req.method === "POST" && /\/broadcasts\/group\/[0-9a-f-]{36}\/cancel$/.test(req.url) && req.url.includes("DONE")) return json(409, {});
    if (req.method === "POST" && /\/broadcasts\/group\/[0-9a-f-]{36}\/(pause|resume|cancel)$/.test(req.url)) { res.writeHead(200); return res.end(); }
    if (req.method === "GET" && req.url === "/api/bots/vk/status") return json(200, { connected: true, accounts: [] });
    if (req.method === "POST" && req.url === "/api/bots/vk/connect-token") return json(200, { id: "acc1", platform: "vk" });
    json(200, { ok: true, id: "x1" });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-aud-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_aud",
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

const B = "11111111-2222-4333-8444-555555555555";
const C = "44444444-2222-4333-8444-555555555555";
const G = "66666666-2222-4333-8444-555555555555";

// ---- audience ----
await call("audience_fields", { botId: B, search: "plan", limit: 20 });
check("audience_fields → GET с search/limit", !!req("GET", `/api/bots/${B}/audience/fields?search=plan&limit=20`));
check("audience_fields limit вне диапазона — ошибка", isErr(await call("audience_fields", { botId: B, limit: 999 })));

await call("audience_search", { botId: B, q: "ivan", page: 1, size: 50 });
check("audience_search с botId → POST per-bot search", req("POST", `/api/bots/${B}/users/search`)?.body?.q === "ivan");
await call("audience_search", { botIds: [B], filter: { tagsAll: ["vip"] } });
check("audience_search без botId → POST subscribers/search (кросс-бот)", req("POST", "/api/bots/subscribers/search")?.body?.filter?.tagsAll?.[0] === "vip");

await call("audience_tag_edit", { botId: B, chatIds: ["12345678901234567890"], add: ["vip"], remove: ["cold"] });
check("audience_tag_edit → POST {chatIds,add,remove} без округления chatId",
  req("POST", `/api/bots/${B}/users/tags`)?.body?.chatIds?.[0] === "12345678901234567890");
check("audience_tag_edit без add/remove — ошибка", isErr(await call("audience_tag_edit", { botId: B, chatIds: ["1"] })));
check("audience_tag_edit без chatIds — ошибка", isErr(await call("audience_tag_edit", { botId: B, add: ["x"] })));

await call("audience_variable_edit", { botId: B, chatIds: ["1"], set: { plan: "pro" }, unset: ["old"] });
check("audience_variable_edit → POST {chatIds,set,unset}", req("POST", `/api/bots/${B}/users/variables`)?.body?.set?.plan === "pro");
check("audience_variable_edit без set/unset — ошибка", isErr(await call("audience_variable_edit", { botId: B, chatIds: ["1"] })));

const csvRes = await call("audience_export", { botId: B, format: "csv" });
check("audience_export csv без savePath → текстом", textOf(csvRes).includes("chatId;username"));
check("audience_export xlsx без savePath — ошибка (бинарный формат)", isErr(await call("audience_export", { botId: B, format: "xlsx" })));
const xlsxPath = join(home, "export.xlsx");
const xlsxRes = await call("audience_export", { botId: B, format: "xlsx", savePath: xlsxPath });
check("audience_export xlsx с savePath → файл записан", !isErr(xlsxRes) && fs.existsSync(xlsxPath) && fs.statSync(xlsxPath).size > 0);
await call("audience_export", { format: "csv" });
check("audience_export без botId → кросс-бот POST /subscribers/export", !!req("POST", "/api/bots/subscribers/export"));

// ---- dialogs ----
await call("dialog_search", { q: "иван", limit: 10 });
check("dialog_search → GET с q/limit", !!req("GET", "/api/bots/dialogs/search?q=%D0%B8%D0%B2%D0%B0%D0%BD&limit=10"));
check("dialog_search без q — ошибка", isErr(await call("dialog_search", {})));
check("dialog_search limit вне диапазона — ошибка", isErr(await call("dialog_search", { q: "x", limit: 999 })));

// ---- publications / VK ----
await call("publications_usage", { botId: B });
check("publications_usage → GET usage", !!req("GET", `/api/bots/${B}/publications/usage`));
await call("vk_status", {});
check("vk_status → GET /api/bots/vk/status", !!req("GET", "/api/bots/vk/status"));
await call("vk_connect", { communityId: "123", accessToken: "tok" });
check("vk_connect → POST connect-token", req("POST", "/api/bots/vk/connect-token")?.body?.communityId === "123");
check("vk_connect без accessToken — ошибка", isErr(await call("vk_connect", { communityId: "123" })));
await call("vk_disconnect", { accountId: "acc1" });
check("vk_disconnect → DELETE /api/bots/vk/{id}", !!req("DELETE", "/api/bots/vk/acc1"));
await call("vk_post", { accountId: "acc1", text: "привет" });
check("vk_post → POST {accountId,text}", req("POST", "/api/bots/vk/post")?.body?.text === "привет");
check("vk_post пустой пост — ошибка", isErr(await call("vk_post", { accountId: "acc1" })));

// ---- migration ----
await call("migration_presets", {});
check("migration_presets → GET presets", !!req("GET", "/api/bots/migration/presets"));
const csvFile = join(home, "sub.csv");
fs.writeFileSync(csvFile, "id;username\n1;ivan\n");
const prevRes = await call("migration_preview", { botId: B, path: csvFile, platform: "GENERIC" });
check("migration_preview без mapping → multipart POST preview (detect)", !isErr(prevRes) && !!reqStarts("POST", `/api/bots/${B}/migration/subscribers/preview`));
check("migration_commit без mapping — ошибка до запроса", isErr(await call("migration_commit", { botId: B, path: csvFile, platform: "GENERIC" })));
const commitRes = await call("migration_commit", { botId: B, path: csvFile, platform: "GENERIC", mapping: { userIdColumn: "id" } });
check("migration_commit с mapping → multipart POST commit", !isErr(commitRes) && !!reqStarts("POST", `/api/bots/${B}/migration/subscribers/commit`));
check("migration_preview несуществующий файл — ошибка до запроса", isErr(await call("migration_preview", { botId: B, path: join(home, "nope.csv"), platform: "GENERIC" })));

// ---- booking confirm/reject ----
await call("booking_confirm", { calendarId: C, bookingId: "77777777-2222-4333-8444-555555555555" });
check("booking_confirm → POST confirm", !!req("POST", `/api/bots/booking/calendars/${C}/bookings/77777777-2222-4333-8444-555555555555/confirm`));
await call("booking_reject", { calendarId: C, bookingId: "77777777-2222-4333-8444-555555555555" });
check("booking_reject → POST reject", !!req("POST", `/api/bots/booking/calendars/${C}/bookings/77777777-2222-4333-8444-555555555555/reject`));

// ---- broadcast_group ----
await call("broadcast_group", { action: "preview", botIds: [B], tagsAll: ["vip"] });
check("broadcast_group preview → POST group-preview", req("POST", "/api/bots/broadcasts/group-preview")?.body?.tagsAll?.[0] === "vip");
await call("broadcast_group", { action: "get", groupId: G });
check("broadcast_group get → GET group/{id}", !!req("GET", `/api/bots/broadcasts/group/${G}`));
await call("broadcast_group", { action: "pause", groupId: G });
check("broadcast_group pause → POST group/{id}/pause", !!req("POST", `/api/bots/broadcasts/group/${G}/pause`));
check("broadcast_group без action — ошибка", isErr(await call("broadcast_group", {})));

child.kill(); srv.close();
if (failed) { console.error(`audience-publications: провалов ${failed}`); process.exit(1); }
console.log("audience-publications OK");
