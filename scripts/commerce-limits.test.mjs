#!/usr/bin/env node
// commerce_limits: лимиты магазинов/товаров/заявок и срок хранения - GET /api/bots/commerce/limits (только чтение).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(os.tmpdir(), "rmcp-limits-"));
const seen = [];
const srv = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (!req.url.startsWith("/api/agent-tools")) seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ shopsUsed: 1, maxShops: 1, catalogItemsUsed: 10, maxCatalogItems: 300, leadsUsed: 5, maxLeads: 500, leadRetentionDays: 60 }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`, RETENSY_MCP_TOKEN: "zmcp_default", RETENSY_MCP_NO_UPDATE_CHECK: "1" },
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
  const t = tools.find((x) => x.name === "commerce_limits");
  check("commerce_limits есть в списке", !!t);
  check("описание про 402 и срок хранения", /402/.test(t.description) && /leadRetentionDays/.test(t.description));
  const r = await call("commerce_limits");
  check("-> GET /api/bots/commerce/limits", seen[0] === "GET /api/bots/commerce/limits");
  check("ответ отдаётся как есть", !r.err && r.text.includes("\"maxCatalogItems\": 300"));
} finally {
  child.kill();
  srv.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failed ? "commerce-limits FAILED" : "commerce-limits OK");
process.exit(failed ? 1 : 0);
