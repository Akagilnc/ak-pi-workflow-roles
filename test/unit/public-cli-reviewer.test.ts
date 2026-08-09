/**
 * #111 public Reviewer path — common Invocation, optional base, adapter-derived
 * capabilities, package code-review provenance + typed expansion evidence.
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
import { REVIEWER_CHILD_TOOLS, REVIEWER_PREREQUISITES } from "../../src/reviewer-admission.ts";
import { compileMechanicalBundle, projectMechanicalBundleIdentity } from "../../src/reviewer-construction.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitReviewerInvocation,
  composeReviewerTaskText,
  deriveReviewerCapabilitiesFromTask,
  parseReviewerArgv,
} from "../../src/public-cli/invocation.ts";
import {
  buildReviewerActivationExtraArgs,
  buildReviewerResumeActivationExtraArgs,
} from "../../src/public-cli/reviewer-run.ts";
import { RESUME_TRANSPORT_ENVELOPE } from "../../src/public-cli/run-lifecycle.ts";
import {
  extractReviewerMethodInvocations,
  extractReviewerRoleOutcome,
  settleReviewerTerminalResult,
} from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import { sha256Hex } from "../../src/sha256.ts";

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
  const bundle = compileMechanicalBundle({
    canonicalSkill: skillText,
    task: "task",
    range: {
      base: "a",
      target: "b",
      diffCommand: "git diff a...b",
      diffSha256: "1".repeat(64),
      commits: ["b"],
    },
    materials: [],
  }).bundle;
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
        runtimeConstructionEvidence: {
          leg: axis,
          workspaceIdentity: `${axis}-workspace`,
          manifestSha256: bundle.manifestSha256,
          entries: bundle.entries.map(
            ({ id, relativeClonePath, utf8Length, sha256 }) => ({
              id,
              relativeClonePath,
              utf8Length,
              sha256,
              verified: true,
              readable: true,
            }),
          ),
        },
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
      construction: { recipe: "reviewer-common-bundle-v1", bundle: projectMechanicalBundleIdentity(bundle) },
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

test("parseReviewerArgv accepts common flags and optional base revision", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.deepEqual(parseReviewerArgv(["Review the branch since main."]), {
    instruction: "Review the branch since main.",
    attachmentPaths: [],
  });
  assert.deepEqual(
    parseReviewerArgv([
      "--base",
      "main",
      "--attach",
      "spec.md",
      "--project",
      "/tmp/p",
      "Review since the base.",
    ]),
    {
      instruction: "Review since the base.",
      attachmentPaths: ["spec.md"],
      baseRevision: "main",
      project: "/tmp/p",
    },
  );
  assert.throws(() => parseReviewerArgv(["--unknown-flag"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--base", "", "task"]), isUsage);
  assert.throws(() => parseReviewerArgv(["--project", "", "task"]), isUsage);
  // Capability packets are not a public surface.
  assert.throws(() => parseReviewerArgv(["--capabilities", "c.json", "task"]), isUsage);
});

test("admitReviewerInvocation derives task-bound capabilities and freezes attachments", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    await assert.rejects(
      () =>
        admitReviewerInvocation({
          home,
          cwd: project,
          instruction: "   ",
          attachmentPaths: [],
        }),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    const source = join(home, "issue.md");
    await writeFile(source, "originating-spec-v1", "utf8");
    const admitted = await admitReviewerInvocation({
      home,
      cwd: project,
      instruction: "Review the work since the base revision.",
      attachmentPaths: [source],
      baseRevision: "origin/main",
      createRunId: () => "run-reviewer-admit-001",
    });
    assert.equal(admitted.role, "reviewer");
    assert.equal(admitted.instruction, "Review the work since the base revision.");
    assert.equal(admitted.baseRevision, "origin/main");
    assert.equal(admitted.attachments.length, 1);
    assert.equal(
      await readFile(admitted.attachments[0]!.frozenPath, "utf8"),
      "originating-spec-v1",
    );

    const taskText = await readFile(admitted.taskPath, "utf8");
    assert.equal(
      taskText,
      composeReviewerTaskText(
        "Review the work since the base revision.",
        "origin/main",
      ),
    );
    assert.match(taskText, /Base revision for the fixed review target: origin\/main/);

    const capabilitiesRaw = await readFile(admitted.capabilitiesPath, "utf8");
    const capabilities = JSON.parse(capabilitiesRaw) as {
      version: number;
      taskSha256: string;
      tools: string[];
      prerequisiteOperations: string[];
    };
    assert.equal(capabilities.version, 1);
    assert.equal(capabilities.taskSha256, admitted.taskSha256);
    assert.equal(
      admitted.taskSha256,
      sha256Hex(new TextEncoder().encode(taskText)),
    );
    assert.deepEqual(capabilities.tools, [...REVIEWER_CHILD_TOOLS]);
    assert.deepEqual(capabilities.prerequisiteOperations, [
      ...REVIEWER_PREREQUISITES,
    ]);
    // Derived from exact task bytes — not a caller packet.
    const derived = deriveReviewerCapabilitiesFromTask(
      new TextEncoder().encode(taskText),
    );
    assert.equal(derived.taskSha256, admitted.taskSha256);
    assert.equal(derived.text, capabilitiesRaw);

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
    ) as {
      role: string;
      capabilitiesPath: string;
      taskSha256: string;
      baseRevision?: string;
    };
    assert.equal(persisted.role, "reviewer");
    assert.equal(persisted.capabilitiesPath, admitted.capabilitiesPath);
    assert.equal(persisted.taskSha256, admitted.taskSha256);
    assert.equal(persisted.baseRevision, "origin/main");
  });
});

test("buildReviewerActivationExtraArgs forces package code-review and derived capabilities", async () => {
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
    assert.equal(args[args.indexOf("--ak-review-task") + 1], admitted.taskPath);
    assert.equal(
      args[args.indexOf("--ak-review-capabilities") + 1],
      admitted.capabilitiesPath,
    );
    assert.equal(
      args.some(
        (a) =>
          a.includes(admitted.instruction) &&
          a.includes("Admitted base revision: HEAD~1"),
      ),
      true,
    );
    // No ambient home skill path and no caller capability packet flag.
    assert.equal(args.some((a) => a.includes(".agents/skills")), false);
    assert.equal(args.includes("--capabilities"), false);

    const resume = buildReviewerResumeActivationExtraArgs(admitted, {
      packageRoot,
    });
    assert.equal(resume.includes("--skill"), true);
    assert.equal(resume.includes(RESUME_TRANSPORT_ENVELOPE), true);
    assert.equal(resume.includes(admitted.instruction), false);
    assert.equal(
      resume[resume.indexOf("--ak-review-capabilities") + 1],
      admitted.capabilitiesPath,
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
      createRunId: () => "run-reviewer-settle-001",
    });
    await mkdir(admitted.sessionDirectory, { recursive: true });
    const material = await loadPackagedMethodSkillMaterial(
      packageRoot,
      "code-review",
    );
    const skillPath = resolvePackagedMethodSkillPath(packageRoot, "code-review");
    const receipt = lawfulReviewerReceipt(["standards", "spec"]);
    const expansion = `<skill name="code-review" location="${material.skillPath}">\n${material.body}\n</skill>\n\nReview standards and spec axes.`;
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
    assert.equal(extracted?.outcome.decisiveFacts.axes, "standards,spec");
    assert.equal(extracted?.outcome.decisiveFacts.reportAxes, "standards,spec");

    const invocations = extractReviewerMethodInvocations(entries, {
      allowedLocations: [material.skillPath, skillPath],
    });
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]?.name, "code-review");
    assert.equal(invocations[0]?.location, material.skillPath);

    // Ambient home path never counts as package expansion evidence.
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
    assert.equal(terminal.runId, "run-reviewer-settle-001");
    assert.equal(terminal.artifacts.some((a) => a.kind === "report"), true);
    assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);
    // #177 S2: reviewer axis report text is legally withheld from decisiveFacts;
    // the durable receipt on the report artifact carries the full reports map.
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
    ) as {
      taskSha256: string;
      capabilitiesPath: string;
      baseRevision?: string;
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
    assert.equal(evidence.taskSha256, admitted.taskSha256);
    assert.equal(evidence.capabilitiesPath, admitted.capabilitiesPath);
    assert.equal(evidence.baseRevision, "main");
    assert.equal(evidence.methodProvenance.name, "code-review");
    assert.equal(
      evidence.methodProvenance.packageAdaptation,
      "reviewer-no-setup-fixed-target-two-axis",
    );
    assert.equal(
      evidence.methodProvenance.upstream.repository,
      "https://github.com/mattpocock/skills",
    );
    assert.equal(evidence.methodProvenance.upstream.attribution, "mattpocock/skills");
    assert.equal(
      evidence.methodProvenance.upstream.path,
      "skills/engineering/code-review",
    );
    assert.equal(
      evidence.methodProvenance.upstream.commit,
      material.provenance.upstream.commit,
    );
    assert.equal(
      evidence.methodProvenance.files["SKILL.md"]?.sha256,
      material.provenance.files["SKILL.md"]!.sha256,
    );
    assert.equal(evidence.methodInvocationObserved, true);
    assert.equal(evidence.methodInvocations.length, 1);
    assert.equal(evidence.methodInvocations[0]!.name, "code-review");
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

test("ak-role reviewer admits base/task, derives capabilities, and rejects blank task", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(["reviewer", "   "], {
        packageRoot,
        home,
        cwd: project,
        io,
        piRunner: async () => {
          throw new Error("must not dispatch");
        },
      });
      assert.equal(result.exitCode, 2);
      assert.equal(stderr.join("").length > 0, true);
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
            const expansion = `<skill name="code-review" location="${skillPath}">\n${material.body}\n</skill>\n\nReview the latest commit on both axes.`;
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
      assert.equal(result.terminal?.roleOutcome.role, "reviewer");
      assert.equal(
        result.terminal?.roleOutcome.kind === "accepted"
          ? result.terminal.roleOutcome.status
          : undefined,
        "completed",
      );
      assert.equal(
        result.terminal?.roleOutcome.kind === "accepted"
          ? result.terminal.roleOutcome.decisiveFacts.axes
          : undefined,
        "standards,spec",
      );

      const bookKey = resolveBookKeyFromGit(project);
      const runDirectory = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-cli-reviewer-ok@reviewer",
      );
      await access(join(runDirectory, "admitted-request.json"));
      await access(join(runDirectory, "task.md"));
      await access(join(runDirectory, "capabilities.json"));
      // Adapter never writes Matt setup / governance files into the project.
      const projectEntries = await readdir(project);
      assert.equal(projectEntries.includes("docs"), false);
      assert.equal(projectEntries.includes(".agents"), false);
      const evidence = JSON.parse(
        await readFile(join(runDirectory, "artifacts", "evidence.json"), "utf8"),
      ) as {
        methodInvocationObserved: boolean;
        methodProvenance: { name: string };
      };
      assert.equal(evidence.methodProvenance.name, "code-review");
      assert.equal(evidence.methodInvocationObserved, true);
    }
  });
});

test("ak-role resume continues reviewer with derived capabilities and package skill", async () => {
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
    ) as {
      role: string;
      taskPath: string;
      capabilitiesPath: string;
      taskSha256: string;
      baseRevision?: string;
    };
    assert.equal(admitted.role, "reviewer");
    assert.equal(admitted.baseRevision, "main");
    assert.equal(typeof admitted.taskSha256, "string");

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
        assert.equal(args[args.indexOf("--ak-review-task") + 1], admitted.taskPath);
        assert.equal(
          args[args.indexOf("--ak-review-capabilities") + 1],
          admitted.capabilitiesPath,
        );
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
        const expansion = `<skill name="code-review" location="${skillPath}">\n${material.body}\n</skill>\n\n${instruction}`;
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
