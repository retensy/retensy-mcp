#!/usr/bin/env node
/**
 * Проверка агента ИИ-клиентами: agent_tests_run / agent_tests_list бьют в правильные пути backend-API
 * (AiClientTestController, /api/bots/agents/{id}/ai-tests/*). Без confirm:true запрос не уходит вовсе (расход ИИ),
 * прогон опрашивается до конца, wait:false возвращает RUNNING сразу. API подменяется локальным сервером.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seen = [];
let polls = 0;
const doneRun = { id: "r1", status: "DONE", passed: 1, failed: 1, errors: 0, regressions: 1, results: [{ caseId: "c1", verdict: "FAIL", regression: true }] };

const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && req.url.endsWith("/ai-tests/runs")) return send(202, { id: "r1", status: "RUNNING", results: [] });
    if (req.method === "GET" && req.url.endsWith("/ai-tests/runs/r1")) { polls += 1; return send(200, doneRun); }
    if (req.method === "GET" && req.url.endsWith("/ai-tests/runs/latest")) return send(200, doneRun);
    if (req.method === "GET" && req.url.endsWith("/ai-tests/runs")) return send(200, [{ id: "r1", status: "DONE" }]);
    if (req.method === "GET" && req.url.endsWith("/ai-tests/cases")) return send(200, [{ id: "c1", name: "Цена" }]);
    return send(200, []);
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { RETENSY_MCP_CATALOG: "off",
    ...process.env,
    RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_agent_tests", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0",
  },
  stdio: ["pipe", "pipe", "ignore"],
});
const waiting = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  waiting.get(m?.id)?.(m);
});
const rpc = (id, method, params, ms = 15000) => {
  const reply = new Promise((resolve) => waiting.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return Promise.race([reply, new Promise((r) => setTimeout(() => r(null), ms))]);
};
const call = (id, name, args) => rpc(id, "tools/call", { name, arguments: args });
const textOf = (r) => r?.result?.content?.[0]?.text ?? "";

const tl = await rpc(0, "tools/list", {});
const tools = Array.isArray(tl?.result?.tools) ? tl.result.tools : [];

const noConfirm = await call(1, "agent_tests_run", { agentId: "a1" });
const noConfirmRequests = seen.length;
const run = await call(2, "agent_tests_run", { agentId: "a1", confirm: true, caseIds: ["c1"] });
const async_ = await call(3, "agent_tests_run", { agentId: "a1", confirm: true, wait: false });
const gen = await call(4, "agent_tests_run", { agentId: "a1", confirm: true, generate: 5, wait: false });
const badGen = await call(5, "agent_tests_run", { agentId: "a1", confirm: true, generate: 50 });
const list = await call(6, "agent_tests_list", { agentId: "a1" });
const listRun = await call(7, "agent_tests_list", { agentId: "a1", runId: "r1" });

child.kill();
srv.close();

const posts = seen.filter((s) => s.method === "POST" && s.url === "/api/bots/agents/a1/ai-tests/runs");
const checks = [
  ["оба инструмента в tools/list", ["agent_tests_run", "agent_tests_list"].every((n) => tools.some((t) => t.name === n))],
  ["agent_tests_run требует confirm в схеме", tools.find((t) => t.name === "agent_tests_run")?.inputSchema?.required?.includes("confirm")],
  ["без confirm:true — ошибка и ни одного запроса к API", noConfirm?.result?.isError === true && noConfirmRequests === 0],
  ["run -> POST .../ai-tests/runs {caseIds, confirmed:true, trigger:MCP}",
    posts[0]?.body?.confirmed === true && posts[0]?.body?.trigger === "MCP" && posts[0]?.body?.caseIds?.[0] === "c1"],
  ["run опрашивает GET .../runs/r1 до конца и возвращает итог", polls >= 1 && textOf(run).includes('"DONE"') && textOf(run).includes("regression")],
  ["wait:false возвращает RUNNING сразу", textOf(async_).includes("RUNNING")],
  ["generate -> POST .../ai-tests/generate {count, confirmed:true}",
    seen.find((s) => s.url === "/api/bots/agents/a1/ai-tests/generate")?.body?.count === 5 &&
    seen.find((s) => s.url === "/api/bots/agents/a1/ai-tests/generate")?.body?.confirmed === true && textOf(gen).includes("RUNNING")],
  ["generate вне 1..10 — ошибка", badGen?.result?.isError === true],
  ["list: cases + history + последний прогон",
    textOf(list).includes("Цена") && textOf(list).includes('"history"') && textOf(list).includes('"DONE"') &&
    seen.some((s) => s.method === "GET" && s.url === "/api/bots/agents/a1/ai-tests/runs/latest")],
  ["list с runId берёт конкретный прогон", seen.filter((s) => s.url === "/api/bots/agents/a1/ai-tests/runs/r1").length >= 2 && textOf(listRun).includes("r1")],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? `  ok  ${name}` : `  FAIL  ${name}`);
  if (!ok) failed += 1;
}
if (failed) { console.error(`agent-tests FAIL: ${failed}\n${JSON.stringify(seen, null, 1)}`); process.exit(1); }
console.log("agent-tests OK");
process.exit(0);
