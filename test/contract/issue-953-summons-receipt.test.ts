/**
 * #953: summons parent-visible receipt; honest diarist escalate diagnostic;
 * artifact face reflects current terminal; failure does not present prior
 * submissions as this-turn result.
 */
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  courtDiaristEscalateDiagnostic,
} from "../../src/public-cli/countersign-run.ts";
import {
  formatTerminalResult,
  publishFailureArtifacts,
  publishJudgeArtifacts,
} from "../../src/public-cli/settlement.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { withTempHome } from "../helpers/failure-settlement-kit.ts";

test("#953 failure presentation distinguishes recorded history from this-turn result", () => {
  const prior = {
    countersignStatus: "continue",
    findings: [{ article: "old", reason: "prior round" }],
  };
  const terminal: TerminalResult = {
    roleOutcome: {
      kind: "failure",
      role: "countersign",
      cause: "provider",
      diagnostic: "WebSocket error",
      decisiveFacts: { cause: "provider", diagnostic: "WebSocket error" },
      payloads: [prior],
    },
    navigator: { disposition: "no-advice" },
    artifacts: [],
    runId: "01fail",
    submissions: [prior],
  };
  const presented = formatTerminalResult(terminal);
  // Current failure is the outcome/diagnostic face — not a submission row of prior verdict.
  assert.match(presented, /^countersign\tfailure\t/m);
  assert.match(presented, /WebSocket error/);
  // Prior recorded payloads must not share the this-turn `submission` label.
  assert.equal(/\nsubmission\t/.test(presented), false);
  // History may still surface, under a distinct label (field is encodeTerminalField'd).
  assert.match(presented, /recorded-submission\t/);
  assert.match(presented, /countersignStatus/);
  assert.match(presented, /prior round/);
});

test("#953 accepted presentation keeps submission label for this-turn receipts", () => {
  const receipt = { countersignStatus: "converged", note: "署" };
  const terminal: TerminalResult = {
    roleOutcome: {
      kind: "accepted",
      role: "countersign",
      payloads: [receipt],
    },
    navigator: { disposition: "no-advice" },
    artifacts: [],
    runId: "01ok",
  };
  const presented = formatTerminalResult(terminal);
  assert.match(presented, /\nsubmission\t/);
  assert.equal(/\nrecorded-submission\t/.test(presented), false);
});

test("#953 diarist escalate diagnostic relays payload facts; does not invent 认不出 when ticketNumber present", () => {
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
  assert.match(withTicket, /court diarist station escalated:/);
  assert.match(withTicket, /946/);
  assert.match(withTicket, /接缝探针/);
  assert.equal(withTicket.includes("cannot identify court target"), false);

  const withoutTicket = courtDiaristEscalateDiagnostic({
    kind: "accepted",
    role: "diarist",
    payloads: [{ status: "escalate", reason: "cannot identify court target" }],
  });
  // When diarist itself wrote that reason, relay is honest — not invented by parent.
  assert.match(withoutTicket, /cannot identify court target/);

  const empty = courtDiaristEscalateDiagnostic(undefined);
  assert.equal(empty, "court diarist station escalated");
  assert.equal(empty.includes("cannot identify court target"), false);
});

test("#953 success artifact face drops prior error; failure face drops prior report", async () => {
  await withTempHome(async (home) => {
    // Ledger topology required by ensureRunArtifactsDir / homeFromRunDirectory.
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      "proj",
      "unbound",
      "runs",
      "01a0-953@judge",
    );
    const sessionDirectory = join(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "session.jsonl"), "", "utf8");
    const admitted = fixtureJudgeAdmitted({
      runId: "01a0-953",
      runDirectory,
      projectRoot: join(home, "proj"),
      bookKey: "proj",
    });
    const authority = piDurablePrincipalAuthority;
    const artifactsDir = join(runDirectory, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    // Prior failure face.
    await writeFile(
      join(artifactsDir, "error.json"),
      `${JSON.stringify({ kind: "error", role: "judge", diagnostic: "old boom" })}\n`,
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

    await access(join(artifactsDir, "report.json"));
    const report = JSON.parse(
      await readFile(join(artifactsDir, "report.json"), "utf8"),
    ) as { outcome?: { kind?: string } };
    assert.equal(report.outcome?.kind, "accepted");
    await assert.rejects(
      () => access(join(artifactsDir, "error.json")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    // Success then failure: report must not remain as the face.
    await publishFailureArtifacts(
      admitted,
      { diagnostic: "new boom", cause: "provider" },
      authority,
    );
    await access(join(artifactsDir, "error.json"));
    const errorBody = JSON.parse(
      await readFile(join(artifactsDir, "error.json"), "utf8"),
    ) as { diagnostic?: string };
    assert.equal(errorBody.diagnostic, "new boom");
    await assert.rejects(
      () => access(join(artifactsDir, "report.json")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  });
});
