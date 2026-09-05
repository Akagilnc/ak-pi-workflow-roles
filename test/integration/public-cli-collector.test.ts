import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { testTmpdir } from "../helpers/worktree-temp.ts";

import { emptyCollectorManifest } from "../../src/collector-config.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";

function seedProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "collector@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Collector Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root, stdio: "ignore" });
}

function receipt() {
  const manifest = emptyCollectorManifest();
  return {
    host: "github.com",
    repository: "acme/widgets",
    prNumber: 1168,
    manifestDigest: manifest.digest,
    activationTime: "2026-01-01T00:00:00.000Z",
    deadlineTime: "2026-01-01T00:15:00.000Z",
    finalObservationTime: "2026-01-01T00:01:00.000Z",
    finalSnapshotId: "snap-1",
    targetHead: "9".repeat(40),
    groups: [{
      identity: { userType: "Bot", userId: 199175422 },
      displayLogin: "chatgpt-codex-connector[bot]",
      attendance: true,
      materials: [{ kind: "review", id: 81, evidenceId: "review-81", headRelation: "current" }],
      findings: [{ identity: { userType: "Bot", userId: 199175422 }, source: { kind: "review", id: 81, evidenceId: "review-81", headRelation: "current" }, category: "material", body: "typed finding" }],
    }],
    requestAttempts: [],
    snapshots: [],
    evidenceRecords: [],
  };
}

test("typed groups travel from real output settlement into the report artifact", async () => {
  const home = await mkdtemp(join(testTmpdir(), "collector-groups-"));
  try {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    const stdout: string[] = [];
    const result = await runAkRole(["collector", "--pr", "1168", "--repo", "acme/widgets", "--project", project], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: false },
      createRunId: () => "collector-groups-run",
      io: { stdout: (text) => stdout.push(text), stderr: () => undefined },
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
        assert.equal(args.some((arg) => arg.includes("collector-legs")), false);
        const sessionFile = args[args.indexOf("--session") + 1]!;
        const details = receipt();
        await writeFile(sessionFile, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: COLLECTOR_OUTPUT_TOOL, isError: false, details } })}\n`);
        return { code: 0, timedOut: false, stderr: "", args: [...args], sealedAcceptance: { role: "collector" as const, details } };
      },
          }),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.terminal?.roleOutcome.decisiveFacts.groups, [{
      identity: { userType: "Bot", userId: 199175422 }, attendance: true, materialCount: 1, findingCount: 1,
    }]);
    const reportPath = result.terminal?.artifacts.find((artifact) => artifact.kind === "report")?.path;
    assert.ok(reportPath);
    const artifact = JSON.parse(await readFile(reportPath, "utf8")) as { receipt: { groups: unknown[] } };
    assert.deepEqual(artifact.receipt.groups, receipt().groups);
    assert.equal(stdout.length > 0, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
