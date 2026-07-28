import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const soul = await readFile(resolve(root, "souls/judge.md"), "utf8");

test("Judge Soul infers burden from materials only and names four postures", () => {
  assert.match(soul, /仅从本次提交的材料|materials only|from (the )?supplied materials/i);
  assert.match(soul, /Authority|authority|契约完备/);
  assert.match(soul, /Plan|计划|开工就绪/);
  assert.match(soul, /Apply|可执行证明/);
  assert.match(soul, /Review|发现裁定|评审/);
});

test("Judge Soul states authority completeness burden without Apply proof demand", () => {
  assert.match(soul, /公共契约|角色边界|状态|时间|证据|信任|接缝|不可逆/i);
  assert.match(soul, /不要求|不必|不等[于於].*Apply|does not require/i);
  assert.match(soul, /可执行证明|executable proof|Apply/i);
});

test("Judge Soul states plan readiness five facts and construction-only converged", () => {
  assert.match(soul, /Behavior/);
  assert.match(soul, /Owner/);
  assert.match(soul, /Red/);
  assert.match(soul, /Green/);
  assert.match(soul, /Scope/);
  assert.match(soul, /授权开工|safe enough to construct|只授权开工|construction/i);
  assert.match(soul, /不证明.*施工|证据已存在|implementation evidence/i);
});

test("Judge Soul separates plan blockers from apply-decidable local mechanics", () => {
  assert.match(soul, /平行机制|forbidden|范围扩张|不可行|oracle/i);
  assert.match(
    soul,
    /不是.*计划阻断|not plan blocker|Apply 义务|apply obligation|局部机制|实现细节/i,
  );
  assert.match(soul, /计划散文|plan (prose|rewrite)|不得为此要求/i);
});

test("Judge Soul states complete-first, late-finding, and authority freeze without retry ceilings", () => {
  assert.match(soul, /首次|first/i);
  assert.match(soul, /枚举|enumerate|全部/i);
  assert.match(soul, /新矛盾|new (contradiction|evidence)|晚发现|late/i);
  assert.match(soul, /冻结|freeze|静默|silent/i);
  assert.doesNotMatch(soul, /最多\s*\d+\s*轮|retry\s*cap|max(?:imum)?\s*retries/i);
});

test("Judge Soul keeps Apply production-evidence strict and Review adjudicative", () => {
  assert.match(soul, /真实.*红绿|red\/green|生产接缝|production/i);
  assert.match(soul, /平行机制|test-only|生产钩子/i);
  assert.match(soul, /不得要求.*改码|不.*Reviewer.*修|routing|路由/i);
});

test("Judge Soul retains evidence, repair triad, surface audit, deadlock escalate", () => {
  assert.match(soul, /当前\s*head|current\s+head/i);
  assert.match(soul, /删.*简化|删除.*简化/);
  assert.match(soul, /三问/);
  assert.match(soul, /卡死.*上抛|上抛/);
  assert.match(soul, /修复面|波及面/);
});

test("Judge Soul keeps three material-relative judgment labels without field catalogs", () => {
  assert.match(soul, /`converged`/);
  assert.match(soul, /`continue`/);
  assert.match(soul, /`escalate`/);
  assert.match(soul, /举证责任|material/i);
  assert.match(soul, /只表示\s*允许开工|construction|授权开工/i);
  assert.match(soul, /可施工|actionable|修理正文/i);
  assert.match(soul, /owner|owner 决定|门槛/i);
});

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
