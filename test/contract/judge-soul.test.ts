import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const soul = await readFile(resolve(root, "souls/judge.md"), "utf8");

test("Judge Soul excludes process, schema, transport, platform, and issue carriers", () => {
  for (const forbidden of [
    /Ming/i,
    /容器/,
    /stationReceiptContracts/,
    /--ak-judge/i,
    /next-?role/i,
    /workflow\s*DSL/i,
    /packets\//i,
    /judge-plan\.md|judge-apply\.md|judge-authority\.md/i,
    /ADR\s*\d+/i,
    /#\s*[123]\b/,
    /retry\s*ceiling|最多\s*\d+\s*次重试/,
    /orchestrat/i,
    /fauxProvider|expected\.json|session\.jsonl/i,
    /exact fake array|helper call syntax/i,
    /helper\/函数\/文件名/,
    /fake\s*数组/,
    /夹具字面量/,
    /库调用语法/,
    /表驱动/,
    /分立测试/,
    /字节边界/,
    /确切\s*helper/i,
    /确切\s*fake/i,
    // Trimmed non-Soul carriers
    /\bnote\b/i,
    /非零|non-?zero/i,
    /Action\s*失败|exit\s*code|以非零状态退出/i,
    /基础设施/,
    /旗标|call[- ]history|拓扑|topology/i,
    /\bPi\b|包接缝/,
    /commit\/diff|字节\/时间|fixture|夹具精度|红绿测试/,
    /judgeStatus|decisionGate|fix\.summary/,
  ]) {
    assert.doesNotMatch(soul, forbidden);
  }
});
