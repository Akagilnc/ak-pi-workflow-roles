import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_CALLABLE_ROLES,
  PUBLIC_CLI_SUPPORT_COMMANDS,
  PUBLIC_CONFIGURABLE_SEATS,
  listHelpCapabilities,
  publicStartupCandidates,
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
    phases: [null],
    outputTool: "ak_judge_output",
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "fixer",
    phases: ["plan", "apply"],
    outputTool: "ak_fixer_output",
    inputFlag: "ak-fix-packet",
    phaseFlag: "ak-fixer-phase",
    activationStage: "load-and-install",
  },
  {
    role: "coder",
    phases: ["plan", "apply"],
    outputTool: "ak_coder_output",
    inputFlag: "ak-coder-task",
    phaseFlag: "ak-coder-phase",
    activationStage: "load-and-install",
  },
  {
    role: "reviewer",
    phases: [null],
    outputTool: "ak_reviewer_output",
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "collector",
    phases: [null],
    outputTool: "ak_collector_output",
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "doctor",
    phases: [null],
    outputTool: "ak_doctor_output",
    inputFlag: "ak-doctor-case",
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "merger",
    phases: [null],
    outputTool: "ak_merger_output",
    inputFlag: "ak-merger-input",
    phaseFlag: undefined,
    activationStage: "prepare-git-and-install",
  },
  {
    role: "notary",
    phases: [null],
    outputTool: "ak_notary_output",
    inputFlag: "ak-notary-source-run",
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "countersign",
    phases: [null],
    outputTool: "ak_countersign_output",
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "gleaner-left",
    phases: [null],
    outputTool: "ak_gleaner_left_output",
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "inspector",
    phases: [null],
    outputTool: "ak_inspector_output",
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "gatekeeper",
    phases: [null],
    outputTool: "ak_gatekeeper_output",
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "navigator",
    phases: [null],
    outputTool: "ak_navigator_output",
    inputFlag: undefined,
    phaseFlag: undefined,
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
  // #639: gatekeeper and navigator are callable roles like any other.
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("gatekeeper"), true);
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("navigator"), true);
  assert.deepEqual(
    [...PUBLIC_CONFIGURABLE_SEATS],
    [...PUBLIC_CALLABLE_ROLES],
  );
  for (const forbidden of ["auditor", "soul-audit", "reviewer-cmr", "archivist", "assisted"]) {
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
  assert.equal(
    (names as readonly string[]).includes("navigator"),
    true,
    "navigator is a callable role with help facts",
  );
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

test("startup model candidates follow #11 package defaults per seat", () => {
  assert.deepEqual(publicStartupCandidates("judge"), [
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  // #572 给事中 — same sol/high court tier as judge (ticket-court review).
  assert.deepEqual(publicStartupCandidates("countersign"), [
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  assert.deepEqual(publicStartupCandidates("reviewer"), [
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  assert.deepEqual(publicStartupCandidates("gleaner-left"), [
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  assert.deepEqual(publicStartupCandidates("navigator"), [
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  // #620: subordinate province officers have no package startup — inherit gatekeeper instead.
  assert.deepEqual(publicStartupCandidates("inspector"), []);
  assert.deepEqual(publicStartupCandidates("notary"), []);
  assert.deepEqual(publicStartupCandidates("gatekeeper"), []);
  for (const seat of ["coder", "fixer", "collector", "doctor", "merger"] as const) {
    assert.deepEqual(publicStartupCandidates(seat), [
      { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      { provider: "xai", model: "grok-4.5", thinking: "high" },
    ]);
  }
});
