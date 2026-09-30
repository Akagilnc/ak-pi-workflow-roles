import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
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
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { packagedExternalHostNames } from "../../src/host-descriptions.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { configurePassingReviewSeats } from "../helpers/passing-review-host.ts";

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) },
  };
}

function seedGitProject(root: string) {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "1132@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "1132"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
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
  /**
   * #1132: observed on every turn — the run-state fields and the turn-BEFORE
   * hooks a催交 turn must NOT re-run.
   */
  readonly onTurn?: (observation: {
    readonly call: number;
    readonly when: "before" | "after";
    readonly runState: { readonly state?: unknown; effectiveEngine?: unknown };
  }) => void;
}): Promise<{
  readonly turns: readonly Turn[];
  /** Every seat this run dispatched, in order — audit continuation shows up here. */
  readonly seatsDispatched: readonly string[];
  readonly exitCode: number;
  readonly terminal?: TerminalResult;
}> {
  await setConfiguredLimit(home, options.limit);
  const turns: Turn[] = [];
  const seatsDispatched: string[] = [];
  let runDirectorySeen: string | undefined;
  const { io } = captureIo();
  const host = {
    async executeTurn(request: RoleTurnRequest) {
      seatsDispatched.push(request.activation.role);
      if (runDirectorySeen === undefined) runDirectorySeen = request.runDirectory;
      // Only this run's judge turns are counted as催交; review seats share the
      // faux host and are recorded separately (they prove the audit handoff).
      if (request.runDirectory !== runDirectorySeen || request.activation.role !== "judge") {
        return { code: 0, stderr: "", timedOut: false };
      }
      const turn: Turn = {
        prompt: request.continuation.prompt,
        hostSessionId:
          request.continuation.kind === "resume" ? request.continuation.hostSessionId : undefined,
        kind: request.continuation.kind,
      };
      turns.push(turn);
      const call = turns.length;
      const observe = async (when: "before" | "after"): Promise<void> => {
        options.onTurn?.({
          call,
          when,
          runState: JSON.parse(
            await readFile(join(request.runDirectory, "run-state.json"), "utf8"),
          ) as { state?: unknown; effectiveEngine?: unknown },
        });
      };
      await observe("before");
      const coordinates = piDurablePrincipalAuthority.decode(request.principal);
      await mkdir(coordinates.sessionDirectory, { recursive: true });
      await writeFile(
        coordinates.sessionFile,
        `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
        "utf8",
      );
      if (options.failOnCall === call) {
        // A real host failure must never be washed into no_receipt.
        await observe("after");
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
          details: { status: "converged" },
          toolCallId: `judge-call-${call}`,
          home: request.home,
        });
      }
      await observe("after");
      return { code: 0, stderr: "", timedOut: false };
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
  return {
    turns,
    seatsDispatched,
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
    const run = await runExternalJudge(home, {
      runId: "1132-external-accepted",
      project: await freshProject(home),
      limit: 2,
      sealOnCall: 2,
    });

    // One initial turn plus one催交 turn; the second sealed.
    assert.equal(run.turns.length, 2);
    assert.equal(run.turns[0]?.kind, "initial");
    // 催交 rides a native resume of this run's own host session.
    assert.equal(run.turns[1]?.kind, "resume");
    // 票面 3：不跳审核。The audit handoff happens in the caller
    // (dispatchAdmitted → auditSubmittedRole) on the returned terminal's kind, so
    // a delivery-turn accepted must actually summon a further seat. Judge alone
    // would be exactly the "未经台院" defect #1050 already ruled on.
    assert.ok(
      run.seatsDispatched.some((role) => role !== "judge"),
      `催交得卷后必须进入审核席；只见 ${JSON.stringify(run.seatsDispatched)}`,
    );
    assert.notEqual(run.terminal?.roleOutcome.kind, "no_receipt");
  });
});

// 变异真跑：去掉催交接线（deliveryTurn: true 传回 / 审核接线）本测试应报红。
test("#1132: 催交得卷 reaches the audit seat, not a bare accepted", async () => {
  await withSeatHome(async (home) => {
    const run = await runExternalJudge(home, {
      runId: "1132-external-audit-continuation",
      project: await freshProject(home),
      limit: 2,
      sealOnCall: 2,
    });
    const nonJudge = run.seatsDispatched.filter((role) => role !== "judge");
    assert.ok(
      nonJudge.length > 0,
      `a催交-sealed judge must continue into review; seats=${JSON.stringify(run.seatsDispatched)}`,
    );
  });
});


// #1132 变异真跑目标：催交轮不得重跑 turn-BEFORE 钩子，也不得中途落终局。
test("#1132: 催交 turns keep run-state running and the engine of the first turn", async () => {
  await withSeatHome(async (home) => {
    const observed: { call: number; when: string; state?: unknown; effectiveEngine?: unknown }[] = [];
    const run = await runExternalJudge(home, {
      runId: "1132-external-run-state",
      project: await freshProject(home),
      limit: 2,
      onTurn: ({ call, when, runState }) => observed.push({ call, when, ...runState }),
    });

    assert.equal(run.turns.length, 3, "first turn plus two催交 turns");
    // The run must never look lawfully terminal WHILE催交 is still in progress:
    // only the outermost turn settles run-state, so every observation up to and
    // including the last still-silent催交 turn must read `running`. A mid-loop
    // persist would show `terminal` here and strand a killed process (#1132).
    const lastStillSilent = observed.filter((seen) => seen.when === "after").at(-1)!;
    for (const seen of observed.filter((item) => item.call <= 2)) {
      assert.equal(seen.state, "running", `turn ${seen.call} (${seen.when}) must not be terminal mid-催交`);
    }
    assert.ok(lastStillSilent !== undefined);
    // The engine recorded at admission survives every催交 turn (effectiveEngine
    // is forwarded; a dropped parameter would blank it on the re-dispatch).
    const engines = new Set(observed.map((seen) => JSON.stringify(seen.effectiveEngine)));
    assert.equal(engines.size, 1, `engine must not change across turns: ${JSON.stringify(observed)}`);
  });
});

// 各循环分别计次：催交轮内 closeRound 重交不虚增 deliveryTurns。
test("#1132: a delivery turn's internal re-ask rounds do not inflate deliveryTurns", async () => {
  await withSeatHome(async (home) => {
    // closeRound inside a delivery turn re-prompts the same host session; the
    // count must still be exactly the number of催交 turns the AK seam issued.
    const run = await runExternalJudge(home, {
      runId: "1132-external-nested-reask",
      project: await freshProject(home),
      limit: 2,
    });
    const outcome = run.terminal?.roleOutcome;
    assert.equal(outcome?.kind, "no_receipt");
    if (outcome?.kind !== "no_receipt") return;
    assert.equal(outcome.deliveryTurns, 2);
    // One initial turn plus two催交 turns — never the nested product.
    assert.equal(run.turns.length, 3);
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

// 首轮之外最多 N 次 — the 催交 bodies carry the count already spent.
test("#1132: each催交 turn carries pi's existing delivery-state content", async () => {
  await withSeatHome(async (home) => {
    const run = await runExternalJudge(home, {
      runId: "1132-external-content",
      project: await freshProject(home),
      limit: 2,
    });
    assert.equal(run.turns.length, 3);
    // Not the initial prompt — the same typed delivery state pi already uses.
    assert.notEqual(run.turns[1]?.prompt, "go");
    const first = JSON.parse(run.turns[1]!.prompt) as { deliveryTurns: number; acceptedReceipt: boolean };
    assert.equal(first.acceptedReceipt, false);
    assert.equal(first.deliveryTurns, 1);
    const second = JSON.parse(run.turns[2]!.prompt) as { deliveryTurns: number };
    assert.equal(second.deliveryTurns, 2);
  });
});

// 真实宿主失败不洗成 no_receipt：a failing催交 keeps its cause.
test("#1132: a failing催交 turn is a real failure, never no_receipt", async () => {
  await withSeatHome(async (home) => {
    const run = await runExternalJudge(home, {
      runId: "1132-external-delivery-failure",
      project: await freshProject(home),
      limit: 2,
      failOnCall: 2,
    });
    assert.notEqual(run.terminal?.roleOutcome.kind, "no_receipt");
    assert.equal(run.exitCode, 1);
  });
});