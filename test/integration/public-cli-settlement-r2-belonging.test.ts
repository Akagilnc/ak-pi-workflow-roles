/**
 * #1161 R2: non-recording re-projection must keep the belonging court's
 * attemptHistoryIdentity — never the leg's latest terminal, never payload guess.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { trySettlePublicSeat } from "../../src/public-cli/settlement.ts";
import { readHistoryRowsSync } from "../../src/run-dossier.ts";
import { readRunTerminal } from "../../src/run-terminal-artifacts.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { seedGitProject, withTempHome } from "../helpers/failure-settlement-kit.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";

async function prepareJudgeRun(home: string, runId: string) {
  const project = join(home, "proj");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const runDirectory = join(
    home,
    ".ak-roles",
    "books",
    "proj",
    "unbound",
    "runs",
    `${runId}@judge`,
  );
  await mkdir(join(runDirectory, "session"), { recursive: true });
  await writeFile(join(runDirectory, "session", "session.jsonl"), "", "utf8");
  const admitted = fixtureJudgeAdmitted({
    runId,
    runDirectory,
    projectRoot: project,
    bookKey: "proj",
  });
  return { project, runDirectory, admitted, authority: piDurablePrincipalAuthority };
}

function terminalIdentity(runDirectory: string): string | undefined {
  const read = readRunTerminal(runDirectory);
  if (read.status !== "present") return undefined;
  const identity = read.body.attemptHistoryIdentity;
  return typeof identity === "string" && identity.length > 0 ? identity : undefined;
}

function terminalPayloadStatuses(runDirectory: string): unknown[] | undefined {
  const read = readRunTerminal(runDirectory);
  if (read.status !== "present") return undefined;
  const outcome = read.body.outcome;
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return undefined;
  const payloads = (outcome as { payloads?: unknown }).payloads;
  if (!Array.isArray(payloads)) return undefined;
  return payloads.map((payload) => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const row = payload as { status?: unknown; judgeStatus?: unknown };
    return row.status ?? row.judgeStatus ?? null;
  });
}

test("#1161 R2 A/B courts: re-project A keeps A's attempt-history, not latest B", async () => {
  await withTempHome(async (home) => {
    const { project, runDirectory, admitted, authority } = await prepareJudgeRun(
      home,
      "01a0r2ab00007000800000000001",
    );
    const payloadA = { status: "converged", findings: [{ id: "A" }], tag: "A" };
    const payloadB = { status: "continue", findings: [{ id: "B" }], tag: "B" };

    await sealAcceptedSubmission({
      cwd: project,
      home,
      runId: admitted.runId,
      runDirectory,
      role: "judge",
      details: payloadA,
      toolCallId: "t-a",
      courtAttemptId: "court-A",
    });
    await trySettlePublicSeat(admitted, authority, {
      courtAttemptId: "court-A",
      recordAttemptHistory: true,
    });
    const idA = terminalIdentity(runDirectory);
    assert.equal(typeof idA, "string");

    await sealAcceptedSubmission({
      cwd: project,
      home,
      runId: admitted.runId,
      runDirectory,
      role: "judge",
      details: payloadB,
      toolCallId: "t-b",
      courtAttemptId: "court-B",
    });
    await trySettlePublicSeat(admitted, authority, {
      courtAttemptId: "court-B",
      recordAttemptHistory: true,
    });
    const idB = terminalIdentity(runDirectory);
    assert.equal(typeof idB, "string");
    assert.notEqual(idA, idB);

    const settledA = await trySettlePublicSeat(admitted, authority, {
      courtAttemptId: "court-A",
    });
    assert.equal(settledA?.roleOutcome.kind, "accepted");
    assert.deepEqual(terminalPayloadStatuses(runDirectory), ["converged"]);
    assert.equal(terminalIdentity(runDirectory), idA);
  });
});

test("#1161 R2 identical payloads: re-project A must not guess B's history row", async () => {
  await withTempHome(async (home) => {
    const { project, runDirectory, admitted, authority } = await prepareJudgeRun(
      home,
      "01a0r2id00007000800000000002",
    );
    const samePayload = { status: "converged", findings: [{ id: "SAME" }], tag: "identical" };

    await sealAcceptedSubmission({
      cwd: project,
      home,
      runId: admitted.runId,
      runDirectory,
      role: "judge",
      details: samePayload,
      toolCallId: "t-a",
      courtAttemptId: "court-A",
    });
    await trySettlePublicSeat(admitted, authority, {
      courtAttemptId: "court-A",
      recordAttemptHistory: true,
    });
    const idA = terminalIdentity(runDirectory);

    await sealAcceptedSubmission({
      cwd: project,
      home,
      runId: admitted.runId,
      runDirectory,
      role: "judge",
      details: samePayload,
      toolCallId: "t-b",
      courtAttemptId: "court-B",
    });
    await trySettlePublicSeat(admitted, authority, {
      courtAttemptId: "court-B",
      recordAttemptHistory: true,
    });
    const idB = terminalIdentity(runDirectory);
    assert.equal(typeof idA, "string");
    assert.equal(typeof idB, "string");
    assert.notEqual(idA, idB);

    await trySettlePublicSeat(admitted, authority, { courtAttemptId: "court-A" });
    assert.equal(terminalIdentity(runDirectory), idA);
  });
});

test("#1161 R2/N1: B history append then terminal EACCES leaves A; re-project A stays A; no invent-append", async () => {
  await withTempHome(async (home) => {
    const { project, runDirectory, admitted, authority } = await prepareJudgeRun(
      home,
      "01a0r2ea00007000800000000003",
    );

    await sealAcceptedSubmission({
      cwd: project,
      home,
      runId: admitted.runId,
      runDirectory,
      role: "judge",
      details: { status: "converged", findings: [{ id: "A" }], tag: "A" },
      toolCallId: "t-a",
      courtAttemptId: "court-A",
    });
    await trySettlePublicSeat(admitted, authority, {
      courtAttemptId: "court-A",
      recordAttemptHistory: true,
    });
    const idA = terminalIdentity(runDirectory);
    assert.equal(typeof idA, "string");
    const historyAfterA = readHistoryRowsSync(runDirectory).filter((row) => row.kind === "attempt-history").length;

    await sealAcceptedSubmission({
      cwd: project,
      home,
      runId: admitted.runId,
      runDirectory,
      role: "judge",
      details: { status: "continue", findings: [{ id: "B" }], tag: "B" },
      toolCallId: "t-b",
      courtAttemptId: "court-B",
    });
    // Freeze state.jsonl so the terminal page append fails after B can still
    // append attempt-history (history.jsonl stays writable).
    await chmod(join(runDirectory, "state.jsonl"), 0o444);
    await assert.rejects(
      () =>
        trySettlePublicSeat(admitted, authority, {
          courtAttemptId: "court-B",
          recordAttemptHistory: true,
        }),
      (error: unknown) => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return code === "EACCES" || code === "EPERM";
      },
    );
    await chmod(join(runDirectory, "state.jsonl"), 0o644);

    assert.equal(terminalIdentity(runDirectory), idA, "failed B terminal must not replace A's face");
    const historyAfterBFault = readHistoryRowsSync(runDirectory).filter((row) => row.kind === "attempt-history").length;
    assert.ok(historyAfterBFault >= historyAfterA);

    const beforeReproject = historyAfterBFault;
    await trySettlePublicSeat(admitted, authority, { courtAttemptId: "court-A" });
    assert.equal(terminalIdentity(runDirectory), idA);
    assert.deepEqual(terminalPayloadStatuses(runDirectory), ["converged"]);
    const afterReproject = readHistoryRowsSync(runDirectory).filter((row) => row.kind === "attempt-history").length;
    assert.equal(afterReproject, beforeReproject, "N1: re-projection must not invent attempt-history");
  });
});
