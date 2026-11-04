#!/usr/bin/env node
/**
 * История версий сценария: graph_versions_list (список / сравнение), graph_version_rollback. API подменяется локальным сервером.
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
const CHAT = "7110953144424190"; // > 2^53 — должен дойти до API без округления

const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    seen.push({ method: req.method, url: req.url, body, raw });
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url === "/api/bots/graph-templates") {
      return json(200, [
        { id: "beauty-booking", name: "Запись в салон", description: "Запись клиентов", niche: "beauty", channels: ["TELEGRAM", "MAX"], nameEn: "Salon booking", descriptionEn: "" },
        { id: "faq", name: "FAQ", description: "Частые вопросы", niche: "universal", channels: ["TELEGRAM", "MAX", "VK"], nameEn: "FAQ", descriptionEn: "" },
      ]);
    }
    json(200, { ok: true, id: "x1" });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-tpl-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_tpl",
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

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "  ok " : "  FAIL"} ${name}`); if (!cond) failed++; };

const ids = async (args) => JSON.parse(textOf(await call("list_templates", args))).map((t) => t.id);
check("без фильтра - все", (await ids({})).length === 2);
check("niche", (await ids({ niche: "beauty" })).join() === "beauty-booking");
check("channel без учёта регистра", (await ids({ channel: "vk" })).join() === "faq");
check("query по русскому и английскому названию", (await ids({ query: "салон" })).join() === "beauty-booking" && (await ids({ query: "faq" })).join() === "faq");
check("ничего не нашлось - пустой список", (await ids({ niche: "legal" })).length === 0);
const list = (await rpc("tools/list", {}))?.result?.tools ?? [];
check("list_templates принимает фильтры", !!list.find((t) => t.name === "list_templates")?.inputSchema?.properties?.niche);

child.kill(); srv.close();
if (failed) { console.error(`templates-filter: провалов ${failed}`); process.exit(1); }
console.log("templates-filter OK");
