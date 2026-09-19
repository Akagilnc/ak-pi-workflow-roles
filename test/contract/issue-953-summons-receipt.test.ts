/**
 * #953: terminal face reflects current settlement; failure history label;
 * diarist escalate relays payload facts.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { courtDiaristEscalateDiagnostic } from "../../src/public-cli/countersign-run.ts";
import {
  publishFailureArtifacts,
  publishJudgeArtifacts,
  settleHostEndedNoReceipt,
} from "../../src/public-cli/settlement.ts";
import { formatTerminalResult } from "../../src/public-cli/terminal.ts";
import { readRunTerminalArtifact } from "../../src/run-terminal-artifacts.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { withTempHome } from "../helpers/failure-settlement-kit.ts";

async function seedJudgeRun(
  home: string,
  runId: string,
): Promise<{
  runDirectory: string;
  artifactsDir: string;
  admitted: ReturnType<typeof fixtureJudgeAdmitted>;
}> {
  const runDirectory = join(
    home,
    ".ak-roles",
    "books",
    "proj",
    "unbound",
    "runs",
    `${runId}@judge`,
  );
  const sessionDirectory = join(runDirectory, "session");
  const artifactsDir = join(runDirectory, "artifacts");
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(sessionDirectory, "session.jsonl"), "", "utf8");
  return {
    runDirectory,
    artifactsDir,
    admitted: fixtureJudgeAdmitted({
      runId,
      runDirectory,
      projectRoot: join(home, "proj"),
      bookKey: "proj",
    }),
  };
}

test("#953 diarist escalate diagnostic relays payload ticketNumber facts", () => {
  const withTicket = courtDiaristEscalateDiagnostic({
    kind: "accepted",
    role: "diarist",
    payloads: [
      {
        status: "escalate",
        ticketNumber: 946,
        reason: "接缝探针",
        sessions: [],
      },
    ],
  });
  assert.ok(withTicket.includes("946"));
  assert.ok(withTicket.includes("接缝探针"));

  const multi = courtDiaristEscalateDiagnostic({
    kind: "accepted",
    role: "diarist",
    payloads: [
      { status: "escalate", reason: "MARKER-FIRST-ESCALATE", sessions: [] },
      {
        status: "escalate",
        ticketNumber: 953,
        reason: "MARKER-LAST-ESCALATE",
        sessions: [],
      },
    ],
  });
  assert.ok(multi.includes("MARKER-FIRST-ESCALATE"));
  assert.ok(multi.includes("MARKER-LAST-ESCALATE"));
  assert.ok(multi.includes("953"));
});

test("#953 reader adopts current failure after success; success after failure", async () => {
  await withTempHome(async (home) => {
    const { runDirectory, artifactsDir, admitted } = await seedJudgeRun(
      home,
      "01a0-953-switch",
    );
    const authority = piDurablePrincipalAuthority;

    await writeFile(
      join(artifactsDir, "error.json"),
      `${JSON.stringify({ kind: "error", role: "judge", runId: "01a0-953-switch", diagnostic: "old boom" })}\n`,
      "utf8",
    );
    await publishJudgeArtifacts(
      admitted,
      {
        kind: "accepted",
        role: "judge",
        payloads: [{ judgeStatus: "pass" }],
      },
      authority.decode(admitted.principal),
    );
    const afterSuccess = await readRunTerminalArtifact(runDirectory);
    assert.equal(afterSuccess.status, "present");
    if (afterSuccess.status === "present") {
      assert.equal(
        (afterSuccess.body.outcome as { kind?: string } | undefined)?.kind,
        "accepted",
      );
    }

    await publishFailureArtifacts(
      admitted,
      { diagnostic: "new boom", cause: "provider" },
      authority,
    );
    const afterFailure = await readRunTerminalArtifact(runDirectory);
    assert.equal(afterFailure.status, "present");
    if (afterFailure.status === "present") {
      assert.equal(afterFailure.body.diagnostic, "new boom");
    }
  });
});

test("#953 clear-fail leaves residual success face but reader still adopts current failure", async () => {
  await withTempHome(async (home) => {
    const { runDirectory, artifactsDir, admitted } = await seedJudgeRun(
      home,
      "01a0-953-shadow",
    );
    await writeFile(
      join(artifactsDir, "report.json"),
      `${JSON.stringify({
        role: "judge",
        runId: "01a0-953-shadow",
        outcome: {
          kind: "accepted",
          role: "judge",
          payloads: [{ judgeStatus: "continue" }],
        },
      })}\n`,
      "utf8",
    );
    await chmod(artifactsDir, 0o555);
    try {
      const refs = await publishFailureArtifacts(
        admitted,
        { diagnostic: "CURRENT FAILURE", cause: "provider" },
        piDurablePrincipalAuthority,
      );
      assert.ok(refs.some((ref) => ref.kind === "error"));
      const read = await readRunTerminalArtifact(runDirectory);
      assert.equal(read.status, "present");
      if (read.status === "present") {
        assert.equal(read.body.diagnostic, "CURRENT FAILURE");
        assert.notEqual(
          (read.body.outcome as { kind?: string } | undefined)?.kind,
          "accepted",
        );
      }
    } finally {
      await chmod(artifactsDir, 0o755);
    }
  });
});

test("#953 no_receipt empty face: reader adopts absent after prior terminal", async () => {
  await withTempHome(async (home) => {
    const { runDirectory, artifactsDir, admitted } = await seedJudgeRun(
      home,
      "01a0-953-empty",
    );
    await writeFile(
      join(artifactsDir, "report.json"),
      `${JSON.stringify({
        role: "judge",
        runId: "01a0-953-empty",
        outcome: { kind: "accepted", role: "judge", payloads: [] },
      })}\n`,
      "utf8",
    );
    const hostEnded = await settleHostEndedNoReceipt(
      admitted,
      piDurablePrincipalAuthority,
    );
    assert.equal(hostEnded.roleOutcome.kind, "no_receipt");
    assert.deepEqual(hostEnded.artifacts, []);
    const afterEmpty = await readRunTerminalArtifact(runDirectory);
    assert.equal(afterEmpty.status, "absent");
  });
});

test("#953 failure public face labels prior receipts as recorded-submission", () => {
  const formatted = formatTerminalResult({
    roleOutcome: {
      kind: "failure",
      role: "judge",
      diagnostic: "boom",
      decisiveFacts: {},
      payloads: [{ judgeStatus: "continue", note: "PRIOR-RECEIPT-MARKER" }],
    },
    navigator: { disposition: "no-advice" },
    artifacts: [],
    runId: "01a0-953-format",
  });
  assert.ok(formatted.includes("recorded-submission\t"));
  assert.ok(formatted.includes("PRIOR-RECEIPT-MARKER"));
  assert.equal(formatted.includes("\nsubmission\t"), false);
});
