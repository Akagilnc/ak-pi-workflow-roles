import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_CALLABLE_ROLES,
  PUBLIC_CLI_SUPPORT_COMMANDS,
  PUBLIC_CONFIGURABLE_SEATS,
  listHelpCapabilities,
} from "../../src/public-cli/registry.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";

/**
 * External metadata oracle — all public roles, every field, roster order (#524 验收 1 / #572 countersign).
 * Baseline string literals only: do not import production contract constants, or
 * constant drift would move expected and actual together and hide the failure.
 */
const EXPECTED_PACKAGED_ROLE_METADATA = [
  {
    role: "judge",
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "instruction",
    sameParent: "none",
    phases: [null],
    outputTool: "ak_judge_output",
    settlement: "sealed",
    runnerFailure: "engine-detour-known-first",
    acceptedText: "大理寺回执已接受",
    activationStage: "load-and-install",
    receiptStatusKey: "judgeStatus",
  },
  {
    role: "fixer",
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "fixer",
    sameParent: "none",
    worker: true,
    methodSkills: ["diagnosing-bugs", "tdd"],
    settleMethod: "diagnosing-bugs",
    phases: ["plan", "apply"],
    outputTool: "ak_fixer_output",
    settlement: "sealed",
    acceptedText: "修内司回执已接受",
    activationFlags: [
      { field: "packetPath", flag: "ak-fix-packet", binds: "input" },
      { field: "phase", flag: "ak-fixer-phase", binds: "phase" },
      { field: "prerequisitesPath", flag: "ak-fixer-prerequisites" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "coder",
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "coder",
    sameParent: "none",
    worker: true,
    applyMethod: "tdd",
    phases: ["plan", "apply"],
    outputTool: "ak_coder_output",
    settlement: "sealed",
    acceptedText: "将作监回执已接受",
    activationFlags: [
      { field: "taskPath", flag: "ak-coder-task", binds: "input" },
      { field: "phase", flag: "ak-coder-phase", binds: "phase" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "reviewer",
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "reviewer",
    sameParent: "none",
    methodSkills: ["ak-cross-m-review"],
    settleMethod: "ak-cross-m-review",
    parallelLenses: true,
    freshExecutionCopy: true,
    phases: [null],
    bareCommand: false,
    outputTool: "ak_reviewer_output",
    settlement: "sealed",
    sealedAcceptedOnly: true,
    runnerFailure: "engine-detour-record-first",
    acceptedText: "御史台回执已接受",
    activationFlags: [
      { field: "baseRevision", flag: "ak-review-base" },
      { field: "lens", flag: "ak-review-lens" },
      { field: "authorityRefs", flag: "ak-review-authority-refs" },
      { field: "ticketNumber", flag: "ak-review-ticket-number" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "collector",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "collector",
    sameParent: "none",
    phases: [null],
    bareCommand: false,
    outputTool: "ak_collector_output",
    settlement: "residual",
    residualScan: "current-attempt",
    residualTool: "ak_collector_wait",
    runnerFailure: "collector-known-first",
    acceptedText: "通进司回执已接受",
    activationFlags: [
      { field: "repo", from: "repository.display", flag: "ak-collector-repo" },
      { field: "pr", from: "prNumber", text: true, flag: "ak-collector-pr" },
      { field: "requestManifestPath", flag: "ak-collector-request-manifest" },
      { field: "waitMs", from: "waitWindowMs", text: true, flag: "ak-collector-wait-ms" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "doctor",
    inCallAutoResume: false,
    presentSettled: "typed",
    summonResume: false,
    admission: "doctor",
    sameParent: "none",
    phases: [null],
    bareCommand: false,
    outputTool: "ak_doctor_output",
    settlement: "sealed",
    acceptedText: "太医署回执已接受",
    activationFlags: [
      { field: "casePath", from: "caseRunsPath", flag: "ak-doctor-case", binds: "input" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "merger",
    inCallAutoResume: true,
    presentSettled: "typed",
    summonResume: false,
    admission: "merger",
    sameParent: "none",
    methodSkills: ["resolving-merge-conflicts"],
    settleMethod: "resolving-merge-conflicts",
    phases: [null],
    outputTool: "ak_merger_output",
    settlement: "residual",
    residualScan: "session",
    residualTool: "ak_merger_output",
    acceptedText: "合并回执已接受",
    activationFlags: [
      { field: "inputPath", from: "mergerInputPath", flag: "ak-merger-input", binds: "input" },
    ],
    activationStage: "prepare-git-and-install",
    receiptCommitKey: "mergeCommitId",
    receiptCommitWhen: "completed",
  },
  {
    role: "notary",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "notary",
    sameParent: "notary",
    phases: [null],
    bareCommand: false,
    outputTool: "ak_notary_output",
    settlement: "accepted",
    acceptedText: "符宝郎回执已接受",
    activationFlags: [
      { field: "sourceRun", from: "sourceRunPath", flag: "ak-notary-source-run", binds: "input" },
      { field: "ticketNumber", flag: "ak-notary-ticket-number" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "countersign",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "countersign",
    sameParent: "none",
    phases: [null],
    outputTool: "ak_countersign_output",
    settlement: "accepted",
    acceptedText: "给事中回执已接受",
    activationFlags: [
      { field: "ticketNumber" },
    ],
    activationStage: "load-and-install",
    receiptStatusKey: "countersignStatus",
  },
  {
    role: "secretariat",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "instruction",
    sameParent: "secretariat",
    phases: [null],
    outputTool: "ak_secretariat_output",
    settlement: "accepted",
    projectCountersignTerminal: true,
    acceptedText: "中书省回执已接受",
    activationFlags: [
      { field: "ticketNumber" },
    ],
    activationStage: "load-and-install",
    receiptStatusKey: "secretariatStatus",
  },
  {
    role: "gleaner-left",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "gleaner",
    sameParent: "none",
    phases: [null],
    bareCommand: false,
    outputTool: "ak_gleaner_left_output",
    settlement: "accepted",
    acceptedText: "左拾遗回执已接受",
    activationFlags: [
      { field: "baseRevision", flag: "ak-gleaner-left-base" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "inspector",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "instruction",
    sameParent: "inspector",
    phases: [null],
    outputTool: "ak_inspector_output",
    settlement: "accepted",
    acceptedText: "台院回执已接受",
    activationFlags: [
      {
        field: "sourceRun",
        from: "sourceRunPath",
        fallback: "gate-pointer",
        flag: "ak-inspector-source-run",
        binds: "input",
      },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "gatekeeper",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: true,
    admission: "instruction",
    sameParent: "none",
    phases: [null],
    outputTool: "ak_gatekeeper_output",
    settlement: "accepted",
    runnerFailure: "engine-detour-record-first",
    acceptedText: "门下省决议已受理",
    activationStage: "load-and-install",
  },
  {
    role: "navigator",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: true,
    admission: "instruction",
    sameParent: "none",
    phases: [null],
    outputTool: "ak_navigator_output",
    settlement: "accepted",
    runnerFailure: "engine-detour-record-first",
    acceptedText: "游奕使建议已受理",
    activationStage: "load-and-install",
  },
  {
    role: "auditor",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: true,
    admission: "instruction",
    sameParent: "auditor",
    phases: [null],
    outputTool: "ak_auditor_output",
    settlement: "accepted",
    runnerFailure: "engine-detour-record-first",
    acceptedText: "审刑院回执已接受",
    activationStage: "load-and-install",
  },
  {
    role: "diarist",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "instruction",
    sameParent: "diarist",
    phases: [null],
    outputTool: "ak_diarist_output",
    settlement: "accepted",
    acceptedText: "起居郎回执已接受",
    activationStage: "load-and-install",
  },
] as const;

test("public registry exposes callable roles with no automatic/classifiable distinction", () => {
  // #524 验收 1 / #572: full metadata fields + order for all public roles (external oracle).
  // #639: automatic-only configurable seats are abolished — roles are roles.
  assert.deepEqual([...PACKAGED_ROLE_REGISTRY], [...EXPECTED_PACKAGED_ROLE_METADATA]);
  assert.deepEqual(
    [...PUBLIC_CALLABLE_ROLES],
    EXPECTED_PACKAGED_ROLE_METADATA.map((entry) => entry.role),
  );
  assert.equal(PUBLIC_CALLABLE_ROLES.length, EXPECTED_PACKAGED_ROLE_METADATA.length);
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("notary"), true);
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("countersign"), true);
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("gleaner-left"), true);
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("inspector"), true);
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("diarist"), true);
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("secretariat"), true);
  assert.deepEqual(
    [...PUBLIC_CONFIGURABLE_SEATS],
    [...PUBLIC_CALLABLE_ROLES],
  );
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("auditor"), true);
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("evidence-child"), false);
  for (const forbidden of ["soul-audit", "reviewer-cmr", "archivist", "assisted"]) {
    assert.equal(
      (PUBLIC_CONFIGURABLE_SEATS as readonly string[]).includes(forbidden),
      false,
      `must not expose ${forbidden}`,
    );
  }
});

test("help capabilities derive from typed public registry facts", () => {
  const capabilities = listHelpCapabilities();
  const names = capabilities.map((cap) => cap.name);
  for (const command of PUBLIC_CLI_SUPPORT_COMMANDS) {
    assert.equal(names.includes(command), true, `support command ${command}`);
  }
  for (const role of PUBLIC_CALLABLE_ROLES) {
    assert.equal(names.includes(role), true, `callable role ${role}`);
  }
  const rolesCap = capabilities.find((cap) => cap.name === "roles");
  assert.equal(rolesCap?.kind, "support");
  const judgeCap = capabilities.find((cap) => cap.kind === "role" && cap.name === "judge");
  assert.equal(judgeCap?.kind, "role");
  assert.ok(judgeCap && judgeCap.kind === "role");
  assert.deepEqual(judgeCap.phases, [null]);
  const fixerCap = capabilities.find((cap) => cap.kind === "role" && cap.name === "fixer");
  assert.ok(fixerCap && fixerCap.kind === "role");
  assert.deepEqual(fixerCap.phases, ["plan", "apply"]);
  assert.equal(fixerCap.defaultPhase, "apply");
  const analystCap = capabilities.find((cap) => cap.name === "analyst");
  assert.equal(analystCap?.kind, "deterministic");
  assert.equal(
    (PUBLIC_CALLABLE_ROLES as readonly string[]).includes("analyst"),
    false,
    "analyst is deterministic, not an LLM-configurable seat",
  );
});
