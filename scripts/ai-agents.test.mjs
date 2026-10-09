#!/usr/bin/env node
/**
 * Инструменты ИИ-агентов и базы знаний (R17): все 13 должны быть в tools/list, и каждый
 * бьёт в правильный путь/метод/тело реального backend-API (org.skiddgoddamn.controller.bot
 * AiAgentController / KnowledgeBaseController / KbDocActionsController). API подменяется
 * локальным сервером (RETENSY_BASE_URL). Выход 0 — ок, 1 — провал.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const AGENT_TOOLS = [
  "agent_list", "agent_get", "agent_create", "agent_update", "agent_publish", "agent_health",
  "agent_test_chat", "kb_docs", "kb_add_qa", "kb_add_text", "kb_add_site", "kb_reindex", "agent_unanswered",
];

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
  env: {
    ...process.env,
    RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_agents", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0",
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

const tl = await rpc(0, "tools/list", {});
const toolNames = Array.isArray(tl?.result?.tools) ? tl.result.tools.map((t) => t.name) : [];

await call(1, "agent_list", {});
await call(2, "agent_get", { agentId: "a1" });
await call(3, "agent_create", { name: "Консультант", description: "десc" });
await call(4, "agent_update", { agentId: "a1", patch: { tone: "FRIENDLY" } });
await call(5, "agent_publish", { agentId: "a1" });
await call(6, "agent_health", { agentId: "a1" });
await call(7, "agent_test_chat", { agentId: "a1", question: "Привет" });
await call(8, "kb_docs", { kbId: "kb1" });
await call(9, "kb_add_qa", { kbId: "kb1", pairs: [{ question: "Q", answer: "A" }] });
await call(10, "kb_add_text", { kbId: "kb1", title: "Правила", text: "Текст" });
await call(11, "kb_add_site", { kbId: "kb1", url: "https://example.com", schedule: "WEEKLY" });
await call(12, "kb_reindex", { kbId: "kb1", docId: "d1", headerRow: 2 });
await call(13, "agent_unanswered", { agentId: "a1", days: 7 });

child.kill();
srv.close();

const req = (url) => seen.find((s) => s.url.split("?")[0] === url);
const checks = [
  ["все 13 инструментов в tools/list", AGENT_TOOLS.every((n) => toolNames.includes(n))],
  ["agent_list -> GET /api/bots/agents", req("/api/bots/agents")?.method === "GET"],
  ["agent_get -> GET /api/bots/agents/a1", req("/api/bots/agents/a1")?.method === "GET"],
  ["agent_create -> POST /api/bots/agents {name,description}",
    seen.find((s) => s.method === "POST" && s.url === "/api/bots/agents")?.body?.name === "Консультант" &&
    seen.find((s) => s.method === "POST" && s.url === "/api/bots/agents")?.body?.description === "десc"],
  ["agent_update -> PATCH /api/bots/agents/a1 с patch как есть",
    seen.find((s) => s.method === "PATCH" && s.url === "/api/bots/agents/a1")?.body?.tone === "FRIENDLY"],
  ["agent_publish -> POST /api/bots/agents/a1/publish", seen.find((s) => s.method === "POST" && s.url === "/api/bots/agents/a1/publish") != null],
  ["agent_health -> GET /api/bots/agents/a1/health", req("/api/bots/agents/a1/health")?.method === "GET"],
  ["agent_test_chat -> POST /api/bots/agents/a1/test-chat {question}",
    seen.find((s) => s.method === "POST" && s.url === "/api/bots/agents/a1/test-chat")?.body?.question === "Привет"],
  ["kb_docs -> GET /api/bots/kb/kb1/docs", req("/api/bots/kb/kb1/docs")?.method === "GET"],
  ["kb_add_qa -> POST /api/bots/kb/kb1/docs/qa с массивом пар",
    Array.isArray(seen.find((s) => s.method === "POST" && s.url === "/api/bots/kb/kb1/docs/qa")?.body) &&
    seen.find((s) => s.method === "POST" && s.url === "/api/bots/kb/kb1/docs/qa")?.body?.[0]?.question === "Q"],
  ["kb_add_text -> POST /api/bots/kb/kb1/docs/text {title,text}",
    seen.find((s) => s.method === "POST" && s.url === "/api/bots/kb/kb1/docs/text")?.body?.title === "Правила"],
  ["kb_add_site -> POST /api/bots/kb/kb1/docs/site {url,schedule}",
    seen.find((s) => s.method === "POST" && s.url === "/api/bots/kb/kb1/docs/site")?.body?.url === "https://example.com" &&
    seen.find((s) => s.method === "POST" && s.url === "/api/bots/kb/kb1/docs/site")?.body?.schedule === "WEEKLY"],
  ["kb_reindex -> POST /api/bots/kb/kb1/docs/d1/reindex {headerRow}",
    seen.find((s) => s.method === "POST" && s.url === "/api/bots/kb/kb1/docs/d1/reindex")?.body?.headerRow === 2],
  ["agent_unanswered -> GET /api/bots/agents/a1/unanswered?days=7",
    seen.find((s) => s.method === "GET" && s.url === "/api/bots/agents/a1/unanswered?days=7") != null],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? `  ok  ${name}` : `  FAIL  ${name}`);
  if (!ok) failed += 1;
}
if (failed) { console.error(`ai-agents FAIL: ${failed}\n${JSON.stringify(seen, null, 1)}`); process.exit(1); }
console.log("ai-agents OK");
process.exit(0);
