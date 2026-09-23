#!/usr/bin/env node
/**
 * retensy-mcp — MCP-сервер для сборки и публикации воронок ботов
 * (Telegram, MAX, Instagram) через API сервиса retensy /bots.
 * Без внешних зависимостей (голый JSON-RPC по stdio).
 *
 * Авторизация (в порядке приоритета):
 *   1) env RETENSY_MCP_TOKEN — персональный токен "zmcp_..."
 *   2) файл ~/.retensy-bot-graph/token  (заполняется инструментом set_token)
 *   3) session-cookie (RETENSY_SESSION_COOKIE / RETENSY_COOKIE) — fallback
 *
 * Если токена нет — инструменты не падают с сухой ошибкой, а возвращают пошаговую
 * инструкцию; есть инструменты `setup` (статус + как подключить) и `set_token`
 * (пользователь присылает токен в чат — агент сохраняет его в конфиг, без рестарта).
 *
 * ENV:
 *   RETENSY_MCP_TOKEN, RETENSY_BASE_URL, RETENSY_SESSION_COOKIE, RETENSY_COOKIE
 *   RETENSY_MCP_TELEMETRY=off|on|full  — отчёты о неудачах (по умолчанию on, без значений аргументов)
 *   RETENSY_MCP_REPORT_URL             — свой webhook вместо нашего
 *   RETENSY_MCP_AUTOUPDATE=0           — не обновлять пакет автоматически
 */

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const VERSION = "0.12.0";
const PKG_NAME = "@retensy/mcp";
const BASE = (process.env.RETENSY_BASE_URL || "https://bots.retensy.com").replace(/\/+$/, "");
const CONFIG_DIR = path.join(os.homedir(), ".retensy-bot-graph");
const TOKEN_FILE = path.join(CONFIG_DIR, "token");
const TOKENS_PAGE = `${BASE}/bots/mcp-tokens`;

function readFileToken() {
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; }
}
function getToken() {
  // Если переменная не задана, Claude Code отдаёт шаблон "${RETENSY_MCP_TOKEN}" литералом —
  // такой env нельзя считать токеном, иначе он перекрывает файл из set_token (вечный 401).
  const env = (process.env.RETENSY_MCP_TOKEN || "").trim();
  if (env && !env.startsWith("${")) return env;
  return readFileToken();
}
function getCookie() {
  return process.env.RETENSY_COOKIE ||
    (process.env.RETENSY_SESSION_COOKIE ? `SESSION=${process.env.RETENSY_SESSION_COOKIE}` : "");
}
function saveToken(token) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token.trim() + "\n", { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* windows */ }
}
function isAuthed() { return !!(getToken() || getCookie()); }

// ============================================================================
// Отчёты о неудачах + проверка обновлений
// ============================================================================
// ЗАЧЕМ: если клиент пытается сделать что-то, чего сервер не умеет (неизвестный
// инструмент, отказ публикации, ошибка API) — мы хотим об этом узнать и добавить
// поддержку. Отчёт уходит на webhook АНОНИМНО и БЕЗ СЕКРЕТОВ.
//
// Что уходит: имя инструмента, категория неудачи, текст ошибки, КЛЮЧИ аргументов
// (значения — только для безопасного списка полей вроде graphId/botId/kind),
// версия, платформа и анонимный id установки (хэш, не имя машины).
// Что НЕ уходит НИКОГДА: токены, cookie, пароли, креды интеграций, тела графов.
//
// Полностью выключить: RETENSY_MCP_TELEMETRY=off
// Присылать и значения аргументов (для отладки своей же установки): =full
//
// Отчёт уходит на НАШ эндпоинт `/api/mcp/report`, а не напрямую в мессенджер: адрес приёмника
// не должен лежать в публичном npm-пакете (оттуда его вытащил бы любой, а у вебхуков нет ни
// авторизации, ни лимита частоты). Сервер сам решает, куда переслать, и ограничивает частоту.
const REPORT_URL = (process.env.RETENSY_MCP_REPORT_URL || `${BASE}/api/mcp/report`).trim();
const REPORT_MODE = (process.env.RETENSY_MCP_TELEMETRY || "on").trim().toLowerCase();
/** Ключи, значения которых не отправляем ни в каком режиме. */
const SECRET_KEY_RX = /token|secret|cookie|passw|apikey|api_key|auth|cred/i;
/** Ключи, значения которых безопасны и реально нужны для разбора. */
const SAFE_ARG_KEYS = new Set(["graphId", "botId", "targetBotId", "templateId", "kind", "value",
  "name", "slug", "id", "page", "size", "preview", "backup", "summary", "publish", "dryRun", "query"]);
const REPORT_MAX = 20;        // на процесс: цикл ретраев не должен залить вебхук
let reportCount = 0;
const reportSeen = new Set(); // дедуп одинаковых неудач в рамках процесса

/** Стабильный анонимный id установки (FNV-1a) — группировать отчёты одного пользователя без PII. */
function installId() {
  let h = 0x811c9dc5;
  for (const ch of `${os.hostname()}|${os.homedir()}`) { h ^= ch.charCodeAt(0); h = (h * 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

function safeArgs(toolName, a) {
  // set_token несёт секрет целиком — не сериализуем его вообще.
  if (toolName === "set_token") return '{"token":"<скрыт>"}';
  const out = {};
  for (const [k, v] of Object.entries(a || {})) {
    if (SECRET_KEY_RX.test(k)) { out[k] = "<скрыт>"; continue; }
    const show = REPORT_MODE === "full" || SAFE_ARG_KEYS.has(k);
    if (Array.isArray(v)) out[k] = `<array:${v.length}>`;
    else if (v && typeof v === "object") out[k] = `<object:${Object.keys(v).length}>`;
    else if (show) out[k] = typeof v === "string" ? v.slice(0, 120) : v;
    else out[k] = `<${typeof v}>`;
  }
  return JSON.stringify(out).slice(0, 900); // сервер обрежет ещё раз, но зря тащить не будем
}

function failureCategory(msg) {
  const m = String(msg || "");
  if (/^Неизвестный инструмент/.test(m)) return "unknown_tool";
  // Токен вообще не настроен — это обычное состояние нового пользователя, а не пробел
  // в возможностях: такие отчёты не отправляем (иначе каждый новичок зашумит канал).
  if (/Нет доступа к retensy/.test(m)) return "not_configured";
  if (/Доступ отклонён/.test(m)) return "auth_rejected";   // токен есть, но отвергнут — это стоит знать
  const http = m.match(/HTTP (\d{3})/);
  if (http) return `http_${http[1]}`;
  return "error";
}

/** Fire-and-forget: никогда не задерживает и не ломает ответ инструмента. */
function reportFailure({ tool, args, message, category }) {
  if (REPORT_MODE === "off" || !REPORT_URL || reportCount >= REPORT_MAX) return;
  const cat = category || failureCategory(message);
  if (cat === "not_configured") return;
  const key = `${tool}|${cat}|${String(message || "").slice(0, 120)}`;
  if (reportSeen.has(key)) return;
  reportSeen.add(key);
  reportCount += 1;
  const body = {
    tool: String(tool || "?").slice(0, 200),
    category: cat,
    message: String(message || "").slice(0, 1500),
    args: safeArgs(tool, args),
    mcpVersion: VERSION,
    node: process.version,
    platform: process.platform,
    baseUrl: BASE,
    installId: installId(),
  };
  const headers = { "Content-Type": "application/json" };
  // Токен прикладываем ТОЛЬКО когда отчёт идёт на наш же адрес — тогда сервер покажет,
  // кому именно не хватило возможности. На сторонний RETENSY_MCP_REPORT_URL токен не уходит.
  if (REPORT_URL.startsWith(`${BASE}/`)) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    fetch(REPORT_URL, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal })
      .catch(() => {}).finally(() => clearTimeout(timer));
  } catch { /* телеметрия не имеет права влиять на работу */ }
}

// ---- Проверка обновлений ----
const UPDATE_FILE = path.join(CONFIG_DIR, "update-check.json");
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
const AUTOUPDATE = (process.env.RETENSY_MCP_AUTOUPDATE || "1").trim() !== "0";
// Запущены из node_modules/_npx → пакет обновляется npm. Запущены из git-чекаута
// (плагин Claude Code) → npm бесполезен: исполняется файл репозитория, а не пакет.
const SELF_DIR = (() => { try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return ""; } })();
const IS_NPM_INSTALL = /[\\/](node_modules|_npx)[\\/]/.test(SELF_DIR);
let updateNotice = "";
let noticeDelivered = false;

function cmpVersions(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < 3; i += 1) {
    const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function spawnSelfUpdate() {
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // stdio:"ignore" обязателен: любой вывод в stdout сломал бы JSON-RPC.
    const child = spawn(npm, ["i", "-g", `${PKG_NAME}@latest`],
      { detached: true, stdio: "ignore", shell: process.platform === "win32" });
    child.unref();
    return true;
  } catch { return false; }
}

function applyUpdateNotice(latest) {
  updateNotice = `⬆️ Доступна новая версия retensy-mcp: ${VERSION} → ${latest}. `;
  if (IS_NPM_INSTALL) {
    // Процесс НЕ МОЖЕТ подменить свой уже загруженный код — обновление вступит в силу
    // только после перезапуска MCP-сервера. Честно об этом пишем.
    updateNotice += AUTOUPDATE && spawnSelfUpdate()
      ? "Обновление запущено в фоне (npm i -g), применится ПОСЛЕ перезапуска MCP-сервера."
      : `Обнови вручную: npm i -g ${PKG_NAME}@latest, затем перезапусти MCP-сервер.`;
  } else {
    updateNotice += "Сервер запущен из репозитория/плагина — обнови плагин (git pull) и перезапусти MCP-сервер.";
  }
  process.stderr.write(`[retensy-mcp] ${updateNotice}\n`);
}

/** Тихо: нет сети или реестр недоступен — работа не должна ломаться. */
async function checkForUpdate() {
  try {
    const cached = JSON.parse(fs.readFileSync(UPDATE_FILE, "utf8"));
    if (cached && Date.now() - cached.at < UPDATE_TTL_MS) {
      if (cached.latest && cmpVersions(cached.latest, VERSION) > 0) applyUpdateNotice(cached.latest);
      return;
    }
  } catch { /* кэша нет или он битый — проверяем в реестре */ }
  let latest = "";
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    // Сокращённый packument (~700 байт) + dist-tags.latest. ВАЖНО: на эндпоинте
    // /<pkg>/latest этот accept даёт HTTP 406 — заголовок работает только на packument.
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME.replace("/", "%2f")}`,
      { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: ac.signal });
    clearTimeout(timer);
    if (res.ok) latest = (await res.json())?.["dist-tags"]?.latest || "";
  } catch { return; }
  if (!latest) return;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_FILE, JSON.stringify({ at: Date.now(), latest }));
  } catch { /* не смогли записать кэш — не страшно */ }
  if (cmpVersions(latest, VERSION) > 0) applyUpdateNotice(latest);
}

const NO_AUTH_HELP =
  "Нет доступа к retensy /bots — не настроена авторизация.\n\n" +
  `Как подключить (помоги пользователю по шагам):\n` +
  `1) Открой ${TOKENS_PAGE} и войди в аккаунт.\n` +
  `2) Нажми «Создать токен», скопируй секрет (вид zmcp_...). Он показывается один раз.\n` +
  `3) Пришли токен сюда — и я вызову инструмент set_token, чтобы сохранить его. (Или задай env RETENSY_MCP_TOKEN.)\n\n` +
  "Подсказка ассистенту: попроси пользователя выполнить шаги 1–2 и прислать токен, затем вызови set_token с этим значением.";

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  const token = getToken();
  const cookie = getCookie();
  if (token) h.Authorization = `Bearer ${token}`;
  else if (cookie) h.Cookie = cookie;
  return h;
}

// Ошибка не-2xx ответа — один форматтер на все вызовы API. 422 с errors[] — отказ проверок (publish, а с
// аудита H2 и PUT активного графа). Агенту нужны ВСЕ причины: раньше здесь был JSON, обрезанный до 600
// символов, и хвост ошибок терялся. Прочее тело — как есть; пустое (так отвечают 409 и многие 400) —
// только статус, без «null» вместо причины.
function httpError(method, path_, status, data) {
  const errors = status === 422 && Array.isArray(data?.errors) ? data.errors : null;
  const raw = data == null ? "" : typeof data === "string" ? data : JSON.stringify(data);
  const msg = errors
    ? `отклонено проверками (ошибок: ${errors.length}):\n` +
      errors.map((e) => `${e?.code || "?"}${e?.nodeId ? `@${e.nodeId}` : ""}: ${e?.message || ""}`).join("\n")
    : raw.slice(0, 600);
  const err = new Error(`${method} ${path_} → HTTP ${status}.${msg ? ` ${msg}` : ""}`);
  err.status = status;   // структурный разбор — арка E (fe#28)
  err.data = data;
  return err;
}

async function api(path_, { method = "GET", body } = {}) {
  if (!isAuthed()) throw new Error(NO_AUTH_HELP);
  const res = await fetch(`${BASE}${path_}`, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Доступ отклонён (HTTP ${res.status}). Токен невалиден, отозван или истёк.\n` +
        `Создай новый на ${TOKENS_PAGE} и пришли мне — я сохраню через set_token.`);
    }
    throw httpError(method, path_, res.status, data);
  }
  return data;
}

// MIME по расширению — уходит как Content-Type части multipart, бэкенд по нему определяет тип медиа.
const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".pdf": "application/pdf", ".zip": "application/zip", ".doc": "application/msword", ".txt": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const guessMime = (name) => MIME_BY_EXT[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";

// Загрузка файла в библиотеку /bots/files (POST /api/bots/media, multipart). Свой fetch:
// у api() Content-Type=application/json, для multipart его ставить нельзя (fetch сам задаёт boundary).
async function uploadMedia({ filePath, url, filename }) {
  if (!isAuthed()) throw new Error(NO_AUTH_HELP);
  let bytes, name, mime;
  if (filePath) {
    const abs = path.resolve(String(filePath).replace(/^~(?=$|[/\\])/, os.homedir()));
    try { bytes = fs.readFileSync(abs); } catch { throw new Error(`Файл не найден: ${abs}`); }
    name = filename || path.basename(abs);
    mime = guessMime(name);
  } else if (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Не удалось скачать файл по url (HTTP ${r.status}).`);
    bytes = Buffer.from(await r.arrayBuffer());
    let base = "file"; try { base = path.basename(new URL(url).pathname) || "file"; } catch { /* ignore */ }
    name = filename || base;
    mime = r.headers.get("content-type") || guessMime(name);
  } else {
    throw new Error("Передай path (локальный файл) ИЛИ url (ссылку для перезаливки).");
  }
  const headers = {};
  const token = getToken(); const cookie = getCookie();
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (cookie) headers.Cookie = cookie;
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: mime }), name);
  const res = await fetch(`${BASE}/api/bots/media`, { method: "POST", headers, body: fd });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`Доступ отклонён (HTTP ${res.status}). Токен невалиден/отозван — создай новый на ${TOKENS_PAGE}.`);
    if (res.status === 402) throw new Error("Лимит хранилища тарифа исчерпан (HTTP 402). Удали ненужные файлы (delete_file) или подними тариф на /bots/subscription.");
    if (res.status === 413) throw new Error("Файл больше 50 МБ (HTTP 413) — лимит Telegram для видео/документов.");
    throw httpError("POST", "/api/bots/media", res.status, data);
  }
  return data;
}

const okResult = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const errResult = (e) => ({ isError: true, content: [{ type: "text", text: "❌ " + (e?.message || String(e)) }] });

function extractGraph(g) {
  if (!g || typeof g !== "object") throw new Error("graph должен быть объектом (контейнер retensy-bot-graph или {nodes,edges}).");
  const nodes = g.nodes ?? g.graph?.nodes;
  const edges = g.edges ?? g.graph?.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error("В graph нет массивов nodes[] и edges[].");
  return { name: g.name, nodes, edges, canvasMeta: g.canvasMeta ?? {} };
}

// Прочитать граф из локального файла (поддерживается ~). MCP исполняется на машине пользователя,
// поэтому большой граф можно не передавать инлайном, а сослаться файлом — без обрезания/ошибок.
function readGraphFile(p) {
  const abs = path.resolve(String(p).replace(/^~(?=$|[/\\])/, os.homedir()));
  let raw;
  try { raw = fs.readFileSync(abs, "utf8"); } catch { throw new Error(`Файл графа не найден: ${abs}`); }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new Error(`Файл графа — невалидный JSON: ${abs}. ${e?.message || e}`); }
  return obj;
}
// Источник графа для пишущих инструментов: graphFile (путь) > graph (контейнер) > nodes/edges.
function resolveGraphInput(a) {
  if (a.graphFile) return extractGraph(readGraphFile(a.graphFile));
  if (a.graph) return extractGraph(a.graph);
  return { nodes: a.nodes, edges: a.edges, canvasMeta: a.canvasMeta ?? {}, name: a.name };
}
// Компактная сводка графа (без объёмных text/cards/buttons) — чтобы не упираться в лимит токенов
// на больших графах. Узлы: id/type/title/позиция; рёбра: id/from/handle/to.
function graphSummary(g) {
  const nodes = (g?.nodes || []).map((n) => ({ id: n.id, type: n.type, title: n.config?._title || n.config?.title || null, x: n.position?.x, y: n.position?.y }));
  const edges = (g?.edges || []).map((e) => ({ id: e.id, from: e.sourceNodeId, h: e.sourceHandle, to: e.targetNodeId }));
  return { graphId: g?.id, name: g?.name, status: g?.status, version: g?.version, counts: { nodes: nodes.length, edges: edges.length }, nodes, edges };
}

const TOOLS = [
  { name: "setup", description: "Показать статус авторизации и пошаговую инструкцию подключения. Вызывай первым, если пользователь не знает, что делать, или при ошибке доступа.", inputSchema: { type: "object", properties: {} } },
  { name: "set_token", description: "Сохранить персональный токен (zmcp_...), который пользователь создал на /bots/mcp-tokens. Применяется сразу, без рестарта.", inputSchema: { type: "object", properties: { token: { type: "string", description: "Секрет токена, начинается с zmcp_" } }, required: ["token"] } },
  { name: "list_bots", description: "Список ботов пользователя (id, имя, статус).", inputSchema: { type: "object", properties: {} } },
  { name: "list_graphs", description: "Список графов (сценариев) бота.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  { name: "list_channels", description: "Список каналов/групп, подключённых к боту (chatId, title, type, статус бота, дата). chatId — числовой id для условия SUBSCRIBED («Подписан на канал»).", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  { name: "list_integrations", description: "Список подключённых сервисов пользователя (GET /api/bots/integrations): {id, provider, title, hint, createdAt}. **id отсюда — это `connectionId`**, обязательное поле действий amocrm_send/amocrm_update/bitrix24_call/getcourse_send/getcourse_order/yametrika_event. Без него действие упадёт «не выбрано подключение». Креды не отдаются — только маскированный hint. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "get_graph", description: "Получить граф по graphId. Для БОЛЬШИХ графов (десятки узлов JSON может превысить лимит токенов) используй summary:true (компактная сводка: id/type/title/позиции + рёбра) или saveToFile (записать полный граф на диск и вернуть сводку+путь — потом правь файл и заливай через update_graph/edit_graph_live с graphFile).", inputSchema: { type: "object", properties: { graphId: { type: "string" }, summary: { type: "boolean", description: "true = вернуть компактную сводку без объёмных text/cards/buttons" }, saveToFile: { type: "string", description: "Путь: записать полный граф (JSON) на диск, вернуть сводку + путь" } }, required: ["graphId"] } },
  { name: "create_graph", description: "Создать пустой граф (DRAFT) в боте. Возвращает граф с id.", inputSchema: { type: "object", properties: { botId: { type: "string" }, name: { type: "string" } }, required: ["botId", "name"] } },
  { name: "update_graph", description: "Залить узлы/рёбра в граф (PUT, сырой replace без бэкапа). Для правок СУЩЕСТВУЮЩЕГО/живого сценария используй edit_graph_live. Активный (PUBLISHED) граф сервер проверяет как публикацию: при ошибках HTTP 422 со всеми code@nodeId, граф НЕ сохранён. Черновик сохраняется без проверок. Принимает graphFile (путь к локальному файлу — НЕ нужно слать граф инлайном, удобно для больших графов), graph-контейнер или nodes/edges.", inputSchema: { type: "object", properties: { graphId: { type: "string" }, graphFile: { type: "string", description: "Путь к локальному JSON графа (контейнер retensy-bot-graph или {nodes,edges}); поддерживается ~" }, graph: { type: "object" }, nodes: { type: "array" }, edges: { type: "array" }, canvasMeta: { type: "object" }, name: { type: "string" } }, required: ["graphId"] } },
  { name: "edit_graph_live", description: "РЕКОМЕНДОВАННЫЙ способ правки СУЩЕСТВУЮЩЕГО (часто живого/опубликованного) сценария: редактирует ТОТ ЖЕ graphId НА МЕСТЕ (id не меняется) и сначала снимает авто-бэкап текущего состояния в один rolling-граф «🔙 Авто-бэкап». НЕ клонирует и НЕ создаёт новый активный граф. Открытые редакторы перечитают граф вживую (external_update), бот применит изменения сразу (читает активный граф заново из БД). Используй ВМЕСТО clone+publish, когда нужно поправить сценарий, который уже открыт/в проде. ВАЖНО: правку активного графа сервер проверяет как публикацию (валидатор, платные блоки, лимит блоков тарифа, платформа) — при ошибках HTTP 422 со всеми code@nodeId, граф НЕ изменён, бот работает на прежней версии. Прогоняй offline validate.mjs и dry_run заранее, чтобы не ловить 422. Живой граф бота — с isActive:true в list_graphs (после publish_graph черновика — publishedGraphId, не id черновика); правка черновика до бота не доходит.", inputSchema: { type: "object", properties: { graphId: { type: "string" }, graph: { type: "object" }, nodes: { type: "array" }, edges: { type: "array" }, canvasMeta: { type: "object" }, name: { type: "string" }, graphFile: { type: "string", description: "Путь к локальному JSON графа (вместо инлайн-передачи); поддерживается ~" }, backup: { type: "boolean", description: "Снимать авто-бэкап предыдущего состояния перед правкой (по умолчанию true)." } }, required: ["graphId"] } },
  { name: "patch_graph", description: "Точечная правка БОЛЬШОГО/живого графа без отправки графа целиком: сервер сам берёт граф по graphId, делает строковые замены в его JSON, проверяет валидность и заливает обратно НА МЕСТЕ (с авто-бэкапом). Идеально, когда граф слишком велик, чтобы передавать его целиком через update_graph/edit_graph_live — напр. сменить id канала в условиях SUBSCRIBED, ссылки кнопок, тексты. replacements: [{find, replace}] — заменяются ВСЕ вхождения; делай find максимально специфичным, чтобы не задеть лишнее. preview=true — только показать число совпадений, ничего не сохраняя. Бот применит изменения сразу только у опубликованного графа (читает активный граф заново из БД); патч черновика до бота не доходит. Результат для активного графа сервер проверяет как публикацию: ошибки → HTTP 422 со всеми code@nodeId, граф не изменён.", inputSchema: { type: "object", properties: { graphId: { type: "string" }, replacements: { type: "array", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] } }, preview: { type: "boolean", description: "true = только отчёт о числе совпадений, без сохранения" }, backup: { type: "boolean", description: "снять авто-бэкап предыдущего состояния перед правкой (по умолчанию true)" } }, required: ["graphId", "replacements"] } },
  { name: "dry_run", description: "Прогнать сценарий без публикации. kind: command|callback|text.", inputSchema: { type: "object", properties: { graphId: { type: "string" }, kind: { type: "string", enum: ["command", "callback", "text"] }, value: { type: "string" }, fromUsername: { type: "string" }, presetVariables: { type: "object" }, presetTags: { type: "array", items: { type: "string" } } }, required: ["graphId", "kind", "value"] } },
  { name: "publish_graph", description: "Опубликовать граф. Вернёт publishedGraphId; при отказе проверок — ошибка HTTP 422 со всеми причинами построчно (code@nodeId: message). Сценарий-вебхук (источник WEBHOOK) этим инструментом не публикуется — HTTP 409, его публикуют в вебе.", inputSchema: { type: "object", properties: { graphId: { type: "string" } }, required: ["graphId"] } },
  { name: "import_funnel", description: "Всё за раз: создать граф, залить узлы/рёбра, (опц.) dry-run /start, опубликовать. Граф можно передать инлайном (graph) или файлом (graphFile).", inputSchema: { type: "object", properties: { botId: { type: "string" }, name: { type: "string" }, graph: { type: "object" }, graphFile: { type: "string", description: "Путь к локальному JSON графа вместо инлайн graph; поддерживается ~" }, dryRun: { type: "boolean" }, publish: { type: "boolean" } }, required: ["botId"] } },
  { name: "list_templates", description: "Список готовых шаблонов воронок (id, имя, описание). Можно стартовать граф из шаблона вместо сборки с нуля.", inputSchema: { type: "object", properties: {} } },
  { name: "create_graph_from_template", description: "Создать граф (DRAFT) из шаблона (см. list_templates). Возвращает граф с id — дальше правь через update_graph.", inputSchema: { type: "object", properties: { botId: { type: "string" }, templateId: { type: "string" }, name: { type: "string" } }, required: ["botId", "templateId"] } },
  { name: "rename_graph", description: "Переименовать сценарий (работает и для опубликованных — имя не влияет на исполнение).", inputSchema: { type: "object", properties: { graphId: { type: "string" }, name: { type: "string" } }, required: ["graphId", "name"] } },
  { name: "clone_graph", description: "Склонировать граф в новый DRAFT «… (copy)» — безопасно итерировать поверх опубликованного. Клон сценария-вебхука получает собственный путь и секрет вебхука.", inputSchema: { type: "object", properties: { graphId: { type: "string" } }, required: ["graphId"] } },
  { name: "copy_graph", description: "Скопировать граф в ДРУГОГО бота (в т.ч. на другую платформу). Возвращает {graphId, sourcePlatform, targetPlatform, notes[]}. notes[] помечают, что адаптировано (severity=TRANSFORM, напр. вопрос-контакт → ввод телефона текстом), что требует ручной правки (MANUAL, напр. условие SUBSCRIBED в MAX) и особенности платформы (INFO). Авто-адаптация узлов реализована для Telegram⇄MAX; при копировании в/из Instagram-бота граф копируется без трансформаций — несовместимые узлы будут отмечены при публикации (IG-allowlist). preview=true — только проверка совместимости, без копирования. Тот же бот запрещён (для дублирования есть clone_graph). Копия сценария-вебхука становится обычным сценарием бота-получателя (вход по вебхуку не переносится).", inputSchema: { type: "object", properties: { graphId: { type: "string" }, targetBotId: { type: "string", description: "id бота-получателя (см. list_bots)" }, preview: { type: "boolean", description: "true = только отчёт о совместимости, ничего не сохраняется" } }, required: ["graphId", "targetBotId"] } },
  { name: "delete_graph", description: "Удалить граф. Активный (опубликованный и назначенный боту) удалить нельзя — будет 409; сначала переключи активный через set_active_graph.", inputSchema: { type: "object", properties: { graphId: { type: "string" } }, required: ["graphId"] } },
  { name: "set_active_graph", description: "Назначить, какой опубликованный граф активен у бота (переключение живого сценария без перепубликации). HTTP 409 — граф не опубликован или это сценарий-вебхук (источник WEBHOOK — такой включается своей публикацией в вебе).", inputSchema: { type: "object", properties: { botId: { type: "string" }, graphId: { type: "string" } }, required: ["botId", "graphId"] } },
  { name: "upload_file", description: "Загрузить файл в библиотеку /bots/files (POST /api/bots/media) и получить публичный URL для вставки в сценарий. Передай path (локальный файл) ИЛИ url (перезалить файл по ссылке в своё хранилище). Возвращает {id, url, mediaType, sizeBytes, originalName}. Полученный url ставь в медиа-карточку SEND_MESSAGE (image/video/audio/file/voice/videonote → поле url; gallery → urls[]) или в SEND_PHOTO.photoUrl. Лимит 50 МБ; типы: image/video/audio/pdf/zip/doc(x)/xlsx/pptx/txt (SVG запрещён); при нехватке места — HTTP 402.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Путь к локальному файлу (поддерживается ~)" }, url: { type: "string", description: "Ссылка на файл — будет скачан и перезалит в /bots/files" }, filename: { type: "string", description: "Переопределить имя файла (необязательно)" } } } },
  { name: "list_files", description: "Список файлов в библиотеке /bots/files (GET /api/bots/media) + использовано/лимит байт. Бери готовые url отсюда, чтобы не загружать одно и то же повторно.", inputSchema: { type: "object", properties: {} } },
  { name: "delete_file", description: "Удалить файл из библиотеки /bots/files по id (DELETE /api/bots/media/{id}). Освобождает место в хранилище тарифа.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "graph_analytics", description: "Аналитика прохождения сценария по узлам (GET /api/bots/graphs/{graphId}/analytics): сколько пользователей дошло до каждого узла — видно, где отваливается воронка. Read-only.", inputSchema: { type: "object", properties: { graphId: { type: "string" } }, required: ["graphId"] } },
  { name: "list_bot_users", description: "Пользователи (подписчики/лиды) бота, постранично (GET /api/bots/{botId}/users). Опц. page (с 0), size (по умолч. 25), query (поиск по имени/username/id). Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" }, page: { type: "number" }, size: { type: "number" }, query: { type: "string" } }, required: ["botId"] } },
  { name: "list_links", description: "Стартовые (трекинговые) ссылки бота с UTM (GET /api/bots/{botId}/links): code, метки, число стартов. Это точки входа в воронку. Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  { name: "article_list", description: "Список СВОИХ статей блога retensy (GET /api/articles/my): id, slug, title, viewCount, даты. id нужен для article_update, slug — публичный адрес /articles/{slug}. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "article_get", description: "Получить статью блога по slug (GET /api/articles/by-slug/{slug}) — публичное чтение, в т.ч. чужие. Возвращает title, content (Markdown), excerpt, coverImage, viewCount.", inputSchema: { type: "object", properties: { slug: { type: "string", description: "slug статьи (часть адреса /articles/{slug})" } }, required: ["slug"] } },
  { name: "article_publish", description: "Опубликовать НОВУЮ статью блога retensy (POST /api/articles). content — Markdown (как README на GitHub: заголовки, списки, таблицы, код, картинки по URL). title необязателен: если не передать, заголовком станет первая строка вида «# Заголовок», и она убирается из текста. Обложку можно задать явно через cover (URL картинки) — иначе берётся первая картинка из текста; excerpt (SEO-описание) тоже можно задать явно, иначе генерируется из текста. Возвращает статью с id и slug + публичный URL.", inputSchema: { type: "object", properties: { title: { type: "string", description: "Заголовок (необязателен, если content начинается с «# ...»)" }, content: { type: "string", description: "Тело статьи в Markdown" }, cover: { type: "string", description: "URL обложки (coverImage/OG). Если не задан — берётся первая картинка из текста." }, excerpt: { type: "string", description: "Краткое SEO-описание (≤160 симв). Если не задан — генерируется из текста." } }, required: ["content"] } },
  { name: "article_update", description: "Обновить СВОЮ статью по id (PUT /api/articles/{id}; id бери из article_list). content — Markdown; title необязателен (как в article_publish, иначе берётся из «# ...»). Только владелец — чужую вернёт 403.", inputSchema: { type: "object", properties: { id: { type: "string", description: "id статьи из article_list" }, title: { type: "string" }, content: { type: "string", description: "Новое тело в Markdown" } }, required: ["id", "content"] } },
];

async function handleCall(params) {
  const a = (params && params.arguments) || {};
  switch (params && params.name) {
    case "setup": {
      const upd = updateNotice ? `\n\n${updateNotice}` : "";
      if (isAuthed()) {
        const via = getToken() ? "персональный токен" : "session-cookie";
        return okResult(`✅ Авторизация настроена (${via}). База API: ${BASE}. Версия MCP: ${VERSION}.\n` +
          `Можно собирать и публиковать ботов: list_bots, create_graph, import_funnel и др.${upd}`);
      }
      return okResult(NO_AUTH_HELP + upd);
    }
    case "set_token": {
      const t = (a.token || "").trim();
      if (!t) throw new Error("Передай token — секрет вида zmcp_..., который ты создал на " + TOKENS_PAGE);
      saveToken(t);
      const warn = t.startsWith("zmcp_") ? "" : "\n⚠️ Обычно токен начинается с «zmcp_» — проверь, что скопирован весь секрет.";
      const envTok = (process.env.RETENSY_MCP_TOKEN || "").trim();
      const envWarn = envTok && !envTok.startsWith("${") && envTok !== t
        ? "\n⚠️ В окружении задан другой RETENSY_MCP_TOKEN — он имеет приоритет над файлом. Убери/обнови env, иначе сохранённый токен не будет использоваться."
        : "";
      // лёгкая проверка валидности
      let check = "";
      try { const bots = await api("/api/bots"); check = `\nПроверка: доступно ботов — ${Array.isArray(bots) ? bots.length : "?"}.`; }
      catch (e) { check = `\n⚠️ Токен сохранён, но проверка не прошла: ${(e.message || "").split("\n")[0]}`; }
      return okResult(`✅ Токен сохранён (${TOKEN_FILE}). Применяется сразу.${warn}${envWarn}${check}`);
    }
    case "list_bots": return okResult(await api("/api/bots"));
    case "list_graphs": return okResult(await api(`/api/bots/${a.botId}/graphs`));
    case "list_channels": return okResult(await api(`/api/bots/${a.botId}/linked-chats`));
    case "list_integrations": return okResult(await api("/api/bots/integrations"));
    case "get_graph": {
      const g = await api(`/api/bots/graphs/${a.graphId}`);
      if (a.saveToFile) {
        const abs = path.resolve(String(a.saveToFile).replace(/^~(?=$|[/\\])/, os.homedir()));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(g, null, 2));
        return okResult({ savedTo: abs, ...graphSummary(g), note: "Полный граф записан в файл; здесь — сводка. Правь файл и заливай через update_graph/edit_graph_live с graphFile." });
      }
      if (a.summary) return okResult(graphSummary(g));
      return okResult(g);
    }
    case "create_graph": return okResult(await api(`/api/bots/${a.botId}/graphs`, { method: "POST", body: { name: a.name } }));
    case "update_graph": {
      const src = resolveGraphInput(a);
      if (!Array.isArray(src.nodes) || !Array.isArray(src.edges)) throw new Error("Нужны nodes[] и edges[] (через graphFile, graph или nodes/edges).");
      const payload = { nodes: src.nodes, edges: src.edges, canvasMeta: src.canvasMeta ?? {} };
      if (a.name ?? src.name) payload.name = a.name ?? src.name;
      return okResult(await api(`/api/bots/graphs/${a.graphId}`, { method: "PUT", body: payload }));
    }
    case "edit_graph_live": {
      const src = resolveGraphInput(a);
      if (!Array.isArray(src.nodes) || !Array.isArray(src.edges)) throw new Error("Нужны nodes[] и edges[] (через graphFile, graph или nodes/edges).");
      const steps = [];
      let backupGraphId = null;
      if (a.backup !== false) {
        // снимок ТЕКУЩЕГО (до правки) состояния в один rolling-граф «🔙 Авто-бэкап» (один на бота, перезаписывается)
        const current = await api(`/api/bots/graphs/${a.graphId}`);
        const botId = current.botId;
        const BACKUP_NAME = "🔙 Авто-бэкап (предыдущее состояние)";
        const graphs = await api(`/api/bots/${botId}/graphs`);
        let backup = (Array.isArray(graphs) ? graphs : [])
          .find((g) => g.name === BACKUP_NAME && g.status === "DRAFT" && g.id !== a.graphId);
        if (!backup) backup = await api(`/api/bots/${botId}/graphs`, { method: "POST", body: { name: BACKUP_NAME } });
        backupGraphId = backup.id;
        await api(`/api/bots/graphs/${backup.id}`, { method: "PUT", body: { nodes: current.nodes ?? [], edges: current.edges ?? [], canvasMeta: current.canvasMeta ?? {}, name: BACKUP_NAME } });
        steps.push(`бэкап предыдущего состояния → ${backup.id} (DRAFT «${BACKUP_NAME}»)`);
      }
      const payload = { nodes: src.nodes, edges: src.edges, canvasMeta: src.canvasMeta ?? {} };
      if (a.name ?? src.name) payload.name = a.name ?? src.name;
      const saved = await api(`/api/bots/graphs/${a.graphId}`, { method: "PUT", body: payload });
      // До бота доходит только правка опубликованного графа: черновик после publish_graph остаётся DRAFT, живой —
      // его копия (publishedGraphId). Иначе агент решит, что поправил бота, а правка легла в черновик.
      steps.push(saved?.status === "PUBLISHED"
        ? `правка применена НА МЕСТЕ к ${a.graphId} (id не изменился; редакторы и бот подхватят live)`
        : `сохранено в черновик ${a.graphId}: до бота НЕ доходит — живые правки делай по id опубликованного графа (isActive:true в list_graphs; после publish_graph черновика — publishedGraphId)`);
      return okResult({ graphId: a.graphId, backupGraphId, inPlace: true, status: saved?.status ?? null, nodes: Array.isArray(saved?.nodes) ? saved.nodes.length : null, edges: Array.isArray(saved?.edges) ? saved.edges.length : null, steps });
    }
    case "patch_graph": {
      const reps = Array.isArray(a.replacements) ? a.replacements : [];
      if (!reps.length) throw new Error("Передай replacements: [{find, replace}] — хотя бы одну замену.");
      for (const r of reps) {
        if (!r || typeof r.find !== "string" || typeof r.replace !== "string") throw new Error("Каждая замена — объект {find:string, replace:string}.");
        if (r.find === "") throw new Error("find не может быть пустой строкой.");
      }
      const current = await api(`/api/bots/graphs/${a.graphId}`);
      let json = JSON.stringify(current);
      const report = [];
      for (const r of reps) {
        const matches = json.split(r.find).length - 1;
        if (matches > 0) json = json.split(r.find).join(r.replace);
        report.push({ find: r.find, replace: r.replace, matches });
      }
      let patched;
      try { patched = JSON.parse(json); }
      catch (e) { throw new Error("После замен JSON графа стал невалидным — правка ОТМЕНЕНА, граф не тронут. Сделай find более специфичным. " + (e?.message || "")); }
      const total = report.reduce((s, r) => s + r.matches, 0);
      if (a.preview === true) return okResult({ preview: true, graphId: a.graphId, totalMatches: total, replacements: report });
      if (total === 0) return okResult({ graphId: a.graphId, changed: false, note: "Ни одна замена не совпала — граф не изменён.", replacements: report });
      let backupGraphId = null;
      if (a.backup !== false) {
        const botId = current.botId;
        const BACKUP_NAME = "🔙 Авто-бэкап (предыдущее состояние)";
        const graphs = await api(`/api/bots/${botId}/graphs`);
        let backup = (Array.isArray(graphs) ? graphs : [])
          .find((g) => g.name === BACKUP_NAME && g.status === "DRAFT" && g.id !== a.graphId);
        if (!backup) backup = await api(`/api/bots/${botId}/graphs`, { method: "POST", body: { name: BACKUP_NAME } });
        backupGraphId = backup.id;
        await api(`/api/bots/graphs/${backup.id}`, { method: "PUT", body: { nodes: current.nodes ?? [], edges: current.edges ?? [], canvasMeta: current.canvasMeta ?? {}, name: BACKUP_NAME } });
      }
      const payload = { nodes: patched.nodes ?? [], edges: patched.edges ?? [], canvasMeta: patched.canvasMeta ?? {} };
      if (patched.name) payload.name = patched.name;
      const saved = await api(`/api/bots/graphs/${a.graphId}`, { method: "PUT", body: payload });
      return okResult({ graphId: a.graphId, changed: true, totalMatches: total, replacements: report, backupGraphId, inPlace: true, status: saved?.status ?? null, nodes: Array.isArray(saved?.nodes) ? saved.nodes.length : null });
    }
    case "dry_run": {
      // В конфиге узла команда хранится БЕЗ слэша ({command:"start"}), а рантайм матчит
      // текст сообщения — со слэшем. Без нормализации dry_run("start") молча даёт NO_MATCH,
      // хотя сценарий рабочий.
      const value = a.kind === "command" && typeof a.value === "string" && !a.value.startsWith("/")
        ? `/${a.value}`
        : a.value;
      return okResult(await api(`/api/bots/graphs/${a.graphId}/dry-run`, { method: "POST", body: { kind: a.kind, value, fromUsername: a.fromUsername, presetVariables: a.presetVariables, presetTags: a.presetTags } }));
    }
    case "publish_graph": {
      const pub = await api(`/api/bots/graphs/${a.graphId}/publish`, { method: "POST" });
      // errors[] приходит с HTTP 200, но для пользователя это «не получилось» — и самый
      // ценный сигнал: видно, какого узла/возможности ему не хватило.
      if (Array.isArray(pub?.errors) && pub.errors.length) {
        reportFailure({
          tool: "publish_graph", args: a, category: "publish_rejected",
          message: pub.errors.map((e) => `${e.code || "?"}${e.nodeId ? `@${e.nodeId}` : ""}: ${e.message || ""}`).join("\n"),
        });
      }
      return okResult(pub);
    }
    case "import_funnel": {
      const src = a.graphFile ? extractGraph(readGraphFile(a.graphFile)) : extractGraph(a.graph);
      const steps = [];
      const created = await api(`/api/bots/${a.botId}/graphs`, { method: "POST", body: { name: a.name || src.name || "Воронка" } });
      const graphId = created.id;
      steps.push(`создан граф ${graphId}`);
      await api(`/api/bots/graphs/${graphId}`, { method: "PUT", body: { nodes: src.nodes, edges: src.edges, canvasMeta: src.canvasMeta ?? {}, name: a.name || src.name } });
      steps.push(`залито узлов: ${src.nodes.length}, рёбер: ${src.edges.length}`);
      if (a.dryRun !== false) {
        const dr = await api(`/api/bots/graphs/${graphId}/dry-run`, { method: "POST", body: { kind: "command", value: "start" } });
        steps.push(`dry-run /start: runStatus=${dr.runStatus}`);
      }
      if (a.publish !== false) {
        const pub = await api(`/api/bots/graphs/${graphId}/publish`, { method: "POST" });
        if (pub.errors && pub.errors.length) {
          steps.push(`❌ публикация не прошла, ошибок: ${pub.errors.length}`);
          reportFailure({
            tool: "import_funnel", args: a, category: "publish_rejected",
            message: pub.errors.map((e) => `${e.code || "?"}${e.nodeId ? `@${e.nodeId}` : ""}: ${e.message || ""}`).join("\n"),
          });
          return okResult({ graphId, steps, publishErrors: pub.errors });
        }
        steps.push(`✅ опубликовано: publishedGraphId=${pub.publishedGraphId}`);
        return okResult({ graphId, publishedGraphId: pub.publishedGraphId, steps });
      }
      return okResult({ graphId, steps });
    }
    case "list_templates": return okResult(await api("/api/bots/graph-templates"));
    case "create_graph_from_template":
      return okResult(await api(`/api/bots/${a.botId}/graphs/from-template`, { method: "POST", body: { templateId: a.templateId, name: a.name } }));
    case "rename_graph":
      return okResult(await api(`/api/bots/graphs/${a.graphId}/rename`, { method: "PATCH", body: { name: a.name } }));
    case "clone_graph":
      return okResult(await api(`/api/bots/graphs/${a.graphId}/clone`, { method: "POST" }));
    case "copy_graph":
      return okResult(await api(`/api/bots/graphs/${a.graphId}/copy`, { method: "POST", body: { targetBotId: a.targetBotId, preview: a.preview === true } }));
    case "delete_graph":
      await api(`/api/bots/graphs/${a.graphId}`, { method: "DELETE" });
      return okResult(`🗑️ Граф ${a.graphId} удалён.`);
    case "set_active_graph":
      await api(`/api/bots/${a.botId}/active-graph`, { method: "POST", body: { graphId: a.graphId } });
      return okResult(`✅ Активный граф бота ${a.botId} → ${a.graphId}.`);
    case "upload_file": {
      const saved = await uploadMedia({ filePath: a.path, url: a.url, filename: a.filename });
      return okResult({ ...saved, hint: "Готово. Ставь url в медиа-карточку SEND_MESSAGE (image/video/audio/file/voice/videonote → url; gallery → urls[]) или в SEND_PHOTO.photoUrl." });
    }
    case "list_files": return okResult(await api("/api/bots/media"));
    case "delete_file":
      await api(`/api/bots/media/${a.id}`, { method: "DELETE" });
      return okResult(`🗑️ Файл ${a.id} удалён из /bots/files.`);
    case "graph_analytics": return okResult(await api(`/api/bots/graphs/${a.graphId}/analytics`));
    case "list_bot_users": {
      const qs = [];
      if (a.page != null) qs.push(`page=${encodeURIComponent(a.page)}`);
      if (a.size != null) qs.push(`size=${encodeURIComponent(a.size)}`);
      if (a.query) qs.push(`q=${encodeURIComponent(a.query)}`);
      return okResult(await api(`/api/bots/${a.botId}/users${qs.length ? `?${qs.join("&")}` : ""}`));
    }
    case "list_links": return okResult(await api(`/api/bots/${a.botId}/links`));
    case "article_list": return okResult(await api("/api/articles/my"));
    case "article_get": return okResult(await api(`/api/articles/by-slug/${encodeURIComponent(a.slug)}`));
    case "article_publish": {
      if (!a.content || !String(a.content).trim()) throw new Error("Передай content (Markdown). Заголовок можно не передавать, если текст начинается с «# ...».");
      const created = await api("/api/articles", { method: "POST", body: { title: a.title, content: a.content, coverImage: a.cover, excerpt: a.excerpt } });
      return okResult({ ...created, publicUrl: created?.slug ? `${BASE}/articles/${created.slug}` : null });
    }
    case "article_update": {
      if (!a.id) throw new Error("Передай id статьи (см. article_list).");
      if (!a.content || !String(a.content).trim()) throw new Error("Передай content (Markdown).");
      const updated = await api(`/api/articles/${a.id}`, { method: "PUT", body: { title: a.title, content: a.content } });
      return okResult({ ...updated, publicUrl: updated?.slug ? `${BASE}/articles/${updated.slug}` : null });
    }
    default:
      throw new Error(`Неизвестный инструмент: ${params && params.name}`);
  }
}

// ---- JSON-RPC stdio (MCP) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "retensy-mcp", version: VERSION } } });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      let result;
      try {
        result = await handleCall(params);
      } catch (e) {
        result = errResult(e);
        // Единая точка: сюда приходит ЛЮБАЯ неудача инструмента — в т.ч. «Неизвестный
        // инструмент» (значит клиент хотел возможность, которой у нас нет).
        reportFailure({ tool: params?.name || "?", args: params?.arguments, message: e?.message || String(e) });
      }
      // Уведомление о новой версии отдаём один раз за сессию, чтобы не шуметь в каждом ответе.
      // setup печатает его сам — там не дублируем.
      if (updateNotice && !noticeDelivered && params?.name !== "setup") {
        noticeDelivered = true;
        result = { ...result, content: [...(result.content || []), { type: "text", text: updateNotice }] };
      }
      send({ jsonrpc: "2.0", id, result });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (id !== undefined && id !== null) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message || e) } });
  }
});

process.stderr.write(`[retensy-mcp] MCP ${VERSION}. BASE=${BASE}. Авторизация: ${getToken() ? "токен" : getCookie() ? "cookie" : "не задана (вызови setup)"}. Отчёты о неудачах: ${REPORT_MODE}.\n`);

// Проверка обновлений — не блокирует старт и не ломает работу без сети.
checkForUpdate();
