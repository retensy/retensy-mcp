#!/usr/bin/env node
// B2B-магазин: инструменты shop_* ходят в REST /api/bots/commerce/..., мутации требуют confirm:true,
// секреты (joinCode, номера счетов) маскируются, файлы отдаются base64 с лимитом или в savePath.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seen = [];
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100, 1)]);
const BIG = Buffer.alloc(2 * 1024 * 1024 + 10, 7);
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const ct = String(req.headers["content-type"] || "");
    const entry = { m: req.method, u: req.url, auth: req.headers.authorization, ct, body: ct.includes("json") && raw.length ? JSON.parse(raw) : null, raw: raw.toString("latin1") };
    seen.push(entry);
    const json = (o, code = 200) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.url === "/api/bots/commerce/orders/o1/invoice.pdf") { res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", "attachment; filename=\"schet-3.pdf\""); return res.end(PDF); }
    if (req.url === "/api/bots/commerce/orders/o1/quote.pdf") { res.setHeader("Content-Type", "application/pdf"); return res.end(PDF); }
    if (req.url === "/api/bots/commerce/orders/o1/quote-file") { res.setHeader("Content-Type", "application/pdf"); return res.end(BIG); }
    if (req.url === "/api/bots/commerce/seller") return json({ seller: { name: "ООО", inn: "7707083893", account: "40702810123456789012", corrAccount: "30101810400000000225" }, ready: true });
    if (req.url === "/api/bots/commerce/buyer-groups" && req.method === "GET") return json({ groups: [{ code: "opt", discountPct: 15, joinCode: "super-secret-code" }, { code: "vip" }], assignments: [] });
    if (req.url === "/api/bots/commerce/buyer-groups/upsert") return json({ code: "opt", joinCode: "abcdef0123456789" });
    if (req.url === "/api/bots/commerce/orders/o1/status" && entry.body?.status === "paid") return json({ error: "bad transition" }, 409);
    if (req.url === "/api/bots/commerce/orders/o1/documents" && req.method === "POST") return json({ id: "d1", name: "x.pdf" });
    json({ ok: true });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const home = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-shop-"));
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, RETENSY_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
    RETENSY_MCP_TOKEN: "zmcp_test_shop", RETENSY_MCP_TELEMETRY: "off", RETENSY_MCP_AUTOUPDATE: "0", RETENSY_MCP_CATALOG: "off" },
  stdio: ["pipe", "pipe", "ignore"],
});
const waiters = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const text = (r) => r?.result?.content?.[0]?.text || "";
const last = () => seen[seen.length - 1];
let failed = 0;
const check = (n, ok) => { if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}`); };
const timer = setTimeout(() => { console.log("  FAIL  таймаут"); process.exit(1); }, 30000);
try {
  await rpc("initialize", {});
  const tools = (await rpc("tools/list", {})).result.tools;
  const shop = tools.filter((t) => t.name.startsWith("shop_"));
  const b2bNames = ["shop_quotes_list", "shop_quote_answer", "shop_order_status_set", "shop_invoice_issue", "shop_invoice_mark_paid", "shop_invoice_pdf", "shop_quote_file_get", "shop_order_document_upload", "shop_order_document_get", "shop_order_document_delete", "shop_seller_get", "shop_seller_checklist", "shop_seller_requisites_update", "shop_buyer_groups_get", "shop_buyer_group_upsert", "shop_buyer_group_delete", "shop_buyer_group_assign", "shop_delivery_settings_get", "shop_delivery_settings_update", "shop_item_b2b_update", "shop_b2b_settings_get", "shop_b2b_settings_update", "shop_leads_list", "shop_lead_to_order", "shop_wholesale_approve", "shop_quote_pdf"];
  check("26 shop-инструментов B2B", b2bNames.every((n) => shop.some((t) => t.name === n)));
  check("у мутаций есть confirm", ["shop_quote_answer", "shop_order_status_set", "shop_invoice_mark_paid", "shop_buyer_group_upsert", "shop_delivery_settings_update", "shop_seller_requisites_update", "shop_item_b2b_update", "shop_b2b_settings_update"].every((n) => !!tools.find((t) => t.name === n)?.inputSchema?.properties?.confirm));

  const n = seen.length;
  let r = await call("shop_quote_answer", { orderId: "o1", lines: [{ index: 0, price: 10 }] });
  check("мутация без confirm отклонена, сервер не вызван", r.result.isError && seen.length === n);

  r = await call("shop_quotes_list", { status: "quote_requested", page: 1 });
  check("quotes_list: GET с query", last().m === "GET" && last().u === "/api/bots/commerce/quotes?status=quote_requested&page=1" && last().auth === "Bearer zmcp_test_shop");

  r = await call("shop_quote_answer", { orderId: "o1", lines: [{ index: 0, price: 1500.5 }], deliveryCost: 300, note: "10 дней", invoice: true, confirm: true });
  check("quote_answer: POST без confirm в теле", last().u === "/api/bots/commerce/orders/o1/quote-answer" && last().body.invoice === true && last().body.confirm === undefined && last().body.lines[0].price === 1500.5);
  r = await call("shop_order_status_set", { orderId: "o1", status: "weird", confirm: true });
  check("status_set: неизвестный статус отклонён", r.result.isError);
  r = await call("shop_order_status_set", { orderId: "o1", status: "paid", confirm: true });
  check("status_set: 409 сервера - ошибка", r.result.isError && /409/.test(text(r)));
  r = await call("shop_order_status_set", { orderId: "../x", status: "shipped", confirm: true });
  check("orderId с path traversal отклонён", r.result.isError);
  await call("shop_invoice_mark_paid", { orderId: "o1", confirm: true });
  check("mark_paid: POST", last().m === "POST" && last().u.endsWith("/orders/o1/mark-paid"));
  await call("shop_invoice_issue", { orderId: "o1", company: { name: "A", inn: "7710140679" }, confirm: true });
  check("invoice_issue: POST с company", last().u.endsWith("/orders/o1/invoice") && last().body.company.inn === "7710140679");

  r = await call("shop_invoice_pdf", { orderId: "o1" });
  const pdf = JSON.parse(text(r));
  check("invoice_pdf: base64, имя из заголовка", Buffer.from(pdf.base64, "base64").equals(PDF) && pdf.fileName === "schet-3.pdf");
  const out = join(home, "x", "inv.pdf");
  r = await call("shop_invoice_pdf", { orderId: "o1", savePath: out });
  check("invoice_pdf: savePath", fs.readFileSync(out).equals(PDF) && !text(r).includes("base64"));
  r = await call("shop_quote_file_get", { orderId: "o1" });
  check("quote_file: больше 2 МБ без savePath - ошибка", r.result.isError && /savePath/.test(text(r)));
  r = await call("shop_quote_file_get", { orderId: "o1", savePath: join(home, "big.pdf") });
  check("quote_file: большой файл в savePath", fs.statSync(join(home, "big.pdf")).size === BIG.length);

  r = await call("shop_order_document_upload", { orderId: "o1", contentBase64: PDF.toString("base64"), fileName: "x.pdf", kind: "contract", confirm: true });
  check("document_upload: multipart file+kind", last().ct.startsWith("multipart/form-data") && last().raw.includes("name=\"file\"") && last().raw.includes("filename=\"x.pdf\"") && last().raw.includes("contract"));
  r = await call("shop_order_document_upload", { orderId: "o1", contentBase64: "AAAA", fileName: "x.exe", confirm: true });
  check("document_upload: расширение вне списка", r.result.isError);
  await call("shop_order_document_delete", { orderId: "o1", docId: "d1", confirm: true });
  check("document_delete: DELETE", last().m === "DELETE" && last().u.endsWith("/orders/o1/documents/d1"));

  r = await call("shop_seller_get", {});
  check("seller_get: счета замаскированы", !text(r).includes("40702810123456789012") && text(r).includes("****9012") && text(r).includes("7707083893"));
  r = await call("shop_buyer_groups_get", {});
  check("buyer_groups_get: joinCode не отдаётся", !text(r).includes("super-secret-code") && JSON.parse(text(r)).groups[0].joinCodeSet === true && JSON.parse(text(r)).groups[1].joinCodeSet === false);
  r = await call("shop_buyer_group_upsert", { code: "opt", generateJoinCode: true, discountPct: 15, confirm: true });
  check("group_upsert: сгенерированный код не отдаётся", !text(r).includes("abcdef0123456789") && last().body.generateJoinCode === true);
  r = await call("shop_buyer_group_upsert", { code: "BAD code", confirm: true });
  check("group_upsert: плохой code", r.result.isError);
  await call("shop_buyer_group_delete", { code: "opt", confirm: true });
  check("group_delete: DELETE", last().m === "DELETE" && last().u.endsWith("/buyer-groups/opt"));
  await call("shop_buyer_group_assign", { chatId: 123, confirm: true });
  check("group_assign: пустой groupCode снимает", last().body.chatId === 123 && last().body.groupCode === "");
  await call("shop_delivery_settings_update", { cutoffTime: "16:00", zones: [{ id: "msk", name: "Москва", type: "courier", price: 300 }], confirm: true });
  check("delivery_update: PUT", last().m === "PUT" && last().u.endsWith("/delivery-config") && last().body.zones.length === 1 && last().body.confirm === undefined);
  await call("shop_seller_requisites_update", { name: "ООО", vatMode: "vat20", confirm: true });
  check("seller_update: PUT патч", last().m === "PUT" && last().u.endsWith("/seller") && last().body.vatMode === "vat20" && last().body.inn === undefined);
  await call("shop_item_b2b_update", { itemId: "i1", priceTiers: [{ minQty: 10, price: 90 }], oversize: true, confirm: true });
  check("item_b2b: PUT /items/i1/b2b", last().m === "PUT" && last().u.endsWith("/items/i1/b2b") && last().body.oversize === true);
  await call("shop_b2b_settings_update", { quoteValidDays: 5, clearAutoStatus: true, confirm: true });
  check("b2b_settings: PUT", last().m === "PUT" && last().u.endsWith("/b2b-settings") && last().body.quoteValidDays === 5);
  await call("shop_seller_requisites_update", { accountant: "Петрова", quotePaymentTerms: "50% аванс", quoteLeadTime: "5 дней", confirm: true });
  check("seller_update: accountant/quotePaymentTerms/quoteLeadTime", last().body.accountant === "Петрова" && last().body.quotePaymentTerms === "50% аванс" && last().body.quoteLeadTime === "5 дней");
  r = await call("shop_seller_checklist", {});
  check("seller_checklist: GET /seller/checklist без confirm", last().m === "GET" && last().u === "/api/bots/commerce/seller/checklist" && !r.result.isError);
  await call("shop_item_b2b_update", { itemId: "i1", unit: "кг", confirm: true });
  check("item_b2b: unit", last().body.unit === "кг");
  await call("shop_b2b_settings_update", { invoiceReminderEnabled: true, invoiceReminderDays: 7, confirm: true });
  check("b2b_settings: invoiceReminder полей", last().body.invoiceReminderEnabled === true && last().body.invoiceReminderDays === 7);
  const nReminder = seen.length;
  r = await call("shop_b2b_settings_update", { invoiceReminderDays: 31, confirm: true });
  check("b2b_settings: invoiceReminderDays 31 отклонён, сервер не вызван", r.result.isError && seen.length === nReminder);
  r = await call("shop_b2b_settings_update", { invoiceReminderEnabled: "yes", confirm: true });
  check("b2b_settings: invoiceReminderEnabled не boolean отклонён", r.result.isError && seen.length === nReminder);
  await call("shop_b2b_settings_get", {});
  check("b2b_settings_get: GET", last().m === "GET" && last().u.endsWith("/b2b-settings"));

  await call("shop_leads_list", { type: "wholesale", status: "NEW", size: 20 });
  check("leads_list: GET с query", last().m === "GET" && last().u === "/api/bots/commerce/leads?type=wholesale&status=NEW&size=20");
  r = await call("shop_lead_to_order", { leadId: "L1", leadTime: "5 дней" });
  check("lead_to_order без confirm отклонён", r.result.isError);
  await call("shop_lead_to_order", { leadId: "L1", leadTime: "5 дней", note: "n", confirm: true });
  check("lead_to_order: POST", last().m === "POST" && last().u.endsWith("/leads/L1/to-order") && last().body.leadTime === "5 дней" && last().body.confirm === undefined);
  r = await call("shop_wholesale_approve", { leadId: "L1", tag: "", confirm: true });
  check("wholesale_approve: пустой tag отклонён", r.result.isError);
  await call("shop_wholesale_approve", { leadId: "L1", tag: "opt", confirm: true });
  check("wholesale_approve: POST tag", last().u.endsWith("/leads/L1/approve-wholesale") && last().body.tag === "opt");
  r = await call("shop_quote_pdf", { orderId: "o1" });
  check("quote_pdf: base64", Buffer.from(JSON.parse(text(r)).base64, "base64").equals(PDF) && last().u.endsWith("/orders/o1/quote.pdf"));
  await call("shop_item_b2b_update", { itemId: "i1", minQty: 10, qtyStep: 5, confirm: true });
  check("item_b2b: minQty/qtyStep", last().body.minQty === 10 && last().body.qtyStep === 5);
  await call("shop_b2b_settings_update", { minOrderSum: 5000, confirm: true });
  check("b2b_settings: minOrderSum", last().body.minOrderSum === 5000);
} finally {
  clearTimeout(timer);
  child.kill(); srv.close();
}
console.log(failed ? `\n${failed} FAILED` : "\nshop-b2b: все проверки зелёные");
process.exit(failed ? 1 : 0);
