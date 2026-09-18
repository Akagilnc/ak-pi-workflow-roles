/**
 * #953: honest diarist escalate diagnostic facts; artifact face reflects
 * current terminal (including seam-owned fallback error faces).
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
  clearOppositeTerminalArtifactFace,
  publishFailureArtifacts,
  publishJudgeArtifacts,
} from "../../src/public-cli/settlement.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { withTempHome } from "../helpers/failure-settlement-kit.ts";

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
  // Feature observation of payload facts — not presentation wording.
  assert.ok(withTicket.includes("946"));
  assert.ok(withTicket.includes("接缝探针"));
  assert.equal(withTicket.includes("cannot identify court target"), false);

  const withoutTicket = courtDiaristEscalateDiagnostic({
    kind: "accepted",
    role: "diarist",
    payloads: [{ status: "escalate", reason: "cannot identify court target" }],
  });
  // When diarist itself wrote that reason, relay is honest — not invented by parent.
  assert.ok(withoutTicket.includes("cannot identify court target"));

  const empty = courtDiaristEscalateDiagnostic(undefined);
  assert.equal(empty.includes("cannot identify court target"), false);
  assert.equal(typeof empty, "string");
  assert.ok(empty.length > 0);
});

test("#953 success artifact face drops prior error faces; failure face drops prior report", async () => {
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
    const runsParent = join(runDirectory, "..");
    await mkdir(artifactsDir, { recursive: true });

    const ownArtifactUnique = join(
      artifactsDir,
      "error.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json",
    );
    const ownRunUnique = join(
      runDirectory,
      "error.bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.json",
    );
    const ownParentUnique = join(
      runsParent,
      "error.cccccccc-dddd-4eee-8fff-000000000000.json",
    );
    const siblingParentUnique = join(
      runsParent,
      "error.dddddddd-eeee-4fff-8000-111111111111.json",
    );

    // Prior failure faces: conventional + settlement fallback + unique (same-run + parent).
    await writeFile(
      join(artifactsDir, "error.json"),
      `${JSON.stringify({ kind: "error", role: "judge", runId: "01a0-953", diagnostic: "old boom" })}\n`,
      "utf8",
    );
    await writeFile(
      join(artifactsDir, "error.settlement.json"),
      `${JSON.stringify({ kind: "error", role: "judge", runId: "01a0-953", diagnostic: "old settlement boom" })}\n`,
      "utf8",
    );
    await writeFile(
      join(runDirectory, "error.settlement.json"),
      `${JSON.stringify({ kind: "error", role: "judge", runId: "01a0-953", diagnostic: "old run-dir boom" })}\n`,
      "utf8",
    );
    await writeFile(
      ownArtifactUnique,
      `${JSON.stringify({ kind: "error", role: "judge", runId: "01a0-953", diagnostic: "own artifact unique" })}\n`,
      "utf8",
    );
    await writeFile(
      ownRunUnique,
      `${JSON.stringify({ kind: "error", role: "judge", runId: "01a0-953", diagnostic: "own run unique" })}\n`,
      "utf8",
    );
    await writeFile(
      ownParentUnique,
      `${JSON.stringify({ kind: "error", role: "judge", runId: "01a0-953", diagnostic: "own parent unique" })}\n`,
      "utf8",
    );
    await writeFile(
      siblingParentUnique,
      `${JSON.stringify({ kind: "error", role: "judge", runId: "someone-else", diagnostic: "sibling parent unique" })}\n`,
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
    await assert.rejects(
      () => access(join(artifactsDir, "error.settlement.json")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    await assert.rejects(
      () => access(join(runDirectory, "error.settlement.json")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    // Seam-owned unique faces cleared; sibling parent unique left (reader ownership).
    await assert.rejects(
      () => access(ownArtifactUnique),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    await assert.rejects(
      () => access(ownRunUnique),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    await assert.rejects(
      () => access(ownParentUnique),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    await access(siblingParentUnique);

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

test("#953 success clears directory-planted error face and settlement fallback", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      "proj",
      "unbound",
      "runs",
      "01a0-953-eisdir@judge",
    );
    const sessionDirectory = join(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "session.jsonl"), "", "utf8");
    const admitted = fixtureJudgeAdmitted({
      runId: "01a0-953-eisdir",
      runDirectory,
      projectRoot: join(home, "proj"),
      bookKey: "proj",
    });
    const artifactsDir = join(runDirectory, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    // Judge probe shape: conventional error face occupied as directory + settlement fallback file.
    await mkdir(join(artifactsDir, "error.json"), { recursive: true });
    await writeFile(
      join(artifactsDir, "error.settlement.json"),
      `${JSON.stringify({ kind: "error", role: "judge", runId: "01a0-953-eisdir", diagnostic: "plant" })}\n`,
      "utf8",
    );

    await publishJudgeArtifacts(
      admitted,
      {
        kind: "accepted",
        role: "judge",
        payloads: [{ judgeStatus: "pass" }],
      },
      piDurablePrincipalAuthority.decode(admitted.principal),
    );

    await access(join(artifactsDir, "report.json"));
    await assert.rejects(
      () => access(join(artifactsDir, "error.json")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    await assert.rejects(
      () => access(join(artifactsDir, "error.settlement.json")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  });
});

test("#953 unparseable run dir does not wipe parent unique faces (reader ownership)", async () => {
  await withTempHome(async (home) => {
    const runsParent = join(home, ".ak-roles", "books", "proj", "unbound", "runs");
    const badRun = join(runsParent, "not-a-role-run");
    await mkdir(badRun, { recursive: true });
    const siblingPath = join(
      runsParent,
      "error.ffffffff-1111-4222-8333-444444444444.json",
    );
    const claimedPath = join(
      runsParent,
      "error.eeeeeeee-dddd-4ccc-8bbb-aaaaaaaaaaaa.json",
    );
    await writeFile(
      siblingPath,
      `${JSON.stringify({ kind: "error", role: "judge", runId: "someone-else", diagnostic: "sibling" })}\n`,
      "utf8",
    );
    await writeFile(
      claimedPath,
      `${JSON.stringify({ kind: "error", role: "judge", runId: "not-a-role-run", diagnostic: "claimed" })}\n`,
      "utf8",
    );

    await clearOppositeTerminalArtifactFace(badRun, "report");

    // runIdFromRunDirectory undefined → presentUniqueFallbackBoundToRun false → parent untouched.
    await access(siblingPath);
    await access(claimedPath);
  });
});
