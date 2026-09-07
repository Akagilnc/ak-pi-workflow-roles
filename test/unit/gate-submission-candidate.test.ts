import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #632: Grok host session.jsonl is header-only (#617 DK-4). After pointer-only
 * summons deleted subject.material, gate officers must still resolve the
 * in-flight tool-call leaf via a run-directory artifact.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import {
  buildGateOfficerReviewInstruction,
  createAuditorDossierTool,
  gateSubmissionCandidatePath,
  persistGateSubmissionCandidate,
  readLatestToolCallLeaf,
} from "../../src/auditor-dossier-tool.ts";
import {
  resumeTurnRequestProjectionOptions,
  type PostAdmissionEnv,
} from "../../src/public-cli/post-admission.ts";
import { RESUME_TRANSPORT_ENVELOPE } from "../../src/public-cli/run-lifecycle.ts";
import type { AdmittedRoleInvocation } from "../../src/public-cli/invocation.ts";

const MARKER = "GATE-CANDIDATE-BODY-MARKER-632";

function headerOnlySession(runDirectory: string): string {
  const sessionFile = join(runDirectory, "session", "session.jsonl");
  mkdirSync(join(runDirectory, "session"), { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "grok-header-only",
      timestamp: new Date().toISOString(),
      cwd: runDirectory,
    })}\n`,
    "utf8",
  );
  return sessionFile;
}

function memoryToolCallLeaf(args: Record<string, unknown>) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-gate-1",
          name: "ak_fixer_output",
          arguments: args,
        },
      ],
    },
  };
}

test("persistGateSubmissionCandidate writes memory tool-call leaf to run artifact", async () => {
  await withTempRoot("ak-gate-candidate-", async (runDirectory) => {
    headerOnlySession(runDirectory);
    const leaf = memoryToolCallLeaf({ status: "completed", report: MARKER });
    const context = {
      sessionManager: {
        getEntries: () => [leaf],
      },
    };

    const path = persistGateSubmissionCandidate(runDirectory, context);
    assert.equal(path, gateSubmissionCandidatePath(runDirectory));
    const written = readFileSync(path!, "utf8");
    assert.equal(written.includes(MARKER), true);
    assert.deepEqual(JSON.parse(written), leaf);
    });
});

test("dossier locator prefers persisted leaf over header-only session.jsonl", async () => {
  await withTempRoot("ak-gate-dossier-", async (runDirectory) => {
    const sessionFile = headerOnlySession(runDirectory);
    const leaf = memoryToolCallLeaf({ status: "completed", report: MARKER });
    const path = persistGateSubmissionCandidate(runDirectory, {
      sessionManager: { getEntries: () => [leaf] },
    });
    assert.ok(path);

    const located = await createAuditorDossierTool(runDirectory, {
      submissionCandidate: path,
    }).execute("id", {});
    assert.equal(located.details?.parentSessionCandidate, path);
    assert.equal(located.details?.submissionCandidate, path);
    assert.equal(readFileSync(located.details!.parentSessionCandidate, "utf8").includes(MARKER), true);

    // Header-only durable principal is still on disk but is not the candidate pointer.
    assert.equal(readFileSync(sessionFile, "utf8").includes(MARKER), false);
    assert.equal(readFileSync(sessionFile, "utf8").includes('"type":"session"'), true);
    });
});

test("mutation: without persist, parentSessionCandidate stays header-only (blind)", async () => {
  await withTempRoot("ak-gate-blind-", async (runDirectory) => {
    const sessionFile = headerOnlySession(runDirectory);
    const leaf = memoryToolCallLeaf({ status: "completed", report: MARKER });
    // Leaf only in memory — same Grok booking shape; no artifact write.
    assert.deepEqual(readLatestToolCallLeaf({ sessionManager: { getEntries: () => [leaf] } }), leaf);

    // Old locator shape: session.jsonl only (pre-#632-r2 / material-deleted blind path).
    const located = await createAuditorDossierTool(runDirectory).execute("id", {});
    assert.equal(located.details?.parentSessionCandidate, sessionFile);
    assert.equal(located.details?.submissionCandidate, undefined);
    const pointed = readFileSync(located.details!.parentSessionCandidate, "utf8");
    assert.equal(pointed.includes(MARKER), false, "header-only pointer must not carry candidate body");
    assert.equal(pointed.includes('"type":"session"'), true);
    });
});

test("readLatestToolCallLeaf returns the last assistant toolCall entry", async () => {
  const older = memoryToolCallLeaf({ status: "old" });
  const newer = memoryToolCallLeaf({ status: "new", report: MARKER });
  const found = readLatestToolCallLeaf({
    sessionManager: {
      getEntries: () => [
        { type: "message", message: { role: "user", content: "hi" } },
        older,
        { type: "message", message: { role: "toolResult", content: [] } },
        newer,
      ],
    },
  });
  assert.deepEqual(found, newer);
});

test("persist returns undefined when session books have no toolCall leaf", async () => {
  await withTempRoot("ak-gate-empty-", async (runDirectory) => {
    const path = persistGateSubmissionCandidate(runDirectory, {
      sessionManager: {
        getEntries: () => [{ type: "message", message: { role: "user", content: "only user" } }],
      },
    });
    assert.equal(path, undefined);
    });
});

test("#753 gate officer resume instruction is human-readable source + candidate pointers", () => {
  const source = "/tmp/parent-run@countersign";
  const candidate = `${source}/artifacts/gate-submission-candidate.json`;
  const withCandidate = buildGateOfficerReviewInstruction({
    sourceRunDirectory: source,
    submissionCandidatePath: candidate,
  });
  assert.equal(withCandidate.includes("本轮父席交卷待审"), true);
  assert.equal(withCandidate.includes(`来源 run：${source}`), true);
  assert.equal(withCandidate.includes(`交卷候选（冻结快照）：${candidate}`), true);
  // No duty/handbook packaging (#755).
  assert.equal(withCandidate.includes("请按"), false);

  const sourceOnly = buildGateOfficerReviewInstruction({ sourceRunDirectory: source });
  assert.equal(sourceOnly.includes("交卷候选"), false);
  assert.equal(sourceOnly.includes(`来源 run：${source}`), true);
});

test("#753 same-ticket resume prompt carries gate review materials, not bare envelope", () => {
  const admitted = {
    runId: "run-1",
    runDirectory: "/tmp/notary-run",
    projectRoot: "/tmp/project",
    role: "notary",
  } as unknown as AdmittedRoleInvocation;
  const source = "/tmp/parent-run@countersign";
  const candidate = `${source}/artifacts/gate-submission-candidate.json`;
  const instruction = buildGateOfficerReviewInstruction({
    sourceRunDirectory: source,
    submissionCandidatePath: candidate,
  });
  const prepared = {
    instruction,
    instructionEmpty: false as const,
    attachments: [] as const,
  };
  const env = {
    packageRoot: "/tmp/pkg",
    home: "/tmp/home",
    agentDir: "/tmp/agent",
  } as PostAdmissionEnv;
  const options = resumeTurnRequestProjectionOptions(
    admitted,
    {
      runId: "run-1",
      summons: { instruction, instructionEmpty: false, sourceRunPath: source },
    },
    env,
    prepared,
  );
  assert.equal(options.continuation.kind, "resume");
  assert.equal(options.continuation.prompt, instruction);
  assert.equal(options.continuation.prompt.includes(candidate), true);
  assert.notEqual(options.continuation.prompt, RESUME_TRANSPORT_ENVELOPE);

  // Mutation oracle: summons without instruction/attachments stays bare envelope.
  const bare = resumeTurnRequestProjectionOptions(
    admitted,
    { runId: "run-1", summons: { sourceRunPath: source } },
    env,
    undefined,
  );
  assert.equal(bare.continuation.kind, "resume");
  assert.equal(bare.continuation.prompt, RESUME_TRANSPORT_ENVELOPE);
});
