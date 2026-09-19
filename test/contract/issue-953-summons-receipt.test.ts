/**
 * #953: terminal face reflects current settlement via real publish/settle entry
 * and the shared terminal-artifact reader. Presentation labels and internal
 * helpers are not mechanical contracts (验收 5 / quality-law).
 */
import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  publishFailureArtifacts,
  publishJudgeArtifacts,
  settleHostEndedNoReceipt,
  withSubmissions,
} from "../../src/public-cli/settlement.ts";
import {
  coalesceSubmissionRows,
  type TerminalResult,
} from "../../src/public-cli/terminal.ts";
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

test("#953 empty failure payloads do not shadow recorded submissions", () => {
  const history = [{ judgeStatus: "continue" }] as const;
  assert.deepEqual(coalesceSubmissionRows([], history), [...history]);
  assert.deepEqual(coalesceSubmissionRows(undefined, history), [...history]);
  assert.deepEqual(
    coalesceSubmissionRows([{ judgeStatus: "pass" }], history),
    [{ judgeStatus: "pass" }],
  );

  const failureTerminal: TerminalResult = {
    roleOutcome: {
      kind: "failure",
      role: "judge",
      diagnostic: "boom",
      cause: "provider",
      payloads: [],
      decisiveFacts: { diagnostic: "boom", cause: "provider" },
    },
    navigator: { disposition: "no-advice" },
    artifacts: [],
    runId: "01a0-953-empty-payloads",
  };
  const attached = withSubmissions(failureTerminal, history);
  assert.equal(attached.roleOutcome.kind, "failure");
  if (attached.roleOutcome.kind === "failure") {
    assert.deepEqual(attached.roleOutcome.payloads, [...history]);
  }
  assert.deepEqual(attached.submissions, [...history]);
});

test("#953 clear-fail leaves residual success face but reader still adopts current failure", async () => {
  await withTempHome(async (home) => {
    const { runDirectory, artifactsDir, admitted } = await seedJudgeRun(
      home,
      "01a0-953-shadow",
    );
    const residualReportPath = join(artifactsDir, "report.json");
    await writeFile(
      residualReportPath,
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
      // Prove the clear seam actually failed: prior success face must remain.
      await access(residualReportPath);
      const residual = JSON.parse(
        await readFile(residualReportPath, "utf8"),
      ) as {
        outcome?: { kind?: string; payloads?: ReadonlyArray<{ judgeStatus?: string }> };
      };
      assert.equal(residual.outcome?.kind, "accepted");
      assert.equal(residual.outcome?.payloads?.[0]?.judgeStatus, "continue");
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
