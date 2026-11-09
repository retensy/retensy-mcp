/**
 * Рассылка по многим ботам одним вызовом БЕЗ confirmToken; обрыв сети без слепых повторов.
 * Проверяет: лимит 100 ботов, 56 ботов идут ОДНИМ invoke, первый же вызов создаёт рассылку (токена нет),
 * сводка группы вместо 49 подробных строк, scheduledAt (dedup без stagger / со stagger / расхождение / прошлое),
 * preview ничего не создаёт и передаёт то же расписание, запись после обрыва не повторяется и подсказывает, создалась ли рассылка.
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
const previews = [];
let botsListFailures = 0;      // сколько раз оборвать GET /api/bots
let botsListCalls = 0;
let invokeMode = "ok";         // ok | drop
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
    if (req.method === "POST" && req.url === "/api/bots/broadcasts/group-preview") {
      previews.push(JSON.parse(raw));
      return res.end(JSON.stringify({ totalRecipients: 1, uniqueRecipients: 1, perBot: [], limit: 50000 }));
    }
    if (req.method === "POST" && req.url === "/api/agent-tools/invoke") {
      const body = JSON.parse(raw);
      invokes.push(body);
      if (invokeMode === "drop") return req.socket.destroy();
      const start = body.args.scheduledAt || body.args.stagger?.startAt || new Date().toISOString();
      // как сервер: группа с подробным perBot по каждому боту
      return res.end(JSON.stringify({
        id: "g1", name: body.args.name, status: "SCHEDULED",
        perBot: body.args.botIds.map((botId, i) => ({
          botId, waveIndex: 0, totalWaves: 1, status: "PENDING", broadcastId: `bc-${i}`, recipientsPlanned: 10, recipientsSkippedDedup: 1,
          plannedStartAt: new Date(Date.parse(start) + (body.args.stagger?.intervalMinutes || 0) * 60000 * i).toISOString(),
          padding: "x".repeat(400),
        })),
      }));
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
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };

let failed = 0;
const check = (n, ok) => { if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}`); };
const timer = setTimeout(() => { console.log("  FAIL  таймаут"); process.exit(1); }, 40000);
const msgs = [{ type: "TEXT", text: "Привет" }];
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
try {
  await rpc("initialize", {});
  const tools = (await rpc("tools/list", {})).result.tools;
  for (const n of ["broadcast_send", "broadcast_group", "broadcast_preview"]) {
    check(`${n}: botIds maxItems 100`, tools.find((t) => t.name === n)?.inputSchema?.properties?.botIds?.maxItems === 100);
  }
  const sendTool = tools.find((t) => t.name === "broadcast_send");
  check("описание broadcast_send: 1–100 ботов", /1–100 ботов/.test(sendTool.description));
  check("broadcast_send: нет параметра confirmToken", !sendTool.inputSchema.properties.confirmToken);
  check("описание: нет confirmToken и «Нужно подтверждение пользователя»", !/confirmToken|Нужно подтверждение пользователя/.test(sendTool.description));
  check("описание: агент обязан показать получателей, текст и время из preview и получить согласие", /ДО вызова/.test(sendTool.description) && /broadcast_group/.test(sendTool.description) && /согласие/.test(sendTool.description));
  check("описание: нет «на первом тике»", !/первом тике/.test(sendTool.description) && !/первом тике/.test(JSON.stringify(sendTool.inputSchema)));

  // больше 100 - понятная ошибка без запроса на сервер
  const before = invokes.length;
  const over = await call("broadcast_send", { name: "x", botIds: ids(101), messages: msgs, dedup: true });
  check("101 бот: ошибка с числом и подсказкой", over.result.isError && /не больше 100/.test(text(over)) && /101/.test(text(over)));
  check("101 бот: на сервер ничего не ушло", invokes.length === before);

  // preview ничего не создаёт
  const nPrev = invokes.length;
  await call("broadcast_group", { action: "preview", botIds: ids(2), dedup: true, scheduledAt: "2026-11-09T12:30:00+03:00" });
  check("preview: ни одного invoke (ничего не создаётся)", invokes.length === nPrev);
  check("preview: scheduledAt ушёл в group-preview", previews.at(-1)?.scheduledAt === "2026-11-09T09:30:00.000Z" || previews.at(-1)?.scheduledAt === "2026-11-09T09:30:00Z");

  // 56 ботов, сразу: один invoke, без токена, сводка вместо простыни
  const r56 = await call("broadcast_send", { name: "Вакансия МОП", botIds: ids(56), messages: msgs, dedup: true });
  const inv = invokes.filter((i) => i.name === "broadcast_send_now");
  check("56 ботов: ровно один invoke со всеми botIds", inv.length === 1 && inv[0].args.botIds.length === 56);
  check("первый вызов создаёт рассылку: токена в args нет", inv[0].args.confirmToken === undefined);
  const t = text(r56);
  const s56 = json(r56);
  check("ответ: не просьба о подтверждении", !r56.result.isError && !/confirmToken|Нужно подтверждение/.test(t));
  check("ответ-сводка короткий (<2000 символов вместо ~27 тыс.)", t.length < 2000);
  check("сводка: 56 ботов и статусы", s56?.group?.bots === 56 && s56.group.statusCounts?.PENDING === 56 && s56.recipientsPlanned === 560);
  check("сводка: первое и последнее plannedStartAt в МСК", /МСК$/.test(s56?.firstStartAt || "") && /МСК$/.test(s56?.lastStartAt || ""));
  check("сводка: предупреждение о немедленном старте", /немедленный/i.test(s56?.warning || ""));
  check("сводка: куда смотреть детали", /broadcast_group/.test(s56?.details || ""));

  // scheduledAt + dedup без stagger: уходит в сервер, старт в сводке = 12:30 МСК, без предупреждения
  const sched = await call("broadcast_send", { name: "План", botIds: ids(3), messages: msgs, dedup: true, scheduledAt: "2099-11-09T12:30:00+03:00" });
  const sLast = invokes.at(-1);
  const ss = json(sched);
  check("scheduledAt + dedup: scheduledAt ушёл на сервер", sLast.args.scheduledAt === "2099-11-09T09:30:00.000Z" || sLast.args.scheduledAt === "2099-11-09T09:30:00Z");
  check("scheduledAt + dedup: старт 12:30 МСК и нет предупреждения", ss?.firstStartAt === "2099-11-09 12:30 МСК" && ss?.lastStartAt === "2099-11-09 12:30 МСК" && !ss?.warning);

  // scheduledAt + stagger с интервалом
  const stag = await call("broadcast_send", { name: "Волна", botIds: ids(3), messages: msgs, scheduledAt: "2099-11-09T12:30:00+03:00", stagger: { intervalMinutes: 10 } });
  const sg = json(stag);
  check("scheduledAt + stagger: первый 12:30, последний 12:50 МСК", sg?.firstStartAt === "2099-11-09 12:30 МСК" && sg?.lastStartAt === "2099-11-09 12:50 МСК");

  // расхождение scheduledAt и stagger.startAt - ошибка без запроса
  const nDiv = invokes.length;
  const div = await call("broadcast_send", { name: "Расхождение", botIds: ids(3), messages: msgs, scheduledAt: "2099-11-09T12:30:00+03:00", stagger: { startAt: "2099-11-09T13:00:00+03:00", intervalMinutes: 5 } });
  check("расхождение времён: ошибка, на сервер не ушло", div.result.isError && /расходятся/.test(text(div)) && invokes.length === nDiv);
  const same = await call("broadcast_send", { name: "Совпало", botIds: ids(3), messages: msgs, scheduledAt: "2099-11-09T12:30:00+03:00", stagger: { startAt: "2099-11-09T12:30:00+03:00", intervalMinutes: 5 } });
  check("одинаковое время в обоих полях принимается", !same.result.isError && invokes.length === nDiv + 1);

  // scheduledAt в прошлом
  const nPast = invokes.length;
  const past = await call("broadcast_send", { name: "Прошлое", botIds: ids(3), messages: msgs, dedup: true, scheduledAt: "2020-01-01T10:00:00Z" });
  check("scheduledAt в прошлом: ошибка, на сервер не ушло", past.result.isError && /уже прошло/.test(text(past)) && invokes.length === nPast);

  // без dedup/stagger: ответ с startsAt и предупреждением
  const plain = await call("broadcast_send", { name: "Обычная", botIds: ids(1), messages: msgs });
  check("прямая рассылка сразу: startsAt «сразу» и предупреждение", json(plain)?.startsAt === "сразу" && /немедленный/i.test(json(plain)?.warning || ""));

  // автоповтор чтения: первый GET /api/bots обрывается
  botsListFailures = 1; botsListCalls = 0;
  const okRead = await call("broadcast_group", { action: "preview", botIds: ids(2) });
  check("чтение после одного обрыва повторяется само", botsListCalls >= 2 && !/Нет связи/.test(text(okRead)));

  // обрыв при записи: без повтора, с причиной и проверкой «создалась ли»
  invokeMode = "drop";
  groups = [];
  let n0 = invokes.length;
  const drop = await call("broadcast_send", { name: "Вакансия МОП 2/3", botIds: ids(20), messages: msgs, dedup: true });
  check("запись не повторяется (один invoke)", invokes.length - n0 === 1);
  check("обрыв: понятная ошибка, не голый fetch failed", drop.result.isError && /Нет связи с сервисом/.test(text(drop)) && /НЕ повторяй вслепую/.test(text(drop)));
  check("обрыв: причина в скобках", /\[[A-Z_]+/.test(text(drop)));
  check("обрыв: рассылки нет -> можно повторить", /нет - она не создана/.test(text(drop)) && !/confirmToken/.test(text(drop)));

  groups = [{ id: "grp-77", name: "Вакансия МОП 2/3", status: "SCHEDULED", createdAt: new Date().toISOString() }];
  n0 = invokes.length;
  const drop2 = await call("broadcast_send", { name: "Вакансия МОП 2/3", botIds: ids(20), messages: msgs, dedup: true });
  check("обрыв, но группа создана: сказано не повторять", /УЖЕ СОЗДАНА/.test(text(drop2)) && /grp-77/.test(text(drop2)) && invokes.length - n0 === 1);
} finally {
  clearTimeout(timer);
  child.kill();
  srv.close();
}
if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nbroadcast-batch OK");
