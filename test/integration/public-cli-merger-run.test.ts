/**
 * #519 §5 shared public-cli real-entry tracer base.
 * One file, one subprocess entry helper, table-driven across 8 packaged roles.
 * Covers: accepted (alternate-host sealed→Terminal), post-seal, no-receipt,
 * infrastructure, merger residual Pi faults, and Pi singleton negatives.
 * Does not substitute createSubmissionLedgerHost unit rows for this seam.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test.after(() => { process.exitCode = undefined; });

import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import { emptyCollectorManifest } from "../../src/collector-config.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { GATEKEEPER_OUTPUT_TOOL, INSPECTOR_OUTPUT_TOOL } from "../../src/gatekeeper-role.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { loadPackagedMethodSkillMaterial } from "../../src/package-resources/method-skill.ts";
import { packagedRoleOutputTool } from "../../src/packaged-role-registry.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { writeRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import {
  NO_RECEIPT_LIFECYCLE_ENTRY_TYPE,
  noReceiptLifecycleFacts,
} from "../../src/receipt-delivery-policy.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
import {
  createSubmissionLedgerHost,
  readSealedSubmission,
} from "../../src/submission-ledger.ts";
import type { HostContext, HostToolDefinition, RoleHost, RoleTurnHost } from "../../src/host-contracts.ts";
import { packageRoot, runPiSubprocess, seedAgentDirModelsJsonFromFaux, withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
import { seatSelection, writeInstitutionalSeatTable } from "../helpers/institutional-seat-table.ts";
import {
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

function seedGitProject(root: string): void {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Public Table Test"]);
  git(root, ["config", "user.email", "public-table@test.local"]);
  git(root, ["commit", "--allow-empty", "-m", "seed"]);
}

async function conflictedRepository(root: string) {
  seedGitProject(root);
  await writeFile(join(root, "same.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["checkout", "-b", "source"]);
  await writeFile(join(root, "same.txt"), "source\n");
  git(root, ["commit", "-am", "source"]);
  const source = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "main"]);
  await writeFile(join(root, "same.txt"), "target\n");
  git(root, ["commit", "-am", "target"]);
  const target = git(root, ["rev-parse", "HEAD"]);
  assert.throws(() => git(root, ["merge", "--no-edit", "source"]));
  const blob = git(root, ["hash-object", "-w", "--stdin"], "resolved\n");
  const index = join(root, "expected-index");
  const indexEnv = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync("git", ["read-tree", "AUTO_MERGE^{tree}"], { cwd: root, env: indexEnv });
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},same.txt`], {
    cwd: root,
    env: indexEnv,
  });
  const tree = execFileSync("git", ["write-tree"], {
    cwd: root,
    env: indexEnv,
    encoding: "utf8",
  }).trim();
  const commit = execFileSync(
    "git",
    ["commit-tree", tree, "-p", target, "-p", source, "-m", "resolve"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    },
  ).trim();
  await writeFile(join(root, ".git/info/exclude"), "expected-index\n");
  return commit;
}

async function withSharedHome<T>(run: (home: string, project: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-role-table-"));
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const project = join(home, "work");
    await mkdir(project);
    seedGitProject(project);
    return await run(home, project);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

async function seedNotarySourceRun(home: string, project: string): Promise<string> {
  const runId = "01a034f1-75bf-71a6-bcf5-d1299145b1a5";
  const coords = issuePiDurablePrincipalCoordinates({
    cwd: project,
    runId,
    role: "judge",
    home,
  });
  await mkdir(coords.sessionDirectory, { recursive: true });
  const admittedRequestPath = join(coords.runDirectory, "admitted-request.json");
  await writeFile(
    coords.sessionFile,
    `${JSON.stringify({ type: "message", message: { role: "user", content: "draft" } })}\n`,
    "utf8",
  );
  await writeFile(
    admittedRequestPath,
    `${JSON.stringify({ role: "judge", runId })}\n`,
    "utf8",
  );
  await writeRoleRunState(coords.runDirectory, {
    runId,
    role: "judge",
    state: "terminal",
    bookKey: coords.bookKey,
    projectRoot: project,
    sessionDirectory: coords.sessionDirectory,
    sessionFile: coords.sessionFile,
    admittedRequestPath,
  });
  return await realpath(coords.runDirectory);
}

async function seedDoctorIssue(home: string, project: string, issueNumber: number): Promise<void> {
  const { resolveBookKeyFromGit } = await import("../../src/activation-ledger-git.ts");
  const key = resolveBookKeyFromGit(project);
  const runs = join(home, ".ak-roles", "books", key, "issues", String(issueNumber), "runs");
  await mkdir(join(runs, "review-001", "session"), { recursive: true });
  await writeFile(join(runs, "review-001", "session", "leg.jsonl"), "{}\n", "utf8");
}

function collectorReceipt() {
  const manifest = emptyCollectorManifest();
  return {
    host: "github.com" as const,
    repository: "acme/widgets",
    prNumber: 3,
    manifestDigest: manifest.digest,
    activationTime: "2026-01-01T00:00:00.000Z",
    deadlineTime: "2026-01-01T00:15:00.000Z",
    finalObservationTime: "2026-01-01T00:01:00.000Z",
    finalSnapshotId: "snap-1",
    targetHead: "9".repeat(40),
    groups: [] as Array<Record<string, unknown>>,
    requestAttempts: [] as unknown[],
    snapshots: [] as unknown[],
    evidenceRecords: [] as unknown[],
  };
}

function reviewerReceipt() {
  return {
    version: 2 as const,
    status: "completed" as const,
    acceptedBatch: {
      identity: "dispatch",
      legs: [{ axis: "standards" as const, prompt: { text: "s\n" } }],
    },
    reports: { standards: { text: "ok" } },
    outcomes: {
      standards: {
        status: "successful",
        prompt: { text: "s\n" },
        workspaceDisposition: "deleted",
      },
    },
    identities: {
      canonicalSkill: { text: "skill\n" },
      construction: { recipe: "reviewer-common-bundle-v1" },
      target: {
        repositoryRoot: "/repo",
        objectFormat: "sha1",
        targetHead: "a".repeat(40),
        refs: { tag: { objectId: "b".repeat(40), peeledCommitId: null } },
      },
    },
  };
}

type AcceptedRow = {
  readonly role: TerminalRoleName;
  readonly status: string;
  readonly args: (project: string, home: string) => Promise<string[]> | string[];
  readonly details: (ctx: {
    project: string;
    home: string;
    runId: string;
    args: readonly string[];
  }) => Promise<unknown> | unknown;
  readonly sessionLines?: (ctx: {
    project: string;
    home: string;
    runId: string;
    details: unknown;
  }) => Promise<string[]> | string[];
};

function hostNeutralTypedTurn(options: {
  role: TerminalRoleName;
  runId: string;
  details: unknown;
  sessionLines?: readonly string[];
  turns?: readonly (readonly { id: string; kind: "output" | "sibling" }[])[];
  onRejection?: (rejection: unknown) => void;
  postSealAction?: boolean;
  stopAfterCandidate?: "end" | "failure";
}): RoleTurnHost {
  return {
    async executeTurn(request) {
      let registered: HostToolDefinition | undefined;
      const handlers = new Map<string, (...values: any[]) => unknown>();
      const host = {
        registerTool(tool: HostToolDefinition) { registered = tool; },
        on(event: string, handler: (...values: any[]) => unknown) { handlers.set(event, handler); },
        async deliverSubmissionRejection(rejection: unknown) { options.onRejection?.(rejection); },
      } as RoleHost;
      const outputTool = packagedRoleOutputTool(options.role)!;
      const pipeline = createSubmissionLedgerHost(host, new Map([[outputTool, options.role]]));
      pipeline.registerTool({
        name: outputTool,
        label: "output",
        description: "",
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: options.details, terminate: true }),
      });
      const coordinates = piDurablePrincipalAuthority.decode(request.principal);
      await mkdir(join(coordinates.sessionFile, ".."), { recursive: true });
      await writeFile(
        coordinates.sessionFile,
        options.sessionLines === undefined ? "" : `${options.sessionLines.join("\n")}\n`,
        "utf8",
      );
      const context = {
        cwd: request.cwd,
        mode: "json",
        model: undefined,
        sessionManager: {
          getHeader: () => ({ type: "session", id: `${options.runId}:alternate-host` }),
          appendCustomEntry(customType: string, data: unknown) {
            appendFileSync(coordinates.sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`, "utf8");
          },
        },
        abort() {},
      } as HostContext;
      const priorRun = process.env.AK_ROLE_RUN_DIR;
      process.env.AK_ROLE_RUN_DIR = request.runDirectory;
      try {
        const turns = options.turns ?? [[{ id: "t1", kind: "output" as const }]];
        for (const [turnIndex, turn] of turns.entries()) {
          const calls = turn.map(({ id, kind }) => ({
            toolCallId: id,
            toolName: kind === "output" ? outputTool : INSPECTOR_OUTPUT_TOOL,
          }));
          for (const call of calls) {
            await handlers.get("tool_execution_start")!(call, context);
          }
          for (const { id, kind } of turn) {
            if (kind === "output") {
              const result = await registered!.execute(id, {}, undefined, undefined, context) as {
                content: unknown;
                details: unknown;
              };
              await appendFile(coordinates.sessionFile, `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: id,
                  toolName: outputTool,
                  isError: false,
                  content: result.content,
                  details: result.details,
                },
              })}\n`, "utf8");
            }
          }
          if (options.stopAfterCandidate !== undefined) {
            if (options.stopAfterCandidate === "failure") {
              return {
                code: 1,
                stderr: "host failed after output candidate",
                timedOut: false,
                knownFailure: {
                  cause: "session",
                  identity: { name: "AlternateHostSessionFailure", code: "candidate-unclosed" },
                },
              };
            }
            context.sessionManager.appendCustomEntry!(
              NO_RECEIPT_LIFECYCLE_ENTRY_TYPE,
              noReceiptLifecycleFacts({
                terminalToolCalled: true,
                rejectedReceipts: [],
                deliveryTurns: 2,
                runPointer: request.runDirectory,
                attemptPointer: `current:${request.runDirectory}`,
              }),
            );
            return { code: 0, stderr: "", timedOut: false };
          }
          await handlers.get("turn_end")!({ turnIndex, calls }, context);
        }
        if (options.postSealAction === true) {
          const late = { toolCallId: "after-seal", toolName: outputTool };
          await handlers.get("tool_execution_start")!(late, context);
        }
      } finally {
        if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
      }
      return { code: 0, stderr: "", timedOut: false };
    },
  };
}

/** Shared public entry backed by a host-neutral typed-turn runtime for every accepted row. */
async function runAcceptedRow(row: AcceptedRow, home: string, project: string) {
  const runId = `run-table-${row.role}-accepted`;
  const args = await row.args(project, home);
  const details = await row.details({ project, home, runId, args });
  const sessionLines = row.sessionLines
    ? await row.sessionLines({ project, home, runId, details })
    : undefined;
  const { io, stderr } = captureIo();
  const result = await runAkRole(args, {
    packageRoot,
    home,
    cwd: project,
    createRunId: () => runId,
    credentials: { "openai-codex": true, xai: false },
    io,
    roleTurnHost: hostNeutralTypedTurn({
      role: row.role,
      runId,
      details,
      ...(sessionLines === undefined ? {} : { sessionLines }),
    }),
  });
  return { result, runId, stderr: stderr.join("") };
}

const ACCEPTED_ROWS: readonly AcceptedRow[] = [
  {
    role: "judge",
    status: "converged",
    args: (project) => ["judge", "--project", project, "Decide."],
    details: () => ({ judgeStatus: "converged" }),
  },
  {
    role: "coder",
    status: "completed",
    args: (project) => ["coder", "--project", project, "Implement."],
    details: () => ({
      status: "completed",
      report: "TDD red/green evidence complete.",
    }),
  },
  {
    role: "fixer",
    status: "planned",
    args: (project) => ["fixer", "plan", "--project", project, "Plan the repair."],
    details: () => ({ status: "planned", report: "Inspect root cause first." }),
  },
  {
    role: "reviewer",
    status: "completed",
    args: (project) => ["reviewer", "--base", "HEAD", "--project", project],
    details: () => reviewerReceipt(),
  },
  {
    role: "doctor",
    status: "refused",
    args: async (project, home) => {
      await seedDoctorIssue(home, project, 40);
      return ["doctor", "--issue", "40", "--project", project, "diagnose"];
    },
    details: () => ({
      status: "refused",
      reason: "missing evidence",
      missingEvidence: [{ need: "leg", targetKeys: ["review-001"] }],
    }),
  },
  {
    role: "merger",
    status: "escalate",
    args: async (project) => {
      await conflictedRepository(project);
      return ["merger", "--project", project, "Escalate incompatible intents."];
    },
    details: ({ runId }) => ({
      status: "escalate",
      attemptId: runId,
      diagnosis: "new product decision",
      report: "both authorized intents cannot coexist",
    }),
    sessionLines: async () => {
      const material = await loadPackagedMethodSkillMaterial(
        packageRoot,
        "resolving-merge-conflicts",
      );
      const expansion = `<skill name="resolving-merge-conflicts" location="${material.skillPath}">\nbody\n</skill>\n\nEscalate.`;
      return [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: expansion }] },
        }),
      ];
    },
  },
  {
    role: "notary",
    status: "pass",
    args: async (project, home) => {
      const source = await seedNotarySourceRun(home, project);
      return ["notary", "--source-run", source];
    },
    details: () => ({ status: "pass", findings: [] }),
  },
  {
    role: "countersign",
    status: "converged",
    args: (project) => ["countersign", "--project", project, "裁：本票是否足以开工。"],
    details: () => ({ countersignStatus: "converged", findings: [] }),
  },
  {
    role: "collector",
    status: "collected",
    args: (project) => [
      "collector",
      "--pr",
      "3",
      "--repo",
      "acme/widgets",
      "--project",
      project,
    ],
    details: () => collectorReceipt(),
  },
];

test("public-cli every packaged role accepts via shared sealed→Terminal entry", { timeout: 180_000 }, async () => {
  await withSharedHome(async (home, project) => {
    for (const row of ACCEPTED_ROWS) {
      // Fresh project state per row when merger mutates the worktree.
      if (row.role === "merger") {
        await rm(project, { recursive: true, force: true });
        await mkdir(project);
        seedGitProject(project);
      }
      const { result, stderr } = await runAcceptedRow(row, home, project);
      assert.equal(result.exitCode, 0, `${row.role} exit: ${stderr}`);
      assert.equal(result.terminal?.roleOutcome.kind, "accepted", `${row.role}: ${stderr}`);
      assert.equal(result.terminal?.roleOutcome.role, row.role, row.role);
      assert.equal(result.terminal?.roleOutcome.status, row.status, row.role);
    }
  });
});

test("host-neutral typed turns reject non-sole output and accept same-session retry", async () => {
  await withSharedHome(async (home, project) => {
    for (const row of [
      {
        name: "output+sibling",
        turns: [
          [{ id: "first", kind: "output" as const }, { id: "sibling", kind: "sibling" as const }],
          [{ id: "retry", kind: "output" as const }],
        ],
      },
      {
        name: "double-output",
        turns: [
          [{ id: "first", kind: "output" as const }, { id: "second", kind: "output" as const }],
          [{ id: "retry", kind: "output" as const }],
        ],
      },
    ]) {
      const runId = `run-host-neutral-${row.name}`;
      const rejections: unknown[] = [];
      const { io } = captureIo();
      const result = await runAkRole(["judge", "--project", project, "Decide."], {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        credentials: { "openai-codex": true, xai: false },
        io,
        roleTurnHost: hostNeutralTypedTurn({
          role: "judge",
          runId,
          details: { judgeStatus: "converged" },
          turns: row.turns,
          onRejection: (rejection) => rejections.push(rejection),
        }),
      });
      assert.equal(rejections.length, 1, row.name);
      assert.deepEqual(rejections[0], {
        kind: "correctable-rejection",
        code: "non-sole-round",
        toolCallIds: row.name === "double-output" ? ["first", "second"] : ["first"],
      });
      assert.equal(result.terminal?.roleOutcome.kind, "accepted", row.name);
      assert.equal((await readSealedSubmission(project, runId))?.role, "judge", row.name);
    }
  });
});

test("public-cli shared entry covers post-seal, no-receipt, and infrastructure", { timeout: 120_000 }, async () => {
  await withSharedHome(async (home, project) => {
    // no-receipt: output candidate exists, but the host ends without typed closure
    {
      const { io } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, "No receipt."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-table-no-receipt",
          credentials: { "openai-codex": true, xai: false },
          io,
          roleTurnHost: hostNeutralTypedTurn({
            role: "judge",
            runId: "run-table-no-receipt",
            details: { judgeStatus: "converged" },
            stopAfterCandidate: "end",
          }),
        },
      );
      assert.equal(result.exitCode, 0, JSON.stringify(result.terminal?.roleOutcome));
      assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
      if (result.terminal?.roleOutcome.kind !== "no_receipt") throw new Error("expected no-receipt outcome");
      assert.equal(result.terminal.roleOutcome.terminalToolCalled, true);
      assert.deepEqual(result.terminal.roleOutcome.rejectedReceipts, []);
      assert.equal(result.terminal.roleOutcome.deliveryTurns, 2);
      assert.equal(
        result.terminal.roleOutcome.sessionCompletion,
        "settled-without-accepted-receipt",
      );
      assert.equal(result.terminal.roleOutcome.acceptedReceipt, false);
      assert.equal(await readSealedSubmission(project, "run-table-no-receipt"), undefined);
    }

    // infrastructure: output candidate exists, then the host fails before typed closure
    {
      const { io } = captureIo();
      const result = await runAkRole(
        ["coder", "--project", project, "Infra fail."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-table-infrastructure",
          credentials: { "openai-codex": true, xai: false },
          io,
          roleTurnHost: hostNeutralTypedTurn({
            role: "coder",
            runId: "run-table-infrastructure",
            details: { status: "completed", report: "candidate before failure" },
            stopAfterCandidate: "failure",
          }),
        },
      );
      assert.equal(result.exitCode, 1);
      assert.equal(result.terminal?.roleOutcome.kind, "failure");
      if (result.terminal?.roleOutcome.kind !== "failure") throw new Error("expected failure outcome");
      assert.equal(result.terminal.roleOutcome.cause, "session");
      assert.equal(
        result.terminal.roleOutcome.decisiveFacts.errorName,
        "AlternateHostSessionFailure",
      );
      assert.equal(result.terminal.roleOutcome.decisiveFacts.errorCode, "candidate-unclosed");
      assert.equal(await readSealedSubmission(project, "run-table-infrastructure"), undefined);
      process.exitCode = undefined;
    }

    // post-seal action is observed by the same typed-turn adapter and blocks ordinary success.
    {
      const runId = "run-table-post-seal";
      const { io } = captureIo();
      const result = await runAkRole(["judge", "--project", project, "Decide."], {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        credentials: { "openai-codex": true, xai: false },
        io,
        roleTurnHost: hostNeutralTypedTurn({
          role: "judge",
          runId,
          details: { judgeStatus: "converged" },
          postSealAction: true,
        }),
      });
      assert.notEqual(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal(await readSealedSubmission(project, runId), undefined);
    }
  });
});

/** Merger residual Pi real-entry (existing §5 case — single-fault residuals). */
async function tracePublicMerger(residual?: "sole" | "sibling" | "wrong-attempt") {
  const providerPath = resolve(packageRoot, "test/fixtures/merger-baseline-provider.ts");
  const home = await mkdtemp(join(tmpdir(), `ak-public-merger-${residual ?? "accepted"}-`));
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const project = join(home, "work");
    await mkdir(project);
    const commit = await conflictedRepository(project);
    return await runAkRole(
      [
        "merger",
        "--model",
        "ak-merger-baseline/faux-1",
        "--thinking",
        "off",
        "--project",
        project,
        "Resolve the ordinary conflict.",
      ],
      {
        packageRoot,
        home,
        agentDir: join(home, ".pi", "agent"),
        cwd: project,
        createRunId: () => `run-merger-baseline-public-${residual ?? "accepted"}`,
        mergerExtraPiArgs: ["-e", providerPath],
        mergerTimeoutMs: 90_000,
        io: { stdout() {}, stderr() {} },
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args, options) => {
            const runId = `run-merger-baseline-public-${residual ?? "accepted"}`;
            const run = await runPiSubprocess([...args], {
              cwd: options.cwd,
              timeoutMs: options.timeoutMs ?? 90_000,
              env: {
                ...options.env,
                PI_OFFLINE: "1",
                AK_MERGER_FIXTURE_COMMIT: commit,
                AK_MERGER_FIXTURE_ATTEMPT_ID: runId,
                ...(residual === undefined ? {} : { AK_MERGER_FIXTURE_RESIDUAL: residual }),
              },
            });
            return {
              code: run.code,
              stdout: run.stdout,
              stderr: run.stderr,
              timedOut: run.localTimeout,
              args: [...args],
            };
          },
          extraPiArgs: ["-e", providerPath],
        }),
      },
    );
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
}

test("public Merger residual failure precedence stays on the shared table", { timeout: 240_000 }, async () => {
  for (const residual of ["sole", "sibling", "wrong-attempt"] as const) {
    const result = await tracePublicMerger(residual);
    const outcome = result.terminal?.roleOutcome;
    assert.equal(outcome?.role, "merger", residual);
    assert.notEqual(result.exitCode, 0, residual);
    assert.notEqual(outcome?.decisiveFacts.acceptedReceipt, true, residual);
    assert.equal(outcome?.kind, residual === "sole" ? "incomplete" : "failure", residual);
  }
});

test("public Merger accepts a clean completed merge on the shared table", { timeout: 240_000 }, async () => {
  const result = await tracePublicMerger();
  assert.equal(result.exitCode, 0);
  assert.equal(result.terminal?.roleOutcome.kind, "accepted");
  assert.equal(result.terminal?.roleOutcome.status, "completed");
});

/**
 * Pi real-entry singleton table — deleted judge/fixer direct-execute sole-call
 * negatives graduate here (not collector-only).
 */
test("Pi real-entry singleton table rejects non-sole-final for packaged roles", { timeout: 120_000 }, async () => {
  const rows = [
    {
      role: "judge" as const,
      tool: JUDGE_OUTPUT_TOOL_NAME,
      flags: (home: string) => ({ "ak-role": "judge" }),
      outputArgs: { judgeStatus: "converged" },
      extension: () =>
        createPiRoleRuntimeExtension({
          loadJudgeSoul: async () => "# Judge\nDecide.",
          auditSoulCompliance: async () => ({ status: "pass" }),
        }),
    },
    {
      role: "fixer" as const,
      tool: FIXER_OUTPUT_TOOL_NAME,
      flags: (home: string) => ({
        "ak-role": "fixer",
        "ak-fixer-phase": "plan",
        "ak-fix-packet": join(home, "fix-packet.md"),
      }),
      outputArgs: { status: "planned", report: "plan only" },
      extension: () =>
        createPiRoleRuntimeExtension({
          loadJudgeSoul: async () => "judge",
          loadFixerSoul: async () => "# Fixer\nPlan.",
          loadFixPacket: async () => "# Repair instructions\n",
          auditSoulCompliance: async () => ({ status: "pass" }),
        }),
    },
  ] as const;

  for (const row of rows) {
    await withActivationHome({ prefix: `ak-pi-singleton-${row.role}-` }, async ({ agentDir, home }) => {
      // Fixer needs a git cwd + packet file for activation.
      const work = join(home, "work");
      await mkdir(work, { recursive: true });
      seedGitProject(work);
      if (row.role === "fixer") {
        await writeFile(join(home, "fix-packet.md"), "# Repair\n", "utf8");
      }
      const faux = fauxProvider({
        api: `singleton-${row.role}`,
        provider: `singleton-${row.role}`,
        tokenSize: { min: 1000, max: 1000 },
      });
      const seededModels = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
      await writeInstitutionalSeatTable(work, {
        gatekeeper: seatSelection(`singleton-${row.role}`, `singleton-${row.role}`),
        inspector: seatSelection(`singleton-${row.role}`, `singleton-${row.role}`),
      });
      let rejectionObservedByModel = false;
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall(row.tool, row.outputArgs, { id: "output" }),
            fauxToolCall("read", { path: "x" }, { id: "sibling" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "inspector" }, { id: "gate-1" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          fauxToolCall(INSPECTOR_OUTPUT_TOOL, { status: "pass", findings: [] }, { id: "inspect-1" }),
          { stopReason: "toolUse" },
        ),
        async (context: any) => {
          rejectionObservedByModel = context.messages.filter((message: any) => message.role === "user").length > 1;
          return fauxAssistantMessage(
            [fauxToolCall(row.tool, row.outputArgs, { id: "retry-output" })],
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage(
          fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "inspector" }, { id: "gate-2" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          fauxToolCall(INSPECTOR_OUTPUT_TOOL, { status: "pass", findings: [] }, { id: "inspect-2" }),
          { stopReason: "toolUse" },
        ),
      ] as any);
      try {
        await withInProcessPi(
        {
          activationLedgerSession: true,
          cwd: work,
          agentDir,
          faux,
          modelsPath: null,
          extensionFactories: [row.extension()],
          noExtensions: true,
          systemPrompt: "BASE",
          mode: "print",
          noTools: "builtin",
          flags: row.flags(home),
        },
        async ({ session, sessionManager }) => {
          await session.prompt("start");
          const entries = sessionManager.getEntries() as any[];
          const output = entries.find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolName === row.tool,
          );
          assert.deepEqual(
            output?.message.details,
            { submissionDisposition: "pending-round-closure" },
            `${row.role} remains pending until typed turn closure`,
          );
          assert.equal(rejectionObservedByModel, true, `${row.role} receives the rejection before retrying`);
          const headerId = sessionManager.getHeader?.()?.id;
          const sealed = headerId === undefined ? undefined : await readSealedSubmission(work, headerId);
          assert.equal(sealed?.role, row.role, `${row.role} retry on the same durable session seals`);
        },
        );
      } finally {
        await seededModels.close();
      }
    });
  }
});
