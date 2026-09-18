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
    await mkdir(artifactsDir, { recursive: true });

    // Prior failure faces: conventional + seam-owned settlement fallback.
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
      `${JSON.stringify({ kind: "error", role: "judge", runId: "01a0-953-eisdir", diagnostic: "plant" })}
`,
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
