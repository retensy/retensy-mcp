/**
 * Единая политика подтверждения: опасные прямые инструменты идут через POST /api/agent-tools/invoke.
 * С 21.11.2026 по MCP-токену сервер подтверждение не требует: инструменты выполняются сразу, у разрушительных есть
 * destructiveHint и пометка «спроси пользователя». 409+confirmToken остаётся только для старых серверов (site_rollback в моке).
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const G = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const invokes = [];
const direct = [];
const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    const body = raw ? JSON.parse(raw) : null;
    if (req.method === "POST" && req.url === "/api/agent-tools/invoke") {
      invokes.push(body);
      if (body.name === "broadcast_send_now") return res.end(JSON.stringify({ broadcastIds: ["b1"], totalAudience: 1 })); // без токена: создаётся сразу
      if (body.name === "site_rollback" && body.args?.confirmToken !== "tok-ok") {
        res.statusCode = 409;
        return res.end(JSON.stringify({ needsConfirmation: true, tool: body.name, message: "Опубликовать?", confirmToken: "tok-ok",
          step: { confirm: { required: true, summary: { added: ["n2"], replaced: [], recipients: 150, irreversible: true, text: "Добавится блоков: 1." } } } }));
      }
      return res.end(JSON.stringify(body.name === "site_publish" ? { publishedRevision: 3, page: { url: "https://x" } } : { ok: true }));
    }
    if (req.method === "GET" && req.url === "/api/bots") return res.end(JSON.stringify([{ id: B, name: "Shop", platform: "TELEGRAM" }]));
    direct.push(`${req.method} ${req.url}`);
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-409-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_409", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0", RETENSY_MCP_CATALOG: "off" },
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
  for (const n of ["publish_graph", "site_publish", "site_rollback", "bot_delete", "agent_publish", "booking_cancel", "broadcast_cancel", "delete_graph", "broadcast_send"]) {
    const t = tools.find((x) => x.name === n);
    check(`${n}: confirmToken в схеме нет, destructiveHint и пометка «спроси пользователя»`, !t?.inputSchema?.properties?.confirmToken && t?.annotations?.destructiveHint === true && /спроси пользователя перед вызовом/.test(t.description) && !/confirmToken/.test(t.description));
  }

  const p1 = await call("publish_graph", { graphId: G });
  check("publish_graph -> invoke graph_publish сразу, без просьбы о токене", invokes.at(-1)?.name === "graph_publish" && invokes.at(-1).args.graphId === G && !p1.result.isError && /"ok": true/.test(text(p1)));
  const p2 = await call("publish_graph", { graphId: G, confirmToken: "tok-ok" });
  check("старый confirmToken от клиента на сервер не уходит", !p2.result.isError && invokes.at(-1).args.confirmToken === undefined);
  const s2 = await call("site_publish", { siteId: "s1" });
  check("site_publish выполняется сразу, прежний формат ответа", /"publishedRevision": 3/.test(text(s2)) && /https:\/\/x/.test(text(s2)));
  const s1 = await call("site_rollback", { siteId: "s1", revision: 1 });
  check("legacy-сервер: 409-текст всё ещё показывается агенту", /confirmToken="tok-ok"/.test(text(s1)) && !s1.result.isError);

  const b1 = await call("broadcast_send", { botIds: [B], name: "N", messages: ["Привет"] });
  check("broadcast_send -> invoke broadcast_send_now", invokes.at(-1)?.name === "broadcast_send_now" && invokes.at(-1).args.name === "N" && !/confirmToken|Нужно подтверждение/.test(text(b1)) && /"totalAudience": 1/.test(text(b1)));

  const d1 = await call("bot_delete", { botId: B });
  check("bot_delete -> invoke bot_delete, без прямого DELETE", invokes.at(-1)?.name === "bot_delete" && !/confirmToken/.test(text(d1)) && !direct.some((d) => d.startsWith("DELETE")));
  const gd = await call("delete_graph", { graphId: G });
  check("delete_graph -> invoke graph_delete и выполняется", invokes.at(-1)?.name === "graph_delete" && !gd.result.isError && /удалён/.test(text(gd)));
  const af = { tagsAll: ["vip"], tagsAny: [], tagsNone: [] };
  const bf = await call("broadcast_send", { botIds: [B], name: "F", messages: ["Привет"], audienceFilter: af });
  const last = invokes.at(-1);
  check("broadcast_send с audienceFilter -> invoke с фильтром", last?.name === "broadcast_send_now" && JSON.stringify(last.args.audienceFilter?.tagsAll) === '["vip"]' && !/confirmToken/.test(text(bf)));
  check("прямых REST-вызовов опасных действий нет", direct.length === 0);
} finally {
  clearTimeout(timer);
  child.kill();
  srv.close();
}
if (failed) { console.error(`confirm-409 FAIL: ${failed}`); process.exit(1); }
console.log("confirm-409 OK");
process.exit(0);
