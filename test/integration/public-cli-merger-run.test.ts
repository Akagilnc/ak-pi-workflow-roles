import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
/**
 * #519 §5 shared public-cli real-entry tracer: host-neutral multi-submission
 * recording, post-seal, no-receipt and infrastructure settlement.
 * Does not substitute createSubmissionLedgerHost unit rows for this seam.
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test.after(() => { process.exitCode = undefined; });

import { INSPECTOR_OUTPUT_TOOL } from "../../src/gatekeeper-role.ts";
import { packagedRoleOutputTool } from "../../src/packaged-role-registry.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  NO_RECEIPT_LIFECYCLE_ENTRY_TYPE,
  noReceiptLifecycleFacts,
  receiptAttemptPointer,
} from "../../src/receipt-delivery-policy.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";
import {
  createSubmissionLedgerHost,
  readRecordedSubmissionRows,
} from "../../src/submission-ledger.ts";
import type { HostContext, HostToolDefinition, RoleHost, RoleTurnHost } from "../../src/host-contracts.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { Type } from "typebox";
import { seedGitProject } from "../helpers/failure-settlement-kit.ts";

async function withSharedHome<T>(run: (home: string, project: string) => Promise<T>): Promise<T> {
  return await withTempRoot("ak-public-role-table-", async (home) => {
    await configurePassingReviewSeats(home);
    // Independently summoned diarist resolves from the live table (#178).
    await runAkRole(
      ["config", "set", "diarist", "test/caller-seat:high"],
      { packageRoot, home, io: { stdout() {}, stderr() {} } },
    );
    const project = join(home, "work");
    await mkdir(project);
    seedGitProject(project);
    return await run(home, project);
  });
}

/** Production ReviewerIntent face — completeness|correctness amendments only. */
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
                attemptPointer: receiptAttemptPointer(request.runDirectory, request.invocationScopeId),
              }),
            );
            return { code: 0, stderr: "", timedOut: false };
          }
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
test("host-neutral typed turns record every terminating submission without sole reject (#836)", async () => {
  await withSharedHome(async (home, project) => {
    const runId = "run-multi-submit-836";
    const first = { status: "continue", report: "first-submit" };
    const second = { status: "converged", report: "second-submit" };
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
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "two submissions"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        credentials: { "openai-codex": true, xai: false },
        io,
        roleTurnHost: withPassingReviewHost(host),
      },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result.terminal?.roleOutcome));
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
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "No receipt."],
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
            details: { status: "converged" },
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
      const result = await runAkRole(["coder", "--model", "test/caller-seat:high", "--project", project, "Infra fail."],
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
      assert.ok((await readRecordedSubmissionRows(project, "run-table-infrastructure", home)).length > 0);
      assert.ok(result.terminal?.submissions?.some((row) =>
        typeof row === "object" && row !== null && (row as { report?: unknown }).report === "candidate before failure",
      ), JSON.stringify(result.terminal?.submissions));
      process.exitCode = undefined;
    }

    // post-seal action is observed (anomaly on ledger) but must not erase the seal (#833).
    {
      const runId = "run-table-post-seal";
      const { io } = captureIo();
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "Decide."], {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        credentials: { "openai-codex": true, xai: false },
        io,
        roleTurnHost: withPassingReviewHost(hostNeutralTypedTurn({
          role: "judge",
          runId,
          details: { status: "converged" },
          postSealAction: true,
        })),
      });
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal((await readRecordedSubmissionRows(project, runId, home)).at(-1)?.role, "judge");
    }
  });
});
