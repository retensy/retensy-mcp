#!/usr/bin/env node
/**
 * Оффлайн-валидатор знает действие call_scenario («Перейти в другой сценарий»), зеркало
 * GraphValidator.validateScenarioCalls: цель задана, не сам сценарий, только mode=goto, последнее в блоке,
 * ключи variables[] — идентификаторы. Выход 0 — ок, 1 — провал.
 */

import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(join(os.tmpdir(), "retensy-mcp-cs-"));
let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "  ok " : "  FAIL"} ${name}`); if (!cond) failed++; };

function run(actions, id) {
  const trig = { id: randomUUID(), type: "TRIGGER_COMMAND", position: { x: 0, y: 0 }, config: { command: "/start" } };
  const acts = { id: randomUUID(), type: "ACTIONS", position: { x: 0, y: 0 }, config: { actions } };
  const file = join(dir, `${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ format: "retensy-bot-graph", version: 1, name: "t", ...(id ? { id } : {}),
    nodes: [trig, acts], edges: [{ id: randomUUID(), sourceNodeId: trig.id, sourceHandle: "next", targetNodeId: acts.id }],
    canvasMeta: {} }));
  const r = spawnSync(process.execPath, [join(root, "skills", "build-bot-funnel", "validate.mjs"), file], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const target = randomUUID();
const good = run([{ kind: "add_tag", tag: "x" }, { kind: "call_scenario", graphId: target, variables: [{ key: "plan", value: "{{var.p}}" }] }]);
check("корректный переход — exit 0 без ACTION_UNKNOWN_KIND и без предупреждения о kind", good.code === 0
  && !/ACTION_UNKNOWN_KIND/.test(good.out) && !/call_scenario.*не из встроенного списка/.test(good.out));

const cases = [
  ["CALL_SCENARIO_NO_TARGET", run([{ kind: "call_scenario" }])],
  ["CALL_SCENARIO_NOT_LAST", run([{ kind: "call_scenario", graphId: target }, { kind: "add_tag", tag: "x" }])],
  ["CALL_SCENARIO_BAD_MODE", run([{ kind: "call_scenario", graphId: target, mode: "call" }])],
  ["ACTION_BAD_KEY", run([{ kind: "call_scenario", graphId: target, variables: [{ key: "Bad Key", value: "1" }] }])],
  ["CALL_SCENARIO_SELF", run([{ kind: "call_scenario", graphId: target }], target)],
];
for (const [code, r] of cases) check(`${code} — exit 1 и код в выводе`, r.code === 1 && r.out.includes(code));

fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`call-scenario: провалов ${failed}`); process.exit(1); }
console.log("call-scenario OK");
