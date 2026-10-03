import { historyPayloads, statePayloads, readCurrentJson, runLogPayloads, readCurrentSection, seedCurrentSection, submittedParams, terminalBodyAt, lockCurrentJson, unlockCurrentJson, clearCurrentSection } from "../helpers/run-dossier-fixture.ts";
import { pointedErrorRecord } from "../helpers/pointed-error-record.ts";

import { payloadStatusSequence, objectPayloads } from "../helpers/terminal-payload.ts";
/**
 * Public manual resume passthrough and host-failure settlement.
 * Seams: run-lifecycle / runAkRole(judge|resume) with injectable Pi runner.
 * Assert typed regions, exact-session reopen, temporary overrides,
 * reject-without-replay — never table labels or prose. #987: public manual
 * resume does not take a package writer-lease gate before host CLI resume.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadPublicCliConfig } from "../../src/public-cli/config.ts";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { createMinimalHost, roleTurnHostFromLegacyPiRunner as rawRoleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE } from "../../src/public-cli/post-admission.ts";
import {
  acquireRunWriterLease,
  describeErrorIdentity,
  loadResumablePublicRole,
  markRunAdmitted,
  readRoleRunState,
  RunWriterLeaseHeldError,
} from "../../src/public-cli/run-lifecycle.ts";
import { trySettlePublicSeat } from "../../src/public-cli/settlement.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { readRecordedSubmissions } from "../../src/submission-ledger.ts";
import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { readSitianRecords, resolveSitianRecordPath, resolveSitianRecordPathInLedger } from "../../src/sitian-facade.ts";
import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { materializeConflictedRepo } from "../helpers/merger-conflict-fixture.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-resume-", async (home) => {
    await configurePassingReviewSeats(home);
    return scenario(home);
  });
}

const roleTurnHostFromLegacyPiRunner: typeof rawRoleTurnHostFromLegacyPiRunner =
  (options) => withPassingReviewHost(rawRoleTurnHostFromLegacyPiRunner(options));

/**
 * Shared plant: seal accepted judge output, optionally block report publication.
 * #953 clears conventional faces (including directory plants) before rewrite,
 * so report.json-as-directory no longer reaches writeFile. When blocking,
 * lock current.json to 0o444 — the terminal write gets EACCES.
 * Throw/ledger poison cases pass blockReportPublication:false. A later
 * read or write fault is a note beside the host terminal.
 */
function sealedPublicationBlockedHost(
  note: string,
  options: { readonly blockReportPublication?: boolean } = {},
): {
  host: RoleTurnHost;
  dispatches: () => number;
  /** Best-effort restore so temp trees and resume rebuilds can write again. */
  restoreWritable: () => Promise<void>;
} {
  const blockReportPublication = options.blockReportPublication !== false;
  let dispatches = 0;
  const lockedCurrents = new Set<string>();
  const inner = roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: async (args) => {
      dispatches += 1;
      const sessionDir = args[args.indexOf("--session-dir") + 1]!;
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "session.jsonl"),
        `${JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolName: JUDGE_OUTPUT_TOOL_NAME,
            isError: false,
            details: {
              status: "converged",
              note,
            },
          },
        })}\n`,
        "utf8",
      );
      return {
        code: 0,
        stderr: "",
        timedOut: false,
        args: [...args],
        sealedAcceptance: {
          role: "judge",
          details: { status: "converged", note },
        },
      };
    },
  });
  // The seal is on the record once the turn returns; the leg's terminal write is
  // next. Locking current.json (an in-place rewrite fails on the file's own mode)
  // refuses that write while reads and history.jsonl appends still work. The fault
  // passes once a gate officer's turn begins, so the gates' own lawful pointer
  // writes into the judge's dossier are not caught by it.
  const restoreWritable = async () => {
    for (const file of lockedCurrents) {
      try {
        unlockCurrentJson(dirname(file));
      } catch {
        // cleanup best-effort
      }
    }
  };
  const host: RoleTurnHost = {
    executeTurn: async (request) => {
      if (request.activation.role !== "judge") await restoreWritable();
      const out = await inner.executeTurn(request);
      if (blockReportPublication && request.activation.role === "judge") {
        const current = join(request.runDirectory, "current.json");
        lockCurrentJson(dirname(current));
        lockedCurrents.add(current);
      }
      return out;
    },
  };
  return { host, dispatches: () => dispatches, restoreWritable };
}


function writeSessionProviderStop(
  sessionDir: string,
  input: {
    provider: string;
    errorMessage: string;
  },
): Promise<void> {
  return writeFile(
    join(sessionDir, "session.jsonl"),
    [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "go" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: input.errorMessage,
          provider: input.provider,
          model: "probe",
          api: "openai-responses",
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
}
test("quota-like prose without typed 429 is not resumable", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const runId = "run-prose-not-resume-001";

    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "prose only"],
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
          // No typed observation file. Only quota-like prose in errorMessage.
          await writeSessionProviderStop(sessionDir, {
            provider: "openai-codex",
            errorMessage: "HTTP 429 rate limited quota exhausted billing",
          });
          return {
            code: 1,
            stderr: "HTTP 429 rate limited\n",
            timedOut: false,
            args: [...args],
          };
        },
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    const bookKey = resolveBookKeyFromGit(project);
    const durable = await readRoleRunState(
      join(home, ".ak-roles", "books", bookKey, "unbound", "runs", `${runId}@judge`),
      piDurablePrincipalAuthority,
    );
    assert.equal(durable?.state, "terminal");
  });
});
async function assertCleanupDiagnosticNoted(
  sessionFile: string,
): Promise<void> {
  const entries = (await readFile(sessionFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { customType?: unknown; data?: { diagnostic?: unknown } });
  const diagnostic = entries.find(
    (entry) => entry.customType === POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE,
  );
  assert.equal(typeof diagnostic?.data?.diagnostic, "string");
}

test("lawful settlement keeps the accepted terminal when publication fails; resume rebuilds the report", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-lawful-publish-fail-001";
    const { io } = captureIo();
    const { host, dispatches, restoreWritable } = sealedPublicationBlockedHost(
      "lawful despite later publication failure",
    );

    try {
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "lawful then publish fails under 429"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          io,
          roleTurnHost: host,
        },
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.terminal);
      assert.equal(result.terminal!.roleOutcome.kind, "accepted");
      assert.equal(typeof result.terminal!.runId, "string");
      // Publication is a package fault beside the accepted host terminal.
      // A lawful terminal stops the auto-resume loop.
      assert.equal(dispatches(), 1);
      assert.equal(result.terminal!.autoResumeCount, 0);
      const bookKey = resolveBookKeyFromGit(project);
      const runDirectory = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "unbound", "runs",
        `${runId}@judge`,
      );
      await assertCleanupDiagnosticNoted(join(runDirectory, "session", "session.jsonl"));
      assert.ok((await readRecordedSubmissions(project, runId, home)).length > 0, "recorded accepted payload must survive publication failure");
      const admitted = (await loadResumablePublicRole(home, runId, piDurablePrincipalAuthority)).admitted;
      const historyOutcomes = () => historyPayloads<{ outcome?: { kind?: string } }>(runDirectory, "attempt-history")
        .map((payload) => payload.outcome?.kind);
      assert.deepEqual(historyOutcomes(), ["accepted"],
        "the sealed attempt is recorded once; publication failure is not a second attempt");

      // The accepted terminal FACT is recorded as a history row; only its rendering
      // was refused (the cleanup note above proves the refusal fired).
      const reportPath = join(runDirectory, "current.json");
      const recordedTerminals = statePayloads<{ face?: string }>(runDirectory, "terminal");
      assert.deepEqual(recordedTerminals.map((terminal) => terminal.face), ["report"]);

      // Unlock so bare resume can rebuild the public report from sealed facts.
      await restoreWritable();

      // #833 / #672 US6: bare resume reaches host; settlement rebuilds public report.
      let resumeDispatches = 0;
      const passthroughHost = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          resumeDispatches += 1;
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      });
      const { io: rebuildIo } = captureIo();
      const rebuilt = await runAkRole(["resume", "--model", "test/caller-seat:high", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io: rebuildIo,
        roleTurnHost: passthroughHost,
      });
      assert.equal(resumeDispatches, 1, "sealed bare resume must reach the host");
      assert.equal(rebuilt.exitCode, 0);
      assert.ok(rebuilt.terminal);
      assert.equal(rebuilt.terminal!.roleOutcome.kind, "accepted");
      if (rebuilt.terminal!.roleOutcome.kind === "accepted") {
        assert.equal(rebuilt.terminal!.roleOutcome.role, "judge");
        assert.deepEqual(payloadStatusSequence(rebuilt.terminal!.roleOutcome), ["converged"]);
        assert.equal(
          (objectPayloads(rebuilt.terminal!.roleOutcome)[0] ?? {}).note,
          "lawful despite later publication failure",
        );
      }
      // #836: seal no longer blocks redispatch; rebuilt accepted terminal is the proof.
      const reportBody = terminalBodyAt(reportPath, "report") as {
        role?: string;
        runId?: string;
        outcome?: { kind?: string; role?: string; payloads?: readonly unknown[] };
      };
      assert.equal(reportBody.role, "judge");
      assert.equal(reportBody.runId, runId);
      assert.equal(reportBody.outcome?.kind, "accepted");
      assert.equal(reportBody.outcome?.role, "judge");
      assert.equal("payloads" in (reportBody.outcome ?? {}), false);
      assert.equal(
        (submittedParams(runDirectory).at(-1) as { note?: string } | undefined)?.note,
        "lawful despite later publication failure",
      );
      assert.ok(
        rebuilt.terminal!.artifacts.some((a) => a.kind === "report" && a.path === reportPath),
        "rebuilt terminal must reference the public report artifact",
      );
      assert.ok(
        (await readRecordedSubmissions(project, runId, home)).length > 0,
        "recorded accepted payload must remain after report rebuild",
      );
      assert.deepEqual(historyOutcomes(), ["accepted", "accepted"],
        "the actual resume adds its own accepted attempt");
      assert.equal((await readRoleRunState(runDirectory, piDurablePrincipalAuthority))?.state, "terminal");
      await trySettlePublicSeat(admitted, piDurablePrincipalAuthority, undefined);
      await trySettlePublicSeat(admitted, piDurablePrincipalAuthority, undefined);
      assert.deepEqual(historyOutcomes(), ["accepted", "accepted"],
        "re-reading the latest seal must not append another attempt");
    } finally {
      await restoreWritable();
    }
  });

  // Direct throw after seal: settle/present rejects out of dispatch; sealed stop
  // must still consult ledger before any auto-resume redispatch (#648).
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-lawful-publish-throw-001";
    const captured = captureIo();
    const { host: inner, dispatches, restoreWritable } = sealedPublicationBlockedHost(
      "lawful then dispatch throws after seal",
      { blockReportPublication: false },
    );

    try {
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "lawful then throw after seal under 429"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          io: captured.io,
          roleTurnHost: {
            executeTurn: async (request) => {
              const out = await inner.executeTurn(request);
              if (request.activation.role === "judge") {
                // The run's facts are rows (the lifecycle page is a state.jsonl row): poison the
                // row file the later audit reads the run-state from, as main poisoned run-state.json.
                const statePath = join(request.runDirectory, "state.jsonl");
                await rm(statePath, { force: true });
                await mkdir(statePath);
              }
              return out;
            },
          },
        },
      );

      // Persist notes the damaged row file. The later mandatory audit reads that same
      // run-state, so the parent is not delivered as accepted.
      assert.equal(result.exitCode, 1);
      assert.equal(result.terminal, undefined);
      assert.equal(dispatches(), 1);
      const runDirectory = join(
        home,
        ".ak-roles",
        "books",
        resolveBookKeyFromGit(project),
        "unbound", "runs",
        `${runId}@judge`,
      );
      await assertCleanupDiagnosticNoted(join(runDirectory, "session", "session.jsonl"));
      assert.ok(
        (await readRecordedSubmissions(project, runId, home)).length > 0,
        "recorded accepted payload must survive a later persist failure",
      );
    } finally {
      await restoreWritable();
    }
  });

  // Failing ledger authority: read errors must preserve true cause and fail closed —
  // never wash into "unsealed" and redispatch (#648).
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-lawful-publish-ledger-fail-001";
    const { io } = captureIo();
    const { host: inner, dispatches, restoreWritable } = sealedPublicationBlockedHost(
      "lawful then ledger authority fails",
      { blockReportPublication: false },
    );

    try {
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "lawful then ledger read fails under 429"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          io,
          roleTurnHost: {
            executeTurn: async (request) => {
              const out = await inner.executeTurn(request);
              // Poison the same history file settlement reads.
              const ledgerFile = join(request.runDirectory, "history.jsonl");
              await rm(ledgerFile, { force: true });
              await mkdir(ledgerFile, { recursive: true });
              await assert.rejects(
                () => readRecordedSubmissions(project, runId, home),
                (error: NodeJS.ErrnoException) => error.code === "EISDIR",
              );
              return out;
            },
          },
        },
      );
      // Ledger damage is a package note. It does not invent a host failure,
      // and a lawful no_receipt stops the loop.
      assert.equal(dispatches(), 1);
      assert.equal(result.exitCode, 0);
      assert.ok(result.terminal);
      assert.equal(result.terminal!.autoResumeCount, 0);
      assert.equal(result.terminal!.roleOutcome.kind, "no_receipt");
      const runDirectory = join(
        home,
        ".ak-roles",
        "books",
        resolveBookKeyFromGit(project),
        "unbound", "runs",
        `${runId}@judge`,
      );
      await assertCleanupDiagnosticNoted(join(runDirectory, "session", "session.jsonl"));

      // #833: poisoned ledger no longer short-circuits manual resume — host is reached.
      // Settlement after the turn still fails closed on the ledger authority error.
      let resumeDispatches = 0;
      const { io: resumeIo } = captureIo();
      const resumeResult = await runAkRole(["resume", "--model", "test/caller-seat:high", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io: resumeIo,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            resumeDispatches += 1;
            return {
              code: 0,
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
        }),
      });
      assert.equal(resumeDispatches, 1, "ledger-authority-fail resume must reach the host");
      assert.equal(resumeResult.exitCode, 0);
      assert.equal(resumeResult.terminal?.roleOutcome.kind, "no_receipt");
      await assertCleanupDiagnosticNoted(join(runDirectory, "session", "session.jsonl"));

    } finally {
      await restoreWritable();
    }
  });

});
test("resume restores admitted identity and exact Pi session without resubmitting instruction", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const attachmentSrc = join(home, "authority.md");
    await writeFile(attachmentSrc, "authority-bytes-v1\n", "utf8");
    const runId = "run-resume-restore-001";
    const instruction = "original admitted instruction must not be resubmitted";
    const openedPrincipals = new Set<string>();

    // First admission interrupted by a nonzero host exit.
    {
      const { io } = captureIo();
      const first = await runAkRole([
          "judge", "--model", "test/caller-seat:high",
          "--project",
          project,
          "--attach",
          attachmentSrc,
          instruction,
        ],
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
            openedPrincipals.add(args[args.indexOf("--session") + 1]!);
            await mkdir(sessionDir, { recursive: true });
            await writeSessionProviderStop(sessionDir, {
              provider: "xai",
              errorMessage: "upstream declined",
            });
            return {
              code: 1,
              stderr: "fail\n",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      // Mutate source attachment after admission — resume must keep frozen bytes.
      await writeFile(attachmentSrc, "authority-bytes-MUTATED\n", "utf8");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "unbound", "runs",
      `${runId}@judge`,
    );
    const sessionDirectory = join(runDirectory, "session");
    // Simulate a resumable run-state written before sessionFile was persisted.
    const legacyState = readCurrentSection(runDirectory, "runState");
    delete legacyState.sessionFile;
    seedCurrentSection(runDirectory, "runState", legacyState);
    // The persisted principal survives project relocation. Keep the original
    // project coordinate reachable for the required post-submission audit.
    const movedProject = join(home, "moved-non-git-project");
    await rename(project, movedProject);
    await symlink(movedProject, project);
    const admittedBefore = readCurrentSection(runDirectory, "admitted") as {
      instruction: string;
      attachments: Array<{ frozenPath: string; sha256: string }>;
    };
    assert.equal(admittedBefore.instruction, instruction);
    assert.equal(admittedBefore.attachments.length, 1);
    const frozenPath = admittedBefore.attachments[0]!.frozenPath;
    const frozenSha = admittedBefore.attachments[0]!.sha256;

    const { io, stderr } = captureIo();
    let resumeArgs: string[] | undefined;
    const resumed = await runAkRole(
      ["--model", "xai/grok-4.5:high", "resume", runId],
      {
        packageRoot,
        home,
        cwd: movedProject,
        credentials: { "openai-codex": true, xai: true },
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          resumeArgs = [...args];
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const sessionFile = args[args.indexOf("--session") + 1]!;
          openedPrincipals.add(sessionFile);
          assert.equal(sessionDir, sessionDirectory);
          assert.equal(sessionFile, join(sessionDirectory, "session.jsonl"));
          // Exact principal reopen — never directory-latest --continue.
          assert.equal(args.includes("--continue"), false);
          // Must not resubmit original instruction as a new prompt payload.
          assert.equal(args.includes(instruction), false);
          assert.equal(args.includes("[ak-role:resume-continue]"), false);
          // Exact model override for this resume only.
          assert.equal(args[args.indexOf("--provider") + 1], "xai");
          assert.equal(args[args.indexOf("--model") + 1], "grok-4.5");
          assert.equal(args[args.indexOf("--thinking") + 1], "high");
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: { status: "converged", note: "resumed ok" },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "judge", details: { status: "converged", note: "resumed ok" } },
          };
        },
        }),
      },
    );

    assert.ok(resumeArgs, stderr.join(""));
    assert.equal(resumed.exitCode, 0, stderr.join(""));
    assert.ok(resumed.terminal);
    assert.equal(resumed.terminal!.roleOutcome.kind, "accepted");
    assert.equal(resumed.terminal!.runId, runId);

    // Frozen attachment bytes unchanged after source mutation.
    const frozenBytes = await readFile(frozenPath, "utf8");
    assert.equal(frozenBytes, "authority-bytes-v1\n");
    const admittedAfter = readCurrentSection(runDirectory, "admitted") as { attachments: Array<{ sha256: string }> };
    assert.equal(admittedAfter.attachments[0]!.sha256, frozenSha);

    const durable = await readRoleRunState(runDirectory, piDurablePrincipalAuthority);
    assert.equal(durable?.state, "terminal");
    assert.equal(durable?.sessionFile, join(sessionDirectory, "session.jsonl"));
    assert.deepEqual([...openedPrincipals], [
      join(sessionDirectory, "session.jsonl"),
    ]);
  });
});

test("resume model override is temporary and does not rewrite persistent config", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Seed persistent judge config.
    {
      const { io } = captureIo();
      const set = await runAkRole(
        ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
        { packageRoot, home, cwd: project, io },
      );
      assert.equal(set.exitCode, 0);
    }

    const runId = "run-temp-override-001";
    {
      const { io } = captureIo();
      await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "hit 429"], {
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
          await writeSessionProviderStop(sessionDir, {
            provider: "openai-codex",
            errorMessage: "declined",
          });
          return {
            code: 1,
            stderr: "x\n",
            timedOut: false,
            args: [...args],
          };
        },
        }),
      });
    }

    const { io } = captureIo();
    await runAkRole(["--model", "xai/grok-4.5:medium", "resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
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
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: { status: "converged" },
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
    });

    // Persistent config unchanged — temporary override only.
    assert.deepEqual((await loadPublicCliConfig(home)).seats.judge, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
  });
});

test("resume model precedence: live seat table wins bare resume; explicit --model beats seat table", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const instruction = "resume model precedence probe";

    async function admitResumable(runId: string) {
      const { io } = captureIo();
      const first = await runAkRole(
        ["--model", "xai/grok-4.5:high", "judge", "--project", project, instruction],
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
              await writeSessionProviderStop(sessionDir, {
                provider: "xai",
                errorMessage: "declined",
              });
              return {
                code: 1,
                stderr: "x\n",
                timedOut: false,
                args: [...args],
              };
            },
          }),
        },
      );
    }

    // Run A: bare resume follows the live seat table (not admitted birth model).
    {
      const runId = "run-model-precedence-a";
      await admitResumable(runId);
      {
        const { io } = captureIo();
        await runAkRole(
          ["config", "set", "judge", "openai-codex/gpt-5.6-sol:medium"],
          { packageRoot, home, io },
        );
      }
      const { io } = captureIo();
      let modelLessArgs: string[] | undefined;
      // Bare resume — no --model; live seat table (config set above) is the source.
      const resumed = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            modelLessArgs = [...args];
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await writeFile(
              join(sessionDir, "session.jsonl"),
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolName: JUDGE_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: { status: "converged" },
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              stderr: "",
              timedOut: false,
              args: [...args],
              sealedAcceptance: { role: "judge", details: { status: "converged" } },
            };
          },
        }),
      });
      assert.ok(modelLessArgs, "bare resume must dispatch a Pi turn");
      assert.equal(modelLessArgs[modelLessArgs.indexOf("--provider") + 1], "openai-codex");
      assert.equal(modelLessArgs[modelLessArgs.indexOf("--model") + 1], "gpt-5.6-sol");
      assert.equal(modelLessArgs[modelLessArgs.indexOf("--thinking") + 1], "medium");
      assert.equal(resumed.exitCode, 0);
    }

    // Run B: an explicit CLI --model on resume beats the live seat table.
    {
      const runId = "run-model-precedence-b";
      await admitResumable(runId);
      {
        const { io } = captureIo();
        await runAkRole(
          ["config", "set", "judge", "xai/grok-4.5:high"],
          { packageRoot, home, io },
        );
      }
      const { io } = captureIo();
      let explicitArgs: string[] | undefined;
      const resumed = await runAkRole(
        ["--model", "openai-codex/gpt-5.6-sol:off", "resume", runId],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
              explicitArgs = [...args];
              const sessionDir = args[args.indexOf("--session-dir") + 1]!;
              await writeFile(
                join(sessionDir, "session.jsonl"),
                `${JSON.stringify({
                  type: "message",
                  message: {
                    role: "toolResult",
                    toolName: JUDGE_OUTPUT_TOOL_NAME,
                    isError: false,
                    details: { status: "converged" },
                  },
                })}\n`,
                "utf8",
              );
              return {
                code: 0,
                stderr: "",
                timedOut: false,
                args: [...args],
                sealedAcceptance: { role: "judge", details: { status: "converged" } },
              };
            },
          }),
        },
      );
      assert.ok(explicitArgs, "explicit-model resume must dispatch a Pi turn");
      assert.equal(explicitArgs[explicitArgs.indexOf("--provider") + 1], "openai-codex");
      assert.equal(explicitArgs[explicitArgs.indexOf("--model") + 1], "gpt-5.6-sol");
      assert.equal(explicitArgs[explicitArgs.indexOf("--thinking") + 1], "off");
      assert.equal(resumed.exitCode, 0);
      assert.deepEqual((await loadPublicCliConfig(home)).seats.judge, {
        provider: "xai",
        model: "grok-4.5",
        thinking: "high",
      });
    }
  });
});

test("unknown run id rejects; terminal run still reaches host (#416/#1091)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    let dispatches = 0;
    const runner = async (args: readonly string[]) => {
      dispatches += 1;
      return {
        code: 0,
        stderr: "",
        timedOut: false,
        args: [...args],
      };
    };

    {
      const { io } = captureIo();
      const unknown = await runAkRole(["resume", "--model", "test/caller-seat:high", "does-not-exist"], {
        packageRoot,
        home,
        cwd: project,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: runner,
        }),
      });
      assert.equal(unknown.exitCode, 2);
      assert.equal(dispatches, 0);
    }

    // Terminal failure run: #416/#1091 load does not gate on terminal state.
    const terminalId = "run-terminal-reject-001";
    {
      const { io } = captureIo();
      await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "activation fail"], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => terminalId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          return {
            code: 1,
            stderr: "activation boom\n",
            timedOut: false,
            args: [...args],
          };
        },
        }),
      });
    }
    dispatches = 0;
    {
      const { io } = captureIo();
      const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", terminalId], {
        packageRoot,
        home,
        cwd: project,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: runner,
        }),
      });
      assert.equal(dispatches, 1);
      assert.equal(resumed.exitCode, 0);
    }

    await assert.rejects(
      () => loadResumablePublicRole(home, "missing", piDurablePrincipalAuthority),
      CliUsageError,
    );
  });
});
test("#987 public manual resume reaches host CLI despite live writer lease", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-lease-001";
    const { io } = captureIo();
    await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "lease setup"], {
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
        await writeSessionProviderStop(sessionDir, {
          provider: "openai-codex",
          errorMessage: "declined",
        });
        return {
          code: 1,
          stderr: "x\n",
          timedOut: false,
          args: [...args],
        };
      },
      }),
    });

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "unbound", "runs",
      `${runId}@judge`,
    );
    const lease = await acquireRunWriterLease(runDirectory);
    let dispatches = 0;
    let savedRunState = "";
    await withPrimaryAwareCleanup(
      async () => {
        const { io: capturedIo } = captureIo();
        const io2 = {
          ...capturedIo,
          stderr: () => {
            // The failed parent write has already been observed. Restore the
            // source run before the mandatory Notary/Auditor summons reads it.
            rmSync(join(runDirectory, "current.json"), { recursive: true });
            writeFileSync(join(runDirectory, "current.json"), savedRunState);
            throw new Error("stderr sink failed");
          },
        };
        const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId], {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          io: io2,
          roleTurnHost: {
            executeTurn: async (request) => {
              const result = await withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
                packageRoot,
                principalAuthority: piDurablePrincipalAuthority,
                piRunner: async (args) => {
                  dispatches += 1;
                  const sessionPath = args[args.indexOf("--session") + 1]!;
                  await writeFile(
                    sessionPath,
                    `${JSON.stringify({
                      type: "message",
                      message: {
                        role: "toolResult",
                        toolName: JUDGE_OUTPUT_TOOL_NAME,
                        isError: false,
                        details: { status: "converged", note: "resume despite live lease" },
                      },
                    })}\n`,
                    "utf8",
                  );
                  return {
                    code: 0,
                    stderr: "",
                    timedOut: false,
                    args: [...args],
                    sealedAcceptance: {
                      role: "judge",
                      details: { status: "converged", note: "resume despite live lease" },
                    },
                  };
                },
              })).executeTurn(request);
              if (request.activation.role === "judge") {
                const statePath = join(runDirectory, "current.json");
                savedRunState = await readFile(statePath, "utf8");
                await rm(statePath, { force: true });
                await mkdir(statePath);
              }
              return result;
            },
          },
        });
        // #987: live package writer lease must not pre-block host CLI resume.
        assert.equal(dispatches, 1);
        assert.equal(resumed.exitCode, 0);
        assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
        const entries = (await readFile(join(runDirectory, "session", "session.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { customType?: unknown; data?: { diagnostic?: unknown } });
        const text = entries.find(
          (entry) => entry.customType === POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE,
        )?.data?.diagnostic;
        assert.equal(typeof text, "string");
      },
      async () => {
        await lease.release();
      },
    );

    // Shared lease acquire itself still fails closed for other authorized writers.
    const first = await acquireRunWriterLease(runDirectory);
    await assert.rejects(
      () => acquireRunWriterLease(runDirectory),
      (error: unknown) => error instanceof RunWriterLeaseHeldError,
    );
    await first.release();
  });
});

test("#418 lease release stays best-effort when cleanup fails: residual lock left, next acquire works", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "run-lease-cleanup-cause@judge");
    await mkdir(runDirectory, { recursive: true });
    const lease = await acquireRunWriterLease(runDirectory);
    // Force a truthful non-EACCES unlink failure: replace the lock file with a
    // directory so release's unlink fails (EISDIR on Linux, EPERM on macOS).
    const lockPath = join(runDirectory, "writer.lock");
    await unlink(lockPath);
    await mkdir(lockPath);
    await lease.release();
    // The failed release must leave the residual lock object on disk.
    await stat(lockPath);
    await rm(lockPath, { recursive: true });
    // Best-effort continue semantics preserved: next acquire succeeds.
    const next = await acquireRunWriterLease(runDirectory);
    await next.release();
  });
});

test("#418 lease release stays best-effort when the diagnostic sink throws", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "run-lease-sink-throws@judge");
    await mkdir(runDirectory, { recursive: true });
    let sinkCalls = 0;
    const lease = await acquireRunWriterLease(runDirectory, () => {
      sinkCalls += 1;
      throw new Error("diagnostic sink exploded");
    });
    // Force a truthful non-EACCES unlink failure (same seam as above).
    const lockPath = join(runDirectory, "writer.lock");
    await unlink(lockPath);
    await mkdir(lockPath);
    // Contract: release() resolves despite the throwing sink — no propagation.
    await lease.release();
    assert.equal(sinkCalls, 1);
    await rm(lockPath, { recursive: true });
  });
});

test("#418 lease release recovery path emits no false diagnostic", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "run-lease-recover@judge");
    await mkdir(runDirectory, { recursive: true });
    const diagnostics: string[] = [];
    const lease = await acquireRunWriterLease(runDirectory, (line) => diagnostics.push(line));
    // EACCES unlink → chmod retry recovers; the success path must stay silent.
    await chmod(runDirectory, 0o500);
    await withPrimaryAwareCleanup(
      async () => {
        await lease.release();
        assert.equal(diagnostics.length, 0);
      },
      async () => {
        await chmod(runDirectory, 0o755);
      },
    );
  });
});

test("#629 stale reclaim re-autopsies after the EACCES chmod — a contender live lock is never stolen", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "run-reclaim-toctou@judge");
    await mkdir(runDirectory, { recursive: true });
    const lockPath = join(runDirectory, "writer.lock");
    // Contender = this test process: a pid that is verifiably alive in the window.
    const contenderPid = process.pid;
    // Stale dead-holder lock in a non-writable run directory.
    const child = spawn("sleep", ["30"]);
    const stalePid = child.pid;
    assert.ok(typeof stalePid === "number" && stalePid > 0);
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await writeFile(lockPath, `${stalePid}\n`, "utf8");
    await chmod(runDirectory, 0o555);
    // Deterministic contender injection without production hooks: the spinner
    // fires at every event-loop check phase and injects exactly when the chmod
    // recovery has restored directory writability while the stale dead lock
    // still owns the pathname — the precise window where the old code blindly
    // unlinked and the fixed code must re-autopsy. Never before (dir unwritable
    // until the recovery chmod) and never after (content no longer stale).
    let injectionArmed = true;
    const spinner = (): void => {
      if (!injectionArmed) return;
      try {
        if (
          (statSync(runDirectory).mode & 0o200) !== 0 &&
          existsSync(lockPath) &&
          readFileSync(lockPath, "utf8").trim() === String(stalePid)
        ) {
          writeFileSync(lockPath, `${contenderPid}\n`, "utf8");
          return;
        }
      } catch {
        // lock vanished mid-spin; keep spinning until acquire settles
      }
      setImmediate(spinner);
    };
    setImmediate(spinner);
    await withPrimaryAwareCleanup(
      async () => {
        await assert.rejects(
          () => acquireRunWriterLease(runDirectory),
          (error: unknown) => error instanceof RunWriterLeaseHeldError,
        );
        // The contender's live lock must still own the pathname: no blind
        // post-chmod unlink, and the acquire rejected instead of creating a
        // second writer.
        assert.equal(await readFile(lockPath, "utf8"), `${contenderPid}\n`);
      },
      async () => {
        injectionArmed = false;
      },
      async () => {
        await chmod(runDirectory, 0o755);
      },
      async () => {
        await rm(lockPath, { force: true });
      },
    );
  });
});

test("#629 persistent EACCES keeps its identity in the stayed-contested refusal", async () => {
  // macOS-only construction: a deny-delete ACE on the lock file survives the
  // reclaim chmod, so every unlink round fails EACCES deterministically. POSIX
  // mode bits alone cannot build this (the recovery chmod would clear them).
  if (process.platform !== "darwin") return;
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "run-reclaim-eacces@judge");
    await mkdir(runDirectory, { recursive: true });
    const lockPath = join(runDirectory, "writer.lock");
    const child = spawn("sleep", ["30"]);
    const stalePid = child.pid;
    assert.ok(typeof stalePid === "number" && stalePid > 0);
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await writeFile(lockPath, `${stalePid}\n`, "utf8");
    execFileSync("chmod", ["+a", "everyone deny delete", lockPath]);
    await withPrimaryAwareCleanup(
      async () => {
        const failure = await acquireRunWriterLease(runDirectory).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(failure instanceof RunWriterLeaseHeldError);
        // The refusal carries the real reclaim errno structurally, not just the
        // dead-pid autopsy — otherwise the true cause is laundered away. Both
        // the wrapper's own code and the underlying EACCES are asserted, so
        // dropping the reclaim identity fails this test.
        assert.equal(failure.code, "AK_RUN_WRITER_LEASE_HELD");
        assert.equal(failure.causeCode, "EACCES");
        // Fail-closed: the unreclaimable lock stays on disk, never blind-deleted.
        assert.equal(existsSync(lockPath), true);
      },
      async () => {
        execFileSync("chmod", ["-a#", "0", lockPath]);
      },
      async () => {
        await rm(lockPath, { force: true });
      },
    );
  });
});

test("host-issued sessionFile coordinate reaches activation and resume execution seams", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-session-principal-001";
    // Host issues a distinctive sessionFile coordinate (not the Pi default name).
    // Contract under test: the opaque frozen wire is the principal on resume,
    // not public-cli rebuilt objects — alternate authority brands decode output
    // to distinguish frozen wire (pass) from reconstructed coordinates (fail).
    const principalAuthority = {
      issue(request: Parameters<typeof piDurablePrincipalAuthority.issue>[0]) {
        const base = piDurablePrincipalAuthority.issue(request);
        const coords = piDurablePrincipalAuthority.decode(base);
        return fixturePrincipal(
          coords.sessionDirectory,
          join(coords.sessionDirectory, "host-issued-principal.jsonl"),
        );
      },
      seal(coordinates: Parameters<typeof piDurablePrincipalAuthority.seal>[0]) {
        return fixturePrincipal(
          coordinates.sessionDirectory,
          join(coordinates.sessionDirectory, "host-issued-principal.jsonl"),
        );
      },
      decode(value: unknown) {
        const coords = piDurablePrincipalAuthority.decode(value);
        return Object.assign({}, coords, { __durableCoords: true });
      },
    };

    {
      const { io } = captureIo();
      const first = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "bind exact session"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          principalAuthority,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority,
            piRunner: async (args) => {
            const sessionDir = (args as string[])[(args as string[]).indexOf("--session-dir") + 1]!;
            const sessionPath = (args as string[])[(args as string[]).indexOf("--session") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeSessionProviderStop(sessionDir, {
              provider: "openai-codex",
              errorMessage: "rate limited",
            });
            await writeFile(sessionPath, "\n", "utf8");
            return {
              code: 1,
              stderr: "fail\n",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(first.exitCode, 1);
      assert.equal(first.terminal?.roleOutcome.kind, "failure");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "unbound", "runs",
      `${runId}@judge`,
    );
    const durable = await readRoleRunState(runDirectory, principalAuthority);
    assert.ok(durable);
    assert.equal(
      durable.sessionFile.endsWith("/session/host-issued-principal.jsonl"),
      true,
      durable.sessionFile,
    );
    assert.equal(durable.state, "terminal");

    // Successful resume with opaque frozen wire must reopen the same host-issued sessionFile.
    // #1091: package no longer gates resume on local session files.
    const { io } = captureIo();
    const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      principalAuthority,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
        const sessionPath = (args as string[])[(args as string[]).indexOf("--session") + 1]!;
        await writeFile(
          sessionPath,
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: { status: "converged", note: "principal ok" },
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
          sealedAcceptance: { role: "judge", details: { status: "converged", note: "principal ok" } },
        };
      },
      }),
    });
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    const after = await readRoleRunState(runDirectory, principalAuthority);
    assert.equal(after?.state, "terminal");
    assert.equal(after?.sessionFile.endsWith("/session/host-issued-principal.jsonl"), true);
  });
});

test("#1091 resume with missing session file loads identity and attempts host", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-missing-principal-001";
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "unbound", "runs",
      `${runId}@judge`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const sessionFile = join(sessionDirectory, "session.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    seedCurrentSection(runDirectory, "admitted", {
      role: "judge",
      instruction: "x",
      instructionEmpty: false,
      attachments: [],
    });
    await markRunAdmitted({
      role: "judge",
      runId,
      bookKey,
      projectRoot: project,
      instruction: "x",
      instructionEmpty: false,
      attachments: [],
      runDirectory,
      principal: fixturePrincipal(sessionDirectory, sessionFile),
    }, piDurablePrincipalAuthority);
    seedCurrentSection(runDirectory, "invocation", {});
    // Principal path is bound but the file itself is missing — not a package gate (#1091).

    const loaded = await loadResumablePublicRole(home, runId, piDurablePrincipalAuthority);
    assert.equal(loaded.admitted.runId, runId);

    const { io, stderr } = captureIo();
    let dispatches = 0;
    const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
        dispatches += 1;
        return {
          code: 1,
          stderr: "host-session-gone\n",
          timedOut: false,
          args: [...args],
        };
      },
      }),
    });
    assert.equal(dispatches, 1);
    assert.notEqual(resumed.exitCode, 0);
    // #1058: read the record the caller was pointed at, not a test-known path.
    const noted = await pointedErrorRecord(runDirectory, stderr.join("")) as {
      diagnostic?: unknown;
      details?: { exitCode?: unknown };
    };
    assert.equal(noted.details?.exitCode, 1);
  });
});
/** #471 transport on existing resume owner: opaque stdin body + bare -- + extras reject. */
test("#471 resume opaque message rides typed stdin; bare -- dispatches; extras reject", async () => {
  await withTempHome(async (home) => {
    type Role = "judge" | "coder" | "fixer" | "reviewer" | "merger";
    const creds = { "openai-codex": true, xai: true } as const;

    function admitArgs(role: Role, project: string): string[] {
      // Host-failure admission uses the xai seat and credentials.
      const model = ["--model", "xai/grok-4.5:high"] as const;
      if (role === "judge") return ["judge", ...model, "--project", project, "admit"];
      if (role === "coder") return ["coder", ...model, "plan", "--project", project, "admit"];
      if (role === "fixer") return ["fixer", ...model, "plan", "--project", project, "admit"];
      if (role === "reviewer") return ["reviewer", ...model, "--project", project, "--base", "main", "--lens", "completeness", "--authority-ref", "CLAUDE.md", "admit"];
      return ["merger", ...model, "--project", project, "admit"];
    }

    async function admit429(role: Role, runId: string, project: string): Promise<{
      sessionFile: string;
      sessionDirectory: string;
    }> {
      const { io } = captureIo();
      const first = await runAkRole(admitArgs(role, project), {
        packageRoot,
        home,
        cwd: project,
        credentials: creds,
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sd = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sd, { recursive: true });
          await writeFile(join(sd, "session.jsonl"), "", "utf8");
          return { code: 1, stderr: "quota", timedOut: false, args: [...args] };
        },
        }),
      });
      const sessionDirectory = join(
        home,
        ".ak-roles",
        "books",
        resolveBookKeyFromGit(project),
        "unbound", "runs",
        `${runId}@${role}`,
        "session",
      );
      return { sessionDirectory, sessionFile: join(sessionDirectory, "session.jsonl") };
    }

    const cases: ReadonlyArray<{
      role: Role;
      runId: string;
      message?: string;
      conflict?: true;
    }> = [
      { role: "judge", runId: "471-j-plain", message: "owner says proceed" },
      { role: "judge", runId: "471-j-model", message: "--model" },
      { role: "judge", runId: "471-j-empty", message: "" },
      { role: "judge", runId: "471-j-ws", message: "  ruling with\nnewline  " },
      { role: "coder", runId: "471-c-envelope", message: '{"kind":"ak-user-dialogue","body":"ACTUAL"}' },
      { role: "judge", runId: "471-j-dd", message: "--" },
      { role: "coder", runId: "471-c", message: "coder owner note" },
      { role: "fixer", runId: "471-f", message: "fixer owner note" },
      { role: "reviewer", runId: "471-r", message: "reviewer owner note" },
      { role: "merger", runId: "471-m", message: "merger owner note", conflict: true },
      { role: "judge", runId: "471-j-bare" },
    ];

    for (const c of cases) {
      const project = join(home, `p-${c.runId}`);
      await mkdir(project, { recursive: true });
      if (c.conflict) await materializeConflictedRepo(project);
      else seedGitProject(project);
      const admitted = await admit429(c.role, c.runId, project);
      // Resume needs a caller model (#178); message tests are orthogonal.
      const resumeArgv =
        c.message === undefined
          ? ["resume", "--model", "xai/grok-4.5:high", c.runId]
          : ["resume", "--model", "xai/grok-4.5:high", c.runId, c.message];
      const { io, stderr } = captureIo();
      let seen: string[] | undefined;
      let seenStdin: string | undefined;
      let n = 0;
      await runAkRole(resumeArgv, {
        packageRoot,
        home,
        cwd: project,
        credentials: creds,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args, options) => {
          n += 1;
          seen = [...args];
          seenStdin = options.stdin;
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
        }),
      });
      assert.equal(n, 1, `${c.runId}: dispatch; ${stderr.join("")}`);
      assert.ok(seen);
      assert.equal(seen[seen.indexOf("--session") + 1], admitted.sessionFile);
      assert.equal(seen[seen.indexOf("--session-dir") + 1], admitted.sessionDirectory);
      // Resume continues the existing method turn instead of invoking its Skill again.
      const rawPrompt = c.message === undefined ? "" : c.message;
      const expectedBody = rawPrompt;
      assert.equal(readUserDialogueStdin(seenStdin ?? ""), expectedBody);
      assert.equal(readUserDialogueStdin((seenStdin ?? "").trim()), expectedBody);
    }

    // extras → usage reject, dispatch=0 (including `-- extra`)
    {
      const project = join(home, "p-extra");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const runId = "471-extra";
      await admit429("judge", runId, project);
      for (const bad of [
        ["resume", runId, "one", "two"],
        ["resume", runId, "--", "extra"],
      ] as const) {
        const { io } = captureIo();
        let n = 0;
        const rejected = await runAkRole([...bad], {
          packageRoot,
          home,
          cwd: project,
          credentials: creds,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            n += 1;
            return { code: 0, stderr: "", timedOut: false, args: [...args] };
          },
          }),
        });
        // Nothing dispatched and the CLI rejected the argv; the help wording
        // printed for it is presentation.
        assert.equal(n, 0, bad.join(" "));
        assert.notEqual(rejected.exitCode, 0);
      }
    }
  });
});

test("public resume failures persist structured diagnostics", async () => {
  const priorSubject = process.env.AK_ROLE_AUDITOR_SUBJECT;
  delete process.env.AK_ROLE_AUDITOR_SUBJECT;
  try {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const bookKey = resolveBookKeyFromGit(project);
      const gone = join(home, "gone-workspace");
      await mkdir(gone, { recursive: true });
      seedGitProject(gone);
      const sourceRun = join(home, "audited-source");
      await mkdir(sourceRun, { recursive: true });
      async function seed(input: {
        readonly runId: string;
        readonly role: "secretariat" | "auditor" | "judge";
        readonly session: boolean;
        readonly projectRoot: string;
        readonly ticketNumber?: number;
        readonly sourceRunPath?: string;
        readonly correlationId?: string;
      }) {
        const runDirectory = join(home, ".ak-roles", "books", bookKey, "unbound", "runs", `${input.runId}@${input.role}`);
        const sessionDirectory = join(runDirectory, "session");
        const sessionFile = join(sessionDirectory, "session.jsonl");
        await mkdir(sessionDirectory, { recursive: true });
        if (input.session) await writeFile(sessionFile, "\n", "utf8");
        seedCurrentSection(runDirectory, "invocation", {});
        seedCurrentSection(runDirectory, "admitted", {
          role: input.role,
          instruction: "x",
          instructionEmpty: false,
          attachments: [],
          ...(input.ticketNumber === undefined ? {} : { ticketNumber: input.ticketNumber }),
          ...(input.sourceRunPath === undefined ? {} : { sourceRunPath: input.sourceRunPath }),
          ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        });
        await markRunAdmitted({
          role: input.role,
          runId: input.runId,
          bookKey,
          projectRoot: input.projectRoot,
          instruction: "x",
          instructionEmpty: false,
          attachments: [],
          runDirectory,
          principal: fixturePrincipal(sessionDirectory, sessionFile),
        }, piDurablePrincipalAuthority);
        return { runDirectory, sessionFile, sessionDirectory };
      }

      await seed({
        runId: "1058-no-workspace",
        role: "secretariat",
        session: true,
        projectRoot: gone,
        ticketNumber: 1058,
      });
      const auditor = await seed({
        runId: "1058-auditor",
        role: "auditor",
        session: true,
        projectRoot: project,
        sourceRunPath: sourceRun,
      });
      const unknownHost = await seed({
        runId: "1058-unknown-host", role: "secretariat", session: true, projectRoot: project,
      });
      await rm(gone, { recursive: true, force: true });

      const seen: RoleTurnRequest[] = [];
      const host = createMinimalHost(async (request) => {
        seen.push(request);
        return { code: 1, stderr: "zeta-unique-host-diagnostic", timedOut: false };
      });
      const resume = async (argv: readonly string[]) => {
        const captured = captureIo();
        const result = await runAkRole([...argv], {
          packageRoot,
          home,
          cwd: home,
          credentials: { "openai-codex": true, xai: true },
          io: captured.io,
          hostAdapters: [
            { name: "pi", create: () => ({ ok: true as const, host }) },
            { name: "claude", create: () => ({ ok: true as const, host }) },
          ],
        });
        return { ...result, stderr: captured.stderr.join("") };
      };
      // #1058: the record must be the one the caller was pointed at, not a path
      // this test already knows — persistence alone proves nothing about delivery.
      const readError = async (pointed: Promise<Record<string, unknown>>, expectedRunId: string) => {
        const record = await pointed as { kind?: unknown; runId?: unknown; diagnostic?: unknown };
        assert.equal(record.kind, "error");
        assert.equal(record.runId, expectedRunId);
        assert.equal(typeof record.diagnostic, "string");
        return record;
      };
      const assertRecordedFailure = async (
        runDirectory: string,
        runId: string,
        argv: readonly string[] = ["resume", "--model", "test/caller-seat:high", runId],
      ) => {
        const callsBefore = seen.length;
        const result = await resume(argv);
        assert.notEqual(result.exitCode, 0);
        assert.equal(seen.length, callsBefore);
        // #1058: the caller must be handed a pointer to this run's error record —
        // derive the pointed file from stderr, then read that file. Reading a
        // test-known path instead would prove only that the artifact persisted.
        const record = await pointedErrorRecord(runDirectory, result.stderr) as {
          runId?: unknown;
          diagnostic?: unknown;
          details?: unknown;
        };
        assert.equal(record.runId, runId);
        assert.equal(typeof record.diagnostic, "string");
        assert.equal(
          record.details !== null && typeof record.details === "object" && !Array.isArray(record.details),
          true,
        );
        const errorDetails = (record.details as { error?: unknown }).error;
        assert.equal(typeof errorDetails, "string");
        assert.notEqual((errorDetails as string).length, 0);
        return result;
      };

      const corruptRunState = await seed({
        runId: "1058-corrupt-run-state",
        role: "secretariat",
        session: true,
        projectRoot: project,
      });
      seedCurrentSection(corruptRunState.runDirectory, "runState", {});
      await assertRecordedFailure(corruptRunState.runDirectory, "1058-corrupt-run-state");
      assert.deepEqual(readCurrentSection(corruptRunState.runDirectory, "runState"), {});

      const seatSelectionFailure = await seed({
        runId: "1058-seat-selection-failure",
        role: "secretariat",
        session: true,
        projectRoot: project,
      });
      const sessionBeforeSelectionFailure = await readFile(
        seatSelectionFailure.sessionFile,
        "utf8",
      );
      const selectionFailureResult = await assertRecordedFailure(
        seatSelectionFailure.runDirectory,
        "1058-seat-selection-failure",
        ["resume", "--host", "unregistered", "--model", "test/caller-seat:high", "1058-seat-selection-failure"],
      );
      assert.equal(selectionFailureResult.hostFailure?.kind, "host-unregistered");
      assert.equal(
        await readFile(seatSelectionFailure.sessionFile, "utf8"),
        sessionBeforeSelectionFailure,
      );

      const parent = await seed({
        runId: "1058-parent-preload-failure",
        role: "secretariat",
        session: true,
        projectRoot: project,
      });
      const child = await seed({
        runId: "1058-child-success",
        role: "judge",
        session: true,
        projectRoot: project,
        correlationId: "1058-parent-preload-failure",
      });
      const dispatchedParent = await seed({
        runId: "1058-parent-dispatch-failure", role: "secretariat", session: true, projectRoot: project,
      });
      const dispatchedChild = await seed({
        runId: "1058-child-before-parent-dispatch", role: "judge", session: true,
        projectRoot: project, correlationId: "1058-parent-dispatch-failure",
      });
      // The parent leg never had an admitted page: no row, no rendered section.
      clearCurrentSection(parent.runDirectory, "admitted");
      let childDispatches = 0;
      let parentDispatches = 0;
      const acceptedChildHost = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          const sessionDirectory = args[args.indexOf("--session-dir") + 1];
          if (sessionDirectory === dispatchedParent.sessionDirectory) {
            parentDispatches += 1;
            return { code: 1, stderr: "parent-host-failure", timedOut: false, args: [...args] };
          }
          childDispatches += 1;
          assert.equal(
            sessionDirectory === child.sessionDirectory || sessionDirectory === dispatchedChild.sessionDirectory,
            true,
          );
          const details = { status: "converged" };
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(sessionFile, `${JSON.stringify({
            type: "message",
            message: { role: "toolResult", toolName: JUDGE_OUTPUT_TOOL_NAME, isError: false, details },
          })}\n`, "utf8");
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "judge", details },
          };
        },
      });
      const parentChainHostAdapters = [
        { name: "pi", create: () => ({ ok: true as const, host: acceptedChildHost }) },
        { name: "claude", create: () => ({ ok: true as const, host: acceptedChildHost }) },
      ];
      const parentResume = captureIo();
      const parentResult = await runAkRole(
        ["resume", "--model", "test/caller-seat:high", "1058-child-success"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          io: parentResume.io,
          hostAdapters: parentChainHostAdapters,
        },
      );
      assert.equal(childDispatches, 1);
      assert.notEqual(
        parentResult.exitCode,
        0,
        `${parentResume.stderr.join("")} ${JSON.stringify(parentResult)}`,
      );
      assert.equal(readCurrentJson(parent.runDirectory).admitted, undefined);
      const parentDiagnostic = await pointedErrorRecord(
        parent.runDirectory,
        parentResume.stderr.join(""),
      ) as {
        runId?: unknown;
        diagnostic?: unknown;
        details?: unknown;
      };
      assert.equal(parentDiagnostic.runId, "1058-parent-preload-failure");
      assert.equal(typeof parentDiagnostic.diagnostic, "string");
      assert.equal(
        parentDiagnostic.details !== null
          && typeof parentDiagnostic.details === "object"
          && !Array.isArray(parentDiagnostic.details),
        true,
      );

      const dispatchedParentIo = captureIo();
      const dispatchedParentResult = await runAkRole(
        ["resume", "--model", "test/caller-seat:high", "1058-child-before-parent-dispatch"],
        {
          packageRoot, home, cwd: project,
          credentials: { "openai-codex": true, xai: true },
          io: dispatchedParentIo.io,
          hostAdapters: parentChainHostAdapters,
        },
      );
      assert.notEqual(dispatchedParentResult.exitCode, 0);
      assert.ok(parentDispatches > 0);
      assert.equal(childDispatches, 2);
      await readError(
        pointedErrorRecord(dispatchedParent.runDirectory, dispatchedParentIo.stderr.join("")),
        "1058-parent-dispatch-failure",
      );

      const deletedResult = await resume(["resume", "--model", "test/caller-seat:high", "1058-no-workspace"]);
      assert.notEqual(deletedResult.exitCode, 0);
      const relocatedDirectory = join(home, ".ak-roles", "books", bookKey, "1058", "runs", "1058-no-workspace@secretariat");
      const deletedRecord = await readError(
        pointedErrorRecord(relocatedDirectory, deletedResult.stderr),
        "1058-no-workspace",
      );
      assert.equal(typeof deletedRecord.diagnostic, "string");
      assert.equal(deletedRecord.diagnostic, "zeta-unique-host-diagnostic");
      assert.equal((deletedRecord as { details?: { exitCode?: unknown } }).details?.exitCode, 1);

      const callsBeforeSubject = seen.length;
      await resume(["resume", "--model", "test/caller-seat:high", "1058-auditor"]);
      assert.equal(seen.at(-1)?.runDirectory, auditor.runDirectory);
      assert.equal(seen.length, callsBeforeSubject + 1);

      process.env.AK_ROLE_AUDITOR_SUBJECT = "judge";
      await resume(["resume", "--model", "test/caller-seat:high", "1058-auditor"]);
      delete process.env.AK_ROLE_AUDITOR_SUBJECT;
      assert.equal(seen.at(-1)?.runDirectory, auditor.runDirectory);

      const unknown = await resume(["resume", "--model", "test/caller-seat:high", "1058-unknown-host"]);
      assert.notEqual(unknown.exitCode, 0);
      assert.equal(unknown.terminal?.roleOutcome.kind, "failure");
      const unknownRecord = await readError(
        pointedErrorRecord(unknownHost.runDirectory, unknown.stderr),
        "1058-unknown-host",
      );
      assert.equal(
        unknown.terminal?.roleOutcome.kind === "failure"
          && unknown.terminal.roleOutcome.diagnostic === unknownRecord.diagnostic,
        true,
      );
    });
  } finally {
    if (priorSubject === undefined) delete process.env.AK_ROLE_AUDITOR_SUBJECT;
    else process.env.AK_ROLE_AUDITOR_SUBJECT = priorSubject;
  }
});
