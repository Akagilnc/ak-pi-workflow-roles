import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
/**
 * #519 §5 shared public-cli real-entry tracer base.
 * One file, one subprocess entry helper, table-driven across 8 packaged roles.
 * Covers: accepted (alternate-host sealed→Terminal), post-seal, no-receipt,
 * and infrastructure. Real-Pi residual/singleton legs culled (#685).
 * Does not substitute createSubmissionLedgerHost unit rows for this seam.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

test.after(() => { process.exitCode = undefined; });

import { emptyCollectorManifest } from "../../src/collector-config.ts";
import { INSPECTOR_OUTPUT_TOOL } from "../../src/gatekeeper-role.ts";
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
import { payloadStatus, payloadStatusSequence } from "../helpers/terminal-payload.ts";
import {
  createSubmissionLedgerHost,
  hasRecordedSubmission,
  readRecordedSubmissionRows,
} from "../../src/submission-ledger.ts";
import type { HostContext, HostToolDefinition, RoleHost, RoleTurnHost } from "../../src/host-contracts.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
  withNestedTrueUnboundDiarist,
} from "../helpers/role-turn-host-fixture.ts";
import { Type } from "typebox";

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
  return await withTempRoot("ak-public-role-table-", async (home) => {
    const project = join(home, "work");
    await mkdir(project);
    seedGitProject(project);
    return await run(home, project);
  });
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
    deadlineTime: "2026-01-01T00:10:00.000Z",
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
  readonly status: string | undefined;
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
      // #604: expose principal session under home/.ak-roles so submission-ledger
      // path-derives package home — never falls through to real books/<basename(cwd)>.
      const context = {
        cwd: request.cwd,
        mode: "json",
        model: undefined,
        runDirectory: request.runDirectory,
        ...(request.courtAttemptId === undefined ? {} : { courtAttemptId: request.courtAttemptId }),
        sessionManager: {
          getHeader: () => ({ type: "session", id: `${options.runId}:alternate-host` }),
          getSessionFile: () => coordinates.sessionFile,
          getSessionDir: () => coordinates.sessionDirectory,
          appendCustomEntry(customType: string, data: unknown) {
            appendFileSync(coordinates.sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`, "utf8");
          },
        },
        abort() {},
      } as HostContext;
      const turns = options.turns ?? [[{ id: "t1", kind: "output" as const }]];
        for (const [turnIndex, turn] of turns.entries()) {
          const calls = turn.map(({ id, kind }) => ({
            toolCallId: id,
            toolName: kind === "output" ? outputTool : INSPECTOR_OUTPUT_TOOL,
          }));
          for (const call of calls) {
            // #836: tool_execution_start post-seal anomaly path deleted; optional if present.
            await handlers.get("tool_execution_start")?.(call, context);
          }
          for (const { id, kind } of turn) {
            if (kind === "output") {
              // #836: LLM params are the ledger payload — pass details as params.
              const result = await registered!.execute(id, options.details, undefined, undefined, context) as {
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
        await handlers.get("tool_execution_start")?.(late, context);
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
    roleTurnHost: withNestedTrueUnboundDiarist(
      hostNeutralTypedTurn({
        role: row.role,
        runId,
        details,
        ...(sessionLines === undefined ? {} : { sessionLines }),
      }),
    ),
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
    // #836: collector has no status leaf — do not invent "collected" or "".
    status: undefined,
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
      assert.deepEqual(
        result.terminal ? payloadStatusSequence(result.terminal.roleOutcome) : [],
        row.status === undefined ? [] : [row.status],
        row.role,
      );
    }
  });
});

test("host-neutral typed turns record every terminating submission without sole reject (#836)", async () => {
  await withSharedHome(async (home, project) => {
    const runId = "run-multi-submit-836";
    const first = { judgeStatus: "continue", report: "first-submit" };
    const second = { judgeStatus: "converged", report: "second-submit" };
    const { io } = captureIo();
    const payloads = [first, second];
    let payloadIndex = 0;
    const host: RoleTurnHost = {
      async executeTurn(request) {
        let registered: HostToolDefinition | undefined;
        const handlers = new Map<string, (...values: any[]) => unknown>();
        const fakeHost = {
          registerTool(tool: HostToolDefinition) { registered = tool; },
          on(event: string, handler: (...values: any[]) => unknown) { handlers.set(event, handler); },
        } as RoleHost;
        const outputTool = packagedRoleOutputTool("judge")!;
        createSubmissionLedgerHost(fakeHost, new Map([[outputTool, "judge" as const]])).registerTool({
          name: outputTool,
          label: "output",
          description: "",
          parameters: {},
          execute: async (_id, params) => ({ content: [], details: params, terminate: true }),
        });
        const coordinates = piDurablePrincipalAuthority.decode(request.principal);
        await mkdir(join(coordinates.sessionFile, ".."), { recursive: true });
        await writeFile(coordinates.sessionFile, "", "utf8");
        const context = {
          cwd: request.cwd,
          mode: "json",
          model: undefined,
          runDirectory: request.runDirectory,
          ...(request.courtAttemptId === undefined ? {} : { courtAttemptId: request.courtAttemptId }),
          sessionManager: {
            getHeader: () => ({ type: "session", id: `${runId}:attempt` }),
            getSessionFile: () => coordinates.sessionFile,
            getSessionDir: () => coordinates.sessionDirectory,
            appendCustomEntry(customType: string, data: unknown) {
              appendFileSync(coordinates.sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`, "utf8");
            },
          },
          abort() {},
        } as HostContext;
        for (const payload of payloads) {
            const id = `call-${payloadIndex++}`;
            await registered!.execute(id, payload, undefined, undefined, context);
            await appendFile(coordinates.sessionFile, `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolCallId: id,
                toolName: outputTool,
                isError: false,
                details: payload,
              },
            })}\n`, "utf8");
          }
        await handlers.get("turn_end")?.({
          turnIndex: 0,
          calls: payloads.map((_, i) => ({ toolCallId: `call-${i}`, toolName: outputTool })),
        }, context);
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const result = await runAkRole(
      ["judge", "--project", project, "two submissions"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        credentials: { "openai-codex": true, xai: false },
        io,
        roleTurnHost: host,
      },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result.terminal?.roleOutcome));
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(result.terminal ? payloadStatusSequence(result.terminal.roleOutcome) : [], ["continue", "converged"]);
    const recorded =
      result.terminal?.roleOutcome.kind === "accepted"
        ? result.terminal.roleOutcome.payloads
        : undefined;
    assert.ok(recorded, "role result block must carry original payloads");
    assert.equal(recorded.length, 2);
    assert.deepEqual(recorded[0], first);
    assert.deepEqual(recorded[1], second);
  });
});


test("public-cli shared entry covers post-seal, no-receipt, and infrastructure", { timeout: 120_000 }, async () => {
  await withSharedHome(async (home, project) => {
    // Zero submissions: host ends cleanly → no_receipt, exit 0.
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
            turns: [],
          }),
        },
      );
      assert.equal(result.exitCode, 0, JSON.stringify(result.terminal?.roleOutcome));
      assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
    }

    // Host fails after a recorded submission: failure + original payload coexist.
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
      assert.equal(result.exitCode, 1, JSON.stringify(result.terminal?.roleOutcome));
      assert.equal(result.terminal?.roleOutcome.kind, "failure");
      assert.ok(await hasRecordedSubmission(project, "run-table-infrastructure", home));
      assert.ok(result.terminal?.submissions?.some((row) =>
        typeof row === "object" && row !== null && (row as { report?: unknown }).report === "candidate before failure",
      ), JSON.stringify(result.terminal?.submissions));
      process.exitCode = undefined;
    }

    // post-seal action is observed (anomaly on ledger) but must not erase the seal (#833).
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
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal((await readRecordedSubmissionRows(project, runId, home)).at(-1)?.role, "judge");
    }
  });
});
