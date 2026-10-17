#!/usr/bin/env node
/**
 * Дополнительные сценарии: publish_graph secondary:true → ?secondary=true (без него — прежний путь), unpublish_graph,
 * link_create с targetGraphId, vk_landing_* передают targetGraphId. API подменяется локальным сервером.
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
    if (req.method === "GET" && req.url.endsWith("/settings")) return json(200, { settings: { color: "#000", title: "Чат" } });
    if (req.method === "GET" && /\/booking\/calendars\/[0-9a-f-]{36}$/.test(req.url)) {
      return json(200, { id: "cal", name: "Клиника", zone: "Europe/Moscow", slotMinutes: 30, hours: [{ day: 1, from: "09:00", to: "18:00" }], exceptions: [] });
    }
    if (req.method === "POST" && req.url.endsWith("/bookings") && body?.slotAt?.startsWith("2026-10-12T16")) return json(409, { error: "CONFLICT: слот уже занят" });
    json(200, { ok: true, id: "x1" });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-sg-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: BASE, RETENSY_MCP_TOKEN: "zmcp_test_sg",
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

const B = "11111111-2222-4333-8444-555555555555";
const none = (frag) => !seen.some((s) => s.url.includes(frag));
const G = "22222222-3333-4444-8555-666666666666";
const N = "33333333-4444-4555-8666-777777777777";

await call("publish_graph", { graphId: G, secondary: true });
check("publish_graph secondary:true → POST ?secondary=true", !!req("POST", `/api/bots/graphs/${G}/publish?secondary=true`));
await call("publish_graph", { graphId: N });
check("publish_graph без secondary → прежний POST без параметра", !!req("POST", `/api/bots/graphs/${N}/publish`));
await call("unpublish_graph", { graphId: G });
check("unpublish_graph → POST /unpublish", !!req("POST", `/api/bots/graphs/${G}/unpublish`));
check("unpublish_graph graphId не UUID — ошибка до запроса", isErr(await call("unpublish_graph", { graphId: "g1" })) && none("/graphs/g1/"));
await call("link_create", { botId: B, name: "Лендинг", targetGraphId: G, targetNodeId: N });
const link = req("POST", `/api/bots/${B}/links`);
check("link_create передаёт targetGraphId и targetNodeId", link?.body?.targetGraphId === G && link?.body?.targetNodeId === N);
check("link_create targetGraphId не UUID — ошибка до запроса",
  isErr(await call("link_create", { botId: B, targetGraphId: "nope" })));
await call("vk_landing_create", { botId: B, title: "Л", targetGraphId: G });
check("vk_landing_create передаёт targetGraphId", req("POST", "/api/growth/vk-landings")?.body?.targetGraphId === G);

child.kill(); srv.close();
if (failed) { console.error(`secondary-graphs: провалов ${failed}`); process.exit(1); }
console.log("secondary-graphs OK");
