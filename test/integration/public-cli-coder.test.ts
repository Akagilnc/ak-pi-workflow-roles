import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
/**
 * #109 public Coder path — common Invocation, default apply / explicit plan,
 * package TDD provenance on shared success Terminal interface.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { loadPackagedMethodSkillMaterial } from "../../src/package-resources/method-skill.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";

import {
  admitCoderInvocation,
} from "../../src/public-cli/invocation.ts";
import {
  settleCoderTerminalResult,
} from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { recordAuditEscalationSubmission, sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-coder-"));
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
  execFileSync("git", ["config", "user.email", "coder@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Coder Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}




/**
 * Replaces direct buildPiTurnExtraArgs argv locks — verifies behavior through
 * the typed request contract, not argv string indexing.
 */

test("coder apply/plan/resume project typed RoleTurnRequest: apply binds TDD method, plan omits it", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const captured: { current: RoleTurnRequest | undefined } = { current: undefined };

    // Apply phase: TDD method binding present, phase = apply.
    {
      await runAkRole(
        ["coder", "--project", project, "Apply the approved plan."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-coder-apply-typed",
          io: captureIo().io,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: createMinimalHost((request) => {
            captured.current = request;
            return Promise.resolve({ code: 1, stderr: "stop", timedOut: false });
          }),
        },
      );
      const req = captured.current!;
      assert.equal(req.activation.role, "coder");
      assert.equal(req.activation.phase, "apply");
      assert.equal(
        req.methods.some((m) => m.kind === "skill" && m.path.includes("tdd")),
        true,
        "apply must bind TDD method",
      );
      assert.equal(req.continuation.kind, "initial");
    }

    // Plan phase: no method bindings.
    {
      const result = await runAkRole(
        ["coder", "plan", "--project", project, "Plan only."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-coder-plan-typed",
          io: captureIo().io,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: createMinimalHost((request) => {
            captured.current = request;
            return Promise.resolve({ code: 1, stderr: "stop", timedOut: false });
          }),
        },
      );
      assert.equal(result.exitCode, 1);
      const req = captured.current!;
      assert.equal(req.activation.role, "coder");
      assert.equal(req.activation.phase, "plan");
      assert.equal(req.methods.length, 0, "plan must omit method bindings");
    }

    // Resume phase: default envelope (no explicit message) preserves apply bindings and selects typed resume continuation.
    {
      // First seed an admitted apply run with accessible session principal coordinates
      await runAkRole(
        ["coder", "--project", project, "Apply the approved plan."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-coder-resume-typed",
          io: captureIo().io,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: createMinimalHost(async (request) => {
            const { sessionDirectory, sessionFile } =
              piDurablePrincipalAuthority.decode(request.principal);
            await mkdir(sessionDirectory, { recursive: true });
            await writeFile(sessionFile, "", "utf8");
            return { code: 1, stderr: "stop", timedOut: false };
          }),
        },
      );

      captured.current = undefined;
      const result = await runAkRole(
        ["resume", "run-coder-resume-typed"],
        {
          packageRoot,
          home,
          cwd: project,
          io: captureIo().io,
          credentials: { "openai-codex": true, xai: true },
          principalAuthority: piDurablePrincipalAuthority,
          roleTurnHost: createMinimalHost((request) => {
            captured.current = request;
            return Promise.resolve({ code: 1, stderr: "stop", timedOut: false });
          }),
        },
      );
      assert.equal(result.exitCode, 1);
      const req = captured.current!;
      assert.equal(req.activation.role, "coder");
      assert.equal(req.activation.phase, "apply");
      assert.equal(
        req.methods.some((m) => m.kind === "skill" && m.path.includes("tdd")),
        true,
        "resumed apply must bind TDD method",
      );
      // The two-argument invocation above selects the no-explicit-message branch;
      // its structured request must still carry resume continuation semantics.
      assert.equal(req.continuation.kind, "resume");
    }
  });
});

test("public coder coordinator settles durable audit escalation", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-coder-escalate-001";
    const runDirectory = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project), "runs", `${runId}@coder`);
    const captured = captureIo();
    const result = await runAkRole(["coder", "--project", project, "Escalate the gate decision."], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => runId,
      io: captured.io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          await mkdir(join(runDirectory, "session"), { recursive: true });
          await writeFile(join(runDirectory, "session", "session.jsonl"), "", "utf8");
          await recordAuditEscalationSubmission({
            cwd: project,
            home,
            runId,
            runDirectory,
            role: "coder",
            details: { kind: "audit_escalation", conflicts: ["authority conflict"] },
          });
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
      }),
    });
    assert.equal(result.exitCode, 0, captured.stderr.join(""));
    assert.equal(result.terminal?.roleOutcome.kind, "audit_escalation");
    assert.deepEqual(result.terminal?.roleOutcome.decisiveFacts.conflicts, ["authority conflict"]);
  });
});

test("lawful coder Terminal settlement publishes report/evidence with method provenance", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const admitted = await admitCoderInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      phase: "apply",
      instruction: "Implement and verify.",
      attachmentPaths: [],
      createRunId: () => "run-coder-settle-001",
    });
    await mkdir(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, { recursive: true });
    const material = await loadPackagedMethodSkillMaterial(packageRoot, "tdd");
    const receipt = {
      status: "completed" as const,
      report:
        "TDD red/green evidence; same-pattern, introduced-regression, and behavior-fact checks complete.",
    };
    // Minimal session leaf: assistant toolCall then accepted toolResult.
    const sessionLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: CODER_OUTPUT_TOOL_NAME,
              arguments: receipt,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: CODER_OUTPUT_TOOL_NAME,
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
      role: "coder",
      details: receipt,
      toolCallId: "c1",
    });

    const terminal = await settleCoderTerminalResult(admitted, piDurablePrincipalAuthority, {
      methodProvenance: material.provenance,
    });
    assert.equal(terminal.roleOutcome.role, "coder");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.roleOutcome.status, "completed");
    assert.equal(terminal.runId, "run-coder-settle-001");
    const report = terminal.artifacts.find((a) => a.kind === "report");
    assert.ok(report);
    assert.ok((await readFile(report.path, "utf8")).includes(receipt.report));
    assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);

    const evidence = JSON.parse(
      await readFile(
        terminal.artifacts.find((a) => a.kind === "evidence")!.path,
        "utf8",
      ),
    ) as {
      methodProvenance: {
        upstream: {
          repository: string;
          attribution: string;
          commit: string;
          tag?: string;
        };
        files: Record<string, { sha256: string; gitBlob: string }>;
      };
    };
    assert.equal(
      evidence.methodProvenance.upstream.repository,
      "https://github.com/mattpocock/skills",
    );
    assert.equal(evidence.methodProvenance.upstream.attribution, "mattpocock/skills");
    assert.equal(
      evidence.methodProvenance.upstream.commit,
      material.provenance.upstream.commit,
    );
    assert.equal(
      evidence.methodProvenance.files["SKILL.md"]?.sha256,
      material.provenance.files["SKILL.md"]!.sha256,
    );
    assert.equal(
      evidence.methodProvenance.files["SKILL.md"]?.gitBlob,
      material.provenance.files["SKILL.md"]!.gitBlob,
    );
    // Evidence must not point at ambient home Skill discovery.
    const evidenceText = JSON.stringify(evidence);
    assert.equal(evidenceText.includes(".agents/skills"), false);
  });
});

test("alternate host seals accepted Terminal without Pi acceptance leaf", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const receipt = {
      status: "completed" as const,
      report: "Alternate host sealed through production ledger producer.",
    };
    const { io, stdout } = captureIo();
    const result = await runAkRole(
      ["coder", "--project", project, "Finish without a Pi session leaf."],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-coder-alternate-host",
        io,
        roleTurnHost: createMinimalHost(async (request) => {
          const { sessionDirectory, sessionFile } =
            piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(sessionDirectory, { recursive: true });
          // No Pi acceptance leaf — alternate host walks production ledger → sealed → Terminal.
          await writeFile(sessionFile, "", "utf8");
          await sealAcceptedSubmission({
            cwd: request.cwd,
            home,
            runId: "run-coder-alternate-host",
            runDirectory: request.runDirectory,
            role: "coder",
            details: receipt,
            toolCallId: "alt-1",
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      },
    );
    assert.equal(result.exitCode, 0, stdout.join("") || "alternate host failed");
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(result.terminal!.roleOutcome.role, "coder");
    assert.equal(result.terminal!.roleOutcome.status, "completed");
  });
});

test("ak-role coder defaults apply, preserves plan, and rejects blank task structurally", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Blank task → structural reject, no run.
    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(["coder", "plan", "   "], {
        packageRoot,
        home,
        cwd: project,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async () => {
          throw new Error("must not dispatch");
        },
          }),
      });
      assert.equal(result.exitCode, 2);
      assert.equal(stderr.join("").length > 0, true);
    }

    // Explicit plan preserved through admission; injectable runner observes phase.
    {
      const { io, stdout } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole(
        [
          "coder",
          "plan",
          "--project",
          project,
          "Propose the first implementation plan.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-coder-plan",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            // Write a lawful planned receipt into the session the args reserved.
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const receipt = {
              status: "planned",
              report: "Plan: one vertical slice with package TDD on apply.",
            };
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "p1",
                  toolName: CODER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: receipt,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              sealedAcceptance: { role: "coder" as const, details: receipt, toolCallId: "p1" },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(result.exitCode, 0, stdout.join("") || "coder plan failed");
      assert.equal(Array.isArray(captured), true);
      assert.equal(captured!.includes("--ak-coder-phase"), true);
      assert.equal(
        captured![captured!.indexOf("--ak-coder-phase") + 1],
        "plan",
      );
      assert.equal(captured!.includes("--skill"), false);
      assert.equal(result.terminal?.roleOutcome.role, "coder");
      assert.equal(
        result.terminal?.roleOutcome.kind === "accepted"
          ? result.terminal.roleOutcome.status
          : undefined,
        "planned",
      );
      await access(
        join(
          home,
          ".ak-roles",
          "books",
          resolveBookKeyFromGit(project),
          "runs",
          "run-cli-coder-plan@coder",
          "admitted-request.json",
        ),
      );
    }

    // Default phase is apply and pins package skill path.
    {
      const { io } = captureIo();
      let captured: string[] | undefined;
      await runAkRole(
        ["coder", "--project", project, "Implement the approved slice."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-coder-apply",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            return {
              code: 1,
              stderr: "forced stop before model",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(Array.isArray(captured), true);
      assert.equal(
        captured![captured!.indexOf("--ak-coder-phase") + 1],
        "apply",
      );
      assert.equal(captured!.includes("--skill"), true);
    }
  });
});

test("ak-role resume continues coder with preserved plan phase and exact session", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-cli-coder-resume-plan";
    const instruction = "Propose the first implementation plan for resume.";

    {
      const { io } = captureIo();
      const first = await runAkRole(
        ["coder", "plan", "--project", project, instruction],
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
      assert.ok(first.terminal?.resume, "coder plan 429 must be resumable");
      assert.equal(first.terminal?.roleOutcome.role, "coder");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@coder`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const admitted = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as { phase: string; role: string; taskPath: string; ticketNumber?: number };
    assert.equal(admitted.role, "coder");
    assert.equal(admitted.phase, "plan");
    assert.equal(admitted.ticketNumber, undefined);

    const { io, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    const resumed = await runAkRole(["resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
        resumeArgs = [...args];
        assert.equal(args[args.indexOf("--ak-role") + 1], "coder");
        assert.equal(args[args.indexOf("--ak-coder-phase") + 1], "plan");
        assert.equal(args[args.indexOf("--ak-coder-task") + 1], admitted.taskPath);
        assert.equal(args.includes("--skill"), false);
        assert.equal(args.includes(instruction), false);
        assert.equal(args[args.indexOf("--session-dir") + 1], sessionDirectory);
        const details = {
                status: "planned",
                report: "Resumed plan remains plan phase.",
              };
        await writeFile(
          join(sessionDirectory, "session.jsonl"),
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "r1",
              toolName: CODER_OUTPUT_TOOL_NAME,
              isError: false,
              details,
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          sealedAcceptance: { role: "coder" as const, details, toolCallId: "r1" },
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
          }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "coder resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumed.terminal?.roleOutcome.role, "coder");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? resumed.terminal.roleOutcome.status
        : undefined,
      "planned",
    );
  });
});

// #346: bare --model provider/model dispatches without inventing --thinking.
test("bare --model provider/model dispatches without --thinking; suffix still passes thinking", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Bare model: legal, passes provider/model, omits --thinking entirely.
    {
      const { io, stdout, stderr } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole(
        [
          "--model",
          "kimi-coding/k3-256k",
          "coder",
          "plan",
          "--project",
          project,
          "Propose with bare model override.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          // Non-catalog provider (kimi-coding) skips credential fail-closed; still pin facts.
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => "run-cli-coder-bare-model",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const receipt = {
              status: "planned",
              report: "Plan under bare model override.",
            };
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "bare1",
                  toolName: CODER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: receipt,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              sealedAcceptance: { role: "coder" as const, details: receipt, toolCallId: "bare1" },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(
        result.exitCode,
        0,
        stderr.join("") || stdout.join("") || "bare model dispatch failed",
      );
      assert.equal(Array.isArray(captured), true);
      assert.equal(captured![captured!.indexOf("--provider") + 1], "kimi-coding");
      assert.equal(captured![captured!.indexOf("--model") + 1], "k3-256k");
      assert.equal(captured!.includes("--thinking"), false);
      // invocation evidence: model identity is the override; thinking stays absent.
      const bookKey = resolveBookKeyFromGit(project);
      const invocation = JSON.parse(
        await readFile(
          join(
            home,
            ".ak-roles",
            "books",
            bookKey,
            "runs",
            "run-cli-coder-bare-model@coder",
            "invocation.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      // invocation evidence records the effective provider/model; thinking stays absent for bare model.
      assert.equal(invocation.provider, "kimi-coding");
      assert.equal(invocation.model, "k3-256k");
      assert.equal("thinking" in invocation, false);
      assert.equal(
        result.terminal?.roleOutcome.kind === "accepted"
          ? result.terminal.roleOutcome.status
          : undefined,
        "planned",
      );
    }

    // Suffix override: --thinking still forwarded unchanged.
    {
      const { io, stderr } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole(
        [
          "--model",
          "openai-codex/gpt-5.6-luna:high",
          "coder",
          "plan",
          "--project",
          project,
          "Propose with thinking suffix.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => "run-cli-coder-thinking-suffix",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            return {
              code: 1,
              stderr: "stop after args capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(Array.isArray(captured), true, stderr.join("") || "suffix dispatch missing args");
      assert.equal(captured![captured!.indexOf("--provider") + 1], "openai-codex");
      assert.equal(captured![captured!.indexOf("--model") + 1], "gpt-5.6-luna");
      assert.equal(captured!.includes("--thinking"), true);
      assert.equal(captured![captured!.indexOf("--thinking") + 1], "high");
      // invocation evidence records provider/model and the supplied thinking level.
      const bookKey = resolveBookKeyFromGit(project);
      const invocation = JSON.parse(
        await readFile(
          join(
            home,
            ".ak-roles",
            "books",
            bookKey,
            "runs",
            "run-cli-coder-thinking-suffix@coder",
            "invocation.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.equal(invocation.provider, "openai-codex");
      assert.equal(invocation.model, "gpt-5.6-luna");
      assert.equal(invocation.thinking, "high");
      // Failure after dispatch is fine — we only assert model/thinking pass-through.
      assert.notEqual(result.exitCode, 2);
    }
  });
});

test("syntactically valid unknown provider/model is not rejected at thinking parse", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stderr } = captureIo();
    let dispatched = false;
    let captured: string[] | undefined;
    const result = await runAkRole(
      [
        "--model",
        "no-such-provider/no-such-model",
        "coder",
        "plan",
        "--project",
        project,
        "Unknown model must reach resolution, not thinking parse.",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-cli-coder-unknown-model",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          dispatched = true;
          captured = [...args];
          // Simulate existing typed model-resolution refusal from the host runtime.
          return {
            code: 1,
            stderr: "Unknown model: no-such-provider/no-such-model",
            timedOut: false,
            args: [...args],
          };
        },
          }),
      },
    );
    assert.equal(dispatched, true, stderr.join("") || "unknown model must reach pi dispatch");
    assert.equal(captured![captured!.indexOf("--provider") + 1], "no-such-provider");
    assert.equal(captured![captured!.indexOf("--model") + 1], "no-such-model");
    assert.equal(captured!.includes("--thinking"), false);
    // Must not be the pre-#346 thinking-required structural wash.
    assert.equal(stderr.join("").includes("requires a thinking level"), false);
    assert.notEqual(result.exitCode, 0);
  });
});

// #346: colon present with empty/illegal thinking stays a typed format reject at the real entry.
test("malformed --model thinking suffix is rejected at public entry without dispatch", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    for (const badSpec of [
      "openai-codex/gpt-5.6-luna:bogus",
      "openai-codex/gpt-5.6-luna:",
      ":provider/model",
    ] as const) {
      const { io, stderr } = captureIo();
      let dispatched = false;
      const result = await runAkRole(
        [
          "--model",
          badSpec,
          "coder",
          "plan",
          "--project",
          project,
          "Malformed thinking must not dispatch.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () =>
            `run-cli-coder-bad-thinking-${
              badSpec.endsWith(":")
                ? "trail"
                : badSpec.startsWith(":")
                  ? "leading"
                  : "bogus"
            }`,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            dispatched = true;
            return {
              code: 0,
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(dispatched, false, `${badSpec} must not reach pi dispatch`);
      assert.notEqual(result.exitCode, 0, `${badSpec} must be rejected`);
      assert.match(
        stderr.join(""),
        /model specification must be provider\/model\[:thinking\]/,
        `${badSpec} must keep typed format rejection; got: ${stderr.join("")}`,
      );
      // Must not wash into the persistent-config "thinking required" channel.
      assert.equal(stderr.join("").includes("requires a thinking level"), false);
    }
  });
});
