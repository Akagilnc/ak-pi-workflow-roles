import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
/**
 * #478 Terminal gate projection — real public CLI entry (runAkRole).
 *
 * Size: mid-tier contract (temp HOME/git + public runner), not a unit micro-test.
 * Owned under test/contract so daily `pnpm test` still covers it with unit+contract.
 *
 * External contracts only:
 *   1. normal dispatch + officer findings; non-empty reason kept as written
 *   2. seat reduction without written reason (reason key absent)
 *   3. no-gate → gate omitted
 *   3b. lawful province pass → accepted Terminal stays; gate omitted (#597)
 *   4. damaged auditor-roles → must not wash to "no gate"
 *   5. ordinary controlled failure still projects accepted gate facts
 *   6. no_receipt projects accepted gate facts
 *   7. resumable failure projects gate while keeping runId only in resume.command
 *   8. audit-incomplete + gate read damage ≠ publication-failure label
 *   9. failure path keeps damaged auditor-roles loud
 *
 * Oracles: typed TerminalResult.gate / roleOutcome fields only (ADR 0052).
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
import type { TerminalGateFact, TerminalResult } from "../../src/public-cli/terminal.ts";
import {
  captureIo,
  seedGitProject,
  withTempHome,
} from "../helpers/failure-settlement-kit.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

const BASE_MS = Date.parse("2026-08-26T04:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

async function seedGatePair(
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
    gateToolSessionJsonl({
      id: "disp-1",
      startedAt: iso(0),
      endedAt: iso(1_000),
      toolName: "ak_gatekeeper_output",
      args: {
        status: "dispatch",
        officer: input.officer,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      attemptEntryId: "attempt-historical-1",
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, `o02_${input.officer}.jsonl`),
    gateToolSessionJsonl({
      id: "off-1",
      startedAt: iso(1_000),
      endedAt: iso(11_000),
      toolName: officerTool,
      args: {
        status: "pass",
        findings: input.findings === undefined ? ["ok"] : [...input.findings],
      },
      attemptEntryId: "attempt-historical-1",
    }),
    "utf8",
  );
}

async function seedDirectOfficer(
  sessionDir: string,
  officer: "inspector" | "notary",
  findings: readonly string[] = [],
): Promise<void> {
  const auditorDir = join(sessionDir, "auditor-roles");
  await mkdir(auditorDir, { recursive: true });
  await writeFile(
    join(auditorDir, `o01_${officer}.jsonl`),
    gateToolSessionJsonl({
      id: "direct-1",
      startedAt: iso(0),
      endedAt: iso(10_000),
      toolName: officer === "inspector" ? "ak_inspector_output" : "ak_notary_output",
      args: { status: "pass", findings: [...findings] },
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

function assertGateNotaryRound(
  gate: TerminalGateFact,
  reason: string | undefined,
): void {
  assert.deepEqual(gate.actualSeats, ["gatekeeper", "notary"]);
  assert.equal(gate.rounds.length, 1);
  const round = gate.rounds[0]!;
  assert.equal(round.roundIndex, 1);
  assert.equal(round.dispatch.kind, "historical_dispatch");
  assert.equal(round.dispatch.officer, "notary");
  if (reason === undefined) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(round.dispatch, "reason"),
      false,
    );
  } else {
    // Durable typed reason field — fixture bytes projected as written.
    assert.equal(round.dispatch.reason, reason);
  }
  assert.equal(round.officer.seat, "notary");
  assert.equal(round.officer.status, "pass");
  assert.ok(Array.isArray(round.officer.findings));
  assert.ok(round.officer.findings.every((item) => typeof item === "string"));
}

/** Typed oracle: gate/session JSONL damage surfaces as LedgerSessionJsonlError, not publication failure. */
function assertLoudGateReadFailure(terminal: TerminalResult): void {
  assert.equal(terminal.roleOutcome.kind, "failure");
  if (terminal.roleOutcome.kind !== "failure") {
    throw new Error("expected failure terminal for gate read damage");
  }
  assert.equal(terminal.roleOutcome.cause, "unrecognized");
  assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "LedgerSessionJsonlError");
  assert.equal(
    Object.prototype.hasOwnProperty.call(terminal.roleOutcome.decisiveFacts, "publicationFailure"),
    false,
  );
  assert.equal(terminal.gate, undefined);
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
  /** When set, seals via production submission ledger (accepted path). */
  sealedAcceptance?: { readonly details: unknown };
}): Promise<{ terminal: TerminalResult; exitCode: number; stdout: string[]; stderr: string[] }> {
  const { io, stdout, stderr } = captureIo();
  const result = await runAkRole(
    ["judge", "--project", input.project, "gate projection"],
    {
      packageRoot,
      home: input.home,
      cwd: input.project,
      createRunId: () => input.runId,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
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
          ...(input.sealedAcceptance === undefined
            ? {}
            : {
                sealedAcceptance: {
                  role: "judge" as const,
                  details: input.sealedAcceptance.details,
                },
              }),
        };
      },
          }),
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

test("public CLI projects normal gate dispatch + officer findings", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Leading/trailing whitespace is durable content — trim only decides emptiness.
    const reason = "  reason-token-normal  ";
    // Opaque durable tokens — assert typed projection structure, not prose wording.
    const findings = ["finding-token-a", "finding-token-b"] as const;
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-gate-normal",
      sealedAcceptance: { details: { judgeStatus: "converged" } },
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
        await seedGatePair(sessionDir, {
          officer: "notary",
          reason,
          findings: [...findings],
        });
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.ok(terminal.gate !== undefined);
    assertGateNotaryRound(terminal.gate!, reason);
    // Typed reason field projects fixture bytes as written (not re-trimmed).
    {
      const dispatch = terminal.gate!.rounds[0]!.dispatch;
      assert.equal(dispatch.kind, "historical_dispatch");
      if (dispatch.kind === "historical_dispatch") {
        assert.equal(dispatch.reason, reason);
      }
    }
    assert.equal(terminal.gate!.rounds[0]!.officer.findings.length, findings.length);
    assert.deepEqual(terminal.gate!.rounds[0]!.officer.findings, [...findings]);
  }, { prefix: "ak-gate-normal-" });
});

test("public CLI shows seat reduction without reason as reason-absent", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal } = await runJudgePublic({
      home,
      project,
      runId: "run-gate-no-reason",
      sealedAcceptance: { details: { judgeStatus: "converged" } },
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
        await seedDirectOfficer(sessionDir, "inspector");
      },
    });
    assert.ok(terminal.gate !== undefined);
    assert.deepEqual(terminal.gate!.actualSeats, ["inspector"]);
    const round = terminal.gate!.rounds[0]!;
    assert.equal(round.dispatch.kind, "direct");
    assert.equal(round.dispatch.officer, "inspector");
    assert.equal(
      Object.prototype.hasOwnProperty.call(round.dispatch, "reason"),
      false,
      "reason must stay absent when dispatch wrote none",
    );
    assert.deepEqual(round.officer.findings, []);
  }, { prefix: "ak-gate-no-reason-" });
});

test("public CLI omits gate when no auditor-roles gate ran", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal } = await runJudgePublic({
      home,
      project,
      runId: "run-gate-no-gate",
      sealedAcceptance: { details: { judgeStatus: "converged" } },
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
      },
    });
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(
      Object.prototype.hasOwnProperty.call(terminal, "gate"),
      false,
      "no-gate run must keep gate omitted (zero change)",
    );
    assert.equal(terminal.gate, undefined);
  }, { prefix: "ak-gate-no-gate-" });
});

test("public CLI keeps accepted Terminal when auditor-roles holds lawful province pass", async () => {
  // #597: province pass is a lawful non-dispatch release — zero paired rounds,
  // gate omitted, accepted submission remains terminal (never exit 1 / unrecognized).
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-gate-province-pass",
      sealedAcceptance: { details: { judgeStatus: "converged" } },
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
        const auditorDir = join(sessionDir, "auditor-roles");
        await mkdir(auditorDir, { recursive: true });
        await writeFile(
          join(auditorDir, "d01_gatekeeper_province_pass.jsonl"),
          gateToolSessionJsonl({
            id: "province-pass",
            startedAt: iso(0),
            endedAt: iso(1_000),
            toolName: "ak_gatekeeper_output",
            args: { status: "pass", reason: "no officer needed" },
          }),
          "utf8",
        );
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.gate, undefined);
  }, { prefix: "ak-gate-province-pass-" });
});

test("public CLI does not wash damaged auditor-roles into no-gate", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-gate-damaged",
      sealedAcceptance: { details: { judgeStatus: "converged" } },
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), acceptedJudgeSessionLine(), "utf8");
        const auditorDir = join(sessionDir, "auditor-roles");
        await mkdir(auditorDir, { recursive: true });
        await writeFile(join(auditorDir, "broken.jsonl"), "{bad}\n", "utf8");
      },
    });
    // Settlement read fails loud — public entry settles a failure carrying the
    // typed JSONL error identity, never an accepted Terminal that pretends no gate ran.
    assert.equal(exitCode, 1);
    assertLoudGateReadFailure(terminal);
  }, { prefix: "ak-gate-damaged-" });
});

test("public CLI failure Terminal still projects accepted gate facts", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const reason = "reason-token-fail";
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-gate-fail",
      piResult: { code: 1, stderr: "provider rejected the request\n" },
      seedSession: async (sessionDir) => {
        // No lawful judge receipt — activation failure path.
        await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
        await seedGatePair(sessionDir, { officer: "notary", reason });
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(terminal.roleOutcome.kind, "failure");
    assert.ok(terminal.gate !== undefined, "failure must not hide accepted gate facts");
    assertGateNotaryRound(terminal.gate!, reason);
  }, { prefix: "ak-gate-fail-" });
});

test("public CLI no_receipt Terminal projects accepted gate facts", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-gate-no-receipt";
    const reason = "reason-token-no-receipt";
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
        await seedGatePair(sessionDir, { officer: "notary", reason });
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(terminal.roleOutcome.kind, "no_receipt");
    assert.ok(terminal.gate !== undefined);
    assertGateNotaryRound(terminal.gate!, reason);
  }, { prefix: "ak-gate-no-receipt-" });
});

test("public CLI resumable failure projects gate without re-disclosing runId outside resume", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-gate-resume-429";
    const reason = "reason-token-resume";
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      [
        "--model",
        "openai-codex/gpt-5.6-sol:high",
        "judge",
        "--project",
        project,
        "gate resume",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
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
          await seedGatePair(sessionDir, { officer: "notary", reason });
          return {
            code: 1,
            stderr: "activation wrapper exited nonzero\n",
            timedOut: false,
            args: [...args],
          };
        },
          }),
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
    assert.ok(terminal.gate !== undefined);
    assertGateNotaryRound(terminal.gate!, reason);
    // Resume desensitization: runId only inside resume.command among typed regions.
    const outside = {
      roleOutcome: terminal.roleOutcome,
      navigator: terminal.navigator,
      artifacts: terminal.artifacts,
      gate: terminal.gate,
      runId: terminal.runId,
    };
    assert.equal(JSON.stringify(outside).includes(runId), false);
  }, { prefix: "ak-gate-resume-" });
});

test("public CLI audit-incomplete keeps gate read damage off the publication-failure label", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-gate-audit-read",
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
    // Gate read throws after successful publication → typed JSONL error identity.
    // Must not carry publicationFailure decisive fact.
    assert.equal(exitCode, 1);
    assertLoudGateReadFailure(terminal);
  }, { prefix: "ak-gate-audit-read-" });
});

test("public CLI failure path keeps damaged auditor-roles loud (not silent no-gate)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { terminal, exitCode } = await runJudgePublic({
      home,
      project,
      runId: "run-gate-fail-damaged",
      piResult: { code: 1, stderr: "provider rejected the request\n" },
      seedSession: async (sessionDir) => {
        await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
        const auditorDir = join(sessionDir, "auditor-roles");
        await mkdir(auditorDir, { recursive: true });
        await writeFile(join(auditorDir, "broken.jsonl"), "{bad}\n", "utf8");
      },
    });
    // Failure settlement projects gate loud: damaged volumes surface typed
    // JSONL error identity rather than a silent no-gate omission.
    assert.equal(exitCode, 1);
    assertLoudGateReadFailure(terminal);
  }, { prefix: "ak-gate-fail-damaged-" });
});
