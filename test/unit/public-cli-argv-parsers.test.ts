import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
// #420 整改移档（自 test/integration/public-cli-{coder,collector,doctor,fixer,engine-axis}.test.ts）：
// 纯 parser / typed resolver 按性质归位快档。契约断言一字不减；
// 真 admission（冻结 FS）与真子进程条仍留 integration。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp as mkdtempFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import type { DoctorOutput } from "../../src/doctor-contracts.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitCoderInvocation,
  parseCoderArgv,
  parseCollectorArgv,
  parseDoctorArgv,
  parseFixerArgv,
} from "../../src/public-cli/invocation.ts";
import { extractDoctorRoleOutcome, formatTerminalResult } from "../../src/public-cli/settlement.ts";
import {
  resolveEffectiveSeat,
  setPersistentSeatConfig,
  setPersistentSeatEngine,
} from "../../src/public-cli/config.ts";

const credentials = { "openai-codex": true, xai: true } as const;

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtempFs(join(tmpdir(), "ak-public-cli-parsers-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "parser@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Parser Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

test("parseCoderArgv defaults to apply and preserves explicit plan|apply", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.deepEqual(parseCoderArgv(["Implement the slice."]), {
    phase: "apply",
    instruction: "Implement the slice.",
    attachmentPaths: [],
  });
  assert.deepEqual(parseCoderArgv(["plan", "Propose first cut."]), {
    phase: "plan",
    instruction: "Propose first cut.",
    attachmentPaths: [],
  });
  assert.deepEqual(
    parseCoderArgv([
      "apply",
      "--attach",
      "a.md",
      "--project",
      "/tmp/p",
      "Do the work.",
    ]),
    {
      phase: "apply",
      instruction: "Do the work.",
      attachmentPaths: ["a.md"],
      project: "/tmp/p",
    },
  );
  assert.throws(() => parseCoderArgv(["--unknown-flag"]), isUsage);
  assert.throws(() => parseCoderArgv(["--project", "", "task"]), isUsage);
});

test("admitCoderInvocation rejects blank task and freezes phase + attachments", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    await assert.rejects(
      () =>
        admitCoderInvocation({
      principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          phase: "apply",
          instruction: "   ",
          attachmentPaths: [],
        }),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    const source = join(home, "notes.txt");
    await writeFile(source, "attachment-v1", "utf8");
    const admitted = await admitCoderInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      phase: "plan",
      instruction: "Plan the first vertical slice.",
      attachmentPaths: [source],
      createRunId: () => "run-coder-plan-001",
    });
    assert.equal(admitted.role, "coder");
    assert.equal(admitted.phase, "plan");
    assert.equal(admitted.instruction, "Plan the first vertical slice.");
    assert.equal(await readFile(admitted.taskPath, "utf8"), "Plan the first vertical slice.");
    assert.equal(admitted.attachments.length, 1);
    assert.equal(await readFile(admitted.attachments[0]!.frozenPath, "utf8"), "attachment-v1");

    const bookKey = resolveBookKeyFromGit(project);
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "runs", "run-coder-plan-001@coder"),
    );
    const persisted = JSON.parse(
      await readFile(admitted.admittedRequestPath, "utf8"),
    ) as { phase: string; role: string };
    assert.equal(persisted.role, "coder");
    assert.equal(persisted.phase, "plan");
  });
});

test("public Collector accepts PR/repository without an observer declaration", () => {
  assert.deepEqual(parseCollectorArgv(["--pr", "1168", "--repo", "acme/widgets"]), {
    prNumber: 1168,
    repo: "acme/widgets",
    instruction: "",
    attachmentPaths: [],
  });
});

test("parseDoctorArgv requires positive issue; accepts optional runs and rejects malformed grammar", () => {
  assert.deepEqual(parseDoctorArgv(["--issue", "40", "note"]), {
    issueNumber: 40,
    instruction: "note",
    attachmentPaths: [],
  });
  assert.deepEqual(
    parseDoctorArgv([
      "--issue",
      "7",
      "--runs",
      ".ak-roles/books/demo/issues/7/runs",
      "--project",
      "/tmp/p",
      "--attach",
      "/tmp/a.md",
    ]),
    {
      issueNumber: 7,
      runs: ".ak-roles/books/demo/issues/7/runs",
      project: "/tmp/p",
      attachmentPaths: ["/tmp/a.md"],
      instruction: "",
    },
  );

  const rejected = [
    [],
    ["--issue"],
    ["--issue", "0"],
    ["--issue", "01"],
    ["--issue", "-3"],
    ["--issue", "1a"],
    ["--issue", "1.5"],
    ["--issue", "1", "--runs"],
    ["--issue", "1", "--runs", ""],
    ["--issue", "1", "--unknown"],
    ["40"], // bare number is not a typed issue selector
  ] as const;
  for (const raw of rejected) {
    assert.throws(() => parseDoctorArgv([...raw]), (error: unknown) => error instanceof CliUsageError && error.code === "AK_ROLE_USAGE", JSON.stringify(raw));
  }
});

function sampleCompletedDoctorOutput(
  identity: { issueNumber: number; runsPath: string },
): DoctorOutput {
  return {
    status: "completed",
    case: identity,
    findings: [],
    cost: {
      invocations: { count: 1, sources: ["review-001"] },
      legs: { count: 1, sources: ["review-001/session/leg.jsonl"] },
      modelApiTurns: { count: 1, sources: ["review-001/session/leg.jsonl"] },
      outputTokens: { count: 7, sources: ["review-001/session/leg.jsonl"] },
      toolCalls: { count: 1, sources: ["review-001/session/leg.jsonl"] },
      retries: {
        count: 0,
        sources: [],
        evidence: "literal run-dir naming",
      },
      statuses: [
        { source: "review-001/session/leg.jsonl", status: "completed" },
      ],
      commits: [],
      sessions: [
        {
          source: "review-001/session/leg.jsonl",
          startedAt: "2026-08-01T05:01:18.580Z",
          endedAt: "2026-08-01T05:01:20.000Z",
          wallMilliseconds: 1420,
          completion: "accepted",
        },
      ],
      outputBytes: {
        count: 1,
        sources: ["review-001/session/leg.jsonl"],
        payload: "raw JSONL bytes",
        providerWireBytes: "unavailable",
      },
    },
  };
}

test("extractDoctorRoleOutcome reads completed and refused decisive facts", () => {
  const identity = {
    issueNumber: 40,
    runsPath: ".ak-roles/books/demo/issues/40/runs",
  };
  const completed = {
    ...sampleCompletedDoctorOutput(identity),
    auditNoReceipt: {
      status: "no-receipt",
      terminalToolCalled: false,
      rejectedReceipts: [],
      deliveryTurns: 2,
      sessionCompletion: "settled-without-accepted-receipt",
      runPointer: "/doctor-audit/run",
      attemptPointer: "doctor-audit-attempt",
      acceptedReceipt: false,
    },
  };
  const extracted = extractDoctorRoleOutcome([
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: DOCTOR_OUTPUT_TOOL_NAME,
        isError: false,
        details: completed,
      },
    },
  ] as never);
  assert.ok(extracted);
  assert.equal(extracted.outcome.role, "doctor");
  assert.equal(extracted.outcome.kind, "accepted");
  assert.equal(extracted.outcome.status, "completed");
  assert.equal(extracted.outcome.decisiveFacts.issueNumber, 40);
  assert.equal(extracted.outcome.decisiveFacts.findingsCount, 0);
  assert.equal((extracted.outcome.decisiveFacts.auditNoReceipt as { acceptedReceipt?: unknown })?.acceptedReceipt, false);
  assert.match(formatTerminalResult({
    roleOutcome: extracted.outcome,
    navigator: { disposition: "no-advice" },
    artifacts: [],
    runId: "doctor-run",
  }), /auditNoReceipt/);
  assert.equal(
    extracted.outcome.decisiveFacts.runsPath,
    identity.runsPath,
  );

  const refused: DoctorOutput = {
    status: "refused",
    reason: "Session bytes are incomplete.",
    missingEvidence: [{ need: "session header", targetKeys: ["case"] }],
  };
  const refusedExtracted = extractDoctorRoleOutcome([
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: DOCTOR_OUTPUT_TOOL_NAME,
        isError: false,
        details: refused,
      },
    },
  ] as never);
  assert.ok(refusedExtracted);
  assert.equal(refusedExtracted.outcome.status, "refused");
  assert.equal(
    refusedExtracted.outcome.decisiveFacts.reason,
    "Session bytes are incomplete.",
  );
  assert.equal(refusedExtracted.outcome.decisiveFacts.missingEvidenceCount, 1);
});

test("parseFixerArgv defaults to apply and preserves explicit plan|apply plus prerequisites path", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.deepEqual(parseFixerArgv(["Repair the class."]), {
    phase: "apply",
    instruction: "Repair the class.",
    attachmentPaths: [],
  });
  assert.deepEqual(parseFixerArgv(["plan", "Propose the repair."]), {
    phase: "plan",
    instruction: "Propose the repair.",
    attachmentPaths: [],
  });
  assert.deepEqual(
    parseFixerArgv([
      "apply",
      "--prerequisites",
      "prereq.json",
      "--attach",
      "a.md",
      "--project",
      "/tmp/p",
      "Settle findings.",
    ]),
    {
      phase: "apply",
      instruction: "Settle findings.",
      attachmentPaths: ["a.md"],
      prerequisitesPath: "prereq.json",
      project: "/tmp/p",
    },
  );
  assert.throws(() => parseFixerArgv(["--unknown-flag"]), isUsage);
  assert.throws(() => parseFixerArgv(["--prerequisites", ""]), isUsage);
  assert.throws(() => parseFixerArgv(["--project", "", "task"]), isUsage);
});

test("engine priority: invocation > persistent > unconfigured (judge only)", () => {
  const config = setPersistentSeatEngine(
    setPersistentSeatConfig(
      { seats: {} },
      "judge",
      { provider: "xai", model: "grok-4.5", thinking: "high" },
    ),
    "judge",
    "cursor",
  );

  const fromPersistent = resolveEffectiveSeat(config, "judge", credentials);
  assert.equal(fromPersistent.engine, "cursor");
  assert.equal(fromPersistent.engineSource, "persistent");
  assert.equal(fromPersistent.source, "persistent");

  const fromInvocation = resolveEffectiveSeat(config, "judge", credentials, {
    engine: "opus",
  });
  assert.equal(fromInvocation.engine, "opus");
  assert.equal(fromInvocation.engineSource, "invocation");
  // Model still from persistent when only engine is overridden.
  assert.equal(fromInvocation.source, "persistent");
  assert.deepEqual(fromInvocation.selection, {
    provider: "xai",
    model: "grok-4.5",
    thinking: "high",
  });

  const bare = resolveEffectiveSeat({ seats: {} }, "judge", credentials);
  assert.equal(bare.engine, undefined);
  assert.equal(bare.engineSource, "unconfigured");

  // Reviewer seat attaches engine the same way (#378).
  const reviewerConfig = setPersistentSeatEngine(
    setPersistentSeatConfig(
      { seats: {} },
      "reviewer",
      { provider: "xai", model: "grok-4.5", thinking: "high" },
    ),
    "reviewer",
    "cursor",
  );
  const reviewerPersistent = resolveEffectiveSeat(reviewerConfig, "reviewer", credentials);
  assert.equal(reviewerPersistent.engine, "cursor");
  assert.equal(reviewerPersistent.engineSource, "persistent");
  const reviewerInvocation = resolveEffectiveSeat(reviewerConfig, "reviewer", credentials, {
    engine: "opus",
  });
  assert.equal(reviewerInvocation.engine, "opus");
  assert.equal(reviewerInvocation.engineSource, "invocation");

  // Fixer seat attaches engine the same way (#391).
  const fixer = resolveEffectiveSeat({ seats: {} }, "fixer", credentials, {
    engine: "opus",
  });
  assert.equal(fixer.engine, "opus");
  assert.equal(fixer.engineSource, "invocation");
});
