import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const soulUrl = new URL("../souls/judge.md", import.meta.url);

test("judge soul contains the generic adjudication kernel", async () => {
  const soul = await readFile(soulUrl, "utf8");

  for (const required of [
    /当前\s*head|current\s+head/i,
    /删.*简化|删除.*简化/,
    /三问/,
    /行为.*边界.*失败路径/s,
    /每条.*记录|逐条.*处置/,
    /安静.*降级|沉默.*降级/,
    /`converged`/,
    /`continue`/,
    /`escalate`/,
    /基础设施.*判词|工具链.*判词/,
    /卡死.*上抛/,
    /修复面审计/,
  ]) {
    assert.match(soul, required);
  }
});

test("judge soul excludes host institutions and numbering", async () => {
  const soul = await readFile(soulUrl, "utf8");

  for (const forbidden of [
    /Ming/i,
    /容器/,
    /family/i,
    /stationReceiptContracts/,
    /verify/i,
    /runner/i,
    /OPEN/,
    /blocked_by/,
    /台账/,
    /ledger/i,
    /ADR\s*\d+/i,
    /#\d+/,
  ]) {
    assert.doesNotMatch(soul, forbidden);
  }
});
