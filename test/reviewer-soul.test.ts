import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const soul = await readFile(resolve(root, "souls/reviewer.md"), "utf8");

test("Reviewer Soul contains only the irreducible review judgment kernel", () => {
  assert.match(soul, /authority/);
  assert.match(soul, /固定/);
  assert.match(soul, /可追溯|可核验/);
  assert.match(soul, /scratch|临时工作区/);
  assert.match(soul, /不负责修复、发布、路由或最终裁决/);
});

test("Reviewer Soul does not copy schema, runtime, or canonical Skill mechanics", () => {
  assert.doesNotMatch(soul, /Agent|ak_reviewer_output|completed|refused/);
  assert.doesNotMatch(soul, /Standards|Spec|three-dot|git diff|smell|400 words/i);
  assert.doesNotMatch(soul, /provider|authentication|clone|parallel|executionMode/i);
});
