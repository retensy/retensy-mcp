#!/usr/bin/env node
// Smoke-тест MCP-сервера: запускает src/index.mjs, шлёт initialize + tools/list
// по stdio и проверяет ответы. Выход 0 — ок, 1 — провал. Используется в CI.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [join(root, "src", "index.mjs")], {
  env: { ...process.env, RETENSY_MCP_TOKEN: "zmcp_smoke" },
  stdio: ["pipe", "pipe", "inherit"],
});

const got = {};
const timer = setTimeout(() => fail("timeout (нет ответов за 8с)"), 8000);

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m && m.id != null) got[m.id] = m;
  if (got[1] && got[2]) finish();
});

function finish() {
  clearTimeout(timer);
  const init = got[1];
  const tl = got[2];
  const tools = tl?.result?.tools;
  const toolNames = Array.isArray(tools) ? tools.map((t) => t.name) : [];
  const ok =
    init?.result?.serverInfo?.name === "retensy-mcp" &&
    Array.isArray(tools) &&
    tools.length === 100 &&
    new Set(toolNames).size === toolNames.length &&
    toolNames.includes("list_channels") &&
    toolNames.includes("list_integrations") &&
    toolNames.includes("edit_graph_live") &&
    toolNames.includes("copy_graph") &&
    toolNames.includes("patch_graph") &&
    toolNames.includes("upload_file") &&
    toolNames.includes("article_publish") &&
    toolNames.includes("article_update") &&
    toolNames.includes("article_list") &&
    toolNames.includes("article_get") &&
    ["site_list", "site_create", "site_get", "site_schema", "site_edit", "site_publish", "site_upload_asset", "site_leads", "site_rollback", "site_domains", "site_lead_settings", "site_templates",
      "create_bot", "bot_stop", "bot_resume", "connect_integration", "disconnect_integration",
      "integration_catalog", "integration_status", "integration_test", "channel_post",
      "broadcast_list", "broadcast_get", "broadcast_preview", "broadcast_send", "broadcast_cancel",
      "broadcast_recurring", "broadcast_drafts", "broadcast_duplicate",
      "agent_list", "agent_get", "agent_create", "agent_update", "agent_publish", "agent_health",
      "agent_test_chat", "kb_docs", "kb_add_qa", "kb_add_text", "kb_add_site", "kb_reindex", "agent_unanswered"]
      .every((n) => toolNames.includes(n));
  child.kill();
  if (!ok) {
    console.error("SMOKE FAIL:", JSON.stringify({ init, tl }, null, 2));
    process.exit(1);
  }
  console.log(`smoke OK: initialize=${init.result.serverInfo.name} v${init.result.serverInfo.version}, tools=${tools.length}, list_channels=${toolNames.includes("list_channels")}`);
  process.exit(0);
}

function fail(reason) {
  console.error("SMOKE FAIL:", reason);
  child.kill();
  process.exit(1);
}

child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
