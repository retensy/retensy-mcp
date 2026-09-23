#!/usr/bin/env node
/**
 * Аудит H2: PUT активного графа проверяется как публикация и отвечает 422 со ВСЕМИ ошибками.
 * Агент обязан увидеть каждый код — раньше api() отдавал JSON, обрезанный до 600 символов,
 * и хвост ошибок терялся. Тот же форматтер отдаёт и прочие не-2xx: 409 с пустым телом
 * (бот-публикация вебхук-сценария) — статус, а не «null» вместо причины.
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
const CODES = ["EMPTY_MESSAGE", "NO_TRIGGER", "SYNC_CYCLE", "DANGLING_EDGE", "PREMIUM_NODE_FORBIDDEN",
  "NODE_LIMIT_EXCEEDED", "INVOICE_NOT_LAST", "IG_NODE_UNSUPPORTED"];
const errors = CODES.map((code, i) => ({
  nodeId: `node-${i + 1}`,
  code,
  message: `${code}: подробное объяснение, что не так с блоком и как это исправить — длинное, как настоящее`,
}));

const srv = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.method === "PUT" && req.url === "/api/bots/graphs/g-live") {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ publishedGraphId: null, errors, warnings: [] }));
      return;
    }
    if (req.method === "PUT" && req.url === "/api/bots/graphs/g-null") {
      // битый элемент в errors[] не должен прятать сам отказ (TypeError вместо 422)
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ publishedGraphId: null, errors: [null, { nodeId: "n-ok", code: "GRAPH_EMPTY", message: "сценарий пуст" }], warnings: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/bots/graphs/g-hook/publish") {
      res.writeHead(409); res.end(); // как бэкенд: ResponseEntity.status(CONFLICT).build()
      return;
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-422-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: {
    ...process.env,
    HOME: home, USERPROFILE: home,          // изолируем файл токена от реального
    RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_422",
    RETENSY_MCP_TELEMETRY: "off",
    RETENSY_MCP_AUTOUPDATE: "0",
  },
  stdio: ["pipe", "pipe", "ignore"],
});

const waiting = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  waiting.get(m?.id)?.(m);
});
const call = (id, name, args) => {
  const reply = new Promise((resolve) => waiting.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  return Promise.race([reply, new Promise((r) => setTimeout(() => r(null), 8000))]);
};

const m = await call(1, "edit_graph_live", { graphId: "g-live", nodes: [], edges: [], backup: false });
const m409 = await call(2, "publish_graph", { graphId: "g-hook" });
const mNull = await call(3, "edit_graph_live", { graphId: "g-null", nodes: [], edges: [], backup: false });
child.kill();
srv.close();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows lock */ }

const textOf = (r) => (r?.result?.content ?? []).map((c) => c.text).join("\n");
const text = textOf(m);
const text409 = textOf(m409);
const textNull = textOf(mNull);
const checks = [
  ["ответ получен", m !== null],
  ["это ошибка инструмента", m?.result?.isError === true],
  ["виден HTTP 422", text.includes("HTTP 422")],
  ["виден заголовок «(ошибок: 8)»", text.includes("отклонено проверками (ошибок: 8):")],
  ...errors.map((e) => [`видна строка ${e.code}@${e.nodeId}: <message>`, text.includes(`${e.code}@${e.nodeId}: ${e.message}`)]),
  ["409 без тела: ошибка инструмента", m409?.result?.isError === true],
  ["409 без тела: виден HTTP 409", text409.includes("HTTP 409")],
  ["409 без тела: нет «null» вместо причины", !text409.includes("null")],
  ["null в errors[]: ошибка инструмента", mNull?.result?.isError === true],
  ["null в errors[]: виден HTTP 422 (ошибок: 2)", textNull.includes("HTTP 422. отклонено проверками (ошибок: 2):")],
  ["null в errors[]: соседняя причина видна", textNull.includes("GRAPH_EMPTY@n-ok: сценарий пуст")],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? `  ok  ${name}` : `  FAIL  ${name}`);
  if (!ok) failed += 1;
}
if (failed) { console.error(`live-edit-422 FAIL: провалено проверок — ${failed}\n${text}\n${text409}\n${textNull}`); process.exit(1); }
console.log("live-edit-422 OK");
process.exit(0);
