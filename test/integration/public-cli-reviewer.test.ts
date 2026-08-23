/**
 * #111 / #236 public Reviewer path — fixed base + package code-review only.
 * Caller instruction is optional provenance, never semantic control.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
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
  buildReviewerActivationExtraArgs,
  buildReviewerResumeActivationExtraArgs,
} from "../../src/public-cli/reviewer-run.ts";
import {
  loadResumableReviewerRun,
  markRunAdmitted,
  markRunResumable,
  RESUME_TRANSPORT_ENVELOPE,
} from "../../src/public-cli/run-lifecycle.ts";
import {
  extractReviewerMethodInvocations,
  extractReviewerRoleOutcome,
  formatTerminalResult,
  settleReviewerTerminalResult,
} from "../../src/public-cli/settlement.ts";
import {
  packageRoot,
  runPiSubprocess,
} from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-reviewer-"));
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
  execFileSync("git", ["config", "user.email", "reviewer@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Reviewer Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function lawfulReviewerReceipt(
  axes: readonly ("standards" | "spec")[] = ["standards", "spec"],
  status: "completed" | "refused" = "completed",
) {
  const skillText = "package code-review skill body\n";
  const prompt = (axis: string) => ({ text: `${axis} prompt\n` });
  const reports = Object.fromEntries(
    axes.map((axis) => [axis, { text: `${axis} report` }]),
  );
  const outcomes = Object.fromEntries(
    axes.map((axis) => [
      axis,
      {
        status: "successful",
        prompt: prompt(axis),
        workspaceDisposition: "deleted",
      },
    ]),
  );
  return {
    version: 2 as const,
    status,
    ...(status === "refused" ? { diagnostic: "review cannot proceed" } : {}),
    acceptedBatch: {
      identity: "dispatch",
      legs: axes.map((axis) => ({ axis, prompt: prompt(axis) })),
    },
    reports,
    outcomes,
    identities: {
      canonicalSkill: { text: skillText },
      construction: { recipe: "reviewer-common-bundle-v1" },
      target: {
        repositoryRoot: "/repo",
        objectFormat: "sha1",
        targetHead: "a".repeat(40),
        refs: {
          tag: { objectId: "b".repeat(40), peeledCommitId: null },
        },
      },
    },
  };
}


async function admitReviewerInvocation(
  options: Parameters<typeof admitReviewerInvocationRaw>[0],
): ReturnType<typeof admitReviewerInvocationRaw> {
  return admitReviewerInvocationRaw(options);
}


test("parseReviewerArgv requires base and accepts optional provenance instruction", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.throws(
    () => parseReviewerArgv(["Review the branch since main."]),
    (error: unknown) => error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
  );
  assert.deepEqual(
    parseReviewerArgv([
      "--base",
      "main",
      "--project",
      "/tmp/p",
      "Review since the base.",
    ]),
    {
      instruction: "Review since the base.",
      attachmentPaths: [],
      baseRevision: "main",
      authorityRefs: [],
      project: "/tmp/p",
    },
  );
  assert.deepEqual(parseReviewerArgv(["--base", "HEAD~1"]), {
    instruction: "",
    attachmentPaths: [],
    baseRevision: "HEAD~1",
    authorityRefs: [],
  });
  assert.deepEqual(
    parseReviewerArgv([
      "--base",
      "main",
      "--authority-ref",
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
      "--authority-ref=https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      "Scope the review to the owner decision.",
    ]),
    {
      instruction: "Scope the review to the owner decision.",
      attachmentPaths: [],
      baseRevision: "main",
      authorityRefs: [
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      ],
    },
  );
  assert.throws(() => parseReviewerArgv(["--unknown-flag"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--base", "", "task"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--project", "", "task"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--attach", "spec.md", "task"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--attach=spec.md", "task"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--base", "main", "--authority-ref", ""]), isUsage);
  assert.throws(() => parseReviewerArgv(["--base", "main", "--authority-ref="]), isUsage);
  // refs-only: representative inline Spec prose is rejected at the public admission seam.
  assert.throws(
    () =>
      parseReviewerArgv([
        "--base",
        "main",
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
        "--authority-ref",
        "Requirements:\n1. Launch two workers\n2. Report cardinality honestly",
      ]),
    isUsage,
  );
  // Durable public reference forms remain accepted with bytes unchanged.
  assert.deepEqual(
    parseReviewerArgv([
      "--base",
      "main",
      "--authority-ref",
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      "--authority-ref",
      "docs/adr/0063-received-prompt-is-audit-evidence-not-authority.md",
      "--authority-ref",
      "git@github.com:Akagilnc/ak-pi-workflow-roles.git",
    ]).authorityRefs,
    [
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      "docs/adr/0063-received-prompt-is-audit-evidence-not-authority.md",
      "git@github.com:Akagilnc/ak-pi-workflow-roles.git",
    ],
  );
});

test("admitReviewerInvocation persists fixed base; caller text is provenance only", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const blank = await admitReviewerInvocation({
      home,
      cwd: project,
      instruction: "   ",
      attachmentPaths: [],
      baseRevision: "origin/main",
      createRunId: () => "run-reviewer-blank",
    });
    assert.equal(blank.instructionEmpty, true);
    assert.equal(blank.baseRevision, "origin/main");
    assert.deepEqual(blank.authorityRefs, []);
    assert.equal("taskPath" in blank, false);
    await assert.rejects(
      () => access(join(blank.runDirectory, "task.md")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    const admitted = await admitReviewerInvocation({
      home,
      cwd: project,
      instruction: "Review the work since the base revision.",
      attachmentPaths: [],
      baseRevision: "origin/main",
      createRunId: () => "run-reviewer-admit-001",
    });
    assert.equal(admitted.role, "reviewer");
    assert.equal(admitted.instruction, "Review the work since the base revision.");
    assert.equal(admitted.instructionEmpty, false);
    assert.equal(admitted.baseRevision, "origin/main");
    assert.deepEqual(admitted.authorityRefs, []);
    assert.equal("taskPath" in admitted, false);
    await assert.rejects(
      () => access(join(admitted.runDirectory, "task.md")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    const withRefs = await admitReviewerInvocation({
      home,
      cwd: project,
      instruction: "Scope only; refs carry authority.",
      attachmentPaths: [],
      baseRevision: "origin/main",
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
    await assert.rejects(
      () =>
        admitReviewerInvocation({
          home,
          cwd: project,
          instruction: "",
          attachmentPaths: [],
          baseRevision: "origin/main",
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
        "runs",
        "run-reviewer-admit-001@reviewer",
      ),
    );
    const persisted = JSON.parse(
      await readFile(admitted.admittedRequestPath, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(persisted.role, "reviewer");
    assert.equal(persisted.baseRevision, "origin/main");
    assert.equal(persisted.instruction, "Review the work since the base revision.");
    assert.deepEqual(persisted.authorityRefs, []);
    assert.equal("taskPath" in persisted, false);
    assert.equal("taskSha256" in persisted, false);
    const persistedRefs = JSON.parse(
      await readFile(withRefs.admittedRequestPath, "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(persistedRefs.authorityRefs, [
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
      "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
    ]);
  });
});

test("buildReviewerActivationExtraArgs forces package code-review and fixed base only", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const admitted = await admitReviewerInvocation({
      home,
      cwd: project,
      instruction: "Review since HEAD~1.",
      attachmentPaths: [],
      baseRevision: "HEAD~1",
      createRunId: () => "run-reviewer-args",
    });
    const args = buildReviewerActivationExtraArgs(admitted, { packageRoot });
    assert.equal(args.includes("--no-skills"), true);
    assert.equal(args.includes("--skill"), true);
    assert.equal(args.includes("--ak-role"), true);
    assert.equal(args[args.indexOf("--ak-role") + 1], "reviewer");
    assert.equal(args.includes("--ak-review-task"), false);
    assert.equal(args[args.indexOf("--ak-review-base") + 1], "HEAD~1");
    assert.equal(args.includes("--ak-review-authority-refs"), false);
    assert.equal(args.includes("--ak-review-ticket-number"), false);
    assert.equal(
      args.some((a) => a.includes("Base revision for the fixed review target: HEAD~1")),
      true,
    );

    const admittedWithRefs = await admitReviewerInvocation({
      home,
      cwd: project,
      instruction: "Scope the review.",
      attachmentPaths: [],
      baseRevision: "HEAD~1",
      authorityRefs: [
        "https://example.com/a",
        "https://example.com/b,with-comma",
      ],
      createRunId: () => "run-reviewer-args-refs",
    });
    const argsWithRefs = buildReviewerActivationExtraArgs(admittedWithRefs, { packageRoot });
    assert.equal(
      argsWithRefs[argsWithRefs.indexOf("--ak-review-authority-refs") + 1],
      JSON.stringify([
        "https://example.com/a",
        "https://example.com/b,with-comma",
      ]),
    );
    const resumeWithRefs = buildReviewerResumeActivationExtraArgs(admittedWithRefs, {
      packageRoot,
    });
    assert.equal(
      resumeWithRefs[resumeWithRefs.indexOf("--ak-review-authority-refs") + 1],
      JSON.stringify([
        "https://example.com/a",
        "https://example.com/b,with-comma",
      ]),
    );
    assert.equal(args.some((a) => a.includes(admitted.instruction)), false);
    assert.equal(args.some((a) => a.includes(".agents/skills")), false);

    const resume = buildReviewerResumeActivationExtraArgs(admitted, {
      packageRoot,
    });
    assert.equal(resume.includes("--skill"), true);
    assert.equal(resume.includes(RESUME_TRANSPORT_ENVELOPE), true);
    assert.equal(resume.includes("--ak-review-task"), false);
    assert.equal(resume.includes(admitted.instruction), false);
    assert.equal(resume[resume.indexOf("--ak-review-base") + 1], "HEAD~1");

    // Typed ticketNumber (attachment frontmatter / admitted page) transports for Spec self-fetch.
    const ticketFile = join(home, "ticket-343.md");
    await writeFile(
      ticketFile,
      ["---", "ticketNumber: 343", "---", "# ticket body", ""].join("\n"),
      "utf8",
    );
    const admittedWithTicket = await admitReviewerInvocation({
      home,
      cwd: project,
      instruction: "Scope only.",
      attachmentPaths: [ticketFile],
      baseRevision: "HEAD~1",
      createRunId: () => "run-reviewer-args-ticket",
    });
    assert.equal(admittedWithTicket.ticketNumber, 343);
    const argsWithTicket = buildReviewerActivationExtraArgs(admittedWithTicket, {
      packageRoot,
    });
    assert.equal(
      argsWithTicket[argsWithTicket.indexOf("--ak-review-ticket-number") + 1],
      "343",
    );
    const resumeWithTicket = buildReviewerResumeActivationExtraArgs(admittedWithTicket, {
      packageRoot,
    });
    assert.equal(
      resumeWithTicket[resumeWithTicket.indexOf("--ak-review-ticket-number") + 1],
      "343",
    );
  });
});

test("lawful reviewer Terminal records method provenance and typed expansion evidence", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const admitted = await admitReviewerInvocation({
      home,
      cwd: project,
      instruction: "Review standards and spec axes.",
      attachmentPaths: [],
      baseRevision: "main",
      // 尺③：非空 authorityRefs 落 evidence artifact 的契约在此承接（原冷装
      // refs-only e2e 的独有断言，#420 类一收拢后由这条在进程内真 Terminal 承载）。
      authorityRefs: [
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      ],
      createRunId: () => "run-reviewer-settle-001",
    });
    await mkdir(admitted.sessionDirectory, { recursive: true });
    const material = await loadPackagedMethodSkillMaterial(
      packageRoot,
      "code-review",
    );
    const skillPath = resolvePackagedMethodSkillPath(packageRoot, "code-review");
    const receipt = {
      ...lawfulReviewerReceipt(["standards", "spec"]),
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
    const expansion = `<skill name="code-review" location="${material.skillPath}">\n${material.body}\n</skill>\n\nBase revision for the fixed review target: main\nUse this exact revision as the fixed review point.`;
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
      admitted.sessionFile,
      `${sessionLines.join("\n")}\n`,
      "utf8",
    );

    const entries = sessionLines.map((line) => JSON.parse(line));
    const extracted = extractReviewerRoleOutcome(entries);
    assert.equal(extracted?.outcome.role, "reviewer");
    assert.equal(extracted?.outcome.kind, "accepted");
    assert.equal(extracted?.outcome.status, "completed");
    assert.deepEqual(extracted?.outcome.decisiveFacts.axes, ["standards", "spec"]);
    assert.deepEqual(extracted?.outcome.decisiveFacts.reportAxes, ["standards", "spec"]);
    assert.equal((extracted?.outcome.decisiveFacts.auditNoReceipt as { acceptedReceipt?: unknown })?.acceptedReceipt, false);
    assert.equal((extracted?.outcome.decisiveFacts.auditNoReceipt as { rejectedReceipts?: Array<{ diagnosticAvailable?: unknown }> })
      ?.rejectedReceipts?.[0]?.diagnosticAvailable, false);

    const invocations = extractReviewerMethodInvocations(entries, {
      allowedLocations: [material.skillPath, skillPath],
    });
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]?.name, "code-review");
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
                text: `<skill name="code-review" location="${join(home, ".agents/skills/code-review/SKILL.md")}">\nbody\n</skill>\n\nreq`,
              },
            ],
          },
        },
      ],
      { allowedLocations: [material.skillPath, skillPath] },
    );
    assert.equal(ambient.length, 0);

    const terminal = await settleReviewerTerminalResult(admitted, {
      methodProvenance: material.provenance,
      methodSkillPath: material.skillPath,
      methodSkillConfiguredPath: skillPath,
    });
    assert.equal(terminal.roleOutcome.role, "reviewer");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.roleOutcome.status, "completed");
    assert.equal((terminal.roleOutcome.decisiveFacts.auditNoReceipt as { acceptedReceipt?: unknown })?.acceptedReceipt, false);
    assert.match(formatTerminalResult(terminal), /auditNoReceipt/);
    assert.equal(terminal.runId, "run-reviewer-settle-001");
    assert.equal(terminal.artifacts.some((a) => a.kind === "report"), true);
    assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);
    const reviewerReportBody = await readFile(
      terminal.artifacts.find((a) => a.kind === "report")!.path,
      "utf8",
    );
    assert.ok(
      reviewerReportBody.includes("standards report"),
      "reviewer standards report text must live in artifact receipt",
    );

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
    assert.equal(evidence.callerProvenance, "Review standards and spec axes.");
    assert.equal(evidence.methodProvenance.name, "code-review");
    assert.equal(
      evidence.methodProvenance.packageAdaptation,
      "reviewer-no-setup-fixed-target-two-axis",
    );
    assert.equal(evidence.methodInvocationObserved, true);
    assert.equal(evidence.methodInvocations.length, 1);
    const evidenceText = JSON.stringify(evidence);
    assert.equal(evidenceText.includes(".agents/skills"), false);
  });
});

test("package code-review method stays usable without Matt setup and forbids governance setup", async () => {
  const material = await loadPackagedMethodSkillMaterial(packageRoot, "code-review");
  assert.equal(material.name, "code-review");
  assert.equal(
    material.provenance.packageAdaptation,
    "reviewer-no-setup-fixed-target-two-axis",
  );
  assert.match(material.body, /Standards/);
  assert.match(material.body, /Spec/);
  assert.equal(material.body.includes("/setup-matt-pocock-skills"), true);
  assert.equal(material.body.includes("Do **not** run `/setup-matt-pocock-skills`"), true);
  assert.equal(material.body.includes("docs/agents/issue-tracker.md"), true);
  assert.equal(material.body.includes("must **not** modify project governance"), true);
  assert.equal(material.body.includes("scratch probes"), true);
  assert.equal(material.body.includes("never turn the review into product repairs"), true);
  assert.equal(material.skillPath.includes(packageRoot), true);
  assert.equal(material.skillPath.includes(".agents/skills"), false);
});

test("ak-role reviewer admits fixed base without requiring caller task", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    {
      const { io, stdout } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole(
        [
          "reviewer",
          "--project",
          project,
          "--base",
          "HEAD~1",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-reviewer-blank-ok",
          io,
          piRunner: async (args) => {
            captured = [...args];
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const material = await loadPackagedMethodSkillMaterial(
              packageRoot,
              "code-review",
            );
            const skillPath = resolvePackagedMethodSkillPath(
              packageRoot,
              "code-review",
            );
            const expansion = `<skill name="code-review" location="${skillPath}">\n${material.body}\n</skill>\n\nBase revision for the fixed review target: HEAD~1\nUse this exact revision as the fixed review point.`;
            const receipt = lawfulReviewerReceipt(["standards", "spec"]);
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
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
        },
      );
      assert.equal(result.exitCode, 0, stdout.join("") || "reviewer failed");
      assert.equal(Array.isArray(captured), true);
      assert.equal(captured![captured!.indexOf("--ak-role") + 1], "reviewer");
      assert.equal(captured!.includes("--skill"), true);
      assert.equal(captured!.includes("--ak-review-task"), false);
      assert.equal(result.terminal?.roleOutcome.role, "reviewer");
      assert.equal(
        result.terminal?.roleOutcome.kind === "accepted"
          ? result.terminal.roleOutcome.status
          : undefined,
        "completed",
      );

      const bookKey = resolveBookKeyFromGit(project);
      const runDirectory = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-cli-reviewer-blank-ok@reviewer",
      );
      await access(join(runDirectory, "admitted-request.json"));
      await assert.rejects(
        () => access(join(runDirectory, "task.md")),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      const projectEntries = await readdir(project);
      assert.equal(projectEntries.includes("docs"), false);
      assert.equal(projectEntries.includes(".agents"), false);
      const evidence = JSON.parse(
        await readFile(join(runDirectory, "artifacts", "evidence.json"), "utf8"),
      ) as {
        methodInvocationObserved: boolean;
        methodProvenance: { name: string };
        callerProvenance?: string;
      };
      assert.equal(evidence.methodProvenance.name, "code-review");
      assert.equal(evidence.methodInvocationObserved, true);
      assert.equal("callerProvenance" in evidence, false);
    }

    {
      const { io, stdout } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole(
        [
          "reviewer",
          "--project",
          project,
          "--base",
          "HEAD~1",
          "Review the latest commit on both axes.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-reviewer-ok",
          io,
          piRunner: async (args) => {
            captured = [...args];
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const material = await loadPackagedMethodSkillMaterial(
              packageRoot,
              "code-review",
            );
            const skillPath = resolvePackagedMethodSkillPath(
              packageRoot,
              "code-review",
            );
            const expansion = `<skill name="code-review" location="${skillPath}">\n${material.body}\n</skill>\n\nBase revision for the fixed review target: HEAD~1\nUse this exact revision as the fixed review point.`;
            const receipt = lawfulReviewerReceipt(["standards", "spec"]);
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
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
        },
      );
      assert.equal(result.exitCode, 0, stdout.join("") || "reviewer failed");
      assert.equal(captured!.includes("--ak-review-task"), false);
      assert.equal(
        captured!.some((a) => a.includes("Review the latest commit on both axes.")),
        false,
      );
      const bookKey = resolveBookKeyFromGit(project);
      const evidence = JSON.parse(
        await readFile(
          join(
            home,
            ".ak-roles",
            "books",
            bookKey,
            "runs",
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
  });
});

test("resume rejects blank/inline authorityRefs via unique --authority-ref grammar", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const admitted = await admitReviewerInvocationRaw({
      home,
      cwd: project,
      instruction: "Scope only",
      attachmentPaths: [],
      baseRevision: "main",
      authorityRefs: ["https://example.com/durable-ref"],
      createRunId: () => "run-cli-reviewer-resume-bad-refs",
    });
    // Durable session principal required before resume load.
    await mkdir(admitted.sessionDirectory, { recursive: true });
    await writeFile(join(admitted.sessionDirectory, "session.jsonl"), "", "utf8");
    await markRunAdmitted(admitted);
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
      () => loadResumableReviewerRun(home, admitted.runId),
      (error: unknown) =>
        error instanceof CliUsageError &&
        error.code === "AK_ROLE_USAGE" &&
        (/nonempty durable reference|not inline Spec prose/i.test(error.message)),
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
      const first = await runAkRole(
        ["reviewer", "--project", project, "--base", "main", instruction],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          io,
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
      "runs",
      `${runId}@reviewer`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const admitted = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as Record<string, unknown> & { role: string; baseRevision?: string; ticketNumber?: number };
    assert.equal(admitted.role, "reviewer");
    assert.equal(admitted.baseRevision, "main");
    assert.equal(admitted.ticketNumber, undefined);
    assert.equal("taskPath" in admitted, false);
    assert.equal("taskSha256" in admitted, false);

    const { io, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    const resumed = await runAkRole(["resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      piRunner: async (args) => {
        resumeArgs = [...args];
        assert.equal(args[args.indexOf("--ak-role") + 1], "reviewer");
        assert.equal(args.includes("--ak-review-task"), false);
        assert.equal(args[args.indexOf("--ak-review-base") + 1], admitted.baseRevision);
        assert.equal(args.includes("--skill"), true);
        assert.equal(args.includes(instruction), false);
        assert.equal(args.includes(RESUME_TRANSPORT_ENVELOPE), true);
        assert.equal(args[args.indexOf("--session-dir") + 1], sessionDirectory);
        const material = await loadPackagedMethodSkillMaterial(
          packageRoot,
          "code-review",
        );
        const skillPath = resolvePackagedMethodSkillPath(
          packageRoot,
          "code-review",
        );
        const expansion = `<skill name="code-review" location="${skillPath}">\n${material.body}\n</skill>\n\nBase revision for the fixed review target: main\nUse this exact revision as the fixed review point.`;
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
              details: lawfulReviewerReceipt(["standards"]),
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "reviewer resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumed.terminal?.roleOutcome.role, "reviewer");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? resumed.terminal.roleOutcome.status
        : undefined,
      "completed",
    );
  });
});

