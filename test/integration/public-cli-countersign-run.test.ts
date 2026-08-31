/**
 * #572 / ADR 0074 public Countersign seat — ticket materials in, 署/封驳 verdict
 * out via real runAkRole entry; one-shot (no resume).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitCountersignInvocation,
  parseCountersignArgv,
} from "../../src/public-cli/invocation.ts";
import {
  buildCountersignTurnRequest,
  runCountersignDiaristStation,
  runPublicCountersign,
  type CountersignRunEnv,
} from "../../src/public-cli/countersign-run.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { createScriptedDiaristCollector } from "../../src/diarist-llm-collector.ts";
import { createScriptedDiaristTicketResolver } from "../../src/diarist-ticket-resolution.ts";
import {
  DiaristIssueSourceError,
  type DiaristIssueFace,
} from "../../src/diarist.ts";
import { DiaristSourceReadError } from "../../src/diarist-mechanical.ts";
import { readTicketProvenance } from "../../src/ticket-provenance.ts";
import { TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC } from "../../src/ticket-provenance-contracts.ts";
import { readFile } from "node:fs/promises";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-countersign-"));
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await scenario(home);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
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
  execFileSync("git", ["config", "user.email", "countersign@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Countersign Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function countersignSessionRows(toolArgs: unknown) {
  const toolCallId = "call_countersign_1";
  return [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-30T00:00:00.000Z",
      message: { role: "user", content: "kickoff", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-08-30T00:00:01.000Z",
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
      timestamp: "2026-08-30T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
        content: [{ type: "text", text: "Countersign output accepted" }],
        details: toolArgs,
        isError: false,
        timestamp: 3,
      },
    },
  ];
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function scriptedCountersignSession(toolArgs: unknown) {
  return async (extraArgs: readonly string[]) => {
    const sessionFile = flagValue(extraArgs, "--session");
    assert.ok(sessionFile);
    await mkdir(join(sessionFile, ".."), { recursive: true });
    await writeFile(
      sessionFile,
      `${countersignSessionRows(toolArgs).map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    const lawful =
      typeof toolArgs === "object" &&
      toolArgs !== null &&
      "countersignStatus" in toolArgs &&
      ["converged", "continue", "escalate"].includes(
        String((toolArgs as { countersignStatus?: unknown }).countersignStatus),
      );
    return {
      code: 0,
      timedOut: false,
      stderr: "",
      args: [...extraArgs],
      ...(lawful
        ? { sealedAcceptance: { role: "countersign" as const, details: toolArgs } }
        : {}),
    };
  };
}

test("countersign admission freezes attachments and binds the countersign role", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const ticket = join(project, "ticket.md");
    await writeFile(ticket, "# 票面\n五问裁决。", "utf8");

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁：本票是否足以开工。",
      attachmentPaths: [ticket],
      createRunId: () => "01a0sign00-0000-7000-8000-000000000001",
    });

    assert.equal(admitted.role, "countersign");
    assert.equal(admitted.instructionEmpty, false);
    assert.equal(admitted.attachments.length, 1);
    assert.ok(admitted.attachments[0]?.frozenPath);

    const turn = buildCountersignTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "裁：本票是否足以开工。" },
    });
    assert.equal(turn.activation.role, "countersign");
    // Unbound admission: no ticket on activation (legal).
    assert.equal(
      "ticketNumber" in turn.activation ? turn.activation.ticketNumber : undefined,
      undefined,
    );
  });
});

test("countersign --ticket admits and projects activation.ticketNumber onto turn request", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const ticket = join(project, "ticket.md");
    // Frontmatter ticket is present; explicit --ticket must win.
    await writeFile(ticket, "---\nticketNumber: 100\n---\n\n五问。\n", "utf8");

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [ticket],
      ticket: 582,
      createRunId: () => "01a0sign00-0000-7000-8000-000000000582",
    });
    assert.equal(admitted.ticketNumber, 582);

    const turn = buildCountersignTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "裁" },
    });
    assert.equal(turn.activation.role, "countersign");
    assert.ok(turn.activation.role === "countersign");
    assert.equal(turn.activation.ticketNumber, 582);

    // Pi adapter output contract: structured argv carries the admitted binding.
    const piArgv = buildPiTurnExtraArgs(turn, piDurablePrincipalAuthority);
    const flagAt = piArgv.indexOf("--ak-countersign-ticket-number");
    assert.ok(flagAt >= 0);
    assert.equal(piArgv[flagAt + 1], "582");
  });
});

test("countersign argv rejects unknown options", async () => {
  assert.throws(
    () => parseCountersignArgv(["--bogus", "裁"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const rejected = await runAkRole(
      ["countersign", "--bogus", "裁"],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(rejected.exitCode, 2);
    assert.equal(rejected.terminal, undefined);
  });
});

test("countersign 署 (converged) and 封驳 (continue) settle as accepted terminals", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const receipts = [
      { countersignStatus: "converged" as const, note: "署" },
      {
        countersignStatus: "continue" as const,
        fix: { summary: "票面授权无可溯真源" },
      },
      {
        countersignStatus: "escalate" as const,
        decisionGate: { question: "本票走哪条路？", options: ["a", "b"] },
      },
    ] as const;

    for (const [index, receipt] of receipts.entries()) {
      const { io } = captureIo();
      const runId = `01a0sign00-0000-7000-8000-${String(index).padStart(12, "0")}`;
      const result = await runAkRole(
        ["countersign", "--project", project, "裁：本票五问。"],
        {
          home,
          packageRoot,
          cwd: project,
          io,
          createRunId: () => runId,
          // Unbound instruction: production would run hermes; inject deterministic
          // true-unbound so the same pre-court stage executes without a live engine.
          diaristTicketResolver: createScriptedDiaristTicketResolver({
            kind: "true-unbound",
          }),
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: scriptedCountersignSession(receipt),
          }),
        },
      );
      assert.equal(result.exitCode, 0, `receipt ${receipt.countersignStatus}`);
      assert.ok(result.terminal, `receipt ${receipt.countersignStatus}`);
      assert.equal(result.terminal.roleOutcome.kind, "accepted");
      assert.equal(
        result.terminal.roleOutcome.status,
        receipt.countersignStatus,
      );
      const facts = result.terminal.roleOutcome.decisiveFacts as Record<
        string,
        unknown
      >;
      assert.equal(facts.countersignStatus, receipt.countersignStatus);
      if (receipt.countersignStatus === "continue") {
        assert.equal(facts.fixSummary, receipt.fix.summary);
      }
      if (receipt.countersignStatus === "escalate") {
        assert.equal(facts.decisionQuestion, receipt.decisionGate.question);
        assert.deepEqual(facts.decisionOptions, [...receipt.decisionGate.options]);
      }
      if (receipt.countersignStatus === "converged") {
        assert.equal(facts.note, receipt.note);
      }
      const coords = issuePiDurablePrincipalCoordinates({
        cwd: project,
        runId,
        role: "countersign",
        home,
      });
      const state = await readRoleRunState(
        coords.runDirectory,
        piDurablePrincipalAuthority,
      );
      assert.equal(state?.role, "countersign");
      assert.equal(state?.state, "terminal");
    }
  });
});

test("public countersign diarist station: issue face/comments/ADR from gh seam; attachments not mislabeled", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
      { cwd: project },
    );

    const adrRel = "docs/adr/0075-ticket-provenance-diarist-pipeline.md";
    await mkdir(join(project, "docs", "adr"), { recursive: true });
    await writeFile(
      join(project, adrRel),
      "# 0075\n\n| `ticket-provenance-file` | 每票 |\n",
      "utf8",
    );

    // Probe attachment must NOT become fake issue-body-comment.
    const probe = join(project, "probe-attachment.md");
    await writeFile(probe, "PROBE_ATTACHMENT_ONLY — not the issue body.\n", "utf8");

    const face: DiaristIssueFace = {
      body: [`「立文件。送司天台记录。」`, `see ${adrRel}`].join("\n"),
      bodyUrl: "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/582",
      comments: [
        {
          id: 9001,
          body: "评论：先起居郎再给事中。",
          createdAt: "2026-08-31T12:00:00.000Z",
          htmlUrl:
            "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/582#issuecomment-9001",
        },
      ],
    };

    const kindsSeen = new Set<string>();
    const sourceRefs: Array<{ url?: string; path?: string; entryId?: string | number }> = [];
    const collector = createScriptedDiaristCollector((input) => {
      for (const c of input.candidates) {
        kindsSeen.add(c.sourceKind);
        sourceRefs.push({ ...c.sourceRef });
      }
      return {
        selections: [],
        rawStdout: '{"selections":[]}',
        engineArgv: ["scripted"],
      };
    });

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [probe],
      ticket: 582,
      createRunId: () => "01a0sign00-0000-7000-8000-000000000d01",
    });
    assert.equal(admitted.ticketNumber, 582);
    assert.equal(admitted.attachments.length, 1);
    const frozenAttachment = admitted.attachments[0]!.frozenPath;

    const result = await runCountersignDiaristStation(admitted, {
      cwd: project,
      packageRoot,
      diaristCollector: collector,
      diaristIssueFaceFetcher: async () => face,
      projectsRoot: join(home, "empty-cc"),
    });
    assert.ok(result);
    assert.equal(result.collectorStatus, "empty-selection");
    // Typed source identities only — no free-text transcript locks.
    assert.ok(kindsSeen.has("issue-body-comment"));
    assert.ok(kindsSeen.has("ticket-decree-block"));
    assert.ok(kindsSeen.has("adr-decision-key"));
    assert.ok(sourceRefs.some((r) => r.url === face.bodyUrl && r.entryId === "body"));
    assert.ok(sourceRefs.some((r) => r.entryId === 9001 && r.url === face.comments[0]!.htmlUrl));
    // Attachment frozen path must not appear as a candidate sourceRef.
    assert.equal(
      sourceRefs.some((r) => r.path === frozenAttachment || r.path === probe),
      false,
    );
  });
});

test("public countersign diarist station: referenced ADR missing fails typed", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/Akagilnc/ak-pi-workflow-roles.git"],
      { cwd: project },
    );

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [],
      ticket: 582,
      createRunId: () => "01a0sign00-0000-7000-8000-000000000d02",
    });

    await assert.rejects(
      () =>
        runCountersignDiaristStation(admitted, {
          cwd: project,
          packageRoot,
          diaristCollector: createScriptedDiaristCollector({
            selections: [],
            rawStdout: '{"selections":[]}',
            engineArgv: ["scripted"],
          }),
          diaristIssueFaceFetcher: async () => ({
            body: "see docs/adr/0075-ticket-provenance-diarist-pipeline.md",
            bodyUrl: "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/582",
            comments: [],
          }),
          projectsRoot: join(home, "empty-cc"),
        }),
      (error: unknown) =>
        error instanceof DiaristSourceReadError && error.reason === "adr-missing",
    );
  });
});

test("public countersign diarist station: bound ticket issue-source failure is typed + durable", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // No origin remote → origin-unresolved (not silent empty issue face).

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [],
      ticket: 582,
      createRunId: () => "01a0sign00-0000-7000-8000-000000000d03",
    });
    assert.equal(admitted.ticketNumber, 582);

    await assert.rejects(
      () =>
        runCountersignDiaristStation(admitted, {
          cwd: project,
          packageRoot,
          diaristCollector: createScriptedDiaristCollector({
            selections: [],
            rawStdout: '{"selections":[]}',
            engineArgv: ["scripted"],
          }),
          projectsRoot: join(home, "empty-cc"),
        }),
      (error: unknown) =>
        error instanceof DiaristIssueSourceError &&
        error.reason === "origin-unresolved" &&
        error.code === "diarist-issue-source",
    );

    const volume = await readTicketProvenance(582, project);
    assert.equal(volume.entries.length, 0);
    assert.equal(volume.diagnostics.length, 1);
    assert.equal(
      volume.diagnostics[0]!.recordClass,
      TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC,
    );
    assert.equal(volume.diagnostics[0]!.diagnosticKind, "issue-source-failed");
    assert.equal(volume.diagnostics[0]!.reason, "origin-unresolved");
  });
});

test("public countersign diarist station: issue-unavailable fetcher fails typed + durable", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
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
      createRunId: () => "01a0sign00-0000-7000-8000-000000000d04",
    });

    await assert.rejects(
      () =>
        runCountersignDiaristStation(admitted, {
          cwd: project,
          packageRoot,
          diaristCollector: createScriptedDiaristCollector({
            selections: [],
            rawStdout: '{"selections":[]}',
            engineArgv: ["scripted"],
          }),
          // Simulate tracker/gh soft miss — station must not continue as empty face.
          diaristIssueFaceFetcher: async () => undefined,
          projectsRoot: join(home, "empty-cc"),
        }),
      (error: unknown) =>
        error instanceof DiaristIssueSourceError &&
        error.reason === "issue-unavailable",
    );

    const volume = await readTicketProvenance(582, project);
    assert.equal(volume.diagnostics.length, 1);
    assert.equal(volume.diagnostics[0]!.diagnosticKind, "issue-source-failed");
    assert.equal(volume.diagnostics[0]!.reason, "issue-unavailable");
  });
});

test("countersign runs are one-shot — resume is refused", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0sign00-0000-7000-8000-0000000000aa";
    const result = await runAkRole(
      ["countersign", "--project", project, "裁"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        diaristTicketResolver: createScriptedDiaristTicketResolver({
          kind: "true-unbound",
        }),
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedCountersignSession({
            countersignStatus: "converged",
            findings: [],
          }),
        }),
      },
    );
    assert.equal(result.exitCode, 0);

    const { io: resumeIo } = captureIo();
    const refused = await runAkRole(["resume", runId, "再裁一次"], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
    });
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.terminal, undefined);
  });
});

function encodeCcProjectPath(cwd: string): string {
  const abs = cwd.startsWith("/") ? cwd : `/${cwd}`;
  return abs.replace(/\//g, "-");
}

test("runPublicCountersign: diarist beforeDispatch failure settles terminal (not stuck running)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // No origin → diarist station throws origin-unresolved after markRunRunning.

    let turnStarted = false;
    const { io, stderr } = captureIo();
    const runId = "01a0sign00-0000-7000-8000-000000000d10";
    const result = await runPublicCountersign(
      ["--ticket", "582", "裁：本票是否足以开工。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: {
          async executeTurn() {
            turnStarted = true;
            throw new Error("role turn must not start after diarist failure");
          },
        },
        createRunId: () => runId,
        projectsRoot: join(home, "empty-cc"),
        diaristCollector: createScriptedDiaristCollector({
          selections: [],
          rawStdout: '{"selections":[]}',
          engineArgv: ["scripted"],
        }),
      },
      io,
      parseCountersignArgv,
    );

    assert.equal(turnStarted, false);
    assert.ok(result.exitCode !== 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId,
      role: "countersign",
      home,
    });
    const state = await readRoleRunState(
      coords.runDirectory,
      piDurablePrincipalAuthority,
    );
    assert.equal(state?.state, "terminal");
    assert.ok(
      stderr.some((line) => line.includes("origin-unresolved") || line.length > 0),
      "controlled failure must present a diagnostic",
    );
  });
});

test("runPublicCountersign: diarist station fills ticket volume before role turn", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
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
    const sessionDir = join(projectsRoot, encodeCcProjectPath(project));
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
      piRunner: scriptedCountersignSession({
        countersignStatus: "converged",
        note: "署",
      }),
    });

    const observingHost = {
      async executeTurn(request: RoleTurnRequest) {
        turnStarted = true;
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
        createRunId: () => "01a0sign00-0000-7000-8000-000000000584",
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
      captureIo().io,
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


/**
 * #582 four-path ticket binding from real public countersign entry.
 * Shared project fixture; four independent path tests; typed fields only.
 */

async function withCountersignProject(
  run: (ctx: { home: string; project: string }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
      { cwd: project },
    );
    await run({ home, project });
  });
}

function countersignPathEnv(input: {
  home: string;
  project: string;
  runId: string;
  onTurn?: (request: RoleTurnRequest) => void;
  diaristTicketResolver?: CountersignRunEnv["diaristTicketResolver"];
  ticketExistenceChecker?: CountersignRunEnv["ticketExistenceChecker"];
  onTicketResolution?: CountersignRunEnv["onTicketResolution"];
  onDiaristResult?: CountersignRunEnv["onDiaristResult"];
  diaristCollector?: CountersignRunEnv["diaristCollector"];
  diaristIssueFaceFetcher?: CountersignRunEnv["diaristIssueFaceFetcher"];
  blockTurn?: boolean;
}): CountersignRunEnv {
  const host = input.blockTurn
    ? {
        async executeTurn() {
          throw new Error("turn must not start");
        },
      }
    : (() => {
        const base = roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedCountersignSession({
            countersignStatus: "converged",
            note: "署",
          }),
        });
        return {
          async executeTurn(request: RoleTurnRequest) {
            input.onTurn?.(request);
            return base.executeTurn(request);
          },
        };
      })();
  return {
    home: input.home,
    agentDir: join(input.home, ".pi"),
    packageRoot,
    cwd: input.project,
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
    roleTurnHost: host,
    createRunId: () => input.runId,
    ...(input.diaristTicketResolver === undefined
      ? {}
      : { diaristTicketResolver: input.diaristTicketResolver }),
    ...(input.ticketExistenceChecker === undefined
      ? {}
      : { ticketExistenceChecker: input.ticketExistenceChecker }),
    ...(input.onTicketResolution === undefined
      ? {}
      : { onTicketResolution: input.onTicketResolution }),
    ...(input.onDiaristResult === undefined ? {} : { onDiaristResult: input.onDiaristResult }),
    diaristCollector:
      input.diaristCollector === undefined
        ? createScriptedDiaristCollector({
            selections: [],
            rawStdout: '{"selections":[]}',
            engineArgv: ["scripted"],
          })
        : input.diaristCollector,
    diaristIssueFaceFetcher:
      input.diaristIssueFaceFetcher ??
      (async () => ({
        body: "face",
        bodyUrl: "https://github.com/o/r/issues/582",
        comments: [],
      })),
  };
}

test("public countersign path: explicit --ticket binds without re-resolution", async () => {
  await withCountersignProject(async ({ home, project }) => {
    let resolverCalled = false;
    let turnTicket: number | undefined;
    const result = await runPublicCountersign(
      ["--ticket", "582", "裁：本票是否足以开工。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p01",
        onTurn: (req) => {
          turnTicket =
            req.activation.role === "countersign" ? req.activation.ticketNumber : undefined;
        },
        diaristTicketResolver: async () => {
          resolverCalled = true;
          return { kind: "true-unbound" };
        },
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(resolverCalled, false);
    assert.equal(result.admitted?.ticketNumber, 582);
    assert.equal(turnTicket, 582);
  });
});

test("public countersign path: unbound resolve+verify binds ticket and runs diary", async () => {
  await withCountersignProject(async ({ home, project }) => {
    let resolutionKind: string | undefined;
    let diaristTicket: number | undefined;
    let turnTicket: number | undefined;
    const result = await runPublicCountersign(
      ["裁：继续审票 #582 是否足以开工。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p02",
        onTurn: (req) => {
          turnTicket =
            req.activation.role === "countersign" ? req.activation.ticketNumber : undefined;
        },
        diaristTicketResolver: createScriptedDiaristTicketResolver({
          kind: "ticket",
          ticketNumber: 582,
        }),
        ticketExistenceChecker: async () => true,
        onTicketResolution: (r) => {
          resolutionKind = r.kind;
        },
        onDiaristResult: (r) => {
          diaristTicket = r.ticketNumber;
        },
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(resolutionKind, "ticket");
    assert.equal(result.admitted?.ticketNumber, 582);
    assert.equal(turnTicket, 582);
    assert.equal(diaristTicket, 582);
    const inv = JSON.parse(
      await readFile(join(result.admitted!.runDirectory, "invocation.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(inv.ticketNumber, 582);
  });
});

test("public countersign path: asserted N fails verify → controlled failure, no wash", async () => {
  await withCountersignProject(async ({ home, project }) => {
    const runId = "01a0sign00-0000-7000-8000-000000000p03";
    const result = await runPublicCountersign(
      ["裁：票 #999999 并不存在。"],
      countersignPathEnv({
        home,
        project,
        runId,
        blockTurn: true,
        diaristTicketResolver: createScriptedDiaristTicketResolver({
          kind: "ticket",
          ticketNumber: 999999,
        }),
        ticketExistenceChecker: async () => false,
        diaristCollector: null,
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.ok(result.exitCode !== 0);
    assert.equal(result.terminal?.roleOutcome.kind, "failure");
    assert.equal(result.admitted?.ticketNumber, undefined);
    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId,
      role: "countersign",
      home,
    });
    assert.equal(
      (await readRoleRunState(coords.runDirectory, piDurablePrincipalAuthority))?.state,
      "terminal",
    );
    const inv = JSON.parse(
      await readFile(join(coords.runDirectory, "invocation.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(inv.ticketNumber, undefined);
  });
});

test("public countersign path: true-unbound skips diary; run page stays unbound", async () => {
  await withCountersignProject(async ({ home, project }) => {
    let diaristCalled = false;
    let resolutionKind: string | undefined;
    let turnTicket: number | undefined;
    const result = await runPublicCountersign(
      ["一般性程序问询，本庭无具体票号。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p04",
        onTurn: (req) => {
          turnTicket =
            req.activation.role === "countersign" ? req.activation.ticketNumber : undefined;
        },
        diaristTicketResolver: createScriptedDiaristTicketResolver({ kind: "true-unbound" }),
        onTicketResolution: (r) => {
          resolutionKind = r.kind;
        },
        onDiaristResult: () => {
          diaristCalled = true;
        },
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(resolutionKind, "true-unbound");
    assert.equal(diaristCalled, false);
    assert.equal(result.admitted?.ticketNumber, undefined);
    assert.equal(turnTicket, undefined);
    const state = await readRoleRunState(
      result.admitted!.runDirectory,
      piDurablePrincipalAuthority,
    );
    assert.equal(state?.role, "countersign");
    assert.equal(state?.runDirectory, result.admitted!.runDirectory);
  });
});
