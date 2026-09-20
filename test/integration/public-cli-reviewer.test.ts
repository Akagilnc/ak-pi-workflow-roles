import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
/**
 * #917 / #236 public Reviewer path — fixed base + package ak-cross-m-review + --lens.
 * Caller instruction is optional provenance, never semantic control.
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
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
import { join, relative } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";
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
  markRunResumable,
  readRoleRunState,
} from "../../src/public-cli/run-lifecycle.ts";
import {
  extractReviewerMethodInvocations,
  formatTerminalResult,
  settleReviewerTerminalResult,
} from "../../src/public-cli/settlement.ts";
import {
  packageRoot,
  withProcessCwd,
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

/**
 * Source tree with a committed focused-test probe and an ignored node_modules
 * dependency — the #983 shape: worktree add does not carry deps; provision must.
 */
async function seedGitProjectWithIgnoredDeps(root: string): Promise<void> {
  seedGitProject(root);
  await writeFile(join(root, ".gitignore"), "node_modules\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "ak-reviewer-worktree-deps-probe",
      type: "module",
      private: true,
    }, null, 2)}\n`,
    "utf8",
  );
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(
    join(root, "test", "deps-probe.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { value } from "ak-reviewer-deps-probe";',
      'test("resolves provisioned dependency", () => {',
      '  assert.equal(value, "ok");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync("git", ["add", ".gitignore", "package.json", "test"], { cwd: root });
  execFileSync("git", ["commit", "-m", "seed focused-test probe"], { cwd: root });
  const depRoot = join(root, "node_modules", "ak-reviewer-deps-probe");
  await mkdir(depRoot, { recursive: true });
  await writeFile(
    join(depRoot, "package.json"),
    `${JSON.stringify({
      name: "ak-reviewer-deps-probe",
      type: "module",
      main: "index.js",
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(depRoot, "index.js"), 'export const value = "ok";\n', "utf8");
}

/** Native focused-test result in the ephemeral sandbox — not ERR_MODULE_NOT_FOUND. */
function assertFocusedTestResolvesInSandbox(cwd: string): void {
  // Sandbox cwd may be a caller subdirectory; focused tests live at the git root.
  const sandboxRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
  // Nested node:test must not inherit the parent runner's IPC/context channels.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  const result = execFileSync(
    process.execPath,
    ["--test", "test/deps-probe.test.js"],
    { cwd: sandboxRoot, encoding: "utf8", env },
  );
  assert.match(result, /# pass 1/);
  assert.equal(result.includes("ERR_MODULE_NOT_FOUND"), false);
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
      authorityRefs: ["https://example.test/a"],
    },
  );
  // Public `--lens all` is not an admitted single-axis value.
  assert.throws(
    () =>
      parseReviewerArgv([
        "--base",
        "main",
        "--lens",
        "all",
        "--authority-ref",
        "https://example.test/a",
      ]),
    (error: unknown) =>
      isUsage(error) &&
      error instanceof Error &&
      error.message === "--lens requires completeness or correctness",
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

/** Shortest lawful child turn: write receipt from --ak-review-lens (or override). */
async function lawfulChildTurn(
  args: readonly string[],
  options?: {
    readonly lens?: "completeness" | "correctness";
    readonly status?: "completed" | "refused";
    readonly axisKey?: string;
    readonly report?: string;
    readonly empty?: boolean;
    readonly includeSkillExpansion?: boolean;
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
  if (options?.includeSkillExpansion) {
    const material = await loadPackagedMethodSkillMaterial(packageRoot, "ak-cross-m-review");
    const skillPath = resolvePackagedMethodSkillPath(packageRoot, "ak-cross-m-review");
    lines.push(JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{
          type: "text",
          text: `<skill name="ak-cross-m-review" location="${skillPath}">\n${material.body}\n</skill>`,
        }],
      },
    }));
  }
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
      assert.equal(args.includes("--skill"), true);
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
    await assert.rejects(
      () => access(join(
        home, ".ak-roles", "books", bookKey, "unbound", "runs",
        "run-cli-reviewer-blank-ok@reviewer", "admitted-request.json",
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
          includeSkillExpansion: true,
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
    const refusedReport = JSON.parse(
      await readFile(
        join(
          home, ".ak-roles", "books", bookKey, "unbound", "runs",
          "run-cli-reviewer-hard-stop@reviewer", "artifacts", "report.json",
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
  });
});

test("explicit single-lens projects admitted lens and optional caller provenance", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    await seedGitProjectWithIgnoredDeps(project);
    const worktreeListBefore = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });

    let captured: string[] | undefined;
    let capturedStdin: string | undefined;
    let turnCwd: string | undefined;
    const { io, stdout } = captureIo();
    const result = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", project, "--base", "HEAD~1", "--lens", "correctness",
      "--authority-ref", "CLAUDE.md",
      "--authority-ref", "docs/adr/0001-roles-grow-by-demand.md",
      "Review the latest commit on both axes.",
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
        // Explicit --lens also runs in a fresh copy (#946 统一新副本).
        assert.notEqual(realpathSync(options.cwd), realpathSync(project));
        // #983: provisioned ignored deps let in-repo focused tests resolve.
        assertFocusedTestResolvesInSandbox(options.cwd);
        // Deliberate receipt/lens mismatch must still land (仓级第 0 条).
        return lawfulChildTurn(args, {
          lens: "completeness",
          includeSkillExpansion: true,
          toolCallId: "ok1",
        });
      }),
    });

    assert.equal(result.exitCode, 0, stdout.join("") || "reviewer failed");
    assert.equal(typeof turnCwd, "string");
    assert.equal(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: project,
        encoding: "utf8",
      }),
      worktreeListBefore,
    );
    assert.equal(captured!.includes("--ak-review-task"), false);
    assert.equal(captured![captured!.indexOf("--ak-review-lens") + 1], "correctness");
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
          home, ".ak-roles", "books", bookKey, "unbound", "runs",
          "run-cli-reviewer-ok@reviewer", "artifacts", "evidence.json",
        ),
        "utf8",
      ),
    ) as { callerProvenance?: string };
    assert.equal(evidence.callerProvenance, "Review the latest commit on both axes.");
  });
});

test("default dual-lens final seal fails closed when HEAD drifts during the batch", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });

    const wrapperRoot = await mkdtemp(join(home, "git-seal-wrapper-"));
    const wrapper = join(wrapperRoot, "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const sealCwd = realpathSync(project);
    await writeFile(wrapper, `#!/bin/sh
count_file='${join(wrapperRoot, "count")}'
marker='${join(wrapperRoot, "committed")}'
count=0
[ -f "$count_file" ] && count=$(cat "$count_file")
if [ "$1 $2 $3" = "rev-parse --verify HEAD^{commit}" ]; then
  count=$((count + 1)); printf '%s' "$count" > "$count_file"
fi
if [ "$1" = "status" ] && [ "$count" = "2" ] && [ "$PWD" = "${sealCwd}" ] && [ ! -f "$marker" ]; then
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
        "reviewer", "--model", "test/caller-seat:high",
        "--project", project, "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
      ], {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-cli-reviewer-final-seal",
        io,
        roleTurnHost: reviewerHost(async (args) => lawfulChildTurn(args)),
      });
      assert.equal(sealed.exitCode, 1, stdout.join(""));
      assert.equal(sealed.terminal?.roleOutcome.kind, "failure");
      assert.equal(
        sealed.terminal?.roleOutcome.kind === "failure"
          ? sealed.terminal.roleOutcome.decisiveFacts.failedChildren
          : undefined,
        0,
      );
      assert.equal(sealed.terminal?.reviewerChildren?.completeness?.roleOutcome.kind, "accepted");
      assert.equal(sealed.terminal?.reviewerChildren?.correctness?.roleOutcome.kind, "accepted");
      assert.equal(sealed.terminal?.reviewerChildOutcomes?.completeness.exitCode, 1);
      assert.equal(sealed.terminal?.reviewerChildOutcomes?.correctness.exitCode, 1);
      assert.equal(
        sealed.terminal?.roleOutcome.kind === "failure"
          && typeof sealed.terminal.roleOutcome.diagnostic === "string"
          && sealed.terminal.roleOutcome.diagnostic.length > 0,
        true,
      );
    } finally {
      process.env.PATH = priorPath;
    }
  });
});

test("default dual-lens pre-dispatch failures keep dual-child surface without child turns", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target"], { cwd: project });

    // Dirty target must hard-stop before clean detached copies hide dirt.
    await writeFile(join(project, "untracked-review-evidence.txt"), "dirty\n", "utf8");
    {
      let childTurns = 0;
      const { io, stdout } = captureIo();
      const dirty = await runAkRole([
        "reviewer", "--model", "test/caller-seat:high",
        "--project", project, "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
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
    await rm(join(project, "untracked-review-evidence.txt"));

    // Missing base keeps the same dual-child structured surface.
    {
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
    persisted.authorityRefs = ["", "The system SHALL launch two workers"];
    await writeFile(
      admitted.admittedRequestPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(
      () => loadResumableReviewerRun(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    persisted.authorityRefs = ["https://example.com/durable-ref"];
    persisted.lens = "all";
    await writeFile(
      admitted.admittedRequestPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadResumableReviewerRun(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    persisted.lens = "correctness";
    persisted.baseRevision = "";
    await writeFile(
      admitted.admittedRequestPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadResumableReviewerRun(home, admitted.runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
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
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );
  });
});

test("ak-role resume continues reviewer with fixed base and package skill", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    await seedGitProjectWithIgnoredDeps(project);
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
        roleTurnHost: reviewerHost(async (args, options) => {
          // First turn also sandboxed; deps must resolve before the 429 (#983).
          assertFocusedTestResolvesInSandbox(options.cwd);
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          await observeTyped429ViaProductionHandler({
            runDirectory: join(sessionDir, ".."),
            provider: "xai",
          });
          return { code: 1, stderr: "quota", timedOut: false, args: [...args] };
        }),
      });
      assert.ok(first.terminal?.resume, "reviewer 429 must be resumable");
      assert.equal(first.terminal?.roleOutcome.role, "reviewer");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home, ".ak-roles", "books", bookKey, "unbound", "runs", `${runId}@reviewer`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const admitted = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as Record<string, unknown> & {
      role: string;
      baseRevision?: string;
      lens?: string;
      projectRoot?: string;
    };
    assert.equal(admitted.role, "reviewer");
    assert.equal(admitted.baseRevision, "main");
    assert.equal(admitted.lens, "correctness");
    assert.equal(realpathSync(String(admitted.projectRoot)), realpathSync(project));

    const worktreeListBefore = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });
    const { io, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    let resumeStdin: string | undefined;
    let resumeCwd: string | undefined;
    const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId], {
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
        assert.equal(args.includes("--skill"), true);
        assert.equal(args.includes(instruction), false);
        const resumeDialogue = readUserDialogueStdin(resumeStdin ?? "");
        const { RESUME_TRANSPORT_ENVELOPE } = await import("../../src/public-cli/run-lifecycle.ts");
        assert.equal(resumeDialogue, RESUME_TRANSPORT_ENVELOPE);
        assert.equal(resumeDialogue.includes("/skill:"), false);
        assert.equal(resumeDialogue.includes(instruction), false);
        assert.equal(args[args.indexOf("--session-dir") + 1], sessionDirectory);
        // Resume runs in a fresh copy of the source tree at resume time (#946 10a).
        assert.notEqual(realpathSync(options.cwd), realpathSync(project));
        // #983: resume path shares the same provisioned-deps capability.
        assertFocusedTestResolvesInSandbox(options.cwd);
        resumeCwd = options.cwd;
        return lawfulChildTurn(args, {
          lens: "correctness",
          includeSkillExpansion: true,
          toolCallId: "rr1",
        });
      }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "reviewer resume failed");
    assert.equal(typeof resumeCwd, "string");
    // Fresh copy is gone after resume returns.
    assert.equal(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: project,
        encoding: "utf8",
      }),
      worktreeListBefore,
    );
    assert.equal(Array.isArray(resumeArgs), true);
    assert.deepEqual(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(resumed.terminal.roleOutcome)
        : [],
      ["completed"],
    );
    assert.equal(
      (await readRoleRunState(runDirectory, piDurablePrincipalAuthority))?.state,
      "terminal",
    );
  });
});

test("default dual-lens from subdirectory admits caller project and deletes ephemeral worktrees", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    // Two commits (empty seed + probe) so HEAD~1 is valid; ignored deps for #983.
    await seedGitProjectWithIgnoredDeps(project);
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
    const worktreeListBefore = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });

    const { io, stdout } = captureIo();
    const batch = await runAkRole([
      "reviewer", "--model", "test/caller-seat:high",
      "--project", subdir, "--base", "HEAD~1", "--authority-ref", "CLAUDE.md",
    ], {
      packageRoot,
      home,
      cwd: subdir,
      credentials: { "openai-codex": true, xai: true },
      reviewerTimeoutMs: 17_777,
      io,
      roleTurnHost: reviewerHost(async (args, options) => {
        assert.equal(options.timeoutMs, 17_777);
        assert.equal(options.cwd.endsWith(join("nested", "leaf")), true);
        assert.notEqual(realpathSync(options.cwd), callerProjectRoot);
        // #983: dual-lens child sandboxes share the same deps provision.
        assertFocusedTestResolvesInSandbox(options.cwd);
        if (args.includes("--provider")) {
          capturedProviders.push(args[args.indexOf("--provider") + 1]!);
        }
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
        await observeTyped429ViaProductionHandler({
          runDirectory: join(sessionDir, ".."),
          provider: "xai",
        });
        return { code: 1, stderr: "quota", timedOut: false, args: [...args] };
      }),
    });

    assert.equal(batch.exitCode, 1, stdout.join(""));
    const completenessResume = batch.terminal?.reviewerChildren?.completeness?.resume?.command;
    const correctnessResume = batch.terminal?.reviewerChildren?.correctness?.resume?.command;
    assert.equal(typeof completenessResume, "string");
    assert.equal(typeof correctnessResume, "string");
    const completenessRunId = completenessResume!.slice("ak-role resume ".length);
    const correctnessRunId = correctnessResume!.slice("ak-role resume ".length);
    assert.notEqual(completenessRunId, correctnessRunId);
    assert.equal(capturedProviders.length >= 2, true);
    for (const provider of capturedProviders) assert.equal(provider, "test-mapped");

    // Ephemeral worktrees are gone after the batch even when children are resumable.
    const worktreeListAfter = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });
    assert.equal(worktreeListAfter, worktreeListBefore);

    // Durable identity matches the caller project (10a); one durable page is enough.
    const bookKey = resolveBookKeyFromGit(project);
    const admitted = JSON.parse(
      await readFile(
        join(
          home, ".ak-roles", "books", bookKey, "unbound", "runs",
          `${completenessRunId}@reviewer`, "admitted-request.json",
        ),
        "utf8",
      ),
    ) as { projectRoot: string; baseRevision: string; lens: string };
    assert.equal(realpathSync(admitted.projectRoot), callerProjectRoot);
    assert.equal(admitted.baseRevision, "HEAD~1");
    assert.equal(admitted.lens, "completeness");

    // Resume: fresh copy of source tree at resume time; old batch worktree not required (#946 10a).
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
          // Sandbox keeps the caller subdirectory layout under a new worktree root.
          assert.equal(options.cwd.endsWith(join("nested", "leaf")), true);
          assert.notEqual(realpathSync(options.cwd), callerProjectRoot);
          assertFocusedTestResolvesInSandbox(options.cwd);
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
    // Resume sandbox is deleted after the call; no ownership residue.
    const worktreeListAfterResume = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });
    assert.equal(worktreeListAfterResume, worktreeListBefore);
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
          assert.notEqual(realpathSync(options.cwd), expectedProjectRoot);
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          await observeTyped429ViaProductionHandler({
            runDirectory: join(sessionDir, ".."),
            provider: "xai",
          });
          return { code: 1, stderr: "quota", timedOut: false, args: [...args] };
        }),
      });
      assert.equal(batch.exitCode, 1, batchStdout.join(""));
      const completenessResume = batch.terminal?.reviewerChildren?.completeness?.resume?.command;
      assert.equal(typeof completenessResume, "string");
      const bookKey = resolveBookKeyFromGit(project);
      const admitted = JSON.parse(
        await readFile(
          join(
            home, ".ak-roles", "books", bookKey, "unbound", "runs",
            `${completenessResume!.slice("ak-role resume ".length)}@reviewer`,
            "admitted-request.json",
          ),
          "utf8",
        ),
      ) as { projectRoot: string; baseRevision: string };
      assert.equal(realpathSync(admitted.projectRoot), expectedProjectRoot);
      assert.equal(admitted.baseRevision, "HEAD~1");
    });

    // Inline --base=value must fail closed before minting worktrees.
    const worktreeListBefore = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });
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
        throw new Error("child turn must not start when base precheck fails");
      }),
    });
    assert.equal(bad.exitCode, 1, badStdout.join(""));
    const worktreeListAfter = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });
    assert.equal(worktreeListAfter, worktreeListBefore);
  });
});
