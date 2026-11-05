// Проверка tools[] агента до отправки в agent_update: зеркало AiAgentService.tools + AgentWriteToolConfig
// на бэкенде (не строже его — иначе MCP отвергнет то, что сервер принял бы). Возвращает список ошибок.

const READ = ["AMO_LOOKUP", "SHEETS_LOOKUP", "HTTP_API", "BOOKING_SLOTS"];
const WRITE = ["AMO_CREATE_LEAD", "AMO_UPDATE_LEAD", "AMO_UPDATE_CONTACT", "SHEETS_APPEND", "HTTP_POST", "SET_FIELD", "ADD_TAG", "HANDOFF", "BOOKING_BOOK", "PAYMENT_LINK", "PUBLISH_POST"];
// схема аргументов этих инструментов фиксирована сервером
const FIXED_SCHEMA = ["SET_FIELD", "ADD_TAG", "HANDOFF", "BOOKING_BOOK", "PAYMENT_LINK", "PUBLISH_POST"];
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const PROP_KEYS = new Set(["type", "description", "enum", "pattern", "maxLength", "minLength", "minimum", "maximum"]);
const SCHEMA_KEYS = new Set(["type", "properties", "required", "description"]);
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "content-type", "expect", "upgrade", "te", "trailer"]);
const MAX_TOOLS = 10;

export const AGENT_WRITE_TOOL_TYPES = WRITE;

function schemaErrors(schema, errs, id) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return errs.push(`${id}: argsSchema — объект {properties, required}`), new Set();
  if (schema.type != null && schema.type !== "object") errs.push(`${id}: argsSchema.type должен быть object`);
  for (const k of Object.keys(schema)) if (!SCHEMA_KEYS.has(k)) errs.push(`${id}: ключевое слово «${k}» в argsSchema не поддерживается`);
  const props = schema.properties;
  if (!props || typeof props !== "object" || Array.isArray(props) || Object.keys(props).length === 0) {
    errs.push(`${id}: опишите хотя бы один аргумент в argsSchema.properties`);
    return new Set();
  }
  if (Object.keys(props).length > 10) errs.push(`${id}: не больше 10 аргументов`);
  for (const [name, p] of Object.entries(props)) {
    if (!ARG_NAME.test(name)) errs.push(`${id}: имя аргумента «${name}» — латиница, цифры, подчёркивание`);
    if (!p || typeof p !== "object") { errs.push(`${id}: описание аргумента ${name} — объект`); continue; }
    for (const k of Object.keys(p)) if (!PROP_KEYS.has(k)) errs.push(`${id}: ключевое слово «${k}» у аргумента ${name} не поддерживается`);
    if (!["string", "number", "integer", "boolean"].includes(p.type)) errs.push(`${id}: type аргумента ${name} — string, number, integer или boolean`);
    if (p.enum != null && (!Array.isArray(p.enum) || p.enum.length === 0 || p.enum.length > 30)) errs.push(`${id}: enum аргумента ${name} — от 1 до 30 значений`);
    if (p.pattern != null) {
      try { new RegExp(p.pattern); } catch { errs.push(`${id}: pattern аргумента ${name} не разбирается`); }
    }
  }
  for (const r of schema.required || []) if (!(r in props)) errs.push(`${id}: required содержит неизвестный аргумент ${r}`);
  return new Set(Object.keys(props));
}

function placeholders(tpl, known, errs, id) {
  for (const m of String(tpl ?? "").matchAll(/\{([A-Za-z_][A-Za-z0-9_]{0,39})\}/g)) {
    if (!known.has(m[1]) && m[1] !== "now") errs.push(`${id}: в шаблоне {${m[1]}} нет в argsSchema.properties`);
  }
}

export function validateAgentTools(tools) {
  const errs = [];
  if (!Array.isArray(tools)) return ["tools должен быть массивом"];
  if (tools.length > MAX_TOOLS) errs.push(`не больше ${MAX_TOOLS} инструментов`);
  const ids = new Set();
  for (const t of tools) {
    const id = t?.id || "?";
    if (!t || typeof t !== "object") { errs.push("инструмент — объект"); continue; }
    if (!/^[a-z0-9_]{1,40}$/.test(t.id || "")) errs.push(`${id}: id — a-z, 0-9, _ (до 40)`);
    if (ids.has(t.id)) errs.push(`${id}: id повторяется`);
    ids.add(t.id);
    if (!t.title) errs.push(`${id}: нужен title`);
    if (![...READ, ...WRITE].includes(t.type)) { errs.push(`${id}: неизвестный type ${t.type}`); continue; }
    if (t.type === "BOOKING_SLOTS" && !t.bookingCalendarId) errs.push(`${id}: нужен bookingCalendarId (booking_calendar_list)`);
    if (!WRITE.includes(t.type)) continue;
    for (const [k, max] of [["limitPerConversation", 20], ["limitPerDay", 1000]]) {
      if (t[k] != null && !(Number.isInteger(t[k]) && t[k] >= 1 && t[k] <= max)) errs.push(`${id}: ${k} — число от 1 до ${max}`);
    }
    let known = new Set();
    if (!FIXED_SCHEMA.includes(t.type)) known = schemaErrors(t.argsSchema, errs, id);
    if (t.type.startsWith("AMO_") && !t.amoConnectionId) errs.push(`${id}: нужен amoConnectionId (подключение amoCRM)`);
    if (t.type === "AMO_CREATE_LEAD" && !t.amoLeadName) errs.push(`${id}: нужен amoLeadName`);
    if (t.type === "AMO_UPDATE_LEAD" && !t.amoLeadId) errs.push(`${id}: нужен amoLeadId`);
    if (t.type === "AMO_UPDATE_CONTACT" && !t.amoContactId) errs.push(`${id}: нужен amoContactId`);
    if (t.type === "BOOKING_BOOK" && !t.bookingCalendarId) errs.push(`${id}: нужен bookingCalendarId (booking_calendar_list)`);
    if (t.type === "PAYMENT_LINK") {
      if (!t.payConnectionId) errs.push(`${id}: нужен payConnectionId (подключение ЮKassa)`);
      if (!(Number(String(t.payAmount ?? "").replace(",", ".")) > 0)) errs.push(`${id}: payAmount — положительная сумма`);
      if (!t.payDescription) errs.push(`${id}: нужен payDescription`);
    }
    if (t.type === "PUBLISH_POST") {
      if (t.publishTarget === "vk") { if (!t.publishAccountId) errs.push(`${id}: нужен publishAccountId (vk_status)`); }
      else if (t.publishTarget === "channel") { if (!t.publishBotId || t.publishChatId == null) errs.push(`${id}: нужны publishBotId и publishChatId (bot_channel_list)`); }
      else errs.push(`${id}: publishTarget — channel|vk`);
    }
    if (t.type === "SHEETS_APPEND") {
      if (!t.sheetsEmail || !t.sheetsSpreadsheetId) errs.push(`${id}: нужны sheetsEmail и sheetsSpreadsheetId`);
      if (!Array.isArray(t.sheetsRowTemplate) || t.sheetsRowTemplate.length === 0) errs.push(`${id}: нужен sheetsRowTemplate (ячейки)`);
    }
    if (t.type === "HTTP_POST") {
      if (!/^https?:\/\//i.test(t.httpUrlTemplate || "")) errs.push(`${id}: httpUrlTemplate — http:// или https://`);
      if (t.httpBodyTemplate) {
        try { JSON.parse(t.httpBodyTemplate); } catch { errs.push(`${id}: httpBodyTemplate — невалидный JSON`); }
      }
      for (const h of t.httpHeaders || []) {
        if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(h?.name || "") || FORBIDDEN_HEADERS.has(String(h.name).toLowerCase())) errs.push(`${id}: недопустимый заголовок ${h?.name}`);
      }
    }
    if (t.type === "SET_FIELD" && !(t.allowedFields || []).length) errs.push(`${id}: нужен allowedFields`);
    if (t.type === "ADD_TAG" && !(t.allowedTags || []).length) errs.push(`${id}: нужен allowedTags`);
    for (const k of ["amoLeadId", "amoContactId", "amoLeadName", "amoPrice", "amoContactName", "amoPhone", "amoEmail", "httpUrlTemplate", "httpBodyTemplate"]) {
      if (t[k]) placeholders(t[k], known, errs, id);
    }
    for (const c of t.sheetsRowTemplate || []) placeholders(c, known, errs, id);
  }
  return errs;
}
