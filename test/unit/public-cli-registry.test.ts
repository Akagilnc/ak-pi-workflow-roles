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
    bareToken: "burden",
    sameParent: "none",
    phases: [null],
    outputTool: "ak_submission_output",
    auditTool: "ak_soul_audit_decision",
    settlement: "sealed",
    boardPlacement: "judge-history",
    navigatorSubject: "public-instruction",
    activationStage: "load-and-install",
    receiptStatusKey: "status",
  },
  {
    role: "fixer",
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "worker-packet",
    sameParent: "none",
    worker: true,
    methodSkills: ["diagnosing-bugs", "tdd"],
    settleMethod: "diagnosing-bugs",
    phases: ["plan", "apply"],
    outputTool: "ak_fixer_output",
    settlement: "sealed",
    artifactFace: {
      reportPhase: true,
    },
    boardPlacement: "marshal",
    navigatorSubject: "public-instruction",
    activationFlags: [
      { field: "phase", flag: "ak-fixer-phase", binds: "phase" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "coder",
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "worker-task",
    sameParent: "none",
    worker: true,
    applyMethod: "tdd",
    boardPlacement: "coder",
    phases: ["plan", "apply"],
    outputTool: "ak_coder_output",
    settlement: "sealed",
    artifactFace: {
      reportPhase: true,
    },
    navigatorSubject: "public-instruction",
    activationFlags: [
      { field: "phase", flag: "ak-coder-phase", binds: "phase" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "reviewer",
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "review-basis",
    baseValue: "revision",
    emitAuthorityRefs: true,
    sameParent: "none",
    methodSkills: ["ak-cross-m-review"],
    settleMethod: "ak-cross-m-review",
    parallelLenses: true,
    phases: [null],
    bareCommand: false,
    outputTool: "ak_reviewer_output",
    settlement: "sealed",
    sealedAcceptedOnly: true,
    artifactFace: {
    },
    transportPrompt: "skill-args",
    boardPlacement: "marshal",
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
    admission: "collect-target",
    sameParent: "none",
    phases: [null],
    bareCommand: false,
    outputTool: "ak_collector_output",
    settlement: "sealed",
    artifactFace: {
    },
    boardPlacement: "collector",
    analystTerminal: "groups",
    activationFlags: [
      { field: "repo", from: "repository.display", flag: "ak-collector-repo" },
      { field: "pr", from: "prNumber", text: true, flag: "ak-collector-pr" },
      { field: "requestManifestPath", flag: "ak-collector-request-manifest" },
    ],
    activationStage: "load-and-install",
  },
  {
    role: "doctor",
    inCallAutoResume: false,
    presentSettled: "typed",
    summonResume: false,
    admission: "case-identity",
    sameParent: "none",
    phases: [null],
    bareCommand: false,
    outputTool: "ak_doctor_output",
    auditTool: "ak_doctor_audit_decision",
    settlement: "sealed",
    artifactFace: {
      doctorReportFacts: true,
    },
    navigatorSubject: "case",
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
    admission: "merge-envelope",
    bareToken: "packet",
    sameParent: "none",
    methodSkills: ["resolving-merge-conflicts"],
    settleMethod: "resolving-merge-conflicts",
    phases: [null],
    outputTool: "ak_merger_output",
    settlement: "sealed",
    artifactFace: {
    },
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
    admission: "source-locator",
    bareToken: "instruction",
    sourceRunStored: "raw",
    argvResult: "source-run",
    sameParent: "source-locator",
    reviewOfficer: true,
    provinceConfig: true,
    modelInheritsFrom: "gatekeeper",
    phases: [null],
    bareCommand: false,
    outputTool: "ak_submission_output",
    settlement: "accepted",
    reaskPrompt: true,
    transportPrompt: "fixed-kickoff",
    navigatorSubject: "source-run",
    gateStageLabel: "符宝郎",
    gateSummon: "source-run",
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
    admission: "court-materials",
    sameParent: "none",
    phases: [null],
    outputTool: "ak_submission_output",
    settlement: "accepted",
    gateStageLabel: "给事中",
    gateSummon: "parent-instruction",
    activationFlags: [
      { field: "ticketNumber" },
    ],
    activationStage: "load-and-install",
    receiptStatusKey: "status",
  },
  {
    role: "secretariat",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "instruction",
    sameParent: "none",
    phases: [null],
    outputTool: "ak_secretariat_output",
    settlement: "accepted",
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
    argvResult: "instruction",
    sameParent: "none",
    phases: [null],
    bareCommand: false,
    outputTool: "ak_gleaner_left_output",
    settlement: "accepted",
    transportPrompt: "baseline",
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
    sameParent: "source-run",
    resumeSourcePath: true,
    reviewOfficer: true,
    provinceConfig: true,
    modelInheritsFrom: "gatekeeper",
    phases: [null],
    outputTool: "ak_submission_output",
    settlement: "accepted",
    reaskPrompt: true,
    gateStageLabel: "台院",
    gateSummon: "source-run",
    activationFlags: [
      {
        field: "sourceRun",
        from: "sourceRunPath",
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
    provinceConfig: true,
    phases: [null],
    outputTool: "ak_gatekeeper_output",
    settlement: "accepted",
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
    activationStage: "load-and-install",
  },
  {
    role: "auditor",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: true,
    admission: "instruction",
    sameParent: "subject-source",
    subjectChoices: ["judge", "doctor"],
    reviewOfficer: true,
    soulSource: "subject",
    phases: [null],
    outputTool: "ak_submission_output",
    settlement: "accepted",
    reaskPrompt: true,
    gateStageLabel: "审刑院",
    gateSummon: "subject-source",
    activationStage: "load-and-install",
  },
  {
    role: "diarist",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "instruction",
    sameParent: "board-ticket",
    phases: [null],
    outputTool: "ak_diarist_output",
    settlement: "accepted",
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
