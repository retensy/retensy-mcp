#!/usr/bin/env node
/**
 * Инструменты агента на запись: agent_update проверяет tools[] локально, agent_tool_test передаёт live,
 * agent_tool_calls бьёт в журнал. API подменяется локальным сервером. Выход 0 — ок, 1 — провал.
 */
import http from "node:http";
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
    res.end(JSON.stringify({ ok: true, id: "x1" }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { RETENSY_MCP_CATALOG: "off",
    ...process.env,
    RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_agent_write", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0",
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
const rpc = (id, method, params) => {
  const reply = new Promise((resolve) => waiting.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return Promise.race([reply, new Promise((r) => setTimeout(() => r(null), 8000))]);
};


const text = (r) => JSON.stringify(r?.result ?? r?.error ?? "");
const goodTool = {
  id: "lead", type: "AMO_CREATE_LEAD", title: "Заявка", amoConnectionId: "c1", amoLeadName: "Заявка {name}", amoPhone: "{phone}",
  argsSchema: { properties: { name: { type: "string", maxLength: 50 }, phone: { type: "string" } }, required: ["name", "phone"] },
};
const tl = await rpc(0, "tools/list", {});
const names = tl?.result?.tools?.map((t) => t.name) ?? [];
const bad1 = await call(1, "agent_update", { agentId: "a1", patch: { tools: [{ ...goodTool, amoLeadName: "{secret}" }] } });
const bad2 = await call(2, "agent_update", { agentId: "a1", patch: { tools: [{ ...goodTool, argsSchema: { properties: { a: { type: "string", $ref: "x" } } } }] } });
const bad3 = await call(3, "agent_update", { agentId: "a1", patch: { tools: [{ id: "h", type: "HTTP_POST", title: "H", httpUrlTemplate: "https://x.ru", argsSchema: goodTool.argsSchema, httpHeaders: [{ name: "Host", value: "e" }] }] } });
const seenBefore = seen.length;
await call(4, "agent_update", { agentId: "a1", patch: { tools: [goodTool, { id: "tag", type: "ADD_TAG", title: "Тег", allowedTags: ["hot"] }] } });
await call(5, "agent_tool_test", { agentId: "a1", toolId: "lead", params: { name: "Иван", phone: "+7999" } });
await call(6, "agent_tool_test", { agentId: "a1", toolId: "lead", params: { name: "Иван", phone: "+7999" }, live: true });
await call(7, "agent_tool_calls", { agentId: "a1", toolId: "lead", limit: 500 });
child.kill();
srv.close();

const find = (m, u) => seen.find((s) => s.method === m && s.url === u);
const tests = seen.filter((s) => s.url === "/api/bots/agents/a1/tools/lead/test");
const checks = [
  ["agent_tool_calls в tools/list", names.includes("agent_tool_calls")],
  ["неизвестный плейсхолдер отвергнут локально", text(bad1).includes("{secret}")],
  ["лишнее ключевое слово схемы отвергнуто", text(bad2).includes("не поддерживается")],
  ["запрещённый заголовок отвергнут", text(bad3).includes("недопустимый заголовок")],
  ["невалидные tools не ушли на сервер", seen.slice(0, seenBefore).every((s) => s.method !== "PATCH" && s.body?.name !== "agent_update")],
  ["валидные tools -> PATCH с tools[2]", seen.find((s) => s.url === "/api/agent-tools/invoke" && s.body?.name === "agent_update")?.body?.args?.patch?.tools?.length === 2],
  ["agent_tool_test без live -> без live в теле", tests[0]?.body?.live === undefined && tests[0]?.body?.params?.name === "Иван"],
  ["agent_tool_test live:true -> live в теле", tests[1]?.body?.live === true],
  ["agent_tool_calls -> GET ...?toolId=lead&limit=200", seen.some((s) => s.url === "/api/bots/agents/a1/tool-calls?toolId=lead&limit=200")],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? `  ok  ${name}` : `  FAIL  ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
