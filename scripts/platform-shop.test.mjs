#!/usr/bin/env node
// B2B-магазин: инструменты shop_* ходят в REST /api/bots/commerce/..., мутации требуют confirm:true,
// секреты (joinCode, номера счетов) маскируются, файлы отдаются base64 с лимитом или в savePath.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seen = [];
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100, 1)]);
const BIG = Buffer.alloc(2 * 1024 * 1024 + 10, 7);
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const ct = String(req.headers["content-type"] || "");
    const entry = { m: req.method, u: req.url, auth: req.headers.authorization, ct, body: ct.includes("json") && raw.length ? JSON.parse(raw) : null, raw: raw.toString("latin1") };
    seen.push(entry);
    const json = (o, code = 200) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.url === "/api/bots/commerce/orders/o1/invoice.pdf") { res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", "attachment; filename=\"schet-3.pdf\""); return res.end(PDF); }
    if (req.url === "/api/bots/commerce/orders/o1/quote.pdf") { res.setHeader("Content-Type", "application/pdf"); return res.end(PDF); }
    if (req.url === "/api/bots/commerce/orders/o1/quote-file") { res.setHeader("Content-Type", "application/pdf"); return res.end(BIG); }
    if (req.url === "/api/bots/commerce/seller") return json({ seller: { name: "ООО", inn: "7707083893", account: "40702810123456789012", corrAccount: "30101810400000000225" }, ready: true });
    if (req.url === "/api/bots/commerce/buyer-groups" && req.method === "GET") return json({ groups: [{ code: "opt", discountPct: 15, joinCode: "super-secret-code" }, { code: "vip" }], assignments: [] });
    if (req.url === "/api/bots/commerce/buyer-groups/upsert") return json({ code: "opt", joinCode: "abcdef0123456789" });
    if (req.url === "/api/bots/commerce/orders/o1/status" && entry.body?.status === "paid") return json({ error: "bad transition" }, 409);
    if (req.url === "/api/bots/commerce/orders/o1/documents" && req.method === "POST") return json({ id: "d1", name: "x.pdf" });
    json({ ok: true });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-shop-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_shop", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0", RETENSY_MCP_CATALOG: "off" },
  stdio: ["pipe", "pipe", "ignore"],
});
const waiters = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const text = (r) => r?.result?.content?.[0]?.text || "";
const last = () => seen[seen.length - 1];
let failed = 0;
const check = (n, ok) => { if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}`); };
const timer = setTimeout(() => { console.log("  FAIL  таймаут"); process.exit(1); }, 30000);
try {
  await rpc("initialize", {});
  const tools = (await rpc("tools/list", {})).result.tools;
  const t = (n) => tools.find((x) => x.name === n);
  const ip = t("catalog_item_upsert").inputSchema.properties;
  check("catalog_item_upsert: badge, badgeTone, unit", !!ip.badge && !!ip.unit && ip.badgeTone.enum.includes("orange"));
  check("catalog_category_upsert: image", !!t("catalog_category_upsert").inputSchema.properties.image);
  check("site_upload_asset: quality", t("site_upload_asset").inputSchema.properties.quality.enum.includes("original"));
  await call("catalog_item_upsert", { name: "Цемент", price: 450, badge: "Хит продаж", badgeTone: "orange", unit: "мешок", confirm: true });
  const it = seen.find((e) => e.u === "/api/bots/commerce/items/upsert");
  check("upsert передаёт метку, тон и единицу", it?.body?.badge === "Хит продаж" && it.body.badgeTone === "orange" && it.body.unit === "мешок");
  await call("catalog_category_upsert", { name: "Крепеж", image: "https://x.ru/k.webp", confirm: true });
  const cat = seen.find((e) => e.u === "/api/bots/commerce/categories" && e.m === "POST");
  check("категория передаёт image", cat?.body?.image === "https://x.ru/k.webp");
  const f = join(home, "b.png"); fs.writeFileSync(f, Buffer.alloc(20, 1));
  await call("site_upload_asset", { siteId: "s1", path: f, quality: "original" });
  const up = seen.find((e) => e.u === "/api/bots/pages/s1/upload");
  check("загрузка передаёт quality=original", !!up && up.raw.includes('name="quality"') && up.raw.includes("original"));
} finally {
  clearTimeout(timer);
  child.kill();
  srv.close();
}
process.exit(failed ? 1 : 0);
