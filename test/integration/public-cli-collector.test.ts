/**
 * #1088 public Collector: seat + request-manifest admission; LLM submits groups.
 * Code-collection tools (observe/bind/wait/handbook) are gone.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { emptyCollectorManifest, loadCollectorManifest } from "../../src/collector-config.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { admitPublicRole, parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { objectPayloads } from "../helpers/terminal-payload.ts";

function seedProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "collector@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Collector Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root, stdio: "ignore" });
}

function receipt(overrides: Record<string, unknown> = {}) {
  const manifest = emptyCollectorManifest();
  return {
    host: "github.com",
    repository: "acme/widgets",
    prNumber: 1168,
    prState: "OPEN",
    manifestDigest: manifest.digest,
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

test("typed groups travel from real output settlement into the report artifact", async () => {
  return await withTempRoot("collector-groups-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    const stdout: string[] = [];
    const result = await runAkRole(["collector", "--model", "test/caller-seat:high", "--pr", "1168", "--repo", "acme/widgets", "--project", project], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: false },
      createRunId: () => "collector-groups-run",
      io: { stdout: (text) => stdout.push(text), stderr: () => undefined },
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          const details = receipt();
          await writeFile(sessionFile, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: COLLECTOR_OUTPUT_TOOL, isError: false, details } })}\n`);
          return { code: 0, timedOut: false, stderr: "", args: [...args], sealedAcceptance: { role: "collector" as const, details } };
        },
      }),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.terminal && (objectPayloads(result.terminal.roleOutcome)[0] ?? {}).groups, receipt().groups);
    const reportPath = result.terminal?.artifacts.find((artifact) => artifact.kind === "report")?.path;
    assert.ok(reportPath);
    const artifact = JSON.parse(await readFile(reportPath, "utf8")) as {
      outcome?: { payloads?: readonly { groups?: unknown[] }[] };
    };
    assert.deepEqual(artifact.outcome?.payloads?.[0]?.groups, receipt().groups);
    assert.equal(stdout.length > 0, true);
  });
});

test("#1088 public --request-manifest admission freezes digest; invalid JSON is usage", async () => {
  await withTempRoot("collector-manifest-admit-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    const good = join(home, "requests.json");
    await writeFile(good, JSON.stringify({ requests: [{ id: "codex", body: "@codex review" }] }));
    const manifest = await loadCollectorManifest(good);

    const admitted = await admitPublicRole("collector", parsePublicSeatArgv("collector", [
      "--pr",
      "42",
      "--repo",
      "acme/widgets",
      "--request-manifest",
      good,
      "--project",
      project,
      "Collect findings.",
    ]), {
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      createRunId: () => "collector-manifest-run",
    });
    assert.equal(admitted.role, "collector");
    if (admitted.role === "collector") {
      assert.equal(admitted.manifestDigest, manifest.digest);
      assert.equal(admitted.prNumber, 42);
      assert.ok(admitted.requestManifestPath?.endsWith("request-manifest.json"));
    }

    const bad = join(home, "bad.json");
    await writeFile(bad, "{ not json");
    await assert.rejects(
      () => admitPublicRole("collector", parsePublicSeatArgv("collector", [
        "--pr",
        "42",
        "--repo",
        "acme/widgets",
        "--request-manifest",
        bad,
        "--project",
        project,
      ]), {
        home,
        principalAuthority: piDurablePrincipalAuthority,
        cwd: project,
        createRunId: () => "collector-bad-manifest",
      }),
      (error: unknown) => error instanceof CliUsageError,
    );
  });
});

test("#1088 public Collector rejects retired --wait-ms", () => {
  assert.throws(
    () => parsePublicSeatArgv("collector", ["--pr", "1", "--repo", "a/b", "--wait-ms", "120000"]),
    (error: unknown) => error instanceof CliUsageError,
  );
});

test("#676 J2 MERGED prState travels from sealed receipt into public Terminal", async () => {
  return await withTempRoot("collector-merged-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    const details = receipt({ prState: "MERGED" });
    const result = await runAkRole(["collector", "--model", "test/caller-seat:high", "--pr", "1168", "--repo", "acme/widgets", "--project", project], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: false },
      createRunId: () => "collector-merged-run",
      io: { stdout: () => undefined, stderr: () => undefined },
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(sessionFile, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: COLLECTOR_OUTPUT_TOOL, isError: false, details } })}\n`);
          return { code: 0, timedOut: false, stderr: "", args: [...args], sealedAcceptance: { role: "collector" as const, details } };
        },
      }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(
      result.terminal && (objectPayloads(result.terminal.roleOutcome)[0] ?? {}).prState,
      "MERGED",
    );
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
