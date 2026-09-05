import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  INSTITUTIONAL_RESOLUTION_FILE,
  readInstitutionalSeatSelection,
  writeInstitutionalResolutionPage,
  InstitutionalResolutionError,
  type InstitutionalResolutionPage,
} from "../../src/institutional-resolution.ts";
import { testTmpdir } from "../helpers/worktree-temp.ts";

test("resolution page write, read, missing-seat, resume rewrite, and corruption failures", async () => {
  const runDir = await mkdtemp(join(testTmpdir(), "ak-test-resolution-page-"));
  try {
    const pageV1: InstitutionalResolutionPage = {
      version: 1,
      seats: {
        gatekeeper: { provider: "prov-1", model: "mod-1" },
        inspector: { provider: "prov-1", model: "mod-1" },
        notary: { provider: "prov-1", model: "mod-1" },
      },
    };

    // 1. Write and read
    await writeInstitutionalResolutionPage(runDir, pageV1);
    const readGatekeeper = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(readGatekeeper, { provider: "prov-1", model: "mod-1" });

    // 2. Missing seat in existing page throws typed error
    await assert.rejects(
      () => readInstitutionalSeatSelection(runDir, "auditor"),
      (error) => {
        assert.ok(error instanceof InstitutionalResolutionError);
        return true;
      },
    );

    // 3. Resume rewrite updates page
    const pageV2: InstitutionalResolutionPage = {
      version: 1,
      seats: {
        gatekeeper: { provider: "prov-2", model: "mod-2", thinking: "high" },
        inspector: { provider: "prov-2", model: "mod-2", thinking: "high" },
        notary: { provider: "prov-2", model: "mod-2", thinking: "high" },
        auditor: { provider: "prov-2", model: "mod-2", thinking: "high" },
      },
    };
    await writeInstitutionalResolutionPage(runDir, pageV2);
    const readAfterResume = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(readAfterResume, { provider: "prov-2", model: "mod-2", thinking: "high" });

    // 4. Corrupted page throws typed error
    await writeFile(join(runDir, INSTITUTIONAL_RESOLUTION_FILE), "not valid json {{{{", "utf8");
    await assert.rejects(
      () => readInstitutionalSeatSelection(runDir, "gatekeeper"),
      (error) => {
        assert.ok(error instanceof InstitutionalResolutionError);
        return true;
      },
    );

    // 5. Missing runDir / missing page throws typed error
    const missingRunDir = join(runDir, "does-not-exist");
    await assert.rejects(
      () => readInstitutionalSeatSelection(missingRunDir, "gatekeeper"),
      (error) => {
        assert.ok(error instanceof InstitutionalResolutionError);
        return true;
      },
    );
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("run-lifecycle dispatch-resume seam refreshes institutional resolution and preserves effective model on engine update", async () => {
  const { markRunRunning } = await import("../../src/public-cli/run-lifecycle.ts");
  const { withActivationHome } = await import("../helpers/pi-test-harness.ts");
  await withActivationHome({ prefix: "ak-test-invocation-truth-" }, async ({ home }) => {
    // #604: runDirectory must sit under home/.ak-roles so homeFromRunDirectory
    // (recordEffectiveInvocationModel / markRunRunning) path-derives package home.
    const runDir = join(home, ".ak-roles", "books", "test-book", "runs", "0195-test-run@coder");
    const sessionDir = join(runDir, "session");
    await (await import("node:fs/promises")).mkdir(sessionDir, { recursive: true });

    // Initial invocation identity and run state written with effective model
    const initialLedger = {
      role: "coder",
      runId: "0195-test-run",
      bookKey: "test-book",
      projectRoot: home,
      runDirectory: runDir,
      sessionDirectory: sessionDir,
      sessionFile: join(sessionDir, "session.jsonl"),
      provider: "initial-provider",
      model: "initial-model",
      thinking: "high",
    };
    await writeFile(join(runDir, "invocation.json"), JSON.stringify(initialLedger, null, 2), "utf8");
    const initialRunState = {
      runId: "0195-test-run",
      role: "coder",
      state: "admitted",
      bookKey: "test-book",
      projectRoot: home,
      runDirectory: runDir,
      sessionDirectory: sessionDir,
      sessionFile: join(sessionDir, "session.jsonl"),
      admittedRequestPath: join(runDir, "admitted-request.json"),
      principalWire: { sessionDirectory: sessionDir, sessionFile: join(sessionDir, "session.jsonl") },
    };
    await writeFile(join(runDir, "run-state.json"), JSON.stringify(initialRunState, null, 2), "utf8");

    // 1. Calling markRunRunning without model (engine update on resume)
    await markRunRunning(runDir, undefined, "next-engine");

    // Institutional resolution page must recover parent effective model from invocation.json
    const gatekeeperSeat = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(gatekeeperSeat, {
      provider: "initial-provider",
      model: "initial-model",
      thinking: "high",
    });

    // Auditor and evidenceChild must also inherit recovered parent effective model
    const auditorSeat = await readInstitutionalSeatSelection(runDir, "auditor");
    assert.deepEqual(auditorSeat, {
      provider: "initial-provider",
      model: "initial-model",
      thinking: "high",
    });

    // 2. Calling markRunRunning with new model override
    await markRunRunning(runDir, {
      provider: "resume-provider",
      model: "resume-model",
    });

    const updatedGatekeeper = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(updatedGatekeeper, {
      provider: "resume-provider",
      model: "resume-model",
    });
    const updatedAuditor = await readInstitutionalSeatSelection(runDir, "auditor");
    assert.deepEqual(updatedAuditor, {
      provider: "resume-provider",
      model: "resume-model",
    });
  });
});

test("public CLI dispatch-resume entrypoint refreshes institutional resolution freshness", async () => {
  const { runAkRole } = await import("../../src/public-cli/cli.ts");
  const { resolveBookKeyFromGit } = await import("../../src/activation-ledger-git.ts");
  const { piDurablePrincipalAuthority } = await import("../../src/pi/durable-principal.ts");
  const { packageRoot } = await import("../helpers/pi-test-harness.ts");
  const { withTempHome, captureIo, seedGitProject } = await import("../helpers/failure-settlement-kit.ts");
  const { roleTurnHostFromLegacyPiRunner } = await import("../helpers/role-turn-host-fixture.ts");
  const { observeTyped429ViaProductionHandler } = await import("../helpers/typed-429-observation.ts");

  await withTempHome(async (home) => {
    const project = join(home, "proj");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-cli-resume-refresh-001";
    const { io } = captureIo();

    // 1. Initial run with model override
    await runAkRole(
      ["--model", "openai-codex/faux-1:high", "judge", "--project", project, "audit task"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await observeTyped429ViaProductionHandler({
              runDirectory: join(sessionDir, ".."),
              provider: "openai-codex",
            });
            const sessionFile = join(sessionDir, "session.jsonl");
            const stopEntry = {
              type: "message",
              message: {
                role: "assistant",
                stopReason: "error",
                errorMessage: "rate limited",
                provider: "openai-codex",
              },
            };
            await writeFile(sessionFile, `${JSON.stringify(stopEntry)}\n`, "utf8");
            return {
              code: 1,
              stderr: "rate limited\n",
              timedOut: false,
              args: [...args],
            };
          },
        }),
      },
    );

    const bookKey = resolveBookKeyFromGit(project);
    const runDir = join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@judge`);

    // Initial page verification
    const initialGatekeeper = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(initialGatekeeper, {
      provider: "openai-codex",
      model: "faux-1",
      thinking: "high",
    });
    const initialAuditor = await readInstitutionalSeatSelection(runDir, "auditor");
    assert.deepEqual(initialAuditor, {
      provider: "openai-codex",
      model: "faux-1",
      thinking: "high",
    });

    // 2. Real CLI resume with model override
    const { io: io2 } = captureIo();
    await runAkRole(
      ["--model", "xai/grok-4:low", "resume", runId],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io: io2,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await writeFile(
              join(sessionDir, "session.jsonl"),
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolName: "ak_judge_output",
                  isError: false,
                  details: { judgeStatus: "converged" },
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
        }),
      },
    );

    // Resumed page freshness verification
    const resumedGatekeeper = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(resumedGatekeeper, {
      provider: "xai",
      model: "grok-4",
      thinking: "low",
    });
    const resumedAuditor = await readInstitutionalSeatSelection(runDir, "auditor");
    assert.deepEqual(resumedAuditor, {
      provider: "xai",
      model: "grok-4",
      thinking: "low",
    });
  });
});

test("readInstitutionalSeatSelection reasons: missing-page, missing-seat, corrupted", async () => {
  const root = await mkdtemp(join(testTmpdir(), "ak-inst-reason-"));
  try {
    await assert.rejects(
      () => readInstitutionalSeatSelection(join(root, "absent"), "navigator"),
      (error: unknown) => error instanceof InstitutionalResolutionError && error.reason === "missing-page",
    );
    const runDirectory = join(root, "run");
    await mkdir(runDirectory);
    await writeFile(join(runDirectory, "institutional-resolution.json"), "{not-json\n", "utf8");
    await assert.rejects(
      () => readInstitutionalSeatSelection(runDirectory, "navigator"),
      (error: unknown) => error instanceof InstitutionalResolutionError && error.reason === "corrupted",
    );
    await writeFile(
      join(runDirectory, "institutional-resolution.json"),
      `${JSON.stringify({ version: 1, seats: { auditor: { provider: "p", model: "m" } } })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => readInstitutionalSeatSelection(runDirectory, "navigator"),
      (error: unknown) => error instanceof InstitutionalResolutionError && error.reason === "missing-seat",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
