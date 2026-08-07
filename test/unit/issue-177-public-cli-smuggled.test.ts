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
  COMPLIANCE_BOOKKEEPING_UNREADABLE,
  createComplianceDecisionTool,
  runComplianceAudit,
} from "../../src/compliance-transport.ts";
import { disposeComplianceDecision } from "../../src/audit-escalation.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { loadDoctorCase } from "../../src/doctor-evidence.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { loadCollectorManifest } from "../../src/collector-config.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import {
  JUDGE_ACCEPTED_TEXT,
  JUDGE_OUTPUT_TOOL_NAME,
} from "../../src/package-contracts/judge-output.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/fixer-output.ts";
import {
  createPiJudgeAuditor,
  JUDGE_AUDIT_TOOL_NAME,
} from "../../src/judge-auditor.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  defaultExplicitInternalPiRunner,
  runExplicitInternalActivation,
} from "../../src/public-cli/explicit-internal.ts";
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

    // Real negative: decisiveFacts missing one option fails the same face checks.
    const incomplete = {
      ...result.terminal!,
      roleOutcome: {
        ...result.terminal!.roleOutcome,
        decisiveFacts: {
          ...result.terminal!.roleOutcome.decisiveFacts,
          decisionOptions: [REAL_ESCALATE_GATE.options[0]],
        },
      },
    };
    const incompletePresented = formatTerminalResult(incomplete);
    assert.equal(
      incompletePresented.includes(REAL_ESCALATE_GATE.options[1]),
      false,
      "face built without the second option must fail the option-presence check",
    );
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

// Reviewer/merger S2 withheld coverage lives in public-cli-reviewer.test.ts and
// public-cli-merger.test.ts (artifact receipt body), not a typeof/length stand-in.

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
  { timeout: 30_000 },
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
// Idle forever — any positive budget still finds the loop running (no "short enough" constraint).
setInterval(() => {}, 1000);
`,
      );

      const direct = await runExplicitInternalActivation({
        packageRoot,
        extraArgs: ["--session-dir", sessionDir, "--help"],
        cwd: home,
        home,
        agentDir: join(home, ".pi", "agent"),
        // Cold-start headroom under parallel load (handler install observed ~0.5s cold).
        // Stub loops forever, so a wider budget does not race past idle.
        timeoutMs: 8_000,
        env: { PI_BINARY: stub },
      });
      assert.equal(direct.timedOut, true);
      assert.notEqual(direct.code, 0);
      await new Promise((r) => setTimeout(r, 200));
      const signal = await readFile(signalFile, "utf8").catch(() => "NONE");
      // signalFile content is the observable proof the stub body ran and handled SIGTERM.
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
      // Child started and finished (exit 0) with stderr recovered; stdout is not a result field.
      assert.equal(result.code, 0);
      assert.equal(Object.hasOwn(result, "stdout"), false);
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

function judgeAuditMessage(arguments_: Record<string, unknown>) {
  return fauxAssistantMessage(
    [fauxToolCall(JUDGE_AUDIT_TOOL_NAME, arguments_)],
    { stopReason: "toolUse" },
  );
}

test("S4: mixed violations keep every entry; #179 string-array pass does not abort", async () => {
  await withPersistedSession(async (sessionManager) => {
    const revise = await runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      runCompletion: async () =>
        fauxAssistantMessage(
          [
            fauxToolCall(decisionToolName, {
              status: "revise",
              violations: ["real", 4],
            }),
          ],
          { stopReason: "toolUse" },
        ),
      context: complianceContext(sessionManager),
    });
    assert.equal(revise.status, "revise");
    if (revise.status === "revise") {
      assert.deepEqual(revise.violations, ["real", 4]);
    }

    const pass = await runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      runCompletion: async () =>
        fauxAssistantMessage(
          [
            fauxToolCall(decisionToolName, {
              status: "pass",
              violations: "[]",
              conflicts: "[]",
              decisionGate: null,
            }),
          ],
          { stopReason: "toolUse" },
        ),
      context: complianceContext(sessionManager),
    });
    assert.equal(pass.status, "pass");
  });
});

test("S4: unknown or missing compliance status is marked unreadable, not pass", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["unknown status", { status: "maybe", violations: [] }],
    ["missing status", {}],
  ];
  for (const [name, arguments_] of cases) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout } = captureIo();
      const note = `大理寺判词保留-${name}`;
      const verdict = { judgeStatus: "converged" as const, note };

      let sessionPayload = "";
      await withPersistedSession(async (sessionManager) => {
        const auditor = createPiJudgeAuditor(async () =>
          judgeAuditMessage(arguments_),
        );
        const decision = await auditor(
          {
            soul: "THE JUDGE LAW",
            transcript: "THE ADJUDICATION RECORD",
            verdict,
          },
          { context: complianceContext(sessionManager) },
        );
        assert.equal(decision.status, "escalate", name);
        if (decision.status === "escalate") {
          assert.ok(
            decision.conflicts.includes(COMPLIANCE_BOOKKEEPING_UNREADABLE),
            name,
          );
          // Unreadable path: honest conflict only — no forged option (class 2).
          assert.deepEqual(decision.decisionGate.options, []);
        }
        // Same seam judge-role uses: pass the already-delivered verdict through.
        const toolResult = await disposeComplianceDecision(
          decision,
          {
            pass: () => {
              throw new Error(`${name}: must not take the pass path`);
            },
            revise: () => {
              throw new Error(`${name}: must not take the revise path`);
            },
            escalate: (result) => result,
          },
          verdict,
        );
        sessionPayload = sessionToolResultLine(
          JUDGE_OUTPUT_TOOL_NAME,
          toolResult.details,
        );
        assert.ok(
          sessionPayload.includes(COMPLIANCE_BOOKKEEPING_UNREADABLE),
          `${name}: unreadable marker must land in the session produced by this decision`,
        );
        assert.ok(
          sessionPayload.includes(note),
          `${name}: delivered verdict note must survive into session bytes`,
        );
        assert.equal(
          sessionPayload.includes(JUDGE_ACCEPTED_TEXT),
          false,
          `${name}: must not accept the verdict`,
        );
      });

      const result = await runAkRole(
        ["judge", "--project", project, `unreadable bookkeeping ${name}`],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => `run-s4-unreadable-${name.replace(/\s+/g, "-")}`,
          io,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(
              join(sessionDir, "session.jsonl"),
              sessionPayload,
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

      assert.equal(result.exitCode, 0, name);
      assert.ok(result.terminal, name);
      assert.equal(result.terminal!.roleOutcome.kind, "audit_escalation", name);
      const facts = result.terminal!.roleOutcome.decisiveFacts as Record<
        string,
        unknown
      >;
      // ADR 0055: delivered verdict fields arrive on the terminal face, not destroyed.
      assert.equal(facts.judgeStatus, "converged", name);
      assert.equal(facts.note, note, name);
      const face = stdout.join("");
      assert.ok(
        face.includes(COMPLIANCE_BOOKKEEPING_UNREADABLE),
        `${name}: terminal face must mark bookkeeping unreadable`,
      );
      assert.ok(
        face.includes(note),
        `${name}: terminal face must keep the delivered verdict note`,
      );
      assert.equal(
        face.includes(JUDGE_ACCEPTED_TEXT),
        false,
        `${name}: must not show Judge verdict accepted`,
      );
    });
  }
});

test("S4: escalate recogniser keeps mixed-type and empty-gate upgrades lawful on public CLI", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "non-string conflict",
      {
        kind: "audit_escalation",
        conflicts: ["ok", 4],
        decisionGate: { question: "Q", options: ["A"] },
        report: "fixer-delivered-report-mixed-conflict",
        status: "completed",
      },
    ],
    [
      "non-string option",
      {
        kind: "audit_escalation",
        conflicts: ["c"],
        decisionGate: { question: "Q", options: ["A", 7] },
        report: "fixer-delivered-report-mixed-option",
        status: "completed",
      },
    ],
    [
      "empty decisionGate",
      {
        kind: "audit_escalation",
        conflicts: ["only-conflict"],
        decisionGate: { question: "", options: [] },
        report: "fixer-delivered-report-empty-gate",
        status: "completed",
      },
    ],
  ];

  for (const [name, details] of cases) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout } = captureIo();
      const sessionPayload = sessionToolResultLine(
        FIXER_OUTPUT_TOOL_NAME,
        details,
      );

      const result = await runAkRole(
        ["fixer", "apply", "--project", project, `escalation shape ${name}`],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () =>
            `run-s4-escalate-shape-${name.replace(/\s+/g, "-")}`,
          io,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(
              join(sessionDir, "session.jsonl"),
              sessionPayload,
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

      assert.equal(result.exitCode, 0, name);
      assert.ok(result.terminal, `${name}: must produce a terminal result`);
      assert.equal(
        result.terminal!.roleOutcome.kind,
        "audit_escalation",
        `${name}: must be recognised as audit_escalation, not controlled failure`,
      );
      const facts = result.terminal!.roleOutcome.decisiveFacts as Record<
        string,
        unknown
      >;
      assert.deepEqual(facts.conflicts, details.conflicts, name);
      assert.deepEqual(facts.decisionGate, details.decisionGate, name);
      // Shared-seam proof: fixer-delivered fields ride the same escalate face.
      assert.equal(facts.report, details.report, name);
      assert.equal(facts.status, details.status, name);
      const face = stdout.join("");
      assert.ok(
        face.includes("audit_escalation"),
        `${name}: face names the escalation kind`,
      );
      assert.equal(
        result.terminal!.roleOutcome.kind === "audit_escalation",
        true,
      );
    });
  }
});

test("S4: stripping delivered verdict from escalate path fails the retention assertion", async () => {
  // Negative: if buildAuditEscalationResult stops merging delivered output,
  // this test goes red — not a self-proving rewrite of the positive path.
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const note = "大理寺判词保留-negative-strip";
    const verdict = { judgeStatus: "converged" as const, note };
    const decision = {
      status: "escalate" as const,
      conflicts: [COMPLIANCE_BOOKKEEPING_UNREADABLE],
      decisionGate: { question: "", options: [] as unknown[] },
    };
    // Deliberately omit delivered output — the retention seam under test.
    const toolResult = await disposeComplianceDecision(decision, {
      pass: () => {
        throw new Error("must not pass");
      },
      revise: () => {
        throw new Error("must not revise");
      },
      escalate: (result) => result,
    });
    const sessionPayload = sessionToolResultLine(
      JUDGE_OUTPUT_TOOL_NAME,
      toolResult.details,
    );
    assert.equal(
      sessionPayload.includes(note),
      false,
      "negative control: stripped path must not contain the verdict note",
    );

    const result = await runAkRole(
      ["judge", "--project", project, "negative strip verdict"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-s4-negative-strip",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), sessionPayload, "utf8");
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal!.roleOutcome.kind, "audit_escalation");
    const facts = result.terminal!.roleOutcome.decisiveFacts as Record<
      string,
      unknown
    >;
    assert.equal(facts.note, undefined);
    assert.equal(facts.judgeStatus, undefined);
    // The positive suite asserts these fields ARE present when verdict is piped;
    // this negative proves the assertion is load-bearing, not tautological.
    assert.notDeepEqual(verdict, {
      judgeStatus: facts.judgeStatus,
      note: facts.note,
    });
  });
});

test("S4: compliance decision causally gates judge verdict on public CLI terminal", async () => {
  const variants: Array<[string, Record<string, unknown>, "pass" | "revise"]> = [
    [
      "string-array pass (#179)",
      {
        status: "pass",
        violations: "[]",
        conflicts: "[]",
        decisionGate: null,
      },
      "pass",
    ],
    ["status-only pass", { status: "pass" }, "pass"],
    [
      "extra-key pass",
      {
        status: "pass",
        violations: [],
        conflicts: [],
        decisionGate: null,
        extraModelKey: "harmless",
      },
      "pass",
    ],
    [
      "empty-violations revise",
      {
        status: "revise",
        violations: [],
        conflicts: [],
        decisionGate: null,
      },
      "revise",
    ],
  ];

  for (const [name, auditArgs, expectedStatus] of variants) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout } = captureIo();
      const note = `大理寺判词完整留存-S4-${name}`;
      const verdict = { judgeStatus: "converged" as const, note };

      // Session bytes are produced only from this decision — not an independent fixture.
      let sessionPayload: string | undefined;
      await withPersistedSession(async (sessionManager) => {
        const auditor = createPiJudgeAuditor(async () =>
          judgeAuditMessage(auditArgs),
        );
        const decision = await auditor(
          {
            soul: "THE JUDGE LAW",
            transcript: "THE ADJUDICATION RECORD",
            verdict,
          },
          { context: complianceContext(sessionManager) },
        );
        assert.equal(decision.status, expectedStatus, name);

        // Same dispose path judge-role uses: only pass writes accepted details.
        if (decision.status === "pass") {
          const toolResult = await disposeComplianceDecision(decision, {
            pass: (usage) => ({
              content: [
                { type: "text" as const, text: JUDGE_ACCEPTED_TEXT },
              ],
              details: verdict,
              terminate: true as const,
              ...(usage === undefined ? {} : { usage }),
            }),
            revise: () => {
              throw new Error(`${name}: pass variant must not revise`);
            },
            escalate: () => {
              throw new Error(`${name}: pass variant must not escalate`);
            },
          });
          sessionPayload = sessionToolResultLine(
            JUDGE_OUTPUT_TOOL_NAME,
            toolResult.details,
          );
          assert.ok(
            sessionPayload.includes(note),
            `${name}: verdict note must land in the session this decision produced`,
          );
        } else {
          // revise: compliance did not abort; accepted verdict is not written.
          sessionPayload = undefined;
        }
      });

      if (expectedStatus === "revise") {
        assert.equal(
          sessionPayload,
          undefined,
          `${name}: revise must not produce an accepted session payload`,
        );
        return;
      }

      assert.ok(sessionPayload, name);
      const result = await runAkRole(
        ["judge", "--project", project, `verdict survives ${name}`],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () =>
            `run-s4-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
          io,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            // Settle the SAME session bytes the compliance decision produced.
            await writeFile(
              join(sessionDir, "session.jsonl"),
              sessionPayload!,
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

      assert.equal(result.exitCode, 0, name);
      assert.ok(result.terminal, name);
      assert.equal(result.terminal!.roleOutcome.kind, "accepted", name);
      assert.equal(
        result.terminal!.roleOutcome.kind === "accepted"
          ? result.terminal!.roleOutcome.status
          : undefined,
        "converged",
        name,
      );
      assert.ok(
        stdout.join("").includes(note),
        `${name}: judge verdict note must appear intact on the public CLI face`,
      );
    });
  }
});
