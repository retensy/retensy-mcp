#!/usr/bin/env node
// Несколько аккаунтов: retensyAccount выбирает токен на один вызов, аккаунт по умолчанию не меняется.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(os.tmpdir(), "rmcp-accounts-"));
const seen = [];
const srv = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const auth = req.headers.authorization || "";
    if (req.url === "/api/bots") seen.push(auth);
    const code = auth === "Bearer zmcp_bad" ? 401 : 200;
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(req.url === "/api/bots" && code === 200 ? JSON.stringify([{ id: auth }]) : "{}");
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`, RETENSY_MCP_TOKEN: "zmcp_default", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0" },
  stdio: ["pipe", "pipe", "ignore"],
});
const waiting = new Map();
createInterface({ input: child.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m.result); });
let nextId = 1;
const rpc = (method, params) => new Promise((r) => { const id = nextId++; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return { err: !!r.isError, text: r.content.map((c) => c.text).join("") }; };
let failed = 0;
const check = (name, ok) => { console.log(`  ${ok ? "ok" : "FAIL"}  ${name}`); if (!ok) failed++; };

try {
  await rpc("initialize", {});
  const { tools } = await rpc("tools/list", {});
  check("list_bots принимает retensyAccount", !!tools.find((t) => t.name === "list_bots").inputSchema.properties.retensyAccount);
  check("account_add без retensyAccount", !tools.find((t) => t.name === "account_add").inputSchema.properties.retensyAccount);

  const bad = await call("account_add", { name: "bad", token: "zmcp_bad" });
  check("неверный токен не сохраняется", bad.err && !fs.existsSync(join(home, ".retensy-bot-graph", "accounts.json")));

  check("аккаунт добавлен", !(await call("account_add", { name: "a@b.ru", token: "zmcp_two" })).err);
  seen.length = 0;
  const [one, two] = await Promise.all([call("list_bots", { retensyAccount: "a@b.ru" }), call("list_bots")]);
  check("вызов идёт под выбранным аккаунтом", one.text.includes("zmcp_two"));
  check("параллельный вызов остаётся на аккаунте по умолчанию", two.text.includes("zmcp_default"));

  seen.length = 0;
  const unknown = await call("list_bots", { retensyAccount: "nope" });
  check("неизвестный аккаунт: ошибка и нет запроса", unknown.err && seen.length === 0);

  const list = await call("account_list");
  check("account_list не показывает токен", list.text.includes("a@b.ru") && !list.text.includes("Bearer") && !fs.readFileSync(join(home, ".retensy-bot-graph", "accounts.json"), "utf8").includes("zmcp_default"));
  check("account_remove", !(await call("account_remove", { name: "a@b.ru" })).err && (await call("list_bots", { retensyAccount: "a@b.ru" })).err);
} finally {
  child.kill();
  srv.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failed ? "multi-account FAILED" : "multi-account OK");
process.exit(failed ? 1 : 0);
