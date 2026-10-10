import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { readCurrentSection, seedCurrentSection, submittedParams, terminalBodyAt } from "../helpers/run-dossier-fixture.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { parseArgs } from "node:util";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { sessionDirectoryOf } from "../../src/role-run-placement.ts";
import { readTicketProgressLines } from "../../src/ticket-progress.ts";
/**
 * #917 / #236 public Reviewer path — fixed base + package ak-cross-m-review + --lens.
 * Caller instruction is optional provenance, never semantic control.
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitPublicRole,
  type AdmitReviewerInvocationOptions,
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";

import {
  loadResumablePublicRole,
  markRunAdmitted,
  readRoleRunState,
} from "../../src/public-cli/run-lifecycle.ts";
import {
  packageRoot,
  withProcessCwd,
} from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-reviewer-", scenario);
}

/** Production ReviewerIntent face (ADR 0003 / #917 lens axes). */
function lawfulReviewerReceipt(
  lens: "completeness" | "correctness",
  status: "completed" | "refused" = "completed",
  options?: { readonly axisKey?: string; readonly report?: string },
) {
  // axisKey may deliberately mismatch the lens name — code must not shape-reject (仓内 CLAUDE.md 开篇).
  const axisKey = options?.axisKey ?? lens;
  const report = options?.report ?? `${lens}-axis-report`;
  const amendments = { [axisKey]: report };
  if (status === "refused") {
    return {
      status: "refused" as const,
      diagnostic: "hard-stop: review cannot proceed",
      amendments,
      // #1171: ordinary reviewer tracers are not the missing-ticket reask case.
      ticketNumber: 1171,
    };
  }
  return {
    status: "completed" as const,
    amendments,
    ticketNumber: 1171,
  };
}

function admitReviewerInvocation(options: AdmitReviewerInvocationOptions) {
  return admitPublicRole("reviewer", {
    instruction: options.instruction,
    attachmentPaths: options.attachmentPaths,
    baseRevision: options.baseRevision,
    lens: options.lens,
    authorityRefs: options.authorityRefs,
    ...(options.project === undefined ? {} : { project: options.project }),
  }, {
    home: options.home,
    principalAuthority: options.principalAuthority,
    cwd: options.cwd,
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
  }, options.assertedTicketNumber === undefined
    ? undefined
    : { assertedTicketNumber: options.assertedTicketNumber });
}

test("parseReviewerArgv defaults to both lenses and accepts an optional single-lens override", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.throws(
    () => parsePublicSeatArgv("reviewer", ["Review the branch since main."]),
    (error: unknown) => error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
  );
  // Authority remains required; omitted lens defaults to the parallel two-axis mode.
  assert.throws(() => parsePublicSeatArgv("reviewer", ["--base", "main"]), isUsage);
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "main",
        "--authority-ref",
        "The system SHALL launch two workers",
      ]),
    isUsage,
  );
  assert.throws(
    () => parsePublicSeatArgv("reviewer", ["--base", "main", "--lens", "completeness"]),
    isUsage,
  );
  assert.deepEqual(
    parsePublicSeatArgv("reviewer", [
      "--base",
      "main",
      "--authority-ref",
      "https://example.test/a",
    ]),
    {
      instruction: "",
      attachmentPaths: [],
      baseRevision: "main",
      authorityRefs: ["https://example.test/a"],
    },
  );
  // Public `--lens all` is not an admitted single-axis value.
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "main",
        "--lens",
        "all",
        "--authority-ref",
        "https://example.test/a",
      ]),
    isUsage,
  );
  // Empty lens is rejected at the same typed usage boundary.
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "main",
        "--lens",
        "",
        "--authority-ref",
        "https://example.test/a",
      ]),
    isUsage,
  );
  assert.deepEqual(
    parsePublicSeatArgv("reviewer", [
      "--base",
      "main",
      "--lens",
      "completeness",
      "--authority-ref",
      "https://example.test/a",
      "--project",
      "/tmp/p",
      "Review since the base.",
    ]),
    {
      instruction: "Review since the base.",
      attachmentPaths: [],
      baseRevision: "main",
      lens: "completeness",
      authorityRefs: ["https://example.test/a"],
      project: "/tmp/p",
    },
  );
  assert.deepEqual(
    parsePublicSeatArgv("reviewer", [
      "--base",
      "HEAD~1",
      "--lens",
      "correctness",
      "--authority-ref",
      "CLAUDE.md",
    ]),
    {
      instruction: "",
      attachmentPaths: [],
      baseRevision: "HEAD~1",
      lens: "correctness",
      authorityRefs: ["CLAUDE.md"],
    },
  );
  assert.deepEqual(
    parsePublicSeatArgv("reviewer", [
      "--base",
      "main",
      "--lens",
      "completeness",
      "--authority-ref",
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
      "--authority-ref=https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      "Scope the review to the owner decision.",
    ]),
    {
      instruction: "Scope the review to the owner decision.",
      attachmentPaths: [],
      baseRevision: "main",
      lens: "completeness",
      authorityRefs: [
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      ],
    },
  );
  // Each negative below carries every other reviewer precondition, so only the
  // targeted rule can reject it — a missing --base/--authority-ref would mask
  // a regression in the rule actually under test.
  assert.throws(
    () => parsePublicSeatArgv("reviewer", [
      "--unknown-flag",
      "--base",
      "main",
      "--authority-ref",
      "CLAUDE.md",
    ]),
    isUsage,
  );
  assert.throws(
    () => parsePublicSeatArgv("reviewer", [
      "--base",
      "",
      "--authority-ref",
      "CLAUDE.md",
      "task",
    ]),
    isUsage,
  );
  // Whitespace-bearing --base smuggles Skill flags; single-token only (same rule as authority-ref).
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "main --lens all",
        "--lens",
        "completeness",
        "--authority-ref",
        "CLAUDE.md",
      ]),
    isUsage,
  );
  // Leading `-` is read as the next Skill option; shared token boundary with authority-ref.
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "--not-a-rev",
        "--lens",
        "completeness",
        "--authority-ref",
        "CLAUDE.md",
      ]),
    isUsage,
  );
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "main",
        "--lens",
        "completeness",
        "--authority-ref",
        "--smuggled",
      ]),
    isUsage,
  );
  assert.throws(
    () => parsePublicSeatArgv("reviewer", [
      "--project",
      "",
      "--base",
      "main",
      "--authority-ref",
      "CLAUDE.md",
      "task",
    ]),
    isUsage,
  );
  assert.throws(
    () => parsePublicSeatArgv("reviewer", [
      "--attach",
      "spec.md",
      "--base",
      "main",
      "--authority-ref",
      "CLAUDE.md",
      "task",
    ]),
    isUsage,
  );
  assert.throws(
    () => parsePublicSeatArgv("reviewer", [
      "--attach=spec.md",
      "--base",
      "main",
      "--authority-ref",
      "CLAUDE.md",
      "task",
    ]),
    isUsage,
  );
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "main",
        "--lens",
        "completeness",
        "--authority-ref",
        "",
      ]),
    isUsage,
  );
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "main",
        "--lens",
        "completeness",
        "--authority-ref=",
      ]),
    isUsage,
  );
  // refs-only: representative inline Spec prose is rejected at the public admission seam.
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "main",
        "--lens",
        "completeness",
        "--authority-ref",
        "The system SHALL launch two workers",
      ]),
    isUsage,
  );
  assert.throws(
    () =>
      parsePublicSeatArgv("reviewer", [
        "--base",
        "main",
        "--lens",
        "correctness",
        "--authority-ref",
        "Requirements:\n1. Launch two workers\n2. Report cardinality honestly",
      ]),
    isUsage,
  );
  // Durable public reference forms remain accepted with bytes unchanged; extras pass (ADR 0025).
  assert.deepEqual(
    parsePublicSeatArgv("reviewer", [
      "--base",
      "main",
      "--lens",
      "correctness",
      "--authority-ref",
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      "--authority-ref",
      "docs/adr/0063-received-prompt-is-audit-evidence-not-authority.md",
      "--authority-ref",
      "git@github.com:Akagilnc/ak-pi-workflow-roles.git",
      "extra free text is fine",
    ]),
    {
      instruction: "extra free text is fine",
      attachmentPaths: [],
      baseRevision: "main",
      lens: "correctness",
      authorityRefs: [
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
        "docs/adr/0063-received-prompt-is-audit-evidence-not-authority.md",
        "git@github.com:Akagilnc/ak-pi-workflow-roles.git",
      ],
    },
  );
});

/** Shortest lawful child turn: write receipt from --ak-review-lens (or override). */
async function lawfulChildTurn(
  args: readonly string[],
  options?: {
    readonly lens?: "completeness" | "correctness";
    readonly status?: "completed" | "refused";
    readonly axisKey?: string;
    readonly report?: string;
    readonly empty?: boolean;
    readonly toolCallId?: string;
  },
) {
  const sessionFile = args[args.indexOf("--session") + 1]!;
  await mkdir(join(sessionFile, ".."), { recursive: true });
  if (options?.empty) {
    await writeFile(sessionFile, "", "utf8");
    return { code: 0, stderr: "", timedOut: false as const, args: [...args] };
  }
  const lens =
    options?.lens
    ?? (args[args.indexOf("--ak-review-lens") + 1] as "completeness" | "correctness");
  const details = lawfulReviewerReceipt(lens, options?.status ?? "completed", options);
  const toolCallId = options?.toolCallId ?? `ok-${lens}`;
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: REVIEWER_OUTPUT_TOOL_NAME,
      isError: false,
      details,
    },
  }));
  await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");
  return {
    code: 0,
    sealedAcceptance: { role: "reviewer" as const, details, toolCallId },
    stderr: "",
    timedOut: false as const,
    args: [...args],
  };
}

function reviewerHost(
  piRunner: Parameters<typeof roleTurnHostFromLegacyPiRunner>[0]["piRunner"],
  principalAuthority = piDurablePrincipalAuthority,
) {
  return roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority,
    piRunner,
  });
}

test("default dual-lens admits both axes without a parent run", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });

    const captured: string[][] = [];
    const childHeads: string[] = [];
    const { io, stdout } = captureIo();
    const result = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", project, "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-cli-reviewer-blank-ok",
      io,
      roleTurnHost: reviewerHost(async (args, options) => {
        captured.push([...args]);
        childHeads.push(execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: options.cwd,
          encoding: "utf8",
        }).trim());
        return lawfulChildTurn(args);
      }),
    });

    assert.equal(result.exitCode, 0, stdout.join("") || "reviewer failed");
    assert.equal(captured.length, 2);
    assert.deepEqual(
      captured.map((args) => args[args.indexOf("--ak-review-lens") + 1]).sort(),
      ["completeness", "correctness"],
    );
    for (const args of captured) {
      assert.equal(args[args.indexOf("--ak-role") + 1], "reviewer");
      assert.equal(args.includes("--ak-review-task"), false);
      // Ordinary single-axis public semantics: dual-lens legs are not station children.
      assert.equal(args.includes("--ak-station-child"), false);
      assert.equal(args[args.indexOf("--ak-review-base") + 1], "HEAD~1");
    }
    assert.equal(new Set(childHeads).size, 1);
    assert.equal(childHeads[0], execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project,
      encoding: "utf8",
    }).trim());
    assert.equal(result.terminal?.batch, "reviewer");
    // Parentless batch must not invent affirmative no-advice (#946).
    assert.equal(result.terminal?.navigator.disposition, "unavailable");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      result.terminal?.roleOutcome.kind === "accepted"
        ? result.terminal.roleOutcome.payloads?.length
        : 0,
      2,
    );
    assert.equal(result.terminal?.reviewerChildren?.completeness?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.reviewerChildren?.correctness?.roleOutcome.kind, "accepted");

    const bookKey = resolveBookKeyFromGit(project);
    // #1199: dual-lens rounds are independent (`1.<lens>`); no occupancy placeholders.
    const progressRounds = readTicketProgressLines(
      join(home, ".ak-roles", "books", bookKey, "1171"),
    )
      .filter((line) => line.seat === "reviewer")
      .map((line) => line.round)
      .sort();
    assert.deepEqual(progressRounds, ["1.completeness", "1.correctness"]);
    await assert.rejects(
      () => access(join(
        home, ".ak-roles", "books", bookKey, "unbound", "runs",
        "run-cli-reviewer-blank-ok@reviewer", "current.json",
      )),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    const projectEntries = await readdir(project);
    assert.equal(projectEntries.includes("docs"), false);
    assert.equal(projectEntries.includes(".agents"), false);
  });
});

test("one dual-lens leg failure keeps the sibling original terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });

    const { io } = captureIo();
    const partial = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", project, "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-cli-reviewer-partial-failure",
      io,
      roleTurnHost: reviewerHost(async (args) => {
        const lens = args[args.indexOf("--ak-review-lens") + 1];
        if (lens === "correctness") throw new Error("correctness summons exploded");
        return lawfulChildTurn(args, { toolCallId: "partial-ok" });
      }),
    });

    assert.equal(partial.exitCode, 1);
    assert.equal(partial.terminal?.roleOutcome.kind, "failure");
    assert.equal(partial.terminal?.reviewerChildren?.completeness?.roleOutcome.kind, "accepted");
    assert.equal(partial.terminal?.reviewerChildren?.correctness?.roleOutcome.kind, "failure");
    assert.equal(partial.terminal?.reviewerChildOutcomes?.correctness.exitCode, 1);
    assert.equal(
      partial.terminal?.roleOutcome.kind === "failure"
        ? partial.terminal.roleOutcome.payloads?.length
        : undefined,
      2,
    );
  });
});

test("lawful no_receipt dual-lens child is not a batch failure", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });

    const { io, stdout } = captureIo();
    const noReceiptBatch = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", project, "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-cli-reviewer-no-receipt-batch",
      io,
      roleTurnHost: reviewerHost(async (args) => {
        const lens = args[args.indexOf("--ak-review-lens") + 1];
        if (lens === "correctness") return lawfulChildTurn(args, { empty: true });
        return lawfulChildTurn(args, { toolCallId: "no-receipt-sibling" });
      }),
    });

    assert.equal(noReceiptBatch.exitCode, 0, stdout.join(""));
    assert.equal(noReceiptBatch.terminal?.roleOutcome.kind, "accepted");
    assert.equal(noReceiptBatch.terminal?.reviewerChildren?.completeness?.roleOutcome.kind, "accepted");
    assert.equal(noReceiptBatch.terminal?.reviewerChildren?.correctness?.roleOutcome.kind, "no_receipt");
    assert.equal(noReceiptBatch.terminal?.reviewerChildOutcomes?.correctness.exitCode, 0);
  });
});

test("explicit single-lens hard-stop refused still lands mismatched axis key", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const { io, stdout } = captureIo();
    const refused = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", project, "--base", "HEAD~1", "--lens", "completeness",
      "--authority-ref", "CLAUDE.md",
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-cli-reviewer-hard-stop",
      io,
      roleTurnHost: reviewerHost(async (args) =>
        lawfulChildTurn(args, {
          status: "refused",
          axisKey: "not-a-declared-axis",
          report: "partial-report-before-stop",
          toolCallId: "r-refused",
        })),
    });

    assert.equal(refused.exitCode, 0, stdout.join("") || "reviewer hard-stop failed");
    assert.deepEqual(
      refused.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(refused.terminal.roleOutcome)
        : [],
      ["refused"],
    );
    const bookKey = resolveBookKeyFromGit(project);
    // Receipt carries ticketNumber (#1171 ordinary tracer) → live under ticket.
    const refusedRunDirectory = join(
      home, ".ak-roles", "books", bookKey, "1171", "runs",
      "run-cli-reviewer-hard-stop@reviewer",
    );
    const refusedReport = terminalBodyAt(join(refusedRunDirectory, "current.json"), "report") as {
      outcome?: { kind?: string };
    };
    assert.equal(refusedReport.outcome?.kind, "accepted");
    // The refusing payload itself is what history.jsonl kept.
    const refusedDurable =
      (submittedParams(refusedRunDirectory) as ReadonlyArray<Record<string, unknown>>)
        .find((p) => p.status === "refused") ?? {};
    assert.equal(refusedDurable.diagnostic, "hard-stop: review cannot proceed");
    assert.equal(
      (refusedDurable.amendments as Record<string, string> | undefined)?.["not-a-declared-axis"],
      "partial-report-before-stop",
    );
  });
});

test("explicit single-lens projects admitted lens and optional caller provenance", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Missing --authority-ref: public entry rejects before the host starts.
    {
      let hostStarted = 0;
      const { io } = captureIo();
      const missingAuthority = await runAkRole([
        "reviewer", "--model", "test/caller-seat:high",
        "--project", project, "--base", "HEAD~1", "--lens", "correctness",
        "Review without authority.",
      ], {
        packageRoot,
        home,
        cwd: project,
        io,
        roleTurnHost: reviewerHost(async () => {
          hostStarted += 1;
          throw new Error("missing authority must not dispatch");
        }),
      });
      assert.equal(missingAuthority.exitCode, 2);
      assert.equal(hostStarted, 0);
    }

    let captured: string[] | undefined;
    let capturedStdin: string | undefined;
    let turnCwd: string | undefined;
    const instruction = "Review the latest commit on both axes.";
    const { io, stdout } = captureIo();
    const result = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", project, "--base", "HEAD~1", "--lens", "correctness",
      "--authority-ref", "CLAUDE.md",
      "--authority-ref", "docs/adr/0001-roles-grow-by-demand.md",
      instruction,
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-cli-reviewer-ok",
      io,
      roleTurnHost: reviewerHost(async (args, options) => {
        captured = [...args];
        capturedStdin = options.stdin;
        turnCwd = options.cwd;
        // Explicit --lens shares the ticket worktree (#997).
        assert.equal(realpathSync(options.cwd), realpathSync(project));
        // Deliberate receipt/lens mismatch must still land (仓内 CLAUDE.md 开篇).
        return lawfulChildTurn(args, {
          lens: "completeness",
          toolCallId: "ok1",
        });
      }),
    });

    assert.equal(result.exitCode, 0, stdout.join("") || "reviewer failed");
    assert.equal(typeof turnCwd, "string");
    assert.equal(realpathSync(turnCwd!), realpathSync(project));
    assert.equal(captured!.includes("--ak-review-task"), false);
    assert.equal(captured![captured!.indexOf("--ak-review-lens") + 1], "correctness");
    // The skill's formal args and the caller's own words must reach the host,
    // not merely the invocation ledger or the internal argv.
    const dialogue = readUserDialogueStdin(capturedStdin ?? "");
    const formalArgs = dialogue.split("\n", 1)[0]!.split(/\s+/);
    const { values, positionals } = parseArgs({
      args: formalArgs,
      options: {
        base: { type: "string" },
        lens: { type: "string" },
        authority: { type: "string", multiple: true },
      },
    });
    assert.deepEqual(positionals, []);
    assert.equal(values.base, "HEAD~1");
    assert.equal(values.lens, "correctness");
    assert.deepEqual(values.authority, ["CLAUDE.md", "docs/adr/0001-roles-grow-by-demand.md"]);
    assert.ok(dialogue.slice(dialogue.indexOf("\n")).includes(instruction));
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.artifacts.some((a) => a.kind === "report"), true);
    // The admitted facts are the run's own record in current.json's admitted section.
    const reportRef = result.terminal?.artifacts.find((a) => a.kind === "report");
    assert.ok(reportRef);
    const admittedFacts = readCurrentSection(dirname(reportRef.path), "admitted") as {
      instruction?: string;
      baseRevision?: string;
      lens?: string;
      authorityRefs?: string[];
    };
    assert.equal(admittedFacts.instruction, instruction);
    assert.equal(admittedFacts.baseRevision, "HEAD~1");
    assert.equal(admittedFacts.lens, "correctness");
    assert.deepEqual(admittedFacts.authorityRefs, [
      "CLAUDE.md",
      "docs/adr/0001-roles-grow-by-demand.md",
    ]);
    assert.equal("taskPath" in admittedFacts, false);
    assert.equal("taskSha256" in admittedFacts, false);
    if (result.terminal?.roleOutcome.kind === "accepted") {
      const amendments = (result.terminal.roleOutcome.payloads?.[0] as {
        amendments?: { completeness?: string };
      } | undefined)?.amendments;
      assert.equal(amendments?.completeness, "completeness-axis-report");
    }
  });
});

test("default dual-lens keeps original child terminals despite dirty tree and mid-batch drift", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });

    // Pre-dispatch dirt and mid-batch probes/HEAD drift must not kill the batch (#1133).
    await writeFile(join(project, "untracked-review-evidence.txt"), "dirty\n", "utf8");
    let childTurns = 0;
    const { io, stdout } = captureIo();
    const result = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", project, "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-cli-reviewer-dirty-ok",
      io,
      roleTurnHost: reviewerHost(async (args, options) => {
        childTurns += 1;
        const lens = args[args.indexOf("--ak-review-lens") + 1]!;
        await writeFile(join(options.cwd, `sibling-probe-${lens}.txt`), "probe\n", "utf8");
        if (lens === "correctness") {
          execFileSync("git", ["commit", "--allow-empty", "-m", "mid-batch-head-drift"], {
            cwd: options.cwd,
          });
        }
        return lawfulChildTurn(args);
      }),
    });

    assert.equal(result.exitCode, 0, stdout.join("") || "dirty dual-lens must keep original terminals");
    assert.equal(childTurns, 2);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.reviewerChildren?.completeness?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.reviewerChildren?.correctness?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.reviewerChildOutcomes?.completeness.exitCode, 0);
    assert.equal(result.terminal?.reviewerChildOutcomes?.correctness.exitCode, 0);
  });
});

test("default dual-lens missing base keeps dual-child surface without child turns", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });

    let childTurns = 0;
    const { io, stdout } = captureIo();
    const missingBase = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", project, "--base", "no-such-reviewer-base-rev",
      "--authority-ref", "CLAUDE.md",
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-cli-reviewer-missing-base",
      io,
      roleTurnHost: {
        async executeTurn() {
          childTurns += 1;
          throw new Error("missing base must not dispatch a child turn");
        },
      },
    });
    assert.equal(missingBase.exitCode, 1, stdout.join(""));
    assert.equal(childTurns, 0);
    assert.equal(missingBase.terminal?.roleOutcome.kind, "failure");
    assert.equal(missingBase.terminal?.reviewerChildOutcomes?.completeness.exitCode, 1);
    assert.equal(missingBase.terminal?.reviewerChildOutcomes?.correctness.exitCode, 1);
    const completenessDiag = missingBase.terminal?.reviewerChildOutcomes?.completeness.stderr ?? "";
    const correctnessDiag = missingBase.terminal?.reviewerChildOutcomes?.correctness.stderr ?? "";
    assert.equal(completenessDiag.length > 0, true);
    assert.equal(completenessDiag, correctnessDiag);
  });
});

test("resume rejects blank/inline authorityRefs via unique --authority-ref grammar", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const admitted = await admitReviewerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      instruction: "Scope only",
      attachmentPaths: [],
      baseRevision: "main",
      lens: "correctness",
      authorityRefs: ["https://example.com/durable-ref"],
      createRunId: () => "run-cli-reviewer-resume-bad-refs",
    });
    await mkdir(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, { recursive: true });
    await writeFile(join(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, "session.jsonl"), "", "utf8");
    await markRunAdmitted(admitted, piDurablePrincipalAuthority);

    const persisted = readCurrentSection(admitted.runDirectory, "admitted");
    persisted.authorityRefs = ["", "The system SHALL launch two workers"];
    seedCurrentSection(admitted.runDirectory, "admitted", persisted);

    await assert.rejects(
      () => loadResumablePublicRole(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    persisted.authorityRefs = ["https://example.com/durable-ref"];
    persisted.lens = "all";
    seedCurrentSection(admitted.runDirectory, "admitted", persisted);
    await assert.rejects(
      () => loadResumablePublicRole(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    persisted.lens = "correctness";
    persisted.baseRevision = "";
    seedCurrentSection(admitted.runDirectory, "admitted", persisted);
    await assert.rejects(
      () => loadResumablePublicRole(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    persisted.baseRevision = "--lens";
    seedCurrentSection(admitted.runDirectory, "admitted", persisted);
    await assert.rejects(
      () => loadResumablePublicRole(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );
  });
});

test("ak-role resume continues reviewer with fixed base", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-cli-reviewer-resume";
    const instruction = "Review the branch after quota recovery.";

    {
      const { io } = captureIo();
      const first = await runAkRole([
        "reviewer", "--model", "test/caller-seat:high",
        "--project", project, "--base", "main", "--lens", "correctness",
        "--authority-ref", "CLAUDE.md", instruction,
      ], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: reviewerHost(async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return { code: 1, stderr: "quota", timedOut: false, args: [...args] };
        }),
      });
      assert.equal(first.terminal?.roleOutcome.role, "reviewer");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home, ".ak-roles", "books", bookKey, "unbound", "runs", `${runId}@reviewer`,
    );
    const sessionDirectory = sessionDirectoryOf(runDirectory);
    const admitted = readCurrentSection(runDirectory, "admitted") as Record<string, unknown> & {
      role: string;
      baseRevision?: string;
      lens?: string;
      projectRoot?: string;
    };
    assert.equal(admitted.role, "reviewer");
    assert.equal(admitted.baseRevision, "main");
    assert.equal(admitted.lens, "correctness");
    assert.equal(realpathSync(String(admitted.projectRoot)), realpathSync(project));

    const { io, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    let resumeStdin: string | undefined;
    let resumeCwd: string | undefined;
    const resumed = await runAkRole([
      "resume", "--model", "test/caller-seat:high", "--engine", "agy", runId,
      "调用者原话",
    ], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      roleTurnHost: reviewerHost(async (args, options) => {
        resumeArgs = [...args];
        resumeStdin = options.stdin;
        assert.equal(args[args.indexOf("--ak-role") + 1], "reviewer");
        assert.equal(args.includes("--ak-review-task"), false);
        assert.equal(args[args.indexOf("--ak-review-base") + 1], admitted.baseRevision);
        assert.equal(args[args.indexOf("--ak-review-lens") + 1], "correctness");
        assert.equal(args.includes(instruction), false);
        const resumeDialogue = readUserDialogueStdin(resumeStdin ?? "");
        assert.equal(resumeDialogue, "调用者原话");
        assert.equal(resumeDialogue.includes("/skill:"), false);
        assert.equal(resumeDialogue.includes(instruction), false);
        assert.equal(args[args.indexOf("--session-dir") + 1], sessionDirectory);
        // Resume shares the ticket worktree (#997); no seat-specific ephemeral copy.
        assert.equal(realpathSync(options.cwd), realpathSync(project));
        resumeCwd = options.cwd;
        return lawfulChildTurn(args, {
          lens: "correctness",
          toolCallId: "rr1",
        });
      }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "reviewer resume failed");
    assert.equal(typeof resumeCwd, "string");
    assert.equal(realpathSync(resumeCwd!), realpathSync(project));
    assert.equal(Array.isArray(resumeArgs), true);
    assert.deepEqual(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(resumed.terminal.roleOutcome)
        : [],
      ["completed"],
    );
    // #1171: resume seal carries ticketNumber → leg lives under ticket, not unbound.
    const liveDirectory = join(
      home, ".ak-roles", "books", bookKey, "1171", "runs", `${runId}@reviewer`,
    );
    assert.equal(
      (await readRoleRunState(liveDirectory, piDurablePrincipalAuthority))?.state,
      "terminal",
    );
  });
});

test("default dual-lens from subdirectory admits caller project and shares ticket worktree", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });
    const subdir = join(project, "nested", "leaf");
    await mkdir(subdir, { recursive: true });
    const callerProjectRoot = realpathSync(subdir);
    // Trap second host-facing projection: first maps test→test-mapped; a second
    // pass would map test-mapped→test-mapped-twice and fail the provider assert.
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "host-providers.json"),
      `${JSON.stringify({
        pi: { test: "test-mapped", "test-mapped": "test-mapped-twice" },
      }, null, 2)}\n`,
      "utf8",
    );

    const capturedProviders: string[] = [];

    const { io, stdout } = captureIo();
    const batch = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", subdir, "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
    ], {
      packageRoot,
      home,
      cwd: subdir,
      credentials: { "openai-codex": true, xai: true },
      timeoutMs: 17_777,
      io,
      roleTurnHost: reviewerHost(async (args, options) => {
        assert.equal(options.timeoutMs, 17_777);
        // Dual-lens children share the caller project path (#997).
        assert.equal(realpathSync(options.cwd), callerProjectRoot);
        if (args.includes("--provider")) {
          capturedProviders.push(args[args.indexOf("--provider") + 1]!);
        }
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
        return { code: 1, stderr: "quota", timedOut: false, args: [...args] };
      }),
    });

    assert.equal(batch.exitCode, 1, stdout.join(""));
    const completenessRunId = batch.terminal?.reviewerChildren?.completeness?.runId;
    const correctnessRunId = batch.terminal?.reviewerChildren?.correctness?.runId;
    if (typeof completenessRunId !== "string" || typeof correctnessRunId !== "string") {
      assert.fail("dual-lens children must disclose runId");
    }
    assert.notEqual(completenessRunId, correctnessRunId);
    assert.equal(capturedProviders.length >= 2, true);
    for (const provider of capturedProviders) assert.equal(provider, "test-mapped");

    // Durable identity matches the caller project (10a); one durable page is enough.
    const bookKey = resolveBookKeyFromGit(project);
    const admitted = readCurrentSection(
      join(home, ".ak-roles", "books", bookKey, "unbound", "runs", `${completenessRunId}@reviewer`),
      "admitted",
    ) as { projectRoot: string; baseRevision: string; lens: string };
    assert.equal(realpathSync(admitted.projectRoot), callerProjectRoot);
    assert.equal(admitted.baseRevision, "HEAD~1");
    assert.equal(admitted.lens, "completeness");

    // Resume: same ticket worktree; no seat-specific ephemeral copy (#997).
    const { io: resumeIo, stdout: resumeStdout } = captureIo();
    let resumeCwd: string | undefined;
    const resumed = await runAkRole(
      ["resume", "--model", "test/caller-seat:high", completenessRunId],
      {
        packageRoot,
        home,
        cwd: subdir,
        credentials: { "openai-codex": true, xai: true },
        io: resumeIo,
        roleTurnHost: reviewerHost(async (args, options) => {
          resumeCwd = options.cwd;
          assert.equal(realpathSync(options.cwd), callerProjectRoot);
          return lawfulChildTurn(args, {
            lens: "completeness",
            toolCallId: "subdir-resume",
          });
        }),
      },
    );
    assert.equal(resumed.exitCode, 0, resumeStdout.join(""));
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(typeof resumeCwd, "string");
    assert.equal(realpathSync(resumeCwd!), callerProjectRoot);
  });
});

test("default dual-lens relative --project and inline --base fail closed like single-axis", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });
    const subdir = join(project, "nested", "leaf");
    await mkdir(subdir, { recursive: true });
    const expectedProjectRoot = realpathSync(subdir);

    await withProcessCwd(project, async () => {
      const relativeProject = relative(process.cwd(), subdir);
      assert.equal(relativeProject.includes(".."), false);

      const { io: batchIo, stdout: batchStdout } = captureIo();
      const batch = await runAkRole([
        "reviewer", "--model", "test/caller-seat:high",
        "--project", relativeProject,
        "--base=HEAD~1", "--authority-ref", "CLAUDE.md",
      ], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io: batchIo,
        roleTurnHost: reviewerHost(async (args, options) => {
          assert.equal(realpathSync(options.cwd), expectedProjectRoot);
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return { code: 1, stderr: "quota", timedOut: false, args: [...args] };
        }),
      });
      assert.equal(batch.exitCode, 1, batchStdout.join(""));
      const completenessRunId = batch.terminal?.reviewerChildren?.completeness?.runId;
      if (typeof completenessRunId !== "string") {
        assert.fail("completeness child must disclose runId");
      }
      const bookKey = resolveBookKeyFromGit(project);
      const admitted = readCurrentSection(
        join(home, ".ak-roles", "books", bookKey, "unbound", "runs", `${completenessRunId}@reviewer`),
        "admitted",
      ) as { projectRoot: string; baseRevision: string };
      assert.equal(realpathSync(admitted.projectRoot), expectedProjectRoot);
      assert.equal(admitted.baseRevision, "HEAD~1");
    });

    // Inline --base=value must fail closed before child turns start.
    let childTurns = 0;
    const { io: badIo, stdout: badStdout } = captureIo();
    const bad = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", subdir,
      "--base=not-a-real-ref-946", "--authority-ref", "CLAUDE.md",
    ], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io: badIo,
      roleTurnHost: reviewerHost(async () => {
        childTurns += 1;
        throw new Error("child turn must not start when base precheck fails");
      }),
    });
    assert.equal(bad.exitCode, 1, badStdout.join(""));
    assert.equal(childTurns, 0);
  });
});
