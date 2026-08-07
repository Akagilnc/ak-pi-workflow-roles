/**
 * #112 public Collector path — explicit PR + leg/author declarations assemble
 * retained manifest; repo defaults from GitHub remote; no prose parsing;
 * session under #78 book; Collector isolation posture preserved.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  COLLECTOR_FIXED_KICKOFF,
  loadCollectorManifest,
} from "../../src/collector-config.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  buildCollectorActivationExtraArgs,
} from "../../src/public-cli/collector-run.ts";
import {
  admitCollectorInvocation,
  parseCollectorArgv,
  parseCollectorLegDeclaration,
  resolveGitHubRemoteRepository,
} from "../../src/public-cli/invocation.ts";
import { markRunAdmitted } from "../../src/public-cli/run-lifecycle.ts";
import {
  assertCollectorReceiptMatchesAdmitted,
  extractCollectorInfrastructureFailure,
  extractCollectorRoleOutcome,
  settleCollectorTerminalResult,
  trySettleCollectorTerminalResult,
} from "../../src/public-cli/settlement.ts";
import {
  COLLECTOR_OBSERVE_TOOL,
} from "../../src/collector-ledger.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

function sampleCollectorReceipt(overrides: {
  repository?: string;
  prNumber?: number;
  manifestDigest?: string;
  legIds?: readonly string[];
} = {}): Record<string, unknown> {
  const legIds = overrides.legIds ?? ["codex"];
  const repository = overrides.repository ?? "acme/widgets";
  const prNumber = overrides.prNumber ?? 12;
  const headOid = "d".repeat(40);
  return {
    host: "github.com",
    repository,
    prNumber,
    manifestDigest: overrides.manifestDigest ?? "c".repeat(64),
    activationTime: "2026-01-01T00:00:00.000Z",
    deadlineTime: "2026-01-01T00:15:00.000Z",
    finalObservationTime: "2026-01-01T00:01:00.000Z",
    finalSnapshotId: "snap-1",
    targetHead: headOid,
    reports: legIds.map((legId) => ({
      kind: "terminal-fact",
      legId,
      terminalStatus: "missing",
      report: "absent",
      windowRelation: "current",
      evidenceRefs: ["snap-1"],
    })),
    legs: legIds.map((legId) => ({
      legId,
      status: "missing",
      rationale: "no review on head",
      evidenceRefs: ["snap-1"],
    })),
    requestAttempts: [],
    snapshots: [
      {
        snapshotId: "snap-1",
        observedAt: "2026-01-01T00:01:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        completedMono: 1,
        host: "github.com",
        repository,
        prNumber,
        prState: "OPEN",
        headOid,
        complete: true,
        evidenceIds: [],
        pageDiagnostics: [],
        normalizedByteLength: 2,
      },
    ],
    evidenceRecords: [],
  };
}

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-collector-"));
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

function seedGitProject(root: string, remoteUrl?: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "collector@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Collector Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
  if (remoteUrl !== undefined) {
    execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: root });
  }
}

function isUsage(error: unknown): boolean {
  return error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";
}

test("parseCollectorLegDeclaration accepts id:author lists and rejects malformed grammar", () => {
  assert.deepEqual(parseCollectorLegDeclaration("codex:CodexBot"), {
    id: "codex",
    expectedAuthors: ["CodexBot"],
  });
  assert.deepEqual(
    parseCollectorLegDeclaration("cursor.bot:Alice,bob-1,Carol_2"),
    {
      id: "cursor.bot",
      expectedAuthors: ["Alice", "bob-1", "Carol_2"],
    },
  );

  const rejected = [
    "",
    ":",
    "codex",
    "codex:",
    ":CodexBot",
    "Codex:bot", // leg id must start lowercase
    "codex: ",
    "codex:Alice,",
    "codex:,Bob",
    "codex:Alice,,Bob",
  ];
  for (const raw of rejected) {
    assert.throws(() => parseCollectorLegDeclaration(raw), isUsage, raw);
  }
});

test("parseCollectorArgv requires positive PR and at least one leg; rejects unknown flags", () => {
  assert.deepEqual(
    parseCollectorArgv([
      "--pr",
      "42",
      "--leg",
      "codex:CodexBot",
      "--leg",
      "cursor:cursor-bot",
      "--repo",
      "Acme/Widgets",
      "--project",
      "/tmp/p",
      "optional note",
    ]),
    {
      prNumber: 42,
      legs: [
        { id: "codex", expectedAuthors: ["CodexBot"] },
        { id: "cursor", expectedAuthors: ["cursor-bot"] },
      ],
      repo: "Acme/Widgets",
      project: "/tmp/p",
      instruction: "optional note",
      attachmentPaths: [],
    },
  );

  assert.throws(() => parseCollectorArgv(["--leg", "codex:bot"]), isUsage);
  assert.throws(
    () => parseCollectorArgv(["--pr", "0", "--leg", "codex:bot"]),
    isUsage,
  );
  assert.throws(
    () => parseCollectorArgv(["--pr", "1a", "--leg", "codex:bot"]),
    isUsage,
  );
  assert.throws(
    () => parseCollectorArgv(["--pr", "1", "--leg", "bad"]),
    isUsage,
  );
  assert.throws(
    () => parseCollectorArgv(["--pr", "1", "--leg", "codex:bot", "--unknown"]),
    isUsage,
  );
  assert.throws(
    () => parseCollectorArgv(["--pr", "1", "--leg", "codex:bot", "--repo", ""]),
    isUsage,
  );
  // Instruction prose is never parsed for PR/legs — bare numbers alone are not enough.
  assert.throws(() => parseCollectorArgv(["42", "please collect codex"]), isUsage);
});

test("resolveGitHubRemoteRepository reads origin owner/repo and rejects non-github remotes", async () => {
  await withTempHome(async (home) => {
    const https = join(home, "https-project");
    await mkdir(https, { recursive: true });
    seedGitProject(https, "https://github.com/OctoCat/Hello-World.git");
    assert.deepEqual(resolveGitHubRemoteRepository(https), {
      display: "OctoCat/Hello-World",
      canonical: "octocat/hello-world",
      owner: "octocat",
      repo: "hello-world",
    });

    const ssh = join(home, "ssh-project");
    await mkdir(ssh, { recursive: true });
    seedGitProject(ssh, "git@github.com:Acme/Widgets.git");
    assert.equal(resolveGitHubRemoteRepository(ssh).canonical, "acme/widgets");

    const bare = join(home, "bare-project");
    await mkdir(bare, { recursive: true });
    seedGitProject(bare, "https://github.com/a/b");
    assert.equal(resolveGitHubRemoteRepository(bare).canonical, "a/b");

    const gitlab = join(home, "gitlab-project");
    await mkdir(gitlab, { recursive: true });
    seedGitProject(gitlab, "https://gitlab.com/a/b.git");
    assert.throws(() => resolveGitHubRemoteRepository(gitlab), isUsage);

    const none = join(home, "no-remote");
    await mkdir(none, { recursive: true });
    seedGitProject(none);
    assert.throws(() => resolveGitHubRemoteRepository(none), isUsage);

    // Extra path / non-identity URL material is not a repository remote.
    const nonRepositoryRemotes = [
      "https://github.com/owner/repo/extra",
      "https://github.com/owner/repo/issues/1",
      "https://github.com/owner/repo.git/info",
      "https://github.com/owner/repo?tab=readme",
      "https://github.com/owner/repo#readme",
      "git@github.com:owner/repo/extra.git",
      "ssh://git@github.com/owner/repo/extra",
    ] as const;
    for (const [index, remoteUrl] of nonRepositoryRemotes.entries()) {
      const bad = join(home, `non-repo-${index}`);
      await mkdir(bad, { recursive: true });
      seedGitProject(bad, remoteUrl);
      assert.throws(
        () => resolveGitHubRemoteRepository(bad),
        isUsage,
        remoteUrl,
      );
    }
  });
});

test("runAkRole collector rejects origin extra-path URL before dispatch", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project, "https://github.com/owner/repo/extra");

    let dispatched = false;
    const captured = captureIo();
    const result = await runAkRole(
      ["collector", "--pr", "1", "--leg", "codex:bot", "--project", project],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        io: captured.io,
        piRunner: async () => {
          dispatched = true;
          throw new Error("collector must not dispatch for non-repository origin URL");
        },
      },
    );
    assert.equal(result.exitCode, 2);
    assert.equal(dispatched, false, "zero dispatch on structural origin reject");
    assert.equal(captured.stdout.join(""), "");
  });
});

test("admitCollectorInvocation assembles retained manifest without request bodies and places session under #78 book", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project, "https://github.com/Acme/Widgets.git");

    const admitted = await admitCollectorInvocation({
      home,
      cwd: project,
      prNumber: 7,
      legs: [
        { id: "codex", expectedAuthors: ["CodexBot", "codex-secondary"] },
        { id: "cursor", expectedAuthors: ["cursor-bot"] },
      ],
      createRunId: () => "run-collector-001",
    });

    assert.equal(admitted.role, "collector");
    assert.equal(admitted.prNumber, 7);
    assert.equal(admitted.repository.canonical, "acme/widgets");
    assert.equal(admitted.repository.display, "Acme/Widgets");

    const bookKey = resolveBookKeyFromGit(project);
    assert.equal(
      admitted.runDirectory,
      join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-collector-001@collector",
      ),
    );
    assert.equal(
      admitted.sessionFile,
      join(admitted.sessionDirectory, "session.jsonl"),
    );

    // Retained manifest path is durable under the run; no request bodies in v1 public path.
    const retained = JSON.parse(await readFile(admitted.legsPath, "utf8")) as {
      legs: Array<Record<string, unknown>>;
    };
    assert.deepEqual(retained.legs, [
      { id: "codex", expectedAuthors: ["CodexBot", "codex-secondary"] },
      { id: "cursor", expectedAuthors: ["cursor-bot"] },
    ]);
    for (const leg of retained.legs) {
      assert.equal(Object.hasOwn(leg, "request"), false);
    }

    const manifest = await loadCollectorManifest(admitted.legsPath);
    assert.equal(manifest.legs.length, 2);
    assert.equal(manifest.digest, admitted.manifestDigest);
    assert.deepEqual([...manifest.legs[0]!.expectedAuthors], [
      "codexbot",
      "codex-secondary",
    ]);

    const persisted = JSON.parse(
      await readFile(admitted.admittedRequestPath, "utf8"),
    ) as {
      role: string;
      prNumber: number;
      repository: string;
      legsPath: string;
      manifestDigest: string;
    };
    assert.equal(persisted.role, "collector");
    assert.equal(persisted.prNumber, 7);
    assert.equal(persisted.repository, "acme/widgets");
    assert.equal(persisted.legsPath, admitted.legsPath);
    assert.equal(persisted.manifestDigest, admitted.manifestDigest);

    // Explicit repo override wins over remote default; malformed override rejects pre-admission.
    const overridden = await admitCollectorInvocation({
      home,
      cwd: project,
      prNumber: 1,
      legs: [{ id: "codex", expectedAuthors: ["bot"] }],
      repo: "Other/Repo",
      createRunId: () => "run-collector-override",
    });
    assert.equal(overridden.repository.canonical, "other/repo");
    assert.equal(overridden.repository.display, "Other/Repo");

    await assert.rejects(
      () =>
        admitCollectorInvocation({
          home,
          cwd: project,
          prNumber: 1,
          legs: [{ id: "codex", expectedAuthors: ["bot"] }],
          repo: "https://github.com/a/b",
          createRunId: () => "run-bad-repo",
        }),
      isUsage,
    );

    await assert.rejects(
      () =>
        admitCollectorInvocation({
          home,
          cwd: project,
          prNumber: 1,
          legs: [
            { id: "a", expectedAuthors: ["same"] },
            { id: "b", expectedAuthors: ["SAME"] },
          ],
          createRunId: () => "run-overlap",
        }),
      isUsage,
    );
  });
});

test("buildCollectorActivationExtraArgs pins isolation, repo/pr/legs flags, and fixed kickoff", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project, "git@github.com:acme/widgets.git");

    const admitted = await admitCollectorInvocation({
      home,
      cwd: project,
      prNumber: 99,
      legs: [{ id: "codex", expectedAuthors: ["CodexBot"] }],
      createRunId: () => "run-collector-args",
    });
    const args = buildCollectorActivationExtraArgs(admitted, {
      model: {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        thinking: "high",
      },
    });

    assert.equal(args.includes("--no-skills"), true);
    assert.equal(args.includes("--no-prompt-templates"), true);
    assert.equal(args.includes("--no-themes"), true);
    assert.equal(args.includes("--no-context-files"), true);
    assert.equal(args.includes("--skill"), false);
    assert.equal(args[args.indexOf("--session") + 1], admitted.sessionFile);
    assert.equal(
      args[args.indexOf("--session-dir") + 1],
      admitted.sessionDirectory,
    );
    assert.equal(args[args.indexOf("--ak-role") + 1], "collector");
    assert.equal(
      args[args.indexOf("--ak-collector-repo") + 1],
      admitted.repository.display,
    );
    assert.equal(args[args.indexOf("--ak-collector-pr") + 1], "99");
    assert.equal(
      args[args.indexOf("--ak-collector-legs") + 1],
      admitted.legsPath,
    );
    assert.equal(args[args.indexOf("--mode") + 1], "json");
    assert.equal(args.at(-1), COLLECTOR_FIXED_KICKOFF);
  });
});

test("extractCollectorRoleOutcome reads accepted receipt decisive facts", () => {
  const receipt = {
    host: "github.com",
    repository: "acme/widgets",
    prNumber: 3,
    manifestDigest: "a".repeat(64),
    activationTime: "2026-01-01T00:00:00.000Z",
    deadlineTime: "2026-01-01T00:15:00.000Z",
    finalObservationTime: "2026-01-01T00:01:00.000Z",
    finalSnapshotId: "snap-1",
    targetHead: "b".repeat(40),
    reports: [
      {
        kind: "terminal-fact",
        legId: "codex",
        terminalStatus: "missing",
        report: "no review",
        windowRelation: "current",
        evidenceRefs: ["snap-1"],
      },
    ],
    legs: [
      {
        legId: "codex",
        status: "missing",
        rationale: "no qualifying review",
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
        prNumber: 3,
        prState: "OPEN",
        headOid: "b".repeat(40),
        complete: true,
        evidenceIds: [],
        pageDiagnostics: [],
        normalizedByteLength: 2,
      },
    ],
    evidenceRecords: [],
  };

  const extracted = extractCollectorRoleOutcome([
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: COLLECTOR_OUTPUT_TOOL,
        isError: false,
        details: receipt,
      },
    },
  ] as never);
  assert.ok(extracted);
  assert.equal(extracted.outcome.role, "collector");
  assert.equal(extracted.outcome.kind, "accepted");
  assert.equal(extracted.outcome.status, "collected");
  assert.equal(extracted.outcome.decisiveFacts.repository, "acme/widgets");
  assert.equal(extracted.outcome.decisiveFacts.prNumber, 3);
  assert.equal(extracted.outcome.decisiveFacts.legStatuses, "codex:missing");
  assert.equal(extracted.outcome.decisiveFacts.targetHead, "b".repeat(40));
});

test("runAkRole collector rejects malformed grammar before admission and does not preflight PR existence", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project, "https://github.com/acme/widgets.git");

    const bad = captureIo();
    const badResult = await runAkRole(
      ["collector", "--pr", "0", "--leg", "codex:bot", "--project", project],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        io: bad.io,
      },
    );
    assert.equal(badResult.exitCode, 2);
    assert.equal(bad.stdout.join(""), "");

    // Well-formed nonexistent PR reaches dispatch (Pi runner records argv) —
    // CLI must not GitHub-preflight the PR number.
    const argvLog = join(home, "collector-pi-argv.json");
    const good = captureIo();
    const goodResult = await runAkRole(
      [
        "collector",
        "--pr",
        "999999",
        "--leg",
        "codex:definitely-not-a-real-bot",
        "--project",
        project,
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        io: good.io,
        createRunId: () => "run-collector-dispatch",
        collectorTimeoutMs: 1_000,
        piRunner: async (args) => {
          await writeFile(argvLog, `${JSON.stringify(args, null, 2)}\n`, "utf8");
          // No lawful session receipt — controlled failure after admission proves
          // the nonexistent PR was not structurally rejected by CLI preflight.
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...args],
          };
        },
        // Inject session contents after dispatch via settlement path tested above;
        // here we only assert argv reached Collector flags for the nonexistent PR.
      },
    );
    // Without a lawful session receipt this is a controlled failure (nonzero),
    // not a structural reject (exit 2) — proving CLI admitted the call.
    assert.notEqual(goodResult.exitCode, 2);
    const recorded = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    assert.equal(recorded[recorded.indexOf("--ak-role") + 1], "collector");
    assert.equal(recorded[recorded.indexOf("--ak-collector-pr") + 1], "999999");
    assert.equal(recorded.includes("--no-skills"), true);
    // Correlation host channel participates when supplied.
  });
});

test("runAkRole collector settles lawful receipt bound to admitted identity with #78 correlation env", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project, "https://github.com/acme/widgets.git");

    let sawCorrelation: string | undefined;
    let boundManifestDigest: string | undefined;
    const { io, stdout } = captureIo();
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
        correlationId: "corr-collector-112",
        io,
        createRunId: () => "run-collector-settle",
        piRunner: async (args, options) => {
          sawCorrelation = options.env.AK_CORRELATION_ID;
          const legsPath = args[args.indexOf("--ak-collector-legs") + 1]!;
          const manifest = await loadCollectorManifest(legsPath);
          boundManifestDigest = manifest.digest;
          const receipt = sampleCollectorReceipt({
            repository: "acme/widgets",
            prNumber: 12,
            manifestDigest: manifest.digest,
            legIds: ["codex"],
          });
          const sessionIdx = args.indexOf("--session");
          const sessionFile = args[sessionIdx + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: COLLECTOR_OUTPUT_TOOL,
                isError: false,
                details: receipt,
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...args],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(sawCorrelation, "corr-collector-112");
    assert.ok(boundManifestDigest);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.role, "collector");
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(
      result.terminal!.roleOutcome.decisiveFacts.legStatuses,
      "codex:missing",
    );
    assert.equal(
      result.terminal!.roleOutcome.decisiveFacts.manifestDigest,
      boundManifestDigest,
    );
    const text = stdout.join("");
    assert.match(text, /collector/);
    // Receipt body lives in run artifacts only (index is zero-content under ADR 0049).
    const reportPath = result.terminal!.artifacts.find((a) => a.kind === "report")
      ?.path;
    assert.ok(reportPath);
    const report = JSON.parse(await readFile(reportPath!, "utf8")) as {
      role: string;
      receipt: { prNumber: number; manifestDigest: string };
    };
    assert.equal(report.role, "collector");
    assert.equal(report.receipt.prNumber, 12);
    assert.equal(report.receipt.manifestDigest, boundManifestDigest);

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-collector-settle@collector",
    );
    const settled = await settleCollectorTerminalResult({
      role: "collector",
      runId: "run-collector-settle",
      bookKey,
      projectRoot: project,
      instruction: "",
      instructionEmpty: true,
      attachments: [],
      runDirectory,
      sessionDirectory: join(runDirectory, "session"),
      sessionFile: join(runDirectory, "session", "session.jsonl"),
      admittedRequestPath: join(runDirectory, "admitted-request.json"),
      prNumber: 12,
      repository: {
        display: "acme/widgets",
        canonical: "acme/widgets",
        owner: "acme",
        repo: "widgets",
      },
      legsPath: join(runDirectory, "legs.json"),
      manifestDigest: boundManifestDigest!,
    });
    assert.equal(settled.roleOutcome.kind, "accepted");
  });
});

test("Collector lawful settlement rejects repository/PR/manifest/leg identity mismatches", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project, "https://github.com/acme/widgets.git");

    const admitted = await admitCollectorInvocation({
      home,
      cwd: project,
      prNumber: 12,
      legs: [
        { id: "codex", expectedAuthors: ["CodexBot"] },
        { id: "cursor", expectedAuthors: ["cursor-bot"] },
      ],
      createRunId: () => "run-collector-bind",
    });

    const writeReceiptSession = async (receipt: Record<string, unknown>) => {
      await mkdir(admitted.sessionDirectory, { recursive: true });
      await writeFile(
        admitted.sessionFile,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolName: COLLECTOR_OUTPUT_TOOL,
            isError: false,
            details: receipt,
          },
        })}\n`,
        "utf8",
      );
    };

    const base = sampleCollectorReceipt({
      repository: admitted.repository.canonical,
      prNumber: admitted.prNumber,
      manifestDigest: admitted.manifestDigest,
      legIds: ["codex", "cursor"],
    });

    await writeReceiptSession(base);
    const ok = await trySettleCollectorTerminalResult(admitted);
    assert.ok(ok);
    assert.equal(ok!.roleOutcome.kind, "accepted");

    const mismatches: Array<{
      label: string;
      receipt: Record<string, unknown>;
      expect: RegExp;
    }> = [
      {
        label: "repository",
        receipt: sampleCollectorReceipt({
          repository: "other/repo",
          prNumber: admitted.prNumber,
          manifestDigest: admitted.manifestDigest,
          legIds: ["codex", "cursor"],
        }),
        expect: /repository/,
      },
      {
        label: "prNumber",
        receipt: sampleCollectorReceipt({
          repository: admitted.repository.canonical,
          prNumber: admitted.prNumber + 1,
          manifestDigest: admitted.manifestDigest,
          legIds: ["codex", "cursor"],
        }),
        expect: /prNumber/,
      },
      {
        label: "manifestDigest",
        receipt: sampleCollectorReceipt({
          repository: admitted.repository.canonical,
          prNumber: admitted.prNumber,
          manifestDigest: "a".repeat(64),
          legIds: ["codex", "cursor"],
        }),
        expect: /manifestDigest/,
      },
      {
        label: "leg set",
        receipt: sampleCollectorReceipt({
          repository: admitted.repository.canonical,
          prNumber: admitted.prNumber,
          manifestDigest: admitted.manifestDigest,
          legIds: ["codex"],
        }),
        expect: /leg set/,
      },
    ];

    for (const case_ of mismatches) {
      await writeReceiptSession(case_.receipt);
      await assert.rejects(
        () => settleCollectorTerminalResult(admitted),
        (error: unknown) => {
          assert.ok(error instanceof Error, case_.label);
          assert.equal(
            (error as { knownCause?: unknown }).knownCause,
            "output",
            case_.label,
          );
          assert.match(error.message, case_.expect, case_.label);
          return true;
        },
      );
      const extracted = extractCollectorRoleOutcome([
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: COLLECTOR_OUTPUT_TOOL,
            isError: false,
            details: case_.receipt,
          },
        },
      ] as never);
      assert.ok(extracted, case_.label);
      assert.throws(
        () =>
          assertCollectorReceiptMatchesAdmitted(
            extracted!.receipt,
            admitted,
            ["codex", "cursor"],
          ),
        case_.expect,
      );
    }

    // Red→green: post-admission legs mutation A→B with receipt digest=A legs=B must fail.
    // Control path above already settled success against unmutated legs.
    await writeFile(
      admitted.legsPath,
      `${JSON.stringify({
        legs: [{ id: "gemini", expectedAuthors: ["GeminiBot"] }],
      }, null, 2)}\n`,
      "utf8",
    );
    const mutatedAttack = sampleCollectorReceipt({
      repository: admitted.repository.canonical,
      prNumber: admitted.prNumber,
      manifestDigest: admitted.manifestDigest,
      legIds: ["gemini"],
    });
    await writeReceiptSession(mutatedAttack);
    await assert.rejects(
      () => settleCollectorTerminalResult(admitted),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { knownCause?: unknown }).knownCause, "output");
        assert.match(error.message, /digest does not match admitted manifestDigest/);
        return true;
      },
    );
  });
});

test("Collector settlement publishes no success artifact when legs mutate after admission", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project, "https://github.com/acme/widgets.git");

    const admitted = await admitCollectorInvocation({
      home,
      cwd: project,
      prNumber: 12,
      legs: [
        { id: "codex", expectedAuthors: ["CodexBot"] },
        { id: "cursor", expectedAuthors: ["cursor-bot"] },
      ],
      createRunId: () => "run-collector-mutate-clean",
    });

    await writeFile(
      admitted.legsPath,
      `${JSON.stringify({
        legs: [{ id: "gemini", expectedAuthors: ["GeminiBot"] }],
      }, null, 2)}\n`,
      "utf8",
    );

    await mkdir(admitted.sessionDirectory, { recursive: true });
    await writeFile(
      admitted.sessionFile,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: COLLECTOR_OUTPUT_TOOL,
          isError: false,
          details: sampleCollectorReceipt({
            repository: admitted.repository.canonical,
            prNumber: admitted.prNumber,
            manifestDigest: admitted.manifestDigest,
            legIds: ["gemini"],
          }),
        },
      })}\n`,
      "utf8",
    );

    await assert.rejects(() => settleCollectorTerminalResult(admitted));
    await assert.rejects(
      () =>
        readFile(join(admitted.runDirectory, "artifacts", "report.json"), "utf8"),
    );
  });
});

test("extractCollectorInfrastructureFailure retains observe HTTP 404 over later noise", () => {
  const failure = extractCollectorInfrastructureFailure([
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: COLLECTOR_OBSERVE_TOOL,
        isError: true,
        content: [
          {
            type: "text",
            text: "Collector observe failed: GitHub /repos/acme/widgets/pulls/999999 failed with HTTP 404",
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "No more faux responses queued",
        provider: "ak-collector-offline",
      },
    },
  ] as never);
  assert.ok(failure);
  assert.equal(failure!.cause, "activation");
  assert.match(failure!.diagnostic, /HTTP 404/);
  assert.match(failure!.diagnostic, /pulls\/999999/);
});

test("runAkRole resume rejects collector runs as one-shot", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project, "https://github.com/acme/widgets.git");

    const admitted = await admitCollectorInvocation({
      home,
      cwd: project,
      prNumber: 1,
      legs: [{ id: "codex", expectedAuthors: ["bot"] }],
      createRunId: () => "run-collector-no-resume",
    });
    // Durable run-state is what resume peeks — mark admitted without dispatch.
    await markRunAdmitted(admitted);

    const { io, stderr } = captureIo();
    const result = await runAkRole(["resume", "run-collector-no-resume"], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: false },
      io,
      piRunner: async () => {
        throw new Error("collector resume must not dispatch");
      },
    });
    assert.equal(result.exitCode, 2);
    assert.match(stderr.join(""), /one-shot|cannot be resumed/i);
  });
});
