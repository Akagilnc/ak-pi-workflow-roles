/**
 * #582 / ADR 0075 — countersign/notary --ticket face + diarist beforeDispatch station.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  packageRoot,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  admitCountersignInvocation,
  parseCountersignArgv,
  parseNotaryArgv,
  parsePositiveTicketNumber,
} from "../../src/public-cli/invocation.ts";
import {
  runCountersignDiaristStation,
  runPublicCountersign,
} from "../../src/public-cli/countersign-run.ts";
import { createScriptedDiaristCollector } from "../../src/diarist-llm-collector.ts";
import { readTicketProvenance } from "../../src/ticket-provenance.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";

test("parsePositiveTicketNumber rejects non-positive and leading junk", () => {
  assert.equal(parsePositiveTicketNumber("582", "--ticket"), 582);
  assert.throws(() => parsePositiveTicketNumber("0", "--ticket"), CliUsageError);
  assert.throws(() => parsePositiveTicketNumber("08", "--ticket"), CliUsageError);
  assert.throws(() => parsePositiveTicketNumber("x", "--ticket"), CliUsageError);
});

test("parseCountersignArgv binds --ticket; judge path has no ticket option", () => {
  const parsed = parseCountersignArgv([
    "--ticket",
    "582",
    "--attach",
    "./t.md",
    "裁：开工？",
  ]);
  assert.equal(parsed.ticket, 582);
  assert.deepEqual(parsed.attachmentPaths, ["./t.md"]);
  assert.equal(parsed.instruction, "裁：开工？");
  assert.throws(
    () => parseCountersignArgv(["--ticket", "nope"]),
    CliUsageError,
  );
});

test("parseNotaryArgv binds optional --ticket alongside required --source-run", () => {
  const parsed = parseNotaryArgv([
    "--source-run",
    "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
    "--ticket",
    "582",
  ]);
  assert.equal(parsed.sourceRun, "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge");
  assert.equal(parsed.ticket, 582);
});

test("countersign admission: explicit --ticket wins over frontmatter", async () => {
  await withHermeticHome({ prefix: "ak-cs-ticket-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    const attach = join(project, "ticket.md");
    await writeFile(
      attach,
      "---\nticketNumber: 100\n---\n\nbody with 「立文件。送司天台记录。」\n",
      "utf8",
    );

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [attach],
      ticket: 582,
      createRunId: () => "01a00000-0000-7000-8000-000000000582",
    });
    assert.equal(admitted.ticketNumber, 582);
    assert.equal(admitted.role, "countersign");
  });
});

test("runCountersignDiaristStation refreshes provenance before turn when ticket bound", async () => {
  await withHermeticHome({ prefix: "ak-cs-diarist-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
      { cwd: project },
    );

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [],
      ticket: 582,
      createRunId: () => "01a00000-0000-7000-8000-000000000583",
    });
    assert.equal(admitted.ticketNumber, 582);

    const projectsRoot = join(home, "cc-projects");
    const sessionDir = join(projectsRoot, encodePath(project));
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "s.jsonl"),
      `${JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-08-31T00:00:00.000Z",
        message: {
          role: "user",
          content: "立文件。送司天台记录。所以每个票都应该有的一份文档。#582 起居录",
        },
      })}\n`,
      "utf8",
    );

    let observedStatus: string | undefined;
    const result = await runCountersignDiaristStation(admitted, {
      cwd: project,
      projectsRoot,
      packageRoot,
      // Soft face inject — production uses shared gh seam; attachments are not the face.
      diaristIssueFaceFetcher: async () => ({
        body: "「立文件。送司天台记录。」",
        bodyUrl: "https://github.com/o/r/issues/582",
        comments: [],
      }),
      diaristCollector: createScriptedDiaristCollector((input) => ({
        selections:
          input.candidates.length > 0
            ? [
                {
                  candidateIndex: 0,
                  quotes: ["立文件。送司天台记录。"],
                  triage: "relevant" as const,
                },
              ]
            : [],
        rawStdout: "{}",
        engineArgv: ["scripted"],
      })),
      onDiaristResult: (r) => {
        observedStatus = r.collectorStatus;
      },
    });
    assert.ok(result);
    assert.equal(observedStatus, "ok");
    assert.equal(result!.appended, 1);
    const read = await readTicketProvenance(582, project);
    assert.equal(read.entries.length, 1);
  });
});

function encodePath(cwd: string): string {
  const abs = cwd.startsWith("/") ? cwd : `/${cwd}`;
  return abs.replace(/\//g, "-");
}

test("runPublicCountersign: diarist station fills ticket volume before role turn", async () => {
  await withHermeticHome({ prefix: "ak-cs-real-entry-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
      { cwd: project },
    );

    const ticketPath = join(project, "ticket.md");
    await writeFile(
      ticketPath,
      "---\nticketNumber: 582\n---\n\n「立文件。送司天台记录。」\n",
      "utf8",
    );

    const projectsRoot = join(home, "cc-projects");
    const sessionDir = join(projectsRoot, encodePath(project));
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "s.jsonl"),
      `${JSON.stringify({
        type: "user",
        uuid: "u-real",
        timestamp: "2026-08-31T10:00:00.000Z",
        message: {
          role: "user",
          content: "立文件。送司天台记录。所以每个票都应该有的一份文档。#582 起居录",
        },
      })}\n`,
      "utf8",
    );

    let diaristObserved = false;
    let volumeAtTurn: number | undefined;
    let turnStarted = false;

    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (extraArgs) => {
        const sessionFile = (() => {
          const i = extraArgs.indexOf("--session");
          return i >= 0 ? extraArgs[i + 1] : undefined;
        })();
        if (sessionFile) {
          await mkdir(join(sessionFile, ".."), { recursive: true });
          const toolCallId = "call_cs_diarist_1";
          const toolArgs = { countersignStatus: "converged", note: "署" };
          await writeFile(
            sessionFile,
            [
              {
                type: "message",
                id: "user-1",
                parentId: null,
                timestamp: "2026-08-31T00:00:00.000Z",
                message: { role: "user", content: "kickoff", timestamp: 1 },
              },
              {
                type: "message",
                id: "assistant-1",
                parentId: "user-1",
                timestamp: "2026-08-31T00:00:01.000Z",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: toolCallId,
                      name: COUNTERSIGN_OUTPUT_TOOL_NAME,
                      arguments: toolArgs,
                    },
                  ],
                  timestamp: 2,
                },
              },
              {
                type: "message",
                id: "result-1",
                parentId: "assistant-1",
                timestamp: "2026-08-31T00:00:02.000Z",
                message: {
                  role: "toolResult",
                  toolCallId,
                  toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
                  content: [{ type: "text", text: "ok" }],
                  details: toolArgs,
                  isError: false,
                  timestamp: 3,
                },
              },
            ]
              .map((row) => JSON.stringify(row))
              .join("\n") + "\n",
            "utf8",
          );
        }
        return {
          code: 0,
          timedOut: false,
          stderr: "",
          sealedAcceptance: {
            role: "countersign" as const,
            details: { countersignStatus: "converged", note: "署" },
          },
        };
      },
    });

    const observingHost = {
      async executeTurn(request: RoleTurnRequest) {
        turnStarted = true;
        // beforeDispatch must have already refreshed the ticket volume.
        const read = await readTicketProvenance(582, project);
        volumeAtTurn = read.entries.length;
        assert.ok(
          diaristObserved,
          "onDiaristResult must fire before executeTurn",
        );
        assert.ok(
          (volumeAtTurn ?? 0) >= 1,
          "ticket-provenance volume must be visible before role turn",
        );
        return baseHost.executeTurn(request);
      },
    };

    const io = {
      stdout: () => {},
      stderr: () => {},
    };

    const result = await runPublicCountersign(
      ["--ticket", "582", "--attach", ticketPath, "裁：本票是否足以开工。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: observingHost,
        createRunId: () => "01a00000-0000-7000-8000-000000000584",
        projectsRoot,
        diaristIssueFaceFetcher: async () => ({
          body: "「立文件。送司天台记录。」",
          bodyUrl: "https://github.com/o/r/issues/582",
          comments: [],
        }),
        diaristCollector: createScriptedDiaristCollector((input) => ({
          selections:
            input.candidates.length > 0
              ? [
                  {
                    candidateIndex: 0,
                    quotes: ["立文件。送司天台记录。"],
                    triage: "relevant" as const,
                  },
                ]
              : [],
          rawStdout: "{}",
          engineArgv: ["scripted"],
        })),
        onDiaristResult: () => {
          diaristObserved = true;
        },
      },
      io,
      parseCountersignArgv,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(turnStarted, true);
    assert.equal(diaristObserved, true);
    assert.ok((volumeAtTurn ?? 0) >= 1);
    const final = await readTicketProvenance(582, project);
    assert.ok(final.entries.length >= 1);
  });
});
