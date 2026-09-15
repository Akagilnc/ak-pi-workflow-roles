// #178: prepare consumers that relied on package navigator default were culled.
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  navigatorProviderFailureFromError,
  parseNavigatorModelSetting,
  navigatorProviderFailureFromPublicTerminal,
} from "../../src/navigator-attendance.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { buildNavigatorInfrastructureFailureFact, publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import {
  candidate,
  sessionHarness,
  attendance,
} from "../helpers/navigator-attendance-kit.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("unchanged routes are omitted after a native-session route entry, while changed settings are reread", async () => {
  await withTempRoot("navigator-route-", async (root) => {
    // Hermetic HOME seat table is the sole model authority (#675).
    const priorHome = process.env.HOME;
    process.env.HOME = root;
    const { savePublicCliConfig } = await import("../../src/public-cli/config.ts");
    try {
      await savePublicCliConfig(
        { seats: { navigator: { provider: "provider", model: "one" } } },
        root,
      );
      const setting = join(root, "model.json");
      await writeFile(setting, JSON.stringify({ model: "ignored/legacy" }));
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events);
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      await harness.tool().execute("prepare-1", candidate(), undefined, undefined, {} as never);
      harness.release();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.ok(events[0].route);
      await savePublicCliConfig(
        { seats: { navigator: { provider: "provider", model: "two" } } },
        root,
      );
      nav.prepare();
      while (harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
      await harness.tool().execute("prepare-2", candidate(), undefined, undefined, {} as never);
      harness.release();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.equal(events[1].route, undefined);
      assert.equal(harness.prompts(), 2);
      await savePublicCliConfig(
        { seats: { navigator: { provider: "provider", model: "three" } } },
        root,
      );
      nav.prepare();
      while (harness.prompts() < 3) await new Promise<void>((resolve) => setImmediate(resolve));
      const original = candidate().candidates[0]!;
      const revised = { candidates: [{ id: original.id, matches: original.matches, reason: original.reason, route: [{ role: "coder" as const, phase: "apply" as const }, { role: "fixer" as const, phase: "apply" as const }, { role: "judge" as const, phase: null }], next: { role: "fixer" as const, phase: "apply" as const } }] };
      await harness.tool().execute("prepare-3", revised, undefined, undefined, {} as never);
      harness.release();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.deepEqual(events[2].route, revised.candidates[0]!.route);
      // #675 ⑥: bare provider/model has no invented thinking default.
      assert.deepEqual(harness.modelSettings, [
        { model: "provider/one" },
        { model: "provider/two" },
        { model: "provider/three" },
      ]);
      assert.ok(harness.entries.some((entry: any) => entry.customType === "ak-navigator-route"));
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
});

test("Navigator accepts only the audit-owned in-memory projection across all four seats", () => {
  const seats = [
    { role: "judge", phase: null, toolName: JUDGE_OUTPUT_TOOL_NAME },
    { role: "fixer", phase: "apply", toolName: FIXER_OUTPUT_TOOL_NAME },
    { role: "reviewer", phase: null, toolName: REVIEWER_OUTPUT_TOOL_NAME },
    { role: "doctor", phase: null, toolName: DOCTOR_OUTPUT_TOOL_NAME },
  ] as const;
  for (const seat of seats) {
    const projected = buildAuditEscalationResult({
      status: "escalate",
      conflicts: [`${seat.role} conflict`],
      decisionGate: { question: `${seat.role} question`, options: ["owner", "audit"] } }, { [seat.role]: "role output" });
    assert.deepEqual(
      publicNavigatorSettlement(seat.role, seat.phase, {
        toolName: seat.toolName,
        isError: false,
        details: projected }),
      { kind: "human_decision", role: seat.role, phase: seat.phase, status: "audit_escalation" },
      seat.role,
    );
    // The same visible shape, including every audit-owned field/value, is
    // still only role-authored data after the object identity is copied.
    assert.notEqual(
      publicNavigatorSettlement(seat.role, seat.phase, {
        toolName: seat.toolName,
        isError: false,
        details: { ...projected } })?.kind,
      "human_decision",
      `${seat.role}: copied role-shaped details must not escalate Navigator`,
    );
    const auditConflicts = Array.isArray((projected.audit as { conflicts?: unknown } | undefined)?.conflicts)
      ? [...((projected.audit as { conflicts: readonly unknown[] }).conflicts)]
      : Array.isArray(projected.conflicts)
        ? [...(projected.conflicts as readonly unknown[])]
        : [];
    for (const forged of [
      { ...projected, status: "pass" },
      { ...projected, kind: "audit_escalation", auditDecisionGate: undefined },
      { ...projected, conflicts: ["wrong"] },
      { ...projected, conflicts: [...auditConflicts, "duplicate"] },
      { ...projected, conflicts: [...auditConflicts].reverse() },
    ]) {
      assert.notEqual(
        publicNavigatorSettlement(seat.role, seat.phase, {
          toolName: seat.toolName,
          isError: false,
          details: { ...forged } })?.kind,
        "human_decision",
        `${seat.role}: forged audit evidence must not escalate Navigator`,
      );
    }
  }
});

test("navigator open failures classify typed reason/status/code, not Error.message prose", () => {
  assert.equal(navigatorProviderFailureFromError(new Error("authentication failed")), undefined);
  assert.equal(navigatorProviderFailureFromError(new Error("provider not found: missing")), undefined);
  assert.deepEqual(
    navigatorProviderFailureFromError(Object.assign(new Error("opaque"), { reason: "auth" })),
    { source: "auth", cause: "auth" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromError(Object.assign(new Error("opaque"), { reason: "model" })),
    { source: "model", cause: "model" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromError(Object.assign(new Error("opaque"), { statusCode: 401 })),
    { source: "auth", cause: "auth" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromError({ cause: Object.assign(new Error("nested"), { reason: "quota" }) }),
    { source: "quota", cause: "quota" },
  );
});

test("untyped public navigator failure keeps unknown cause instead of relabeling session", () => {
  assert.deepEqual(
    navigatorProviderFailureFromPublicTerminal({
      diagnostic: "opaque provider wording",
      decisiveFacts: { diagnostic: "opaque provider wording" },
    }),
    { source: "unknown", cause: "unknown" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromPublicTerminal({
      cause: "session",
      diagnostic: "session unreadable",
      decisiveFacts: {},
    }),
    { source: "session", cause: "session" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromPublicTerminal({
      cause: "provider",
      diagnostic: "provider failure",
      decisiveFacts: { httpStatus: 401 },
    }),
    { source: "auth", cause: "auth" },
  );
  // cause=provider alone does not confirm a transport subclass — cause stays unknown.
  assert.deepEqual(
    navigatorProviderFailureFromPublicTerminal({
      cause: "provider",
      diagnostic: "provider failure",
      decisiveFacts: {},
    }),
    { source: "transport", cause: "unknown" },
  );
});

test("model settings are exact and typed settlement projection ignores prose and correctable errors", () => {
  assert.deepEqual(parseNavigatorModelSetting("openai-codex/gpt-5.6-luna:max"), { provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "max" });
  assert.deepEqual(parseNavigatorModelSetting("provider/model:medium"), { provider: "provider", model: "model", thinkingLevel: "medium" });
  assert.deepEqual(parseNavigatorModelSetting("provider/model:xhigh"), { provider: "provider", model: "model", thinkingLevel: "xhigh" });
  // Bare provider/model omits thinkingLevel — no invented default.
  assert.deepEqual(parseNavigatorModelSetting("provider/model"), { provider: "provider", model: "model" });
  // Suffix is opaque pass-through; no whitelist reject (#683 / #675 ⑥).
  assert.deepEqual(parseNavigatorModelSetting("provider/model:backup"), { provider: "provider", model: "model", thinkingLevel: "backup" });
  assert.equal(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: { message: "correctable schema wording" } }), undefined);
  assert.deepEqual(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: buildNavigatorInfrastructureFailureFact() }), { kind: "role_infrastructure_failure", role: "coder", phase: "apply" });
  assert.equal(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: { terminal: "infrastructure_failure", message: "network wording" } }), undefined);
  assert.deepEqual(publicNavigatorSettlement("judge", null, { toolName: "ak_judge_output", isError: false, details: { judgeStatus: "escalate", report: "any wording" } }), { kind: "human_decision", role: "judge", phase: null, status: "escalate" });
  assert.deepEqual(publicNavigatorSettlement("countersign", null, { toolName: "ak_countersign_output", isError: false, details: { countersignStatus: "escalate" } }), { kind: "human_decision", role: "countersign", phase: null, status: "escalate" });
  assert.notEqual(publicNavigatorSettlement("fixer", "apply", { toolName: "ak_fixer_output", isError: false, details: { kind: "audit_escalation", conflicts: ["authority"], auditDecisionGate: { question: "Which?", options: ["owner"] } } })?.kind, "human_decision");
  // selectNavigatorCandidate status membership is owned by the status-specific outrank table.
});
