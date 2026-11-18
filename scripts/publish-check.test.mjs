/**
 * Проверка перед публикацией: инструмент publish_check (GET .../publish-check), site_publish передаёт force и отдаёт
 * check.warnings, 422 с errors/warnings доходит до агента. API подменяется локальным сервером.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const invokes = [];
const direct = [];
const report = {
  blocked: false, canForce: true, counts: { errors: 0, warnings: 1, info: 0 }, errors: [],
  warnings: [{ severity: "warning", code: "NO_CONTACT", message: "В шапке нет телефона", path: "globals.header", pageId: null, blockId: "h1" }],
  hasCatalog: false,
};
const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    const body = raw ? JSON.parse(raw) : null;
    if (req.method === "POST" && req.url === "/api/agent-tools/invoke") {
      invokes.push(body);
      if (body.args?.confirmToken !== "tok-ok") {
        res.statusCode = 409;
        return res.end(JSON.stringify({ needsConfirmation: true, tool: body.name, message: "Опубликовать?", confirmToken: "tok-ok",
          step: { confirm: { required: true, summary: { text: "Сайт станет виден посетителям." } } } }));
      }
      if (body.args.siteId === "blocked" && !body.args.force) {
        res.statusCode = 422;
        return res.end(JSON.stringify({ error: "Проверка перед публикацией нашла ошибки", blocked: true, errors: [{ code: "EMPTY_BLOCK", message: "Пустой блок" }], warnings: [] }));
      }
      return res.end(JSON.stringify({ publishedRevision: 4, page: { url: "https://x" }, check: report }));
    }
    direct.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/api/bots/pages/s1/publish-check") return res.end(JSON.stringify(report));
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-pc-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_pc", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0", RETENSY_MCP_CATALOG: "off" },
  stdio: ["pipe", "pipe", "ignore"],
});
const waiters = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiters.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const text = (r) => r?.result?.content?.[0]?.text || "";

let failed = 0;
const check = (n, ok) => { if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}`); };
const timer = setTimeout(() => { console.log("  FAIL  таймаут"); process.exit(1); }, 20000);
try {
  await rpc("initialize", {});
  const tools = (await rpc("tools/list", {})).result.tools;
  const pc = tools.find((t) => t.name === "publish_check");
  check("publish_check есть в tools/list с siteId", !!pc && pc.inputSchema.required.includes("siteId"));
  check("publish_check: в описании errors, warnings и force", /errors/.test(pc.description) && /warnings/.test(pc.description) && /canForce/.test(pc.description));
  const sp = tools.find((t) => t.name === "site_publish");
  check("site_publish: параметр force и описание проверки", !!sp.inputSchema.properties.force && /publish_check/.test(sp.description));

  const r = await call("publish_check", { siteId: "s1" });
  check("publish_check -> GET publish-check, отчёт целиком", direct.includes("GET /api/bots/pages/s1/publish-check") && /NO_CONTACT/.test(text(r)));

  const a = await call("site_publish", { siteId: "s1", confirmToken: "tok-ok" });
  check("site_publish без force: force в args нет", invokes.at(-1).args.force === undefined && invokes.at(-1).args.siteId === "s1");
  check("site_publish отдаёт check.warnings", /NO_CONTACT/.test(text(a)) && /"publishedRevision": 4/.test(text(a)));

  const b = await call("site_publish", { siteId: "blocked", confirmToken: "tok-ok" });
  check("site_publish с ошибками проверки -> 422 доходит до агента", !!b.result.isError && /EMPTY_BLOCK|Проверка перед публикацией/.test(text(b)));
  const c = await call("site_publish", { siteId: "blocked", force: true, confirmToken: "tok-ok" });
  check("site_publish force:true уходит в args", invokes.at(-1).args.force === true && !c.result.isError);
} finally {
  clearTimeout(timer);
  child.kill();
  srv.close();
}
if (failed) { console.error(`publish-check FAIL: ${failed}`); process.exit(1); }
console.log("publish-check OK");
process.exit(0);
