/**
 * Рассылка по многим ботам одним вызовом и одним подтверждением; обрыв сети без слепых повторов.
 * Проверяет: лимит 100 ботов (схема и текст ошибки), 56 ботов идут ОДНИМ invoke, компактный текст подтверждения,
 * причина перевыдачи токена (истёк / использован / подмена), автоповтор только чтения, запись после обрыва не повторяется
 * и подсказывает, создалась ли рассылка.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bots = Array.from({ length: 101 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Bot ${i}`, platform: "TELEGRAM" }));
const ids = (n) => bots.slice(0, n).map((b) => b.id);
const invokes = [];
let botsListFailures = 0;      // сколько раз оборвать GET /api/bots
let botsListCalls = 0;
let invokeMode = "ok";         // ok | reissue-expired | drop-with-token
let groups = [];

const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/api/bots") {
      botsListCalls++;
      if (botsListFailures > 0) { botsListFailures--; return req.socket.destroy(); }
      return res.end(JSON.stringify(bots));
    }
    if (req.method === "GET" && req.url === "/api/bots/broadcasts/group") return res.end(JSON.stringify(groups));
    if (req.method === "GET" && /\/api\/bots\/[^/]+\/broadcasts$/.test(req.url)) return res.end("[]");
    if (req.method === "POST" && req.url === "/api/agent-tools/invoke") {
      const body = JSON.parse(raw);
      invokes.push(body);
      if (body.args.confirmToken && invokeMode === "drop-with-token") return req.socket.destroy();
      if (!body.args.confirmToken || invokeMode === "reissue-expired") {
        res.statusCode = 409;
        return res.end(JSON.stringify({
          needsConfirmation: true, tool: body.name, confirmToken: "tok-2", ttlMinutes: 30,
          reissueReason: invokeMode === "reissue-expired" ? "expired_same" : undefined,
          message: "x".repeat(2000),
          step: { confirm: { required: true, summary: { recipients: 33516, irreversible: true,
            text: `Рассылка: 33516 уникальным получателям (сумма по ${body.args.botIds.length} ботам до дедупа: 41208), сразу.` } } },
        }));
      }
      return res.end(JSON.stringify({ id: "g1", status: "SCHEDULED", perBot: [] }));
    }
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-batch-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_batch", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0", RETENSY_MCP_CATALOG: "off" },
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
const timer = setTimeout(() => { console.log("  FAIL  таймаут"); process.exit(1); }, 40000);
const msgs = [{ type: "TEXT", text: "Привет" }];
try {
  await rpc("initialize", {});
  const tools = (await rpc("tools/list", {})).result.tools;
  for (const n of ["broadcast_send", "broadcast_group", "broadcast_preview"]) {
    check(`${n}: botIds maxItems 100`, tools.find((t) => t.name === n)?.inputSchema?.properties?.botIds?.maxItems === 100);
  }
  check("описание broadcast_send: 1–100 ботов", /1–100 ботов/.test(tools.find((t) => t.name === "broadcast_send").description));

  // больше 100 - понятная ошибка без запроса на сервер
  const before = invokes.length;
  const over = await call("broadcast_send", { name: "x", botIds: ids(101), messages: msgs, dedup: true });
  check("101 бот: ошибка с числом и подсказкой", over.result.isError && /не больше 100/.test(text(over)) && /101/.test(text(over)));
  check("101 бот: на сервер ничего не ушло", invokes.length === before);

  // 56 ботов - один invoke, одно подтверждение
  const r56 = await call("broadcast_send", { name: "Вакансия МОП", botIds: ids(56), messages: msgs, dedup: true });
  const inv = invokes.filter((i) => i.name === "broadcast_send_now");
  check("56 ботов: один invoke со всеми botIds", inv.length === 1 && inv[0].args.botIds.length === 56);
  const t = text(r56);
  check("подтверждение компактное: 2 строки, до 500 символов", t.split("\n").length === 2 && t.length < 500);
  check("подтверждение: оба числа и токен с TTL 30 мин", /33516/.test(t) && /41208/.test(t) && /confirmToken="tok-2"/.test(t) && /30 мин/.test(t));
  check("подтверждение: нет простыни message", !/xxxx/.test(t));

  // токен истёк, выдан новый: причина названа явно
  invokeMode = "reissue-expired";
  const re = await call("broadcast_send", { name: "Вакансия МОП", botIds: ids(56), messages: msgs, dedup: true, confirmToken: "tok-old" });
  check("перевыдача: сказано, что токен истёк и описание не менялось", /истёк, выдан новый; описание не менялось/.test(text(re)));
  check("перевыдача: токен ушёл в args как есть", invokes.at(-1).args.confirmToken === "tok-old");

  // автоповтор чтения: первый GET /api/bots обрывается
  invokeMode = "ok";
  botsListFailures = 1; botsListCalls = 0;
  const okRead = await call("broadcast_group", { action: "preview", botIds: ids(2) });
  check("чтение после одного обрыва повторяется само", botsListCalls >= 2 && !/Нет связи/.test(text(okRead)));

  // обрыв при записи с токеном: без повтора, с причиной и проверкой «создалась ли»
  invokeMode = "drop-with-token";
  groups = [];
  let n0 = invokes.length;
  const drop = await call("broadcast_send", { name: "Вакансия МОП 2/3", botIds: ids(20), messages: msgs, dedup: true, confirmToken: "tok-2" });
  check("запись не повторяется (один invoke с токеном)", invokes.length - n0 === 1);
  check("обрыв: понятная ошибка, не голый fetch failed", drop.result.isError && /Нет связи с сервисом/.test(text(drop)) && /НЕ повторяй вслепую/.test(text(drop)));
  check("обрыв: причина в скобках", /\[[A-Z_]+/.test(text(drop)));
  check("обрыв: рассылки нет -> можно повторить с новым подтверждением", /нет - она не создана/.test(text(drop)));

  groups = [{ id: "grp-77", name: "Вакансия МОП 2/3", status: "SCHEDULED", createdAt: new Date().toISOString() }];
  n0 = invokes.length;
  const drop2 = await call("broadcast_send", { name: "Вакансия МОП 2/3", botIds: ids(20), messages: msgs, dedup: true, confirmToken: "tok-2" });
  check("обрыв, но группа создана: сказано не повторять", /УЖЕ СОЗДАНА/.test(text(drop2)) && /grp-77/.test(text(drop2)) && invokes.length - n0 === 1);
} finally {
  clearTimeout(timer);
  child.kill();
  srv.close();
}
if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nbroadcast-batch OK");
