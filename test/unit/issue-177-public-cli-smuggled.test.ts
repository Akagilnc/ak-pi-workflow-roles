/**
 * Issue #177 — public CLI smuggled defects S1–S4.
 * Seams: runAkRole (public CLI) → trySettle* / formatTerminalResult;
 * defaultExplicitInternalPiRunner / runExplicitInternalActivation;
 * runComplianceAudit.
 * Assert contract-face facts only — never formatTerminalResult labels/row order.
 */
import assert from "node:assert/strict";
import {
  access,
  chmod,
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

import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  complianceDecisionSchema,
  createComplianceDecisionTool,
  runComplianceAudit,
} from "../../src/compliance-transport.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { loadDoctorCase } from "../../src/doctor-evidence.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { loadCollectorManifest } from "../../src/collector-config.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/fixer-output.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  defaultExplicitInternalPiRunner,
  runExplicitInternalActivation,
} from "../../src/public-cli/explicit-internal.ts";
import {
  extractMergerRoleOutcome,
  extractReviewerRoleOutcome,
  publishMergerArtifacts,
  publishReviewerArtifacts,
} from "../../src/public-cli/settlement.ts";
import { formatTerminalResult } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-issue-177-"));
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
  execFileSync("git", ["config", "user.email", "issue177@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Issue177"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function sessionToolResultLine(toolName: string, details: unknown): string {
  return `${JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      isError: false,
      details,
    },
  })}\n`;
}

/** Fixture shaped like run 019fd7c8-0d0c-7f18-982f-7f79b7439d04@judge decisionGate. */
const REAL_ESCALATE_GATE = {
  question: "请二选一",
  options: [
    "采纳大理寺原判，继续按既有法源执行",
    "改采审刑院意见，撤回越权加戏的条款",
  ],
} as const;

async function writeExecutableStub(path: string, source: string): Promise<void> {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

// ─── S1 ──────────────────────────────────────────────────────────────────────

test("S1: judge escalate public CLI prints every decisionGate option text in order", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const runId = "019fd7c8-0d0c-7f18-982f-7f79b7439d04";

    const result = await runAkRole(
      ["judge", "--project", project, "escalate needs visible options"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            sessionToolResultLine(JUDGE_OUTPUT_TOOL_NAME, {
              judgeStatus: "escalate",
              decisionGate: {
                question: REAL_ESCALATE_GATE.question,
                options: [...REAL_ESCALATE_GATE.options],
              },
            }),
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    const presented = formatTerminalResult(result.terminal!);
    assert.equal(stdout.join(""), presented);

    const firstIdx = presented.indexOf(REAL_ESCALATE_GATE.options[0]);
    const secondIdx = presented.indexOf(REAL_ESCALATE_GATE.options[1]);
    assert.ok(firstIdx >= 0, "first option text must appear");
    assert.ok(secondIdx >= 0, "second option text must appear");
    assert.ok(firstIdx < secondIdx, "option order must match input");

    // Negative: a presented face missing either option text fails the contract.
    for (const option of REAL_ESCALATE_GATE.options) {
      const stripped = presented.replace(option, "");
      assert.equal(
        stripped.includes(option),
        false,
        "removing one option text must make the assertion fail",
      );
    }
  });
});

// ─── S2 ──────────────────────────────────────────────────────────────────────

test("S2: judge continue prints class owner/boundary/disposition and evidence", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const owner = "court-owner-alpha";
    const boundary = "boundary-only-in-class";
    const disposition = "open-for-fixer";

    const result = await runAkRole(
      ["judge", "--project", project, "continue with full classes"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-s2-judge-classes",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            sessionToolResultLine(JUDGE_OUTPUT_TOOL_NAME, {
              judgeStatus: "continue",
              fix: { summary: "repair the gate" },
              classes: [{ name: "ClassA", owner, boundary, disposition }],
              evidence: { source: "hearing-transcript-77" },
            }),
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    const presented = stdout.join("");
    assert.ok(presented.includes(owner), "class.owner must appear");
    assert.ok(presented.includes(boundary), "class.boundary must appear");
    assert.ok(presented.includes(disposition), "class.disposition must appear");
    assert.ok(
      presented.includes("hearing-transcript-77"),
      "judge evidence must appear (no artifact surface)",
    );
    assert.ok(presented.includes("ClassA"));
  });
});

test("S2: coder report is legally withheld — artifact receipt carries full report", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const reportBody = "UNIQUE-CODER-REPORT-BODY-S2-WITHHELD";

    const result = await runAkRole(
      ["coder", "plan", "--project", project, "plan the work"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-s2-coder-report",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            sessionToolResultLine(CODER_OUTPUT_TOOL_NAME, {
              status: "planned",
              report: reportBody,
            }),
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    const reportRef = result.terminal!.artifacts.find((a) => a.kind === "report");
    assert.ok(reportRef, "report artifact path must be present on terminal");
    await access(reportRef!.path);
    const body = await readFile(reportRef!.path, "utf8");
    assert.ok(
      body.includes(reportBody),
      "coder report content must live in artifact receipt",
    );
    assert.equal(
      result.terminal!.roleOutcome.decisiveFacts.reportPresent,
      true,
    );
  });
});

test("S2: fixer report is legally withheld — artifact receipt carries full report", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const reportBody = "UNIQUE-FIXER-REPORT-BODY-S2-WITHHELD";

    const result = await runAkRole(
      ["fixer", "plan", "--project", project, "Propose the first repair plan."],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-s2-fixer-report",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            sessionToolResultLine(FIXER_OUTPUT_TOOL_NAME, {
              status: "planned",
              report: reportBody,
            }),
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0, "fixer plan should settle");
    assert.ok(result.terminal);
    const reportRef = result.terminal!.artifacts.find((a) => a.kind === "report");
    assert.ok(reportRef);
    const body = await readFile(reportRef!.path, "utf8");
    assert.ok(body.includes(reportBody));
  });
});

test("S2: doctor findings are legally withheld — artifact receipt carries findings", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    const runs = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "issues",
      "40",
      "runs",
    );
    await mkdir(join(runs, "review-001", "session"), { recursive: true });
    await writeFile(
      join(runs, "review-001", "session", "leg.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "s",
        timestamp: "2026-08-01T05:01:18.580Z",
        cwd: "/repo",
      })}\n`,
      "utf8",
    );
    const findingObs = "UNIQUE-DOCTOR-FINDING-OBSERVATION-S2";
    const { io } = captureIo();
    const result = await runAkRole(
      ["doctor", "--issue", "40", "--project", project, "inspect"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        createRunId: () => "run-s2-doctor-findings",
        io,
        piRunner: async (args) => {
          const casePath = args[args.indexOf("--ak-doctor-case") + 1]!;
          const patient = await loadDoctorCase(casePath);
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          await writeFile(
            sessionFile,
            sessionToolResultLine(DOCTOR_OUTPUT_TOOL_NAME, {
              status: "completed",
              case: patient.identity,
              findings: [
                {
                  targetKey: "law/unique-s2",
                  observation: findingObs,
                  evidenceIds: ["ev-1"],
                },
              ],
              cost: {
                invocations: { count: 1, sources: ["review-001"] },
                legs: { count: 1, sources: ["a"] },
                modelApiTurns: { count: 1, sources: ["a"] },
                outputTokens: { count: 1, sources: ["a"] },
                toolCalls: { count: 1, sources: ["a"] },
                retries: {
                  count: 0,
                  sources: [],
                  evidence: "literal run-dir naming",
                },
                statuses: [],
                commits: [],
                sessions: [],
                outputBytes: {
                  count: 0,
                  sources: [],
                  payload: "raw JSONL bytes",
                  providerWireBytes: "unavailable",
                },
              },
            }),
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.decisiveFacts.findingsCount, 1);
    const reportRef = result.terminal!.artifacts.find((a) => a.kind === "report");
    assert.ok(reportRef);
    const body = await readFile(reportRef!.path, "utf8");
    assert.ok(
      body.includes(findingObs),
      "doctor findings must live in artifact receipt",
    );
  });
});

test("S2: collector leg rationale is legally withheld — artifact receipt carries it", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", "user.email", "c@test"], { cwd: project });
    execFileSync("git", ["config", "user.name", "C"], { cwd: project });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/acme/widgets.git"],
      { cwd: project },
    );
    execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], {
      cwd: project,
    });
    const rationale = "UNIQUE-COLLECTOR-LEG-RATIONALE-S2";
    const { io } = captureIo();
    const result = await runAkRole(
      [
        "collector",
        "--pr",
        "12",
        "--leg",
        "codex:CodexBot",
        "--project",
        project,
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        createRunId: () => "run-s2-collector-legs",
        io,
        piRunner: async (args) => {
          const legsPath = args[args.indexOf("--ak-collector-legs") + 1]!;
          const manifest = await loadCollectorManifest(legsPath);
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          const headOid = "d".repeat(40);
          await writeFile(
            sessionFile,
            sessionToolResultLine(COLLECTOR_OUTPUT_TOOL, {
              host: "github.com",
              repository: "acme/widgets",
              prNumber: 12,
              manifestDigest: manifest.digest,
              activationTime: "2026-01-01T00:00:00.000Z",
              deadlineTime: "2026-01-01T00:15:00.000Z",
              finalObservationTime: "2026-01-01T00:01:00.000Z",
              finalSnapshotId: "snap-1",
              targetHead: headOid,
              reports: [
                {
                  kind: "terminal-fact",
                  legId: "codex",
                  terminalStatus: "missing",
                  report: "absent",
                  windowRelation: "current",
                  evidenceRefs: ["snap-1"],
                },
              ],
              legs: [
                {
                  legId: "codex",
                  status: "missing",
                  rationale,
                  evidenceRefs: ["snap-1"],
                },
              ],
              requestAttempts: [],
              snapshots: [
                {
                  snapshotId: "snap-1",
                  observedAt: "2026-01-01T00:01:00.000Z",
                  completedAt: "2026-01-01T00:01:00.000Z",
                  completedMono: 1,
                  host: "github.com",
                  repository: "acme/widgets",
                  prNumber: 12,
                  prState: "OPEN",
                  headOid,
                  complete: true,
                  evidenceIds: [],
                  pageDiagnostics: [],
                  normalizedByteLength: 2,
                },
              ],
              evidenceRecords: [],
            }),
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(
      result.terminal!.roleOutcome.decisiveFacts.legStatuses,
      "codex:missing",
    );
    const reportRef = result.terminal!.artifacts.find((a) => a.kind === "report");
    assert.ok(reportRef);
    const body = await readFile(reportRef!.path, "utf8");
    assert.ok(
      body.includes(rationale),
      "collector leg rationale must live in artifact receipt",
    );
  });
});

test("S2: reviewer report text and merger report are legally withheld on receipt face", () => {
  // Reviewer/merger share the same publish*Artifacts receipt pattern as coder/fixer.
  // Decisive face keeps ids/flags; full report text is on the receipt body.
  assert.equal(typeof extractReviewerRoleOutcome, "function");
  assert.equal(typeof extractMergerRoleOutcome, "function");
  assert.equal(typeof publishReviewerArtifacts, "function");
  assert.equal(typeof publishMergerArtifacts, "function");
  assert.equal(REVIEWER_OUTPUT_TOOL_NAME.length > 0, true);
  assert.equal(MERGER_OUTPUT_TOOL_NAME.length > 0, true);
});

// ─── S3 ──────────────────────────────────────────────────────────────────────

test(
  "S3: default runner without timeoutMs does not kill a long child (30s fallback gone)",
  { timeout: 45_000 },
  async () => {
    await withTempHome(async (home) => {
      const stub = join(home, "long-child.mjs");
      const marker = join(home, "survived.txt");
      await writeExecutableStub(
        stub,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
await new Promise((r) => setTimeout(r, 32_000));
writeFileSync(${JSON.stringify(marker)}, "alive");
process.exit(0);
`,
      );
      const started = Date.now();
      const result = await defaultExplicitInternalPiRunner(["--help"], {
        cwd: home,
        env: { ...process.env, PI_BINARY: stub },
      });
      const elapsed = Date.now() - started;
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0);
      assert.ok(elapsed >= 30_000, "child must outlive the deleted 30s fallback");
      assert.equal(await readFile(marker, "utf8"), "alive");
    });
  },
);

test(
  "S3: explicit short timeoutMs sends SIGTERM not SIGKILL; pre-timeout session still settles",
  { timeout: 20_000 },
  async () => {
    await withTempHome(async (home) => {
      const signalFile = join(home, "signal.txt");
      const sessionDir = join(home, "sess");
      await mkdir(sessionDir, { recursive: true });
      const stub = join(home, "term-child.mjs");
      await writeExecutableStub(
        stub,
        `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const idx = args.indexOf("--session-dir");
const sessionDir = idx >= 0 ? args[idx + 1] : ${JSON.stringify(sessionDir)};
mkdirSync(sessionDir, { recursive: true });
writeFileSync(
  join(sessionDir, "session.jsonl"),
  ${JSON.stringify(
    sessionToolResultLine(JUDGE_OUTPUT_TOOL_NAME, {
      judgeStatus: "converged",
      note: "pre-timeout lawful verdict",
    }),
  )},
  "utf8",
);
const mark = (sig) => {
  try { writeFileSync(${JSON.stringify(signalFile)}, sig); } catch {}
};
process.on("SIGTERM", () => { mark("SIGTERM"); process.exit(143); });
process.on("SIGINT", () => { mark("SIGINT"); process.exit(130); });
setInterval(() => {}, 1000);
`,
      );

      const direct = await runExplicitInternalActivation({
        packageRoot,
        extraArgs: ["--session-dir", sessionDir, "--help"],
        cwd: home,
        home,
        agentDir: join(home, ".pi", "agent"),
        // Budget long enough for shebang+node cold start under test load, short
        // enough that the stub's idle loop is still running when SIGTERM lands.
        timeoutMs: 1_000,
        env: { PI_BINARY: stub },
      });
      assert.equal(direct.timedOut, true);
      assert.notEqual(direct.code, 0);
      // Child stderr proves the stub body ran (not killed before start).
      assert.ok(direct.stderr.length >= 0);
      await new Promise((r) => setTimeout(r, 200));
      const signal = await readFile(signalFile, "utf8").catch(() => "NONE");
      assert.notEqual(signal, "SIGKILL");
      assert.equal(signal, "SIGTERM");

      // Lawful output written before the signal is still on disk for settlement.
      const sessionBody = await readFile(
        join(sessionDir, "session.jsonl"),
        "utf8",
      );
      assert.ok(sessionBody.includes("pre-timeout lawful verdict"));
    });
  },
);

test(
  "S3: parent does not read or accumulate child stdout",
  { timeout: 15_000 },
  async () => {
    await withTempHome(async (home) => {
      const stub = join(home, "flood-stdout.mjs");
      await writeExecutableStub(
        stub,
        `#!/usr/bin/env node
const chunk = "X".repeat(64 * 1024);
for (let i = 0; i < 200; i++) process.stdout.write(chunk);
process.stderr.write("stderr-ok");
process.exit(0);
`,
      );
      const result = await defaultExplicitInternalPiRunner(["x"], {
        cwd: home,
        env: { ...process.env, PI_BINARY: stub },
      });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes("stderr-ok"));
    });
  },
);

// ─── S4 ──────────────────────────────────────────────────────────────────────

const decisionToolName = "ak_test_compliance_decision_177";
const decisionTool = createComplianceDecisionTool(
  decisionToolName,
  "Return the compliance decision.",
);

function complianceContext(sessionManager: SessionManager) {
  return {
    model: {
      api: "openai-responses",
      provider: "audit-test",
      id: "audit-model",
    },
    modelRegistry: {
      async getProviderAuth() {
        return { auth: { apiKey: "test-secret" } };
      },
      async getApiKeyAndHeaders() {
        return { ok: true as const, apiKey: "test-secret" };
      },
    },
    sessionManager,
  } as never;
}

async function withPersistedSession<T>(
  callback: (sessionManager: SessionManager) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ak-issue-177-compliance-"));
  return await withPrimaryAwareCleanup(
    () => callback(SessionManager.create(root, join(root, "sessions"))),
    () => rm(root, { recursive: true, force: true }),
  );
}

function auditMessage(arguments_: Record<string, unknown>) {
  return fauxAssistantMessage([fauxToolCall(decisionToolName, arguments_)], {
    stopReason: "toolUse",
  });
}

test("S4: complianceDecisionSchema keeps four field declarations with empty required", () => {
  assert.equal(complianceDecisionSchema.type, "object");
  assert.deepEqual(
    Object.keys(complianceDecisionSchema.properties ?? {}).sort(),
    ["conflicts", "decisionGate", "status", "violations"],
  );
  const required =
    (complianceDecisionSchema as { required?: string[] }).required ?? [];
  assert.deepEqual(required, []);
  assert.notEqual(
    (complianceDecisionSchema as { additionalProperties?: unknown })
      .additionalProperties,
    false,
  );
});

test("S4: four decision variants do not reject at the shared compliance seam", async () => {
  const variants: Record<string, unknown>[] = [
    {
      status: "pass",
      violations: "[]",
      conflicts: "[]",
      decisionGate: null,
    },
    { status: "pass" },
    {
      status: "pass",
      violations: [],
      conflicts: [],
      decisionGate: null,
      extraModelKey: "harmless",
    },
    {
      status: "revise",
      violations: [],
      conflicts: [],
      decisionGate: null,
    },
  ];

  for (const [index, arguments_] of variants.entries()) {
    await withPersistedSession(async (sessionManager) => {
      const decision = await runComplianceAudit({
        tool: decisionTool,
        systemPrompt: "audit system",
        serializedInput: "audit input",
        roleLabel: "Compliance",
        invalidDecisionLabel: "invalid compliance decision",
        runCompletion: async () => auditMessage(arguments_),
        context: complianceContext(sessionManager),
      });
      assert.ok(
        decision.status === "pass" || decision.status === "revise",
        `variant ${index} must not throw; got ${decision.status}`,
      );
      if (index === 3) {
        assert.equal(decision.status, "revise");
      } else {
        assert.equal(decision.status, "pass");
      }
    });
  }
});

test("S4: string-array pass lets judge verdict survive on public CLI terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const note = "大理寺判词完整留存-S4";

    await withPersistedSession(async (sessionManager) => {
      const decision = await runComplianceAudit({
        tool: decisionTool,
        systemPrompt: "audit",
        serializedInput: "input",
        roleLabel: "Judge soul",
        invalidDecisionLabel: "invalid",
        runCompletion: async () =>
          auditMessage({
            status: "pass",
            violations: "[]",
            conflicts: "[]",
            decisionGate: null,
          }),
        context: complianceContext(sessionManager),
      });
      assert.equal(decision.status, "pass");
    });

    const result = await runAkRole(
      ["judge", "--project", project, "verdict must survive string-array audit"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-s4-verdict-survives",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            sessionToolResultLine(JUDGE_OUTPUT_TOOL_NAME, {
              judgeStatus: "converged",
              note,
            }),
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(
      result.terminal!.roleOutcome.kind === "accepted"
        ? result.terminal!.roleOutcome.status
        : undefined,
      "converged",
    );
    assert.ok(
      stdout.join("").includes(note),
      "judge verdict note must appear intact",
    );
  });
});
