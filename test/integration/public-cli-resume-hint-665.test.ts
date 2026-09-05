/**
 * #665 — 429 failure terminal resume hint is seat-uniform.
 * Seam: presentControlledFailure (post-admission). Principal available +
 * typed 429 → resume; no per-seat hasLawful / isResumableRole fork.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fixtureDoctorAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { presentControlledFailure } from "../../src/public-cli/post-admission.ts";
import {
  markRunAdmitted,
  readRoleRunState,
  renderResumeCommand,
} from "../../src/public-cli/run-lifecycle.ts";
import { testTmpdir } from "../helpers/worktree-temp.ts";

test("#665 typed 429 failure projects resume uniformly (no per-seat fork)", async () => {
  const home = await mkdtemp(join(testTmpdir(), "ak-665-resume-hint-"));
  try {
    const runId = "run-665-uniform-429";
    const runDirectory = join(home, "runs", `${runId}@doctor`);
    const sessionDirectory = join(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    const sessionFile = join(sessionDirectory, "session.jsonl");
    await writeFile(sessionFile, "", "utf8");
    await writeFile(join(runDirectory, "admitted-request.json"), "{}\n", "utf8");

    await observeTyped429ViaProductionHandler({
      runDirectory,
      provider: "openai-codex",
    });

    const caseRunsPath = join(home, "case-runs");
    const admitted = fixtureDoctorAdmitted({
      runId,
      runDirectory,
      bookKey: "book",
      projectRoot: home,
      issueNumber: 665,
      caseRunsPath,
      caseIdentity: { issueNumber: 665, runsPath: caseRunsPath },
    });
    await markRunAdmitted(admitted, piDurablePrincipalAuthority);

    const stdout: string[] = [];
    const stderr: string[] = [];
    // Doctor-shaped adapters: trySettle only — no per-seat resume fork flags.
    const result = await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: 1,
        stderr: "provider stop\n",
      },
      {
        trySettle: async () => undefined,
      },
      piDurablePrincipalAuthority,
      {
        stdout: (text) => {
          stdout.push(text);
        },
        stderr: (text) => {
          stderr.push(text);
        },
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.terminal.roleOutcome.kind, "failure");
    assert.ok(
      result.terminal.resume,
      "429 failure terminal must carry resume uniformly (no per-seat fork)",
    );
    assert.equal(result.terminal.resume.command, renderResumeCommand(runId));

    const durable = await readRoleRunState(runDirectory, piDurablePrincipalAuthority);
    assert.equal(durable?.state, "resumable");
    assert.deepEqual(durable?.resumable, {
      httpStatus: 429,
      provider: "openai-codex",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
