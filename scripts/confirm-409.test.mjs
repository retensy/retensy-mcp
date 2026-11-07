/**
 * Единая политика подтверждения: опасные прямые инструменты идут через POST /api/agent-tools/invoke.
 * Без confirmToken сервер отвечает 409 {needsConfirmation, confirmToken, step.confirm.summary} — агент получает
 * «что изменится» и токен; повтор с confirmToken выполняет действие.
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
      if (body.args?.confirmToken !== "tok-ok") {
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
  for (const n of ["publish_graph", "site_publish", "site_rollback", "broadcast_send", "bot_delete", "agent_publish", "booking_cancel", "broadcast_cancel"]) {
    check(`${n}: в схеме есть confirmToken`, !!tools.find((t) => t.name === n)?.inputSchema?.properties?.confirmToken);
  }

  const p1 = await call("publish_graph", { graphId: G });
  check("publish_graph -> invoke graph_publish", invokes.at(-1)?.name === "graph_publish" && invokes.at(-1).args.graphId === G);
  check("409: не ошибка, а просьба спросить пользователя", !p1.result.isError && /подтверждение/i.test(text(p1)));
  check("409: что изменится (summary.text, получатели, необратимо)", /Добавится блоков: 1/.test(text(p1)) && /Получателей: 150/.test(text(p1)) && /необратимо/i.test(text(p1)));
  check("409: токен в тексте", /confirmToken: "tok-ok"/.test(text(p1)));

  const p2 = await call("publish_graph", { graphId: G, confirmToken: "tok-ok" });
  check("повтор с confirmToken выполняется, токен ушёл в args", !p2.result.isError && invokes.at(-1).args.confirmToken === "tok-ok" && /"ok": true/.test(text(p2)));

  const s1 = await call("site_publish", { siteId: "s1" });
  check("site_publish без токена -> 409-текст", /confirmToken: "tok-ok"/.test(text(s1)));
  const s2 = await call("site_publish", { siteId: "s1", confirmToken: "tok-ok" });
  check("site_publish с токеном -> прежний формат ответа", /"publishedRevision": 3/.test(text(s2)) && /https:\/\/x/.test(text(s2)));

  const b1 = await call("broadcast_send", { botIds: [B], name: "N", messages: ["Привет"] });
  check("broadcast_send -> invoke broadcast_send_now", invokes.at(-1)?.name === "broadcast_send_now" && invokes.at(-1).args.name === "N" && /confirmToken: "tok-ok"/.test(text(b1)));

  const d1 = await call("bot_delete", { botId: B });
  check("bot_delete -> invoke bot_delete, без прямого DELETE", invokes.at(-1)?.name === "bot_delete" && /confirmToken/.test(text(d1)) && !direct.some((d) => d.startsWith("DELETE")));
  const gd = await call("delete_graph", { graphId: G });
  check("delete_graph -> invoke graph_delete, 409-текст", invokes.at(-1)?.name === "graph_delete" && /confirmToken: "tok-ok"/.test(text(gd)));
  const gd2 = await call("delete_graph", { graphId: G, confirmToken: "tok-ok" });
  check("delete_graph с токеном выполняется", !gd2.result.isError && /удалён/.test(text(gd2)));
  const af = { tagsAll: ["vip"], tagsAny: [], tagsNone: [] };
  const bf = await call("broadcast_send", { botIds: [B], name: "F", messages: ["Привет"], audienceFilter: af });
  const last = invokes.at(-1);
  check("broadcast_send с audienceFilter -> invoke с фильтром", last?.name === "broadcast_send_now" && JSON.stringify(last.args.audienceFilter?.tagsAll) === '["vip"]' && /confirmToken/.test(text(bf)));
  check("прямых REST-вызовов опасных действий нет", direct.length === 0);
} finally {
  clearTimeout(timer);
  child.kill();
  srv.close();
}
if (failed) { console.error(`confirm-409 FAIL: ${failed}`); process.exit(1); }
console.log("confirm-409 OK");
process.exit(0);
