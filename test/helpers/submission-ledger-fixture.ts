/**
 * Minimal durable sealed fact for settlement-only tests.
 * Does not replay the production submission protocol — producer proof lives in
 * test/contract/submission-ledger.test.ts and real role-runtime entry paths.
 */
import { basename } from "node:path";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { readSealedSubmission } from "../../src/submission-ledger.ts";
import { sitianReport } from "../../src/sitian-facade.ts";

/** Spawn-env convenience for public-cli faux runners that already own typed details. */
export async function writeSealedSubmissionFixtureForSpawn(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly toolCallId?: string;
}): Promise<void> {
  const runDirectory = input.env.AK_ROLE_RUN_DIR;
  if (typeof runDirectory !== "string" || runDirectory.length === 0) return;
  await writeSealedSubmissionFixture({
    cwd: input.cwd,
    runDirectory,
    role: input.role,
    details: input.details,
    ...(typeof input.env.HOME === "string" ? { home: input.env.HOME } : {}),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
  });
}

export async function writeSealedSubmissionFixture(input: {
  readonly cwd: string;
  readonly runDirectory: string;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly home?: string;
  readonly toolCallId?: string;
}): Promise<void> {
  const runId = basename(input.runDirectory).split("@")[0] || "unbound";
  const priorHome = process.env.HOME;
  if (input.home !== undefined) process.env.HOME = input.home;
  try {
    if (await readSealedSubmission(input.cwd, runId) !== undefined) return;
    const status =
      typeof input.details === "object" && input.details !== null
        ? typeof (input.details as { status?: unknown }).status === "string"
          ? (input.details as { status: string }).status
          : typeof (input.details as { judgeStatus?: unknown }).judgeStatus === "string"
            ? (input.details as { judgeStatus: string }).judgeStatus
            : "accepted"
        : "accepted";
    const toolCallId = input.toolCallId ?? "seal-1";
    const attemptId = `${runId}:fixture`;
    sitianReport({
      level: "event",
      kind: "sealed",
      subject: { runId, attemptId },
      payload: {
        type: "sealed",
        attemptId,
        toolCallId,
        accepted: input.details,
        projection: {
          kind: "accepted",
          role: input.role,
          status,
          decisiveFacts: input.details,
        },
      },
      source: "test-fixture",
      cwd: input.cwd,
    });
  } finally {
    if (input.home !== undefined) {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  }
}
