import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #917 / #236 public Reviewer path — fixed base + package ak-cross-m-review + --lens.
 * Caller instruction is optional provenance, never semantic control.
 */
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { recordReviewerWorktreeOwnership } from "../../src/reviewer-worktree-lifecycle.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { payloadFacts, payloadStatus, payloadStatusSequence , objectPayloads} from "../helpers/terminal-payload.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
} from "../../src/package-resources/method-skill.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitReviewerInvocation as admitReviewerInvocationRaw,
  parseReviewerArgv,
} from "../../src/public-cli/invocation.ts";

import {
  loadResumableReviewerRun,
  markRunAdmitted,
  readRoleRunState,
  markRunResumable,
} from "../../src/public-cli/run-lifecycle.ts";
import {
  extractReviewerMethodInvocations,
  formatTerminalResult,
  settleReviewerTerminalResult,
} from "../../src/public-cli/settlement.ts";
import {
  packageRoot,
} from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-reviewer-", scenario);
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
  execFileSync("git", ["config", "user.email", "reviewer@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Reviewer Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

/** Production ReviewerIntent face (ADR 0003 / #917 lens axes). */
function lawfulReviewerReceipt(
  lens: "completeness" | "correctness",
  status: "completed" | "refused" = "completed",
  options?: { readonly axisKey?: string; readonly report?: string },
) {
  // axisKey may deliberately mismatch the lens name — code must not shape-reject (仓级第 0 条).
  const axisKey = options?.axisKey ?? lens;
  const report = options?.report ?? `${lens}-axis-report`;
  const amendments = { [axisKey]: report };
  if (status === "refused") {
    return {
      status: "refused" as const,
      diagnostic: "hard-stop: review cannot proceed",
      amendments,
    };
  }
  return {
    status: "completed" as const,
    amendments,
  };
}


async function admitReviewerInvocation(
  options: Parameters<typeof admitReviewerInvocationRaw>[0],
): ReturnType<typeof admitReviewerInvocationRaw> {
  return admitReviewerInvocationRaw(options);
}


test("parseReviewerArgv defaults to both lenses and accepts an optional single-lens override", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.throws(
    () => parseReviewerArgv(["Review the branch since main."]),
    (error: unknown) => error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
  );
  // Authority remains required; omitted lens defaults to the parallel two-axis mode.
  assert.throws(() => parseReviewerArgv(["--base", "main"]), isUsage);
  assert.throws(
    () => parseReviewerArgv(["--base", "main", "--lens", "completeness"]),
    isUsage,
  );
  assert.deepEqual(
    parseReviewerArgv([
      "--base",
      "main",
      "--authority-ref",
      "https://example.test/a",
    ]),
    {
      instruction: "",
      attachmentPaths: [],
      baseRevision: "main",
      lens: "all",
      authorityRefs: ["https://example.test/a"],
    },
  );
  // Empty lens shares the enum message (not path-helper "requires a path").
  assert.throws(
    () =>
      parseReviewerArgv([
        "--base",
        "main",
        "--lens",
        "",
        "--authority-ref",
        "https://example.test/a",
      ]),
    (error: unknown) =>
      isUsage(error) &&
      error instanceof Error &&
      error.message === "--lens requires completeness or correctness",
  );
  assert.deepEqual(
    parseReviewerArgv([
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
    parseReviewerArgv([
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
    parseReviewerArgv([
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
  assert.throws(() => parseReviewerArgv(["--unknown-flag"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--base", "", "task"]), isUsage);
  // Whitespace-bearing --base smuggles Skill flags; single-token only (same rule as authority-ref).
  assert.throws(
    () =>
      parseReviewerArgv([
        "--base",
        "main --lens all",
        "--lens",
        "completeness",
        "--authority-ref",
        "CLAUDE.md",
      ]),
    (error: unknown) =>
      isUsage(error) &&
      error instanceof Error &&
      error.message === "--base requires a single-token revision",
  );
  // Leading `-` is read as the next Skill option; shared token boundary with authority-ref.
  assert.throws(
    () =>
      parseReviewerArgv([
        "--base",
        "--not-a-rev",
        "--lens",
        "completeness",
        "--authority-ref",
        "CLAUDE.md",
      ]),
    (error: unknown) =>
      isUsage(error) &&
      error instanceof Error &&
      error.message === "--base requires a single-token revision",
  );
  assert.throws(
    () =>
      parseReviewerArgv([
        "--base",
        "main",
        "--lens",
        "completeness",
        "--authority-ref",
        "--smuggled",
      ]),
    (error: unknown) =>
      isUsage(error) &&
      error instanceof Error &&
      error.message ===
        "--authority-ref requires a durable reference, not inline Spec prose",
  );
  assert.throws(() => parseReviewerArgv(["--project", "", "task"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--attach", "spec.md", "task"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--attach=spec.md", "task"]), isUsage);
  assert.throws(
    () =>
      parseReviewerArgv([
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
      parseReviewerArgv([
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
      parseReviewerArgv([
        "--base",
        "main",
        "--lens",
        "completeness",
        "--authority-ref",
        "The system SHALL launch two workers",
      ]),
    (error: unknown) =>
      isUsage(error) &&
      error instanceof Error &&
      /durable reference, not inline Spec prose/i.test(error.message),
  );
  assert.throws(
    () =>
      parseReviewerArgv([
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
    parseReviewerArgv([
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

test("admitReviewerInvocation persists fixed base, lens, authority; caller text is provenance only", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    await assert.rejects(
      () =>
        admitReviewerInvocation({
          principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          instruction: "   ",
          attachmentPaths: [],
          baseRevision: "origin/main",
          lens: "completeness",
          authorityRefs: [],
          createRunId: () => "run-reviewer-blank-no-auth",
        }),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    const blank = await admitReviewerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      instruction: "   ",
      attachmentPaths: [],
      baseRevision: "origin/main",
      lens: "completeness",
      authorityRefs: ["CLAUDE.md"],
      createRunId: () => "run-reviewer-blank",
    });
    assert.deepEqual(
      blank.instructionEmpty, true);
    assert.equal(blank.baseRevision, "origin/main");
    assert.equal(blank.lens, "completeness");
    assert.deepEqual(blank.authorityRefs, ["CLAUDE.md"]);
    assert.equal("taskPath" in blank, false);
    await assert.rejects(
      () => access(join(blank.runDirectory, "task.md")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    const admitted = await admitReviewerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      instruction: "Review the work since the base revision.",
      attachmentPaths: [],
      baseRevision: "origin/main",
      lens: "correctness",
      authorityRefs: ["docs/adr/0001-roles-grow-by-demand.md"],
      createRunId: () => "run-reviewer-admit-001",
    });
    assert.equal(admitted.role, "reviewer");
    assert.equal(admitted.instruction, "Review the work since the base revision.");
    assert.equal(admitted.instructionEmpty, false);
    assert.equal(admitted.baseRevision, "origin/main");
    assert.equal(admitted.lens, "correctness");
    assert.deepEqual(admitted.authorityRefs, ["docs/adr/0001-roles-grow-by-demand.md"]);
    assert.equal("taskPath" in admitted, false);
    await assert.rejects(
      () => access(join(admitted.runDirectory, "task.md")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    const withRefs = await admitReviewerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      instruction: "Scope only; refs carry authority.",
      attachmentPaths: [],
      baseRevision: "origin/main",
      lens: "completeness",
      authorityRefs: [
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      ],
      createRunId: () => "run-reviewer-admit-refs",
    });
    assert.deepEqual(withRefs.authorityRefs, [
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
    ]);
    assert.equal(withRefs.lens, "completeness");
    await assert.rejects(
      () =>
        admitReviewerInvocation({
          principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          instruction: "",
          attachmentPaths: [],
          baseRevision: "origin/main",
          lens: "completeness",
          authorityRefs: ["The system SHALL launch two workers"],
          createRunId: () => "run-reviewer-admit-inline-rejected",
        }),
      (error: unknown) =>
        error instanceof CliUsageError &&
        error.code === "AK_ROLE_USAGE" &&
        /durable reference, not inline Spec prose/i.test(error.message),
    );

    const bookKey = resolveBookKeyFromGit(project);
    assert.equal(
      admitted.runDirectory,
      join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "unbound", "runs",
        "run-reviewer-admit-001@reviewer",
      ),
    );
    const persisted = JSON.parse(
      await readFile(admitted.admittedRequestPath, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(persisted.role, "reviewer");
    assert.equal(persisted.baseRevision, "origin/main");
    assert.equal(persisted.lens, "correctness");
    assert.equal(persisted.instruction, "Review the work since the base revision.");
    assert.deepEqual(persisted.authorityRefs, ["docs/adr/0001-roles-grow-by-demand.md"]);
    assert.equal("taskPath" in persisted, false);
    assert.equal("taskSha256" in persisted, false);
    const persistedRefs = JSON.parse(
      await readFile(withRefs.admittedRequestPath, "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(persistedRefs.authorityRefs, [
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
    ]);
    assert.equal(persistedRefs.lens, "completeness");
  });
});

test("lawful reviewer Terminal records method provenance and typed expansion evidence", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const admitted = await admitReviewerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      instruction: "Review completeness and correctness lenses.",
      attachmentPaths: [],
      baseRevision: "main",
      lens: "completeness",
      // 尺③：非空 authorityRefs 落 evidence artifact 的契约在此承接（原冷装
      // refs-only e2e 的独有断言，#420 类一收拢后由这条在进程内真 Terminal 承载）。
      authorityRefs: [
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      ],
      createRunId: () => "run-reviewer-settle-001",
    });
    await mkdir(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, { recursive: true });
    const material = await loadPackagedMethodSkillMaterial(
      packageRoot,
      "ak-cross-m-review",
    );
    const skillPath = resolvePackagedMethodSkillPath(packageRoot, "ak-cross-m-review");
    const receipt = {
      ...lawfulReviewerReceipt("completeness"),
      auditNoReceipt: {
        status: "no-receipt",
        terminalToolCalled: true,
        rejectedReceipts: [{ reason: "  \t" }],
        deliveryTurns: 2,
        sessionCompletion: "settled-without-accepted-receipt",
        runPointer: "/reviewer-audit/run",
        attemptPointer: "reviewer-audit-attempt",
        acceptedReceipt: false,
      },
    };
    // Skill-tag fixture only — method extraction does not consume opening prose (#495 S4).
    const expansion = `<skill name="ak-cross-m-review" location="${material.skillPath}">\n${material.body}\n</skill>`;
    const sessionLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: expansion }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "r1",
              name: REVIEWER_OUTPUT_TOOL_NAME,
              arguments: { status: "completed" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "r1",
          toolName: REVIEWER_OUTPUT_TOOL_NAME,
          isError: false,
          details: receipt,
        },
      }),
    ];
    await writeFile(
      piDurablePrincipalAuthority.decode(admitted.principal).sessionFile,
      `${sessionLines.join("\n")}\n`,
      "utf8",
    );
    await sealAcceptedSubmission({
      runId: admitted.runId,
      cwd: project,
      home,
      runDirectory: admitted.runDirectory,
      role: "reviewer",
      details: receipt,
      toolCallId: "r1",
    });

    const entries = sessionLines.map((line) => JSON.parse(line));
    const invocations = extractReviewerMethodInvocations(entries, {
      allowedLocations: [material.skillPath, skillPath],
    });
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]?.name, "ak-cross-m-review");
    assert.equal(invocations[0]?.location, material.skillPath);

    const ambient = extractReviewerMethodInvocations(
      [
        {
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `<skill name="ak-cross-m-review" location="${join(home, ".agents/skills/ak-cross-m-review/SKILL.md")}">\nbody\n</skill>\n\nreq`,
              },
            ],
          },
        },
      ],
      { allowedLocations: [material.skillPath, skillPath] },
    );
    assert.equal(ambient.length, 0);

    const terminal = await settleReviewerTerminalResult(admitted, piDurablePrincipalAuthority, {
      methodProvenance: material.provenance,
      methodSkillPath: material.skillPath,
      methodSkillConfiguredPath: skillPath,
    });
    assert.equal(terminal.roleOutcome.role, "reviewer");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(terminal.roleOutcome), ["completed"]);
    assert.equal(terminal.runId, "run-reviewer-settle-001");
    assert.equal(terminal.artifacts.some((a) => a.kind === "report"), true);
    assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);
    assert.match(formatTerminalResult(terminal), /auditNoReceipt/);

    const evidence = JSON.parse(
      await readFile(
        terminal.artifacts.find((a) => a.kind === "evidence")!.path,
        "utf8",
      ),
    ) as Record<string, unknown> & {
      baseRevision?: string;
      callerProvenance?: string;
      methodProvenance: {
        name: string;
        packageAdaptation: string;
        upstream: {
          repository: string;
          attribution: string;
          commit: string;
          path: string;
        };
        files: Record<string, { sha256: string; gitBlob: string }>;
      };
      methodInvocationObserved: boolean;
      methodInvocations: Array<{ name: string; location: string }>;
    };
    assert.equal("taskPath" in evidence, false);
    assert.equal("taskSha256" in evidence, false);
    assert.equal(evidence.baseRevision, "main");
    assert.deepEqual(evidence.authorityRefs, [
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
    ]);
    assert.equal(evidence.callerProvenance, "Review completeness and correctness lenses.");
    assert.equal(evidence.methodProvenance.name, "ak-cross-m-review");
    assert.equal(
      evidence.methodProvenance.packageAdaptation,
      "verbatim-upstream",
    );
    assert.equal(evidence.methodInvocationObserved, true);
    assert.equal(evidence.methodInvocations.length, 1);
    const evidenceText = JSON.stringify(evidence);
    assert.equal(evidenceText.includes(".agents/skills"), false);
  });
});

test("package ak-cross-m-review method is verbatim upstream single-lens CMR", async () => {
  const material = await loadPackagedMethodSkillMaterial(packageRoot, "ak-cross-m-review");
  assert.equal(material.name, "ak-cross-m-review");
  assert.equal(material.provenance.packageAdaptation, "verbatim-upstream");
  assert.equal(
    material.provenance.upstream.commit,
    "57b10e2cea9ff008e2b36b98b55610e58cdfd512",
  );
  assert.equal(material.provenance.upstream.version, "0.5.2.0");
  assert.equal(material.skillPath.includes(packageRoot), true);
  assert.equal(material.skillPath.includes(".agents/skills"), false);
});

test("ak-role reviewer admits fixed base without requiring caller task", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });

    {
      const { io, stdout } = captureIo();
      const captured: string[][] = [];
      const capturedStdin: string[] = [];
      const childHeads: string[] = [];
      const result = await runAkRole([
          "reviewer", "--model", "test/caller-seat:high",
          "--project",
          project,
          "--base",
          "HEAD~1",
          "--authority-ref",
          "CLAUDE.md",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-reviewer-blank-ok",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            captured.push([...args]);
            capturedStdin.push(options.stdin ?? "");
            childHeads.push(execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: options.cwd,
              encoding: "utf8",
            }).trim());
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const material = await loadPackagedMethodSkillMaterial(
              packageRoot,
              "ak-cross-m-review",
            );
            const skillPath = resolvePackagedMethodSkillPath(
              packageRoot,
              "ak-cross-m-review",
            );
            // Skill-tag fixture only — method extraction does not consume opening prose (#495 S4).
            const expansion = `<skill name="ak-cross-m-review" location="${skillPath}">\n${material.body}\n</skill>`;
            const childLens = args[args.indexOf("--ak-review-lens") + 1] as "completeness" | "correctness";
            const receipt = lawfulReviewerReceipt(childLens);
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "user",
                  content: [{ type: "text", text: expansion }],
                },
              })}\n${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "ok1",
                  toolName: REVIEWER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: receipt,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              sealedAcceptance: { role: "reviewer" as const, details: receipt, toolCallId: "ok1" },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(result.exitCode, 0, stdout.join("") || "reviewer failed");
      assert.equal(captured.length, 2);
      assert.deepEqual(
        captured.map((args) => args[args.indexOf("--ak-review-lens") + 1]).sort(),
        ["completeness", "correctness"],
      );
      for (const args of captured) {
        assert.equal(args[args.indexOf("--ak-role") + 1], "reviewer");
        assert.equal(args.includes("--skill"), true);
        assert.equal(args.includes("--ak-review-task"), false);
        assert.equal(
          args[args.indexOf("--ak-review-base") + 1],
          execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: project, encoding: "utf8" }).trim(),
        );
      }
      assert.equal(new Set(childHeads).size, 1);
      assert.equal(childHeads[0], execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: project,
        encoding: "utf8",
      }).trim());
      assert.equal(result.terminal?.roleOutcome.role, "reviewer");
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal(result.terminal?.reviewerChildren?.completeness?.roleOutcome.role, "reviewer");
      assert.equal(result.terminal?.reviewerChildren?.correctness?.roleOutcome.role, "reviewer");
      for (const child of [
        result.terminal?.reviewerChildren?.completeness,
        result.terminal?.reviewerChildren?.correctness,
      ]) {
        const reportPath = child?.artifacts.find((artifact) => artifact.kind === "report")?.path;
        assert.ok(reportPath);
        const childInvocation = JSON.parse(
          await readFile(join(reportPath, "..", "..", "invocation.json"), "utf8"),
        ) as { correlationId?: string };
        const childAdmitted = JSON.parse(
          await readFile(join(reportPath, "..", "..", "admitted-request.json"), "utf8"),
        ) as { correlationId?: string };
        assert.equal(childInvocation.correlationId, "run-cli-reviewer-blank-ok");
        assert.equal(childAdmitted.correlationId, "run-cli-reviewer-blank-ok");
      }

      const bookKey = resolveBookKeyFromGit(project);
      const runDirectory = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "unbound", "runs",
        "run-cli-reviewer-blank-ok@reviewer",
      );
      await access(join(runDirectory, "admitted-request.json"));
      await assert.rejects(
        () => access(join(runDirectory, "task.md")),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      const projectEntries = await readdir(project);
      assert.deepEqual(
      projectEntries.includes("docs"), false);
      assert.equal(projectEntries.includes(".agents"), false);
      // Durable parent report directly embeds both original child Terminals.
      const completedReport = JSON.parse(
        await readFile(join(runDirectory, "artifacts", "report.json"), "utf8"),
      ) as {
        role: string;
        outcome?: {
          kind?: string;
          payloads?: ReadonlyArray<Record<string, unknown>>;
        };
      };
      assert.equal(completedReport.role, "reviewer");
      assert.equal(completedReport.outcome?.kind, "accepted");
      assert.equal(completedReport.outcome?.payloads?.length, 2);
      assert.deepEqual(completedReport.outcome?.payloads, [
        result.terminal?.reviewerChildren?.completeness,
        result.terminal?.reviewerChildren?.correctness,
      ]);
      assert.equal(
        (await readRoleRunState(runDirectory, piDurablePrincipalAuthority))?.state,
        "terminal",
      );
    }

    // One summons exception must not discard the sibling's original Terminal.
    {
      const { io } = captureIo();
      const partial = await runAkRole([
        "reviewer", "--model", "test/caller-seat:high", "--project", project,
        "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
      ], {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-cli-reviewer-partial-failure",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const lens = args[args.indexOf("--ak-review-lens") + 1] as "completeness" | "correctness";
            if (lens === "correctness") throw new Error("correctness summons exploded");
            const sessionFile = args[args.indexOf("--session") + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const details = lawfulReviewerReceipt(lens);
            await writeFile(sessionFile, `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolCallId: "partial-ok",
                toolName: REVIEWER_OUTPUT_TOOL_NAME,
                isError: false,
                details,
              },
            })}\n`, "utf8");
            return {
              code: 0,
              sealedAcceptance: { role: "reviewer" as const, details, toolCallId: "partial-ok" },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
        }),
      });
      assert.equal(partial.exitCode, 1);
      assert.equal(partial.terminal?.roleOutcome.kind, "failure");
      assert.equal(partial.terminal?.reviewerChildren?.completeness?.roleOutcome.kind, "accepted");
      assert.equal(partial.terminal?.reviewerChildren?.correctness?.roleOutcome.kind, "failure");
      assert.equal(partial.terminal?.reviewerChildOutcomes?.correctness.exitCode, 1);
      assert.equal(partial.terminal?.roleOutcome.kind === "failure"
        ? partial.terminal.roleOutcome.payloads?.length
        : undefined, 2);
    }

    // Same public entry: hard-stop refused + mismatched axis key still lands (仓级第 0 条).
    {
      const { io, stdout } = captureIo();
      const refusedReceipt = lawfulReviewerReceipt("completeness", "refused", {
        axisKey: "not-a-declared-axis",
        report: "partial-report-before-stop",
      });
      const refused = await runAkRole([
          "reviewer", "--model", "test/caller-seat:high",
          "--project",
          project,
          "--base",
          "HEAD~1",
          "--lens",
          "completeness",
          "--authority-ref",
          "CLAUDE.md",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-reviewer-hard-stop",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const material = await loadPackagedMethodSkillMaterial(
              packageRoot,
              "ak-cross-m-review",
            );
            const skillPath = resolvePackagedMethodSkillPath(
              packageRoot,
              "ak-cross-m-review",
            );
            const expansion = `<skill name="ak-cross-m-review" location="${skillPath}">\n${material.body}\n</skill>`;
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "user",
                  content: [{ type: "text", text: expansion }],
                },
              })}\n${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "r-refused",
                  toolName: REVIEWER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: refusedReceipt,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              sealedAcceptance: {
                role: "reviewer" as const,
                details: refusedReceipt,
                toolCallId: "r-refused",
              },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(refused.exitCode, 0, stdout.join("") || "reviewer hard-stop failed");
      assert.equal(refused.terminal?.roleOutcome.role, "reviewer");
      assert.deepEqual(
        refused.terminal?.roleOutcome.kind === "accepted"
          ? payloadStatusSequence(refused.terminal.roleOutcome)
          : [],
        ["refused"],
      );
      const bookKey = resolveBookKeyFromGit(project);
      const refusedReport = JSON.parse(
        await readFile(
          join(
            home,
            ".ak-roles",
            "books",
            bookKey,
            "unbound", "runs",
            "run-cli-reviewer-hard-stop@reviewer",
            "artifacts",
            "report.json",
          ),
          "utf8",
        ),
      ) as {
        outcome?: {
          kind?: string;
          payloads?: ReadonlyArray<Record<string, unknown>>;
        };
      };
      assert.equal(refusedReport.outcome?.kind, "accepted");
      const refusedDurable =
        refusedReport.outcome?.payloads?.find((p) => p.status === "refused") ?? {};
      assert.equal(refusedDurable.diagnostic, "hard-stop: review cannot proceed");
      assert.equal(
        (refusedDurable.amendments as Record<string, string> | undefined)?.["not-a-declared-axis"],
        "partial-report-before-stop",
      );
    }

    {
      const { io, stdout } = captureIo();
      let captured: string[] | undefined;
      let capturedStdin: string | undefined;
      const result = await runAkRole([
          "reviewer", "--model", "test/caller-seat:high",
          "--project",
          project,
          "--base",
          "HEAD~1",
          "--lens",
          "correctness",
          "--authority-ref",
          "CLAUDE.md",
          "--authority-ref",
          "docs/adr/0001-roles-grow-by-demand.md",
          "Review the latest commit on both axes.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-reviewer-ok",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            captured = [...args];
            capturedStdin = options.stdin;
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const material = await loadPackagedMethodSkillMaterial(
              packageRoot,
              "ak-cross-m-review",
            );
            const skillPath = resolvePackagedMethodSkillPath(
              packageRoot,
              "ak-cross-m-review",
            );
            // Skill-tag fixture only — method extraction does not consume opening prose (#495 S4).
            const expansion = `<skill name="ak-cross-m-review" location="${skillPath}">\n${material.body}\n</skill>`;
            const receipt = lawfulReviewerReceipt("completeness");
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "user",
                  content: [{ type: "text", text: expansion }],
                },
              })}\n${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "ok1",
                  toolName: REVIEWER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: receipt,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              sealedAcceptance: { role: "reviewer" as const, details: receipt, toolCallId: "ok1" },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(result.exitCode, 0, stdout.join("") || "reviewer failed");
      assert.equal(captured!.includes("--ak-review-task"), false);
      // correctness path must project the admitted lens (catches constant-completeness).
      assert.equal(captured![captured!.indexOf("--ak-review-lens") + 1], "correctness");
      // Repeatable authority + optional caller prose ride the same frozen Skill line.
      const okDialogue = readUserDialogueStdin(capturedStdin ?? "");
      assert.equal(
        okDialogue.startsWith(
          "/skill:ak-cross-m-review --base HEAD~1 --lens correctness --authority CLAUDE.md --authority docs/adr/0001-roles-grow-by-demand.md",
        ),
        true,
        okDialogue,
      );
      assert.match(okDialogue, /Review the latest commit on both axes\./);
      const bookKey = resolveBookKeyFromGit(project);
      const evidence = JSON.parse(
        await readFile(
          join(
            home,
            ".ak-roles",
            "books",
            bookKey,
            "unbound", "runs",
            "run-cli-reviewer-ok@reviewer",
            "artifacts",
            "evidence.json",
          ),
          "utf8",
        ),
      ) as { callerProvenance?: string };
      assert.equal(
        evidence.callerProvenance,
        "Review the latest commit on both axes.",
      );
    }

    // Final seal brackets status with two HEAD reads; a clean commit between them fails.
    {
      const wrapperRoot = await mkdtemp(join(home, "git-seal-wrapper-"));
      const wrapper = join(wrapperRoot, "git");
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      await writeFile(wrapper, `#!/bin/sh
count_file='${join(wrapperRoot, "count")}'
marker='${join(wrapperRoot, "committed")}'
count=0
[ -f "$count_file" ] && count=$(cat "$count_file")
if [ "$1 $2 $3" = "rev-parse --verify HEAD^{commit}" ]; then
  count=$((count + 1)); printf '%s' "$count" > "$count_file"
fi
if [ "$1" = "status" ] && [ "$count" = "2" ] && [ "$PWD" = "${project}" ] && [ ! -f "$marker" ]; then
  : > "$marker"
  '${realGit}' commit --allow-empty -m 'seal-race' >/dev/null
fi
exec '${realGit}' "$@"
`, "utf8");
      await chmod(wrapper, 0o755);
      const priorPath = process.env.PATH;
      process.env.PATH = `${wrapperRoot}:${priorPath ?? ""}`;
      try {
        const { io, stdout } = captureIo();
        const sealed = await runAkRole([
          "reviewer", "--model", "test/caller-seat:high", "--project", project,
          "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
        ], {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-reviewer-final-seal",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
              const lens = args[args.indexOf("--ak-review-lens") + 1] as "completeness" | "correctness";
              const sessionFile = args[args.indexOf("--session") + 1]!;
              await mkdir(join(sessionFile, ".."), { recursive: true });
              const details = lawfulReviewerReceipt(lens);
              await writeFile(sessionFile, `${JSON.stringify({
                type: "message",
                message: { role: "toolResult", toolCallId: `seal-${lens}`, toolName: REVIEWER_OUTPUT_TOOL_NAME, isError: false, details },
              })}\n`, "utf8");
              return {
                code: 0,
                sealedAcceptance: { role: "reviewer" as const, details, toolCallId: `seal-${lens}` },
                stderr: "",
                timedOut: false,
                args: [...args],
              };
            },
          }),
        });
        assert.equal(sealed.exitCode, 1, stdout.join(""));
        assert.equal(sealed.terminal?.roleOutcome.kind, "failure");
        assert.equal(sealed.terminal?.reviewerChildren?.completeness?.roleOutcome.kind, "accepted");
        assert.equal(sealed.terminal?.reviewerChildren?.correctness?.roleOutcome.kind, "accepted");
        assert.equal(sealed.terminal?.reviewerChildOutcomes?.completeness.exitCode, 1);
        assert.equal(sealed.terminal?.reviewerChildOutcomes?.correctness.exitCode, 1);
      } finally {
        process.env.PATH = priorPath;
      }
    }

    // Default parent must apply canonical Step 1 before clean detached copies hide dirt.
    {
      await writeFile(join(project, "untracked-review-evidence.txt"), "dirty\n", "utf8");
      let childTurns = 0;
      const { io, stdout } = captureIo();
      const dirty = await runAkRole([
        "reviewer", "--model", "test/caller-seat:high", "--project", project,
        "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
      ], {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-cli-reviewer-dirty-parent",
        io,
        roleTurnHost: {
          async executeTurn() {
            childTurns += 1;
            throw new Error("dirty parent must not dispatch a child turn");
          },
        },
      });
      assert.equal(dirty.exitCode, 1, stdout.join(""));
      assert.equal(childTurns, 0);
      assert.equal(dirty.terminal?.roleOutcome.kind, "failure");
      assert.equal(dirty.terminal?.reviewerChildOutcomes?.completeness.exitCode, 1);
      assert.equal(dirty.terminal?.reviewerChildOutcomes?.correctness.exitCode, 1);
      assert.equal(dirty.terminal?.reviewerChildren?.completeness, undefined);
      assert.equal(dirty.terminal?.reviewerChildren?.correctness, undefined);
    }
  });
});

test("resume rejects blank/inline authorityRefs via unique --authority-ref grammar", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const admitted = await admitReviewerInvocationRaw({
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
    // Durable session principal required before resume load.
    await mkdir(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, { recursive: true });
    await writeFile(join(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, "session.jsonl"), "", "utf8");
    await markRunAdmitted(admitted, piDurablePrincipalAuthority);
    await markRunResumable(admitted.runDirectory, {
      httpStatus: 429,
      provider: "xai",
    });

    const persisted = JSON.parse(
      await readFile(admitted.admittedRequestPath, "utf8"),
    ) as Record<string, unknown>;
    // Corrupt durable face with blank + inline Spec prose — must not restore as authority.
    persisted.authorityRefs = ["", "The system SHALL launch two workers"];
    await writeFile(
      admitted.admittedRequestPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(
      () => loadResumableReviewerRun(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError &&
        error.code === "AK_ROLE_USAGE" &&
        (/nonempty durable reference|not inline Spec prose/i.test(error.message)),
    );

    // Base damage keeps durable run identity — never rebrand as fresh --base input.
    persisted.authorityRefs = ["https://example.com/durable-ref"];
    persisted.baseRevision = "";
    await writeFile(
      admitted.admittedRequestPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadResumableReviewerRun(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError &&
        error.code === "AK_ROLE_USAGE" &&
        error.message.includes(`role run admitted reviewer base revision is missing: ${admitted.runId}`) &&
        !error.message.includes("--base"),
    );

    persisted.baseRevision = "--lens";
    await writeFile(
      admitted.admittedRequestPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadResumableReviewerRun(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError &&
        error.code === "AK_ROLE_USAGE" &&
        error.message.includes(`role run admitted reviewer base revision is damaged: ${admitted.runId}`) &&
        !error.message.includes("--base"),
    );
  });
});

test("ak-role resume continues reviewer with fixed base and package skill", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-cli-reviewer-resume";
    const instruction = "Review the branch after quota recovery.";

    {
      const { io } = captureIo();
      const first = await runAkRole([
        "reviewer", "--model", "test/caller-seat:high", "--project", project,
        "--base", "main", "--lens", "correctness", "--authority-ref", "CLAUDE.md",
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
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            await observeTyped429ViaProductionHandler({
              runDirectory: join(sessionDir, ".."),
              provider: "xai",
            });
            return {
              code: 1,
              stderr: "quota",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.ok(first.terminal?.resume, "reviewer 429 must be resumable");
      assert.equal(first.terminal?.roleOutcome.role, "reviewer");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "unbound", "runs",
      `${runId}@reviewer`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const admitted = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as Record<string, unknown> & { role: string; baseRevision?: string; ticketNumber?: number };
    assert.equal(admitted.role, "reviewer");
    assert.equal(admitted.baseRevision, "main");
    assert.equal(admitted.lens, "correctness");
    assert.equal(admitted.ticketNumber, undefined);
    assert.equal("taskPath" in admitted, false);
    assert.equal("taskSha256" in admitted, false);

    const { io, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    let resumeStdin: string | undefined;
    const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
        resumeArgs = [...args];
        resumeStdin = options.stdin;
        assert.equal(args[args.indexOf("--ak-role") + 1], "reviewer");
        assert.equal(args.includes("--ak-review-task"), false);
        assert.equal(args[args.indexOf("--ak-review-base") + 1], admitted.baseRevision);
        // correctness resume path — constant-completeness projection must fail here.
        assert.equal(args[args.indexOf("--ak-review-lens") + 1], "correctness");
        assert.equal(args[args.indexOf("--ak-review-lens") + 1], admitted.lens);
        assert.equal(args.includes("--skill"), true);
        assert.equal(args.includes(instruction), false);
        const resumeDialogue = readUserDialogueStdin(resumeStdin ?? "");
        assert.equal(resumeDialogue, "[ak-role:resume-continue]");
        assert.equal(resumeDialogue.includes("/skill:"), false);
        assert.equal(resumeDialogue.includes(instruction), false);
        assert.equal(args[args.indexOf("--session-dir") + 1], sessionDirectory);
        const material = await loadPackagedMethodSkillMaterial(
          packageRoot,
          "ak-cross-m-review",
        );
        const skillPath = resolvePackagedMethodSkillPath(
          packageRoot,
          "ak-cross-m-review",
        );
        // Skill-tag fixture only — method extraction does not consume opening prose (#495 S4).
        const expansion = `<skill name="ak-cross-m-review" location="${skillPath}">\n${material.body}\n</skill>`;
        const details = lawfulReviewerReceipt("correctness");
        await writeFile(
          join(sessionDirectory, "session.jsonl"),
          `${JSON.stringify({
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: expansion }],
            },
          })}\n${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "rr1",
              toolName: REVIEWER_OUTPUT_TOOL_NAME,
              isError: false,
              details,
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          sealedAcceptance: { role: "reviewer" as const, details, toolCallId: "rr1" },
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
          }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "reviewer resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumed.terminal?.roleOutcome.role, "reviewer");
    assert.deepEqual(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(resumed.terminal.roleOutcome)
        : [],
      ["completed"],
    );
  });
});


test("default reviewer resume preserves the frozen dual-axis shape", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-cli-reviewer-default-resume";
    const admitted = await admitReviewerInvocationRaw({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      instruction: "--opaque-resume-request",
      attachmentPaths: [],
      baseRevision: "main",
      lens: "all",
      authorityRefs: ["CLAUDE.md"],
      createRunId: () => runId,
    });
    await mkdir(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, { recursive: true });
    await writeFile(piDurablePrincipalAuthority.decode(admitted.principal).sessionFile, "", "utf8");
    await markRunAdmitted(admitted, piDurablePrincipalAuthority);
    await markRunResumable(admitted.runDirectory, { httpStatus: 429, provider: "xai" });
    const retainedRoot = join(home, "retained-reviewer-worktrees");
    const retainedProject = join(retainedRoot, "completeness");
    await mkdir(retainedRoot, { recursive: true });
    execFileSync("git", ["worktree", "add", "--detach", retainedProject, "HEAD"], { cwd: project });
    await recordReviewerWorktreeOwnership(admitted.runDirectory, {
      sourceProjectRoot: project,
      worktreeRoot: retainedRoot,
      projectRoot: retainedProject,
    });
    await access(retainedProject);

    const lenses: string[] = [];
    const dialogues: string[] = [];
    const { io, stdout } = captureIo();
    const resumed = await runAkRole([
      "resume", "--model", "test/caller-seat:high", runId, "--opaque-current-message",
    ], {
      packageRoot,
      home,
      cwd: project,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          const lens = args[args.indexOf("--ak-review-lens") + 1] as "completeness" | "correctness";
          lenses.push(lens);
          dialogues.push(readUserDialogueStdin(options.stdin ?? ""));
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          const details = lawfulReviewerReceipt(lens);
          await writeFile(sessionFile, `${JSON.stringify({
            type: "message",
            message: { role: "toolResult", toolCallId: `resume-${lens}`, toolName: REVIEWER_OUTPUT_TOOL_NAME, isError: false, details },
          })}\n`, "utf8");
          return {
            code: 0,
            sealedAcceptance: { role: "reviewer" as const, details, toolCallId: `resume-${lens}` },
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join(""));
    assert.deepEqual(lenses.sort(), ["completeness", "correctness"]);
    assert.equal(dialogues.every((dialogue) => dialogue.includes("--opaque-current-message")), true);
    assert.equal(dialogues.every((dialogue) => dialogue.includes("--opaque-resume-request")), true);
    assert.equal(resumed.terminal?.reviewerChildren?.completeness?.roleOutcome.kind, "accepted");
    assert.equal(resumed.terminal?.reviewerChildren?.correctness?.roleOutcome.kind, "accepted");
    assert.equal(
      (await readRoleRunState(admitted.runDirectory, piDurablePrincipalAuthority))?.state,
      "terminal",
    );
    await assert.rejects(
      () => access(retainedProject),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    await assert.rejects(
      () => access(retainedRoot),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  });
});
