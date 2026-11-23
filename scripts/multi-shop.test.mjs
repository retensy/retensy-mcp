#!/usr/bin/env node
// Несколько магазинов: shopId/siteId инструмента магазина уходит заголовком X-Shop-Id только в этот вызов.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(os.tmpdir(), "rmcp-shops-"));
const seen = [];
const srv = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url.startsWith("/api/bots/commerce/quotes") || req.url.startsWith("/api/bots/marketplace/")) seen.push(req.headers["x-shop-id"] || "");
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
  check("инструмент магазина принимает shopId", !!tools.find((t) => t.name === "shop_quotes_list").inputSchema.properties.shopId);
  check("shop_create без shopId-заголовка", !!tools.find((t) => t.name === "shop_create") && !tools.find((t) => t.name === "shop_create").inputSchema.properties.shopId);
  check("shop_list есть", !!tools.find((t) => t.name === "shop_list"));
  check("list_bots без shopId", !tools.find((t) => t.name === "list_bots").inputSchema.properties.shopId);
  await call("shop_quotes_list", { shopId: "6acbeb5994c85dc62c68dc4f" });
  await call("shop_quotes_list", { siteId: "0f8fad5b-d9cb-469f-a165-70867728950e" });
  await call("shop_quotes_list");
  check("shopId -> заголовок", seen[0] === "6acbeb5994c85dc62c68dc4f");
  check("siteId -> заголовок", seen[1] === "0f8fad5b-d9cb-469f-a165-70867728950e");
  check("без выбора заголовка нет (текущий магазин)", seen[2] === "");
  const bad = await call("shop_quotes_list", { shopId: "../x" });
  check("мусорный shopId отвергается без запроса", bad.err && seen.length === 3);
  const mp = tools.filter((t) => t.name.startsWith("marketplace_"));
  check("8 инструментов отзывов, у всех есть shopId", mp.length === 8 && mp.every((t) => t.inputSchema.properties.shopId));
  await call("marketplace_connections", { shopId: "6acbeb5994c85dc62c68dc4f" });
  await call("marketplace_item_skip", { id: "665f0c1e665f0c1e665f0c1e", shopId: "6acbeb5994c85dc62c68dc4f" });
  check("shopId отзывов -> заголовок", seen[3] === "6acbeb5994c85dc62c68dc4f" && seen[4] === "6acbeb5994c85dc62c68dc4f");
} finally {
  child.kill();
  srv.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failed ? "multi-shop FAILED" : "multi-shop OK");
process.exit(failed ? 1 : 0);
