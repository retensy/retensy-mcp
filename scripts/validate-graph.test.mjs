#!/usr/bin/env node
/**
 * Оффлайн-валидатор скилла (skills/build-bot-funnel/validate.mjs) знает новые возможности бэкенда:
 * TRIGGER_SCHEDULE, действия записи/подписок/handoff/Meta CAPI, шаблонные даты DELAY UNTIL / SCHEDULE со смещением.
 * Хороший граф — exit 0 без ACTION_UNKNOWN_KIND; плохой — коды ошибок бэкенда. Выход 0 — ок, 1 — провал.
 */

import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-vg-"));
let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "  ok " : "  FAIL"} ${name}`); if (!cond) failed++; };

function run(nodes, edges, platform) {
  const file = join(dir, `${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ format: "retensy-bot-graph", version: 1, name: "t", nodes, edges, canvasMeta: {} }));
  const r = spawnSync(process.execPath, [join(root, "skills", "build-bot-funnel", "validate.mjs"), file, ...(platform ? [`--platform=${platform}`] : [])], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}
const node = (type, config) => ({ id: randomUUID(), type, position: { x: 0, y: 0 }, config });
const edge = (a, b, h = "next") => ({ id: randomUUID(), sourceNodeId: a.id, sourceHandle: h, targetNodeId: b.id });
const CAL = randomUUID();

// --- хороший граф ---
const trig = node("TRIGGER_SCHEDULE", { cron: "0 9 * * 1-5", timezone: "Europe/Moscow" });
const acts = node("ACTIONS", { actions: [
  { kind: "booking_slots", calendarId: CAL, saveTo: "slots" },
  { kind: "booking_book", calendarId: CAL, slotAt: "{{var.slot_at}}" },
  { kind: "booking_cancel", bookingId: "{{var.booking_id}}" },
  { kind: "lead_link_contact", phone: "{{var.phone}}" },
  { kind: "invite_link_create", expireHours: 24 },
  { kind: "invite_link_revoke", link: "{{var.invite_link}}" },
  { kind: "subscription_extend", period: "1mo" },
  { kind: "subscription_check" },
  { kind: "yookassa_charge_saved", connectionId: "c1", amount: "990" },
  { kind: "meta_capi_event", connectionId: "c2", eventName: "Purchase" },
  { kind: "agent_chat" },
  { kind: "bitrix24_call", connectionId: "c3", b24method: "crm.lead.add" },
  { kind: "send_email", email: "{{var.email}}", subject: "Тема", text: "Текст", replyTo: "owner@retensy.com" },
] });
const delay = node("DELAY", { kind: "UNTIL", isoTimestamp: "{{var.slot_at}}", offset: "-24h", timezone: "Europe/Moscow" });
const sched = node("SCHEDULE", { isoDate: "{{var.slot_at}}", offset: "-30m" });
const msg = node("SEND_MESSAGE", { text: "Напоминание", cards: [{ type: "text", text: "Напоминание" }] });
const good = run([trig, acts, delay, sched, msg], [edge(trig, acts), edge(acts, delay), edge(acts, msg, "taken"), edge(delay, sched), edge(sched, msg, "scheduled")]);
check("новые kind, TRIGGER_SCHEDULE, шаблонные даты — валидация пройдена", good.code === 0 && !/ACTION_UNKNOWN_KIND/.test(good.out));

const coreActs = node("ACTIONS", { actions: [{ kind: "moysklad_order_create", connectionId: "c" }] });
const core = run([trig, coreActs], [edge(trig, coreActs)]);
check("kind Integration Core не из списка — предупреждение, не ошибка", core.code === 0 && /integration_catalog/.test(core.out));

// --- плохой граф ---
const badTrig = node("TRIGGER_SCHEDULE", { cron: "0 9 * *", timezone: "Mars/Olympus" });
const badActs = node("ACTIONS", { actions: [{ kind: "booking_book" }, { kind: "booking_slots", calendarId: CAL, saveTo: "Bad-Var" },
  { kind: "send_email", email: "not-an-email", text: "" }] });
const badDelay = node("DELAY", { kind: "UNTIL", isoTimestamp: "{{var.slot_at}}", offset: "minus a day" });
const badSched = node("SCHEDULE", { isoDate: "2026-10-12" });
const bad = run([badTrig, badActs, badDelay, badSched], [edge(badTrig, badActs), edge(badActs, badDelay), edge(badDelay, badSched)]);
check("плохой граф — exit 1", bad.code === 1);
for (const code of ["SCHEDULE_TRIGGER_BAD_CRON", "SCHEDULE_TRIGGER_BAD_TIMEZONE", "ACTION_BOOKING_NO_CALENDAR", "ACTION_BAD_KEY", "DELAY_BAD_OFFSET", "SCHEDULE_BAD_TIME",
  "ACTION_SEND_EMAIL_BAD_EMAIL", "ACTION_SEND_EMAIL_NO_TEXT"]) {
  check(`плохой граф — ${code}`, bad.out.includes(code));
}

// публикации из сценария
const pubBad = node("ACTIONS", { actions: [{ kind: "publish_post", target: "channel", text: "x" }, { kind: "chain_enqueue", chainId: "nope" }] });
const pb = run([trig, pubBad], [edge(trig, pubBad)]);
for (const code of ["PUBLISH_NO_DESTINATION", "CHAIN_ENQUEUE_BAD_CHAIN", "CHAIN_ENQUEUE_EMPTY"]) check(`публикации — ${code}`, pb.out.includes(code));
const pubOk = node("ACTIONS", { actions: [{ kind: "publish_post", target: "vk", accountId: "a1", text: "x" }, { kind: "chain_enqueue", chainId: randomUUID(), text: "y" }] });
check("публикации: корректные действия проходят", run([trig, pubOk], [edge(trig, pubOk)]).code === 0);

// start_broadcast и TRIGGER_BOOKING
const bcBad = node("ACTIONS", { actions: [{ kind: "start_broadcast", draftId: "nope", segmentId: "x", minIntervalHours: 0 }] });
const bcb = run([trig, bcBad], [edge(trig, bcBad)]);
for (const code of ["BROADCAST_BAD_DRAFT", "BROADCAST_BAD_SEGMENT", "BROADCAST_BAD_INTERVAL"]) check(`start_broadcast — ${code}`, bcb.out.includes(code));
const bcOk = node("ACTIONS", { actions: [{ kind: "start_broadcast", draftId: randomUUID(), minIntervalHours: 24, idempotencyKey: "promo-{{var.id}}" }] });
check("start_broadcast: корректное действие проходит", run([trig, bcOk], [edge(trig, bcOk)]).code === 0);
const bkTrig = node("TRIGGER_BOOKING", { events: [] });
const bkMsg = node("SEND_MESSAGE", { text: "Запись {{booking.label}}", cards: [{ type: "text", text: "Запись {{booking.label}}" }] });
check("TRIGGER_BOOKING без событий — BOOKING_TRIGGER_NO_EVENTS", run([bkTrig, bkMsg], [edge(bkTrig, bkMsg)]).out.includes("BOOKING_TRIGGER_NO_EVENTS"));
const bkBad = node("TRIGGER_BOOKING", { events: ["booked", "oops"], calendarId: "x", hoursBefore: 999 });
const bkb = run([bkBad, bkMsg], [edge(bkBad, bkMsg)]);
for (const code of ["BOOKING_TRIGGER_BAD_EVENT", "BOOKING_TRIGGER_BAD_CALENDAR", "BOOKING_TRIGGER_BAD_HOURS"]) check(`TRIGGER_BOOKING — ${code}`, bkb.out.includes(code));
const bkOk = node("TRIGGER_BOOKING", { events: ["booked", "reminder"], hoursBefore: 24 });
check("TRIGGER_BOOKING: корректный проходит", run([bkOk, bkMsg], [edge(bkOk, bkMsg)]).code === 0);

// fix-раунд 1, Minor: запятая/несколько адресов не должны проходить как один получатель
const commaActs = node("ACTIONS", { actions: [{ kind: "send_email", email: "a@b.c,admin@evil.com", text: "Текст" }] });
const comma = run([trig, commaActs], [edge(trig, commaActs)]);
check("send_email: запятая в адресе — ACTION_SEND_EMAIL_BAD_EMAIL", comma.out.includes("ACTION_SEND_EMAIL_BAD_EMAIL"));

// DELAY: окно в поясе подписчика
const okWinDelay = node("DELAY", { kind: "FIXED", durationSec: 3600, windowFrom: "09:00", windowTo: "21:00", windowTz: "subscriber" });
const okWinTrig = node("TRIGGER_COMMAND", { command: "start" });
const okWin = run([okWinTrig, okWinDelay], [edge(okWinTrig, okWinDelay)]);
check("DELAY windowTz=subscriber - без DELAY_BAD_WINDOW_TZ", !okWin.out.includes("DELAY_BAD_WINDOW_TZ"));
const okWinOffset = run([okWinTrig, node("DELAY", { kind: "FIXED", durationSec: 60, windowFrom: "09:00", windowTo: "21:00", windowTz: "UTC+3" })], []);
check("DELAY windowTz=UTC+3 допустим", !okWinOffset.out.includes("DELAY_BAD_WINDOW_TZ"));
const badWinDelay = node("DELAY", { kind: "FIXED", durationSec: 3600, windowFrom: "09:00", windowTo: "21:00", windowTz: "Mars/Olympus" });
const badWin = run([okWinTrig, badWinDelay], [edge(okWinTrig, badWinDelay)]);
check("DELAY windowTz мусор - DELAY_BAD_WINDOW_TZ", badWin.out.includes("DELAY_BAD_WINDOW_TZ"));

// DELETE_MESSAGE: хороший и плохой конфиги
const linkMsg = node("SEND_MESSAGE", { text: "Ссылка", parseMode: "PLAIN" });
const delOk = node("DELETE_MESSAGE", { mode: "NODE", nodeId: linkMsg.id, delay: 30, unit: "SECONDS" });
const delGood = run([trig, linkMsg, delOk], [edge(trig, linkMsg), edge(linkMsg, delOk)]);
check("DELETE_MESSAGE: корректный узел — exit 0", delGood.code === 0);
const delBad = node("DELETE_MESSAGE", { mode: "NODE", nodeId: trig.id, delay: 25, unit: "HOURS" });
const delBad2 = node("DELETE_MESSAGE", { mode: "NEXT" });
const delBadRun = run([trig, linkMsg, delBad, delBad2], [edge(trig, linkMsg), edge(linkMsg, delBad), edge(delBad, delBad2)]);
for (const code of ["DELETE_NODE_NOT_SENDER", "DELETE_DELAY_TOO_LONG", "DELETE_NEXT_NO_DELAY"]) {
  check(`DELETE_MESSAGE: ${code}`, delBadRun.out.includes(code));
}
check("DELETE_MESSAGE: неизвестный mode", run([trig, node("DELETE_MESSAGE", { mode: "ALL" })], []).out.includes("DELETE_BAD_MODE"));

// NEXT через паузу: предупреждение (не ошибка); напрямую - без предупреждения; дробная пауза допустима
const nxt = node("DELETE_MESSAGE", { mode: "NEXT", delay: 0.5, unit: "MINUTES" });
const pause = node("DELAY", { kind: "FIXED", durationSec: 60 });
const nxtSend = node("SEND_MESSAGE", { text: "Ссылка", parseMode: "PLAIN" });
const parked = run([trig, nxt, pause, nxtSend], [edge(trig, nxt), edge(nxt, pause), edge(pause, nxtSend)]);
check("DELETE_MESSAGE NEXT через DELAY: DELETE_NEXT_PARKED, exit 0", parked.code === 0 && parked.out.includes("DELETE_NEXT_PARKED"));
const direct = run([trig, nxt, nxtSend], [edge(trig, nxt), edge(nxt, nxtSend)]);
check("DELETE_MESSAGE NEXT напрямую: без предупреждения, дробная пауза ок", direct.code === 0 && !direct.out.includes("DELETE_NEXT_PARKED"));
check("DELETE_MESSAGE NEXT без отправителя: DELETE_NEXT_NO_SENDER", run([trig, nxt], [edge(trig, nxt)]).out.includes("DELETE_NEXT_NO_SENDER"));
const nxtZero = run([trig, linkMsg, node("DELETE_MESSAGE", { mode: "NEXT", delay: 0 })], [edge(trig, linkMsg), edge(linkMsg, trig)]);
check("DELETE_MESSAGE NEXT delay 0: DELETE_NEXT_NO_DELAY", nxtZero.out.includes("DELETE_NEXT_NO_DELAY"));

// group_kick: режимы, срок, чат
const kickOk = node("ACTIONS", { actions: [{ kind: "group_kick", mode: "kick", chatId: "-100123" }, { kind: "group_kick", mode: "ban", untilDays: "30", chatId: "@my_channel" }, { kind: "group_kick" }] });
check("group_kick: корректные конфиги — exit 0", run([trig, kickOk], [edge(trig, kickOk)]).code === 0);
const kickBad = node("ACTIONS", { actions: [{ kind: "group_kick", mode: "remove" }, { kind: "group_kick", mode: "ban", untilDays: "400" },
  { kind: "group_kick", mode: "kick", untilDays: "5" }, { kind: "group_kick", mode: "kick", chatId: "канал" }] });
const kickBadRun = run([trig, kickBad], [edge(trig, kickBad)]);
for (const code of ["GROUP_KICK_BAD_MODE", "GROUP_KICK_BAD_UNTIL", "GROUP_KICK_UNTIL_WITH_KICK", "GROUP_KICK_BAD_CHAT"])
  check(`group_kick — ${code}`, kickBadRun.out.includes(code));
// RANDOM_TEXT: зеркало GraphValidator.validateRandomText
const rtOk = node("RANDOM_TEXT", { texts: ["один", "два"], mode: "send", noRepeat: true });
const rtGood = run([trig, rtOk], [edge(trig, rtOk)]);
check("RANDOM_TEXT: корректный узел — без RANDOM_TEXT_*", !rtGood.out.includes("RANDOM_TEXT_"));
const rtEmpty = node("RANDOM_TEXT", { texts: ["  "], mode: "variable" });
const rtBad = run([trig, rtEmpty], [edge(trig, rtEmpty)]);
check("RANDOM_TEXT: пусто — RANDOM_TEXT_NO_TEXTS", rtBad.out.includes("RANDOM_TEXT_NO_TEXTS"));
check("RANDOM_TEXT: variable без saveTo — RANDOM_TEXT_BAD_SAVE_TO", rtBad.out.includes("RANDOM_TEXT_BAD_SAVE_TO"));
const rtLong = node("RANDOM_TEXT", { texts: ["x".repeat(65537)] });
check("RANDOM_TEXT: длинный текст — RANDOM_TEXT_TOO_LONG", run([trig, rtLong], [edge(trig, rtLong)]).out.includes("RANDOM_TEXT_TOO_LONG"));

// AI_CLASSIFY: зеркало GraphValidator.validateAiClassify
const aiOk = node("AI_CLASSIFY", { mode: "classify", instruction: "Что хочет клиент", categories: [{ id: "buy", label: "Купить" }, { id: "ask", label: "Вопрос" }], saveTo: "intent" });
check("AI_CLASSIFY: корректный узел — без AI_CLASSIFY_*", !run([trig, aiOk], [edge(trig, aiOk)]).out.includes("AI_CLASSIFY_"));
const aiBad = node("AI_CLASSIFY", { mode: "classify", instruction: "", categories: [{ id: "a", label: "A" }] });
const aiBadRun = run([trig, aiBad], [edge(trig, aiBad)]);
check("AI_CLASSIFY: одна категория — AI_CLASSIFY_FEW_CATEGORIES", aiBadRun.out.includes("AI_CLASSIFY_FEW_CATEGORIES"));
check("AI_CLASSIFY: без instruction — AI_CLASSIFY_NO_INSTRUCTION", aiBadRun.out.includes("AI_CLASSIFY_NO_INSTRUCTION"));
const aiExtract = node("AI_CLASSIFY", { mode: "extract" });
const aiExtractRun = run([trig, aiExtract], [edge(trig, aiExtract)]);
check("AI_CLASSIFY: extract без field/saveTo", aiExtractRun.out.includes("AI_CLASSIFY_NO_FIELD") && aiExtractRun.out.includes("AI_CLASSIFY_NO_SAVE_TO"));
check("AI_CLASSIFY: неизвестный mode — AI_CLASSIFY_BAD_MODE", run([trig, node("AI_CLASSIFY", { mode: "x" })], [edge(trig, node("END", {}))]).out.includes("AI_CLASSIFY_BAD_MODE"));
// CONDITION TAG OLDER_THAN: нужен tagDays
const tagAge = node("CONDITION", { match: "ALL", conditions: [{ kind: "TAG", op: "OLDER_THAN", value: "lead" }] });
check("CONDITION TAG OLDER_THAN без tagDays — CONDITION_BAD_TAG_DAYS", run([trig, tagAge], [edge(trig, tagAge)]).out.includes("CONDITION_BAD_TAG_DAYS"));

// issue_stars_invoice: зеркало GraphValidator.validateStarsInvoice (Telegram Stars, XTR)
const starsOk = node("ACTIONS", { actions: [{ kind: "add_tag", tag: "buyer" }, { kind: "issue_stars_invoice", amount: "150", title: "Курс", description: "Доступ", timeoutMinutes: 30 }] });
const starsGood = run([trig, starsOk], [edge(trig, starsOk)]);
check("issue_stars_invoice: корректный счёт — exit 0, без STARS_*", starsGood.code === 0 && !starsGood.out.includes("STARS_") && !starsGood.out.includes("ACTION_UNKNOWN_KIND"));
const starsTpl = node("ACTIONS", { actions: [{ kind: "issue_stars_invoice", amount: "{{var.price}}", title: "Курс {{var.n}}" }] });
check("issue_stars_invoice: шаблоны в amount/title допустимы", run([trig, starsTpl], [edge(trig, starsTpl)]).code === 0);
const starsBad = node("ACTIONS", { actions: [{ kind: "issue_stars_invoice", amount: "0", title: "x".repeat(33), description: "d".repeat(256) }] });
const starsBadRun = run([trig, starsBad], [edge(trig, starsBad)]);
for (const code of ["STARS_BAD_AMOUNT", "STARS_TITLE_TOO_LONG", "STARS_DESC_TOO_LONG"])
  check(`issue_stars_invoice — ${code}`, starsBadRun.out.includes(code));
const starsEmpty = node("ACTIONS", { actions: [{ kind: "issue_stars_invoice" }] });
const starsEmptyRun = run([trig, starsEmpty], [edge(trig, starsEmpty)]);
check("issue_stars_invoice: пусто — STARS_NO_AMOUNT и STARS_NO_TITLE", starsEmptyRun.out.includes("STARS_NO_AMOUNT") && starsEmptyRun.out.includes("STARS_NO_TITLE"));
const starsFrac = node("ACTIONS", { actions: [{ kind: "issue_stars_invoice", amount: "1.5", title: "A" }, { kind: "issue_stars_invoice", amount: "10001", title: "A" }] });
check("issue_stars_invoice: дробная и слишком большая сумма — STARS_BAD_AMOUNT", run([trig, starsFrac], [edge(trig, starsFrac)]).out.includes("STARS_BAD_AMOUNT"));
const starsNotLast = node("ACTIONS", { actions: [{ kind: "issue_stars_invoice", amount: "5", title: "A" }, { kind: "add_tag", tag: "x" }] });
check("issue_stars_invoice: не последний — INVOICE_NOT_LAST", run([trig, starsNotLast], [edge(trig, starsNotLast)]).out.includes("INVOICE_NOT_LAST"));
const starsMixed = node("ACTIONS", { actions: [{ kind: "issue_invoice", connectionId: "c", amount: "5", description: "d" }, { kind: "issue_stars_invoice", amount: "5", title: "A" }] });
check("ЮKassa-счёт + звёзды в одном блоке — INVOICE_DUPLICATE", run([trig, starsMixed], [edge(trig, starsMixed)]).out.includes("INVOICE_DUPLICATE"));
const starsMax = run([trig, starsOk], [edge(trig, starsOk)], "MAX");
check("issue_stars_invoice на MAX — STARS_TELEGRAM_ONLY", starsMax.code !== 0 && starsMax.out.includes("STARS_TELEGRAM_ONLY"));

// Telegram Business: business_message - рабочее событие, business_connection - нет; условие BUSINESS
const bizTrig = node("TRIGGER_TG_EVENT", { event: "business_message", filter: { text: "цена", textMode: "contains" } });
const bizMsg = node("SEND_MESSAGE", { text: "Привет", cards: [{ type: "text", text: "Привет" }] });
const bizRun = run([bizTrig, bizMsg], [edge(bizTrig, bizMsg)]);
check("TG_EVENT business_message: допустим, без TG_EVENT_UNSUPPORTED и без предупреждения о фильтре", bizRun.code === 0 && !bizRun.out.includes("TG_EVENT_UNSUPPORTED") && !bizRun.out.includes("игнорируется"));
const bizConn = node("TRIGGER_TG_EVENT", { event: "business_connection" });
check("TG_EVENT business_connection: TG_EVENT_UNSUPPORTED", run([bizConn, bizMsg], [edge(bizConn, bizMsg)]).out.includes("TG_EVENT_UNSUPPORTED"));
const bizCond = node("CONDITION", { match: "ALL", conditions: [{ kind: "BUSINESS", op: "IS" }] });
const bizCondRun = run([trig, bizCond, bizMsg], [edge(trig, bizCond), edge(bizCond, bizMsg, "yes")]);
check("CONDITION BUSINESS/IS: без предупреждения о kind/op", !bizCondRun.out.includes("неизвестный kind") && !bizCondRun.out.includes("не из {"));
const bizCondBad = node("CONDITION", { match: "ALL", conditions: [{ kind: "BUSINESS", op: "MAYBE" }] });
check("CONDITION BUSINESS/MAYBE: предупреждение об op", run([trig, bizCondBad, bizMsg], [edge(trig, bizCondBad), edge(bizCondBad, bizMsg, "yes")]).out.includes("не из {IS,IS_NOT}"));

// ACCESS_GATE и маппинг TRIGGER_WEBHOOK
const gateOk = node("ACCESS_GATE", { match: "ANY", rules: [{ kind: "ALLOWLIST" }, { kind: "TG_ID", value: "123" }, { kind: "TAG", value: "vip" }, { kind: "SEGMENT", value: "s1" }, { kind: "VARIABLE", key: "plan", op: "EQUALS", value: "pro" }] });
const gateRun = run([trig, gateOk, bizMsg], [edge(trig, gateOk), edge(gateOk, bizMsg, "allowed")]);
check("ACCESS_GATE: корректный узел без ошибок ACCESS_GATE_*", !gateRun.out.includes("ACCESS_GATE_"));
const gateBad = (cfg) => run([trig, node("ACCESS_GATE", cfg)], []).out;
check("ACCESS_GATE: без правил - ACCESS_GATE_NO_RULES", gateBad({ match: "ANY", rules: [] }).includes("ACCESS_GATE_NO_RULES"));
check("ACCESS_GATE: неизвестный kind", gateBad({ rules: [{ kind: "FOO" }] }).includes("ACCESS_GATE_BAD_KIND"));
check("ACCESS_GATE: TG_ID/USERNAME/PHONE без value", ["TG_ID", "USERNAME", "PHONE"].every((k) => gateBad({ rules: [{ kind: k, value: " " }] }).includes("ACCESS_GATE_NO_VALUE")));
check("ACCESS_GATE: SEGMENT без value", gateBad({ rules: [{ kind: "SEGMENT" }] }).includes("ACCESS_GATE_NO_SEGMENT"));
check("ACCESS_GATE: VARIABLE без key", gateBad({ rules: [{ kind: "VARIABLE" }] }).includes("ACCESS_GATE_NO_KEY"));
check("ACCESS_GATE: плохой match", gateBad({ match: "SOME", rules: [{ kind: "ALLOWLIST" }] }).includes("ACCESS_GATE_BAD_MATCH"));
const whBad = (cfg) => run([node("TRIGGER_WEBHOOK", cfg)], []).out;
check("TRIGGER_WEBHOOK mappings: корректные без ошибок", !whBad({ mappings: [{ path: "$.data.email", saveTo: "email" }] }).includes("WEBHOOK_BAD_MAPPING"));
check("TRIGGER_WEBHOOK mappings: path без $", whBad({ mappings: [{ path: "data.email", saveTo: "email" }] }).includes("WEBHOOK_BAD_MAPPING_PATH"));
check("TRIGGER_WEBHOOK mappings: плохое saveTo", whBad({ mappings: [{ path: "$.a", saveTo: "Bad-Name" }] }).includes("WEBHOOK_BAD_MAPPING_SAVE_TO"));

const sendBad = (cfg) => run([node("SEND_MESSAGE", { text: "Привет", ...cfg })], []).out;
check("SEND_MESSAGE ephemeral + awaitReply отвергается", sendBad({ ephemeral: true, awaitReply: true, saveTo: "a" }).includes("EPHEMERAL_NO_QUESTION"));
check("SEND_MESSAGE ephemeral сам по себе без ошибок", !sendBad({ ephemeral: true }).includes("EPHEMERAL_NO_QUESTION"));
check("SEND_MESSAGE widget: мало вариантов", sendBad({ widget: { options: ["Да"] }, awaitReply: true, saveTo: "a" }).includes("WIDGET_OPTIONS"));
check("SEND_MESSAGE widget: без awaitReply", sendBad({ widget: { options: ["Да", "Нет"] } }).includes("WIDGET_NO_SAVE_TO"));
check("SEND_MESSAGE widget: корректный", !/WIDGET_/.test(sendBad({ widget: { options: ["Да", "Нет"] }, awaitReply: true, saveTo: "a" })));

fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`validate-graph: провалов ${failed}`); process.exit(1); }
console.log("validate-graph OK");
