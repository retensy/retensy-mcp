#!/usr/bin/env node
/**
 * Паритет MCP с платформой, часть 2: имя/токен бота, доп. каналы, стартовые ссылки, UTM и A/B, удаление базы
 * и агента, снятие агента, заявки сайта (прочитано/удаление/CSV), выгрузка подписчиков, сброс сессии.
 * Аргументы → метод, путь и тело; проверки и confirm — до запроса; 400/403/404/409 — понятная ошибка.
 * API подменяется локальным сервером. Выход 0 — ок, 1 — провал.
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
const CHAT = "7110953144424190";
const B = "11111111-2222-4333-8444-555555555555";
const MISSING = "99999999-2222-4333-8444-555555555555"; // → 404
const FOREIGN = "88888888-2222-4333-8444-555555555555"; // → 403
const S = "22222222-2222-4333-8444-555555555555", L = "33333333-2222-4333-8444-555555555555";
const G = "44444444-2222-4333-8444-555555555555", N = "55555555-2222-4333-8444-555555555555";
const CH = "66666666-2222-4333-8444-555555555555", LK = "77777777-2222-4333-8444-555555555555";
const BAD_TOKEN = "123:bad_secret_value";
const CSV = "name,phone\nАнна,+79990000000\n";

const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    seen.push({ method: req.method, url: req.url, body });
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const text = (code, t, type = "text/plain") => { res.writeHead(code, { "Content-Type": type }); res.end(t); };
    if (req.url.includes(MISSING)) return json(404, { error: "Not Found" });
    if (req.url.includes(FOREIGN)) return json(403, { error: "Forbidden" });
    if (req.url.endsWith("/token") && body?.token === BAD_TOKEN) return text(400, "Invalid bot token: Unauthorized");
    if (req.url.endsWith("/channels") && req.method === "POST" && body?.token === BAD_TOKEN) return text(400, "Токен уже подключён");
    if (req.method === "DELETE" && req.url === "/api/bots/kb/agent_kb") return json(409, { error: "x", code: "KB_OWNED_BY_AGENT" });
    if (req.method === "DELETE" && req.url === "/api/bots/agents/busy") {
      return json(409, { error: "x", code: "AGENT_IN_USE", scenarios: [{ botId: B, graphId: G, graphName: "Воронка", live: true }] });
    }
    if (req.url.endsWith("/leads.csv")) return text(200, CSV, "text/csv");
    if (req.url.includes("/users/export?format=csv")) return text(200, "chatId,tags\n1,vip\n", "text/csv");
    if (req.url.includes("/users/export?format=json")) return json(200, [{ chatId: 1, tags: ["vip"] }]);
    if (req.method === "DELETE" || req.url.endsWith("/leads/read")) {
      res.writeHead(req.url.includes("/leads/") ? 204 : 200);
      return res.end();
    }
    json(200, { ok: true, id: "x1" });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-p2-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_p2",
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
const none = (frag) => !seen.some((s) => s.url.includes(frag));

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "  ok " : "  FAIL"} ${name}`); if (!cond) failed++; };

// ---- бот: имя и токен ----
await call("bot_rename", { botId: B, name: "Продажи" });
check("bot_rename → PATCH {name}", req("PATCH", `/api/bots/${B}`)?.body?.name === "Продажи");
await call("bot_rename", { botId: B, name: "" });
check("bot_rename пустое имя уходит как сброс", seen.filter((s) => s.method === "PATCH" && s.url === `/api/bots/${B}`).at(-1)?.body?.name === "");
check("bot_rename без name — ошибка", isErr(await call("bot_rename", { botId: B })));
check("bot_rename botId не UUID — ошибка до запроса", isErr(await call("bot_rename", { botId: "../x", name: "a" })) && none("../x"));
const r404 = await call("bot_rename", { botId: MISSING, name: "a" });
check("bot_rename 404 → ошибка с HTTP 404", isErr(r404) && /HTTP 404/.test(textOf(r404)));
const r403 = await call("bot_rename", { botId: FOREIGN, name: "a" });
check("bot_rename 403 → «Доступ отклонён»", isErr(r403) && /Доступ отклонён \(HTTP 403\)/.test(textOf(r403)));

await call("bot_change_token", { botId: B, token: " 123:good " });
check("bot_change_token → POST {token} без пробелов", req("POST", `/api/bots/${B}/token`)?.body?.token === "123:good");
const badTok = await call("bot_change_token", { botId: B, token: BAD_TOKEN });
check("bot_change_token 400 → причина, без самого токена",
  isErr(badTok) && /Токен не принят: Invalid bot token/.test(textOf(badTok)) && !textOf(badTok).includes("bad_secret"));
check("bot_change_token пустой токен — ошибка до запроса", isErr(await call("bot_change_token", { botId: S, token: "  " })) && none(`${S}/token`));

// ---- дополнительные каналы ----
await call("bot_channel_list", { botId: B });
check("bot_channel_list → GET channels", !!req("GET", `/api/bots/${B}/channels`));
await call("bot_channel_add", { botId: B, token: "1:t", name: "Резерв" });
check("bot_channel_add → POST {token,name}", req("POST", `/api/bots/${B}/channels`)?.body?.name === "Резерв");
const chBad = await call("bot_channel_add", { botId: B, token: BAD_TOKEN });
check("bot_channel_add 400 → причина", isErr(chBad) && /Канал не добавлен: Токен уже подключён/.test(textOf(chBad)));
check("bot_channel_delete без confirm — ошибка до запроса",
  isErr(await call("bot_channel_delete", { botId: B, channelId: CH })) && !req("DELETE", `/api/bots/${B}/channels/${CH}`));
await call("bot_channel_delete", { botId: B, channelId: CH, confirm: true });
check("bot_channel_delete confirm → DELETE", !!req("DELETE", `/api/bots/${B}/channels/${CH}`));

// ---- стартовые ссылки ----
await call("link_create", { botId: B, name: "Reels", targetNodeId: N });
const lc = req("POST", `/api/bots/${B}/links`)?.body;
check("link_create → POST {name,targetNodeId}", lc?.name === "Reels" && lc?.targetNodeId === N);
check("link_create кривой targetNodeId — ошибка", isErr(await call("link_create", { botId: B, targetNodeId: "n1" })));
check("link_delete без confirm — ошибка", isErr(await call("link_delete", { linkId: LK })) && !req("DELETE", `/api/bots/links/${LK}`));
await call("link_delete", { linkId: LK, confirm: true });
check("link_delete confirm → DELETE /api/bots/links/{id}", !!req("DELETE", `/api/bots/links/${LK}`));

// ---- аналитика ----
await call("utm_sources", { botId: B });
check("utm_sources → GET utm-sources", !!req("GET", `/api/bots/${B}/utm-sources`));
await call("ab_results", { graphId: G, branchNodeId: N, period: "30d" });
check("ab_results → GET ?branchNodeId&period", !!req("GET", `/api/bots/graphs/${G}/ab-results?branchNodeId=${N}&period=30d`));
check("ab_results без branchNodeId — ошибка", isErr(await call("ab_results", { graphId: G })));
check("ab_results period=week — ошибка", isErr(await call("ab_results", { graphId: G, branchNodeId: N, period: "week" })));

// ---- база знаний и агент ----
check("kb_delete без confirm — ошибка до запроса", isErr(await call("kb_delete", { kbId: "kb1" })) && !req("DELETE", "/api/bots/kb/kb1"));
await call("kb_delete", { kbId: "kb1", confirm: true });
check("kb_delete confirm → DELETE", !!req("DELETE", "/api/bots/kb/kb1"));
const kbAgent = await call("kb_delete", { kbId: "agent_kb", confirm: true });
check("kb_delete 409 → KB_OWNED_BY_AGENT с подсказкой", isErr(kbAgent) && /KB_OWNED_BY_AGENT/.test(textOf(kbAgent)) && /agent_delete/.test(textOf(kbAgent)));
check("kb_delete kbId с «/» — ошибка до запроса", isErr(await call("kb_delete", { kbId: "a/b", confirm: true })) && none("a/b"));

await call("agent_unpublish", { agentId: "ag1" });
check("agent_unpublish → POST unpublish", !!req("POST", "/api/bots/agents/ag1/unpublish"));
check("agent_delete без confirm — ошибка", isErr(await call("agent_delete", { agentId: "ag1" })) && !req("DELETE", "/api/bots/agents/ag1"));
await call("agent_delete", { agentId: "ag1", confirm: true });
check("agent_delete confirm → DELETE", !!req("DELETE", "/api/bots/agents/ag1"));
const busy = await call("agent_delete", { agentId: "busy", confirm: true });
check("agent_delete 409 → AGENT_IN_USE со сценариями", isErr(busy) && /AGENT_IN_USE/.test(textOf(busy)) && /Воронка/.test(textOf(busy)));

// ---- заявки сайта ----
const mr = await call("site_leads_mark_read", { siteId: S });
check("site_leads_mark_read → POST leads/read", !!req("POST", `/api/bots/pages/${S}/leads/read`) && !isErr(mr));
check("site_lead_delete без confirm — ошибка",
  isErr(await call("site_lead_delete", { siteId: S, leadId: L })) && !req("DELETE", `/api/bots/pages/${S}/leads/${L}`));
const ld = await call("site_lead_delete", { siteId: S, leadId: L, confirm: true });
check("site_lead_delete confirm → DELETE (204)", !!req("DELETE", `/api/bots/pages/${S}/leads/${L}`) && !isErr(ld));
const ld404 = await call("site_lead_delete", { siteId: S, leadId: MISSING, confirm: true });
check("site_lead_delete 404 → ошибка", isErr(ld404) && /HTTP 404/.test(textOf(ld404)));
const csv = await call("site_leads_export", { siteId: S });
check("site_leads_export → CSV текстом", textOf(csv) === CSV);
const csvPath = join(home, "out", "leads.csv");
const saved = await call("site_leads_export", { siteId: S, savePath: csvPath });
check("site_leads_export savePath → файл", !isErr(saved) && fs.readFileSync(csvPath, "utf8") === CSV);

// ---- подписчики ----
await call("bot_users_export", { botId: B });
check("bot_users_export по умолчанию csv", !!req("GET", `/api/bots/${B}/users/export?format=csv`));
const uj = await call("bot_users_export", { botId: B, format: "JSON" });
check("bot_users_export json → массив", !!req("GET", `/api/bots/${B}/users/export?format=json`) && /"vip"/.test(textOf(uj)));
check("bot_users_export format=xml — ошибка", isErr(await call("bot_users_export", { botId: B, format: "xml" })));
check("bot_user_reset без confirm — ошибка",
  isErr(await call("bot_user_reset", { botId: B, chatId: CHAT })) && !req("DELETE", `/api/bots/${B}/sessions/${CHAT}`));
await call("bot_user_reset", { botId: B, chatId: CHAT, confirm: true });
check("bot_user_reset confirm → DELETE sessions/{chatId} без округления", !!req("DELETE", `/api/bots/${B}/sessions/${CHAT}`));
check("bot_user_reset chatId не число — ошибка", isErr(await call("bot_user_reset", { botId: B, chatId: "abc", confirm: true })));

child.kill(); srv.close();
fs.rmSync(home, { recursive: true, force: true });
if (failed) { console.error(`parity-2: провалов ${failed}`); process.exit(1); }
console.log("parity-2 OK");
