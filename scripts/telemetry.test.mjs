#!/usr/bin/env node
/**
 * Тест отчётов о неудачах: проверяет, что отчёт уходит на webhook и что в нём
 * НЕТ СЕКРЕТОВ. Это security-путь — ломать его молча нельзя, поэтому он в CI.
 *
 * Webhook подменяется на локальный сервер (RETENSY_MCP_REPORT_URL), домашний каталог —
 * на временный (HOME/USERPROFILE), чтобы set_token не трогал реальный ~/.retensy-bot-graph/token.
 * Выход 0 — ок, 1 — провал.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_TOKEN = "zmcp_ENVTOKEN_MUST_NOT_LEAK";
const ARG_TOKEN = "zmcp_ARGTOKEN_MUST_NOT_LEAK";

const captured = [];
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    captured.push({ body, auth: req.headers.authorization || null });
    res.writeHead(204); res.end();
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const hookUrl = `http://127.0.0.1:${srv.address().port}/hook`;

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-test-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: {
    ...process.env,
    HOME: home, USERPROFILE: home,          // изолируем файл токена от реального
    RETENSY_MCP_TOKEN: ENV_TOKEN,
    RETENSY_MCP_REPORT_URL: hookUrl,
    RETENSY_MCP_TELEMETRY: "on",
    RETENSY_MCP_AUTOUPDATE: "0",
  },
  stdio: ["pipe", "pipe", "ignore"],
});
createInterface({ input: child.stdout }).on("line", () => {});

const call = (id, name, args) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");

call(1, "definitely_not_a_tool", { wish: "функция, которой нет" });   // → unknown_tool
call(2, "set_token", { token: ARG_TOKEN });                          // секрет в аргументах
call(3, "list_graphs", { botId: "bot-does-not-exist" });              // ошибка API

await new Promise((r) => setTimeout(r, 6000));
child.kill();

// Фаза 2: токена НЕТ вовсе — это обычное состояние нового пользователя, а не пробел
// в возможностях. Такие неудачи отправляться НЕ должны (иначе новички зашумят канал).
const noAuthHome = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-noauth-"));
const before = captured.length;
const child2 = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: {
    HOME: noAuthHome, USERPROFILE: noAuthHome,
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,   // без RETENSY_MCP_TOKEN
    RETENSY_MCP_REPORT_URL: hookUrl, RETENSY_MCP_TELEMETRY: "on", RETENSY_MCP_AUTOUPDATE: "0",
  },
  stdio: ["pipe", "pipe", "ignore"],
});
createInterface({ input: child2.stdout }).on("line", () => {});
child2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_bots", arguments: {} } }) + "\n");
await new Promise((r) => setTimeout(r, 4000));
child2.kill();
const noAuthReports = captured.length - before;

srv.close();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows lock */ }
try { fs.rmSync(noAuthHome, { recursive: true, force: true }); } catch { /* windows lock */ }

const all = captured.map((c) => c.body).join("\n");
const parsed = captured.map((c) => { try { return JSON.parse(c.body); } catch { return null; } });
const titles = parsed.map((p) => (p ? `${p.tool} — ${p.category}` : "<битый payload>"));

const checks = [
  ["отчёт вообще отправлен", captured.length >= 1],
  ["payload — валидный JSON по контракту /api/mcp/report", parsed.every((p) => p && p.tool && p.category && p.mcpVersion)],
  ["неизвестный инструмент помечен unknown_tool", parsed.some((p) => p?.category === "unknown_tool")],
  ["имя запрошенного инструмента передано", parsed.some((p) => p?.tool === "definitely_not_a_tool")],
  ["токен из ENV не утёк в тело", !all.includes("ENVTOKEN_MUST_NOT_LEAK")],
  ["токен из аргументов не утёк в тело", !all.includes("ARGTOKEN_MUST_NOT_LEAK")],
  ["нет подстроки zmcp_ в теле", !all.includes("zmcp_")],
  ["есть анонимный installId", parsed.every((p) => /^[0-9a-f]{8}$/.test(p?.installId || ""))],
  ["ненастроенный токен НЕ шлёт отчёт", noAuthReports === 0],
  ["отвергнутый токен помечен auth_rejected", parsed.some((p) => p?.category === "auth_rejected")],
  // Токен прикладывается для атрибуции, но ТОЛЬКО когда приёмник — наш же BASE.
  // Здесь REPORT_URL подменён на localhost, значит заголовка быть не должно.
  ["на сторонний REPORT_URL токен не отправляется", captured.every((c) => !c.auth)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? `  ok  ${name}` : `  FAIL  ${name}`);
  if (!ok) failed += 1;
}
console.log(`отчётов получено: ${captured.length} → ${titles.join(" | ")}`);

if (failed) { console.error(`telemetry FAIL: провалено проверок — ${failed}`); process.exit(1); }
console.log("telemetry OK");
process.exit(0);
