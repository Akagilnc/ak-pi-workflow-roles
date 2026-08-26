/**
 * #478 Terminal menxia projection — real public CLI entry (runAkRole).
 *
 * External contracts only:
 *   1. normal dispatch + officer findings on accepted Terminal
 *   2. seat reduction without written reason (reason key absent)
 *   3. no-gate → menxia omitted
 *   4. damaged auditor-roles → must not wash to "no gate"
 *   5. dispatch reason kept as written (trim only for emptiness)
 *   6. ordinary controlled failure still projects accepted gate facts
 *   7. no_receipt projects accepted gate facts
 *   8. resumable failure projects menxia while keeping runId only in resume.command
 *   9. audit-incomplete + menxia read damage ≠ publication-failure label
 *
 * Oracles: typed TerminalResult.menxia / roleOutcome fields only (ADR 0052).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { NO_RECEIPT_LIFECYCLE_ENTRY_TYPE } from "../../src/receipt-delivery-policy.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { renderResumeCommand } from "../../src/public-cli/run-lifecycle.ts";
import type { TerminalMenxiaFact, TerminalResult } from "../../src/public-cli/terminal.ts";
import {
  captureIo,
  seedGitProject,
  withTempHome,
} from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

const BASE_MS = Date.parse("2026-08-26T04:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

function gateVolumeLines(input: {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): string {
  const header = {
    type: "session",
    version: 3,
    id: input.id,
    timestamp: input.startedAt,
    cwd: "/tmp/menxia-terminal",
  };
  const call = {
    type: "message",
    id: `${input.id}-call`,
    parentId: null,
    timestamp: input.endedAt,
    message: {
      role: "assistant",
      timestamp: input.endedAt,
      content: [
        {
          type: "toolCall",
          id: `call_${input.id}`,
          name: input.toolName,
          arguments: input.args,
        },
      ],
    },
  };
  const result = {
    type: "message",
    id: `${input.id}-result`,
    parentId: `${input.id}-call`,
    timestamp: input.endedAt,
    message: {
      role: "toolResult",
      toolCallId: `call_${input.id}`,
      toolName: input.toolName,
      timestamp: input.endedAt,
      isError: false,
      content: [{ type: "text", text: "ok" }],
    },
  };
  return [header, call, result].map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function seedMenxiaPair(
  sessionDir: string,
  input: {
    readonly officer: "inspector" | "notary";
    readonly reason?: string;
    readonly findings?: readonly string[];
  },
): Promise<void> {
  const auditorDir = join(sessionDir, "auditor-roles");
  await mkdir(auditorDir, { recursive: true });
  const officerTool =
    input.officer === "notary" ? "ak_notary_output" : "ak_inspector_output";
  await writeFile(
    join(auditorDir, "d01_gatekeeper.jsonl"),
    gateVolumeLines({
      id: "disp-1",
      startedAt: iso(0),
      endedAt: iso(1_000),
      toolName: "ak_gatekeeper_output",
      args: {
        status: "dispatch",
        officer: input.officer,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, `o02_${input.officer}.jsonl`),
    gateVolumeLines({
      id: "off-1",
      startedAt: iso(1_000),
      endedAt: iso(11_000),
      toolName: officerTool,
      args: {
        status: "pass",
        findings: input.findings === undefined ? ["ok"] : [...input.findings],
      },
    }),
    "utf8",
  );
}

function acceptedJudgeSessionLine(): string {
  return `${JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: { judgeStatus: "converged" },
    },
  })}\n`;
}

function auditIncompleteSessionRows(callId: string, candidate: unknown): string {
  return [
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: callId,
            name: JUDGE_OUTPUT_TOOL_NAME,
            arguments: { judgeStatus: "converged" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "custom",
      customType: "ak_compliance_response",
      data: {
        response: {
          content: [
            {
              type: "toolCall",
              name: JUDGE_AUDIT_TOOL_NAME,
              arguments: candidate,
            },
          ],
        },
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details: {
          status: "audit-incomplete",
          observation: { kind: "non-object-arguments", type: "array" },
          candidate: ["ignored"],
        },
      },
    }),
  ].join("\n") + "\n";
}

function assertMenxiaNotaryRound(
  menxia: TerminalMenxiaFact,
  reason: string | undefined,
): void {
  assert.deepEqual(menxia.actualSeats, ["gatekeeper", "notary"]);
  assert.equal(menxia.rounds.length, 1);
  const round = menxia.rounds[0]!;
  assert.equal(round.roundIndex, 1);
  assert.equal(round.dispatch.status, "dispatch");
  assert.equal(round.dispatch.officer, "notary");
  if (reason === undefined) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(round.dispatch, "reason"),
      false,
    );
  } else {
    assert.equal(round.dispatch.reason, reason);
  }
  assert.equal(round.officer.seat, "notary");
  assert.equal(round.officer.status, "pass");
}

async function runJudgePublic(input: {
  readonly home: string;
  readonly project: string;
  readonly runId: string;
  readonly seedSession: (sessionDir: string, runDir: string) => Promise<void>;
  readonly piResult?: {
    readonly code: number;
    readonly stderr?: string;
  };
}): Promise<{ terminal: TerminalResult; exitCode: number; stdout: string[]; stderr: string[] }> {
  const { io, stdout, stderr } = captureIo();
  const result = await runAkRole(
    ["judge", "--project", input.project, "menxia projection"],
    {
      packageRoot,
      home: input.home,
      cwd: input.project,
      createRunId: () => input.runId,
      io,
      piRunner: async (args) => {
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        const runDir = join(sessionDir, "..");
        await mkdir(sessionDir, { recursive: true });
        await input.seedSession(sessionDir, runDir);
        return {
          code: input.piResult?.code ?? 0,
          stderr: input.piResult?.stderr ?? "",
          timedOut: false,
          args: [...args],
        };
      },
    },
  );
  assert.ok(result.terminal, "public entry must settle a Terminal");
  return {
    terminal: result.terminal!,
    exitCode: result.exitCode,
    stdout,
    stderr,
  };
}

test("public CLI projects normal menxia dispatch + officer findings", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const reason = "judge draft requires document fidelity";
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-menxia-normal",
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
        await seedMenxiaPair(sessionDir, {
          officer: "notary",
          reason,
          findings: ["quote matches source", "ticket axes aligned"],
        });
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.ok(terminal.menxia !== undefined);
    assertMenxiaNotaryRound(terminal.menxia!, reason);
    assert.deepEqual(terminal.menxia!.rounds[0]!.officer.findings, [
      "quote matches source",
      "ticket axes aligned",
    ]);
  }, { prefix: "ak-menxia-normal-" });
});

test("public CLI shows seat reduction without reason as reason-absent", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal } = await runJudgePublic({
      home,
      project,
      runId: "run-menxia-no-reason",
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
        await seedMenxiaPair(sessionDir, {
          officer: "inspector",
          findings: [],
        });
      },
    });
    assert.ok(terminal.menxia !== undefined);
    assert.deepEqual(terminal.menxia!.actualSeats, ["gatekeeper", "inspector"]);
    const round = terminal.menxia!.rounds[0]!;
    assert.equal(round.dispatch.officer, "inspector");
    assert.equal(
      Object.prototype.hasOwnProperty.call(round.dispatch, "reason"),
      false,
      "reason must stay absent when dispatch wrote none",
    );
    assert.deepEqual(round.officer.findings, []);
  }, { prefix: "ak-menxia-no-reason-" });
});

test("public CLI omits menxia when no auditor-roles gate ran", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal } = await runJudgePublic({
      home,
      project,
      runId: "run-menxia-no-gate",
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
      },
    });
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(
      Object.prototype.hasOwnProperty.call(terminal, "menxia"),
      false,
      "no-gate run must keep menxia omitted (zero change)",
    );
    assert.equal(terminal.menxia, undefined);
  }, { prefix: "ak-menxia-no-gate-" });
});

test("public CLI does not wash damaged auditor-roles into no-gate", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-menxia-damaged",
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
        const auditorDir = join(sessionDir, "auditor-roles");
        await mkdir(auditorDir, { recursive: true });
        await writeFile(join(auditorDir, "broken.jsonl"), "{bad}\n", "utf8");
      },
    });
    // Settlement read fails loud — public entry settles a failure carrying the
    // JSONL cause, never an accepted Terminal that pretends no gate ran.
    assert.equal(exitCode, 1);
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") throw new Error("expected failure");
    assert.match(terminal.roleOutcome.diagnostic, /malformed JSONL record/);
    assert.equal(terminal.menxia, undefined);
  }, { prefix: "ak-menxia-damaged-" });
});

test("public CLI keeps non-empty dispatch reason bytes as written", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Leading/trailing whitespace is durable content — trim only decides emptiness.
    const reason = "  padded seat-reduction reason  ";
    const { terminal } = await runJudgePublic({
      home,
      project,
      runId: "run-menxia-reason-as-is",
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
        await seedMenxiaPair(sessionDir, { officer: "notary", reason });
      },
    });
    assert.ok(terminal.menxia !== undefined);
    assert.equal(terminal.menxia!.rounds[0]!.dispatch.reason, reason);
  }, { prefix: "ak-menxia-reason-" });
});

test("public CLI failure Terminal still projects accepted menxia gate facts", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const reason = "prior gate before main failure";
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-menxia-fail",
      piResult: { code: 1, stderr: "provider rejected the request\n" },
      seedSession: async (sessionDir) => {
        // No lawful judge receipt — activation failure path.
        await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
        await seedMenxiaPair(sessionDir, { officer: "notary", reason });
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(terminal.roleOutcome.kind, "failure");
    assert.ok(terminal.menxia !== undefined, "failure must not hide accepted gate facts");
    assertMenxiaNotaryRound(terminal.menxia!, reason);
  }, { prefix: "ak-menxia-fail-" });
});

test("public CLI no_receipt Terminal projects accepted menxia gate facts", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-menxia-no-receipt";
    const reason = "gate before no-receipt";
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId,
      // code 0 + no lawful receipt → output cause → no_receipt lifecycle wins.
      piResult: { code: 0 },
      seedSession: async (sessionDir, runDir) => {
        const lifecycle = {
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
        };
        await writeFile(
          join(sessionDir, "session.jsonl"),
          `${JSON.stringify({
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "go" }] },
          })}\n${JSON.stringify(lifecycle)}\n`,
          "utf8",
        );
        await seedMenxiaPair(sessionDir, { officer: "notary", reason });
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(terminal.roleOutcome.kind, "no_receipt");
    assert.ok(terminal.menxia !== undefined);
    assertMenxiaNotaryRound(terminal.menxia!, reason);
  }, { prefix: "ak-menxia-no-receipt-" });
});

test("public CLI resumable failure projects menxia without re-disclosing runId outside resume", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-menxia-resume-429";
    const reason = "gate before 429";
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      [
        "--model",
        "openai-codex/gpt-5.6-sol:high",
        "judge",
        "--project",
        project,
        "menxia resume",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          await mkdir(sessionDir, { recursive: true });
          await observeTyped429ViaProductionHandler({
            runDirectory: runDir,
            provider: "openai-codex",
          });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            [
              JSON.stringify({
                type: "message",
                message: {
                  role: "user",
                  content: [{ type: "text", text: "go" }],
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "upstream declined this request",
                  provider: "openai-codex",
                },
              }),
            ].join("\n") + "\n",
            "utf8",
          );
          await seedMenxiaPair(sessionDir, { officer: "notary", reason });
          return {
            code: 1,
            stderr: "activation wrapper exited nonzero\n",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    assert.ok(result.terminal);
    const terminal = result.terminal!;
    assert.equal(terminal.roleOutcome.kind, "failure");
    assert.ok(terminal.resume);
    assert.equal(terminal.resume!.command, renderResumeCommand(runId));
    assert.equal(terminal.runId, undefined);
    assert.ok(terminal.menxia !== undefined);
    assertMenxiaNotaryRound(terminal.menxia!, reason);
    // Resume desensitization: runId only inside resume.command among typed regions.
    const outside = {
      roleOutcome: terminal.roleOutcome,
      navigator: terminal.navigator,
      artifacts: terminal.artifacts,
      menxia: terminal.menxia,
      runId: terminal.runId,
    };
    assert.equal(JSON.stringify(outside).includes(runId), false);
  }, { prefix: "ak-menxia-resume-" });
});

test("public CLI audit-incomplete keeps menxia read damage off the publication-failure label", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-menxia-audit-read",
      seedSession: async (sessionDir) => {
        await writeFile(
          join(sessionDir, "session.jsonl"),
          auditIncompleteSessionRows("role-1", ["retained"]),
          "utf8",
        );
        const auditorDir = join(sessionDir, "auditor-roles");
        await mkdir(auditorDir, { recursive: true });
        await writeFile(join(auditorDir, "broken.jsonl"), "{bad}\n", "utf8");
      },
    });
    // Menxia read throws after successful publication → auto-resume exhausts with
    // the JSONL identity. Must not be labeled publication failure.
    assert.equal(exitCode, 1);
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") {
      throw new Error("expected failure terminal carrying JSONL read cause");
    }
    assert.equal(
      terminal.roleOutcome.diagnostic.includes(
        "audit-incomplete evidence publication failed",
      ),
      false,
    );
    assert.match(terminal.roleOutcome.diagnostic, /malformed JSONL record/);
    assert.equal(terminal.menxia, undefined);
  }, { prefix: "ak-menxia-audit-read-" });
});

test("public CLI failure path keeps damaged auditor-roles loud (not silent no-gate)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-menxia-fail-damaged",
      piResult: { code: 1, stderr: "provider rejected the request\n" },
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
        const auditorDir = join(sessionDir, "auditor-roles");
        await mkdir(auditorDir, { recursive: true });
        await writeFile(join(auditorDir, "broken.jsonl"), "{bad}\n", "utf8");
      },
    });
    // Failure settlement projects menxia loud: damaged volumes surface their
    // JSONL cause rather than a silent no-gate omission on the failure Terminal.
    assert.equal(exitCode, 1);
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") {
      throw new Error("expected failure");
    }
    assert.match(terminal.roleOutcome.diagnostic, /malformed JSONL record/);
    assert.equal(terminal.menxia, undefined);
  }, { prefix: "ak-menxia-fail-damaged-" });
});
