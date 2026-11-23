#!/usr/bin/env node
// Поддержка Retensy: support_status/support_ask/support_call_human ходят на /api/bots/support/* (тот же путь, что у инструментов Чата с ИИ).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(os.tmpdir(), "rmcp-support-"));
const seen = [];
const srv = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (!req.url.startsWith("/api/agent-tools")) seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [], total: 0, page: 0, size: 50 }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`, RETENSY_MCP_TOKEN: "zmcp_default", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0" },
  stdio: ["pipe", "pipe", "ignore"],
});
const waiting = new Map();
createInterface({ input: child.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m.result); });
let nextId = 1;
const rpc = (method, params) => new Promise((r) => { const id = nextId++; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return { err: !!r.isError, text: r.content.map((c) => c.text).join("") }; };
let failed = 0;
const check = (name, ok) => { console.log(`  ${ok ? "ok" : "FAIL"}  ${name}`); if (!ok) failed++; };

try {
  await rpc("initialize", {});
  const { tools } = await rpc("tools/list", {});
  for (const n of ["support_status", "support_ask", "support_call_human"]) check(`${n} есть в списке`, !!tools.find((t) => t.name === n));
  check("support_* не принимают shopId", ["support_status", "support_ask", "support_call_human"].every((n) => !tools.find((t) => t.name === n).inputSchema.properties.shopId));
  check("support_ask требует text", tools.find((t) => t.name === "support_ask").inputSchema.required?.includes("text"));
  await call("support_status");
  await call("support_ask", { text: "Как подключить бота?" });
  await call("support_call_human");
  check("status -> GET /api/bots/support/state", seen[0] === "GET /api/bots/support/state");
  check("ask -> POST /api/bots/support/messages", seen[1] === "POST /api/bots/support/messages");
  check("call_human -> POST /api/bots/support/escalate", seen[2] === "POST /api/bots/support/escalate");
  const empty = await call("support_ask", { text: "  " });
  check("пустой вопрос отвергается без запроса", empty.err && seen.length === 3);
} finally {
  child.kill();
  srv.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failed ? "support FAILED" : "support OK");
process.exit(failed ? 1 : 0);
