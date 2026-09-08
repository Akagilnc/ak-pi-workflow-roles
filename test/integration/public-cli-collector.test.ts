import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { emptyCollectorManifest } from "../../src/collector-config.ts";
import {
  COLLECTOR_BIND_TARGET_TOOL,
  createCollectorLedger,
} from "../../src/collector-ledger.ts";
import {
  COLLECTOR_OUTPUT_TOOL,
} from "../../src/package-contracts/collector-output.ts";
import {
  createCollectorRoleRuntime,
  type CollectorActivation,
} from "../../src/collector-role.ts";
import { createSystemCollectorClock } from "../../src/collector-evidence.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
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
import { createFakeGitHubTransport, samplePull, sampleUser } from "../helpers/fake-github-transport.ts";
import {
  isCorrectableExecuteError,
  projectCorrectableExecuteRejection,
} from "../../src/submission-correctable-error.ts";
import type { HostContext, HostToolDefinition, RoleHost } from "../../src/host-contracts.ts";
import type { AdmittedCollectorInvocation } from "../../src/public-cli/invocation.ts";

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

/** Minimal RoleHost for real collector business-tool execute (no heavy in-process Pi). */
function collectorToolHost(flags: Readonly<Record<string, string>> = {
  "ak-collector-repo": "acme/widgets",
}): {
  host: RoleHost;
  tools: Map<string, HostToolDefinition>;
} {
  const tools = new Map<string, HostToolDefinition>();
  const host = {
    registerFlag() {},
    getFlag(name: string) {
      return flags[name];
    },
    registerTool(tool: HostToolDefinition) {
      tools.set(tool.name, tool);
    },
    getAllTools() {
      return [...tools.keys()].map((name) => ({ name }));
    },
    setActiveTools() {},
    getActiveTools() {
      return [...tools.keys()];
    },
    on() {},
    deliverSubmissionRejection() {},
  } as unknown as RoleHost;
  return { host, tools };
}

function hostContext(): HostContext {
  return {
    cwd: process.cwd(),
    mode: "print",
    model: undefined,
    abort() {},
    sessionManager: {
      getSessionDir: () => "/tmp/collector-bind-test",
      getSessionFile: () => "/tmp/collector-bind-test/session.jsonl",
      getLeafEntry: () => undefined,
      appendCustomEntry() {},
    },
  } as unknown as HostContext;
}

/**
 * Real ak_collector_bind_target execute through createCollectorRoleRuntime.
 * Returns durable toolResult shape (success or projected correctable isError).
 */
async function executeCollectorBind(input: {
  readonly params: { prNumber?: number; issueNumber?: number };
  readonly toolCallId?: string;
}): Promise<{
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly content: Array<{ type: "text"; text: string }>;
  readonly details: Record<string, unknown>;
}> {
  const { host, tools } = collectorToolHost();
  let activation: CollectorActivation | undefined;
  const runtime = createCollectorRoleRuntime(
    host,
    {
      async loadSoul() {
        return "# Collector\nBind and collect.";
      },
      createTransport() {
        return createFakeGitHubTransport({
          user: sampleUser(),
          pullRequest: samplePull({ headOid: "head-1" }),
          reviews: [],
          issueComments: [],
          reviewComments: [],
        });
      },
      createClock: () => createSystemCollectorClock(),
      createLedger(config, clock, ctx) {
        return createCollectorLedger(config, {
          clock,
          dossierEntries: ctx.sessionManager?.getEntries?.() ?? [],
        });
      },
    },
    {
      failInfrastructure(error: unknown): never {
        throw error instanceof Error ? error : new Error(String(error));
      },
    },
  );
  activation = await runtime.activate(hostContext());
  runtime.registerBusinessTools(() => activation);
  const tool = tools.get(COLLECTOR_BIND_TARGET_TOOL);
  assert.ok(tool, "bind-target business tool must register");
  const toolCallId = input.toolCallId ?? "call-bind-1";
  try {
    const result = await tool.execute(
      toolCallId,
      input.params,
      undefined,
      undefined,
      hostContext(),
    );
    return {
      toolCallId,
      isError: false,
      content: result.content as Array<{ type: "text"; text: string }>,
      details: (result.details ?? {}) as Record<string, unknown>,
    };
  } catch (error) {
    assert.equal(isCorrectableExecuteError(error), true, "bind rejection must be correctable");
    const projected = projectCorrectableExecuteRejection(error);
    return {
      toolCallId,
      isError: true,
      content: [{ type: "text", text: projected.diagnostic }],
      details: projected.details,
    };
  }
}

/** Install a PATH-first gh stub for issue→PR association (light; no real network). */
async function withFakeGh(
  home: string,
  script: string,
  run: () => Promise<void>,
): Promise<void> {
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  const gh = join(binDir, "gh");
  await writeFile(gh, script, "utf8");
  await chmod(gh, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${binDir}:${previous ?? ""}`;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

function multiPrIssueGhScript(): string {
  // Admission head/commit association: empty → unbound.
  // Bind-target GraphQL for issue #42: two PRs → correctable ambiguity.
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
const path = args.filter((a) => a.startsWith("/")).at(-1) || "";
function ok(body) {
  process.stdout.write("HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n" + JSON.stringify(body));
}
if (args.includes("graphql")) {
  ok({
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: { nodes: [{ number: 7 }, { number: 9 }] },
          timelineItems: { nodes: [] },
        },
      },
    },
  });
  process.exit(0);
}
// Admission structured association paths: empty list keeps target unbound.
if (path.includes("/commits/") || path.includes("/pulls?")) { ok([]); process.exit(0); }
if (path.includes("/issues/42")) ok({ number: 42, title: "t", state: "open" });
else if (path.endsWith("/user")) ok({ login: "fixture" });
else { ok([]); process.exit(0); }
`;
}

function uniquePrIssueGhScript(prNumber: number): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
const path = args.filter((a) => a.startsWith("/")).at(-1) || "";
function ok(body) {
  process.stdout.write("HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n" + JSON.stringify(body));
}
if (args.includes("graphql")) {
  ok({
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: { nodes: [{ number: ${prNumber} }] },
          timelineItems: { nodes: [] },
        },
      },
    },
  });
  process.exit(0);
}
if (path.includes("/commits/") || path.includes("/pulls?")) { ok([]); process.exit(0); }
if (path.includes("/issues/")) ok({ number: 42, title: "t", state: "open" });
else if (path.endsWith("/user")) ok({ login: "fixture" });
else { ok([]); process.exit(0); }
`;
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
        packageRoot,
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
    assert.deepEqual(result.terminal?.roleOutcome.decisiveFacts.groups, receipt().groups);
    const reportPath = result.terminal?.artifacts.find((artifact) => artifact.kind === "report")?.path;
    assert.ok(reportPath);
    const artifact = JSON.parse(await readFile(reportPath, "utf8")) as { receipt: { groups: unknown[] } };
    assert.deepEqual(artifact.receipt.groups, receipt().groups);
    assert.equal(stdout.length > 0, true);
  });
});

test("#676 J2/J3 public entry: real bind-target multi-PR rejection → no_receipt targetBind facts", async () => {
  // Public runAkRole seam + real ak_collector_bind_target execute (fake gh association only).
  return await withTempRoot("collector-bind-clarify-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    await withFakeGh(home, multiPrIssueGhScript(), async () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const result = await runAkRole(
        ["collector", "--repo", "acme/widgets", "--project", project, "Task materials only mention issue #42"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: false },
          createRunId: () => "collector-bind-ambiguous",
          io: {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text),
          },
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
              const sessionFile = args[args.indexOf("--session") + 1]!;
              const runDir = options.env.AK_ROLE_RUN_DIR;
              assert.ok(typeof runDir === "string");
              // Real bind execute — diagnostic text comes from production CollectorTargetBindError.
              const bind = await executeCollectorBind({
                params: { issueNumber: 42 },
                toolCallId: "call-bind-1",
              });
              assert.equal(bind.isError, true);
              assert.match(bind.content.map((p) => p.text).join(""), /multiple PRs/);
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
                      toolCallId: bind.toolCallId,
                      toolName: COLLECTOR_BIND_TARGET_TOOL,
                      isError: true,
                      content: bind.content,
                      details: bind.details,
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
                      runPointer: runDir,
                      attemptPointer: `current:${runDir}`,
                      acceptedReceipt: false,
                    },
                  },
                ].map((row) => JSON.stringify(row)).join("\n")}\n`,
              );
              return { code: 0, timedOut: false, stderr: "", args: [...args] };
            },
          }),
        },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
      const facts = result.terminal?.roleOutcome.decisiveFacts ?? {};
      assert.equal(facts.targetBindRejected, true);
      assert.equal(typeof facts.targetBindDiagnostic, "string");
      assert.match(String(facts.targetBindDiagnostic), /multiple PRs/);
      assert.match(String(facts.targetBindDiagnostic), /#42/);
      assert.equal(facts.targetBindCode, "CollectorTargetBindError");
      assert.equal(stdout.length > 0, true);
      assert.equal(stderr.length > 0, true);
    });
  });
});

test("#676 J3 latest bind success clears earlier rejection on no_receipt", async () => {
  // Fail then succeed on the same attempt — public facts must not keep the stale rejection.
  return await withTempRoot("collector-bind-cleared-", async (home) => {
    const runDirectory = join(home, "runs", "collector-bind-cleared@collector");
    const sessionDirectory = join(runDirectory, "session");
    const sessionFile = join(sessionDirectory, "session.jsonl");
    await mkdir(sessionDirectory, { recursive: true });

    await withFakeGh(home, multiPrIssueGhScript(), async () => {
      const failed = await executeCollectorBind({
        params: { issueNumber: 42 },
        toolCallId: "call-bind-fail",
      });
      assert.equal(failed.isError, true);
    });
    // Success path needs no gh — explicit prNumber.
    const succeeded = await executeCollectorBind({
      params: { prNumber: 77 },
      toolCallId: "call-bind-ok",
    });
    assert.equal(succeeded.isError, false);
    assert.equal(succeeded.details.prNumber, 77);

    await writeFile(
      sessionFile,
      `${[
        { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-bind-fail",
            toolName: COLLECTOR_BIND_TARGET_TOOL,
            isError: true,
            content: [{ type: "text", text: "multiple PRs associated with issue #42: 7, 9; pass an explicit prNumber or --pr" }],
            details: { code: "CollectorTargetBindError" },
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-bind-ok",
            toolName: COLLECTOR_BIND_TARGET_TOOL,
            isError: false,
            content: succeeded.content,
            details: succeeded.details,
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
      runId: "collector-bind-cleared",
      bookKey: "work",
      projectRoot: home,
      runDirectory,
      principal: fixturePrincipal(sessionDirectory, sessionFile),
      instruction: "bind then other work",
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
    assert.equal(terminal.roleOutcome.decisiveFacts.targetBindRejected, undefined);
    assert.equal(terminal.roleOutcome.decisiveFacts.targetBindDiagnostic, undefined);
    const stderr: string[] = [];
    presentFailureTerminal(terminal, { stdout: () => undefined, stderr: (t) => stderr.push(t) });
    assert.equal(stderr.length, 0, "cleared bind must not surface stale clarification on stderr");
  });
});

test("#676 J2 public entry: real bind-target unique issue→PR then accepted receipt", async () => {
  return await withTempRoot("collector-bind-unique-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
    await withFakeGh(home, uniquePrIssueGhScript(77), async () => {
      // Real execute proves unique association binds without --pr on the tool.
      const bind = await executeCollectorBind({
        params: { issueNumber: 42 },
        toolCallId: "call-bind-unique",
      });
      assert.equal(bind.isError, false);
      assert.equal(bind.details.prNumber, 77);
      assert.equal(bind.details.issueNumber, 42);

      const details = receipt({ prNumber: 77 });
      const result = await runAkRole(
        ["collector", "--repo", "acme/widgets", "--project", project, "Materials decide issue #42"],
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
              // Re-run real bind inside the public turn so the tool chain is not bypassed.
              const live = await executeCollectorBind({
                params: { issueNumber: 42 },
                toolCallId: "call-bind-live",
              });
              assert.equal(live.isError, false);
              assert.equal(live.details.prNumber, 77);
              const sessionFile = args[args.indexOf("--session") + 1]!;
              await writeFile(
                sessionFile,
                `${[
                  {
                    type: "message",
                    message: {
                      role: "toolResult",
                      toolCallId: live.toolCallId,
                      toolName: COLLECTOR_BIND_TARGET_TOOL,
                      isError: false,
                      content: live.content,
                      details: live.details,
                    },
                  },
                  {
                    type: "message",
                    message: {
                      role: "toolResult",
                      toolName: COLLECTOR_OUTPUT_TOOL,
                      isError: false,
                      details,
                    },
                  },
                ].map((row) => JSON.stringify(row)).join("\n")}\n`,
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
      assert.equal(result.terminal?.roleOutcome.decisiveFacts.prNumber, 77);
    });
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

test("#676 J2 explicit --pr is unique bound at admission", async () => {
  return await withTempRoot("collector-bound-", async (home) => {
    const project = join(home, "project");
    await mkdir(project);
    seedProject(project);
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
