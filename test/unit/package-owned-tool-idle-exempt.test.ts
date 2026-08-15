/**
 * #339 — inventory + wrap seam for audit-type terminating tools with inner
 * ADR 0059 compliance stream-idle owner. Outer package-owned 183s must not stack.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS,
  PACKAGE_OWNED_TOOLS_WITH_COMPLIANCE_STREAM_IDLE_OWNER,
  PackageOwnedToolIdleTimeoutError,
  hasComplianceStreamIdleOwner,
  wrapPackageOwnedToolDefinition,
} from "../../src/package-owned-tool-idle.ts";
import { TERMINATING_TOOL_NAMES } from "../../src/package-contracts/terminating-tools.ts";
import {
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
} from "../../src/evidence-child-executor.ts";
import {
  StreamIdleTimeoutError,
  isStreamIdleTimeoutError,
} from "../../src/stream-idle-guard.ts";
import { flushEventLoopTurns } from "../helpers/pi-test-harness.ts";

/**
 * #339 construction step 1 — full scan of package-owned terminating submission tools.
 * Inner idle owner means execute awaits compliance via executeAuditorChild(idleRetry:true)
 * (judge/reviewer/doctor auditors → runComplianceAudit → ADR 0059 stream-idle).
 *
 * | tool                 | file              | inner owner |
 * |----------------------|-------------------|-------------|
 * | ak_coder_output      | worker-role.ts    | no          |
 * | ak_fixer_output      | worker-role.ts    | no          |
 * | ak_reviewer_output   | reviewer-role.ts  | yes         |
 * | ak_judge_output      | judge-role.ts     | yes         |
 * | ak_collector_output  | collector-role.ts | no          |
 * | ak_doctor_output     | doctor-role.ts    | yes         |
 * | ak_merger_output     | merger-role.ts    | no          |
 */
const TERMINATING_SUBMISSION_INNER_IDLE_OWNER: Readonly<
  Record<(typeof TERMINATING_TOOL_NAMES)[number], boolean>
> = {
  ak_coder_output: false,
  ak_fixer_output: false,
  ak_reviewer_output: true,
  ak_judge_output: true,
  ak_collector_output: false,
  ak_doctor_output: true,
  ak_merger_output: false,
};

test("#339 inventory: exempt set equals terminating tools with compliance stream-idle owner", () => {
  const expected = TERMINATING_TOOL_NAMES.filter(
    (name) => TERMINATING_SUBMISSION_INNER_IDLE_OWNER[name],
  );
  assert.deepEqual(
    [...PACKAGE_OWNED_TOOLS_WITH_COMPLIANCE_STREAM_IDLE_OWNER].sort(),
    [...expected].sort(),
  );
  for (const name of TERMINATING_TOOL_NAMES) {
    assert.equal(
      hasComplianceStreamIdleOwner(name),
      TERMINATING_SUBMISSION_INNER_IDLE_OWNER[name],
      name,
    );
  }
  // Ordinary non-terminating package tools remain under the outer gate.
  assert.equal(hasComplianceStreamIdleOwner("ak_package_owned_idle"), false);
  assert.equal(hasComplianceStreamIdleOwner("ak_soul_audit_decision"), false);
});

test(
  "wrap skips outer 183s gate for tools with inner compliance stream-idle owner",
  { timeout: 15_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS, 183_000);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executeCount = 0;
    const tool = wrapPackageOwnedToolDefinition({
      name: "ak_judge_output",
      async execute() {
        executeCount += 1;
        await gate;
        return { content: [{ type: "text" as const, text: "ok" }], details: { judgeStatus: "converged" } };
      },
    });

    const pending = tool.execute();
    let settled: "resolve" | "reject" | undefined;
    let failure: unknown;
    void pending.then(
      () => {
        settled = "resolve";
      },
      (error: unknown) => {
        settled = "reject";
        failure = error;
      },
    );

    await flushEventLoopTurns();
    assert.equal(executeCount, 1);

    t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
    await flushEventLoopTurns(30);
    assert.equal(settled, undefined, "outer package-owned idle must not settle exempt execute");
    assert.equal(failure, undefined);
    assert.equal(executeCount, 1, "no second execute / re-audit from outer gate");

    release();
    await pending;
    assert.equal(settled, "resolve");
    assert.equal(failure, undefined);
  },
);

test(
  "wrap still arms outer 183s gate for ordinary package-owned tools without inner owner",
  { timeout: 15_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const tool = wrapPackageOwnedToolDefinition({
      name: "ak_ordinary_package_tool",
      async execute() {
        await new Promise<never>(() => {});
      },
    });

    const pending = tool.execute();
    let failureName: string | undefined;
    void pending.then(
      () => {},
      (error: unknown) => {
        failureName = error instanceof Error ? error.name : undefined;
      },
    );

    await flushEventLoopTurns();
    t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS - 1);
    await flushEventLoopTurns();
    assert.equal(failureName, undefined);

    t.mock.timers.tick(1);
    await flushEventLoopTurns(20);
    assert.equal(failureName, "PackageOwnedToolIdleTimeoutError");
    await assert.rejects(pending, (error: unknown) => {
      assert.equal(error instanceof Error ? error.name : undefined, "PackageOwnedToolIdleTimeoutError");
      return true;
    });
  },
);

test("inner StreamIdleTimeoutError identity stays distinct; compliance idle retries remain finite", () => {
  // Guardrail: #339 must not invent a second retry layer or collapse error identity.
  assert.equal(DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES, 2);
  const inner = new StreamIdleTimeoutError(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
  const outer = new PackageOwnedToolIdleTimeoutError();
  assert.equal(isStreamIdleTimeoutError(inner), true);
  assert.equal(isStreamIdleTimeoutError(outer), false);
  assert.notEqual(inner.name, outer.name);
});
