/**
 * #1132 — 没交卷先回本人催交，不直接结为 no_receipt.
 *
 * Driven from the public entry (runAkRole) on an **external host**, which is the
 * case the ticket names: pi runs the package role runtime in-process and that
 * runtime issues its own 催交, so the AK execution seam's delivery requests
 * apply to hosts that do not deliver to themselves.
 *
 * The counts come from the one configured value (public-cli.json top-level
 * `autoResumeLimit`) — including 0, which must send nothing. `deliveryTurns`
 * must equal the delivery requests actually issued.
 */
import { assertRunDirectoryHoldsOnlyDossier, historyPayloads } from "../helpers/run-dossier-fixture.ts";
import { readCurrentSection, seedHostSessionId } from "../helpers/run-dossier-fixture.ts";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { randomUUID } from "node:crypto";

import type { RoleTurnRequest, RoleTurnResult } from "../../src/host-contracts.ts";
import { driveExternalRoleTurnRounds } from "../../src/external-host-turn-loop.ts";
import { packagedExternalHostNames } from "../../src/host-descriptions.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { resolveBoundHostSessionId } from "../../src/prepared-role-turn.ts";
import { recordAdmittedCorrelation } from "../../src/public-cli/invocation.ts";
import { findRunDirectoryById, loadResumablePublicRole } from "../../src/public-cli/run-lifecycle.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { createSessionIdentityAuthority } from "../../src/session-identity.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import { CANONICAL_SOURCE_RUN_ID, seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";

import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";

/**
 * Prepared-role-turn binding entry (same resolveBoundHostSessionId headless/ACP use).
 * Kept only for the negative fail-closed case — do not mock that refusal.
 */
async function loadBoundHostSessionLikeAdapter(request: RoleTurnRequest): Promise<string | undefined> {
  const hostName =
    typeof request.host === "string" && request.host.trim() !== ""
      ? request.host.trim()
      : "grok-build";
  return resolveBoundHostSessionId(
    request,
    createSessionIdentityAuthority(piDurablePrincipalAuthority, hostName),
  );
}

async function withSeatHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-1132-", async (home) => {
    await runAkRole(
      ["config", "set", "judge", "test/caller-seat:high", "diarist", "test/caller-seat:high", "countersign", "test/caller-seat:high"],
      { packageRoot, home, io: { stdout() {}, stderr() {} } },
    );
    // The review seats must resolve for 不跳审核 to be observable at all.
    await configurePassingReviewSeats(home);
    return fn(home);
  });
}

/** #1132 怎么验: drive the one configured value through the public config entry. */
async function setConfiguredLimit(home: string, limit: number): Promise<void> {
  await runAkRole(["config", "set-auto-resume-limit", String(limit)], {
    packageRoot,
    home,
    io: { stdout() {}, stderr() {} },
  });
}

type Turn = {
  readonly prompt: string;
  readonly host: string | undefined;
  readonly hostSessionId: string | undefined;
  readonly kind: RoleTurnRequest["continuation"]["kind"];
};

/**
 * One external-host judge turn. The faux host returns cleanly; `sealOnCall`
 * (1-based, across this run's judge turns only) seals a receipt by writing the
 * role's own toolResult into the run's session, as the production adapters
 * surface a submission.
 */
async function runExternalJudge(
  home: string,
  options: {
    readonly runId: string;
    readonly project: string;
    readonly limit: number;
    readonly sealOnCall?: number;
    readonly failOnCall?: number;
}): Promise<{
  readonly turns: readonly Turn[];
  /** Every seat this run dispatched, in order — audit continuation shows up here. */
  readonly seatsDispatched: readonly string[];
  /** This run's directory, so a test can read the final run-state. */
  readonly runDirectory: string | undefined;
  readonly exitCode: number;
  readonly terminal?: TerminalResult;
}> {
  await setConfiguredLimit(home, options.limit);
  const turns: Turn[] = [];
  const seatsDispatched: string[] = [];
  let runDirectorySeen: string | undefined;
  const { io } = captureIo();
  const judgeHost = {
    async executeTurn(request: RoleTurnRequest) {
      if (runDirectorySeen === undefined) runDirectorySeen = request.runDirectory;
      if (request.activation.role !== "judge") {
        return { code: 0, stderr: "", timedOut: false };
      }
      const turn: Turn = {
        prompt: request.continuation.prompt,
        host: request.host,
        hostSessionId:
          request.continuation.kind === "resume" ? request.continuation.hostSessionId : undefined,
        kind: request.continuation.kind,
      };
      turns.push(turn);
      const call = turns.length;
      const coordinates = piDurablePrincipalAuthority.decode(request.principal);
      await mkdir(coordinates.sessionDirectory, { recursive: true });
      await writeFile(
        coordinates.sessionFile,
        `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
        "utf8",
      );
      if (options.failOnCall === call) {
        // A real host failure must never be washed into no_receipt.
        return { code: 1, stderr: "host exploded\n", timedOut: false };
      }
      if (options.sealOnCall === call) {
        // Seal through the production ledger seam, exactly as a role's own
        // submission tool does — a session file alone is not a receipt.
        await sealAcceptedSubmission({
          cwd: request.cwd,
          runId: runIdFromRunDirectory(request.runDirectory)!,
          runDirectory: request.runDirectory,
          role: "judge",
          // #1171: 催交/得卷 tracers are not the missing-ticket soft reask case.
          details: { status: "converged", ticketNumber: 1171 },
          toolCallId: `judge-call-${call}`,
          home: request.home,
        });
      }
      return { code: 0, stderr: "", timedOut: false };
    },
  };
  const reviewing = withPassingReviewHost(judgeHost);
  const host = {
    async executeTurn(request: RoleTurnRequest) {
      seatsDispatched.push(request.activation.role);
      return reviewing.executeTurn(request);
    },
  };
  const result = await runAkRole(
    ["judge", "--host", "grok-build", "--project", options.project, "go"],
    {
      packageRoot,
      home,
      cwd: options.project,
      credentials: { "openai-codex": true, xai: true },
      createRunId: () => options.runId,
      io,
      roleTurnHost: host,
      // Every adapter row uses the faux host so the review chain (auditor /
      // inspector / notary) is observable too — 不跳断言 needs to see it.
      hostAdapters: packagedExternalHostNames()
        .concat("pi")
        .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
    },
  );
  // #1171: a sealed ticketNumber may relocate the leg off the first-seen path.
  const liveDirectory =
    (await findRunDirectoryById(home, options.runId)) ?? runDirectorySeen;
  return {
    turns,
    seatsDispatched,
    runDirectory: liveDirectory,
    exitCode: result.exitCode,
    ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
  };
}

async function freshProject(home: string): Promise<string> {
  const project = join(home, `proj-${Math.random().toString(36).slice(2)}`);
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  return project;
}

// 催交取得卷后走既有审核，不跳审核、不转父席。
test("#1132: a receipt obtained on a催交 turn settles instead of no_receipt", async () => {
  await withSeatHome(async (home) => {
    const project = await freshProject(home);
    const run = await runExternalJudge(home, {
      runId: "1132-external-accepted",
      project,
      limit: 2,
      sealOnCall: 2,
    });

    // One initial turn plus one催交 turn; the second sealed.
    assert.equal(run.turns.length, 2);
    assert.equal(run.turns[0]?.kind, "initial");
    // 催交 rides a native resume of this run's own host session.
    assert.equal(run.turns[1]?.kind, "resume");
    assert.equal(run.turns[1]?.host, "grok-build");
    assert.equal(run.exitCode, 0);
    // The grok-build leg at rest after a催交 resume: only the dossier (#1161).
    assertRunDirectoryHoldsOnlyDossier(run.runDirectory!);
    assert.equal(run.terminal?.roleOutcome.kind, "accepted");
    // 票面 3：不跳审核。The audit handoff happens in the caller
    // (dispatchAdmitted → auditSubmittedRole) on the returned terminal's kind, so
    // a delivery-turn accepted must actually summon a further seat. Judge alone
    // would be exactly the "未经台院" defect #1050 already ruled on.
    assert.ok(
      run.seatsDispatched.some((role) => role !== "judge"),
      `催交得卷后必须进入审核席；只见 ${JSON.stringify(run.seatsDispatched)}`,
    );
    assert.notEqual(run.terminal?.roleOutcome.kind, "no_receipt");
    assert.ok(run.runDirectory !== undefined);
    const runState = readCurrentSection(run.runDirectory!, "runState") as { state: string };
    assert.equal(runState.state, "terminal");
    // Structured ledger surface for this public催交 case (kinds/contents).
    // Same-case base/HEAD per-kind对照 is a one-shot probe, not a second local
    // sealed↔reader mirror that would not prove the old ledger path.
    const sealed = historyPayloads<{ type?: string; accepted?: unknown; toolCallId?: string; role?: string }>(
      run.runDirectory!,
      "sealed",
    );
    assert.deepEqual(
      sealed.map(({ type, accepted, toolCallId, role }) => ({ type, accepted, toolCallId, role })),
      [{ type: "sealed", accepted: { status: "converged", ticketNumber: 1171 }, toolCallId: "judge-call-2", role: "judge" }],
    );
    assert.deepEqual(
      (await readRecordedSubmissionRows(project, "1132-external-accepted", home))
        .map(({ kind, accepted, toolCallId, role }) => ({ kind, accepted, toolCallId, role })),
      [{ kind: "accepted", accepted: { status: "converged", ticketNumber: 1171 }, toolCallId: "judge-call-2", role: "judge" }],
    );
  });
});

// #1132 r3：manual-resume 席位（countersign/notary/secretariat/doctor 等
// inCallAutoResume:false）走 persistRunState=true 一路，deferredPersist 为空，
// 催交得卷出口没有 needsPersist 可补——这才是 run-state 停在 running 的真路径。
test("#1132: 催交得卷 leaves the run terminal on the manual-resume seat path", async () => {
  await withSeatHome(async (home) => {
    const project = await freshProject(home);
    await runAkRole(["config", "set", "countersign", "test/caller-seat:high"], {
      packageRoot, home, io: { stdout() {}, stderr() {} },
    });
    const seatsDispatched: string[] = [];
    let runDirectorySeen: string | undefined;
    let turns = 0;
    const countersignHost = {
      async executeTurn(request: RoleTurnRequest) {
        if (request.activation.role !== "countersign") return { code: 0, stderr: "", timedOut: false };
        if (runDirectorySeen === undefined) runDirectorySeen = request.runDirectory;
        turns += 1;
        const coordinates = piDurablePrincipalAuthority.decode(request.principal);
        await mkdir(coordinates.sessionDirectory, { recursive: true });
        await writeFile(
          coordinates.sessionFile,
          `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
          "utf8",
        );
        if (turns === 2) {
          await sealAcceptedSubmission({
            cwd: request.cwd,
            runId: runIdFromRunDirectory(request.runDirectory)!,
            runDirectory: request.runDirectory,
            role: "countersign",
            details: { status: "converged", ticketNumber: 1171 },
            toolCallId: "countersign-call-2",
            home: request.home,
          });
        }
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const reviewing = withPassingReviewHost(countersignHost);
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        seatsDispatched.push(request.activation.role);
        return reviewing.executeTurn(request);
      },
    };
    await setConfiguredLimit(home, 2);
    const { io } = captureIo();
    const result = await runAkRole(
      ["countersign", "--host", "grok-build", "--project", project, "go"],
      {
        packageRoot, home, cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "1132-countersign-seal",
        io,
        roleTurnHost: host,
        hostAdapters: packagedExternalHostNames()
          .concat("pi")
          .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
      },
    );
    assert.equal(turns, 2, "first turn plus one催交 turn");
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    // The催交 really sealed: the seat continued into its review chain.
    assert.ok(
      seatsDispatched.some((role) => role !== "countersign"),
      `催交得卷必须继续；seats=${JSON.stringify(seatsDispatched)}`,
    );
    assert.ok(runDirectorySeen !== undefined);
    const liveDirectory =
      (await findRunDirectoryById(home, "1132-countersign-seal")) ?? runDirectorySeen!;
    const runState = readCurrentSection(liveDirectory, "runState") as { state: string };
    assert.equal(runState.state, "terminal", "催交得卷 must leave the run terminal");
  });
});

// 会签首轮走专用投影，已解析上限必须跟到这一轮，不能退回包默认。
test("#1132: a countersign first turn carries the configured delivery ceiling", async () => {
  for (const limit of [0, 5]) {
    await withSeatHome(async (home) => {
      await setConfiguredLimit(home, limit);
      const project = await freshProject(home);
      await runAkRole(["config", "set", "countersign", "test/caller-seat:high"], {
        packageRoot, home, io: { stdout() {}, stderr() {} },
      });
      let turns = 0;
      const seenLimits: Array<number | undefined> = [];
      const host = {
        async executeTurn(request: RoleTurnRequest) {
          if (request.activation.role !== "countersign") return { code: 0, stderr: "", timedOut: false };
          turns += 1;
          seenLimits.push(request.deliveryRequestLimit);
          const coordinates = piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(coordinates.sessionDirectory, { recursive: true });
          await writeFile(
            coordinates.sessionFile,
            `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
            "utf8",
          );
          return { code: 0, stderr: "", timedOut: false };
        },
      };
      const result = await runAkRole(
        ["countersign", "--host", "grok-build", "--project", project, "go"],
        {
          packageRoot, home, cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => `1132-countersign-limit-${limit}`,
          io: captureIo().io,
          roleTurnHost: host,
          hostAdapters: packagedExternalHostNames()
            .concat("pi")
            .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
        },
      );
      assert.deepEqual(seenLimits, Array.from({ length: limit + 1 }, () => limit), `limit ${limit}`);
      assert.equal(turns, limit + 1, `limit ${limit}`);
      assert.equal(result.exitCode, 0, `limit ${limit}`);
      assert.equal(result.terminal?.roleOutcome.kind, "no_receipt", `limit ${limit}`);
      if (result.terminal?.roleOutcome.kind !== "no_receipt") return;
      assert.equal(result.terminal.roleOutcome.deliveryTurns, limit, `limit ${limit}`);
    });
  }
});

/**
 * Production closeRound (prepareRoleEnvelope + driveExternalRoleTurnRounds).
 * The first round submits unfinished with no reason; later rounds submit nothing.
 */
async function driveFixerCloseRound(
  request: RoleTurnRequest,
  rounds: { count: number },
): Promise<RoleTurnResult> {
  const prepared = await prepareRoleEnvelope({
    request: { ...request, host: "codex" },
    dependencies: createRoleRuntimeDependencies(packageRoot),
    socketPath: `/tmp/ak-1132-mcp-${randomUUID()}.sock`,
    listTerminatingToolOnMcp: false,
    sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
    principalAuthority: piDurablePrincipalAuthority,
    });
  try {
    return await driveExternalRoleTurnRounds(prepared, request, {
      roundLimitName: "StructuredOutputRoundLimit",
      currentSessionId: () => undefined,
      async runRound() {
        rounds.count += 1;
        if (rounds.count === 1) {
          // #1171: unfinished still seals accepted; carry ticket so soft reask
          // does not steal a second round from the delivery-count tracer.
          await prepared.ingestStructuredOutput({ status: "unfinished", ticketNumber: 1171 });
        }
        return { status: "delivered" };
      },
    });
  } finally {
    await prepared.dispose?.();
  }
}

// closeRound 重交、失败续跑、催交实发次数各计各的。limit 0 时缺理由不再被催。
test("#1132: closeRound reasks and failure recovery stay off the delivery count", async () => {
  await withSeatHome(async (home) => {
    const project = await freshProject(home);
    await setConfiguredLimit(home, 0);
    const silentRounds = { count: 0 };
    const silentHost = {
      async executeTurn(request: RoleTurnRequest) {
        return driveFixerCloseRound(request, silentRounds);
      },
    };
    const silentIo = captureIo();
    const silent = await runAkRole(
      ["fixer", "--host", "grok-build", "--model", "test/caller-seat:high", "--project", project, "apply", "Stop without a reason."],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "1132-fixer-limit-zero",
        io: silentIo.io,
        roleTurnHost: silentHost,
        hostAdapters: packagedExternalHostNames()
          .concat("pi")
          .map((name) => ({ name, create: () => ({ ok: true as const, host: silentHost }) })),
      },
    );
    assert.equal(silentRounds.count, 1, "limit 0 does not reask an unfinished submission");
    assert.equal(silent.exitCode, 0);
    assert.equal(silent.terminal?.roleOutcome.kind, "accepted");

    await setConfiguredLimit(home, 1);
    const rounds = { count: 0 };
    let failedDelivery = false;
    let outerCalls = 0;
    // Deterministic fixture ops: initial = closeRound; later resumes = 催交 then
    // failure recovery — do not infer identity from prompt text (#1208).
    const host = {
      async executeTurn(request: RoleTurnRequest): Promise<RoleTurnResult> {
        outerCalls += 1;
        if (request.continuation.kind === "initial") {
          return driveFixerCloseRound(request, rounds);
        }
        if (!failedDelivery) {
          failedDelivery = true;
          return { code: 1, stderr: "host exploded\n", timedOut: false };
        }
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const loopIo = captureIo();
    const run = await runAkRole(
      ["fixer", "--host", "grok-build", "--model", "test/caller-seat:high", "--project", project, "apply", "Stop without a reason."],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "1132-fixer-loops",
        io: loopIo.io,
        roleTurnHost: host,
        hostAdapters: packagedExternalHostNames()
          .concat("pi")
          .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
      },
    );
    assert.equal(rounds.count, 2, "one closeRound reask beyond the first round");
    assert.equal(failedDelivery, true, "the delivery failure entered auto-resume");
    assert.ok(outerCalls > 2, `failure recovery must dispatch again; calls=${outerCalls}`);
    const outcome = run.terminal?.roleOutcome;
    assert.equal(outcome?.kind, "no_receipt");
    if (outcome?.kind !== "no_receipt") return;
    assert.equal(outcome.deliveryTurns, 1, "closeRound rounds and the failed send stay at the issued count");
    const failedAttempts = (outcome.decisiveFacts as { failedAttempts?: readonly unknown[] } | undefined)?.failedAttempts;
    assert.ok((failedAttempts?.length ?? 0) >= 1, "the host failure stays on the record");
  });
});

// 催交额度用满仍无卷才由结算接缝记 no_receipt；deliveryTurns 记实发次数。
test("#1132: no_receipt records the delivery requests actually issued", async () => {
  for (const limit of [0, 1, 3]) {
    await withSeatHome(async (home) => {
      const run = await runExternalJudge(home, {
        runId: `1132-external-no-receipt-${limit}`,
        project: await freshProject(home),
        limit,
      });

      // First turn plus exactly N催交 turns.
      assert.equal(run.turns.length, limit + 1, `limit ${limit}`);
      assert.equal(run.exitCode, 0, `limit ${limit}`);
      const outcome = run.terminal?.roleOutcome;
      assert.equal(outcome?.kind, "no_receipt", `limit ${limit}`);
      if (outcome?.kind !== "no_receipt") return;
      assert.equal(outcome.deliveryTurns, limit, `limit ${limit}: count must be what went out`);
    });
  }
});

// 首轮之外最多 N 次 — #1208: 催交重发本轮实际输入；次数在终局 deliveryTurns。
test("#1132/#1208: each催交 turn resends this turn's actual prompt", async () => {
  await withSeatHome(async (home) => {
    const run = await runExternalJudge(home, {
      runId: "1132-external-content",
      project: await freshProject(home),
      limit: 2,
    });
    assert.equal(run.turns.length, 3);
    assert.equal(run.turns[0]?.prompt, "go");
    assert.equal(run.turns[1]?.prompt, "go");
    assert.equal(run.turns[2]?.prompt, "go");
    assert.equal(run.terminal?.roleOutcome.kind, "no_receipt");
    if (run.terminal?.roleOutcome.kind !== "no_receipt") return;
    assert.equal(run.terminal.roleOutcome.deliveryTurns, 2);
  });
});

// 催交中的宿主失败留在 failedAttempts，并让这次跑离开 running。
test("#1132: a failing催交 turn records the host failure and leaves the run out of running", async () => {
  await withSeatHome(async (home) => {
    const run = await runExternalJudge(home, {
      runId: "1132-external-delivery-failure",
      project: await freshProject(home),
      limit: 2,
      failOnCall: 2,
    });
    // The failed催交 is resumed. Later silent turns settle no_receipt, and the
    // issued count includes the request that failed, not a fresh budget.
    assert.ok(run.turns.length > 2, `auto-resume must continue after the failure; turns=${run.turns.length}`);
    assert.equal(run.terminal?.roleOutcome.kind, "no_receipt");
    if (run.terminal?.roleOutcome.kind !== "no_receipt") return;
    assert.equal(run.terminal.roleOutcome.deliveryTurns, 2);
    const failedAttempts = (
      run.terminal.roleOutcome.decisiveFacts as { failedAttempts?: readonly unknown[] } | undefined
    )?.failedAttempts;
    assert.ok((failedAttempts?.length ?? 0) >= 1);
    assert.ok(run.runDirectory !== undefined);
    const runState = readCurrentSection(run.runDirectory, "runState") as { state: string };
    assert.notEqual(runState.state, "running");
  });
});

// 子席结论读不出三态：回本人重问，次数与别的循环分开，用尽后留下已有终局。
test("#1132: an unreadable gate-child conclusion reasks only up to the configured limit", async () => {
  const sideways = {
    role: "notary" as const,
    toolName: NOTARY_OUTPUT_TOOL_NAME,
    details: { status: "sideways", ticketNumber: 1171},
    seal: true,
  };
  const openNotary = (home: string, project: string, sourceRunPath: string, runId: string) =>
    runAkRole(
      ["new", "notary", "--model", "test/caller-seat:high", "--source-run", sourceRunPath],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io: captureIo().io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedTerminatingToolSession(sideways),
        }),
      },
    );

  for (const limit of [0, 1]) {
    await withSeatHome(async (home) => {
      await setConfiguredLimit(home, limit);
      const project = await freshProject(home);
      const sourceRunPath = await seedCanonicalSourceRun(home, project);
      const notaryRunId = `1132-notary-unreadable-${limit}`;
      const opened = await openNotary(home, project, sourceRunPath, notaryRunId);
      assert.equal(opened.exitCode, 0, `limit ${limit} open`);
      assert.equal(opened.terminal?.roleOutcome.kind, "accepted", `limit ${limit} open`);
      const loaded = await loadResumablePublicRole(home, notaryRunId, piDurablePrincipalAuthority);
      await recordAdmittedCorrelation(loaded.admitted, CANONICAL_SOURCE_RUN_ID);

      let calls = 0;
      const resumed = await runAkRole(
        ["resume", "--model", "test/caller-seat:high", notaryRunId],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          io: captureIo().io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
              calls += 1;
              return scriptedTerminatingToolSession({
                ...sideways,
                toolCallId: `call_notary_${calls}`,
              })(args, options);
            },
          }),
        },
      );
      assert.equal(calls, limit + 1, `limit ${limit}: resume plus at most ${limit} reasks`);
      assert.equal(resumed.exitCode, 0, `limit ${limit}`);
      assert.equal(resumed.terminal?.roleOutcome.kind, "accepted", `limit ${limit}`);
      if (resumed.terminal?.roleOutcome.kind !== "accepted") return;
      const statuses = payloadStatusSequence(resumed.terminal.roleOutcome);
      assert.equal(statuses.at(-1), "sideways", `limit ${limit}: kept terminal stays outside the three states`);
      assert.ok(
        statuses.every((status) => status !== "converged" && status !== "continue" && status !== "escalate"),
        `limit ${limit}: ${statuses.join(",")}`,
      );
    });
  }
});

// 审核封驳续跑仍用配置里的催交额度，不把这一轮的上限改成 0。
test("#1132: an audit continue resumes the submitted seat with its delivery budget", async () => {
  await withSeatHome(async (home) => {
    await setConfiguredLimit(home, 2);
    const project = await freshProject(home);
    const judgeRunId = "1132-audit-continue-budget";
    let judgeCalls = 0;
    const seatsDispatched: string[] = [];
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        seatsDispatched.push(request.activation.role);
        const coordinates = piDurablePrincipalAuthority.decode(request.principal);
        await mkdir(coordinates.sessionDirectory, { recursive: true });
        await writeFile(
          coordinates.sessionFile,
          `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
          "utf8",
        );
        if (request.activation.role === "judge") {
          judgeCalls += 1;
          if (judgeCalls === 1) {
            await sealAcceptedSubmission({
              cwd: request.cwd,
              runId: runIdFromRunDirectory(request.runDirectory)!,
              runDirectory: request.runDirectory,
              role: "judge",
              details: { status: "continue", ticketNumber: 1171},
              toolCallId: "judge-continue",
              home: request.home,
            });
          }
          return { code: 0, stderr: "", timedOut: false };
        }
        if (request.activation.role === "notary") {
          await sealAcceptedSubmission({
            cwd: request.cwd,
            runId: runIdFromRunDirectory(request.runDirectory)!,
            runDirectory: request.runDirectory,
            role: "notary",
            details: { status: "continue", ticketNumber: 1171},
            toolCallId: "notary-continue",
            home: request.home,
          });
        }
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const { io } = captureIo();
    const result = await runAkRole(
      ["judge", "--host", "grok-build", "--project", project, "go"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => judgeRunId,
        io,
        roleTurnHost: host,
        hostAdapters: packagedExternalHostNames()
          .concat("pi")
          .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
      },
    );
    assert.ok(seatsDispatched.includes("notary"), JSON.stringify(seatsDispatched));
    assert.equal(judgeCalls, 4, `audit continue must keep the configured delivery budget; seats=${JSON.stringify(seatsDispatched)}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
    if (result.terminal?.roleOutcome.kind !== "no_receipt") return;
    assert.equal(result.terminal.roleOutcome.deliveryTurns, 2);
  });
});

// 读不出三态的审核召唤用尽配置次数后留下该回执，不把父席再送去改。
test("#1132: an unreadable audit officer stops at the ceiling without resuming the parent", async () => {
  for (const limit of [0, 1, 3]) {
    await withSeatHome(async (home) => {
      await setConfiguredLimit(home, limit);
      const project = await freshProject(home);
      let judgeCalls = 0;
      let notaryCalls = 0;
      const host = {
        async executeTurn(request: RoleTurnRequest) {
          const coordinates = piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(coordinates.sessionDirectory, { recursive: true });
          await writeFile(
            coordinates.sessionFile,
            `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
            "utf8",
          );
          if (request.activation.role === "judge") {
            judgeCalls += 1;
            if (judgeCalls === 1) {
              await sealAcceptedSubmission({
                cwd: request.cwd,
                runId: runIdFromRunDirectory(request.runDirectory)!,
                runDirectory: request.runDirectory,
                role: "judge",
                details: { status: "continue", ticketNumber: 1171},
                toolCallId: "judge-continue",
                home: request.home,
              });
            }
            return { code: 0, stderr: "", timedOut: false };
          }
          if (request.activation.role === "notary") {
            notaryCalls += 1;
            await sealAcceptedSubmission({
              cwd: request.cwd,
              runId: runIdFromRunDirectory(request.runDirectory)!,
              runDirectory: request.runDirectory,
              role: "notary",
              details: { status: "sideways", revision: notaryCalls, ticketNumber: 1171},
              toolCallId: `notary-sideways-${notaryCalls}`,
              home: request.home,
              ...(request.courtAttemptId === undefined ? {} : { courtAttemptId: request.courtAttemptId }),
            });
          }
          return { code: 0, stderr: "", timedOut: false };
        },
      };
      const result = await runAkRole(
        ["judge", "--host", "grok-build", "--project", project, "go"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => `1132-audit-unreadable-stop-${limit}`,
          io: captureIo().io,
          roleTurnHost: host,
          hostAdapters: packagedExternalHostNames()
            .concat("pi")
            .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
        },
      );
      assert.equal(judgeCalls, 1, `limit ${limit}: parent is not resumed for revision`);
      assert.equal(notaryCalls, limit + 1, `limit ${limit}`);
      assert.equal(result.exitCode, 0, `limit ${limit}`);
      // #1195: unreadable audit returns the actual officer volume — not a parent copy.
      assert.equal(result.terminal?.roleOutcome.kind, "accepted", `limit ${limit}`);
      assert.equal(result.terminal?.roleOutcome.role, "notary", `limit ${limit}`);
      if (result.terminal?.roleOutcome.kind !== "accepted") return;
      assert.equal(result.terminal.roleOutcome.decisiveFacts?.directionUnsettled, true);
      assert.equal(result.terminal.roleOutcome.decisiveFacts?.subsequentAudit, "incomplete");
      assert.equal(
        result.terminal.roleOutcome.decisiveFacts?.officerPayloads,
        undefined,
        "parent/other-seat payload copies must not ride the returned terminal",
      );
      // This-court volume: submissions carry reask history when present; else payloads.
      const volume = (result.terminal.submissions !== undefined && result.terminal.submissions.length > 0
        ? result.terminal.submissions
        : result.terminal.roleOutcome.payloads ?? []) as readonly { status?: string; revision?: number }[];
      assert.equal(volume.at(-1)?.status, "sideways");
      assert.deepEqual(
        volume.map((payload) => payload.revision),
        Array.from({ length: limit + 1 }, (_, index) => index + 1),
      );
      assert.equal(typeof result.terminal.runId, "string");
    });
  }
});

// 同一不可读会签结论只由门召唤计次。直召会签仍用席位自己的额度。
test("#1132: one unreadable countersign conclusion spends one budget", async () => {
  for (const limit of [0, 1]) {
    await withSeatHome(async (home) => {
      await setConfiguredLimit(home, limit);
      await runAkRole(
        ["config", "set", "secretariat", "test/caller-seat:high", "notary", "test/caller-seat:high", "auditor", "test/caller-seat:high"],
        { packageRoot, home, io: { stdout() {}, stderr() {} } },
      );
      const project = await freshProject(home);
      const calls: Record<string, number> = {};
      const host = {
        async executeTurn(request: RoleTurnRequest) {
          const role = request.activation.role;
          calls[role] = (calls[role] ?? 0) + 1;
          const coordinates = piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(coordinates.sessionDirectory, { recursive: true });
          await writeFile(
            coordinates.sessionFile,
            `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
            "utf8",
          );
          const details = role === "secretariat"
            ? { secretariatStatus: "converged", ticketNumber: 1132 }
            : role === "countersign"
              ? { status: "sideways", ticketNumber: 1132 }
              : role === "diarist"
                ? { status: "completed", ticketNumber: 1132, sessions: [] }
                : { status: "converged", ticketNumber: 1132 };
          await sealAcceptedSubmission({
            cwd: request.cwd,
            runId: runIdFromRunDirectory(request.runDirectory)!,
            runDirectory: request.runDirectory,
            role,
            details,
            ...(request.courtAttemptId === undefined ? {} : { courtAttemptId: request.courtAttemptId }),
            toolCallId: `${role}-${calls[role]}`,
            home: request.home,
          });
          return { code: 0, stderr: "", timedOut: false };
        },
      };
      const env = {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true as const, xai: true as const },
        io: captureIo().io,
        roleTurnHost: host,
        hostAdapters: packagedExternalHostNames()
          .concat("pi")
          .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
      };
      const opened = await runAkRole(
        ["secretariat", "--host", "grok-build", "--project", project, "go"],
        { ...env, createRunId: () => `1132-secretariat-countersign-${limit}` },
      );
      assert.equal(calls.secretariat, 1, `limit ${limit}`);
      assert.equal(calls.countersign, limit + 1, `limit ${limit}`);
      assert.equal(opened.exitCode, 0, `limit ${limit}`);
      assert.equal(opened.terminal?.roleOutcome.kind, "accepted", `limit ${limit}`);
      // #1195: resume identity is the actual audit seat, not a parent-side copy field.
      assert.equal(opened.terminal?.roleOutcome.role, "countersign", `limit ${limit}`);
      assert.equal(opened.terminal?.roleOutcome.decisiveFacts?.directionUnsettled, true, `limit ${limit}`);
      assert.equal(
        opened.terminal?.roleOutcome.decisiveFacts?.officerPayloads,
        undefined,
        `limit ${limit}: no other-seat payload copy`,
      );
      const officerRunId = opened.terminal?.runId;
      assert.equal(typeof officerRunId, "string", `limit ${limit}`);
      const beforeResume = calls.countersign ?? 0;
      const resumed = await runAkRole(["resume", officerRunId!], env);
      assert.equal((calls.countersign ?? 0) - beforeResume, limit + 1, `limit ${limit} resume`);
      assert.equal(calls.secretariat, 1, `limit ${limit} resume`);
      assert.equal(resumed.exitCode, 0, `limit ${limit} resume`);
    });
  }
});

// 首轮已经启动后，催交 resume 经适配器 binding load 失败；不得派发旧 id。
test("#1132: a delivery assembly failure after the turn started resumes the session", async () => {
  await withSeatHome(async (home) => {
    await setConfiguredLimit(home, 1);
    const project = await freshProject(home);
    const kinds: string[] = [];
    const resumedWith: Array<string | undefined> = [];
    let runDirectory: string | undefined;
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        runDirectory = request.runDirectory;
        kinds.push(request.continuation.kind);
        if (request.continuation.kind === "resume") {
          // In-call delivery leaves hostSessionId absent (host-contracts). The
          // adapter — not the dispatch layer — loads the live binding and must
          // refuse damaged state instead of reusing a prior id.
          resumedWith.push(request.continuation.hostSessionId);
          await loadBoundHostSessionLikeAdapter(request);
        }
        const coordinates = piDurablePrincipalAuthority.decode(request.principal);
        await mkdir(coordinates.sessionDirectory, { recursive: true });
        await writeFile(
          coordinates.sessionFile,
          `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
          "utf8",
        );
        // Valid bind then syntax-corrupt state.jsonl — next resume load fails closed.
        seedHostSessionId(dirname(coordinates.sessionDirectory), "grok-build", "old-native");
        appendFileSync(join(dirname(coordinates.sessionDirectory), "state.jsonl"), "not JSON\n");
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    // #1171: this case injects control-plane damage to exercise resume binding
    // fail-closed — not missing-ticket discovery. Bind the ticket up front so
    // post-host board re-read is not owed; damage still fails closed on the
    // resume adapter load (original failure path below). Do not wash unbound
    // board-read damage into "no ticket".
    const result = await runAkRole(
      ["judge", "--host", "grok-build", "--project", project, "go"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "1132-delivery-assembly-failure",
        boundTicketNumber: 1171,
        io: captureIo().io,
        roleTurnHost: host,
        hostAdapters: packagedExternalHostNames()
          .concat("pi")
          .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
      },
    );
    // Damage is appended after the initial turn. Exactly one bare resume
    // reaches the adapter (hostSessionId absent); identity.load refuses.
    assert.deepEqual(kinds, ["initial", "resume"]);
    assert.deepEqual(resumedWith, [undefined]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.terminal?.roleOutcome.kind, "failure");
    assert.equal(result.terminal?.autoResumeCount, 1);
    if (result.terminal?.roleOutcome.kind === "failure") {
      // state.jsonl syntax damage fails closed on the control plane. Dedicated
      // binding-file JSON.parse used to surface SyntaxError (BASE); the shared
      // state volume's control readers refuse with Error (readPageSync class).
      assert.equal(result.terminal.roleOutcome.decisiveFacts.errorName, "Error");
    }
    assert.ok(runDirectory !== undefined);
    // Syntax damage fails closed for every control-plane page read, so
    // markRunTerminal cannot flip runState (best-effort note beside the failure
    // terminal — same persistence disposition as main). Do not pretend terminal.
    const runState = readCurrentSection(runDirectory!, "runState") as { state?: string };
    assert.equal(runState.state, "running");
  });
});
