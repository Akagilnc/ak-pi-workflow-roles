/** #1243: public Gatekeeper receipts use the shared review queue and reask seam. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { REVIEW_SUBMISSION_OUTPUT_TOOL_NAME } from "../../src/review-submission.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";

const trialRecord = [{ exitCode: 0, cost: { usd: 0 }, observed: { usable: true } }];
const corrected = { status: "continue", trialRecord, ticketNumber: 1243 };
const unreadable = { status: "dispatch", trialRecord, ticketNumber: 1243 };
const CASES = [
  ...["converged", "continue", "escalate"].map((status) => ({
    name: status,
    submissions: [{ status, trialRecord, ticketNumber: 1243 }],
    unsettled: false,
  })),
  { name: "missing record", submissions: [{ status: "converged", ticketNumber: 1243 }], unsettled: false },
  { name: "unreadable then corrected", submissions: [unreadable, corrected], unsettled: false },
  { name: "unreadable exhausted", submissions: [unreadable, unreadable], unsettled: true },
];

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-instruction-seat-", scenario);
}

for (const scenario of CASES) {
  test(`ak-role gatekeeper accepts original receipts: ${scenario.name}`, async () => {
    await withTempHome(async (home) => {
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io } = captureIo();
      await runAkRole(["config", "set-auto-resume-limit", "1"], { home, packageRoot, io });
      const turns: { role: string; kind: string; runDirectory: string }[] = [];
      let calls = 0;
      const host = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          const details = scenario.submissions[Math.min(calls++, scenario.submissions.length - 1)];
          return scriptedTerminatingToolSession({
            role: "gatekeeper",
            toolName: REVIEW_SUBMISSION_OUTPUT_TOOL_NAME,
            toolCallId: `trial-${calls}`,
            details,
          })(args, options);
        },
      });
      const result = await runAkRole(
        ["gatekeeper", "--model", "test/caller-seat:high", "--project", project, `覆验 #1243，工作树 ${project}`],
        {
          home, packageRoot, cwd: project, io,
          roleTurnHost: {
            async executeTurn(request) {
              turns.push({ role: request.activation.role, kind: request.continuation.kind, runDirectory: request.runDirectory });
              return host.executeTurn(request);
            },
          },
        },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.role, "gatekeeper");
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.deepEqual(result.terminal?.roleOutcome.payloads?.at(-1), scenario.submissions.at(-1));
      assert.equal(result.terminal?.roleOutcome.decisiveFacts?.directionUnsettled === true, scenario.unsettled);
      assert.deepEqual(turns.map(({ role, kind }) => ({ role, kind })), scenario.submissions.map((_, i) => ({
        role: "gatekeeper", kind: i === 0 ? "initial" : "resume",
      })));
      const runDirectory = turns.at(-1)!.runDirectory;
      // Ticket binding relocates unbound → 1243; the same run resumes.
      assert.ok(turns.every((turn) => basename(turn.runDirectory) === basename(runDirectory)));
      const rows = await readRecordedSubmissionRows(project, result.terminal!.runId!, { home });
      assert.deepEqual(rows.map(({ accepted }) => accepted), scenario.submissions);
    });
  });
}
