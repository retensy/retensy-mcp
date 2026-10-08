#!/usr/bin/env node
/**
 * site_edit init:"mini-landing" и site_create template: бэкенд отвечает 422 на пустой ops:[], поэтому при одном init
 * инструмент шлёт безвредную операцию set_settings{settings:{}} (как редактор: черновик создаётся сразу).
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
const seen = [];
const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method === "POST" && req.url === "/api/bots/pages") res.end(JSON.stringify({ id: "s-new", title: "Лендинг" }));
    else res.end(JSON.stringify({ revision: 1, results: [{ op: "set_settings" }] }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-init-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: {
    ...process.env, HOME: home, USERPROFILE: home,
    RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_init", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0",
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

const r1 = await call(1, "site_edit", { siteId: "s1", init: "mini-landing" });
const r2 = await call(2, "site_edit", { siteId: "s2", ops: [{ op: "add_page", title: "Ещё" }], init: "mini-landing" });
const r3 = await call(3, "site_edit", { siteId: "s3" });
const n3 = seen.length;
const r4 = await call(4, "site_create", { title: "Лендинг", template: "mini-landing" });
const r5 = await call(5, "site_create", { title: "Сайт" });
child.kill();
srv.close();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows lock */ }

const ops = (url) => seen.find((s) => s.url === url)?.body;
const NOOP = JSON.stringify([{ op: "set_settings", settings: {} }]);
const after4 = seen.slice(n3);
const checks = [
  ["init без ops: успех", r1 && r1.result?.isError !== true],
  ["init без ops: init=mini-landing", ops("/api/bots/pages/s1/document/ops")?.init === "mini-landing"],
  ["init без ops: непустой no-op ops", JSON.stringify(ops("/api/bots/pages/s1/document/ops")?.ops) === NOOP],
  ["ops+init: ops как переданы", ops("/api/bots/pages/s2/document/ops")?.ops?.[0]?.op === "add_page" && ops("/api/bots/pages/s2/document/ops").ops.length === 1],
  ["без ops и init: ошибка без запроса", r3?.result?.isError === true && !seen.some((s) => s.url.includes("/s3/"))],
  ["site_create template: POST /pages", after4[0]?.method === "POST" && after4[0]?.url === "/api/bots/pages" && after4[0]?.body?.mode === "BLOCKS"],
  ["site_create template: ops с init=mini-landing", after4[1]?.url === "/api/bots/pages/s-new/document/ops" && after4[1]?.body?.init === "mini-landing" && JSON.stringify(after4[1]?.body?.ops) === NOOP],
  ["site_create template: успех", r4 && r4.result?.isError !== true],
  ["site_create без template: только POST /pages", r5 && after4.length === 3],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? `  ok  ${name}` : `  FAIL  ${name}`);
  if (!ok) failed += 1;
}
if (failed) { console.error(`site-init FAIL: ${failed}\n${JSON.stringify(seen, null, 1)}`); process.exit(1); }
console.log("site-init OK");
process.exit(0);
