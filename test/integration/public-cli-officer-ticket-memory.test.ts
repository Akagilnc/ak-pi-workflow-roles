/**
 * #636 — 察院/符宝郎/审刑院 ticket+seat memory principal.
 * Public / institutional true entry: same ticket reopens the same nest; different
 * tickets isolate; public CLI second call sends continuation.resume on the sealed
 * principal. Native host reopen + cross-host DK-4 true runs are #638 family
 * evidence — this suite does not treat mock handoff as DK-4 completion.
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

test("#636 public notary CLI: second same-ticket call seals nest and sends continuation.resume", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-public-notary-mem-"));
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

    // Observing typed continuation + principal path only — not a DK-4 mock-handoff proof.
    const seen: Array<{
      sessionFile: string;
      kind: RoleTurnRequest["continuation"]["kind"];
      runDirectory: string;
    }> = [];
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        const sessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
        seen.push({
          sessionFile,
          kind: request.continuation.kind,
          runDirectory: request.runDirectory,
        });
        // No scripted session rewrite: contract under test is the turn request wire.
        return { code: 0, stderr: "", timedOut: false };
      },
    };

    const io = {
      stdout: (_t: string) => {},
      stderr: (_t: string) => {},
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

    await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, createRunId: () => "notary-mem-1" },
      io,
      parseNotaryArgv,
    );
    assert.equal(seen.length, 1, "first public notary must dispatch one turn");
    assert.equal(seen[0]!.kind, "initial", "first nest open is initial");
    assert.ok(
      seen[0]!.sessionFile.startsWith(memoryDir),
      `first principal must seal ticket-seat nest, got ${seen[0]!.sessionFile}`,
    );

    await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, createRunId: () => "notary-mem-2" },
      io,
      parseNotaryArgv,
    );
    assert.equal(seen.length, 2, "second public notary must dispatch one turn");
    assert.equal(seen[1]!.kind, "resume", "existing nest must send continuation.resume");
    assert.equal(
      seen[1]!.sessionFile,
      seen[0]!.sessionFile,
      "same ticket must reopen the same native session file path",
    );
    assert.notEqual(
      seen[1]!.runDirectory,
      seen[0]!.runDirectory,
      "each call keeps its own run directory",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
