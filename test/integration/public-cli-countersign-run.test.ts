import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #572 / ADR 0074 public Countersign seat — ticket materials in, 署/封驳 verdict
 * out via real runAkRole entry; #599 resume continues the exact session.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitCountersignInvocation,
  bindAdmittedTicketNumber,
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
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  installGhFixture,
  installHermesFixture,
} from "../helpers/hermes-fixture.ts";
import { DiaristIssueSourceError } from "../../src/diarist.ts";
import { DiaristSourceReadError } from "../../src/diarist-mechanical.ts";
import {
  ensureTicketProvenanceVolume,
  readTicketProvenance,
} from "../../src/ticket-provenance.ts";
import { TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC } from "../../src/ticket-provenance-contracts.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-countersign-", async (home) => {
    const binDir = join(home, "bin");
    await installHermesFixture(binDir);
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    return withPrimaryAwareCleanup(
      () => scenario(home),
      async () => {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      },
    );
  });
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

function scriptedCountersignSession(details: unknown) {
  return scriptedTerminatingToolSession({
    role: "countersign",
    toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
    details,
  });
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

test("countersign admission ignores attachment frontmatter; --ticket is unknown", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const ticket = join(project, "ticket.md");
    await writeFile(ticket, "---\nticketNumber: 100\n---\n\n五问。\n", "utf8");

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [ticket],
      createRunId: () => "01a0sign00-0000-7000-8000-000000000582",
    });
    assert.equal(admitted.ticketNumber, undefined);

    const turn = buildCountersignTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "裁" },
    });
    assert.equal(turn.activation.role, "countersign");
    assert.equal(
      "ticketNumber" in turn.activation ? turn.activation.ticketNumber : undefined,
      undefined,
    );

    // #632: private countersign ticket transport flag is gone (was write-only).
    const piArgv = buildPiTurnExtraArgs(turn, piDurablePrincipalAuthority);
    assert.equal(piArgv.includes("--ak-countersign-ticket-number"), false);
  });

  assert.throws(
    () => parseCountersignArgv(["--ticket", "582", "裁"]),
    (error: unknown) =>
      error instanceof CliUsageError
      && /unknown countersign option: --ticket/.test(
        error instanceof Error ? error.message : String(error),
      ),
  );
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
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
              const outcome = await scriptedCountersignSession(receipt)(args, options);
              // #634: scriptedTerminatingToolSession writes only the countersign
              // terminating receipt — it never opens a real pi role activation that
              // would summon Notary. Seed the direct officer volume the production
              // gate would leave, so Terminal projection still asserts typed seats.
              if (receipt.countersignStatus === "converged") {
                const sessionFile = argvFlagValue(args, "--session");
                assert.ok(sessionFile);
                const auditorDir = join(dirname(sessionFile), "auditor-roles");
                await mkdir(auditorDir, { recursive: true });
                await writeFile(
                  join(auditorDir, "o01_notary.jsonl"),
                  gateToolSessionJsonl({
                    id: "direct-notary",
                    startedAt: "2026-09-04T00:00:00.000Z",
                    endedAt: "2026-09-04T00:00:10.000Z",
                    toolName: "ak_notary_output",
                    args: { status: "pass", findings: [] },
                  }),
                  "utf8",
                );
              }
              return outcome;
            },
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
        assert.ok(result.terminal.gate);
        assert.deepEqual(result.terminal.gate!.actualSeats, ["notary"]);
        assert.equal(result.terminal.gate!.rounds[0]!.dispatch.kind, "direct");
        assert.equal(result.terminal.gate!.rounds[0]!.dispatch.officer, "notary");
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

    const bodyUrl =
      "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/582";
    const commentUrl =
      "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/582#issuecomment-9001";
    // selectAll → volume entries carry typed sourceKind/sourceRef (durable face).
    await installHermesFixture(join(home, "bin"), { selectAllCandidates: true });
    await installGhFixture(join(home, "bin"), {
      issues: {
        582: {
          body: [`「立文件。送司天台记录。」`, `see ${adrRel}`].join("\n"),
          htmlUrl: bodyUrl,
          comments: [
            {
              id: 9001,
              body: "评论：先起居郎再给事中。",
              createdAt: "2026-08-31T12:00:00.000Z",
              htmlUrl: commentUrl,
            },
          ],
        },
      },
    });

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [probe],
      createRunId: () => "01a0sign00-0000-7000-8000-000000000d01",
    });
    await bindAdmittedTicketNumber(admitted, 582);
    assert.equal(admitted.ticketNumber, 582);
    assert.equal(admitted.attachments.length, 1);
    const frozenAttachment = admitted.attachments[0]!.frozenPath;

    const result = await runCountersignDiaristStation(admitted, {
      cwd: project,
      packageRoot,
    });
    assert.ok(result);
    assert.equal(result.collectorStatus, "ok");
    assert.ok(result.appended >= 1);

    // Durable volume only — typed sourceKind/sourceRef; no transcript locks.
    const volume = await readTicketProvenance(582, project, home);
    const kindsSeen = new Set(volume.entries.map((e) => e.sourceKind));
    const sourceRefs = volume.entries.map((e) => e.sourceRef);
    assert.ok(kindsSeen.has("issue-body-comment"));
    assert.ok(kindsSeen.has("ticket-decree-block"));
    assert.ok(kindsSeen.has("adr-decision-key"));
    assert.ok(
      sourceRefs.some((r) => r.url === bodyUrl && r.entryId === "body"),
    );
    assert.ok(
      sourceRefs.some((r) => r.entryId === 9001 && r.url === commentUrl),
    );
    assert.ok(sourceRefs.some((r) => r.path === adrRel));
    // Attachment frozen path must not appear as a candidate sourceRef.
    assert.equal(
      sourceRefs.some(
        (r) => r.path === frozenAttachment || r.path === probe,
      ),
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

    await installGhFixture(join(home, "bin"), {
      issues: {
        582: {
          body: "see docs/adr/0075-ticket-provenance-diarist-pipeline.md",
          comments: [],
        },
      },
    });

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [],
      createRunId: () => "01a0sign00-0000-7000-8000-000000000d02",
    });
    await bindAdmittedTicketNumber(admitted, 582);

    await assert.rejects(
      () =>
        runCountersignDiaristStation(admitted, {
          cwd: project,
          packageRoot,
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
      createRunId: () => "01a0sign00-0000-7000-8000-000000000d03",
    });
    await bindAdmittedTicketNumber(admitted, 582);
    assert.equal(admitted.ticketNumber, 582);

    await assert.rejects(
      () =>
        runCountersignDiaristStation(admitted, {
          cwd: project,
          packageRoot,
        }),
      (error: unknown) =>
        error instanceof DiaristIssueSourceError &&
        error.reason === "origin-unresolved" &&
        error.code === "diarist-issue-source",
    );

    const volume = await readTicketProvenance(582, project, home);
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

    await installGhFixture(join(home, "bin"), {
      issues: {}, // issue 582 unavailable -> 404
    });

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [],
      createRunId: () => "01a0sign00-0000-7000-8000-000000000d04",
    });
    await bindAdmittedTicketNumber(admitted, 582);

    await assert.rejects(
      () =>
        runCountersignDiaristStation(admitted, {
          cwd: project,
          packageRoot,
        }),
      (error: unknown) =>
        error instanceof DiaristIssueSourceError &&
        error.reason === "issue-unavailable",
    );

    const volume = await readTicketProvenance(582, project, home);
    assert.equal(volume.diagnostics.length, 1);
    assert.equal(volume.diagnostics[0]!.diagnosticKind, "issue-source-failed");
    assert.equal(volume.diagnostics[0]!.reason, "issue-unavailable");
  });
});

test("ak-role resume continues countersign on the exact session", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0sign00-0000-7000-8000-0000000000aa";
    // Ticket acceptance surface: interrupt first (unsealed), then resume lands a
    // distinct sealed verdict — not a vacuous re-read of a first-run seal (#599).
    const first = await runAkRole(
      ["countersign", "--project", project, "裁"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            await writeFile(sessionFile, "\n", "utf8");
            return {
              code: 1,
              stderr: "upstream timeout\n",
              timedOut: true,
              args: [...args],
            };
          },
        }),
      },
    );
    assert.equal(first.exitCode, 1);
    assert.equal(first.terminal?.roleOutcome.kind, "failure");
    assert.equal(
      first.terminal?.roleOutcome.kind === "failure"
        ? first.terminal.roleOutcome.cause
        : undefined,
      "timeout",
    );

    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId,
      role: "countersign",
      home,
    });
    const { io: resumeIo, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    const resumed = await runAkRole(["resume", runId, "再裁一次"], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          resumeArgs = [...args];
          return scriptedCountersignSession({
            countersignStatus: "converged",
            note: "RESUMED-续署",
          })(args, options);
        },
      }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "countersign resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumeArgs![resumeArgs!.indexOf("--ak-role") + 1], "countersign");
    assert.equal(resumeArgs![resumeArgs!.indexOf("--session-dir") + 1], coords.sessionDirectory);
    assert.equal(resumeArgs!.includes("再裁一次"), true);
    assert.equal(resumed.terminal?.roleOutcome.role, "countersign");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? resumed.terminal.roleOutcome.status
        : undefined,
      "converged",
    );
    const facts = resumed.terminal?.roleOutcome.kind === "accepted"
      ? (resumed.terminal.roleOutcome.decisiveFacts as Record<string, unknown>)
      : undefined;
    assert.equal(facts?.note, "RESUMED-续署");
  });
});

test("ak-role resume after sealed countersign presents the sealed verdict without dispatch", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0sign00-0000-7000-8000-0000000000ab";
    const first = await runAkRole(
      ["countersign", "--project", project, "裁"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedCountersignSession({
            countersignStatus: "converged",
            note: "FIRST-署",
          }),
        }),
      },
    );
    assert.equal(first.exitCode, 0);
    assert.equal(
      first.terminal?.roleOutcome.kind === "accepted"
        ? (first.terminal.roleOutcome.decisiveFacts as { note?: string }).note
        : undefined,
      "FIRST-署",
    );

    let resumeDispatches = 0;
    const { io: resumeIo, stdout } = captureIo();
    const resumed = await runAkRole(["resume", runId, "再裁一次"], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          resumeDispatches += 1;
          return scriptedCountersignSession({
            countersignStatus: "continue",
            fix: { summary: "RESUMED-封驳-must-not-land" },
          })(args, options);
        },
      }),
    });
    assert.equal(resumeDispatches, 0, "sealed resume must not dispatch a doomed turn");
    assert.equal(resumed.exitCode, 0, stdout.join("") || "sealed countersign resume failed");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? resumed.terminal.roleOutcome.status
        : undefined,
      "converged",
    );
    const facts = resumed.terminal?.roleOutcome.kind === "accepted"
      ? (resumed.terminal.roleOutcome.decisiveFacts as Record<string, unknown>)
      : undefined;
    assert.equal(facts?.note, "FIRST-署");
    assert.notEqual(facts?.fixSummary, "RESUMED-封驳-must-not-land");
  });
});

test("countersign resume timeout is not masked by a prior-attempt residual", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0sign00-0000-7000-8000-0000000000ac";
    const first = await runAkRole(
      ["countersign", "--project", project, "裁"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedTerminatingToolSession({
            role: "countersign",
            toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
            details: { countersignStatus: "converged", note: "PRIOR-residual" },
            isError: true,
            acceptedText: "PRIOR-attempt-residual-error",
          }),
        }),
      },
    );
    assert.equal(first.exitCode, 1);
    assert.equal(first.terminal?.roleOutcome.kind, "failure");
    assert.equal(
      first.terminal?.roleOutcome.kind === "failure"
        ? first.terminal.roleOutcome.cause
        : undefined,
      "output",
    );

    const { io: resumeIo, stdout } = captureIo();
    const resumed = await runAkRole(["resume", runId, "再试"], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          // Append a resumed user turn; keep the prior residual so the scan
          // boundary is exercised (production resume appends, does not wipe).
          const prior = await readFile(sessionFile, "utf8");
          const resumeUser = {
            type: "message",
            id: "user-resume",
            parentId: null,
            timestamp: "2026-08-30T00:01:00.000Z",
            message: { role: "user", content: "再试", timestamp: 10 },
          };
          await writeFile(
            sessionFile,
            `${prior}${JSON.stringify(resumeUser)}\n`,
            "utf8",
          );
          return {
            code: 1,
            stderr: "upstream timeout\n",
            timedOut: true,
            args: [...args],
          };
        },
      }),
    });
    assert.equal(resumed.exitCode, 1, stdout.join("") || "resume timeout path failed");
    assert.equal(resumed.terminal?.roleOutcome.kind, "failure");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "failure"
        ? resumed.terminal.roleOutcome.cause
        : undefined,
      "timeout",
      "prior-attempt residual must not mask current resume timeout",
    );
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
    await installHermesFixture(join(home, "bin"));
    // #709: identity is reused from an existing 起居录 volume, not a model call.
    ensureTicketProvenanceVolume(582, project, home);

    let turnStarted = false;
    const { io, stderr } = captureIo();
    const runId = "01a0sign00-0000-7000-8000-000000000d10";
    const result = await runPublicCountersign(
      ["裁：本票 #582 是否足以开工。"],
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

    ensureTicketProvenanceVolume(582, project, home);
    await installHermesFixture(join(home, "bin"), {
      collectorResponse: {
        selections: [
          {
            candidateIndex: 0,
            quotes: ["立文件。送司天台记录。"],
            triage: "relevant",
          },
        ],
      },
    });
    await installGhFixture(join(home, "bin"), {
      issues: {
        582: {
          body: "「立文件。送司天台记录。」",
          comments: [],
        },
      },
    });

    const ticketPath = join(project, "ticket.md");
    await writeFile(
      ticketPath,
      "---\nticketNumber: 582\n---\n\n「立文件。送司天台记录。」\n",
      "utf8",
    );

    const projectsRoot = join(home, ".claude", "projects");
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
        const read = await readTicketProvenance(582, project, home);
        volumeAtTurn = read.entries.length;
        assert.ok(
          (volumeAtTurn ?? 0) >= 1,
          "ticket-provenance volume must be visible before role turn",
        );
        return baseHost.executeTurn(request);
      },
    };

    const result = await runPublicCountersign(
      ["--attach", ticketPath, "裁：本票 #582 是否足以开工。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: observingHost,
        createRunId: () => "01a0sign00-0000-7000-8000-000000000584",
      },
      captureIo().io,
      parseCountersignArgv,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(turnStarted, true);
    assert.ok((volumeAtTurn ?? 0) >= 1);
    const final = await readTicketProvenance(582, project, home);
    assert.ok(final.entries.length >= 1);
  });
});

/**
 * #709 ticket identity reuse from the real public countersign entry.
 * Shared project fixture; typed fields only.
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
    await installGhFixture(join(home, "bin"), {
      issues: {
        582: { body: "issue 582 body", comments: [] },
        82: { body: "issue 82 body", comments: [] },
      },
    });
    await run({ home, project });
  });
}

function countersignPathEnv(input: {
  home: string;
  project: string;
  runId: string;
  onTurn?: (request: RoleTurnRequest) => void;
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
  };
}

test("public countersign path: --ticket is unknown-option reject (exit 2)", async () => {
  await withCountersignProject(async ({ home, project }) => {
    const result = await runPublicCountersign(
      ["--ticket", "582", "裁：本票是否足以开工。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p01",
        blockTurn: true,
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.admitted, undefined);
  });
});

test("public countersign path: known ticket is reused, bound, and delivered with its diary", async () => {
  await withCountersignProject(async ({ home, project }) => {
    // #709: the identity already exists in this book's records — no seat model call.
    ensureTicketProvenanceVolume(582, project, home);
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
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, 582);
    assert.equal(turnTicket, 582);
    const inv = JSON.parse(
      await readFile(join(result.admitted!.runDirectory, "invocation.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(inv.ticketNumber, 582);
    // Diary station ran for the bound ticket (volume established on disk).
    const volume = await readTicketProvenance(582, project, home);
    assert.ok(volume.recordFile);
    await readFile(volume.recordFile, "utf8");
  });
});

test("public countersign path: no known ticket stays unbound, skips diary and dossier", async () => {
  await withCountersignProject(async ({ home, project }) => {
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
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0);
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

test("public countersign path: an unrecorded number in the instruction is not minted", async () => {
  await withCountersignProject(async ({ home, project }) => {
    let turnTicket: number | undefined;
    const result = await runPublicCountersign(
      ["裁：票 #999999 从未在本书留过记录。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p03",
        onTurn: (req) => {
          turnTicket =
            req.activation.role === "countersign" ? req.activation.ticketNumber : undefined;
        },
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    assert.equal(turnTicket, undefined);
  });
});

test("public countersign path: a known number's digit substring is not that ticket", async () => {
  await withCountersignProject(async ({ home, project }) => {
    // Only #82 is recorded; the instruction carries #582, which is a different token.
    ensureTicketProvenanceVolume(82, project, home);
    const result = await runPublicCountersign(
      ["裁：审票 #582 是否足以开工。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p06",
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
  });
});
