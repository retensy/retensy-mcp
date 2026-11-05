// Единый каталог действий сервиса (GET /api/agent-tools/catalog) — тот же список, что у «Чата с ИИ» в кабинете.
// Инструменты каталога регистрируются динамически и вызываются через POST /api/agent-tools/invoke: новые действия
// появляются в MCP без релиза npm. Захардкоженные инструменты остаются для обратной совместимости; при совпадении
// имени берётся версия из каталога (сервер гарантирует тот же смысл — контракт-тест реестра на бэкенде).
//
// Кэш: в памяти + файл ~/.retensy-bot-graph/catalog-<хэш базы>.json (чтобы tools/list сразу после старта уже
// знал каталог), обновление по TTL. Изменился набор — сервер шлёт notifications/tools/list_changed.
// Выключить: RETENSY_MCP_CATALOG=off.

import fs from "node:fs";
import path from "node:path";

export const CATALOG_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
/** Служебные инструменты MCP: каталог их никогда не перекрывает. */
const RESERVED = new Set(["setup", "set_token"]);
const NAME_RX = /^[a-z][a-z0-9_]{2,63}$/;

/** Валидная запись каталога: имя, описание, схема-объект. Остальное отбрасывается, а не ломает tools/list. */
export function validCatalogTool(t) {
  return !!t && typeof t === "object" && typeof t.name === "string" && NAME_RX.test(t.name) && !RESERVED.has(t.name)
    && typeof t.description === "string" && t.description.trim().length > 0
    && t.inputSchema && typeof t.inputSchema === "object" && t.inputSchema.type === "object";
}

/**
 * Список tools/list: захардкоженные инструменты, кроме перекрытых каталогом, + инструменты каталога.
 * Порядок стабильный: сначала захардкоженные (как было), затем новые из каталога.
 */
export function mergeTools(staticTools, catalogTools) {
  const byName = new Map((catalogTools || []).filter(validCatalogTool).map((t) => [t.name, t]));
  const out = staticTools.map((t) => {
    const c = byName.get(t.name);
    return c ? { name: c.name, description: c.description, inputSchema: c.inputSchema } : t;
  });
  const known = new Set(staticTools.map((t) => t.name));
  for (const c of byName.values()) {
    if (!known.has(c.name)) out.push({ name: c.name, description: c.description, inputSchema: c.inputSchema });
  }
  return out;
}

export function createCatalog({ base, headers, configDir, enabled = true, now = () => Date.now(), fetchImpl = fetch }) {
  const file = path.join(configDir, `catalog-${hash(base)}.json`);
  let tools = readCache(file);
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
        const next = Array.isArray(data?.tools) ? data.tools.filter(validCatalogTool) : null;
        if (!next) return false;
        fetchedAt = now();
        tools = next;
        try {
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ fetchedAt, tools }));
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
    return Array.isArray(data?.tools) ? data.tools.filter(validCatalogTool) : [];
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

/** Ответ invoke → результат MCP. 409 needsConfirmation — не ошибка сервиса, а просьба спросить человека. */
export function confirmationText(data) {
  if (data && typeof data === "object" && data.needsConfirmation === true) {
    return `⚠️ Нужно подтверждение пользователя. ${typeof data.message === "string" ? data.message : ""}`.trim();
  }
  return null;
}
