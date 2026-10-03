/**
 * Two public calls on one leg — the live leg and a manual resume — both write the leg's
 * current.json (#1161). Facts are rows first, so whichever finishes last, the file is the
 * rendering of the rows: the model the resume recorded stands, and every item in the file
 * has its source row.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { findRunDirectoryById } from "../../src/public-cli/run-lifecycle.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { roleTurnHostFromLegacyPiRunner as rawRoleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { assertCurrentIsRenderingOfRows, readCurrentSection } from "../helpers/run-dossier-fixture.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A judge host whose turn seals an accepted verdict; `pauseAfterSeal` holds the turn open after it. */
function sealingJudgeHost(note: string, pauseAfterSeal?: () => Promise<void>) {
  return withPassingReviewHost(rawRoleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: async (args) => {
      const sessionDir = args[args.indexOf("--session-dir") + 1]!;
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "session.jsonl"),
        `${JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolName: JUDGE_OUTPUT_TOOL_NAME, isError: false, details: { status: "converged", note } },
        })}\n`,
        "utf8",
      );
      await pauseAfterSeal?.();
      return {
        code: 0,
        stderr: "",
        timedOut: false,
        args: [...args],
        sealedAcceptance: { role: "judge", details: { status: "converged", note } },
      };
    },
  }));
}

test("a live leg and a manual resume write one current.json: the resumed model stands and the file is the rendering of the rows", async () => {
  await withTempRoot("ak-public-cli-concurrent-legs-", async (home) => {
    await configurePassingReviewSeats(home);
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-concurrent-legs-001";

    let releaseLive!: () => void;
    const liveHeld = new Promise<void>((resolve) => { releaseLive = resolve; });
    let liveInside!: () => void;
    const liveEntered = new Promise<void>((resolve) => { liveInside = resolve; });
    const liveIo = captureIo();
    const live = runAkRole(
      ["judge", "--model", "test/initial-model:high", "--project", project, "the live leg"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io: liveIo.io,
        roleTurnHost: sealingJudgeHost("live", async () => { liveInside(); await liveHeld; }),
      },
    );
    await liveEntered;

    // While the live leg is mid-turn, a public manual resume runs to the end with another model.
    const resumeIo = captureIo();
    const resumed = await runAkRole(
      ["resume", "--model", "test/resumed-model:high", runId],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io: resumeIo.io,
        roleTurnHost: sealingJudgeHost("resumed"),
      },
    );
    assert.equal(resumed.exitCode, 0, resumeIo.stderr.join(""));

    // The live leg then settles last.
    releaseLive();
    const liveResult = await live;
    assert.equal(liveResult.exitCode, 0, liveIo.stderr.join(""));

    const runDirectory = await findRunDirectoryById(home, runId, undefined, "judge");
    assert.ok(runDirectory !== undefined);
    assert.equal(readCurrentSection(runDirectory, "invocation").model, "resumed-model");
    assertCurrentIsRenderingOfRows(runDirectory);
  });
});
