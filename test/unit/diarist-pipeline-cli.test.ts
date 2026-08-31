/**
 * #582 / ADR 0075 — countersign/notary --ticket face + diarist beforeDispatch station.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
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
import { runCountersignDiaristStation } from "../../src/public-cli/countersign-run.ts";
import { createScriptedDiaristCollector } from "../../src/diarist-llm-collector.ts";
import { readTicketProvenance } from "../../src/ticket-provenance.ts";
import type { DiaristSourceBlock } from "../../src/diarist-mechanical.ts";
import { createCountersignRoleRuntime } from "../../src/role-runtime.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";

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
    const attach = join(project, "ticket.md");
    await writeFile(
      attach,
      "---\nticketNumber: 582\n---\n\n「立文件。送司天台记录。」\n",
      "utf8",
    );

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [attach],
      createRunId: () => "01a00000-0000-7000-8000-000000000583",
    });
    assert.equal(admitted.ticketNumber, 582);

    const blocks: DiaristSourceBlock[] = [
      {
        sourceKind: "cc-session",
        sourceRef: { sessionFile: "/s", entryId: "u1" },
        transcript: "立文件。送司天台记录。所以每个票都应该有的一份文档。#582",
        timestamp: "2026-08-31T00:00:00.000Z",
        isUserTurn: true,
        isNotification: false,
      },
    ];

    // Inject blocks via collector that sees candidates from empty cc root —
    // use runDiarist path through station with collector that still needs candidates.
    // Station calls runDiarist without blocks; provide projectsRoot empty + collector
    // that no-ops on empty. Instead call station after seeding via direct runDiarist
    // is not the point — wire collector null and ensure skip-safe, then with scripted
    // path through a thin override: monkey the module is heavy. Use onDiaristResult
    // with collector that works when candidates exist by also setting projectsRoot
    // with a session.

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

test("countersign runtime with hostActions runs notary inner gate on submit", async () => {
  const tools = new Map<string, { name: string; execute: Function }>();
  let beforeStart: ((event: { systemPrompt: string }) => unknown) | undefined;
  const gateCalls: Array<{ kind: string; material: string }> = [];
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: { systemPrompt: string }) => unknown) {
      if (event === "before_agent_start") beforeStart = handler;
    },
    getAllTools() {
      return [{ name: COUNTERSIGN_OUTPUT_TOOL_NAME }];
    },
    async requireGatekeeperPass(options: {
      subject: { kind: string; material: string };
      hostActions: unknown;
      toolCallId: string;
    }) {
      gateCalls.push({
        kind: options.subject.kind,
        material: options.subject.material,
      });
    },
  };
  const hostActions = {
    failInfrastructure(): never {
      throw new Error("fail");
    },
    bindSubmissionNonPass() {},
  };
  const runtime = createCountersignRoleRuntime(
    roleHost as never,
    { loadSoul: async () => "LAW" },
    hostActions,
  );
  await runtime.activate();
  assert.ok(tools.has(COUNTERSIGN_OUTPUT_TOOL_NAME));
  const verdict = { countersignStatus: "converged", note: "署" };
  await tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!.execute(
    "call-1",
    verdict,
    undefined,
    undefined,
    { cwd: "/tmp", mode: "json", model: undefined, sessionManager: {} as never, abort() {} },
  );
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0]!.kind, "countersign_verdict");
  assert.ok(gateCalls[0]!.material.includes("converged"));
  const parsed = JSON.parse(gateCalls[0]!.material) as {
    verdict?: { countersignStatus?: string };
  };
  assert.equal(parsed.verdict?.countersignStatus, "converged");
  void beforeStart;
});
