/**
 * #636 — 察院/符宝郎/审刑院 ticket+seat memory principal.
 * Public CLI true entry: same ticket reopens the same native officer volume;
 * different tickets isolate; no parallel continuation machine.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import {
  INSPECTOR_OUTPUT_TOOL,
  NOTARY_OUTPUT_TOOL,
  runGatekeeper,
} from "../../src/gatekeeper-role.ts";
import {
  ticketSeatMemorySessionDirectory,
  ticketSeatMemorySubject,
} from "../../src/ticket-seat-memory.ts";
import { createHash } from "node:crypto";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { runPublicNotary } from "../../src/public-cli/notary-run.ts";
import { parseNotaryArgv } from "../../src/public-cli/invocation.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fauxGatekeeper as completion } from "../helpers/faux-gatekeeper.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";
import {
  CANONICAL_SOURCE_ROLE,
  CANONICAL_SOURCE_RUN_ID,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import {
  machineLedgerHome,
  packageRoot,
  seedAgentDirModelsJsonFromFaux,
  seedGitRepository,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";

function seedGitProject(root: string): void {
  seedGitRepository(root);
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
    { cwd: root },
  );
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n)).sort();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function withTicketedParent(input: {
  ticketNumber: number;
  run: (ctx: {
    context: any;
    faux: ReturnType<typeof fauxProvider>;
    home: string;
    project: string;
    runDirectory: string;
  }) => Promise<void>;
}): Promise<void> {
  await withActivationHome({ prefix: "ak-ticket-seat-mem-" }, async ({ agentDir, home }) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const faux = fauxProvider({
      api: "ticket-seat-parent",
      provider: "ticket-seat-parent",
      tokenSize: { min: 1000, max: 1000 },
    });
    faux.setResponses([fauxAssistantMessage("parent")]);
    const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
    try {
      await withInProcessPi(
        {
          cwd: project,
          home,
          agentDir,
          activationLedgerSession: true,
          faux,
          modelsPath: null,
          noExtensions: true,
          noTools: "builtin",
          mode: "print",
          systemPrompt: "BASE",
          flags: {},
        },
        async ({ session, model }) => {
          const runDirectory = join(
            machineLedgerHome(home),
            "books",
            "project",
            "runs",
            `parent-${input.ticketNumber}@fixer`,
          );
          await mkdir(join(runDirectory, "session"), { recursive: true });
          await writeFile(
            join(runDirectory, "admitted-request.json"),
            `${JSON.stringify({
              role: "fixer",
              runId: `parent-${input.ticketNumber}`,
              ticketNumber: input.ticketNumber,
              projectRoot: project,
            }, null, 2)}\n`,
            "utf8",
          );
          await writeInstitutionalSeatTable(runDirectory, {
            gatekeeper: seatSelection("ticket-seat-parent", "ticket-seat-parent"),
            inspector: seatSelection("ticket-seat-parent", "ticket-seat-parent"),
            notary: seatSelection("ticket-seat-parent", "ticket-seat-parent"),
            auditor: seatSelection("ticket-seat-parent", "ticket-seat-parent"),
          });
          await input.run({
            context: {
              cwd: project,
              model,
              modelRegistry: {
                getProvider() {
                  return undefined;
                },
                find() {
                  return model;
                },
                async getProviderAuth() {
                  return { auth: {} };
                },
                async getApiKeyAndHeaders() {
                  return { ok: true };
                },
              },
              thinkingLevel: "off",
              sessionManager: session.sessionManager,
              runDirectory,
            },
            faux,
            home,
            project,
            runDirectory,
          });
        },
      );
    } finally {
      await seeded.close();
    }
  });
}

test("#636 same ticket second inspector summons reopens the same native volume", async () => {
  await withTicketedParent({
    ticketNumber: 636,
    run: async ({ context, faux, home, project, runDirectory }) => {
      const memoryDir = ticketSeatMemorySessionDirectory({
        ticketNumber: 636,
        seat: "inspector",
        cwd: project,
        home,
      });
      const expectedDigest = createHash("sha256")
        .update(ticketSeatMemorySubject(636, "inspector"))
        .digest("hex")
        .slice(0, 32);
      assert.ok(
        memoryDir.endsWith(join("auditor-roles", expectedDigest)),
        "memory nest is ticket+seat digest under auditor-roles",
      );

      const respondPass = () =>
        completion([{ tool: INSPECTOR_OUTPUT_TOOL, args: { status: "pass", findings: [] } }], []);

      faux.setResponses([respondPass()]);
      const first = await runGatekeeper({
        context,
        runDirectory,
        subject: { kind: "worker_completion" },
      });
      assert.deepEqual(first, { status: "pass", officer: "inspector", findings: [] });

      const afterFirst = await listJsonlFiles(memoryDir);
      assert.equal(afterFirst.length, 1, "first summons materializes one native volume");
      const firstFile = afterFirst[0]!;

      // Second summons on the same ticketed parent run (same ticket+seat principal).
      faux.setResponses([respondPass()]);
      const second = await runGatekeeper({
        context,
        runDirectory,
        subject: { kind: "worker_completion" },
      });
      assert.deepEqual(second, { status: "pass", officer: "inspector", findings: [] });

      const afterSecond = await listJsonlFiles(memoryDir);
      assert.equal(afterSecond.length, 1, "second summons must not mint a second native volume");
      assert.equal(afterSecond[0], firstFile, "same ticket reopens the exact same session file");

      // Parent nest must not receive a parallel fresh auditor-roles volume for ticketed memory.
      const parentNest = join(
        context.sessionManager.getSessionFile()
          ? join(
              context.sessionManager.getSessionFile()!.replace(/[/\\][^/\\]+$/, ""),
              "auditor-roles",
            )
          : join(runDirectory, "session", "auditor-roles"),
      );
      // When parent session lives under activation ledger, nest path is dirname(sessionFile)/auditor-roles.
      const parentSessionFile = context.sessionManager.getSessionFile() as string | undefined;
      if (parentSessionFile !== undefined) {
        const legacyNest = join(
          parentSessionFile.slice(0, parentSessionFile.lastIndexOf("/")),
          "auditor-roles",
        );
        const legacyFiles = await listJsonlFiles(legacyNest);
        assert.equal(
          legacyFiles.length,
          0,
          "ticketed officer memory must not also mint a fresh parent-nested volume",
        );
      }

      // Volume retained both parent-attempt bindings (two summons).
      const body = await readFile(firstFile, "utf8");
      const bindings = body
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { customType?: string })
        .filter((row) => row.customType === "ak_auditor_parent_attempt_binding");
      assert.ok(bindings.length >= 2, "resumed volume carries both summons bindings");
    },
  });
});

test("#636 different tickets do not share officer memory volumes", async () => {
  await withActivationHome({ prefix: "ak-ticket-seat-iso-" }, async ({ agentDir, home }) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const faux = fauxProvider({
      api: "ticket-seat-iso",
      provider: "ticket-seat-iso",
      tokenSize: { min: 1000, max: 1000 },
    });
    faux.setResponses([fauxAssistantMessage("parent")]);
    const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
    try {
      await withInProcessPi(
        {
          cwd: project,
          home,
          agentDir,
          activationLedgerSession: true,
          faux,
          modelsPath: null,
          noExtensions: true,
          noTools: "builtin",
          mode: "print",
          systemPrompt: "BASE",
          flags: {},
        },
        async ({ session, model }) => {
          async function summonOnTicket(ticketNumber: number): Promise<string> {
            const runDirectory = join(
              machineLedgerHome(home),
              "books",
              "project",
              "runs",
              `iso-${ticketNumber}@fixer`,
            );
            await mkdir(join(runDirectory, "session"), { recursive: true });
            await writeFile(
              join(runDirectory, "admitted-request.json"),
              `${JSON.stringify({
                role: "fixer",
                runId: `iso-${ticketNumber}`,
                ticketNumber,
                projectRoot: project,
              }, null, 2)}\n`,
              "utf8",
            );
            await writeInstitutionalSeatTable(runDirectory, {
              inspector: seatSelection("ticket-seat-iso", "ticket-seat-iso"),
            });
            const context = {
              cwd: project,
              model,
              modelRegistry: {
                getProvider() {
                  return undefined;
                },
                find() {
                  return model;
                },
                async getProviderAuth() {
                  return { auth: {} };
                },
                async getApiKeyAndHeaders() {
                  return { ok: true };
                },
              },
              thinkingLevel: "off",
              sessionManager: session.sessionManager,
              runDirectory,
            };
            faux.setResponses([
              completion(
                [{ tool: INSPECTOR_OUTPUT_TOOL, args: { status: "pass", findings: [] } }],
                [],
              ),
            ]);
            const result = await runGatekeeper({
              context: context as never,
              runDirectory,
              subject: { kind: "worker_completion" },
            });
            assert.equal(result.status, "pass");
            const memoryDir = ticketSeatMemorySessionDirectory({
              ticketNumber,
              seat: "inspector",
              cwd: project,
              home,
            });
            const files = await listJsonlFiles(memoryDir);
            assert.equal(files.length, 1);
            return files[0]!;
          }

          const fileA = await summonOnTicket(100);
          const fileB = await summonOnTicket(200);
          assert.notEqual(fileA, fileB, "distinct tickets must not share the native volume");
        },
      );
    } finally {
      await seeded.close();
    }
  });
});

test("#636 notary ticket memory resumes same volume across summons", async () => {
  await withTicketedParent({
    ticketNumber: 636,
    run: async ({ context, faux, home, project, runDirectory }) => {
      const memoryDir = ticketSeatMemorySessionDirectory({
        ticketNumber: 636,
        seat: "notary",
        cwd: project,
        home,
      });
      const respond = () =>
        completion([{ tool: NOTARY_OUTPUT_TOOL, args: { status: "pass", findings: [] } }], []);
      faux.setResponses([respond()]);
      assert.equal(
        (await runGatekeeper({
          context,
          runDirectory,
          subject: { kind: "judge_draft" },
        })).status,
        "pass",
      );
      const first = (await listJsonlFiles(memoryDir))[0];
      assert.ok(first);
      faux.setResponses([respond()]);
      assert.equal(
        (await runGatekeeper({
          context,
          runDirectory,
          subject: { kind: "countersign_verdict" },
        })).status,
        "pass",
      );
      const second = await listJsonlFiles(memoryDir);
      assert.deepEqual(second, [first]);
    },
  });
});

function scriptedNotaryPassRunner(onSession?: (sessionFile: string) => void) {
  const base = scriptedTerminatingToolSession({
    role: "notary",
    toolName: NOTARY_OUTPUT_TOOL_NAME,
    details: { status: "pass", findings: [] },
  });
  return async (args: readonly string[], options: unknown) => {
    const sessionFile = argvFlagValue(args, "--session");
    assert.ok(sessionFile);
    onSession?.(sessionFile);
    // Preserve an existing ticket-seat header so the next summons can resume the
    // same principal (scriptedTerminatingToolSession alone overwrites the file).
    let priorHeader = "";
    try {
      const prior = await readFile(sessionFile, "utf8");
      const firstLine = prior.split("\n").find((line) => line.trim() !== "");
      if (firstLine !== undefined) {
        const parsed = JSON.parse(firstLine) as { type?: string };
        if (parsed.type === "session") priorHeader = `${firstLine}\n`;
      }
    } catch {
      // First summons — no prior bytes yet.
    }
    const result = await base(args, options as never);
    if (priorHeader !== "") {
      const written = await readFile(sessionFile, "utf8");
      await writeFile(sessionFile, `${priorHeader}${written}`, "utf8");
    }
    return result;
  };
}

test("#636 public notary CLI reuses ticket+seat memory principal across runs", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-public-notary-mem-"));
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    // Ticket rides the source-run admitted form (#635 inheritance).
    const admittedPath = join(sourceRunPath, "admitted-request.json");
    const admittedRaw = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      admittedPath,
      `${JSON.stringify({ ...admittedRaw, ticketNumber: 636 }, null, 2)}\n`,
      "utf8",
    );

    const memoryDir = ticketSeatMemorySessionDirectory({
      ticketNumber: 636,
      seat: "notary",
      cwd: project,
      home,
    });

    const seenSessionFiles: string[] = [];
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedNotaryPassRunner((sessionFile) => {
        seenSessionFiles.push(sessionFile);
        assert.ok(
          sessionFile.startsWith(memoryDir),
          `public notary session must open ticket-seat memory nest, got ${sessionFile}`,
        );
      }),
    });

    const capture = () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      return {
        io: {
          stdout: (t: string) => {
            stdout.push(t);
          },
          stderr: (t: string) => {
            stderr.push(t);
          },
        },
      };
    };

    const envBase = {
      packageRoot,
      home,
      agentDir: join(home, "agent"),
      cwd: project,
      principalAuthority: piDurablePrincipalAuthority,
      roleTurnHost: host,
      sessionAppender: appendPiSessionCustomEntry,
      host: "pi" as const,
    };

    const first = await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, createRunId: () => "notary-mem-1" },
      capture().io,
      parseNotaryArgv,
    );
    assert.equal(first.exitCode, 0, "first notary must settle");
    assert.ok(first.admitted);

    const second = await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, createRunId: () => "notary-mem-2" },
      capture().io,
      parseNotaryArgv,
    );
    assert.equal(second.exitCode, 0, "second notary must settle");
    assert.ok(second.admitted);
    assert.notEqual(first.admitted!.runId, second.admitted!.runId, "runs stay independent");

    assert.equal(seenSessionFiles.length, 2);
    assert.equal(
      seenSessionFiles[0],
      seenSessionFiles[1],
      "same ticket must reopen the same native session file",
    );

    const firstPrincipalFile = piDurablePrincipalAuthority.decode(
      first.admitted!.principal,
    ).sessionFile;
    const secondPrincipalFile = piDurablePrincipalAuthority.decode(
      second.admitted!.principal,
    ).sessionFile;
    assert.equal(firstPrincipalFile, seenSessionFiles[0]);
    assert.equal(secondPrincipalFile, seenSessionFiles[0]);
    assert.notEqual(
      first.admitted!.runDirectory,
      second.admitted!.runDirectory,
      "each call keeps its own run directory",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("#636 cross-host notary memory feeds prior native paths (DK-4)", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-notary-xhost-"));
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const admittedPath = join(sourceRunPath, "admitted-request.json");
    const admittedRaw = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      admittedPath,
      `${JSON.stringify({ ...admittedRaw, ticketNumber: 636 }, null, 2)}\n`,
      "utf8",
    );

    const memoryDir = ticketSeatMemorySessionDirectory({
      ticketNumber: 636,
      seat: "notary",
      cwd: project,
      home,
    });

    let firstSessionFile = "";
    const piHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedNotaryPassRunner((sessionFile) => {
        firstSessionFile = sessionFile;
      }),
    });

    const io = {
      stdout: (_t: string) => {},
      stderr: (_t: string) => {},
    };
    const first = await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        packageRoot,
        home,
        agentDir: join(home, "agent"),
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: piHost,
        sessionAppender: appendPiSessionCustomEntry,
        host: "pi",
        createRunId: () => "notary-xhost-pi",
      },
      io,
      parseNotaryArgv,
    );
    assert.equal(first.exitCode, 0);
    assert.ok(firstSessionFile.startsWith(memoryDir));

    let observedPrior: readonly string[] | undefined;
    let observedPreviousHost: string | undefined;
    let observedSessionFile = "";
    const grokHost = {
      async executeTurn(request: RoleTurnRequest) {
        observedPrior = request.hostTransition?.priorNativePaths;
        observedPreviousHost = request.hostTransition?.previousHost;
        observedSessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
        // DK-4 handoff is observable at executeTurn; no need to drive full settlement.
        return { code: 0, stderr: "", timedOut: false };
      },
    };

    await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        packageRoot,
        home,
        agentDir: join(home, "agent"),
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: grokHost,
        sessionAppender: appendPiSessionCustomEntry,
        host: "grok-build",
        createRunId: () => "notary-xhost-grok",
      },
      io,
      parseNotaryArgv,
    );
    assert.equal(observedSessionFile, firstSessionFile, "cross-host keeps memory principal");
    assert.equal(observedPreviousHost, "pi");
    assert.ok(observedPrior !== undefined, "cross-host must project prior native paths");
    assert.ok(
      observedPrior!.includes(firstSessionFile),
      "prior pi session file must be handed as context path (DK-7)",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
