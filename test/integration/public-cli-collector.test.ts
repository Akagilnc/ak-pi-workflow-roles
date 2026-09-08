import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { emptyCollectorManifest } from "../../src/collector-config.ts";
import { COLLECTOR_BIND_TARGET_TOOL } from "../../src/collector-ledger.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { AdmittedCollectorInvocation } from "../../src/public-cli/invocation.ts";
import {
  presentFailureTerminal,
  settleFailureTerminalResult,
} from "../../src/public-cli/settlement.ts";
import { NO_RECEIPT_LIFECYCLE_ENTRY_TYPE } from "../../src/receipt-delivery-policy.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { resolveCollectorTarget } from "../../src/collector-target.ts";
import { normalizePullRequest } from "../../src/collector-github.ts";

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
    ...overrides,
  };
}

test("typed groups travel from real output settlement into the report artifact", async () => {
  return await withTempRoot("collector-groups-", async (home) => {
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
    // #757: groups pass through in full — no materialCount/findingCount-only projection.
    assert.deepEqual(result.terminal?.roleOutcome.decisiveFacts.groups, receipt().groups);
    const reportPath = result.terminal?.artifacts.find((artifact) => artifact.kind === "report")?.path;
    assert.ok(reportPath);
    const artifact = JSON.parse(await readFile(reportPath, "utf8")) as { receipt: { groups: unknown[] } };
    assert.deepEqual(artifact.receipt.groups, receipt().groups);
    assert.equal(stdout.length > 0, true);
    });
});

test("#676 J2/J3 no_receipt public terminal projects collector target-bind rejection to caller facts", async () => {
  // Legal seam after #685: settlement/present delivery — durable bind rejection → public facts + stderr.
  // no_receipt stays lawful exit 0; no model prose parse; no heavy in-process host.
  return await withTempRoot("collector-bind-clarify-", async (home) => {
    const runDirectory = join(home, "runs", "collector-bind-ambiguous@collector");
    const sessionDirectory = join(runDirectory, "session");
    const sessionFile = join(sessionDirectory, "session.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    const bindDiagnosticFixture = "collector-target-bind-rejected-fixture";
    await writeFile(
      sessionFile,
      `${[
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "go" }] },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-bind-1",
            toolName: COLLECTOR_BIND_TARGET_TOOL,
            isError: true,
            content: [{ type: "text", text: bindDiagnosticFixture }],
            details: { code: "CollectorTargetBindError" },
          },
        },
        {
          type: "custom",
          customType: NO_RECEIPT_LIFECYCLE_ENTRY_TYPE,
          data: {
            terminalToolCalled: false,
            rejectedReceipts: [],
            deliveryTurns: 2,
            sessionCompletion: "settled-without-accepted-receipt",
            runPointer: runDirectory,
            attemptPointer: `current:${runDirectory}`,
            acceptedReceipt: false,
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const admitted = {
      role: "collector",
      runId: "collector-bind-ambiguous",
      bookKey: "work",
      projectRoot: home,
      runDirectory,
      principal: fixturePrincipal(sessionDirectory, sessionFile),
      instruction: "Task materials only mention issue #42",
      instructionEmpty: false,
      attachments: [],
      admittedRequestPath: join(runDirectory, "admitted-request.json"),
      repository: {
        owner: "acme",
        repo: "widgets",
        canonical: "acme/widgets",
        display: "acme/widgets",
      },
      manifestDigest: emptyCollectorManifest().digest,
    } satisfies AdmittedCollectorInvocation;

    const terminal = await settleFailureTerminalResult(
      admitted,
      {
        cause: "output",
        diagnostic: "Collector Role run completed without a lawful typed terminal result",
      },
      piDurablePrincipalAuthority,
    );
    assert.equal(terminal.roleOutcome.kind, "no_receipt");
    const facts = terminal.roleOutcome.decisiveFacts;
    assert.equal(facts.targetBindRejected, true);
    assert.equal(typeof facts.targetBindDiagnostic, "string");
    assert.ok(String(facts.targetBindDiagnostic).trim().length > 0);
    assert.equal(facts.targetBindCode, "CollectorTargetBindError");

    const stdout: string[] = [];
    const stderr: string[] = [];
    presentFailureTerminal(terminal, {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    // Presentation covered as non-empty only — no free-text/oracle lock (#676 D2).
    assert.equal(stdout.length > 0, true);
    assert.equal(stderr.length > 0, true);
  });
});

test("#676 J2 MERGED prState travels from sealed receipt into public Terminal", async () => {
  return await withTempRoot("collector-merged-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    const details = receipt({
      prNumber: 9,
      prState: "MERGED",
      groups: [{
        identity: { userType: "Bot", userId: 136622811 },
        displayLogin: "coderabbitai[bot]",
        attendance: true,
        materials: [{ kind: "review", id: 91, evidenceId: "review-91", headRelation: "current" }],
        findings: [{
          identity: { userType: "Bot", userId: 136622811 },
          source: { kind: "review", id: 91, evidenceId: "review-91", headRelation: "current" },
          category: "material",
          body: "closed-pr finding",
        }],
      }],
      requestAttempts: [],
    });
    const result = await runAkRole(
      ["collector", "--pr", "9", "--repo", "acme/widgets", "--project", project, "Collect closed PR materials."],
      {
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
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: { role: "toolResult", toolName: COLLECTOR_OUTPUT_TOOL, isError: false, details },
              })}\n`,
            );
            return {
              code: 0,
              timedOut: false,
              stderr: "",
              args: [...args],
              sealedAcceptance: { role: "collector" as const, details },
            };
          },
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.roleOutcome.decisiveFacts.prState, "MERGED");
    assert.deepEqual(result.terminal?.roleOutcome.decisiveFacts.requestAttempts, []);
    const reportPath = result.terminal?.artifacts.find((artifact) => artifact.kind === "report")?.path;
    assert.ok(reportPath);
    const artifact = JSON.parse(await readFile(reportPath, "utf8")) as {
      receipt: { prState: string; requestAttempts: unknown[]; groups: unknown[] };
    };
    assert.equal(artifact.receipt.prState, "MERGED");
    assert.equal(artifact.receipt.requestAttempts.length, 0);
    assert.equal(artifact.receipt.groups.length >= 1, true);
  });
});

test("#676 J2 CLOSED non-OPEN prState still returns materials without inventing requests", async () => {
  return await withTempRoot("collector-closed-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    const details = receipt({
      prNumber: 11,
      prState: "CLOSED",
      requestAttempts: [],
    });
    const result = await runAkRole(
      ["collector", "--pr", "11", "--repo", "acme/widgets", "--project", project],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        createRunId: () => "collector-closed-run",
        io: { stdout: () => undefined, stderr: () => undefined },
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: { role: "toolResult", toolName: COLLECTOR_OUTPUT_TOOL, isError: false, details },
              })}\n`,
            );
            return {
              code: 0,
              timedOut: false,
              stderr: "",
              args: [...args],
              sealedAcceptance: { role: "collector" as const, details },
            };
          },
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.decisiveFacts.prState, "CLOSED");
    assert.deepEqual(result.terminal?.roleOutcome.decisiveFacts.requestAttempts, []);
    assert.ok(Array.isArray(result.terminal?.roleOutcome.decisiveFacts.groups));
  });
});

test("#676 J2 explicit --pr is unique bound; unbound admission keeps role-side bind authority", async () => {
  return await withTempRoot("collector-bound-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    // Explicit --pr is the unique-bind public face (no association queries).
    const explicit = await resolveCollectorTarget({
      projectRoot: project,
      repository: {
        owner: "acme",
        repo: "widgets",
        canonical: "acme/widgets",
        display: "acme/widgets",
      },
      explicitPrNumber: 42,
    });
    assert.deepEqual(explicit, { kind: "bound", prNumber: 42 });

    // Role-bound receipt after unbound admission: settlement accepts receipt.prNumber.
    const details = receipt({ prNumber: 77 });
    const result = await runAkRole(
      ["collector", "--pr", "77", "--repo", "acme/widgets", "--project", project],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        createRunId: () => "collector-unique-bind-run",
        io: { stdout: () => undefined, stderr: () => undefined },
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: { role: "toolResult", toolName: COLLECTOR_OUTPUT_TOOL, isError: false, details },
              })}\n`,
            );
            return {
              code: 0,
              timedOut: false,
              stderr: "",
              args: [...args],
              sealedAcceptance: { role: "collector" as const, details },
            };
          },
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.decisiveFacts.prNumber, 77);
  });
});

test("#676 J2 REST merged:true normalizes to MERGED (shared with Terminal projection)", () => {
  const merged = normalizePullRequest({
    number: 9,
    state: "closed",
    merged: true,
    head: { sha: "cafebabe" },
    html_url: "https://github.com/acme/widgets/pull/9",
  });
  assert.equal(merged.state, "MERGED");
  const closed = normalizePullRequest({
    number: 11,
    state: "closed",
    merged: false,
    head: { sha: "deadbeef" },
    html_url: "https://github.com/acme/widgets/pull/11",
  });
  assert.equal(closed.state, "CLOSED");
});
