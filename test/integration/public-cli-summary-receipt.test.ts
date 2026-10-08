/**
 * #1198: each seat's terminating schema declares optional `summary`; public CLI
 * receipts keep it as submitted (present / missing / overlong) with full text.
 * Seam: public `ak-role` + in-repo fake host (owner-approved test seam).
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleSubmissionDeclaration } from "../../src/role-submission-declarations.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  roleTurnHostFromStructuredOutputRounds,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { objectPayloads } from "../helpers/terminal-payload.ts";

function schemaProperties(parameters: unknown): Record<string, { description?: unknown }> {
  assert.ok(parameters !== null && typeof parameters === "object");
  const properties = (parameters as { properties?: unknown }).properties;
  assert.ok(properties !== null && typeof properties === "object");
  return properties as Record<string, { description?: unknown }>;
}

function schemaRequired(parameters: unknown): readonly string[] {
  assert.ok(parameters !== null && typeof parameters === "object");
  const required = (parameters as { required?: unknown }).required;
  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === "string")
    : [];
}

async function runCoderReceipt(
  home: string,
  project: string,
  runId: string,
  details: unknown,
) {
  const result = await runAkRole(
    ["coder", "--model", "test/caller-seat:high", "plan", "--project", project, "summary receipt"],
    {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      createRunId: () => runId,
      io: captureIo().io,
      roleTurnHost: roleTurnHostFromStructuredOutputRounds({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        submissions: [details],
      }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.terminal);
  assert.equal(result.terminal.roleOutcome.kind, "accepted");
  return result;
}

test("#1198 summary is declared on every seat and passes through public receipts as-is", async () => {
  for (const role of ["coder", "judge", "notary", "secretariat"] as const) {
    const declaration = roleSubmissionDeclaration(role);
    const properties = schemaProperties(declaration.parameters);
    assert.ok(Object.hasOwn(properties, "summary"), `${role} declares summary`);
    assert.equal(typeof properties.summary.description, "string");
    assert.ok(
      String(properties.summary.description).trim().length > 0,
      `${role} summary has semantics`,
    );
    assert.equal(schemaRequired(declaration.parameters).includes("summary"), false);
  }

  await withTempRoot("ak-public-cli-summary-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const withSummary = {
      status: "planned" as const,
      report: "full coder report still present",
      summary: "coder short conclusion",
      ticketNumber: 1198,
    };
    const missingSummary = {
      status: "planned" as const,
      report: "full report without summary field",
      ticketNumber: 1198,
    };
    const overlongSummary = {
      status: "planned" as const,
      report: "full report with overlong summary kept",
      summary: "x".repeat(200),
      ticketNumber: 1198,
    };
    const judgeWithSummary = {
      status: "escalate" as const,
      findings: ["detail finding remains"],
      note: "full judge note remains",
      decisionGate: { question: "q", options: ["a"] },
      summary: "judge short conclusion",
      ticketNumber: 1198,
    };

    {
      const result = await runCoderReceipt(home, project, "run-summary-coder-present", withSummary);
      assert.deepEqual(objectPayloads(result.terminal!.roleOutcome), [withSummary]);
      assert.equal(
        (objectPayloads(result.terminal!.roleOutcome)[0] as { report?: unknown }).report,
        withSummary.report,
      );
    }

    {
      const result = await runCoderReceipt(home, project, "run-summary-coder-missing", missingSummary);
      const payload = objectPayloads(result.terminal!.roleOutcome)[0] as Record<string, unknown>;
      assert.equal(Object.hasOwn(payload, "summary"), false);
      assert.equal(payload.report, missingSummary.report);
    }

    {
      const result = await runCoderReceipt(home, project, "run-summary-coder-overlong", overlongSummary);
      assert.deepEqual(objectPayloads(result.terminal!.roleOutcome), [overlongSummary]);
    }

    {
      const result = await runAkRole(
        ["judge", "--model", "test/caller-seat:high", "--project", project, "adjudicate with summary"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-summary-judge-present",
          io: captureIo().io,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: scriptedTerminatingToolSession({
              role: "judge",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              details: judgeWithSummary,
            }),
          }),
        },
      );
      assert.equal(result.exitCode, 0);
      assert.ok(result.terminal);
      assert.equal(result.terminal.roleOutcome.kind, "accepted");
      const payload = objectPayloads(result.terminal.roleOutcome)[0] as Record<string, unknown>;
      assert.equal(payload.summary, judgeWithSummary.summary);
      assert.equal(payload.note, judgeWithSummary.note);
      assert.deepEqual(payload.findings, judgeWithSummary.findings);
    }
  });
});
