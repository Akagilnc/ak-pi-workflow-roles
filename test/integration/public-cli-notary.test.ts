/**
 * #448 public Notary seat — source-run locator only; four external terminal layers
 * via real runAkRole entry; default judge path adds no intake notary call.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import {
  NotarySourceRunError,
  resolveNotarySourceRunLocator,
} from "../../src/notary-source-run.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitNotaryInvocation,
  buildNotaryTransportPrompt,
  parseNotaryArgv,
} from "../../src/public-cli/invocation.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { isLawfulTypedTerminalOutcome } from "../../src/public-cli/terminal.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import {
  argvFlagValue,
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  CANONICAL_SOURCE_RUN_ID,
  CANONICAL_SOURCE_ROLE,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-notary-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "notary@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Notary Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

/** Project-tree fake projection — must be rejected by public locator. */
async function seedProjectProjection(project: string): Promise<string> {
  const sourceDir = join(
    project,
    ".source-runs",
    `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
  );
  await mkdir(join(sourceDir, "session"), { recursive: true });
  await writeFile(
    join(sourceDir, "session", "session.jsonl"),
    `${JSON.stringify({ type: "message", message: { role: "user", content: "draft" } })}\n`,
    "utf8",
  );
  return await realpath(sourceDir);
}

function scriptedNotarySession(
  details: unknown,
  options: { isError?: boolean; seal?: boolean } = {},
) {
  const isError = options.isError === true;
  const lawful =
    !isError &&
    typeof details === "object" &&
    details !== null &&
    "status" in details &&
    ((details as { status?: unknown }).status === "pass" ||
      (details as { status?: unknown }).status === "bounce");
  return scriptedTerminatingToolSession({
    role: "notary",
    toolName: NOTARY_OUTPUT_TOOL_NAME,
    details,
    isError,
    seal: options.seal ?? lawful,
  });
}

const flagValue = argvFlagValue;

test("#620 notary public entry injects gatekeeper inheritance into RoleTurnRequest.model", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const credentials = { "openai-codex": true, xai: true } as const;

    assert.equal(
      (
        await runAkRole(
          ["config", "set", "gatekeeper", "openai-codex/gpt-5.6-sol:low"],
          { home, packageRoot, io: captureIo().io },
        )
      ).exitCode,
      0,
    );

    const captured: { current: RoleTurnRequest | undefined } = { current: undefined };
    await runAkRole(["notary", "--source-run", sourceRunPath], {
      home,
      packageRoot,
      cwd: project,
      credentials,
      createRunId: () => "01a0notary-0000-7000-8000-000000000620",
      io: captureIo().io,
      roleTurnHost: createMinimalHost((request) => {
        captured.current = request;
        return Promise.resolve({ code: 1, stderr: "stop", timedOut: false });
      }),
    });
    const inherited = captured.current!;
    assert.equal(inherited.activation.role, "notary");
    assert.deepEqual(inherited.model, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "low",
    });
  });
});

test("notary argv rejects caller prompt and attachment projection", async () => {
  assert.throws(
    () => parseNotaryArgv(["--source-run", "x@judge", "please bounce lightly"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  assert.throws(
    () => parseNotaryArgv(["--attach", "./note.md", "--source-run", "x@judge"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  assert.throws(
    () => parseNotaryArgv([]),
    (error: unknown) => error instanceof CliUsageError,
  );

  // Public CLI structural exit for the same input contract.
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const { io } = captureIo();
    const withPrompt = await runAkRole(
      ["notary", "--source-run", sourceRunPath, "caller framing must not admit"],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(withPrompt.exitCode, 2);
    assert.equal(withPrompt.terminal, undefined);

    const withAttach = await runAkRole(
      ["notary", "--attach", "./note.md", "--source-run", sourceRunPath],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(withAttach.exitCode, 2);
    assert.equal(withAttach.terminal, undefined);
  });
});

test("notary bad source-run locator is structural reject (exit 2)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();

    const missing = await runAkRole(
      ["notary", "--source-run", join(project, "no-such-run@judge")],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(missing.exitCode, 2);
    assert.equal(missing.terminal, undefined);

    const filePath = join(project, "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge");
    await writeFile(filePath, "not a directory\n", "utf8");
    const notDir = await runAkRole(
      ["notary", "--source-run", filePath],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(notDir.exitCode, 2);
    assert.equal(notDir.terminal, undefined);

    const badNameDir = join(project, "not-a-run-id");
    await mkdir(badNameDir, { recursive: true });
    const badName = await runAkRole(
      ["notary", "--source-run", badNameDir],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(badName.exitCode, 2);
    assert.equal(badName.terminal, undefined);

    // Project-tree projection is not an authoritative source run.
    const projection = await seedProjectProjection(project);
    const projected = await runAkRole(
      ["notary", "--source-run", projection],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(projected.exitCode, 2);
    assert.equal(projected.terminal, undefined);

    // Unit seam: same failures surface as NotarySourceRunError before CLI wrap.
    await assert.rejects(
      () =>
        resolveNotarySourceRunLocator({
          projectRoot: project,
          sourceRun: join(project, "missing@judge"),
          home,
        }),
      (error: unknown) => error instanceof NotarySourceRunError,
    );
    await assert.rejects(
      () =>
        resolveNotarySourceRunLocator({
          projectRoot: project,
          sourceRun: projection,
          home,
        }),
      (error: unknown) =>
        error instanceof NotarySourceRunError &&
        error.message.includes("machine-ledger book"),
    );
  });
});

test("notary rejects canonical ledger run with illegal retained role record (exit 2)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Hand-forged retained record under canonical runs/ — directory name parses,
    // four-string shape looks complete, but shared typed reader rejects invented role.
    const inventedRole = "inventedrole";
    const runId = CANONICAL_SOURCE_RUN_ID;
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      activationBookDirectory(resolveActivationLedgerHome(home), bookKey),
      "runs",
      `${runId}@${inventedRole}`,
    );
    const sessionDirectory = join(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    const sessionFile = join(sessionDirectory, "session.jsonl");
    const admittedRequestPath = join(runDirectory, "admitted-request.json");
    await writeFile(sessionFile, "\n", "utf8");
    await writeFile(
      admittedRequestPath,
      `${JSON.stringify({ role: inventedRole, runId })}\n`,
      "utf8",
    );
    await writeFile(
      join(runDirectory, "run-state.json"),
      `${JSON.stringify(
        {
          runId,
          role: inventedRole,
          state: "terminal",
          bookKey,
          projectRoot: project,
          sessionDirectory,
          sessionFile,
          runDirectory,
          admittedRequestPath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    assert.equal(await readRoleRunState(runDirectory, piDurablePrincipalAuthority), undefined);

    const { io } = captureIo();
    const bare = `${runId}@${inventedRole}`;
    const rejectedBare = await runAkRole(["notary", "--source-run", bare], {
      home,
      packageRoot,
      cwd: project,
      io,
    });
    assert.equal(rejectedBare.exitCode, 2);
    assert.equal(rejectedBare.terminal, undefined);

    const rejectedPath = await runAkRole(
      ["notary", "--source-run", runDirectory],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(rejectedPath.exitCode, 2);
    assert.equal(rejectedPath.terminal, undefined);

    await assert.rejects(
      () =>
        resolveNotarySourceRunLocator({
          projectRoot: project,
          sourceRun: bare,
          home,
        }),
      (error: unknown) =>
        error instanceof NotarySourceRunError &&
        error.message.includes("retained run-state identity"),
    );
  });
});

test("notary admits canonical ledger source-run and bare runId@role; rejects project projection", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const projection = await seedProjectProjection(project);

    const byPath = await resolveNotarySourceRunLocator({
      projectRoot: project,
      sourceRun: sourceRunPath,
      home,
    });
    assert.equal(byPath.runDirectory, sourceRunPath);
    assert.equal(byPath.runId, CANONICAL_SOURCE_RUN_ID);
    assert.equal(byPath.role, CANONICAL_SOURCE_ROLE);

    const bare = `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`;
    const byBare = await resolveNotarySourceRunLocator({
      projectRoot: project,
      sourceRun: bare,
      home,
    });
    assert.equal(byBare.runDirectory, sourceRunPath);

    // Real public entry: bare locator admits; project projection is exit 2.
    const { io } = captureIo();
    const admittedBare = await runAkRole(
      ["notary", "--source-run", bare],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => "01a0notary-0000-7000-8000-0000000000aa",
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: scriptedNotarySession({ status: "pass", findings: [] }),
          }),
      },
    );
    assert.equal(admittedBare.exitCode, 0);
    assert.ok(admittedBare.terminal);
    assert.equal(admittedBare.terminal.roleOutcome.kind, "accepted");

    const rejectedProjection = await runAkRole(
      ["notary", "--source-run", projection],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(rejectedProjection.exitCode, 2);
    assert.equal(rejectedProjection.terminal, undefined);
  });
});

test("layer ① accepted pass/bounce exit 0 via public entry", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);

    const receipts = [
      { status: "pass", findings: [] as string[] },
      {
        status: "bounce",
        findings: ["quote has no source"],
        disposition: "rewrite",
      },
    ] as const;

    for (const [index, receipt] of receipts.entries()) {
      const { io } = captureIo();
      const result = await runAkRole(
        ["notary", "--source-run", sourceRunPath],
        {
          home,
          packageRoot,
          cwd: project,
          io,
          createRunId: () =>
            `01a0notary-0000-7000-8000-${String(index).padStart(12, "0")}`,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: scriptedNotarySession(receipt),
          }),
        },
      );
      assert.equal(result.exitCode, 0, `receipt ${receipt.status}`);
      assert.ok(result.terminal, `receipt ${receipt.status}`);
      assert.equal(result.terminal.roleOutcome.kind, "accepted");
      assert.equal(result.terminal.roleOutcome.role, "notary");
      assert.equal(
        result.terminal.roleOutcome.status,
        receipt.status,
        `receipt ${receipt.status}`,
      );
      assert.equal(isLawfulTypedTerminalOutcome(result.terminal.roleOutcome), true);
    }
  });
});

test("layer ② no usable Notary release keeps candidate on failure channel and exits non-zero", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const bad = { status: "maybe", note: "not an explicit release" };
    const { io } = captureIo();

    // ADR 0055: role accepts once (isError false); public-terminal projects cause:output + candidate.
    const result = await runAkRole(
      ["notary", "--source-run", sourceRunPath],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => "01a0notary-0000-7000-8000-000000000002",
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: scriptedNotarySession(bad),
          }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "failure");
    if (result.terminal.roleOutcome.kind === "failure") {
      assert.equal(result.terminal.roleOutcome.role, "notary");
      assert.equal(result.terminal.roleOutcome.cause, "output");
      assert.deepEqual(result.terminal.roleOutcome.decisiveFacts.secondaryEvidence, {
        candidate: bad,
        acceptedReceipt: false,
      });
      assert.ok(
        result.terminal.artifacts.some((artifact) => artifact.kind === "error"),
        "failure channel must publish error artifact",
      );
    }
    assert.equal(isLawfulTypedTerminalOutcome(result.terminal.roleOutcome), false);
  });
});

test("layer ③ no_receipt from shared lifecycle is lawful exit 0", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const { io } = captureIo();

    const result = await runAkRole(
      ["notary", "--source-run", sourceRunPath],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => "01a0notary-0000-7000-8000-000000000003",
        notaryTimeoutMs: 5_000,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (extraArgs, options) => {
          const sessionFile = flagValue(extraArgs, "--session");
          assert.ok(sessionFile);
          await mkdir(join(sessionFile, ".."), { recursive: true });
          const runDir = options.env.AK_ROLE_RUN_DIR;
          assert.ok(typeof runDir === "string");
          const noReceipt = {
            type: "custom",
            customType: "ak-no-receipt-lifecycle",
            data: {
              terminalToolCalled: false,
              rejectedReceipts: [],
              deliveryTurns: 2,
              sessionCompletion: "settled-without-accepted-receipt",
              acceptedReceipt: false,
              runPointer: runDir,
              attemptPointer: `current:${runDir}`,
            },
            timestamp: "2026-08-25T00:00:03.000Z",
          };
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              id: "u",
              message: { role: "user", content: "k", timestamp: 1 },
              timestamp: "2026-08-25T00:00:00.000Z",
            })}\n${JSON.stringify(noReceipt)}\n`,
            "utf8",
          );
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...extraArgs],
          };
        },
          }),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "no_receipt");
    if (result.terminal.roleOutcome.kind === "no_receipt") {
      assert.equal(result.terminal.roleOutcome.role, "notary");
      assert.equal(result.terminal.roleOutcome.acceptedReceipt, false);
      assert.equal(
        result.terminal.roleOutcome.sessionCompletion,
        "settled-without-accepted-receipt",
      );
    }
    assert.equal(isLawfulTypedTerminalOutcome(result.terminal.roleOutcome), true);
  });
});

test("layer ④ transport/provider failure is controlled non-zero failure", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const { io } = captureIo();
    const result = await runAkRole(
      ["notary", "--source-run", sourceRunPath],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => "01a0notary-0000-7000-8000-000000000004",
        notaryTimeoutMs: 5_000,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          void args;
          throw new Error("provider disconnected");
        },
          }),
      },
    );
    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "failure");
    if (result.terminal.roleOutcome.kind === "failure") {
      assert.equal(result.terminal.roleOutcome.role, "notary");
    }
  });
});

test("default judge public path admits no notary seat intake (observable run)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    let dispatchedArgs: readonly string[] | undefined;
    const judgeRunId = "01a0judge0-0000-7000-8000-000000000099";

    await runAkRole(
      ["judge", "--project", project, "ticket court intake probe"],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => judgeRunId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
          dispatchedArgs = args;
          const sessionFile = flagValue(args, "--session");
          assert.ok(sessionFile);
          await mkdir(join(sessionFile, ".."), { recursive: true });
          await writeFile(sessionFile, "", "utf8");
          void options;
          return {
            code: 1,
            timedOut: false,
            stderr: "stop after intake",
            args: [...args],
          };
        },
          }),
      },
    );

    assert.ok(dispatchedArgs, "judge public path must dispatch once");
    assert.equal(flagValue(dispatchedArgs, "--ak-role"), "judge");
    assert.equal(dispatchedArgs.includes("--ak-notary-source-run"), false);

    const books = join(home, ".ak-roles", "books");
    const notaryRuns: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.endsWith("@notary")) notaryRuns.push(path);
          await walk(path);
        }
      }
    }
    await walk(books);
    assert.deepEqual(notaryRuns, []);
  });
});
