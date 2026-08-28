import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_CALLABLE_ROLES,
  PUBLIC_CLI_SUPPORT_COMMANDS,
  PUBLIC_CONFIGURABLE_SEATS,
  listHelpCapabilities,
  publicStartupCandidates,
} from "../../src/public-cli/registry.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
} from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";

/** External metadata oracle — all 8 roles, every field, roster order (#524 验收 1). */
const EXPECTED_PACKAGED_ROLE_METADATA = [
  {
    role: "judge",
    phases: [null],
    outputTool: JUDGE_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "fixer",
    phases: ["plan", "apply"],
    outputTool: FIXER_OUTPUT_TOOL_NAME,
    inputFlag: "ak-fix-packet",
    phaseFlag: "ak-fixer-phase",
    activationStage: "load-and-install",
  },
  {
    role: "coder",
    phases: ["plan", "apply"],
    outputTool: CODER_OUTPUT_TOOL_NAME,
    inputFlag: "ak-coder-task",
    phaseFlag: "ak-coder-phase",
    activationStage: "load-and-install",
  },
  {
    role: "reviewer",
    phases: [null],
    outputTool: REVIEWER_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "collector",
    phases: [null],
    outputTool: COLLECTOR_OUTPUT_TOOL,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "doctor",
    phases: [null],
    outputTool: DOCTOR_OUTPUT_TOOL_NAME,
    inputFlag: "ak-doctor-case",
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
  {
    role: "merger",
    phases: [null],
    outputTool: MERGER_OUTPUT_TOOL_NAME,
    inputFlag: "ak-merger-input",
    phaseFlag: undefined,
    activationStage: "prepare-git-and-install",
  },
  {
    role: "notary",
    phases: [null],
    outputTool: NOTARY_OUTPUT_TOOL_NAME,
    inputFlag: "ak-notary-source-run",
    phaseFlag: undefined,
    activationStage: "load-and-install",
  },
] as const;

test("public registry exposes callable roles plus automatic configurable seats", () => {
  // #524 验收 1: full metadata fields + order for all 8 roles (external oracle).
  assert.deepEqual(
    PACKAGED_ROLE_REGISTRY.map((entry) => ({
      role: entry.role,
      phases: [...entry.phases],
      outputTool: entry.outputTool,
      inputFlag: entry.inputFlag,
      phaseFlag: entry.phaseFlag,
      activationStage: entry.activationStage,
    })),
    EXPECTED_PACKAGED_ROLE_METADATA.map((entry) => ({
      role: entry.role,
      phases: [...entry.phases],
      outputTool: entry.outputTool,
      inputFlag: entry.inputFlag,
      phaseFlag: entry.phaseFlag,
      activationStage: entry.activationStage,
    })),
  );
  assert.deepEqual(
    [...PUBLIC_CALLABLE_ROLES],
    EXPECTED_PACKAGED_ROLE_METADATA.map((entry) => entry.role),
  );
  assert.equal(PUBLIC_CALLABLE_ROLES.length, 8);
  assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("notary"), true);
  // #453: automatic gate seats join navigator as configurable-only (never caller commands).
  assert.deepEqual(
    [...PUBLIC_CONFIGURABLE_SEATS],
    [...PUBLIC_CALLABLE_ROLES, "gatekeeper", "inspector", "navigator"],
  );
  for (const automatic of ["gatekeeper", "inspector", "navigator"] as const) {
    assert.equal(
      PUBLIC_CONFIGURABLE_SEATS.includes(automatic as never),
      true,
      `must expose automatic seat ${automatic}`,
    );
    assert.equal(
      (PUBLIC_CALLABLE_ROLES as readonly string[]).includes(automatic),
      false,
      `${automatic} is automatic, not a callable command`,
    );
  }
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
    false,
    "navigator is automatic, not a callable command",
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
  assert.deepEqual(publicStartupCandidates("reviewer"), [
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  assert.deepEqual(publicStartupCandidates("navigator"), [
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  for (const seat of ["coder", "fixer", "collector", "doctor", "merger", "notary"] as const) {
    assert.deepEqual(publicStartupCandidates(seat), [
      { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      { provider: "xai", model: "grok-4.5", thinking: "high" },
    ]);
  }
});
