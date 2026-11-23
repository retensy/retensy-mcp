#!/usr/bin/env node
// Мультимагазин: clients_list, dashboard_metric_query и readiness_get (действия каталога) принимают shopId,
// он уходит аргументом в /api/agent-tools/invoke (исполнитель бэка шлёт X-Shop-Id); мусор отвергается без запроса.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(os.tmpdir(), "rmcp-shops2-"));
const invoked = [];
const NAMES = ["clients_list", "dashboard_metric_query", "readiness_get"];
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/agent-tools/catalog") {
      res.end(JSON.stringify({ tools: NAMES.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) }));
    } else if (req.url === "/api/agent-tools/invoke") {
      invoked.push(JSON.parse(body || "{}"));
      res.end(JSON.stringify({ ok: true }));
    } else res.end("{}");
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`, RETENSY_MCP_TOKEN: "zmcp_default", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0" },
  stdio: ["pipe", "pipe", "ignore"],
});
const waiting = new Map();
createInterface({ input: child.stdout }).on("line", (l) => { const m = JSON.parse(l); if (m.id != null) waiting.get(m.id)?.(m.result); });
let nextId = 1;
const rpc = (method, params) => new Promise((r) => { const id = nextId++; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return { err: !!r.isError, text: r.content.map((c) => c.text).join("") }; };
let failed = 0;
const check = (name, ok) => { console.log(`  ${ok ? "ok" : "FAIL"}  ${name}`); if (!ok) failed++; };

try {
  await rpc("initialize", {});
  let tools = [];
  for (let i = 0; i < 40 && !NAMES.every((n) => tools.find((t) => t.name === n)); i++) {
    await new Promise((r) => setTimeout(r, 150));
    tools = (await rpc("tools/list", {})).tools;
  }
  for (const n of NAMES) check(`${n} принимает shopId`, !!tools.find((t) => t.name === n)?.inputSchema.properties.shopId);
  const shop = "6acbeb5994c85dc62c68dc4f";
  for (const n of NAMES) await call(n, { shopId: shop });
  for (const n of NAMES) check(`${n}: shopId уходит аргументом`, invoked.find((b) => b.name === n)?.args?.shopId === shop);
  await call("clients_list", { q: "x" });
  check("без выбора shopId не добавляется", invoked.at(-1)?.args?.shopId === undefined);
  const before = invoked.length;
  const bad = await call("clients_list", { shopId: "../x" });
  check("мусорный shopId отвергается без запроса", bad.err && invoked.length === before);
} finally {
  child.kill();
  srv.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failed ? "multi-shop-summary FAILED" : "multi-shop-summary OK");
process.exit(failed ? 1 : 0);
