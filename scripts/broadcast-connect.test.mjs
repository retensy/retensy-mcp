#!/usr/bin/env node
/**
 * Аргументы инструмента → запрос к API: рассылка (broadcast_send) и подключения (connect_integration).
 * Плюс правило «нельзя через API — дай ссылку»: Google OAuth, Instagram, 402 с upgradeUrl.
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
const seen = [];   // {method, url, body}
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=s1";

const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    seen.push({ method: req.method, url: req.url, body });
    const json = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url === "/api/bots") {
      return json(200, [{ id: "b1", name: "Shop", platform: "TELEGRAM" }, { id: "b2", name: "Max", platform: "MAX" },
        { id: "ig", name: "Insta", platform: "INSTAGRAM" }]);
    }
    if (req.method === "POST" && req.url === "/api/bots/broadcasts/direct") {
      if (body?.name === "quota") return json(402, { error: "broadcast_quota_exceeded", count: 7 });
      return json(200, { broadcastIds: ["bc1", "bc2"], totalAudience: 42 });
    }
    if (req.method === "POST" && req.url === "/api/bots/google/auth-url?returnPath=%2Fbots%2Fintegrations") return json(200, { authUrl: AUTH_URL });
    if (req.method === "GET" && req.url === "/api/bots/google/identities") return json(200, ["owner@gmail.com"]);
    if (req.method === "POST" && req.url === "/api/bots/integrations") {
      return json(200, { id: "conn-1", provider: body?.provider, title: body?.title, hint: "…1234" });
    }
    if (req.method === "POST" && req.url === "/api/bots") return json(402, { error: "bot limit", upgradeUrl: "https://bots.retensy.com/bots/subscription" });
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-bc-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: {
    ...process.env, HOME: home, USERPROFILE: home,
    RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_bc",
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
const call = (name, args) => {
  const id = nextId++;
  const reply = new Promise((resolve) => waiting.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  return Promise.race([reply, new Promise((r) => setTimeout(() => r(null), 8000))]);
};
const textOf = (r) => (r?.result?.content ?? []).map((c) => c.text).join("\n");

// 1. Прямая рассылка: сокращения сообщений → формат API, время без пояса → Москва.
const send = await call("broadcast_send", {
  name: "Акция", botIds: ["b1", "b2"], tagsAll: ["vip"], scheduledAt: "2099-01-02T10:00",
  messages: ["Привет, <b>друг</b>!", { type: "photo", url: "https://cdn/x.jpg", text: "подпись", buttons: [{ text: "Купить", url: "https://shop" }, { text: "", url: "" }] },
    { type: "GALLERY", urls: ["https://cdn/1.jpg", "https://cdn/2.jpg"] }],
});
const direct = seen.find((s) => s.url === "/api/bots/broadcasts/direct")?.body;
// 2. Instagram-бот — отказ до запроса.
const ig = await call("broadcast_send", { name: "x", botIds: ["ig"], messages: ["hi"] });
// 3. Галерея с кнопками — понятная ошибка до запроса.
const gal = await call("broadcast_send", { name: "x", botIds: ["b1"], messages: [{ type: "GALLERY", mediaUrls: ["a", "b"], buttons: [{ text: "t", url: "https://u" }] }] });
// 4. 402 квоты — ссылка на тариф.
const quota = await call("broadcast_send", { name: "quota", botIds: ["b1"], messages: ["hi"] });
// 5. Google Таблицы — ссылка OAuth вместо ошибки.
const google = await call("connect_integration", { provider: "google_sheets" });
// 6. Instagram — ссылка на кабинет.
const igConn = await call("connect_integration", { provider: "instagram" });
const igBot = await call("create_bot", { platform: "INSTAGRAM" });
// 7. amoCRM без кредов — какие поля нужны; с кредами — POST с правильным телом.
const amoMissing = await call("connect_integration", { provider: "amocrm", creds: { subdomain: "acme" } });
const amo = await call("connect_integration", { provider: "amoCRM", title: "Продажи", creds: { subdomain: "acme", longToken: "tok" } });
const amoBody = seen.find((s) => s.method === "POST" && s.url === "/api/bots/integrations")?.body;
// 8. Лимит ботов — 402 с upgradeUrl.
const botLimit = await call("create_bot", { platform: "TELEGRAM", token: "1:AA" });

child.kill();
srv.close();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows lock */ }

const checks = [
  ["send: без ошибки", send && send.result?.isError !== true],
  ["send: botIds", JSON.stringify(direct?.botIds) === '["b1","b2"]'],
  ["send: tagsAll/tagsNone", JSON.stringify(direct?.tagsAll) === '["vip"]' && Array.isArray(direct?.tagsNone) && direct.tagsNone.length === 0],
  ["send: scheduledAt без пояса → +03:00", direct?.scheduledAt === "2099-01-02T07:00:00.000Z"],
  ["send: строка → TEXT/HTML", direct?.messages?.[0]?.type === "TEXT" && direct.messages[0].text === "Привет, <b>друг</b>!" && direct.messages[0].parseMode === "HTML"],
  ["send: photo → PHOTO, url → mediaUrl+photoUrl", direct?.messages?.[1]?.type === "PHOTO" && direct.messages[1].mediaUrl === "https://cdn/x.jpg" && direct.messages[1].photoUrl === "https://cdn/x.jpg"],
  ["send: пустая кнопка отброшена", direct?.messages?.[1]?.buttons?.length === 1],
  ["send: GALLERY urls → mediaUrls, без buttons", JSON.stringify(direct?.messages?.[2]?.mediaUrls) === '["https://cdn/1.jpg","https://cdn/2.jpg"]' && direct.messages[2].buttons === undefined],
  ["send: ответ API отдан", textOf(send).includes("totalAudience")],
  ["instagram-рассылка: ошибка", ig?.result?.isError === true && textOf(ig).includes("Instagram")],
  ["галерея с кнопками: ошибка до запроса", gal?.result?.isError === true && textOf(gal).includes("GALLERY")],
  ["402: ссылка на тариф", quota?.result?.isError === true && textOf(quota).includes("HTTP 402") && textOf(quota).includes(`${BASE}/bots/subscription`) && textOf(quota).includes("квота")],
  ["google: не ошибка, а ссылка OAuth", google?.result?.isError !== true && textOf(google).includes(AUTH_URL) && textOf(google).includes("needsBrowser")],
  ["google: видны уже подключённые аккаунты", textOf(google).includes("owner@gmail.com")],
  ["instagram-подключение: ссылка на кабинет", igConn?.result?.isError !== true && textOf(igConn).includes(`${BASE}/bots/connect`)],
  ["create_bot INSTAGRAM: ссылка на кабинет", igBot?.result?.isError !== true && textOf(igBot).includes(`${BASE}/bots/connect`)],
  ["amo без longToken: список полей", amoMissing?.result?.isError !== true && textOf(amoMissing).includes("longToken") && textOf(amoMissing).includes('"connected": false')],
  ["amo: POST {provider, title, creds}", amoBody?.provider === "AMOCRM" && amoBody?.title === "Продажи" && amoBody?.creds?.longToken === "tok" && amoBody?.creds?.subdomain === "acme"],
  ["amo: вернулся connectionId", textOf(amo).includes('"connectionId": "conn-1"')],
  ["create_bot 402: upgradeUrl", botLimit?.result?.isError === true && textOf(botLimit).includes("https://bots.retensy.com/bots/subscription")],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? `  ok  ${name}` : `  FAIL  ${name}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`broadcast-connect FAIL: провалено проверок — ${failed}\n${JSON.stringify(direct, null, 2)}\n${[send, ig, gal, quota, google, igConn, amoMissing, amo, botLimit].map(textOf).join("\n---\n")}`);
  process.exit(1);
}
console.log("broadcast-connect OK");
process.exit(0);
