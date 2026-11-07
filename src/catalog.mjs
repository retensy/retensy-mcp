// Единый каталог действий сервиса (GET /api/agent-tools/catalog) — тот же список, что у «Чата с ИИ» в кабинете.
// Инструменты каталога регистрируются динамически и вызываются через POST /api/agent-tools/invoke: новые действия
// появляются в MCP без релиза npm. Захардкоженные инструменты остаются для обратной совместимости; при совпадении
// имени остаётся локальная версия: каталог только ДОБАВЛЯЕТ новые имена (SEC-24), вызовы локальных
// инструментов идут через локальный handleCall.
//
// Кэш: в памяти + файл ~/.retensy-bot-graph/catalog-<хэш базы>.json (чтобы tools/list сразу после старта уже
// знал каталог), обновление по TTL. Изменился набор — сервер шлёт notifications/tools/list_changed.
// Выключить: RETENSY_MCP_CATALOG=off.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const CATALOG_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
/** Служебные инструменты MCP: каталог их никогда не перекрывает. */
const RESERVED = new Set(["setup", "set_token"]);
export const MAX_DESCRIPTION_BYTES = 2 * 1024;
export const MAX_SCHEMA_BYTES = 8 * 1024;
export const MAX_CATALOG_TOOLS = 300;
const NAME_RX = /^[a-z][a-z0-9_]{2,63}$/;

/** Валидная запись каталога: имя, описание, схема-объект. Остальное отбрасывается, а не ломает tools/list. */
export function validCatalogTool(t) {
  return !!t && typeof t === "object" && typeof t.name === "string" && NAME_RX.test(t.name) && !RESERVED.has(t.name)
    && typeof t.description === "string" && t.description.trim().length > 0
    && Buffer.byteLength(t.description, "utf8") <= MAX_DESCRIPTION_BYTES
    && t.inputSchema && typeof t.inputSchema === "object" && t.inputSchema.type === "object"
    && Buffer.byteLength(JSON.stringify(t.inputSchema), "utf8") <= MAX_SCHEMA_BYTES;
}

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`[retensy-mcp] ${msg}`);
}

/** Валидные записи каталога, не больше MAX_CATALOG_TOOLS. */
function sanitize(list) {
  const valid = (Array.isArray(list) ? list : []).filter(validCatalogTool);
  if (valid.length > MAX_CATALOG_TOOLS) warnOnce("max-tools", `каталог: ${valid.length} инструментов, берутся первые ${MAX_CATALOG_TOOLS}`);
  return valid.slice(0, MAX_CATALOG_TOOLS);
}

/**
 * Список tools/list: захардкоженные инструменты, кроме перекрытых каталогом, + инструменты каталога.
 * Порядок стабильный: сначала захардкоженные (как было), затем новые из каталога.
 */
export function mergeTools(staticTools, catalogTools) {
  const known = new Set(staticTools.map((t) => t.name));
  const out = [...staticTools];
  for (const c of sanitize(catalogTools)) {
    if (known.has(c.name)) {
      warnOnce(`skip:${c.name}`, `каталог: инструмент ${c.name} уже есть локально, версия сервера пропущена`);
      continue;
    }
    known.add(c.name);
    const t = { name: c.name, description: c.description, inputSchema: c.inputSchema };
    if (c.requiresConfirmation === true) t.annotations = { destructiveHint: true };
    out.push(t);
  }
  return out;
}

function isSafeBase(base) {
  try {
    const u = new URL(base);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch { return false; }
}

export function createCatalog({ base, headers, configDir, enabled = true, now = () => Date.now(), fetchImpl = fetch }) {
  if (enabled && !isSafeBase(base)) {
    warnOnce("insecure-base", "каталог выключен: для не-localhost RETENSY_BASE_URL нужен https");
    enabled = false;
  }
  // Ключ кэша: база + хэш токена/куки, чтобы набор одного токена не виден другому.
  const fileFor = () => {
    const h = headers() || {};
    const secret = `${h.Authorization || h.authorization || ""}|${h.Cookie || h.cookie || ""}`;
    const tokenHash = crypto.createHash("sha256").update(secret).digest("hex").slice(0, 16);
    return path.join(configDir, `catalog-${hash(base)}-${tokenHash}.json`);
  };
  let tools = enabled ? readCache(fileFor()) : [];
  let fetchedAt = 0;
  let inflight = null;
  let signature = sig(tools);

  async function refresh() {
    if (!enabled) return false;
    if (inflight) return inflight;
    inflight = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(`${base}/api/agent-tools/catalog`, { headers: headers(), signal: ctrl.signal });
        if (!res.ok) return false;
        const data = await res.json();
        const next = Array.isArray(data?.tools) ? sanitize(data.tools) : null;
        if (!next) return false;
        fetchedAt = now();
        tools = next;
        try {
          fs.mkdirSync(configDir, { recursive: true });
          const file = fileFor();
          fs.writeFileSync(file, JSON.stringify({ fetchedAt, tools }), { mode: 0o600 });
          try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
        } catch { /* кэш на диске — удобство, не обязанность */ }
        const s = sig(tools);
        const changed = s !== signature;
        signature = s;
        return changed;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    tools: () => (enabled ? tools : []),
    has: (name) => enabled && tools.some((t) => t.name === name),
    stale: () => enabled && now() - fetchedAt > CATALOG_TTL_MS,
    refresh,
  };
}

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data?.tools) ? sanitize(data.tools) : [];
  } catch {
    return [];
  }
}

function sig(tools) {
  return JSON.stringify((tools || []).map((t) => [t.name, t.description, t.inputSchema]));
}

function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = (h * 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Что изменится: summary.text от сервера (diff узлов/блоков, получатели), иначе общий message. */
function changeSummary(data) {
  const sum = data?.step?.confirm?.summary;
  if (!sum || typeof sum !== "object") return "";
  const parts = [];
  if (typeof sum.text === "string" && sum.text) parts.push(sum.text);
  if (typeof sum.recipients === "number") parts.push(`Получателей: ${sum.recipients}.`);
  if (sum.irreversible === true) parts.push("Действие необратимо.");
  return parts.join(" ");
}

/** Ответ invoke → результат MCP. 409 needsConfirmation — не ошибка сервиса, а просьба спросить человека. */
export function confirmationText(data) {
  if (data && typeof data === "object" && data.needsConfirmation === true) {
    const msg = typeof data.message === "string" ? data.message : "";
    const what = changeSummary(data);
    const head = ["Нужно подтверждение пользователя.", what && !msg.includes(what) ? `Что изменится: ${what}` : "", msg].filter(Boolean).join(" ");
    if (typeof data.confirmToken === "string" && data.confirmToken) {
      return `⚠️ ${head} Опиши пользователю, что именно будет сделано, получи его явное согласие и повтори вызов с ТЕМИ ЖЕ аргументами плюс confirmToken: "${data.confirmToken}" (токен одноразовый, привязан к этим аргументам и действует 5 минут; если состояние изменилось, придёт новый запрос — покажи пользователю новое описание).`.trim();
    }
    return `⚠️ ${head}`.trim();
  }
  return null;
}
