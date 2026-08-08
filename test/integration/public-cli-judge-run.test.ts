/**
 * #106 end-to-end: ak-role judge → existing Judge gate (real Pi + faux provider)
 * → one Terminal result with registry-rendered Navigator command.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { COMPLIANCE_RESPONSE_ENTRY_TYPE } from "../../src/compliance-transport.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { settleJudgeTerminalResult } from "../../src/public-cli/settlement.ts";
import {
  packageRoot,
  piCli,
  runPiSubprocess,
} from "../helpers/pi-test-harness.ts";

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "judge-e2e@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Judge E2E"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

test(
  "ak-role Judge settles retained malformed compliance as a typed incomplete Terminal",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-public-cli-judge-incomplete-"));
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const providerPath = resolve(
        packageRoot,
        "test/fixtures/audit-failure-provider.ts",
      );
      const result = await runAkRole(
        [
          "judge",
          "--model",
          "ak-audit-failure/faux-1",
          "--thinking",
          "off",
          "--project",
          project,
          "Retain the original Judge candidate.",
        ],
        {
          packageRoot,
          home,
          agentDir: join(home, ".pi", "agent"),
          cwd: project,
          createRunId: () => "run-e2e-judge-incomplete-001",
          judgeExtraPiArgs: ["-e", providerPath],
          judgeTimeoutMs: 90_000,
          io: {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text),
          },
          piRunner: async (args, options) => {
            const subprocess = await runPiSubprocess([...args], {
              cwd: options.cwd,
              env: {
                ...options.env,
                PI_OFFLINE: "1",
                AK_AUDIT_NON_OBJECT: "1",
              },
              timeoutMs: options.timeoutMs ?? 90_000,
            });
            return {
              code: subprocess.code,
              stdout: subprocess.stdout,
              stderr: subprocess.stderr,
              timedOut: subprocess.timedOut,
              args: [...args],
            };
          },
        },
      );

      assert.equal(result.exitCode, 1, stderr.join("") || "incomplete audit unexpectedly succeeded");
      assert.equal(stdout.length, 1);
      assert.ok(result.terminal);
      const outcome = result.terminal!.roleOutcome;
      assert.equal(outcome.kind, "audit_incomplete");
      assert.equal(outcome.role, "judge");
      assert.equal(outcome.status, "audit-incomplete");
      assert.equal(outcome.decision, "no-usable-decision");
      assert.equal(outcome.acceptedReceipt, false);
      assert.deepEqual(outcome.roleCandidate, { judgeStatus: "converged" });
      assert.deepEqual(outcome.audit.candidate, ["malformed auditor candidate"]);
      assert.deepEqual(outcome.audit.observation, {
        kind: "non-object-arguments",
        type: "array",
      });
      assert.notDeepEqual(outcome.roleCandidate, outcome.audit.candidate);

      const bookKey = resolveBookKeyFromGit(project);
      const sessionFile = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-e2e-judge-incomplete-001@judge",
        "session",
        "session.jsonl",
      );
      const rows = (await readFile(sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as any);
      const retained = rows.filter(
        (row) => row.type === "custom" && row.customType === COMPLIANCE_RESPONSE_ENTRY_TYPE,
      );
      assert.equal(retained.length, 1);
      const retainedCall = retained[0].data.response.content.find(
        (part: any) => part.type === "toolCall",
      );
      assert.deepEqual(retainedCall.arguments, outcome.audit.candidate);
      const roleCall = rows.find(
        (row) => row.type === "message" && row.message?.role === "assistant" &&
          row.message?.content?.some((part: any) => part.type === "toolCall" && part.name === "ak_judge_output"),
      );
      const originalRoleCall = roleCall.message.content.find(
        (part: any) => part.type === "toolCall" && part.name === "ak_judge_output",
      );
      assert.deepEqual(originalRoleCall.arguments, outcome.roleCandidate);
      assert.equal(rows.some(
        (row) => row.type === "message" && row.message?.toolName === "ak_judge_output" && row.message?.isError === false && row.message?.details?.judgeStatus === "converged",
      ), false);
      const evidenceRef = result.terminal!.artifacts.find(
        (artifact) => artifact.kind === "evidence",
      );
      assert.ok(evidenceRef);
      const evidence = JSON.parse(await readFile(evidenceRef.path, "utf8")) as any;
      assert.deepEqual(evidence.roleCandidate, outcome.roleCandidate);
      assert.deepEqual(evidence.audit.candidate, outcome.audit.candidate);
      assert.deepEqual(evidence.audit.observation, outcome.audit.observation);
      // Public stdout exposes typed decisive facts without depending on presentation labels.
      const publicOutput = stdout.join("");
      assert.ok(publicOutput.includes("roleCandidate"));
      assert.ok(publicOutput.includes("auditCandidate"));
      assert.ok(publicOutput.includes("malformed auditor candidate"));
      assert.ok(publicOutput.includes("auditObservation"));
      assert.ok(publicOutput.includes("array"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "ak-role judge reaches Judge gate and settles Terminal with registry command",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-public-cli-judge-e2e-"));
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const attachment = join(home, "brief.txt");
      await writeFile(attachment, "canonical nonblank prose for navigator work context", "utf8");
      // Point automatic Navigator at the same offline faux provider as Judge.
      const agentDir = join(home, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "navigator-model.json"),
        JSON.stringify({ model: "ak-audit-failure/faux-1" }),
        "utf8",
      );

      const stdout: string[] = [];
      const stderr: string[] = [];
      const providerPath = resolve(
        packageRoot,
        "test/fixtures/audit-failure-provider.ts",
      );

      const result = await runAkRole(
        [
          "judge",
          "--model",
          "ak-audit-failure/faux-1",
          "--thinking",
          "off",
          "--attach",
          attachment,
          "--project",
          project,
          "Canonical nonblank prose Judge request for navigation.",
        ],
        {
          packageRoot,
          home,
          agentDir,
          cwd: project,
          correlationId: "corr-106-e2e",
          createRunId: () => "run-e2e-judge-001",
          judgeExtraPiArgs: ["-e", providerPath],
          judgeTimeoutMs: 90_000,
          io: {
            stdout: (text) => {
              stdout.push(text);
            },
            stderr: (text) => {
              stderr.push(text);
            },
          },
          piRunner: async (args, options) => {
            // Delivery outcome scripts a lawful soul-audit pass + Judge converge
            // and a typed Navigator recommendation (model command prose ignored).
            const subprocess = await runPiSubprocess([...args], {
              cwd: options.cwd,
              env: {
                ...options.env,
                PI_OFFLINE: "1",
                AK_NAVIGATOR_DELIVERY_OUTCOME: "recommendation",
              },
              timeoutMs: options.timeoutMs ?? 90_000,
            });
            return {
              code: subprocess.code,
              stdout: subprocess.stdout,
              stderr: subprocess.stderr,
              timedOut: subprocess.timedOut,
              args: [...args],
            };
          },
        },
      );

      assert.equal(result.exitCode, 0, stderr.join("") || "judge e2e failed");
      // AC4 publication: one non-empty stdout write. Typed facts come from settlement owners,
      // not presentation labels (ADR 0052).
      assert.equal(stdout.length, 1);
      assert.ok(stdout[0]!.length > 0);

      const bookKey = resolveBookKeyFromGit(project);
      const runDir = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-e2e-judge-001@judge",
      );
      const terminal = await settleJudgeTerminalResult({
        role: "judge",
        runId: "run-e2e-judge-001",
        runDirectory: runDir,
        sessionDirectory: join(runDir, "session"),
        sessionFile: join(runDir, "session", "session.jsonl"),
        projectRoot: project,
        bookKey,
        instruction: "Canonical nonblank prose Judge request for navigation.",
        instructionEmpty: false,
        attachments: [],
        admittedRequestPath: join(runDir, "admitted-request.json"),
      });
      assert.equal(terminal.roleOutcome.role, "judge");
      assert.equal(terminal.roleOutcome.kind, "accepted");
      assert.equal(terminal.roleOutcome.status, "converged");
      assert.equal(terminal.navigator.disposition, "recommendation");
      if (terminal.navigator.disposition === "recommendation") {
        assert.equal(terminal.navigator.next.role, "reviewer");
        assert.equal(terminal.navigator.command, "ak-role reviewer");
        assert.equal(terminal.navigator.command.includes("pi --ak-role"), false);
      }
      assert.equal(terminal.runId, "run-e2e-judge-001");
      assert.ok(terminal.artifacts.length >= 2);
      assert.equal(terminal.artifacts.some((a) => a.kind === "report"), true);
      assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);
      for (const artifact of terminal.artifacts) {
        await readFile(artifact.path);
      }

      const admitted = JSON.parse(
        await readFile(join(runDir, "admitted-request.json"), "utf8"),
      ) as { instruction: string; attachments: Array<{ frozenPath: string }> };
      assert.equal(
        admitted.instruction,
        "Canonical nonblank prose Judge request for navigation.",
      );
      assert.equal(admitted.attachments.length, 1);
      assert.equal(
        await readFile(admitted.attachments[0]!.frozenPath, "utf8"),
        "canonical nonblank prose for navigator work context",
      );

      // #78 index may record correlation/session pointers only — zero content bytes (ADR 0049).
      const indexPath = join(home, ".ak-roles", "books", bookKey, "waiting.jsonl");
      const indexText = await readFile(indexPath, "utf8");
      assert.equal(
        indexText.includes("Canonical nonblank prose Judge request for navigation."),
        false,
      );
      assert.equal(
        indexText.includes("canonical nonblank prose for navigator work context"),
        false,
      );
      assert.match(indexText, /"event":"accepted-activation"/);
      assert.match(indexText, /"id":"corr-106-e2e"/);

      // pi binary used by harness exists (sanity for runner wiring).
      assert.equal(piCli.endsWith("/pi"), true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
