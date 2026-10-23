/**
 * #1088 public Collector: seat + request-manifest admission; LLM submits groups.
 * Code-collection tools (observe/bind/wait/handbook) are gone.
 */
import { submittedParams, terminalBodyAt } from "../helpers/run-dossier-fixture.ts";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { withTempRoot } from "../helpers/environment-fixtures.ts";
import { captureIo, seedGitProject as seedProject } from "../helpers/failure-settlement-kit.ts";

import { runAkRole } from "../../src/public-cli/cli.ts";
import { admitPublicRole, parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromStructuredOutputRounds } from "../helpers/role-turn-host-fixture.ts";
import { objectPayloads } from "../helpers/terminal-payload.ts";

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    host: "github.com",
    repository: "acme/widgets",
    prNumber: 1168,
    prState: "OPEN",
    // Open receipt field may still be submitted by the role; package does not invent it.
    manifestDigest: "role-submitted-optional",
    groups: [{
      identity: { userType: "Bot", userId: 199175422 },
      displayLogin: "chatgpt-codex-connector[bot]",
      attendance: true,
      materials: [{ kind: "review", id: 81, evidenceId: "review-81", headRelation: "current" }],
      findings: [{
        identity: { userType: "Bot", userId: 199175422 },
        source: { kind: "review", id: 81, evidenceId: "review-81", headRelation: "current" },
        category: "material",
        body: "typed finding",
      }],
    }],
    unfinishedReasons: [],
    ...overrides,
  };
}

test("Collector receipt travels unchanged through the envelope into Terminal and ledger", async () => {
  return await withTempRoot("collector-groups-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    const { io } = captureIo();
    const details = receipt({ prState: "MERGED", ticketNumber: 1237 });
    const result = await runAkRole(["collector", "--model", "test/caller-seat:high", "--pr", "1168", "--repo", "acme/widgets", "--project", project], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: false },
      createRunId: () => "collector-groups-run",
      io,
      roleTurnHost: roleTurnHostFromStructuredOutputRounds({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        submissions: [details],
      }),
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(result.terminal && objectPayloads(result.terminal.roleOutcome), [details]);
    const reportPath = result.terminal?.artifacts.find((artifact) => artifact.kind === "report")?.path;
    assert.ok(reportPath);
    const artifact = terminalBodyAt(reportPath, "report") as {
      outcome?: { payloads?: unknown };
    };
    // The submitted groups live in history.jsonl; the terminal carries only the verdict.
    assert.equal(artifact.outcome !== undefined && "payloads" in artifact.outcome, false);
    const submitted = submittedParams(dirname(reportPath)) as readonly { groups?: unknown[] }[];
    assert.deepEqual(submitted, [details]);
  });
});

test("#676 J2 explicit --pr is unique bound at admission", async () => {
  await withTempRoot("collector-explicit-pr-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    const admitted = await admitPublicRole("collector", parsePublicSeatArgv("collector", [
      "--pr",
      "99",
      "--repo",
      "acme/widgets",
      "--project",
      project,
    ]), {
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      createRunId: () => "collector-pr-run",
    });
    assert.equal(admitted.role, "collector");
    if (admitted.role === "collector") {
      assert.equal(admitted.prNumber, 99);
    }
  });
});
