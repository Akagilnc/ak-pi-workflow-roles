import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
/**
 * #106 end-to-end: ak-role judge → existing Judge gate (real Pi + faux provider)
 * → one Terminal result with registry-rendered Navigator command.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { NO_RECEIPT_LIFECYCLE_ENTRY_TYPE } from "../../src/receipt-delivery-policy.ts";
import { readSitianRecords, resolveSitianRecordPath } from "../../src/sitian-facade.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { settleJudgeTerminalResult } from "../../src/public-cli/settlement.ts";
import {
  buildNavigatorInfrastructureFailureFact,
  JUDGE_OUTPUT_TOOL_NAME,
} from "../../src/role-runtime.ts";

import {
  packageRoot,
  piCli,
  runPiSubprocess,
} from "../helpers/pi-test-harness.ts";

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "judge-e2e@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Judge E2E"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

test(
  "public Coder entry settles rejected and never-called abandonment as typed no-receipt",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-public-primary-no-receipt-"));
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const agentDir = join(home, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "navigator-model.json"),
        `${JSON.stringify({ model: "ak-primary-no-receipt/faux-1" })}\n`,
      );
      const providerPath = resolve(
        packageRoot,
        "test/fixtures/primary-no-receipt-provider.ts",
      );
      const bookKey = resolveBookKeyFromGit(project);

      for (const scenario of [
        { mode: "rejected", runId: "run-primary-rejected-001", requests: 1 },
        { mode: "never-called", runId: "run-primary-never-called-001", requests: 2 },
      ] as const) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const result = await runAkRole(
          [
            "coder",
            "--model",
            "ak-primary-no-receipt/faux-1",
            "--thinking",
            "off",
            "--project",
            project,
            "Exercise bounded receipt delivery.",
          ],
          {
            packageRoot,
            home,
            agentDir,
            cwd: project,
            createRunId: () => scenario.runId,
            coderExtraPiArgs: ["-e", providerPath],
            coderTimeoutMs: 90_000,
            io: {
              stdout: (text) => stdout.push(text),
              stderr: (text) => stderr.push(text),
            },
          },
        );

        assert.equal(result.exitCode, 0, stderr.join(""));
        assert.equal(stdout.length, 1, "public Terminal emits one result");
        assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
        const outcome = result.terminal!.roleOutcome;
        if (outcome.kind !== "no_receipt") throw new Error("expected no-receipt outcome");
        assert.equal(outcome.acceptedReceipt, false);
        assert.equal(outcome.deliveryTurns, 2);
        assert.equal(outcome.terminalToolCalled, scenario.mode === "rejected");
        assert.deepEqual(
          outcome.rejectedReceipts,
          scenario.mode === "rejected" ? [{ reason: "未观察到 commit", diagnosticAvailable: true }] : [],
        );

        const runDirectory = join(
          home,
          ".ak-roles",
          "books",
          bookKey,
          "runs",
          `${scenario.runId}@coder`,
        );
        assert.equal(outcome.runPointer, runDirectory);
        assert.equal(outcome.attemptPointer, `current:${runDirectory}`);
        const rows = (await readFile(join(runDirectory, "session", "session.jsonl"), "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as any);
        const deliveryRequests = rows.filter((row) =>
          row.customType === "ak-receipt-delivery-request" ||
          row.message?.customType === "ak-receipt-delivery-request"
        );
        assert.equal(deliveryRequests.length, scenario.requests, "bounded budget emits no third request");
        const lifecycle = rows.filter((row) =>
          row.customType === NO_RECEIPT_LIFECYCLE_ENTRY_TYPE ||
          row.message?.customType === NO_RECEIPT_LIFECYCLE_ENTRY_TYPE
        );
        assert.equal(lifecycle.length, 1);
        assert.equal(stdout.join("").includes("acceptedReceipt"), true);
        assert.equal(stdout.join("").includes("false"), true);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "public Coder aborted stop stays on infrastructure nonzero without receipt delivery",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-public-primary-aborted-"));
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const providerPath = resolve(packageRoot, "test/fixtures/primary-no-receipt-provider.ts");
      const result = await runAkRole([
        "coder", "--model", "ak-primary-no-receipt/faux-1", "--thinking", "off",
        "--project", project, "Exercise aborted infrastructure settlement.",
      ], {
        packageRoot, home, agentDir: join(home, ".pi", "agent"), cwd: project,
        createRunId: () => "run-primary-aborted-001",
        coderExtraPiArgs: ["-e", providerPath], coderTimeoutMs: 90_000,
        io: { stdout() {}, stderr() {} },
      });
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "failure");
      const runDirectory = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project), "runs", "run-primary-aborted-001@coder");
      const rows = (await readFile(join(runDirectory, "session", "session.jsonl"), "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line) as any);
      assert.equal(rows.some((row) => row.customType === "ak-receipt-delivery-request" || row.message?.customType === "ak-receipt-delivery-prompt"), false);
      assert.equal(rows.some((row) => row.customType === NO_RECEIPT_LIFECYCLE_ENTRY_TYPE || row.message?.customType === NO_RECEIPT_LIFECYCLE_ENTRY_TYPE), false);
    } finally { await rm(home, { recursive: true, force: true }); }
  },
);

test(
  "ak-role Judge settles retained unreadable compliance on the failure channel",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-public-cli-judge-unreadable-"));
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const providerPath = resolve(
        packageRoot,
        "test/fixtures/audit-failure-provider.ts",
      );
      const result = await runAkRole(
        [
          "judge",
          "--model",
          "ak-audit-failure/faux-1",
          "--thinking",
          "off",
          "--project",
          project,
          "Retain the original Judge candidate.",
        ],
        {
          packageRoot,
          home,
          agentDir: join(home, ".pi", "agent"),
          cwd: project,
          createRunId: () => "run-e2e-judge-unreadable-001",
          judgeExtraPiArgs: ["-e", providerPath],
          judgeTimeoutMs: 90_000,
          io: {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text),
          },
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            const subprocess = await runPiSubprocess([...args], {
              cwd: options.cwd,
              env: {
                ...options.env,
                PI_OFFLINE: "1",
                AK_AUDIT_UNKNOWN_STATUS: "1",
              },
              timeoutMs: options.timeoutMs ?? 90_000,
            });
            return {
              code: subprocess.code,
              stdout: subprocess.stdout,
              stderr: subprocess.stderr,
              timedOut: subprocess.localTimeout,
              args: [...args],
            };
          },
            extraPiArgs: ["-e", providerPath],
          }),
        },
      );

      assert.equal(result.exitCode, 1, stderr.join("") || "unreadable audit unexpectedly succeeded");
      assert.equal(stdout.length, 1);
      assert.ok(result.terminal);
      const outcome = result.terminal!.roleOutcome;
      assert.equal(outcome.kind, "failure");
      if (outcome.kind !== "failure") throw new Error("expected failure outcome");
      assert.equal(outcome.role, "judge");
      // Unreadable compliance is infrastructure/output failure, not a judgment status (#475).
      assert.equal(outcome.cause, "output");
      assert.deepEqual(outcome.decisiveFacts.secondaryEvidence, {
        kind: "role_infrastructure_failure",
        source: "shared-role-lifecycle",
        reasonCode: "host_failure",
        observation: { kind: "object-status-unreadable", status: "unknown" },
        candidate: { status: "mystery", retained: "raw auditor candidate" },
        exitCode: 1,
      });

      const bookKey = resolveBookKeyFromGit(project);
      const runDir = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-e2e-judge-unreadable-001@judge",
      );
      const sessionFile = join(runDir, "session", "session.jsonl");
      const rows = (await readFile(sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as any);
      const recordFile = resolveSitianRecordPath({
        level: "event",
        kind: "auditor",
        cwd: project,
        sessionParent: sessionFile,
      }).recordFile;
      const retained = (await readSitianRecords(recordFile)).records.flatMap((record) => {
        const payload = record.payload as { response?: { content?: any[] } } | undefined;
        return payload?.response === undefined ? [] : [payload.response];
      });
      assert.ok(retained.length >= 1, "retained auditor response must still land");
      const retainedResponse = retained[0];
      assert.ok(retainedResponse);
      const retainedCall = retainedResponse.content?.find(
        (part: any) => part.type === "toolCall",
      );
      assert.deepEqual(retainedCall.arguments, {
        status: "mystery",
        retained: "raw auditor candidate",
      });
      // No accepted judge receipt for the unreadable audit path.
      assert.equal(rows.some(
        (row) => row.type === "message" && row.message?.toolName === "ak_judge_output" && row.message?.isError === false && row.message?.details?.judgeStatus === "converged",
      ), false);
      const errorRef = result.terminal!.artifacts.find(
        (artifact) => artifact.kind === "error",
      );
      assert.ok(errorRef, "failure channel must publish error artifact");
      const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
        kind: string;
        role: string;
        cause: string;
        details?: Record<string, unknown>;
      };
      assert.equal(errorBody.kind, "error");
      assert.equal(errorBody.role, "judge");
      assert.equal(errorBody.cause, "output");
      assert.deepEqual(errorBody.details, {
        kind: "role_infrastructure_failure",
        source: "shared-role-lifecycle",
        reasonCode: "host_failure",
        observation: { kind: "object-status-unreadable", status: "unknown" },
        candidate: { status: "mystery", retained: "raw auditor candidate" },
        exitCode: 1,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

/** #475 public Judge failure tracer: one harness, scenario data only. */
async function traceJudgeInfrastructureFailure(input: {
  readonly name: string;
  readonly runId: string;
  readonly childEnv?: NodeJS.ProcessEnv;
  readonly poisonRunDir?: boolean;
  readonly expectGateAbsent?: boolean;
  readonly expectDetails: Record<string, unknown>;
}): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), `ak-public-cli-judge-${input.name}-`));
  try {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const providerPath = resolve(packageRoot, "test/fixtures/audit-failure-provider.ts");
    const result = await runAkRole(
      [
        "judge",
        "--model",
        "ak-audit-failure/faux-1",
        "--thinking",
        "off",
        "--project",
        project,
        `Exercise ${input.name} failure evidence.`,
      ],
      {
        packageRoot,
        home,
        agentDir: join(home, ".pi", "agent"),
        cwd: project,
        createRunId: () => input.runId,
        judgeExtraPiArgs: ["-e", providerPath],
        judgeTimeoutMs: 90_000,
        io: { stdout() {}, stderr() {} },
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
          const env: NodeJS.ProcessEnv = {
            ...options.env,
            PI_OFFLINE: "1",
            ...input.childEnv,
          };
          if (input.poisonRunDir) {
            env.AK_ROLE_RUN_DIR = join(home, "missing-dossier-does-not-exist");
          }
          const subprocess = await runPiSubprocess([...args], {
            cwd: options.cwd,
            env,
            timeoutMs: options.timeoutMs ?? 90_000,
          });
          return {
            code: subprocess.code,
            stdout: subprocess.stdout,
            stderr: subprocess.stderr,
            timedOut: subprocess.localTimeout,
            args: [...args],
          };
        },
            extraPiArgs: ["-e", providerPath],
          }),
      },
    );

    assert.equal(result.exitCode, 1, `${input.name} must exit nonzero`);
    assert.ok(result.terminal);
    const outcome = result.terminal!.roleOutcome;
    assert.equal(outcome.kind, "failure");
    if (outcome.kind !== "failure") throw new Error("expected failure");
    assert.equal(outcome.cause, "output");
    if (input.expectGateAbsent) {
      assert.equal(result.terminal!.gate, undefined, `${input.name}: no accepted Gate cycle`);
    }

    const runDir = join(
      home,
      ".ak-roles",
      "books",
      resolveBookKeyFromGit(project),
      "runs",
      `${input.runId}@judge`,
    );
    const rows = (await readFile(join(runDir, "session", "session.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          toolName?: string;
          isError?: boolean;
          details?: Record<string, unknown>;
        };
      });
    const infraResult = [...rows].reverse().find(
      (row) =>
        row.type === "message"
        && row.message?.role === "toolResult"
        && row.message?.toolName === JUDGE_OUTPUT_TOOL_NAME
        && row.message?.isError === true,
    );
    assert.ok(infraResult?.message?.details, `${input.name}: durable infra toolResult`);
    const expected = {
      ...buildNavigatorInfrastructureFailureFact(),
      ...input.expectDetails,
    };
    const durableDetails = infraResult!.message!.details!;
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((key) => [key, durableDetails[key]])),
      expected,
    );

    const errorRef = result.terminal!.artifacts.find((artifact) => artifact.kind === "error");
    assert.ok(errorRef, `${input.name}: error artifact`);
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      kind: string;
      role: string;
      cause: string;
      identity?: { name?: string; code?: string | number };
      details?: Record<string, unknown>;
    };
    assert.equal(errorBody.kind, "error");
    assert.equal(errorBody.role, "judge");
    assert.equal(errorBody.cause, "output");
    assert.equal(errorBody.identity?.name, JUDGE_OUTPUT_TOOL_NAME);
    assert.equal(typeof errorBody.identity?.code, "string");
    const expectedErrorDetails = { ...expected, exitCode: 1 };
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(expectedErrorDetails).map((key) => [key, errorBody.details?.[key]]),
      ),
      expectedErrorDetails,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** #475: audited-role materials + Gate unusable submission — one parameterized harness. */
for (const scenario of [
  {
    name: "missing-dossier",
    runId: "run-e2e-judge-missing-dossier-001",
    poisonRunDir: true,
    expectDetails: {
      observation: { kind: "missing-dossier" },
      candidate: null,
    },
  },
  {
    name: "missing-subject",
    runId: "run-e2e-judge-missing-subject-001",
    childEnv: { AK_AUDIT_MISSING_SUBJECT: "1" },
    expectDetails: {
      observation: { kind: "missing-subject", subject: "candidate-verdict" },
      candidate: null,
    },
  },
  {
    name: "notary-no-pass",
    runId: "run-e2e-judge-gate-notary-001",
    childEnv: { AK_GATE_MODE: "notary-no-pass" },
    expectGateAbsent: true,
    expectDetails: {
      stage: "notary",
      submission: { status: "ok-enough" },
    },
  },
] as const) {
  test(
    `ak-role Judge public failure-evidence tracer: ${scenario.name}`,
    { timeout: 120_000 },
    async () => {
      await traceJudgeInfrastructureFailure({
        name: scenario.name,
        runId: scenario.runId,
        expectDetails: scenario.expectDetails,
        ...("poisonRunDir" in scenario ? { poisonRunDir: scenario.poisonRunDir } : {}),
        ...("childEnv" in scenario ? { childEnv: scenario.childEnv } : {}),
        ...("expectGateAbsent" in scenario
          ? { expectGateAbsent: scenario.expectGateAbsent }
          : {}),
      });
    },
  );
}

test(
  "ak-role judge reaches Judge gate and settles Terminal with registry command",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-public-cli-judge-e2e-"));
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const attachment = join(home, "brief.txt");
      await writeFile(attachment, "canonical nonblank prose for navigator work context", "utf8");
      // Point automatic Navigator at the same offline faux provider as Judge.
      const agentDir = join(home, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "navigator-model.json"),
        JSON.stringify({ model: "ak-audit-failure/faux-1" }),
        "utf8",
      );

      const stdout: string[] = [];
      const stderr: string[] = [];
      const providerPath = resolve(
        packageRoot,
        "test/fixtures/audit-failure-provider.ts",
      );

      const result = await runAkRole(
        [
          "judge",
          "--model",
          "ak-audit-failure/faux-1",
          "--thinking",
          "off",
          "--attach",
          attachment,
          "--project",
          project,
          "Canonical nonblank prose Judge request for navigation.",
        ],
        {
          packageRoot,
          home,
          agentDir,
          cwd: project,
          // ADR 0049 host correlation channel (optional; not ticket attribution).
          correlationId: "corr-106-e2e",
          createRunId: () => "run-e2e-judge-001",
          judgeExtraPiArgs: ["-e", providerPath],
          judgeTimeoutMs: 90_000,
          io: {
            stdout: (text) => {
              stdout.push(text);
            },
            stderr: (text) => {
              stderr.push(text);
            },
          },
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            // Delivery outcome scripts a lawful soul-audit pass + Judge converge
            // and a typed Navigator recommendation (model command prose ignored).
            const subprocess = await runPiSubprocess([...args], {
              cwd: options.cwd,
              env: {
                ...options.env,
                PI_OFFLINE: "1",
                AK_NAVIGATOR_DELIVERY_OUTCOME: "recommendation",
              },
              timeoutMs: options.timeoutMs ?? 90_000,
            });
            return {
              code: subprocess.code,
              stdout: subprocess.stdout,
              stderr: subprocess.stderr,
              timedOut: subprocess.localTimeout,
              args: [...args],
            };
          },
            extraPiArgs: ["-e", providerPath],
          }),
        },
      );

      assert.equal(result.exitCode, 0, stderr.join("") || "judge e2e failed");
      // AC4 publication: one non-empty stdout write. Typed facts come from settlement owners,
      // not presentation labels (ADR 0052).
      assert.equal(stdout.length, 1);
      assert.ok(stdout[0]!.length > 0);

      const bookKey = resolveBookKeyFromGit(project);
      const runDir = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-e2e-judge-001@judge",
      );
      // #634: judge settlement projects a direct Notary round with no Gatekeeper seat.
      {
        const auditorDir = join(runDir, "session", "auditor-roles");
        await mkdir(auditorDir, { recursive: true });
        await writeFile(
          join(auditorDir, "o01_notary.jsonl"),
          gateToolSessionJsonl({
            id: "direct-notary",
            startedAt: "2026-09-04T00:00:00.000Z",
            endedAt: "2026-09-04T00:00:10.000Z",
            toolName: "ak_notary_output",
            args: { status: "pass", findings: [] },
          }),
          "utf8",
        );
      }
      const terminal = await settleJudgeTerminalResult(
        fixtureJudgeAdmitted({
          runId: "run-e2e-judge-001",
          runDirectory: runDir,
          projectRoot: project,
          bookKey,
          instruction: "Canonical nonblank prose Judge request for navigation.",
          instructionEmpty: false,
        }),
        piDurablePrincipalAuthority,
      );
      assert.equal(terminal.roleOutcome.role, "judge");
      assert.equal(terminal.roleOutcome.kind, "accepted");
      assert.equal(terminal.roleOutcome.status, "converged");
      assert.ok(terminal.gate);
      assert.deepEqual(terminal.gate!.actualSeats, ["notary"]);
      assert.equal(terminal.gate!.rounds[0]!.dispatch.kind, "direct");
      assert.equal(terminal.gate!.rounds[0]!.dispatch.officer, "notary");
      assert.equal(terminal.navigator.disposition, "recommendation");
      if (terminal.navigator.disposition === "recommendation") {
        assert.equal(terminal.navigator.next.role, "reviewer");
        assert.equal(terminal.navigator.command, undefined);
      }
      assert.equal(terminal.runId, "run-e2e-judge-001");
      assert.ok(terminal.artifacts.length >= 2);
      assert.equal(terminal.artifacts.some((a) => a.kind === "report"), true);
      assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);
      for (const artifact of terminal.artifacts) {
        await readFile(artifact.path);
      }

      const admitted = JSON.parse(
        await readFile(join(runDir, "admitted-request.json"), "utf8"),
      ) as { instruction: string; attachments: Array<{ frozenPath: string }> };
      assert.equal(
        admitted.instruction,
        "Canonical nonblank prose Judge request for navigation.",
      );
      assert.equal(admitted.attachments.length, 1);
      assert.equal(
        await readFile(admitted.attachments[0]!.frozenPath, "utf8"),
        "canonical nonblank prose for navigator work context",
      );

      // #78 index may record correlation/session pointers only — zero content bytes (ADR 0049).
      const indexPath = join(home, ".ak-roles", "books", bookKey, "waiting.jsonl");
      const indexText = await readFile(indexPath, "utf8");
      assert.equal(
        indexText.includes("Canonical nonblank prose Judge request for navigation."),
        false,
      );
      assert.equal(
        indexText.includes("canonical nonblank prose for navigator work context"),
        false,
      );
      assert.match(indexText, /"event":"accepted-activation"/);
      // Activation correlation comes from the ADR 0049 host channel when supplied.
      const rows = indexText
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as {
          event?: string;
          correlation?: { kind?: string; id?: string };
        });
      assert.equal(rows.some((row) => row.event === "ticket-binding"), false);
      const activation = rows.find((row) => row.event === "accepted-activation");
      assert.ok(activation, "accepted-activation fact required");
      assert.equal(activation!.correlation?.kind, "caller");
      assert.equal(activation!.correlation?.id, "corr-106-e2e");

      // pi binary used by harness exists (sanity for runner wiring).
      assert.equal(piCli.endsWith("/pi"), true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
