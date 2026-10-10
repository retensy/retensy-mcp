#!/usr/bin/env node
/**
 * retensy-mcp — MCP-сервер для сборки и публикации воронок ботов, рассылок, сайтов и статей
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

const VERSION = "0.20.0";
/** С чего начать пустой сайт (init у /document/ops; на сайте с черновиком игнорируется). */
const SITE_INITS = ["starter", "blank", "mini-landing"];
/** Безвредная операция, когда нужен только init: бэкенд не принимает пустой ops[]. */
const SITE_NOOP_OPS = [{ op: "set_settings", settings: {} }];
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

// =====================================================================// Отчёты о неудачах + проверка обновлений
// =====================================================================// ЗАЧЕМ: если клиент пытается сделать что-то, чего сервер не умеет (неизвестный
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

async function api(path_, { method = "GET", body, rawBody } = {}) {
  if (!isAuthed()) throw new Error(NO_AUTH_HELP);
  const res = await fetch(`${BASE}${path_}`, {
    method,
    headers: authHeaders(),
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(`Доступ отклонён (HTTP 401). Токен невалиден, отозван или истёк.\n` +
        `Создай новый на ${TOKENS_PAGE} и пришли мне — я сохраню через set_token.`);
    }
    if (res.status === 403) {
      // 403 бэкенд отдаёт и на «не твой бот/граф/подключение» — это не всегда про токен.
      const why = bodyReason(data);
      throw new Error(`Доступ отклонён (HTTP 403)${why ? `: ${why}` : ""}. Нет прав на этот объект (чужой бот/граф/подключение) ` +
        `или токен не действует. Если так отвечает любой инструмент — создай новый токен на ${TOKENS_PAGE} и пришли мне (set_token).`);
    }
    if (res.status === 402) throw paymentError(data);
    throw httpError(method, path_, res.status, data);
  }
  return data;
}

/** Причина отказа из тела ответа: {error}/{message} или строка. */
function bodyReason(data) {
  if (data == null) return "";
  if (typeof data === "string") return data.slice(0, 300);
  const e = data.message || data.error;
  return typeof e === "string" && e !== "Forbidden" && e !== "Payment Required" ? e.slice(0, 300) : "";
}

const SUBSCRIPTION_PAGE = `${BASE}/bots/subscription`;
const PAYMENT_REASONS = {
  broadcast_not_available: "рассылки недоступны на текущем тарифе",
  broadcast_quota_exceeded: "исчерпана месячная квота получателей рассылок",
};
/** 402 — оплата/тариф: через API не решается, отдаём ссылку, которую пользователь откроет сам. */
function paymentError(data) {
  const code = data && typeof data === "object" ? data.error : "";
  const reason = PAYMENT_REASONS[code] || bodyReason(data) || "лимит тарифа исчерпан";
  const url = (data && typeof data === "object" && typeof data.upgradeUrl === "string" && data.upgradeUrl) || SUBSCRIPTION_PAGE;
  const count = data && typeof data === "object" && data.count != null ? ` (получателей: ${data.count})` : "";
  const err = new Error(`Нужен тариф выше (HTTP 402): ${reason}${count}.\n` +
    `🔗 Открой ${url} — смена тарифа/оплата делается только в браузере. После оплаты повтори действие.`);
  err.status = 402;
  err.data = data;
  return err;
}

/**
 * Действие, которое нельзя сделать через API (OAuth/вход/оплата/2FA): не падаем, а отдаём прямую ссылку и
 * одну строку инструкции — ассистент передаёт её пользователю как есть.
 */
function linkResult(title, url, instruction, extra) {
  return okResult({ needsBrowser: true, title, url, instruction, ...(extra || {}) });
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
    if (res.status === 402) throw new Error(`Лимит хранилища тарифа исчерпан (HTTP 402). Удали ненужные файлы (delete_file) или подними тариф: 🔗 ${SUBSCRIPTION_PAGE}`);
    if (res.status === 413) throw new Error("Файл больше 50 МБ (HTTP 413) — лимит Telegram для видео/документов.");
    throw httpError("POST", "/api/bots/media", res.status, data);
  }
  return data;
}

// Ассет сайта из блоков: POST /api/bots/pages/{id}/upload (multipart, dir=assets). Бэкенд принимает имена только из
// [A-Za-z0-9._@()+- ], поэтому имя приводим к латинице с коротким суффиксом.
async function uploadSiteAsset(siteId, { filePath, url }) {
  if (!isAuthed()) throw new Error(NO_AUTH_HELP);
  if (!siteId) throw new Error("Передай siteId.");
  let bytes, name, mime;
  if (filePath) {
    const abs = path.resolve(String(filePath).replace(/^~(?=$|[/\\])/, os.homedir()));
    try { bytes = fs.readFileSync(abs); } catch { throw new Error(`Файл не найден: ${abs}`); }
    name = path.basename(abs);
    mime = guessMime(name);
  } else if (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Не удалось скачать файл по url (HTTP ${r.status}).`);
    bytes = Buffer.from(await r.arrayBuffer());
    try { name = path.basename(new URL(url).pathname) || "file"; } catch { name = "file"; }
    mime = r.headers.get("content-type") || guessMime(name);
  } else {
    throw new Error("Передай path (локальный файл) ИЛИ url.");
  }
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 9);
  const base = path.basename(name, path.extname(name)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "file";
  const safe = `${base}-${Math.random().toString(36).slice(2, 6)}${ext}`;
  const headers = {};
  const token = getToken(); const cookie = getCookie();
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (cookie) headers.Cookie = cookie;
  const fd = new FormData();
  fd.append("files", new Blob([bytes], { type: mime }), safe);
  fd.append("dir", "assets");
  const res = await fetch(`${BASE}/api/bots/pages/${siteId}/upload`, { method: "POST", headers, body: fd });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`Доступ отклонён (HTTP ${res.status}). Токен невалиден/отозван — создай новый на ${TOKENS_PAGE}.`);
    if (res.status === 402) throw new Error(`Лимит хранилища тарифа исчерпан (HTTP 402). Подними тариф: 🔗 ${SUBSCRIPTION_PAGE}`);
    throw httpError("POST", `/api/bots/pages/${siteId}/upload`, res.status, data);
  }
  return { asset: `assets/${safe}`, sizeBytes: bytes.length };
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
// Сервер хранит id узлов/рёбер как UUID: иначе PUT падал голым HTTP 400 без причины.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertGraphIds(g) {
  const bad = [];
  for (const n of g.nodes || []) if (!UUID_RE.test(String(n?.id))) bad.push(`узел ${n?.id}`);
  for (const e of g.edges || []) {
    for (const k of ["id", "sourceNodeId", "targetNodeId"]) if (!UUID_RE.test(String(e?.[k]))) bad.push(`ребро ${e?.id ?? "?"}.${k}=${e?.[k]}`);
  }
  if (bad.length) throw new Error(`id узлов и рёбер должны быть UUID (crypto.randomUUID()). Не UUID: ${bad.slice(0, 10).join(", ")}${bad.length > 10 ? ` и ещё ${bad.length - 10}` : ""}.`);
}
// chatId бывает больше 2^53 (виджет, MAX) — принимаем строкой, пропускаем только цифры (и минус у групп).
function pageQs(a) {
  const q = [];
  if (a.page != null) q.push(`page=${encodeURIComponent(a.page)}`);
  if (a.size != null) q.push(`size=${encodeURIComponent(a.size)}`);
  return q.length ? `?${q.join("&")}` : "";
}
function chatIdArg(v) {
  const s = String(v ?? "").trim();
  if (!/^-?\d{1,20}$/.test(s)) throw new Error(`chatId — число (из list_bot_users), получено: ${s || "пусто"}.`);
  return s;
}
function uuidArg(v, label) {
  const s = String(v ?? "").trim();
  if (!UUID_RE.test(s)) throw new Error(`${label} — UUID (например, из list_bots), получено: ${s || "пусто"}.`);
  return s;
}
// id из Mongo/строковые ключи: только безопасный сегмент пути, без «/», «..», пробелов.
function idArg(v, label) {
  const s = String(v ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error(`${label} — id из соответствующего списка, получено: ${s || "пусто"}.`);
  return s;
}
function enumArg(v, label, allowed) {
  const s = String(v ?? "").trim().toUpperCase();
  if (!allowed.includes(s)) throw new Error(`${label}: ${allowed.join(" | ")}, получено: ${s || "пусто"}.`);
  return s;
}
const LEAD_STATUSES = ["NEW", "IN_PROGRESS", "DONE", "REJECTED"];
function dateArg(v, label) {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`${label} — дата ГГГГ-ММ-ДД, получено: ${s || "пусто"}.`);
  return s;
}
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
// Поля календаря записи (BookingCalendar): переданные накладываются на base (для PUT — текущий календарь целиком).
function calendarBody(a, base = {}) {
  const b = { ...base };
  if (a.name != null) b.name = String(a.name).trim();
  if (a.zone != null) b.zone = String(a.zone).trim();
  if (a.botId !== undefined) b.botId = a.botId === null || a.botId === "" ? null : uuidArg(a.botId, "botId");
  if (a.slotMinutes != null) {
    const n = Number(a.slotMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) throw new Error("slotMinutes — целое от 5 до 1440.");
    b.slotMinutes = n;
  }
  if (a.hours != null) {
    if (!Array.isArray(a.hours)) throw new Error("hours — массив [{day: 1–7, from: \"HH:mm\", to: \"HH:mm\"}].");
    a.hours.forEach((h, i) => {
      if (!Number.isInteger(h?.day) || h.day < 1 || h.day > 7) throw new Error(`hours[${i}].day — от 1 (пн) до 7 (вс).`);
      if (!HHMM_RE.test(String(h.from)) || !HHMM_RE.test(String(h.to))) throw new Error(`hours[${i}]: from/to — время HH:mm.`);
    });
    b.hours = a.hours.map((h) => ({ day: h.day, from: h.from, to: h.to }));
  }
  if (a.exceptions != null) {
    if (!Array.isArray(a.exceptions)) throw new Error("exceptions — массив [{date: \"ГГГГ-ММ-ДД\", from?, to?}].");
    b.exceptions = a.exceptions.map((e, i) => {
      const date = dateArg(e?.date, `exceptions[${i}].date`);
      const closed = !e.from && !e.to;
      if (!closed && (!HHMM_RE.test(String(e.from)) || !HHMM_RE.test(String(e.to)))) throw new Error(`exceptions[${i}]: from/to — время HH:mm или оба пусты (выходной).`);
      return closed ? { date } : { date, from: e.from, to: e.to };
    });
  }
  return b;
}
// Компактная сводка графа (без объёмных text/cards/buttons) — чтобы не упираться в лимит токенов
// на больших графах. Узлы: id/type/title/позиция; рёбра: id/from/handle/to.
function graphSummary(g) {
  const nodes = (g?.nodes || []).map((n) => ({ id: n.id, type: n.type, title: n.config?._title || n.config?.title || null, x: n.position?.x, y: n.position?.y }));
  const edges = (g?.edges || []).map((e) => ({ id: e.id, from: e.sourceNodeId, h: e.sourceHandle, to: e.targetNodeId }));
  return { graphId: g?.id, name: g?.name, status: g?.status, version: g?.version, counts: { nodes: nodes.length, edges: edges.length }, nodes, edges };
}

// =====================================================================// Рассылки
// =====================================================================// Бэкенд на 400 отдаёт только статус (без причины), поэтому правила TgBroadcastController.validateDirectMessage
// повторены здесь — агент получает понятную ошибку до запроса, а не голый «HTTP 400».
const BC_TYPES = ["TEXT", "PHOTO", "VIDEO", "AUDIO", "FILE", "VOICE", "VIDEONOTE", "GALLERY"];
const BC_MEDIA = new Set(["PHOTO", "VIDEO", "AUDIO", "FILE", "VOICE", "VIDEONOTE"]);
const BC_MAX_MESSAGES = 5, BC_MAX_BOTS = 20, BC_MAX_BUTTONS = 8, BC_TEXT_MAX = 4096, BC_CAPTION_MAX = 1024;

/**
 * Сообщение рассылки как его строит мастер в кабинете (broadcastBlocks.ts → blocksToMessages).
 * Принимает и сокращения: строка → TEXT; url → mediaUrl; urls → mediaUrls; type в любом регистре.
 * strict=false (черновик) — только нормализация, без проверки полноты.
 */
function normalizeBroadcastMessage(m, i, strict = true) {
  if (typeof m === "string") m = { type: "TEXT", text: m };
  if (!m || typeof m !== "object") throw new Error(`messages[${i}]: ожидается объект {type, text?, mediaUrl?, mediaUrls?, buttons?}.`);
  const mediaUrl = (m.mediaUrl || m.url || m.photoUrl || "").trim();
  const type = String(m.type || (mediaUrl ? "PHOTO" : "TEXT")).toUpperCase();
  if (!BC_TYPES.includes(type)) throw new Error(`messages[${i}]: неизвестный type ${type}. Бывают: ${BC_TYPES.join(", ")}.`);
  const out = { type, parseMode: m.parseMode === null ? undefined : "HTML" };
  const text = typeof m.text === "string" && m.text.trim() ? m.text : undefined;
  if (text !== undefined && type !== "VIDEONOTE") out.text = text;
  if (BC_MEDIA.has(type)) { out.mediaUrl = mediaUrl; if (type === "PHOTO") out.photoUrl = mediaUrl; }
  if (type === "GALLERY") out.mediaUrls = (m.mediaUrls || m.urls || []).map((u) => String(u || "").trim()).filter(Boolean);
  const buttons = (Array.isArray(m.buttons) ? m.buttons : [])
    .filter((b) => b && String(b.text || "").trim() && String(b.url || "").trim())
    .map((b) => ({ text: String(b.text).trim(), url: String(b.url).trim() }));
  if (type !== "GALLERY") out.buttons = buttons;
  if (!strict) return out;
  if (type === "TEXT" && !out.text) throw new Error(`messages[${i}]: у TEXT нужен text.`);
  if (BC_MEDIA.has(type) && !out.mediaUrl) throw new Error(`messages[${i}]: у ${type} нужен mediaUrl (загрузи файл через upload_file и возьми url).`);
  if (type === "GALLERY" && (out.mediaUrls.length < 2 || out.mediaUrls.length > 10)) throw new Error(`messages[${i}]: GALLERY — от 2 до 10 картинок в mediaUrls.`);
  if (type === "GALLERY" && buttons.length) throw new Error(`messages[${i}]: у GALLERY не бывает кнопок — вынеси их в следующее сообщение.`);
  if (type === "VIDEONOTE" && text) throw new Error(`messages[${i}]: VIDEONOTE (кружок) не поддерживает текст.`);
  const plain = (out.text || "").replace(/<[^>]+>/g, "").length;
  const limit = type === "TEXT" ? BC_TEXT_MAX : BC_CAPTION_MAX;
  if (plain > limit) throw new Error(`messages[${i}]: текст длиннее ${limit} символов (${plain}).`);
  if (buttons.length > BC_MAX_BUTTONS) throw new Error(`messages[${i}]: не больше ${BC_MAX_BUTTONS} кнопок.`);
  for (const b of buttons) if (!/^(https?:\/\/|tg:\/\/)/i.test(b.url)) throw new Error(`messages[${i}]: кнопка «${b.text}» — url должен быть ссылкой https://… (callback-кнопок в рассылке нет).`);
  return out;
}

function normalizeBroadcastMessages(list, strict = true) {
  if (!Array.isArray(list)) list = list == null ? [] : [list];
  if (strict && (list.length < 1 || list.length > BC_MAX_MESSAGES)) throw new Error(`messages: от 1 до ${BC_MAX_MESSAGES} сообщений.`);
  if (list.length > BC_MAX_MESSAGES) throw new Error(`messages: не больше ${BC_MAX_MESSAGES}.`);
  return list.map((m, i) => normalizeBroadcastMessage(m, i, strict));
}

/** botIds из botIds[] или botId. */
function botIdsOf(a) {
  const ids = Array.isArray(a.botIds) ? a.botIds : a.botId ? [a.botId] : [];
  return [...new Set(ids.map(String).filter(Boolean))];
}

const strList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((t) => String(t).trim()).filter(Boolean);

/**
 * Время запуска → ISO-instant. Строка без пояса (2026-10-06T10:00) считается московской (+03:00) — как
 * продукт считает расписание повторов; «now»/пусто — сразу.
 */
function toInstant(v, field) {
  if (v == null || v === "" || v === "now") return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(s)) s = (s.length === 10 ? `${s}T00:00` : s.replace(" ", "T")) + "+03:00";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`${field}: не распознал время «${v}». Формат ISO 8601, например 2026-10-06T10:00:00+03:00.`);
  return d.toISOString();
}

/** У Instagram-ботов рассылок нет (окно 24 ч Meta) — отказываем до запроса. */
async function assertBroadcastBots(botIds) {
  if (!botIds.length) throw new Error("Передай botIds — id ботов (list_bots), по которым рассылать.");
  if (botIds.length > BC_MAX_BOTS) throw new Error(`botIds: не больше ${BC_MAX_BOTS} ботов за раз.`);
  const bots = await api("/api/bots");
  const byId = new Map((Array.isArray(bots) ? bots : []).map((b) => [String(b.id), b]));
  for (const id of botIds) {
    const b = byId.get(id);
    if (!b) throw new Error(`Бот ${id} не найден среди твоих ботов (list_bots).`);
    if (String(b.platform || "").toUpperCase() === "INSTAGRAM") {
      throw new Error(`Бот ${b.name || b.username || id} — Instagram: рассылок у Instagram-ботов нет (Meta разрешает писать только в окне 24 ч после сообщения пользователя). Используй сценарий с триггером.`);
    }
  }
  return byId;
}

function qs(params) {
  const parts = Object.entries(params).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

// Выгрузка (CSV/JSON): с savePath — в локальный файл (большие выгрузки не тащим в контекст), без — текстом.
function exportResult(data, savePath) {
  const text = data == null ? "" : typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (!savePath) return okResult(text || "Пусто: выгружать нечего.");
  const abs = path.resolve(String(savePath).replace(/^~(?=$|[/\\])/, os.homedir()));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return okResult({ saved: abs, bytes: Buffer.byteLength(text) });
}

// =====================================================================// Подключения сервисов
// =====================================================================/** IA v2: каталог и подключения — раздел «Интеграции». Старые /bots/connect|integrations остаются в кабинете (Instagram — там). */
const CONNECT_PAGE = `${BASE}/integrations`;
const INTEGRATIONS_PAGE = CONNECT_PAGE;
const LEGACY_CONNECT_PAGE = `${BASE}/bots/connect`;
/** Ключи с секретами: бэкенд их не отдаёт (только маска hint), но вычищаем и здесь — секрет не должен попасть в вывод. */
const SECRET_OUT_RX = /^(creds|credsEnc|credentials|password|api_?key|.*secret(key)?|.*token)$/i;
function withoutSecrets(v) {
  if (Array.isArray(v)) return v.map(withoutSecrets);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_OUT_RX.test(k) && typeof x !== "boolean") continue; // secret:true в схеме каталога — флаг, не секрет
    out[k] = withoutSecrets(x);
  }
  return out;
}
/** Поля кредов — как форма кабинета (IntegrationsPage.tsx PROVIDER_FIELDS). */
const PROVIDER_FIELDS = {
  AMOCRM: { name: "amoCRM", fields: { subdomain: "поддомен: acme из acme.amocrm.ru", longToken: "долгосрочный токен: amoCRM → Интеграции → ваша интеграция → Ключи и доступы" } },
  BITRIX24: { name: "Битрикс24", fields: { webhookUrl: "URL входящего вебхука: Приложения → Разработчикам → Входящий вебхук (права: CRM)" } },
  GETCOURSE: { name: "GetCourse", fields: { account: "аккаунт: school из school.getcourse.ru", apiKey: "секретный ключ: Настройки → API (показывается один раз)" } },
  YAMETRIKA: { name: "Яндекс Метрика", fields: { counterId: "номер счётчика", oauthToken: "OAuth-токен Яндекса с доступом к загрузке офлайн-конверсий (выдаётся на oauth.yandex.ru)" } },
  YOOKASSA: { name: "ЮKassa", fields: { shopId: "shopId магазина — число: ЮKassa → Настройки → Магазин", secretKey: "секретный ключ: ЮKassa → Интеграция → Ключи API (показывается один раз)" } },
};
const PROVIDER_ALIASES = {
  amocrm: "AMOCRM", amo: "AMOCRM", bitrix24: "BITRIX24", bitrix: "BITRIX24", getcourse: "GETCOURSE",
  yametrika: "YAMETRIKA", metrika: "YAMETRIKA", yandex_metrika: "YAMETRIKA", yandexmetrika: "YAMETRIKA",
  yookassa: "YOOKASSA", yukassa: "YOOKASSA", ukassa: "YOOKASSA",
  google_sheets: "GOOGLE_SHEETS", googlesheets: "GOOGLE_SHEETS", sheets: "GOOGLE_SHEETS", google: "GOOGLE_SHEETS",
  instagram: "INSTAGRAM", telegram: "TELEGRAM", max: "MAX",
};
const normProvider = (p) => PROVIDER_ALIASES[String(p || "").trim().toLowerCase().replace(/[\s.-]+/g, "_")] || String(p || "").trim().toUpperCase();

/** Instagram подключается только входом через Facebook (OAuth) и сейчас выключен в сервисе (instagram.enabled). */
function instagramAnswer() {
  return linkResult("Instagram: подключение через вход Facebook (OAuth) — сейчас выключено в сервисе", LEGACY_CONNECT_PAGE,
    "Instagram-аккаунт нельзя подключить по API или токену: только входом через Facebook в кабинете. Сейчас подключение Instagram в retensy выключено (страница /bots/instagram ведёт на список ботов). Открой каталог подключений по ссылке — когда Instagram включат, он появится там. Пока доступны Telegram и MAX (create_bot).");
}

const TOOLS = [
  { name: "setup", description: "Показать статус авторизации и пошаговую инструкцию подключения. Вызывай первым, если пользователь не знает, что делать, или при ошибке доступа.", inputSchema: { type: "object", properties: {} } },
  { name: "set_token", description: "Сохранить персональный токен (zmcp_...), который пользователь создал на /bots/mcp-tokens. Применяется сразу, без рестарта.", inputSchema: { type: "object", properties: { token: { type: "string", description: "Секрет токена, начинается с zmcp_" } }, required: ["token"] } },
  { name: "list_bots", description: "Список ботов пользователя (id, имя, статус).", inputSchema: { type: "object", properties: {} } },
  { name: "list_graphs", description: "Список сценариев САМОГО бота (без узлов). Вебхук-сценарии, которые лишь отвечают через этого бота, сюда не входят — их публикуют в вебе, в «Сценариях» автора.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  { name: "list_channels", description: "Список каналов/групп, подключённых к боту (chatId, title, type, статус бота, дата). chatId — числовой id для условия SUBSCRIBED («Подписан на канал»).", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  { name: "integration_catalog", description: "Каталог сервисов Integration Core (GET /api/integrations/catalog): [{provider, name, category, authType, configSchema: [{key, label, hint, secret}] — поля подключения, actions: [{kind, label, inputs}] — действия для сценария и coreDelivery, healthCheck — умеет ли integration_test, inbound: {events: [{key, label, vars: [{key, label, example}], paymentSucceeded}]} | null — провайдер умеет только исходящие действия}]. inbound.events — события для узла TRIGGER_WEBHOOK с заполненным config.provider (см. integration_ingress_url): events[].key идёт в config.event, vars[].key — переменные {{body.<key>}} в сценарии. paymentSucceeded:true — событие сверх обычного вебхука ещё и заводит узел «Оплата прошла» (headless или в чате подписчика, если платёжная ссылка была привязана к нему действием *_link). 404 — Integration Core выключен в сервисе. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "integration_status", description: "Статус подключения (GET /api/integrations/{id}/status): {status: UNKNOWN | OK | NEEDS_REAUTH (ключ отозван/устарел — обнови через connect_integration) | ERROR, lastCheckedAt, lastError, supported}. Только своё подключение (чужое — 403). Read-only, внешний сервис не вызывает.", inputSchema: { type: "object", properties: { connectionId: { type: "string", description: "id из list_integrations" } }, required: ["connectionId"] } },
  { name: "integration_test", description: "Проверить подключение (POST /api/integrations/{id}/test): выполняет ЖИВУЮ проверку ключа во внешнем сервисе от имени владельца (без побочных эффектов — ничего не создаёт) и обновляет статус. Ответ как у integration_status; supported:false — сервис проверку не умеет. Только своё подключение (чужое — 403); 404 — Integration Core выключен.", inputSchema: { type: "object", properties: { connectionId: { type: "string", description: "id из list_integrations" } }, required: ["connectionId"] } },
  { name: "channel_post", description: "Разовый пост от имени бота в канал/группу Telegram или MAX (раздел «Публикации», POST /api/bots/{botId}/linked-chats/{chatId}/post). Бот должен быть администратором канала (list_channels). text и/или mediaUrl — файл из upload_file (тип фото/видео/документ берётся из файла; чужие ссылки не принимаются). Лимиты: Telegram — 4096 символов текста, 1024 подписи к файлу; MAX — 4000. Ответ {ok, messageId?}. Публикует сразу — подтверди текст с пользователем.", inputSchema: { type: "object", properties: { botId: { type: "string" }, chatId: { type: "number", description: "chatId из list_channels" }, text: { type: "string" }, mediaUrl: { type: "string", description: "url из upload_file" } }, required: ["botId", "chatId"] } },
  { name: "list_integrations", description: "Список подключённых сервисов пользователя (GET /api/bots/integrations): {id, provider, title, hint, createdAt}. **id отсюда — это `connectionId`**, обязательное поле действий amocrm_send/amocrm_update/bitrix24_call/getcourse_send/getcourse_order/yametrika_event. Без него действие упадёт «не выбрано подключение». Креды не отдаются — только маскированный hint. Подключить новый — connect_integration. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "get_graph", description: "Получить граф по graphId. Для БОЛЬШИХ графов (десятки узлов JSON может превысить лимит токенов) используй summary:true (компактная сводка: id/type/title/позиции + рёбра) или saveToFile (записать полный граф на диск и вернуть сводку+путь — потом правь файл и заливай через update_graph/edit_graph_live с graphFile).", inputSchema: { type: "object", properties: { graphId: { type: "string" }, summary: { type: "boolean", description: "true = вернуть компактную сводку без объёмных text/cards/buttons" }, saveToFile: { type: "string", description: "Путь: записать полный граф (JSON) на диск, вернуть сводку + путь" } }, required: ["graphId"] } },
  { name: "create_graph", description: "Создать пустой граф (DRAFT) в боте. Возвращает граф с id.", inputSchema: { type: "object", properties: { botId: { type: "string" }, name: { type: "string" } }, required: ["botId", "name"] } },
  { name: "update_graph", description: "Залить узлы/рёбра в граф (PUT, сырой replace без бэкапа). Для правок СУЩЕСТВУЮЩЕГО/живого сценария используй edit_graph_live. Активный (PUBLISHED) граф сервер проверяет как публикацию: при ошибках HTTP 422 со всеми code@nodeId, граф НЕ сохранён. Черновик сохраняется без проверок публикации, кроме размера: граф больше 4 МБ → HTTP 422 GRAPH_TOO_LARGE, не сохранён. Принимает graphFile (путь к локальному файлу — НЕ нужно слать граф инлайном, удобно для больших графов), graph-контейнер или nodes/edges.", inputSchema: { type: "object", properties: { graphId: { type: "string" }, graphFile: { type: "string", description: "Путь к локальному JSON графа (контейнер retensy-bot-graph или {nodes,edges}); поддерживается ~" }, graph: { type: "object" }, nodes: { type: "array" }, edges: { type: "array" }, canvasMeta: { type: "object" }, name: { type: "string" } }, required: ["graphId"] } },
  { name: "edit_graph_live", description: "РЕКОМЕНДОВАННЫЙ способ правки СУЩЕСТВУЮЩЕГО (часто живого/опубликованного) сценария: редактирует ТОТ ЖЕ graphId НА МЕСТЕ (id не меняется) и сначала снимает авто-бэкап текущего состояния в один rolling-граф «🔙 Авто-бэкап». НЕ клонирует и НЕ создаёт новый активный граф. Открытые редакторы перечитают граф вживую (external_update), бот применит изменения сразу (читает активный граф заново из БД). Используй ВМЕСТО clone+publish, когда нужно поправить сценарий, который уже открыт/в проде. ВАЖНО: правку активного графа сервер проверяет как публикацию (валидатор, платные блоки, лимит блоков тарифа, платформа) — при ошибках HTTP 422 со всеми code@nodeId, граф НЕ изменён, бот работает на прежней версии. Прогоняй offline validate.mjs и dry_run заранее, чтобы не ловить 422. Живой граф бота — с isActive:true в list_graphs — для бот-сценария (после publish_graph черновика — publishedGraphId, не id черновика); правка черновика до бота не доходит.", inputSchema: { type: "object", properties: { graphId: { type: "string" }, graph: { type: "object" }, nodes: { type: "array" }, edges: { type: "array" }, canvasMeta: { type: "object" }, name: { type: "string" }, graphFile: { type: "string", description: "Путь к локальному JSON графа (вместо инлайн-передачи); поддерживается ~" }, backup: { type: "boolean", description: "Снимать авто-бэкап предыдущего состояния перед правкой (по умолчанию true)." } }, required: ["graphId"] } },
  { name: "patch_graph", description: "Точечная правка БОЛЬШОГО/живого графа без отправки графа целиком: сервер сам берёт граф по graphId, делает строковые замены в его JSON, проверяет валидность и заливает обратно НА МЕСТЕ (с авто-бэкапом). Идеально, когда граф слишком велик, чтобы передавать его целиком через update_graph/edit_graph_live — напр. сменить id канала в условиях SUBSCRIBED, ссылки кнопок, тексты. replacements: [{find, replace}] — заменяются ВСЕ вхождения; делай find максимально специфичным, чтобы не задеть лишнее. preview=true — только показать число совпадений, ничего не сохраняя. Бот применит изменения сразу только у опубликованного графа (читает активный граф заново из БД); патч черновика до бота не доходит. Результат для активного графа сервер проверяет как публикацию: ошибки → HTTP 422 со всеми code@nodeId, граф не изменён.", inputSchema: { type: "object", properties: { graphId: { type: "string" }, replacements: { type: "array", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] } }, preview: { type: "boolean", description: "true = только отчёт о числе совпадений, без сохранения" }, backup: { type: "boolean", description: "снять авто-бэкап предыдущего состояния перед правкой (по умолчанию true)" } }, required: ["graphId", "replacements"] } },
  { name: "dry_run", description: "Прогнать сценарий без публикации. kind: command|callback|text. Внешние действия (HTTP, CRM, таблицы, письма, ИИ) пропускаются (skipped: dry-run). Статус прогона: OK, FAILED (прерван) или PARTIAL — «завершён с ошибками»: дошёл до конца, но хотя бы одно действие упало (у шага ok:false, error «КОД: …»).", inputSchema: { type: "object", properties: { graphId: { type: "string" }, kind: { type: "string", enum: ["command", "callback", "text"] }, value: { type: "string" }, fromUsername: { type: "string" }, presetVariables: { type: "object" }, presetTags: { type: "array", items: { type: "string" } } }, required: ["graphId", "kind", "value"] } },
  { name: "publish_graph", description: "Опубликовать граф. У бота ОДИН активный сценарий: публикация черновика заменяет содержимое активного (id живого графа сохраняется); прежняя активная версия, которой нет ни в одном черновике бота (правки вживую), сохраняется черновиком «… (была активной до дата время)». Вернёт publishedGraphId; при отказе проверок — ошибка HTTP 422 со всеми причинами построчно (code@nodeId: message). Сценарий-вебхук (источник WEBHOOK) этим инструментом не публикуется — HTTP 409, его публикуют в вебе.", inputSchema: { type: "object", properties: { graphId: { type: "string" } }, required: ["graphId"] } },
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
  { name: "site_list", description: "Сайты пользователя (раздел «Страницы», GET /api/bots/pages): id, title, mode (BLOCKS — сайт из блоков, CODE — файлы/Mini App), url (основной адрес), publishedRevision. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "site_create", description: "Создать сайт из блоков (POST /api/bots/pages, mode=BLOCKS). Возвращает id. Дальше: site_edit (init=starter — стартовый лендинг, init=blank — пустая главная, init=mini-landing — мини-лендинг с кнопками мессенджеров) → site_publish. template (starter|blank|mini-landing) — сразу создать черновик из шаблона (как «Мини-лендинг» в редакторе), в ответе revision. slug — «название» в адресе pages.retensy.com/<id>/<slug>/ (необязательно, по умолчанию транслит title).", inputSchema: { type: "object", properties: { title: { type: "string" }, slug: { type: "string" }, template: { type: "string", enum: ["starter", "blank", "mini-landing"] } }, required: ["title"] } },
  { name: "site_get", description: "Модель сайта из блоков (GET /api/bots/pages/{siteId}/document): revision, draft (SiteModel: theme, globals.header/footer, pages[].blocks[], popups[]) — id страниц/блоков/попапов нужны для site_edit. draft=null — сайт пуст (первый site_edit создаст его). saveToFile — записать модель на диск и вернуть путь.", inputSchema: { type: "object", properties: { siteId: { type: "string" }, saveToFile: { type: "string" } }, required: ["siteId"] } },
  { name: "site_schema", description: "JSON Schema модели сайта (model) и операций правки (ops) — какие блоки и поля бывают (GET /api/bots/pages/schema). Читай перед первой правкой.", inputSchema: { type: "object", properties: {} } },
  { name: "site_edit", description: "Правка сайта операциями — всё или ничего (POST /api/bots/pages/{siteId}/document/ops). " +
    "Страницы: add_page{title} · update_page{pageId,patch: {title?, path?, seo?{title,description,noindex,ogTitle,ogDescription,ogImage}, showHeader?, showFooter?, folder?}} · remove_page{pageId} · move_page{pageId,delta}. " +
    "Папки страниц: add_folder{name} (id в results) · rename_folder{folderId,name} · remove_folder{folderId}; страница в папку — update_page{pageId, patch:{folder: folderId}}. " +
    "Дизайны (отдельные экраны-макеты из Zero-кадров): add_design{name} (id в results) · update_design{designId,name} · remove_design{designId} · add_design_frame{designId,name,w,h} → в results blockId Zero-кадра, дальше с ним работают операции Zero-элементов. " +
    "Шаблоны: add_template{container, templateId, after?} — вставить шаблон из библиотеки (site_templates). " +
    "Блоки: add_block{container: id страницы|попапа, type, after?, variant?, props?, style?} · update_block{blockId, props?, style?, variant?} · move_block{blockId,delta} · duplicate_block{blockId} · remove_block{blockId}. " +
    "Код блока: get_block_code{blockId} (results[i].code: Zero — разметка <zero>…</zero>, остальные — JSON) · set_block_code{blockId,code} · add_block_code{container,code,after?}. " +
    "Zero-блок (type zero, свободная вёрстка как в Tilda): add_element{blockId, kind: text|image|button|shape|video|html|group, frame?{d:{x,y,w,h,container?,axisX?,axisY?}, t?, m?}, props?, style?, hover?, anim?, link?, parent?, name?, fixed?} · update_element{blockId,elementId, …те же поля, hidden?, locked?, link:null — убрать} · remove_element · move_element{delta: +1 — слой выше} · group_elements{blockId,elementIds[],name?} · ungroup_element. " +
    "Сайт: set_global{slot: header|footer, on} · set_theme{theme} · set_settings{settings} · add_popup{name} · update_popup{popupId,name?,width?} · remove_popup{popupId}. " +
    "props/style/theme/frame — JSON Merge Patch (null удаляет ключ, массивы заменяются целиком). Типы блоков: header, cover, text, image, gallery, buttons, features, form, video, html, spacer, footer, zero, messengers. " +
    "Значения по экранам: {d, t?, m?} (десктоп/планшет/телефон). revision — защита от перезаписи (409, если сайт изменили); init (starter|blank|mini-landing) — с чего начать пустой сайт (на сайте с черновиком игнорируется); только init без ops — создать черновик из шаблона. " +
    "Ответ: новая revision и results[] с id созданного (и code у get_block_code). Ошибки — HTTP 422 с путями. Тариф: HTML-блок и HTML-элемент Zero публикуются только на платном тарифе (422 при site_publish).", inputSchema: { type: "object", properties: { siteId: { type: "string" }, ops: { type: "array", items: { type: "object" } }, revision: { type: "number" }, init: { type: "string", enum: ["starter", "blank", "mini-landing"] } }, required: ["siteId"] } },
  { name: "site_publish", description: "Опубликовать черновик сайта (POST /api/bots/pages/{siteId}/publish): рендер в статику, адрес начинает отдавать новую версию. Ошибки проверки — HTTP 422 с путями. Возвращает publishedRevision и url.", inputSchema: { type: "object", properties: { siteId: { type: "string" } }, required: ["siteId"] } },
  { name: "site_upload_asset", description: "Загрузить картинку/видео в сайт (POST /api/bots/pages/{siteId}/upload, папка assets). Передай path (локальный файл) ИЛИ url. Возвращает asset — строку вида assets/<имя> для полей image/logo/icon/style.bg.image.", inputSchema: { type: "object", properties: { siteId: { type: "string" }, path: { type: "string" }, url: { type: "string" } }, required: ["siteId"] } },
  { name: "site_rollback", description: "Вернуть прошлую публикацию сайта (POST /api/bots/pages/{siteId}/publish/rollback): revision — номер из истории публикаций (site_get → versions[]). Черновик заменяется этой версией и сразу публикуется. Возвращает publishedRevision и url.", inputSchema: { type: "object", properties: { siteId: { type: "string" }, revision: { type: "number" } }, required: ["siteId", "revision"] } },
  { name: "site_domains", description: "Свои домены сайта (/api/bots/pages/{siteId}/domains). action: list — домены, статусы и dnsTarget (IP для A-записи); add {host, withWww?} — привязать (withWww у корневого домена добавляет www-пару); check {domainId} — перепроверить DNS и сертификат; remove {domainId} — отвязать. Число доменов ограничено тарифом (HTTP 402 с upgradeUrl). Каждое действие возвращает актуальный список.", inputSchema: { type: "object", properties: { siteId: { type: "string" }, action: { type: "string", enum: ["list", "add", "check", "remove"] }, host: { type: "string" }, withWww: { type: "boolean" }, domainId: { type: "string" } }, required: ["siteId", "action"] } },
  { name: "site_lead_settings", description: "Куда доставлять заявки из форм сайта (/api/bots/pages/{siteId}/lead-settings). Без settings — прочитать: {settings, scenarios (вебхук-сценарии), amoConnections, coreConnections: [{id, name, provider}] — подключения для доставки «Интеграция», без кредов}. С settings — сохранить ЦЕЛИКОМ (сначала прочитай и поменяй нужное): {notifyBot: в бот уведомлений из профиля, notifyEmail: письмо на почту аккаунта, webhookUrl?: POST JSON на ваш адрес, scenarioId?: вебхук-сценарий, который запускает заявка, amoConnectionId?: сделка в amoCRM, coreDelivery?: {connectionId: id из coreConnections, kind: действие сервиса из integration_catalog (actions[].kind, например amocrm_send), params?: {поле действия: шаблон}} | null}. Пустые params заполнятся из заявки (имя, телефон, почта, текст); в шаблонах — {{var.name}}, {{var.phone}}, {{var.email}}, {{var.<имя поля>}}, {{var.lead_text}} (текст заявки). Чужое подключение или неизвестный kind — 400. Запуск сценариев по заявке — триггер TRIGGER_SITE_FORM (скилл build-bot-funnel).", inputSchema: { type: "object", properties: { siteId: { type: "string" }, settings: { type: "object", properties: { notifyBot: { type: "boolean" }, notifyEmail: { type: "boolean" }, webhookUrl: { type: "string" }, scenarioId: { type: "string" }, amoConnectionId: { type: "string" }, coreDelivery: { type: ["object", "null"], properties: { connectionId: { type: "string" }, kind: { type: "string" }, params: { type: "object", additionalProperties: { type: "string" } } } } } } }, required: ["siteId"] } },
  { name: "site_leads", description: "Заявки из форм сайта (GET /api/bots/pages/{siteId}/leads): поля, UTM, статус доставки и обработки. page (с 0), size (до 100), status — фильтр NEW|IN_PROGRESS|DONE|REJECTED. Read-only.", inputSchema: { type: "object", properties: { siteId: { type: "string" }, page: { type: "number" }, size: { type: "number" }, status: { type: "string", enum: ["NEW", "IN_PROGRESS", "DONE", "REJECTED"] } }, required: ["siteId"] } },
  { name: "article_list", description: "Список СВОИХ статей блога retensy (GET /api/articles/my): id, slug, title, viewCount, даты. id нужен для article_update, slug — публичный адрес /articles/{slug}. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "article_get", description: "Получить статью блога по slug (GET /api/articles/by-slug/{slug}) — публичное чтение, в т.ч. чужие. Возвращает title, content (Markdown), excerpt, coverImage, viewCount.", inputSchema: { type: "object", properties: { slug: { type: "string", description: "slug статьи (часть адреса /articles/{slug})" } }, required: ["slug"] } },
  { name: "article_publish", description: "Опубликовать НОВУЮ статью блога retensy (POST /api/articles). content — Markdown (как README на GitHub: заголовки, списки, таблицы, код, картинки по URL). title необязателен: если не передать, заголовком станет первая строка вида «# Заголовок», и она убирается из текста. Обложку можно задать явно через cover (URL картинки) — иначе берётся первая картинка из текста; excerpt (SEO-описание) тоже можно задать явно, иначе генерируется из текста. Возвращает статью с id и slug + публичный URL.", inputSchema: { type: "object", properties: { title: { type: "string", description: "Заголовок (необязателен, если content начинается с «# ...»)" }, content: { type: "string", description: "Тело статьи в Markdown" }, cover: { type: "string", description: "URL обложки (coverImage/OG). Если не задан — берётся первая картинка из текста." }, excerpt: { type: "string", description: "Краткое SEO-описание (≤160 симв). Если не задан — генерируется из текста." } }, required: ["content"] } },
  { name: "article_update", description: "Обновить СВОЮ статью по id (PUT /api/articles/{id}; id бери из article_list). content — Markdown; title необязателен (как в article_publish, иначе берётся из «# ...»). Только владелец — чужую вернёт 403.", inputSchema: { type: "object", properties: { id: { type: "string", description: "id статьи из article_list" }, title: { type: "string" }, content: { type: "string", description: "Новое тело в Markdown" } }, required: ["id", "content"] } },
  // ---- ИИ-агенты и база знаний ----
  { name: "agent_list", description: "Список ИИ-агентов пользователя (GET /api/bots/agents): карточки — id, имя, статус. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "agent_get", description: "ИИ-агент по id (GET /api/bots/agents/{agentId}): настройки (имя, язык, тон, длина/формат ответа, инструкции, запретные/передаточные темы, kbId базы знаний, статус). Чужой агент — 404. Read-only.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "agent_create", description: "Создать ИИ-агента (POST /api/bots/agents): name, description — необязательны. Вместе с агентом создаётся его база знаний (kbId в ответе) — дальше kb_add_qa/kb_add_text/kb_add_site.", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } } } },
  { name: "agent_update", description: "Изменить настройки агента (PATCH /api/bots/agents/{agentId}): patch — объект с полями для правки (name, description, language: RU|EN|AUTO, tone: FRIENDLY|NEUTRAL|FORMAL, answerLength: SHORT|MEDIUM|LONG, format: PLAIN|LIST_FRIENDLY, instructions, forbiddenTopics[], handoffTopics[], fallback). Применяется частично — передавай только то, что меняешь.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, patch: { type: "object", description: "Поля агента для частичного обновления" } }, required: ["agentId", "patch"] } },
  { name: "agent_publish", description: "Опубликовать агента (POST /api/bots/agents/{agentId}/publish): агент начинает отвечать в подключённых сценариях. HTTP 409 CHECKLIST_FAILED с чеклистом, если агент ещё не готов (нет базы знаний, пустые инструкции и т.п.) — агент не меняется.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "agent_health", description: "Здоровье базы знаний агента (GET /api/bots/agents/{agentId}/health): счётчики документов/фрагментов по запросу, без кэша. Read-only.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "agent_test_chat", description: "Проверить ответ агента в песочнице без отправки клиенту (POST /api/bots/agents/{agentId}/test-chat): question (1–1000 символов), history — необязательная история диалога [{role: client|agent, text}], до 12 реплик. ТРАТИТ бюджет ИИ, как настоящий ответ — не вызывай массово.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, question: { type: "string" }, history: { type: "array", items: { type: "object", properties: { role: { type: "string", enum: ["client", "agent"] }, text: { type: "string" } } } } }, required: ["agentId", "question"] } },
  { name: "kb_docs", description: "Документы базы знаний агента (GET /api/bots/kb/{kbId}/docs): источник (FILE/QA/SITE), статус индексации, число фрагментов. Только верхний уровень — у сайта страницы видны счётчиком. Read-only.", inputSchema: { type: "object", properties: { kbId: { type: "string", description: "kbId агента (agent_get)" } }, required: ["kbId"] } },
  { name: "kb_add_qa", description: "Добавить пары вопрос-ответ в базу знаний (POST /api/bots/kb/{kbId}/docs/qa): pairs — [{question, answer}], до 200 пар за раз (вопрос ≤500 символов, ответ ≤4000). Каждая пара — отдельный фрагмент для поиска.", inputSchema: { type: "object", properties: { kbId: { type: "string" }, pairs: { type: "array", items: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] } } }, required: ["kbId", "pairs"] } },
  { name: "kb_add_text", description: "Добавить источник «Текст/инструкция» в базу знаний (POST /api/bots/kb/{kbId}/docs/text): title (≤120 символов), text (≤100 000 символов). Индексация уходит в фон — документ появится в kb_docs со статусом PENDING → READY.", inputSchema: { type: "object", properties: { kbId: { type: "string" }, title: { type: "string" }, text: { type: "string" } }, required: ["kbId", "title", "text"] } },
  { name: "kb_add_site", description: "Добавить сайт в базу знаний обходом страниц (POST /api/bots/kb/{kbId}/docs/site): url (http/https, не внутренняя сеть), schedule — расписание повторного обхода: NEVER|DAILY|WEEKLY|MONTHLY (по умолчанию NEVER). Обход уходит в фон; документ появится в kb_docs со статусом PENDING.", inputSchema: { type: "object", properties: { kbId: { type: "string" }, url: { type: "string" }, schedule: { type: "string", enum: ["NEVER", "DAILY", "WEEKLY", "MONTHLY"] } }, required: ["kbId", "url"] } },
  { name: "kb_reindex", description: "Переиндексировать документ-файл базы знаний из сохранённого оригинала (POST /api/bots/kb/{kbId}/docs/{docId}/reindex) — «Повторить» после ошибки. headerRow — необязательно, для табличных файлов: номер строки с шапкой (1..50), если автоопределение ошиблось. Только для источника FILE.", inputSchema: { type: "object", properties: { kbId: { type: "string" }, docId: { type: "string" }, headerRow: { type: "number" } }, required: ["kbId", "docId"] } },
  { name: "agent_unanswered", description: "Вопросы без ответа агента за период (GET /api/bots/agents/{agentId}/unanswered): days — 7|30|90 (по умолчанию 30). Группы вопросов, на которые агент не нашёл ответ в базе знаний — подсказка, что туда добавить. Read-only.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, days: { type: "number", enum: [7, 30, 90] } }, required: ["agentId"] } },
  // ---- Боты ----
  { name: "create_bot", description: "Подключить бота по токену (POST /api/bots): platform TELEGRAM (токен от @BotFather) или MAX (токен от MasterBot в MAX). Вебхук настраивается сам; name — отображаемое имя (иначе @username). Возвращает бота с id. Число ботов ограничено тарифом — HTTP 402 со ссылкой на смену тарифа. platform WEB — чат-виджет для сайта без токена (POST /api/bots/web): вернёт botId, key и snippet — код вставки на сайт (у существующего виджета — web_widget_snippet). platform INSTAGRAM по токену не подключается (только вход через Facebook в кабинете, сейчас выключен) — инструмент вернёт ссылку на кабинет вместо ошибки.", inputSchema: { type: "object", properties: { platform: { type: "string", enum: ["TELEGRAM", "MAX", "WEB", "INSTAGRAM"] }, token: { type: "string", description: "Токен бота: 123456789:AA… (Telegram) или токен MAX" }, name: { type: "string" } }, required: ["platform"] } },
  { name: "bot_stop", description: "Остановить бота (POST /api/bots/{botId}/stop): снимает вебхук, бот перестаёт отвечать, сценарии и подписчики сохраняются. Запуск обратно — bot_resume.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  { name: "bot_resume", description: "Запустить остановленного бота или бота, приостановленного лимитом тарифа (POST /api/bots/{botId}/resume). Если лимит ботов тарифа исчерпан — HTTP 402 со ссылкой на смену тарифа.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  // ---- Подключения ----
  { name: "connect_integration", description: "Подключить сервис (POST /api/bots/integrations) — дальше его id (= connectionId) ставится в действия сценария и в site_lead_settings. provider и creds: AMOCRM {subdomain, longToken} · BITRIX24 {webhookUrl} · GETCOURSE {account, apiKey} · YAMETRIKA {counterId, oauthToken} · YOOKASSA {shopId, secretKey}. Остальные ~25 сервисов (smsru, retailcrm, cloudpayments, rest_api, yandex_market и т.д.) берутся из каталога Integration Core (integration_catalog) — provider передавай его provider-ключом в НИЖНЕМ регистре, нужные creds — из configSchema каждого провайдера (hint подскажет, где взять; поле с «необязательно»/optional в hint можно не слать). Без нужных creds вернёт, какие поля и где их взять. connectionId — обновить креды/название существующего подключения (PUT). Сервисы со входом через браузер не падают, а возвращают ссылку для пользователя: GOOGLE_SHEETS → ссылка согласия Google (OAuth; после неё таблицы выбираются в узле «Google Таблицы»), INSTAGRAM → кабинет (вход через Facebook, сейчас выключен). TELEGRAM/MAX — это боты: используй create_bot. Провайдер каталога со статусом COMING_SOON/IN_DEVELOPMENT подключить нельзя (вернёт ошибку). Если каталог недоступен (офлайн/выключен) — работают только 5 легаси-провайдеров выше. Креды хранятся в сервисе зашифрованными и НИКОГДА не возвращаются — ни здесь, ни в list_integrations (только маска hint); в отчёты не попадают. Проверить ключ после подключения — integration_test.", inputSchema: { type: "object", properties: { provider: { type: "string", description: "AMOCRM | BITRIX24 | GETCOURSE | YAMETRIKA | YOOKASSA | GOOGLE_SHEETS | INSTAGRAM, либо провайдер из integration_catalog (его ключ в нижнем регистре, напр. smsru, retailcrm, cloudpayments)" }, title: { type: "string", description: "Название подключения в кабинете (например «amoCRM продажи»)" }, creds: { type: "object", description: "Поля провайдера: для легаси — см. описание, для остальных — ключи из configSchema провайдера в integration_catalog" }, connectionId: { type: "string", description: "id существующего подключения (list_integrations) — обновить его" } }, required: ["provider"] } },
  { name: "disconnect_integration", description: "Удалить подключение сервиса по id из list_integrations (DELETE /api/bots/integrations/{id}). Действия сценария с этим connectionId перестанут работать.", inputSchema: { type: "object", properties: { connectionId: { type: "string" } }, required: ["connectionId"] } },
  { name: "integration_ingress_url", description: "URL ингресса для триггера «Внешние события» (POST /api/bots/integrations/{id}/ingress-url, лениво создаёт токен при первом вызове; rotate:true — /ingress-url/rotate: старый URL сразу перестаёт принимать запросы). Вставь этот URL в сервис провайдера (CRM/кассу/форму) как webhook/notification/result URL, чтобы его события доходили до сценария. В сценарии добейся узла TRIGGER_WEBHOOK с config = {provider: provider-ключ в нижнем регистре (из integration_catalog), connectionId: id из list_integrations, event: events[].key из inbound.events того же provider в каталоге} — именно эти три поля конструктор и бэкенд читают для триггера интеграции (GraphValidator.validateWebhookTrigger / IngressFanout); без provider+connectionId узел ведёт себя как обычный TRIGGER_WEBHOOK с произвольным адресом. Только своё подключение (чужое — 403).", inputSchema: { type: "object", properties: { connectionId: { type: "string", description: "id из list_integrations" }, rotate: { type: "boolean", description: "true — выпустить новый URL, старый сразу отключится" } }, required: ["connectionId"] } },
  // ---- Рассылки ----
  { name: "broadcast_list", description: "Рассылки. Без botId — по всем ботам постранично (GET /api/bots/broadcasts): {counts: {drafts, scheduled, sent, recurring}, page: {content: [{id, botId, botUsername, name, status, direct, totalJobs, sentJobs, failedJobs, skippedByQuota, scheduledAt, createdAt}], totalElements…}}; group: scheduled (ещё не начали) | sent (идут/завершены). С botId — полная история одного бота. status: EXPANDING/MATERIALIZING/READY (ждёт) → RUNNING → DONE | CANCELLING → CANCELLED | FAILED. Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" }, group: { type: "string", enum: ["scheduled", "sent"] }, page: { type: "number" }, size: { type: "number", description: "до 100, по умолчанию 20" } } } },
  { name: "broadcast_get", description: "Рассылка целиком по id (GET /api/bots/broadcasts/{id}): статус, счётчики отправки, фильтр аудитории, сообщения, время. При failedJobs > 0 — ещё errors: топ-5 причин ошибок [{error, count}] (GET …/{id}/errors; детали живут 30 дней). Read-only.", inputSchema: { type: "object", properties: { broadcastId: { type: "string" } }, required: ["broadcastId"] } },
  { name: "broadcast_preview", description: "Сколько подписчиков получат рассылку (POST /api/bots/{botId}/broadcasts/preview) — по каждому боту и всего. Фильтр по тегам: tagsAll — есть ВСЕ эти теги, tagsNone — нет НИ ОДНОГО; без тегов — все подписчики бота. Лимит — 50 000 получателей на бота. Ничего не отправляет.", inputSchema: { type: "object", properties: { botIds: { type: "array", items: { type: "string" } }, botId: { type: "string" }, tagsAll: { type: "array", items: { type: "string" } }, tagsNone: { type: "array", items: { type: "string" } } } } },
  { name: "broadcast_send", description: "Отправить рассылку сейчас или запланировать (scheduledAt). " +
    "Прямая (по умолчанию, POST /api/bots/broadcasts/direct): name, botIds[] (1–20 ботов ОДНОГО владельца; по каждому создаётся своя рассылка), messages[] (1–5), tagsAll?/tagsNone? (фильтр по тегам). " +
    "Сообщение: {type, text?, mediaUrl?, mediaUrls?, buttons?}; type: TEXT (text обязателен, до 4096) · PHOTO | VIDEO | AUDIO | FILE | VOICE (mediaUrl обязателен, text — подпись до 1024) · VIDEONOTE (кружок: mediaUrl, без текста) · GALLERY (mediaUrls: 2–10 картинок, подпись, БЕЗ кнопок). " +
    "text — Telegram-HTML: <b> <i> <u> <s> <code> <pre> <blockquote> <tg-spoiler> <a href=\"https://…\">, перенос строки — \\n (не <br>); прочее экранируется. buttons — до 8 URL-кнопок [{text, url}] (callback-кнопок в рассылке нет). Можно строкой — это TEXT. Медиа — сначала upload_file, потом его url. " +
    "По сценарию (graphId): POST /api/bots/{botId}/broadcasts — один botId, сценарий самого бота, entryNodeId? — с какого узла начать. " +
    "draftId — отправить черновик (поля черновика, переданные аргументы их перекрывают); после отправки черновик удаляется. " +
    "scheduledAt — ISO 8601 (без пояса — московское время); пусто — сразу. Немедленная резервирует квоту получателей тарифа, отложенная считает аудиторию в момент отправки. Рассылки только на платном тарифе — HTTP 402 со ссылкой. У Instagram-ботов рассылок нет. Возвращает {broadcastIds, totalAudience}.", inputSchema: { type: "object", properties: { name: { type: "string" }, botIds: { type: "array", items: { type: "string" } }, botId: { type: "string" }, messages: { type: "array", items: {} }, tagsAll: { type: "array", items: { type: "string" } }, tagsNone: { type: "array", items: { type: "string" } }, scheduledAt: { type: "string", description: "ISO 8601, напр. 2026-10-06T10:00:00+03:00; пусто — сразу" }, graphId: { type: "string", description: "рассылка запуском сценария бота вместо сообщений" }, entryNodeId: { type: "string" }, draftId: { type: "string" } } } },
  { name: "broadcast_cancel", description: "Отменить рассылку (POST /api/bots/broadcasts/{id}/cancel): запланированная не уйдёт, идущая остановится (статус CANCELLING → CANCELLED). Уже завершённую отменить нельзя — HTTP 409.", inputSchema: { type: "object", properties: { broadcastId: { type: "string" } }, required: ["broadcastId"] } },
  { name: "broadcast_recurring", description: "Повторяющиеся рассылки (/api/bots/broadcasts/recurring). action: list — правила (активные и остановленные); create {name, botIds[], messages[], tagsAll?, tagsNone?, recurrence: DAILY|MONTHLY|YEARLY, firstRunAt} — сообщения как в broadcast_send, firstRunAt — первый запуск в будущем (ISO 8601, без пояса — московское), дальше в то же время суток/число (Москва); stop {ruleId} — остановить правило (уже отправленные прогоны не трогаются). Нужен платный тариф (402 со ссылкой).", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "create", "stop"] }, ruleId: { type: "string" }, name: { type: "string" }, botIds: { type: "array", items: { type: "string" } }, botId: { type: "string" }, messages: { type: "array", items: {} }, tagsAll: { type: "array", items: { type: "string" } }, tagsNone: { type: "array", items: { type: "string" } }, recurrence: { type: "string", enum: ["DAILY", "MONTHLY", "YEARLY"] }, firstRunAt: { type: "string" } }, required: ["action"] } },
  { name: "broadcast_drafts", description: "Черновики рассылок (/api/bots/broadcasts/drafts) — те же, что в мастере кабинета. action: list · get {draftId} · create {name?, botIds?, messages?, tagsAll?, tagsNone?, scheduledAt?} · update {draftId, …те же поля — переданные заменяют, остальные остаются} · delete {draftId}. Черновик не проверяется на полноту; отправить — broadcast_send {draftId}. Лимит — 200 черновиков.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "get", "create", "update", "delete"] }, draftId: { type: "string" }, name: { type: "string" }, botIds: { type: "array", items: { type: "string" } }, messages: { type: "array", items: {} }, tagsAll: { type: "array", items: { type: "string" } }, tagsNone: { type: "array", items: { type: "string" } }, scheduledAt: { type: "string" } }, required: ["action"] } },
  { name: "broadcast_duplicate", description: "Копия как новый черновик «<имя> (копия)»: исходник не меняется, время отправки и статистика не переносятся. broadcastId — прямая рассылка (POST /api/bots/broadcasts/{id}/duplicate: бот, фильтр, сообщения; по сценарию — HTTP 409); draftId — черновик (POST /api/bots/broadcasts/drafts/{id}/duplicate). Дальше broadcast_drafts update / broadcast_send {draftId}.", inputSchema: { type: "object", properties: { broadcastId: { type: "string" }, draftId: { type: "string" } } } },
  // ---- Сайты: библиотека шаблонов ----
  // ---- Сайт-виджет, база знаний, подписчик ----
  { name: "web_widget_snippet", description: "Код вставки чат-виджета на сайт (GET /api/bots/web/{botId}/snippet) — для бота с platform WEB (create_bot {platform:\"WEB\"}). Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  { name: "kb_list", description: "Базы знаний пользователя (GET /api/bots/kb): id, name, chunkCount. id — knowledgeBaseId для узла AI_REPLY mode:\"agent\". Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "kb_create", description: "Создать пустую базу знаний (POST /api/bots/kb, name ≤ 120 символов). Возвращает id. Наполнение — kb_add_qa / kb_add_site; подключение к сценарию — knowledgeBaseId в узле AI_REPLY mode:\"agent\". Повторный вызов создаёт ВТОРУЮ базу — сначала проверь kb_list.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "kb_delete_doc", description: "Удалить документ из базы знаний вместе с его фрагментами (DELETE /api/bots/kb/{kbId}/docs/{docId}). Необратимо.", inputSchema: { type: "object", properties: { kbId: { type: "string" }, docId: { type: "string" } }, required: ["kbId", "docId"] } },
  { name: "bot_user_get", description: "Карточка подписчика (GET /api/bots/{botId}/users/{chatId}): теги, переменные (поля, ответы, ai_summary), блокировка, счётчики. chatId — из list_bot_users. Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" }, chatId: { type: "string", description: "числовой chatId (строкой — без потери точности)" } }, required: ["botId", "chatId"] } },
  { name: "bot_user_runs", description: "Журнал запусков сценариев подписчика (GET /api/bots/{botId}/users/{chatId}/runs): триггер, статус, шаги с результатом (ветка ИИ-агента, ok/ошибка каждого действия — CRM, уведомление, HTTP). Так проверяют, что сценарий реально сделал нужное. Статус прогона: OK, FAILED (прерван) или PARTIAL — «завершён с ошибками»: дошёл до конца, но хотя бы одно действие упало (у шага ok:false, error «КОД: …»). Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" }, chatId: { type: "string" }, page: { type: "number" }, size: { type: "number" } }, required: ["botId", "chatId"] } },
  { name: "dialog_messages", description: "Переписка с подписчиком, свежие сверху (GET /api/bots/{botId}/users/{chatId}/messages, page/size). Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" }, chatId: { type: "string" }, page: { type: "number" }, size: { type: "number" } }, required: ["botId", "chatId"] } },
  { name: "dialog_reply", description: "ОТПРАВИТЬ сообщение подписчику от имени оператора (POST /api/bots/{botId}/users/{chatId}/messages) — как ответ из раздела «Диалоги». Уходит РЕАЛЬНОМУ человеку: только по явной просьбе пользователя. Бот при этом не останавливается.", inputSchema: { type: "object", properties: { botId: { type: "string" }, chatId: { type: "string" }, text: { type: "string" } }, required: ["botId", "chatId", "text"] } },
  // ---- Паритет платформы: журнал вызовов, оператор, заявки, виджет, подписчики, бот ----
  { name: "integration_calls", description: "Журнал вызовов внешних сервисов из сценариев (GET /api/bots/integrations/calls): время, подключение, действие, ok/ошибка, код, попытки, correlationId (= runId прогона). Фильтры: connectionId (из list_integrations), ok (true — только успешные, false — только упавшие), limit (1–200). Так проверяют, что CRM/таблица/HTTP реально получили данные. Read-only.", inputSchema: { type: "object", properties: { connectionId: { type: "string" }, ok: { type: "boolean" }, limit: { type: "number" } } } },
  { name: "dialog_handoff", description: "Передача диалога оператору (POST /api/bots/{botId}/users/{chatId}/handoff {active}): active:true — бот и ИИ молчат, входящие копятся в «Диалогах», отвечает человек (dialog_reply); active:false — «Вернуть боту». Текущее состояние — поле handoff в bot_user_get.", inputSchema: { type: "object", properties: { botId: { type: "string" }, chatId: { type: "string" }, active: { type: "boolean" } }, required: ["botId", "chatId", "active"] } },
  { name: "site_lead_status", description: "Статус заявки сайта (PATCH /api/bots/pages/{siteId}/leads/{leadId} {status}): NEW → IN_PROGRESS → DONE | REJECTED. leadId — из site_leads. Недопустимый переход → ошибка 409.", inputSchema: { type: "object", properties: { siteId: { type: "string" }, leadId: { type: "string" }, status: { type: "string", enum: ["NEW", "IN_PROGRESS", "DONE", "REJECTED"] } }, required: ["siteId", "leadId", "status"] } },
  { name: "integration_update", description: "Изменить подключение (PUT /api/bots/integrations/{connectionId}): title — новое название; creds — новые ключи доступа (заменяют старые; поля — как в connect_integration для этого провайдера). Передай хотя бы одно.", inputSchema: { type: "object", properties: { connectionId: { type: "string" }, title: { type: "string" }, creds: { type: "object", additionalProperties: { type: "string" } } }, required: ["connectionId"] } },
  { name: "web_widget_settings", description: "Вид чат-виджета сайта (бот platform WEB). Без settings — прочитать (GET /api/bots/web/{botId}/settings: settings, brandingRemovable, snippet). С settings — изменить (PUT): переданные поля накладываются на текущие, остальные сохраняются; сервер проверяет значения (уходят в разметку чужих сайтов).", inputSchema: { type: "object", properties: { botId: { type: "string" }, settings: { type: "object", description: "Поля настроек виджета для изменения (имена — как в ответе чтения)" } }, required: ["botId"] } },
  { name: "bot_users_import", description: "Добавить подписчикам метки и поля (POST /api/bots/{botId}/users/import): rows — [{chatId, username?, tags?: [строки], variables?: {ключ: значение}}], до 10 000 строк. Метки ДОБАВЛЯЮТСЯ; переменная пишется, только если у подписчика её ещё нет (существующие не перезаписываются); новый chatId создаёт подписчика (в пределах лимита тарифа). Снять метку или перезаписать поле через API нельзя.", inputSchema: { type: "object", properties: { botId: { type: "string" }, rows: { type: "array", items: { type: "object", properties: { chatId: { type: "string" }, username: { type: "string" }, tags: { type: "array", items: { type: "string" } }, variables: { type: "object" } }, required: ["chatId"] } } }, required: ["botId", "rows"] } },
  { name: "bot_runs", description: "Журнал прогонов сценариев бота. Без runId — список свежих прогонов (GET /api/bots/{botId}/runs, page/size); с runId — один прогон с шагами (GET /api/bots/runs/{runId}, в т.ч. headless-прогоны вебхук-сценариев и расписаний). По подписчику — bot_user_runs, по сценарию — scenario_runs. Статус прогона: OK, FAILED (прерван) или PARTIAL — «завершён с ошибками»: дошёл до конца, но хотя бы одно действие упало (у шага ok:false, error «КОД: …»). Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" }, runId: { type: "string" }, page: { type: "number" }, size: { type: "number" } } } },
  { name: "scenario_runs", description: "Журнал прогонов одного сценария (GET /api/bots/graphs/{graphId}/runs, page/size), включая headless-прогоны без чата — вебхук-сценарии, заявки сайта, TRIGGER_SCHEDULE. Доступ — как к просмотру графа. Шаги прогона — bot_runs {runId}. Статус прогона: OK, FAILED (прерван) или PARTIAL — «завершён с ошибками»: дошёл до конца, но хотя бы одно действие упало (у шага ok:false, error «КОД: …»). Read-only.", inputSchema: { type: "object", properties: { graphId: { type: "string" }, page: { type: "number" }, size: { type: "number" } }, required: ["graphId"] } },
  { name: "bot_delete", description: "УДАЛИТЬ бота навсегда (DELETE /api/bots/{botId}) вместе с каналами, сценариями, подписчиками, журналами, рассылками и ссылками. Только владелец. Необратимо: вызывай только по явной просьбе пользователя и с confirm:true. Временно выключить — bot_stop.", inputSchema: { type: "object", properties: { botId: { type: "string" }, confirm: { type: "boolean", description: "true — пользователь явно подтвердил удаление" } }, required: ["botId", "confirm"] } },
  // ---- Запись на слоты (бронирование) ----
  { name: "booking_calendar_list", description: "Календари записи пользователя (GET /api/bots/booking/calendars): id, name, zone, slotMinutes, hours, exceptions, botId. id — calendarId для действий сценария booking_slots/booking_book/booking_cancel. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "booking_calendar_get", description: "Календарь записи по id (GET /api/bots/booking/calendars/{calendarId}). Read-only.", inputSchema: { type: "object", properties: { calendarId: { type: "string" } }, required: ["calendarId"] } },
  { name: "booking_calendar_create", description: "Создать календарь записи (POST /api/bots/booking/calendars): сетка слотов по рабочим часам в зоне календаря, в слоте — одна бронь. Без hours свободных слотов не будет.", inputSchema: { type: "object", properties: { name: { type: "string", description: "Название (до 100 символов)" }, zone: { type: "string", description: "Часовой пояс IANA, по умолчанию Europe/Moscow" }, slotMinutes: { type: "number", description: "Длительность слота, 5–1440 мин (по умолчанию 60)" }, hours: { type: "array", description: "Рабочие окна: day 1=пн…7=вс, from/to \"HH:mm\"; несколько окон в день — перерыв", items: { type: "object", properties: { day: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, required: ["day", "from", "to"] } }, exceptions: { type: "array", description: "Исключения на даты: {date:\"ГГГГ-ММ-ДД\"} — выходной, с from/to — только это окно", items: { type: "object", properties: { date: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["date"] } }, botId: { type: "string", description: "Необязательно: только для этого бота (иначе — все боты владельца)" } }, required: ["name"] } },
  { name: "booking_calendar_update", description: "Изменить календарь (PUT /api/bots/booking/calendars/{calendarId}): переданные поля заменяют текущие (hours/exceptions — целиком), остальные сохраняются. Существующие брони не трогаются.", inputSchema: { type: "object", properties: { calendarId: { type: "string" }, name: { type: "string", description: "Название (до 100 символов)" }, zone: { type: "string", description: "Часовой пояс IANA, по умолчанию Europe/Moscow" }, slotMinutes: { type: "number", description: "Длительность слота, 5–1440 мин (по умолчанию 60)" }, hours: { type: "array", description: "Рабочие окна: day 1=пн…7=вс, from/to \"HH:mm\"; несколько окон в день — перерыв", items: { type: "object", properties: { day: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, required: ["day", "from", "to"] } }, exceptions: { type: "array", description: "Исключения на даты: {date:\"ГГГГ-ММ-ДД\"} — выходной, с from/to — только это окно", items: { type: "object", properties: { date: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["date"] } }, botId: { type: "string", description: "Необязательно: только для этого бота (иначе — все боты владельца)" } }, required: ["calendarId"] } },
  { name: "booking_calendar_delete", description: "УДАЛИТЬ календарь записи (DELETE /api/bots/booking/calendars/{calendarId}). Сценарии с его calendarId перестанут записывать. Только по явной просьбе, с confirm:true.", inputSchema: { type: "object", properties: { calendarId: { type: "string" }, confirm: { type: "boolean" } }, required: ["calendarId", "confirm"] } },
  { name: "booking_slots", description: "Свободные слоты календаря (GET /api/bots/booking/calendars/{calendarId}/slots): [{at — ISO-8601 с зоной, label — «пн 12.10 15:00»}]. from/to — даты ГГГГ-ММ-ДД в зоне календаря (по умолчанию сегодня … +6 дней), limit — 1–500 (по умолчанию 50). Read-only.", inputSchema: { type: "object", properties: { calendarId: { type: "string" }, from: { type: "string" }, to: { type: "string" }, limit: { type: "number" } }, required: ["calendarId"] } },
  { name: "booking_list", description: "Брони календаря от даты from (ГГГГ-ММ-ДД, по умолчанию сегодня), включая отменённые, до 500 (GET /api/bots/booking/calendars/{calendarId}/bookings). Read-only.", inputSchema: { type: "object", properties: { calendarId: { type: "string" }, from: { type: "string" } }, required: ["calendarId"] } },
  { name: "booking_create", description: "Записать вручную на слот (POST /api/bots/booking/calendars/{calendarId}/bookings {slotAt, name, phone}): slotAt — at из booking_slots (ISO-8601 с зоной). Слот занят → понятная ошибка «занят», слота нет в сетке → ошибка 400.", inputSchema: { type: "object", properties: { calendarId: { type: "string" }, slotAt: { type: "string" }, name: { type: "string" }, phone: { type: "string" } }, required: ["calendarId", "slotAt"] } },
  { name: "booking_cancel", description: "Отменить бронь и освободить слот (POST /api/bots/booking/calendars/{calendarId}/bookings/{bookingId}/cancel). Повторная отмена — без ошибки. bookingId — из booking_list.", inputSchema: { type: "object", properties: { calendarId: { type: "string" }, bookingId: { type: "string" } }, required: ["calendarId", "bookingId"] } },
  { name: "site_templates", description: "Библиотека шаблонов блоков сайта (GET /api/bots/pages/templates): {categories: [{id, title, description?}], templates: [{id, category, title, description?, blocks: сколько блоков вставится}]}. Вставка — site_edit add_template {container, templateId, after?} (results.id — первый блок, results.ids — все); дальше блоки правятся как обычные. category — фильтр по id категории.", inputSchema: { type: "object", properties: { category: { type: "string" } } } },
  // ---- Паритет платформы, часть 2: бот, база, агент, заявки, подписчики, каналы, ссылки, аналитика ----
  { name: "bot_rename", description: "Переименовать бота (PATCH /api/bots/{botId} {name}): отображаемое имя в кабинете, до 250 символов. Пустое name сбрасывает имя на @username. Имя в самом Telegram/MAX не меняется.", inputSchema: { type: "object", properties: { botId: { type: "string" }, name: { type: "string" } }, required: ["botId", "name"] } },
  { name: "bot_change_token", description: "Сменить токен бота (POST /api/bots/{botId}/token {token}): сервер проверяет токен и перезапускает приём сообщений; сценарии, подписчики и ссылки остаются. Нужен, если токен перевыпущен в @BotFather (/revoke) или MAX. Неверный или чужой токен → ошибка с причиной. Владелец или ADMIN.", inputSchema: { type: "object", properties: { botId: { type: "string" }, token: { type: "string", description: "Новый токен бота" } }, required: ["botId", "token"] } },
  { name: "bot_channel_list", description: "Дополнительные Telegram-боты (мультиканальность) этого бота (GET /api/bots/{botId}/channels): id, username, name, active. Это НЕ каналы/группы для постинга — те в list_channels. Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  { name: "bot_channel_add", description: "Добавить к боту ещё одного Telegram-бота как канал (POST /api/bots/{botId}/channels {token, name?}): он отвечает теми же сценариями. Токен проверяется в Telegram; токен, уже подключённый где-то ещё, не принимается.", inputSchema: { type: "object", properties: { botId: { type: "string" }, token: { type: "string" }, name: { type: "string" } }, required: ["botId", "token"] } },
  { name: "bot_channel_delete", description: "Отключить дополнительного Telegram-бота от бота (DELETE /api/bots/{botId}/channels/{channelId}). channelId — из bot_channel_list. Только по явной просьбе, с confirm:true.", inputSchema: { type: "object", properties: { botId: { type: "string" }, channelId: { type: "string" }, confirm: { type: "boolean" } }, required: ["botId", "channelId", "confirm"] } },
  { name: "link_create", description: "Создать стартовую ссылку бота (POST /api/bots/{botId}/links {name, targetNodeId?}): code для t.me/<бот>?start=<code>, счётчик стартов. targetNodeId — узел сценария, на который ведёт диплинк; для одного узла повторный вызов вернёт существующую ссылку.", inputSchema: { type: "object", properties: { botId: { type: "string" }, name: { type: "string" }, targetNodeId: { type: "string" } }, required: ["botId"] } },
  { name: "link_delete", description: "Удалить стартовую ссылку (DELETE /api/bots/links/{linkId}); id — из list_links. Разосланные ссылки перестанут считаться. Только по явной просьбе, с confirm:true.", inputSchema: { type: "object", properties: { linkId: { type: "string" }, confirm: { type: "boolean" } }, required: ["linkId", "confirm"] } },
  { name: "utm_sources", description: "UTM-источники подписчиков бота (GET /api/bots/{botId}/utm-sources): по каким меткам utm_* люди входили в сценарии и сколько их. Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"] } },
  { name: "ab_results", description: "Результаты A/B-теста (GET /api/bots/graphs/{graphId}/ab-results?branchNodeId&period): статистика по вариантам узла-развилки. branchNodeId — id узла A/B в графе; period — «24h», «7d», «30d» (по умолчанию 7d). Read-only.", inputSchema: { type: "object", properties: { graphId: { type: "string" }, branchNodeId: { type: "string" }, period: { type: "string" } }, required: ["graphId", "branchNodeId"] } },
  { name: "kb_delete", description: "УДАЛИТЬ базу знаний целиком со всеми документами (DELETE /api/bots/kb/{kbId}). База ИИ-агента так не удаляется (ошибка KB_OWNED_BY_AGENT) — удаляй агента. Необратимо: только по явной просьбе, с confirm:true.", inputSchema: { type: "object", properties: { kbId: { type: "string" }, confirm: { type: "boolean" } }, required: ["kbId", "confirm"] } },
  { name: "agent_unpublish", description: "Снять ИИ-агента с публикации (POST /api/bots/agents/{agentId}/unpublish): агент возвращается в черновик и перестаёт отвечать. В ответе — agent и сценарии, которые сейчас на нём работают (их стоит проверить).", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "agent_delete", description: "УДАЛИТЬ ИИ-агента (DELETE /api/bots/agents/{agentId}). Пока агент или его база подключены к сценариям — ошибка AGENT_IN_USE со списком сценариев: сначала отключи его там. Необратимо: только по явной просьбе, с confirm:true.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, confirm: { type: "boolean" } }, required: ["agentId", "confirm"] } },
  { name: "site_leads_mark_read", description: "Отметить все заявки сайта прочитанными (POST /api/bots/pages/{siteId}/leads/read): обнуляет счётчик unread из site_leads. Статусы обработки не меняются (это site_lead_status).", inputSchema: { type: "object", properties: { siteId: { type: "string" } }, required: ["siteId"] } },
  { name: "site_lead_delete", description: "УДАЛИТЬ заявку сайта (DELETE /api/bots/pages/{siteId}/leads/{leadId}); leadId — из site_leads. Необратимо: только по явной просьбе, с confirm:true.", inputSchema: { type: "object", properties: { siteId: { type: "string" }, leadId: { type: "string" }, confirm: { type: "boolean" } }, required: ["siteId", "leadId", "confirm"] } },
  { name: "site_leads_export", description: "Все заявки сайта в CSV (GET /api/bots/pages/{siteId}/leads.csv). savePath — сохранить в локальный файл и вернуть путь (для больших выгрузок); без него CSV возвращается текстом. Read-only.", inputSchema: { type: "object", properties: { siteId: { type: "string" }, savePath: { type: "string" } }, required: ["siteId"] } },
  { name: "bot_users_export", description: "Выгрузка всех подписчиков бота (GET /api/bots/{botId}/users/export?format=csv|json): chatId, имя, метки, переменные. savePath — сохранить в локальный файл и вернуть путь; без него данные возвращаются текстом. Read-only.", inputSchema: { type: "object", properties: { botId: { type: "string" }, format: { type: "string", enum: ["csv", "json"] }, savePath: { type: "string" } }, required: ["botId"] } },
  { name: "bot_user_reset", description: "Сбросить сессию подписчика (DELETE /api/bots/{botId}/sessions/{chatId}): стираются его позиция в сценарии, метки и переменные, и он пропадает из list_bot_users; при следующем сообщении начнёт как новый. Для повторного прохождения воронки при тесте. Необратимо: только по явной просьбе, с confirm:true.", inputSchema: { type: "object", properties: { botId: { type: "string" }, chatId: { type: "string" }, confirm: { type: "boolean" } }, required: ["botId", "chatId", "confirm"] } },
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
    case "list_integrations": return okResult(withoutSecrets(await api("/api/bots/integrations")));
    case "integration_catalog": return okResult(withoutSecrets(await api("/api/integrations/catalog")));
    case "integration_status":
    case "integration_test": {
      const id = String(a.connectionId || "").trim();
      if (!id) throw new Error("Передай connectionId — id подключения из list_integrations.");
      const live = params.name === "integration_test";
      const p_ = `/api/integrations/${encodeURIComponent(id)}/${live ? "test" : "status"}`;
      return okResult(withoutSecrets(await api(p_, live ? { method: "POST" } : undefined)));
    }
    case "channel_post": {
      if (!a.botId) throw new Error("Передай botId (list_bots).");
      const chatId = Number(a.chatId);
      if (!Number.isSafeInteger(chatId)) throw new Error("chatId — числовой id канала из list_channels (например -1001234567890).");
      const text = a.text == null ? "" : String(a.text);
      if (!text.trim() && !a.mediaUrl) throw new Error("Пустой пост: передай text и/или mediaUrl (файл из upload_file).");
      const body = { text };
      if (a.mediaUrl) body.mediaUrl = String(a.mediaUrl);
      return okResult(await api(`/api/bots/${encodeURIComponent(a.botId)}/linked-chats/${chatId}/post`, { method: "POST", body }));
    }
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
      assertGraphIds(src);
      const payload = { nodes: src.nodes, edges: src.edges, canvasMeta: src.canvasMeta ?? {} };
      if (a.name ?? src.name) payload.name = a.name ?? src.name;
      return okResult(await api(`/api/bots/graphs/${a.graphId}`, { method: "PUT", body: payload }));
    }
    case "edit_graph_live": {
      const src = resolveGraphInput(a);
      if (!Array.isArray(src.nodes) || !Array.isArray(src.edges)) throw new Error("Нужны nodes[] и edges[] (через graphFile, graph или nodes/edges).");
      assertGraphIds(src);
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
        : `сохранено в черновик ${a.graphId}: до бота НЕ доходит — живые правки делай по id опубликованного графа (isActive:true в list_graphs — для бот-сценария; после publish_graph черновика — publishedGraphId)`);
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
      assertGraphIds(src);
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
    case "site_list": return okResult(await api("/api/bots/pages"));
    case "site_create": {
      if (!a.title) throw new Error("Передай title сайта.");
      if (a.template != null && !SITE_INITS.includes(a.template)) throw new Error(`template — одно из: ${SITE_INITS.join(", ")}.`);
      const page = await api("/api/bots/pages", { method: "POST", body: { title: a.title, slug: a.slug || undefined, mode: "BLOCKS" } });
      if (!a.template) return okResult(page);
      // черновик сразу, как редактор при «Мини-лендинг»: бэкенд не берёт пустой ops[] — безвредная set_settings{}
      const doc = await api(`/api/bots/pages/${page.id}/document/ops`, { method: "POST", body: { ops: SITE_NOOP_OPS, init: a.template } });
      return okResult({ ...page, template: a.template, revision: doc?.revision });
    }
    case "site_get": {
      const doc = await api(`/api/bots/pages/${a.siteId}/document`);
      if (a.saveToFile) {
        const abs = path.resolve(String(a.saveToFile).replace(/^~(?=$|[/\\])/, os.homedir()));
        fs.writeFileSync(abs, JSON.stringify(doc, null, 2));
        return okResult({ revision: doc?.revision, publishedRevision: doc?.publishedRevision, savedTo: abs });
      }
      return okResult(doc);
    }
    case "site_schema": return okResult(await api("/api/bots/pages/schema"));
    case "site_edit": {
      const hasOps = Array.isArray(a.ops) && a.ops.length > 0;
      if (!hasOps && !a.init) throw new Error("Передай ops — массив операций (см. site_schema) — или init, чтобы только создать черновик.");
      if (a.init != null && !SITE_INITS.includes(a.init)) throw new Error(`init — одно из: ${SITE_INITS.join(", ")}.`);
      const ops = hasOps ? a.ops : SITE_NOOP_OPS; // бэкенд отвечает 422 на пустой ops[]
      return okResult(await api(`/api/bots/pages/${a.siteId}/document/ops`, { method: "POST", body: { ops, revision: a.revision, init: a.init } }));
    }
    case "site_publish": {
      const r = await api(`/api/bots/pages/${a.siteId}/publish`, { method: "POST" });
      return okResult({ publishedRevision: r?.publishedRevision, url: r?.page?.url });
    }
    case "site_upload_asset": return okResult(await uploadSiteAsset(a.siteId, { filePath: a.path, url: a.url }));
    case "site_leads": {
      const qs = [];
      if (a.page != null) qs.push(`page=${encodeURIComponent(a.page)}`);
      if (a.size != null) qs.push(`size=${encodeURIComponent(a.size)}`);
      if (a.status) qs.push(`status=${enumArg(a.status, "status", LEAD_STATUSES)}`);
      return okResult(await api(`/api/bots/pages/${a.siteId}/leads${qs.length ? `?${qs.join("&")}` : ""}`));
    }
    case "site_rollback": {
      if (typeof a.revision !== "number") throw new Error("Передай revision — номер публикации (site_get → versions[]).");
      const r = await api(`/api/bots/pages/${a.siteId}/publish/rollback`, { method: "POST", body: { revision: a.revision } });
      return okResult({ publishedRevision: r?.publishedRevision, url: r?.page?.url });
    }
    case "site_domains": {
      const base = `/api/bots/pages/${a.siteId}/domains`;
      if (a.action === "list") return okResult(await api(base));
      if (a.action === "add") {
        if (!a.host) throw new Error("Передай host — домен, например example.ru.");
        return okResult(await api(base, { method: "POST", body: { host: a.host, withWww: !!a.withWww } }));
      }
      if (!a.domainId) throw new Error("Передай domainId (site_domains action=list).");
      if (a.action === "check") return okResult(await api(`${base}/${a.domainId}/check`, { method: "POST" }));
      if (a.action === "remove") return okResult(await api(`${base}/${a.domainId}`, { method: "DELETE" }));
      throw new Error("action: list | add | check | remove.");
    }
    case "site_lead_settings": {
      const p_ = `/api/bots/pages/${a.siteId}/lead-settings`;
      if (a.settings == null) return okResult(withoutSecrets(await api(p_)));
      return okResult(withoutSecrets(await api(p_, { method: "PUT", body: a.settings })));
    }
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
    case "agent_list": return okResult(await api("/api/bots/agents"));
    case "agent_get": return okResult(await api(`/api/bots/agents/${a.agentId}`));
    case "agent_create": return okResult(await api("/api/bots/agents", { method: "POST", body: { name: a.name, description: a.description } }));
    case "agent_update": {
      if (!a.patch || typeof a.patch !== "object") throw new Error("Передай patch — объект с полями агента для правки.");
      return okResult(await api(`/api/bots/agents/${a.agentId}`, { method: "PATCH", body: a.patch }));
    }
    case "agent_publish": return okResult(await api(`/api/bots/agents/${a.agentId}/publish`, { method: "POST" }));
    case "agent_health": return okResult(await api(`/api/bots/agents/${a.agentId}/health`));
    case "agent_test_chat": {
      if (!a.question || !String(a.question).trim()) throw new Error("Передай question.");
      return okResult(await api(`/api/bots/agents/${a.agentId}/test-chat`, { method: "POST", body: { question: a.question, history: a.history } }));
    }
    // ---- Сайт-виджет, база знаний, подписчик ----
    case "web_widget_snippet": return okResult(await api(`/api/bots/web/${a.botId}/snippet`));
    case "kb_list": return okResult(await api("/api/bots/kb"));
    case "kb_create": {
      if (!a.name || !String(a.name).trim()) throw new Error("Передай name — название базы знаний.");
      return okResult(await api("/api/bots/kb", { method: "POST", body: { name: String(a.name).trim() } }));
    }
    case "kb_docs": return okResult(await api(`/api/bots/kb/${a.kbId}/docs`));
    case "kb_add_qa": {
      if (!Array.isArray(a.pairs) || a.pairs.length === 0) throw new Error("Передай pairs — непустой массив [{question, answer}].");
      return okResult(await api(`/api/bots/kb/${a.kbId}/docs/qa`, { method: "POST", body: a.pairs }));
    }
    case "kb_add_text": {
      if (!a.title || !a.text) throw new Error("Передай title и text.");
      return okResult(await api(`/api/bots/kb/${a.kbId}/docs/text`, { method: "POST", body: { title: a.title, text: a.text } }));
    }
    case "kb_add_site": {
      if (!a.url) throw new Error("Передай url.");
      return okResult(await api(`/api/bots/kb/${a.kbId}/docs/site`, { method: "POST", body: { url: a.url, schedule: a.schedule } }));
    }
    case "kb_reindex": return okResult(await api(`/api/bots/kb/${a.kbId}/docs/${a.docId}/reindex`, { method: "POST", body: { headerRow: a.headerRow } }));
    case "agent_unanswered": {
      const qs = a.days != null ? `?days=${encodeURIComponent(a.days)}` : "";
      return okResult(await api(`/api/bots/agents/${a.agentId}/unanswered${qs}`));
    }
    case "kb_delete_doc": {
      await api(`/api/bots/kb/${a.kbId}/docs/${a.docId}`, { method: "DELETE" });
      return okResult(`🗑️ Документ ${a.docId} удалён из базы ${a.kbId}.`);
    }
    case "bot_user_get": return okResult(await api(`/api/bots/${a.botId}/users/${chatIdArg(a.chatId)}`));
    case "bot_user_runs": return okResult(await api(`/api/bots/${a.botId}/users/${chatIdArg(a.chatId)}/runs${pageQs(a)}`));
    case "dialog_messages": return okResult(await api(`/api/bots/${a.botId}/users/${chatIdArg(a.chatId)}/messages${pageQs(a)}`));
    case "dialog_reply": {
      const text = String(a.text ?? "").trim();
      if (!text) throw new Error("Передай text — текст ответа.");
      return okResult(await api(`/api/bots/${a.botId}/users/${chatIdArg(a.chatId)}/messages`, { method: "POST", body: { text } }));
    }
    // ---- Запись на слоты ----
    case "booking_calendar_list": return okResult(await api("/api/bots/booking/calendars"));
    case "booking_calendar_get": return okResult(await api(`/api/bots/booking/calendars/${uuidArg(a.calendarId, "calendarId")}`));
    case "booking_calendar_create": {
      const body = calendarBody(a);
      if (!body.name) throw new Error("Передай name — название календаря.");
      return okResult(await api("/api/bots/booking/calendars", { method: "POST", body }));
    }
    case "booking_calendar_update": {
      const path_ = `/api/bots/booking/calendars/${uuidArg(a.calendarId, "calendarId")}`;
      const { calendarId, ...fields } = a;
      if (!Object.keys(fields).length) throw new Error("Передай хотя бы одно поле: name, zone, slotMinutes, hours, exceptions, botId.");
      const body = calendarBody(fields, await api(path_)); // PUT заменяет календарь целиком — накладываем на текущий
      return okResult(await api(path_, { method: "PUT", body }));
    }
    case "booking_calendar_delete": {
      const id = uuidArg(a.calendarId, "calendarId");
      if (a.confirm !== true) throw new Error("Удаление календаря необратимо. Спроси пользователя и повтори с confirm:true.");
      await api(`/api/bots/booking/calendars/${id}`, { method: "DELETE" });
      return okResult(`🗑️ Календарь ${id} удалён.`);
    }
    case "booking_slots": {
      const q = {};
      if (a.from) q.from = dateArg(a.from, "from");
      if (a.to) q.to = dateArg(a.to, "to");
      if (a.limit != null) {
        const n = Number(a.limit);
        if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error("limit — целое от 1 до 500.");
        q.limit = n;
      }
      return okResult(await api(`/api/bots/booking/calendars/${uuidArg(a.calendarId, "calendarId")}/slots${qs(q)}`));
    }
    case "booking_list": {
      const q = a.from ? { from: dateArg(a.from, "from") } : {};
      return okResult(await api(`/api/bots/booking/calendars/${uuidArg(a.calendarId, "calendarId")}/bookings${qs(q)}`));
    }
    case "booking_create": {
      const id = uuidArg(a.calendarId, "calendarId");
      const slotAt = String(a.slotAt ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(slotAt) || Number.isNaN(Date.parse(slotAt))) {
        throw new Error(`slotAt — ISO-8601 с зоной (at из booking_slots), например 2026-10-12T15:00:00+03:00; получено: ${slotAt || "пусто"}.`);
      }
      try {
        return okResult(await api(`/api/bots/booking/calendars/${id}/bookings`, { method: "POST", body: { slotAt, name: a.name, phone: a.phone } }));
      } catch (e) {
        if (e.status === 409) throw new Error(`Слот ${slotAt} уже занят — выбери другой из booking_slots.`);
        throw e;
      }
    }
    case "booking_cancel": {
      const id = uuidArg(a.calendarId, "calendarId");
      const bookingId = uuidArg(a.bookingId, "bookingId");
      await api(`/api/bots/booking/calendars/${id}/bookings/${bookingId}/cancel`, { method: "POST" });
      return okResult(`✅ Бронь ${bookingId} отменена, слот свободен.`);
    }
    // ---- Паритет платформы ----
    case "integration_calls": {
      const q = {};
      if (a.connectionId != null && a.connectionId !== "") q.connectionId = idArg(a.connectionId, "connectionId");
      if (a.ok != null) {
        if (typeof a.ok !== "boolean") throw new Error("ok — true или false.");
        q.ok = a.ok;
      }
      if (a.limit != null) {
        const n = Number(a.limit);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("limit — целое от 1 до 200.");
        q.limit = n;
      }
      return okResult(await api(`/api/bots/integrations/calls${qs(q)}`));
    }
    case "dialog_handoff": {
      if (typeof a.active !== "boolean") throw new Error("active — true (передать оператору) или false (вернуть боту).");
      const res = await api(`/api/bots/${uuidArg(a.botId, "botId")}/users/${chatIdArg(a.chatId)}/handoff`, { method: "POST", body: { active: a.active } });
      return okResult(res ?? (a.active ? "✅ Диалог передан оператору: бот молчит." : "✅ Диалог возвращён боту."));
    }
    case "site_lead_status": {
      const status = enumArg(a.status, "status", LEAD_STATUSES);
      try {
        return okResult(await api(`/api/bots/pages/${uuidArg(a.siteId, "siteId")}/leads/${uuidArg(a.leadId, "leadId")}`, { method: "PATCH", body: { status } }));
      } catch (e) {
        if (e.status === 409) throw new Error(`Недопустимый переход статуса заявки в ${status}: NEW → IN_PROGRESS → DONE | REJECTED.`);
        throw e;
      }
    }
    case "integration_update": {
      const body = {};
      if (a.title != null) {
        const t = String(a.title).trim();
        if (!t) throw new Error("title не может быть пустым.");
        body.title = t;
      }
      if (a.creds != null) {
        if (typeof a.creds !== "object" || Array.isArray(a.creds) || !Object.keys(a.creds).length) throw new Error("creds — непустой объект {поле: значение}.");
        body.creds = Object.fromEntries(Object.entries(a.creds).map(([k, v]) => [k, String(v)]));
      }
      if (!Object.keys(body).length) throw new Error("Передай title и/или creds.");
      return okResult(await api(`/api/bots/integrations/${idArg(a.connectionId, "connectionId")}`, { method: "PUT", body }));
    }
    case "web_widget_settings": {
      const path_ = `/api/bots/web/${uuidArg(a.botId, "botId")}/settings`;
      if (a.settings == null) return okResult(await api(path_));
      if (typeof a.settings !== "object" || Array.isArray(a.settings)) throw new Error("settings — объект с полями настроек.");
      const cur = await api(path_);
      const merged = { ...(cur?.settings ?? {}), ...a.settings };
      return okResult(await api(path_, { method: "PUT", body: merged }));
    }
    case "bot_users_import": {
      if (!Array.isArray(a.rows) || !a.rows.length) throw new Error("Передай rows — непустой массив [{chatId, tags?, variables?}].");
      if (a.rows.length > 10000) throw new Error("rows — не больше 10 000 строк за вызов.");
      // chatId бывает > 2^53: в JSON кладём числом прямо из строки, без Number().
      const rows = a.rows.map((r, i) => {
        const cid = String(r?.chatId ?? "").trim();
        if (!/^[1-9]\d{0,18}$/.test(cid)) throw new Error(`rows[${i}].chatId — положительное число, получено: ${cid || "пусто"}.`);
        if (r.tags != null && !Array.isArray(r.tags)) throw new Error(`rows[${i}].tags — массив строк.`);
        if (r.variables != null && (typeof r.variables !== "object" || Array.isArray(r.variables))) throw new Error(`rows[${i}].variables — объект.`);
        return { chatId: `@@CID${cid}@@`, username: r.username, tags: r.tags, variables: r.variables };
      });
      const raw = JSON.stringify({ rows }).replace(/"@@CID(\d+)@@"/g, "$1");
      return okResult(await api(`/api/bots/${uuidArg(a.botId, "botId")}/users/import`, { method: "POST", rawBody: raw }));
    }
    case "bot_runs": {
      if (a.runId) return okResult(await api(`/api/bots/runs/${idArg(a.runId, "runId")}`));
      return okResult(await api(`/api/bots/${uuidArg(a.botId, "botId")}/runs${pageQs(a)}`));
    }
    case "scenario_runs": return okResult(await api(`/api/bots/graphs/${uuidArg(a.graphId, "graphId")}/runs${pageQs(a)}`));
    case "bot_delete": {
      const botId = uuidArg(a.botId, "botId");
      if (a.confirm !== true) throw new Error("Удаление бота необратимо. Спроси пользователя и повтори с confirm:true.");
      await api(`/api/bots/${botId}`, { method: "DELETE" });
      return okResult(`🗑️ Бот ${botId} удалён вместе со сценариями и подписчиками.`);
    }
    // ---- Паритет платформы, часть 2 ----
    case "bot_rename": {
      if (typeof a.name !== "string") throw new Error("name — строка (пустая сбрасывает имя на @username).");
      return okResult(await api(`/api/bots/${uuidArg(a.botId, "botId")}`, { method: "PATCH", body: { name: a.name } }));
    }
    case "bot_change_token": {
      const botId = uuidArg(a.botId, "botId");
      const token = String(a.token ?? "").trim();
      if (!token) throw new Error("Передай token — новый токен бота.");
      try {
        return okResult(await api(`/api/bots/${botId}/token`, { method: "POST", body: { token } }));
      } catch (e) {
        // 400 — строка-причина (неверный токен, уже подключён к другому боту); сам токен в ошибку не кладём.
        if (e.status === 400) throw new Error(`Токен не принят: ${typeof e.data === "string" && e.data ? e.data : "проверь токен"}.`);
        throw e;
      }
    }
    case "bot_channel_list": return okResult(await api(`/api/bots/${uuidArg(a.botId, "botId")}/channels`));
    case "bot_channel_add": {
      const botId = uuidArg(a.botId, "botId");
      const token = String(a.token ?? "").trim();
      if (!token) throw new Error("Передай token — токен дополнительного Telegram-бота.");
      try {
        return okResult(await api(`/api/bots/${botId}/channels`, { method: "POST", body: { token, name: a.name || undefined } }));
      } catch (e) {
        if (e.status === 400) throw new Error(`Канал не добавлен: ${typeof e.data === "string" && e.data ? e.data : "токен не принят"}.`);
        throw e;
      }
    }
    case "bot_channel_delete": {
      const botId = uuidArg(a.botId, "botId");
      const channelId = uuidArg(a.channelId, "channelId");
      if (a.confirm !== true) throw new Error("Отключение канала необратимо. Спроси пользователя и повтори с confirm:true.");
      await api(`/api/bots/${botId}/channels/${channelId}`, { method: "DELETE" });
      return okResult(`🗑️ Канал ${channelId} отключён от бота ${botId}.`);
    }
    case "link_create": {
      const body = { name: a.name || undefined };
      if (a.targetNodeId) body.targetNodeId = uuidArg(a.targetNodeId, "targetNodeId");
      return okResult(await api(`/api/bots/${uuidArg(a.botId, "botId")}/links`, { method: "POST", body }));
    }
    case "link_delete": {
      const linkId = uuidArg(a.linkId, "linkId");
      if (a.confirm !== true) throw new Error("Удаление ссылки необратимо. Спроси пользователя и повтори с confirm:true.");
      await api(`/api/bots/links/${linkId}`, { method: "DELETE" });
      return okResult(`🗑️ Ссылка ${linkId} удалена.`);
    }
    case "utm_sources": return okResult(await api(`/api/bots/${uuidArg(a.botId, "botId")}/utm-sources`));
    case "ab_results": {
      const q = { branchNodeId: uuidArg(a.branchNodeId, "branchNodeId") };
      if (a.period != null && a.period !== "") {
        const p = String(a.period).trim();
        if (!/^\d{1,4}[hd]$/.test(p)) throw new Error(`period — число с h или d (24h, 7d, 30d), получено: ${p}.`);
        q.period = p;
      }
      return okResult(await api(`/api/bots/graphs/${uuidArg(a.graphId, "graphId")}/ab-results${qs(q)}`));
    }
    case "kb_delete": {
      const kbId = idArg(a.kbId, "kbId");
      if (a.confirm !== true) throw new Error("Удаление базы знаний необратимо. Спроси пользователя и повтори с confirm:true.");
      try {
        await api(`/api/bots/kb/${kbId}`, { method: "DELETE" });
      } catch (e) {
        if (e.status === 409) throw new Error("Это база ИИ-агента (KB_OWNED_BY_AGENT): отдельно не удаляется — удали агента (agent_delete).");
        throw e;
      }
      return okResult(`🗑️ База знаний ${kbId} удалена со всеми документами.`);
    }
    case "agent_unpublish": return okResult(await api(`/api/bots/agents/${idArg(a.agentId, "agentId")}/unpublish`, { method: "POST" }));
    case "agent_delete": {
      const agentId = idArg(a.agentId, "agentId");
      if (a.confirm !== true) throw new Error("Удаление агента необратимо. Спроси пользователя и повтори с confirm:true.");
      try {
        await api(`/api/bots/agents/${agentId}`, { method: "DELETE" });
      } catch (e) {
        if (e.status === 409) {
          const refs = Array.isArray(e.data?.scenarios) ? e.data.scenarios.map((s) => s?.graphName || s?.graphId).filter(Boolean) : [];
          throw new Error(`Агент подключён к сценариям (AGENT_IN_USE)${refs.length ? `: ${refs.join(", ")}` : ""}. Сначала отключи его в них.`);
        }
        throw e;
      }
      return okResult(`🗑️ Агент ${agentId} удалён.`);
    }
    case "site_leads_mark_read": {
      const siteId = uuidArg(a.siteId, "siteId");
      await api(`/api/bots/pages/${siteId}/leads/read`, { method: "POST" });
      return okResult(`✅ Все заявки сайта ${siteId} отмечены прочитанными.`);
    }
    case "site_lead_delete": {
      const siteId = uuidArg(a.siteId, "siteId");
      const leadId = uuidArg(a.leadId, "leadId");
      if (a.confirm !== true) throw new Error("Удаление заявки необратимо. Спроси пользователя и повтори с confirm:true.");
      await api(`/api/bots/pages/${siteId}/leads/${leadId}`, { method: "DELETE" });
      return okResult(`🗑️ Заявка ${leadId} удалена.`);
    }
    case "site_leads_export": return exportResult(await api(`/api/bots/pages/${uuidArg(a.siteId, "siteId")}/leads.csv`), a.savePath);
    case "bot_users_export": {
      const format = String(a.format || "csv").trim().toLowerCase();
      if (format !== "csv" && format !== "json") throw new Error(`format: csv | json, получено: ${format}.`);
      return exportResult(await api(`/api/bots/${uuidArg(a.botId, "botId")}/users/export?format=${format}`), a.savePath);
    }
    case "bot_user_reset": {
      const botId = uuidArg(a.botId, "botId");
      const chatId = chatIdArg(a.chatId);
      if (a.confirm !== true) throw new Error("Сброс сессии стирает метки и переменные подписчика. Спроси пользователя и повтори с confirm:true.");
      await api(`/api/bots/${botId}/sessions/${chatId}`, { method: "DELETE" });
      return okResult(`♻️ Сессия подписчика ${chatId} сброшена: при следующем сообщении он начнёт как новый.`);
    }
    // ---- Боты ----
    case "create_bot": {
      const platform = String(a.platform || "").trim().toUpperCase();
      if (platform === "INSTAGRAM") return instagramAnswer();
      if (platform === "WEB") return okResult(await api("/api/bots/web", { method: "POST", body: { name: a.name || undefined } }));
      if (platform !== "TELEGRAM" && platform !== "MAX") throw new Error("platform: TELEGRAM | MAX | WEB (Instagram подключается только в кабинете).");
      const token = String(a.token || "").trim();
      if (!token) {
        return okResult(platform === "MAX"
          ? "Нужен токен MAX-бота: создай бота у MasterBot в MAX и пришли токен — я подключу его (create_bot {platform:\"MAX\", token})."
          : "Нужен токен Telegram-бота: открой https://t.me/BotFather → /newbot (или /token для существующего) и пришли токен вида 123456789:AA… — я подключу его (create_bot {platform:\"TELEGRAM\", token}).");
      }
      let bot;
      try {
        bot = await api("/api/bots", { method: "POST", body: { token, platform } });
      } catch (e) {
        // 400 приходит строкой-причиной (неверный токен, бот уже подключён) — её и показываем.
        if (e.status === 400) throw new Error(`Бот не подключён: ${typeof e.data === "string" && e.data ? e.data : "токен не принят"}. Проверь токен (${platform === "MAX" ? "MasterBot в MAX" : "@BotFather → /token"}).`);
        throw e;
      }
      if (a.name && bot?.id) {
        try { bot = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { name: a.name } }); }
        catch (e) { return okResult({ ...bot, warning: `Бот подключён, но имя не задано: ${(e.message || "").split("\n")[0]}` }); }
      }
      return okResult(bot);
    }
    case "bot_stop": return okResult(await api(`/api/bots/${a.botId}/stop`, { method: "POST" }));
    case "bot_resume": return okResult(await api(`/api/bots/${a.botId}/resume`, { method: "POST" }));
    // ---- Подключения ----
    case "connect_integration": {
      const provider = normProvider(a.provider);
      if (provider === "INSTAGRAM") return instagramAnswer();
      if (provider === "TELEGRAM" || provider === "MAX") {
        return okResult(`${provider === "MAX" ? "MAX" : "Telegram"} подключается как бот, а не интеграция: вызови create_bot {platform:"${provider}", token}.`);
      }
      if (provider === "GOOGLE_SHEETS") {
        const r = await api(`/api/bots/google/auth-url${qs({ returnPath: "/bots/integrations" })}`, { method: "POST" });
        let connected = [];
        try { const ids = await api("/api/bots/google/identities"); connected = Array.isArray(ids) ? ids : []; } catch { /* список не обязателен */ }
        if (!r?.authUrl) throw new Error(`Сервер не вернул ссылку авторизации Google. Подключи в кабинете: ${INTEGRATIONS_PAGE}`);
        return linkResult("Google Таблицы: вход через Google (OAuth)", r.authUrl,
          "Открой ссылку, выбери Google-аккаунт и разреши доступ к таблицам — затем таблица выбирается в узле сценария «Google Таблицы». Ссылка одноразовая и живёт недолго: если истекла, вызови connect_integration ещё раз.",
          { connectedGoogleAccounts: connected });
      }
      const spec = PROVIDER_FIELDS[provider];
      if (spec) {
        // Легаси-провайдер (одна из исходных 5) — шлём enum `provider` как раньше, без каталога.
        const creds = a.creds && typeof a.creds === "object" ? Object.fromEntries(
          Object.entries(a.creds).filter(([, v]) => v != null && String(v).trim() !== "").map(([k, v]) => [k, String(v).trim()])) : {};
        const missing = Object.keys(spec.fields).filter((k) => !creds[k]);
        if (missing.length && (!a.connectionId || Object.keys(creds).length)) {
          return okResult({
            connected: false,
            provider,
            need: Object.fromEntries(missing.map((k) => [k, spec.fields[k]])),
            instruction: `Для ${spec.name} не хватает полей creds: ${missing.join(", ")}. Попроси их у пользователя и вызови connect_integration ещё раз. Или пусть подключит сам в кабинете: ${CONNECT_PAGE}`,
          });
        }
        const title = a.title || spec.name;
        try {
          const saved = a.connectionId
            ? await api(`/api/bots/integrations/${a.connectionId}`, { method: "PUT", body: { title: a.title, creds: Object.keys(creds).length ? creds : undefined } })
            : await api("/api/bots/integrations", { method: "POST", body: { provider, title, creds } });
          return okResult({ connected: true, connectionId: saved?.id, ...withoutSecrets(saved), note: "Креды сохранены зашифрованными и обратно не отдаются (только маска hint).", usage: "connectionId ставь в действия сценария (amocrm_send, bitrix24_call, getcourse_send, yametrika_event, оплата ЮKassa) и в site_lead_settings (amoConnectionId или coreDelivery.connectionId). Проверить ключ — integration_test." });
        } catch (e) {
          if (e.status === 400) throw new Error(`${spec.name} не подключён: ${bodyReason(e.data) || "креды не приняты"}. Проверь поля: ${Object.entries(spec.fields).map(([k, v]) => `${k} — ${v}`).join("; ")}.`);
          throw e;
        }
      }

      // Провайдер из каталога Integration Core (~25 сервисов, GET /api/integrations/catalog) —
      // ключ в запросе на создание ВСЁ ЕЩЁ называется `provider`, но в нижнем регистре (bots/integrations
      // одинаково принимает enum-провайдеров и свободные providerKey из реестра, см. IntegrationConnectionService.create).
      const catalogKey = String(a.provider || "").trim().toLowerCase().replace(/[\s.-]+/g, "_");
      let catalog;
      try { catalog = await api("/api/integrations/catalog"); } catch { /* офлайн — фолбэк на статическую таблицу ниже */ }
      if (!Array.isArray(catalog)) {
        throw new Error(`Неизвестный provider «${a.provider}». Бывают: ${Object.keys(PROVIDER_FIELDS).join(", ")}, GOOGLE_SHEETS, INSTAGRAM (каталог Integration Core сейчас недоступен — офлайн-режим). Каталог: ${CONNECT_PAGE}`);
      }
      const entry = catalog.find((p) => String(p?.provider || "").toLowerCase() === catalogKey);
      if (!entry) {
        const names = catalog.map((p) => p.provider).filter(Boolean).join(", ");
        throw new Error(`Неизвестный provider «${a.provider}». Бывают: ${Object.keys(PROVIDER_FIELDS).join(", ")}, GOOGLE_SHEETS, INSTAGRAM, ${names}. Каталог: ${CONNECT_PAGE}`);
      }
      if (entry.status === "COMING_SOON" || entry.status === "IN_DEVELOPMENT") {
        throw new Error(`${entry.name} (${entry.provider}) пока нельзя подключить: статус ${entry.status}. Каталог: ${CONNECT_PAGE}`);
      }
      const schema = Array.isArray(entry.configSchema) ? entry.configSchema : [];
      const creds = a.creds && typeof a.creds === "object" ? Object.fromEntries(
        Object.entries(a.creds).filter(([, v]) => v != null && String(v).trim() !== "").map(([k, v]) => [k, String(v).trim()])) : {};
      const requiredFields = schema.filter((f) => !/необязательно|optional/i.test(f?.hint || ""));
      const missing = requiredFields.map((f) => f.key).filter((k) => !creds[k]);
      if (missing.length && (!a.connectionId || Object.keys(creds).length)) {
        return okResult({
          connected: false,
          provider: entry.provider,
          need: Object.fromEntries(schema.filter((f) => missing.includes(f.key)).map((f) => [f.key, f.hint || f.label])),
          instruction: `Для ${entry.name} не хватает полей creds: ${missing.join(", ")}. Попроси их у пользователя и вызови connect_integration ещё раз. Или пусть подключит сам в кабинете: ${CONNECT_PAGE}`,
        });
      }
      const title = a.title || entry.name;
      try {
        const saved = a.connectionId
          ? await api(`/api/bots/integrations/${a.connectionId}`, { method: "PUT", body: { title: a.title, creds: Object.keys(creds).length ? creds : undefined } })
          : await api("/api/bots/integrations", { method: "POST", body: { provider: entry.provider, title, creds } });
        return okResult({ connected: true, connectionId: saved?.id, ...withoutSecrets(saved), note: "Креды сохранены зашифрованными и обратно не отдаются (только маска hint).", usage: "connectionId ставь в действия сценария (actions из integration_catalog) и в site_lead_settings (coreDelivery.connectionId). Проверить ключ — integration_test." });
      } catch (e) {
        if (e.status === 400) throw new Error(`${entry.name} не подключён: ${bodyReason(e.data) || "креды не приняты"}. Проверь поля: ${schema.map((f) => `${f.key} — ${f.hint || f.label}`).join("; ")}.`);
        throw e;
      }
    }
    case "disconnect_integration":
      await api(`/api/bots/integrations/${a.connectionId}`, { method: "DELETE" });
      return okResult(`🗑️ Подключение ${a.connectionId} удалено.`);
    case "integration_ingress_url": {
      const id = String(a.connectionId || "").trim();
      if (!id) throw new Error("Передай connectionId — id подключения из list_integrations.");
      const suffix = a.rotate ? "/rotate" : "";
      const r = await api(`/api/bots/integrations/${encodeURIComponent(id)}/ingress-url${suffix}`, { method: "POST" });
      return okResult({ ...r, usage: "Вставь url в сервис провайдера как webhook/notification/result URL. В узле TRIGGER_WEBHOOK сценария задай config.provider + config.connectionId + config.event (ключ события из integration_catalog → inbound.events)." });
    }
    // ---- Рассылки ----
    case "broadcast_list": {
      if (a.botId) return okResult(await api(`/api/bots/${a.botId}/broadcasts`));
      const page = await api(`/api/bots/broadcasts${qs({ page: a.page, size: a.size, group: a.group })}`);
      let counts = null;
      try { counts = await api("/api/bots/broadcasts/counts"); } catch { /* счётчики не обязательны */ }
      return okResult({ counts, page });
    }
    case "broadcast_get": {
      const b = await api(`/api/bots/broadcasts/${a.broadcastId}`);
      if (b && b.failedJobs > 0) b.errors = await api(`/api/bots/broadcasts/${a.broadcastId}/errors`).catch(() => []);
      return okResult(b);
    }
    case "broadcast_preview": {
      const ids = botIdsOf(a);
      await assertBroadcastBots(ids);
      const filter = { tagsAll: strList(a.tagsAll), tagsNone: strList(a.tagsNone) };
      const perBot = [];
      for (const id of ids) {
        const r = await api(`/api/bots/${id}/broadcasts/preview`, { method: "POST", body: filter });
        perBot.push({ botId: id, count: r?.count ?? null, limit: r?.limit ?? null });
      }
      return okResult({ total: perBot.reduce((s, r) => s + (Number(r.count) || 0), 0), perBot, filter });
    }
    case "broadcast_send": {
      if (a.graphId) {
        const ids = botIdsOf(a);
        if (ids.length !== 1) throw new Error("Рассылка по сценарию — ровно один botId (сценарий принадлежит боту).");
        await assertBroadcastBots(ids);
        if (!a.name) throw new Error("Передай name рассылки.");
        const b = await api(`/api/bots/${ids[0]}/broadcasts`, { method: "POST", body: {
          name: a.name, audienceFilter: { tagsAll: strList(a.tagsAll), tagsNone: strList(a.tagsNone) },
          graphId: a.graphId, entryNodeId: a.entryNodeId || undefined, scheduledAt: toInstant(a.scheduledAt, "scheduledAt") } });
        return okResult({ broadcastIds: [b?.id], status: b?.status, scheduledAt: b?.scheduledAt ?? null, broadcast: b });
      }
      let draft = null;
      if (a.draftId) draft = await api(`/api/bots/broadcasts/drafts/${a.draftId}`);
      const pick = (k) => (a[k] !== undefined ? a[k] : draft?.[k]);
      const ids = botIdsOf({ botIds: a.botIds ?? (a.botId ? undefined : draft?.botIds), botId: a.botId });
      await assertBroadcastBots(ids);
      const name = String(pick("name") || "").trim();
      if (!name) throw new Error("Передай name рассылки (видно только тебе в списке рассылок).");
      const body = {
        name, botIds: ids,
        tagsAll: strList(a.tagsAll !== undefined ? a.tagsAll : draft?.audienceFilter?.tagsAll),
        tagsNone: strList(a.tagsNone !== undefined ? a.tagsNone : draft?.audienceFilter?.tagsNone),
        messages: normalizeBroadcastMessages(pick("messages")),
        scheduledAt: toInstant(pick("scheduledAt"), "scheduledAt"),
      };
      if (body.scheduledAt && new Date(body.scheduledAt).getTime() <= Date.now()) {
        // Прошедшее время бэкенд молча считает «сейчас» — для черновика с устаревшей датой это сюрприз.
        if (a.scheduledAt !== undefined) throw new Error(`scheduledAt ${body.scheduledAt} уже прошло — укажи будущее время или не передавай его (отправить сейчас).`);
        body.scheduledAt = null;
      }
      const r = await api("/api/bots/broadcasts/direct", { method: "POST", body });
      let draftDeleted = false;
      if (a.draftId) { try { await api(`/api/bots/broadcasts/drafts/${a.draftId}`, { method: "DELETE" }); draftDeleted = true; } catch { /* не критично */ } }
      return okResult({ ...r, scheduledAt: body.scheduledAt, ...(a.draftId ? { draftDeleted } : {}) });
    }
    case "broadcast_cancel":
      await api(`/api/bots/broadcasts/${a.broadcastId}/cancel`, { method: "POST" });
      return okResult(`⏹️ Рассылка ${a.broadcastId} отменяется (CANCELLING → CANCELLED).`);
    case "broadcast_recurring": {
      const base = "/api/bots/broadcasts/recurring";
      if (a.action === "list") return okResult(await api(base));
      if (a.action === "stop") {
        if (!a.ruleId) throw new Error("Передай ruleId (broadcast_recurring action=list).");
        await api(`${base}/${a.ruleId}/stop`, { method: "POST" });
        return okResult(`⏹️ Правило ${a.ruleId} остановлено — новых прогонов не будет.`);
      }
      if (a.action === "create") {
        const ids = botIdsOf(a);
        await assertBroadcastBots(ids);
        if (!a.name) throw new Error("Передай name.");
        const recurrence = String(a.recurrence || "").toUpperCase();
        if (!["DAILY", "MONTHLY", "YEARLY"].includes(recurrence)) throw new Error("recurrence: DAILY | MONTHLY | YEARLY.");
        const firstRunAt = toInstant(a.firstRunAt, "firstRunAt");
        if (!firstRunAt || new Date(firstRunAt).getTime() <= Date.now()) throw new Error("firstRunAt — время первого запуска в будущем (ISO 8601, без пояса — московское).");
        return okResult(await api(base, { method: "POST", body: {
          name: a.name, botIds: ids, tagsAll: strList(a.tagsAll), tagsNone: strList(a.tagsNone),
          messages: normalizeBroadcastMessages(a.messages), recurrence, firstRunAt } }));
      }
      throw new Error("action: list | create | stop.");
    }
    case "broadcast_drafts": {
      const base = "/api/bots/broadcasts/drafts";
      if (a.action === "list") return okResult(await api(base));
      if (a.action === "create" || a.action === "update") {
        if (a.action === "update" && !a.draftId) throw new Error("Передай draftId (broadcast_drafts action=list).");
        // update: PUT заменяет черновик целиком — непереданные поля берём из текущего, чтобы правка текста не стёрла ботов.
        const cur = a.action === "update" ? (await api(`${base}/${a.draftId}`)) || {} : {};
        const has = (k) => a[k] !== undefined;
        const body = {
          name: has("name") ? a.name : cur.name,
          botIds: has("botIds") || has("botId") ? botIdsOf(a) : (cur.botIds || []),
          tagsAll: strList(has("tagsAll") ? a.tagsAll : cur.audienceFilter?.tagsAll),
          tagsNone: strList(has("tagsNone") ? a.tagsNone : cur.audienceFilter?.tagsNone),
          messages: normalizeBroadcastMessages(has("messages") ? a.messages : cur.messages, false),
          scheduledAt: toInstant(has("scheduledAt") ? a.scheduledAt : cur.scheduledAt, "scheduledAt"),
        };
        if (a.action === "create") return okResult(await api(base, { method: "POST", body }));
        return okResult(await api(`${base}/${a.draftId}`, { method: "PUT", body }));
      }
      if (!a.draftId) throw new Error("Передай draftId (broadcast_drafts action=list).");
      if (a.action === "get") return okResult(await api(`${base}/${a.draftId}`));
      if (a.action === "delete") { await api(`${base}/${a.draftId}`, { method: "DELETE" }); return okResult(`🗑️ Черновик ${a.draftId} удалён.`); }
      throw new Error("action: list | get | create | update | delete.");
    }
    case "broadcast_duplicate":
      if (a.draftId) return okResult(await api(`/api/bots/broadcasts/drafts/${a.draftId}/duplicate`, { method: "POST" }));
      if (!a.broadcastId) throw new Error("Передай broadcastId или draftId.");
      return okResult(await api(`/api/bots/broadcasts/${a.broadcastId}/duplicate`, { method: "POST" }));
    case "site_templates": {
      const r = await api("/api/bots/pages/templates");
      let templates = Array.isArray(r?.templates) ? r.templates : [];
      if (a.category) templates = templates.filter((t) => t?.category === a.category);
      return okResult({ categories: r?.categories ?? [], templates });
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
