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

function run(nodes, edges) {
  const file = join(dir, `${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ format: "retensy-bot-graph", version: 1, name: "t", nodes, edges, canvasMeta: {} }));
  const r = spawnSync(process.execPath, [join(root, "skills", "build-bot-funnel", "validate.mjs"), file], { encoding: "utf8" });
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

// fix-раунд 1, Minor: запятая/несколько адресов не должны проходить как один получатель
const commaActs = node("ACTIONS", { actions: [{ kind: "send_email", email: "a@b.c,admin@evil.com", text: "Текст" }] });
const comma = run([trig, commaActs], [edge(trig, commaActs)]);
check("send_email: запятая в адресе — ACTION_SEND_EMAIL_BAD_EMAIL", comma.out.includes("ACTION_SEND_EMAIL_BAD_EMAIL"));

fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`validate-graph: провалов ${failed}`); process.exit(1); }
console.log("validate-graph OK");
