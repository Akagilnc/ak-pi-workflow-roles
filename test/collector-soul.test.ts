import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const soul = await readFile(resolve(root, "souls/collector.md"), "utf8");

test("Collector Soul contains only irreducible collection judgment law", () => {
  assert.match(soul, /证据收集|evidence collector|收集/i);
  assert.match(soul, /非权威|data/i);
  assert.match(soul, /pending|terminal/i);
  assert.match(soul, /HEAD|目标/);
  assert.match(soul, /先前|prior|历史/i);
  assert.match(soul, /不确定|uncertainty|不编造/i);
});

test("Collector Soul excludes CLI, schema, tools, timers, Flow, and Skill mechanics", () => {
  assert.doesNotMatch(soul, /ak_collector_|--ak-collector|gh api|pagination/i);
  assert.doesNotMatch(soul, /15.?minute|900000|8 MiB|32 MiB|manifestDigest/i);
  assert.doesNotMatch(soul, /Flow|orchestrator|onlineCollect|ReviewCargo/i);
  assert.doesNotMatch(soul, /SKILL\.md|code-review|tdd|process\.exit/i);
  assert.doesNotMatch(soul, /refused|approve|merge|landing/i);
});
