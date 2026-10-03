import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import type { HostContext, HostToolDefinition, HostToolResult, RoleHost } from "../../src/host-contracts.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { GatekeeperDecisionError } from "../../src/gatekeeper-role.ts";
import { packagedRoleOutputTool } from "../../src/packaged-role-registry.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { WorkerUnfinishedReasonReminderError } from "../../src/worker-submission-gates.ts";
import { publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { Type } from "typebox";
import { readCurrentJson, seedCurrentSection } from "../helpers/run-dossier-fixture.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import {
  createSubmissionLedgerHost,
  readRecordedSubmissionRows,
  readRecordedSubmissions,
} from "../../src/submission-ledger.ts";

/** Sole unbound run path for this fixture (docs/dossier-topology.md no-ticket nest). */
function fixtureUnboundRunDirectory(root: string, runLeaf: string): string {
  return `${root}/.ak-roles/books/fixture/unbound/runs/${runLeaf}`;
}

function registerTool(
  root: string,
  execute: (params?: unknown) => Promise<HostToolResult<unknown>> = async (params) => ({
    content: [],
    // Default: echo params as details so ledger params≡details unless a test overrides.
    details: params !== undefined && params !== null && typeof params === "object" && !Array.isArray(params) && Object.keys(params as object).length > 0
      ? params
      : { status: "converged" },
    terminate: true,
  }),
  outputTool = JUDGE_OUTPUT_TOOL_NAME,
  role: TerminalRoleName = "judge",
) {
  let registered: HostToolDefinition | undefined;
  const deliveredRejections: unknown[] = [];
  const closedSubmissions: unknown[] = [];
  const host = {
    deliverSubmissionRejection(rejection: unknown) { deliveredRejections.push(rejection); },
    registerTool(tool: HostToolDefinition) { registered = tool; },
  } as RoleHost;
  const pipeline = createSubmissionLedgerHost(host, new Map([[outputTool, role]]), undefined, async (projection) => {
    closedSubmissions.push(projection);
  }, { home: root });
  pipeline.registerTool({
    name: outputTool,
    label: "output",
    description: "",
    parameters: Type.Object({}),
    execute: async (_id, params) => execute(params),
  });
  // HostContext.runDirectory is the admitted run coordinate (#879) — must sit
  // inside the ledger home so restore/append share one ownership path.
  const runDirectory = fixtureUnboundRunDirectory(root, `run-ledger@${role}`);
  mkdirSync(`${runDirectory}/session`, { recursive: true });
  writeFileSync(`${runDirectory}/session/session.jsonl`, "");
  const context = {
    cwd: root,
    mode: "json",
    model: undefined,
    runDirectory,
    sessionManager: {
      getHeader: () => ({ type: "session", id: "run-ledger:attempt" }),
      getLeafEntry: () => undefined,
      getLeafId: () => null,
      getEntries: () => [],
      getSessionDir: () => `${runDirectory}/session`,
      getSessionFile: () => `${runDirectory}/session/session.jsonl`,
    },
    abort() { throw new Error("ledger must not abort the host (#836)"); },
  } as unknown as HostContext;
  return {
    context,
    deliveredRejections,
    closedSubmissions,
    tool: () => registered!,
    // Calls are recorded on execute; there is no turn-end bookkeeping to prime.
    start: async (_id: string, _name = JUDGE_OUTPUT_TOOL_NAME) => {},
  };
}

async function fixture() {
  const root = await mkdtemp(worktreeTempPrefix("ak-submission-ledger-"));
  execFileSync("git", ["init", "-q", root]);
  const runDirectory = fixtureUnboundRunDirectory(root, "run-ledger@judge");
  await mkdir(`${runDirectory}/session`, { recursive: true });
  await writeFile(`${runDirectory}/session/session.jsonl`, "");
  return { root, ...registerTool(root) };
}

const JUDGE_RUN_LEAF = "run-ledger@judge";

/** The run's history.jsonl read raw, the way an outside reader sees it. */
async function historyRows(runDirectory: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(`${runDirectory}/history.jsonl`, "utf8");
  return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function withLedgerFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorCourt = process.env.AK_ROLE_COURT_ATTEMPT;
  const f = await fixture();
  process.env.AK_ROLE_RUN_DIR = fixtureUnboundRunDirectory(f.root, "run-ledger@judge");
  delete process.env.AK_ROLE_COURT_ATTEMPT;
  await withPrimaryAwareCleanup(
    () => run(f),
    async () => {
      if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = priorRun;
      if (priorCourt === undefined) delete process.env.AK_ROLE_COURT_ATTEMPT;
      else process.env.AK_ROLE_COURT_ATTEMPT = priorCourt;
    },
    async () => {
      await rm(f.root, { recursive: true, force: true });
    },
  );
}



test("non-object params stay raw on accepted/submissions — no envelope wrap (#836 bounce)", async () => {
  await withLedgerFixture(async (f) => {
    const host = registerTool(
      f.root,
      async () => ({ content: [], details: { ignored: true }, terminate: true }),
    );
    await host.start("raw");
    await host.tool().execute("raw", "plain-string-submission", undefined, undefined, host.context);
    const all = await readRecordedSubmissions(f.root, "run-ledger", f.root);
    assert.equal(all.length, 1);
    assert.equal(all[0], "plain-string-submission");
  });
});

test("ledger records LLM params, not rewritten result.details (#836 bounce)", async () => {
  await withLedgerFixture(async (f) => {
    const params = { status: "converged", report: "from-llm-params" };
    const details = { status: "converged", report: "from-tool-result", injected: true };
    const host = registerTool(
      f.root,
      async () => ({ content: [], details, terminate: true }),
    );
    await host.start("p1");
    await host.tool().execute("p1", params, undefined, undefined, host.context);
    const rows = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.deepEqual(rows[0]?.accepted, params, "ledger must keep LLM params");
    assert.notDeepEqual(rows[0]?.accepted, details, "must not store rewritten tool result");
    const all = await readRecordedSubmissions(f.root, "run-ledger", f.root);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], params);
  });
});

test("one turn two submissions → two ledger rows; original payload returned; no abort (#836)", async () => {
  await withLedgerFixture(async (f) => {
    await f.start("first");
    const firstPayload = { status: "converged" };
    const first = await f.tool().execute("first", firstPayload, undefined, undefined, f.context);
    assert.equal(first.terminate, true);
    assert.deepEqual(first.details, firstPayload);
    assert.deepEqual(await readRecordedSubmissionRows(f.root, "run-ledger", f.root), [
      { role: "judge", kind: "accepted", accepted: firstPayload, toolCallId: "first" },
    ]);

    // Second submission on the same attempt records again — no seal throw.
    const secondDetails = { status: "continue", report: "more" };
    const secondHost = registerTool(
      f.root,
      async () => ({ content: [], details: secondDetails, terminate: true }),
    );
    await secondHost.start("second");
    const accepted2 = await secondHost.tool().execute("second", secondDetails, undefined, undefined, secondHost.context);
    assert.deepEqual(accepted2.details, secondDetails);
    assert.equal(accepted2.terminate, true);

    const all = await readRecordedSubmissions(f.root, "run-ledger", f.root);
    assert.equal(all.length, 2);
    assert.deepEqual(all[0], { status: "converged" });
    assert.deepEqual(all[1], secondDetails);
    assert.equal(f.deliveredRejections.length, 0);
    assert.equal(secondHost.deliveredRejections.length, 0);
  });
});

test("continuing gate records candidate without sealing acceptance", async () => {
  await withLedgerFixture(async (f) => {
    const continuing = registerTool(f.root, async (params) => ({ content: [], details: params, terminate: false }));
    await continuing.start("continue");
    const candidate = { status: "continue" };
    const result = await continuing.tool().execute("continue", candidate, undefined, undefined, continuing.context);
    assert.equal(result.terminate, false);
    assert.deepEqual(await readRecordedSubmissions(f.root, "run-ledger", f.root), [candidate]);
    assert.deepEqual(await readRecordedSubmissionRows(f.root, "run-ledger", f.root), [{ role: "judge", kind: "candidate", accepted: candidate, toolCallId: "continue" }]);
    assert.deepEqual(continuing.closedSubmissions, []);
  });
});

test("mixed tools in one turn still record every terminating submission (#836 no sole)", async () => {
  await withLedgerFixture(async (f) => {
    await f.start("a");
    await f.tool().execute("a", { status: "converged" }, undefined, undefined, f.context);
    // A non-terminating read tool in the same turn leaves no submission row.
    await f.start("b", "read");
    assert.equal((await readRecordedSubmissions(f.root, "run-ledger", f.root)).length, 1);
    assert.equal(f.deliveredRejections.length, 0, "no non-sole rejection");
    const rows = await historyRows(fixtureUnboundRunDirectory(f.root, JUDGE_RUN_LEAF));
    assert.deepEqual(rows.map((row) => ({ type: row.type, toolCallId: row.toolCallId, disposition: row.disposition })), [
      { type: "submission", toolCallId: "a", disposition: "accepted" },
    ]);
  });
});

test("review escalate keeps a failure declaration; other roles still host-fail", async () => {
  await withLedgerFixture(async (f) => {
    let ran = 0;
    const params = { status: "escalate", infrastructureFailure: { diagnostic: "disk full" } };
    const host = registerTool(f.root, async (submitted) => {
      ran += 1;
      return { content: [], details: submitted, terminate: true };
    });
    const result = await host.tool().execute("review-escalate", params, undefined, undefined, host.context);
    assert.equal(ran, 1);
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, params);
    const rows = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.deepEqual(rows.at(-1), {
      role: "judge",
      kind: "accepted",
      accepted: params,
      toolCallId: "review-escalate",
    });
    assert.deepEqual(publicNavigatorSettlement("judge", null, {
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: params,
    }), { kind: "human_decision", role: "judge", phase: null, status: "escalate" });
  });

  await withLedgerFixture(async (f) => {
    let ran = 0;
    const params = { infrastructureFailure: { diagnostic: "disk full" } };
    const coderTool = packagedRoleOutputTool("coder");
    assert.equal(typeof coderTool, "string");
    const host = registerTool(f.root, async () => {
      ran += 1;
      return { content: [], details: params, terminate: true };
    }, coderTool, "coder");
    await assert.rejects(
      host.tool().execute("coder-infra", params, undefined, undefined, host.context),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "InfrastructureFailure");
        assert.equal(error.message, params.infrastructureFailure.diagnostic);
        return true;
      },
    );
    assert.equal(ran, 0);
    const submissions = await historyRows(fixtureUnboundRunDirectory(f.root, "run-ledger@coder"));
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.disposition, "infrastructure");
    assert.equal(submissions[0]?.role, "coder");
    assert.deepEqual(submissions[0]?.params, params);
  });
});

test("pipeline ledger records an unknown output failure as infrastructure", async () => {
  await withLedgerFixture(async (f) => {
    const params = { status: "converged", report: "infra-params" };
    const failing = registerTool(f.root, async () => { throw new Error("typed seam unavailable"); });
    await assert.rejects(failing.tool().execute("failure", params, undefined, undefined, failing.context));
    const [row, ...rest] = await historyRows(fixtureUnboundRunDirectory(f.root, JUDGE_RUN_LEAF));
    assert.equal(rest.length, 0, "one history line per submission call");
    const { at, ...stable } = row!;
    assert.equal(typeof at, "string");
    assert.deepEqual(stable, {
      type: "submission",
      attempt: 1,
      attemptId: "run-ledger:attempt",
      toolCallId: "failure",
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      role: "judge",
      params,
      disposition: "infrastructure",
      reason: "typed seam unavailable",
    });
    // #881: original params stay projectable even when outcome is not sealed.
    assert.deepEqual(await readRecordedSubmissionRows(f.root, "run-ledger", f.root), [
      { role: "judge", kind: "infrastructure", accepted: params, toolCallId: "failure" },
    ]);
  });
});

test("pipeline ledger records typed bounce anchors as correctable-rejection", async () => {
  await withLedgerFixture(async (f) => {
    const anchors: Array<{ label: string; error: Error }> = [
      { label: "gatekeeper", error: new GatekeeperDecisionError({ status: "continue", officer: "inspector", receipt: { status: "continue", findings: ["x"] } }) },
      { label: "unfinished-reason", error: new WorkerUnfinishedReasonReminderError() },
    ];
    for (const anchor of anchors) {
      const params = { status: "converged", report: anchor.label };
      const failing = registerTool(f.root, async () => { throw anchor.error; });
      await assert.rejects(
        failing.tool().execute(anchor.label, params, undefined, undefined, failing.context),
      );
      const last = (await historyRows(fixtureUnboundRunDirectory(f.root, JUDGE_RUN_LEAF))).at(-1);
      assert.equal(last?.disposition, "rejected", anchor.label);
      assert.equal(last?.toolCallId, anchor.label);
      assert.equal(last?.role, "judge", anchor.label);
      assert.deepEqual(last?.params, params, anchor.label);
      // #881: correctable-rejection original params project once per call.
      const rows = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
      const projected = rows.find(
        (row) => row.kind === "correctable-rejection" && row.toolCallId === anchor.label,
      );
      assert.ok(projected, anchor.label);
      assert.deepEqual(projected?.accepted, params, anchor.label);
    }
  });
});

test("#881 reader projects non-sealed original params once per tool call (correctable + infrastructure)", async () => {
  await withLedgerFixture(async (f) => {
    const bounceParams = { status: "converged", report: "bounce-1" };
    const bounce = registerTool(f.root, async () => {
      throw new GatekeeperDecisionError({
        status: "continue",
        officer: "inspector",
        receipt: { status: "continue", findings: ["x"] },
      });
    });
    await assert.rejects(bounce.tool().execute("call-bounce", bounceParams, undefined, undefined, bounce.context));

    const infraParams = { status: "converged", report: "infra-2" };
    const infra = registerTool(f.root, async () => {
      throw new Error("host aborted after candidate");
    });
    await assert.rejects(infra.tool().execute("call-infra", infraParams, undefined, undefined, infra.context));

    const rows = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.deepEqual(
      rows.map((row) => ({ kind: row.kind, toolCallId: row.toolCallId, accepted: row.accepted })),
      [
        { kind: "correctable-rejection", toolCallId: "call-bounce", accepted: bounceParams },
        { kind: "infrastructure", toolCallId: "call-infra", accepted: infraParams },
      ],
    );
    // One history line per call: no separate candidate/outcome pair.
    assert.equal((await readRecordedSubmissions(f.root, "run-ledger", f.root)).length, 2);
    const lines = await historyRows(fixtureUnboundRunDirectory(f.root, JUDGE_RUN_LEAF));
    assert.deepEqual(lines.map((line) => [line.attempt, line.toolCallId, line.disposition]), [
      [1, "call-bounce", "rejected"],
      [2, "call-infra", "infrastructure"],
    ]);
  });
});

test("pipeline ledger refuses shared unbound run identity", async () => {
  await withLedgerFixture(async (f) => {
    delete process.env.AK_ROLE_RUN_DIR;
    const bare = registerTool(f.root);
    const context = {
      ...bare.context,
      runDirectory: undefined,
      sessionManager: {},
    } as unknown as HostContext;
    await assert.rejects(
      bare.tool().execute("no-id", {}, undefined, undefined, context),
      Error,
    );
  });
});

test("every packaged role records original payload through the production ledger host (#836)", async () => {
  const rows = [
    { role: "judge" as const, details: { status: "converged" }, status: "converged" },
    { role: "coder" as const, details: { status: "completed", report: "done" }, status: "completed" },
    { role: "fixer" as const, details: { status: "completed", report: "done", classResults: [] }, status: "completed" },
    { role: "reviewer" as const, details: { status: "completed" }, status: "completed" },
    { role: "doctor" as const, details: { status: "refused", reason: "missing", missingEvidence: [] }, status: "refused" },
    { role: "merger" as const, details: { status: "escalate", attemptId: "a", diagnosis: "d", report: "r" }, status: "escalate" },
    { role: "notary" as const, details: { status: "converged", findings: [] }, status: "converged" },
    { role: "countersign" as const, details: { status: "converged" }, status: "converged" },
    { role: "gleaner-left" as const, details: { status: "completed", findings: [] }, status: "completed" },
    { role: "inspector" as const, details: { status: "converged", findings: [] }, status: "converged" },
    // Collector has no status leaf — record empty status, original groups payload.
    { role: "collector" as const, details: { groups: [] }, status: "" },
  ];
  for (const row of rows) {
    await withLedgerFixture(async (f) => {
      const roleRunDirectory = fixtureUnboundRunDirectory(f.root, `run-${row.role}@${row.role}`);
      process.env.AK_ROLE_RUN_DIR = roleRunDirectory;
      await mkdir(`${roleRunDirectory}/session`, { recursive: true });
      await writeFile(`${roleRunDirectory}/session/session.jsonl`, "");
      const outputTool = packagedRoleOutputTool(row.role)!;
      const alternateHost = registerTool(
        f.root,
        async () => ({ content: [], details: row.details, terminate: true }),
        outputTool,
        row.role,
      );
      alternateHost.context.runDirectory = roleRunDirectory;
      await alternateHost.start(`${row.role}-output`, outputTool);
      const accepted = await alternateHost.tool().execute(`${row.role}-output`, row.details, undefined, undefined, alternateHost.context);
      assert.deepEqual(accepted.details, row.details, row.role);
      assert.equal(accepted.terminate, true, row.role);
      const rows = await readRecordedSubmissionRows(f.root, `run-${row.role}`, {
        home: f.root,
        sessionParent: `${roleRunDirectory}/session/session.jsonl`,
      });
      assert.deepEqual(
        rows,
        [{ role: row.role, kind: "accepted", accepted: row.details, toolCallId: `${row.role}-output` }],
        row.role,
      );
    });
  }
});

test("a recorded append failure never returns accepted", async () => {
  await withLedgerFixture(async (f) => {
    const runDirectory = fixtureUnboundRunDirectory(f.root, JUDGE_RUN_LEAF);
    const historyFile = `${runDirectory}/history.jsonl`;
    const failing = registerTool(f.root, async () => {
      return { content: [], details: { status: "converged" }, terminate: true };
    });
    await withPrimaryAwareCleanup(
      async () => {
        // Create history.jsonl through a throw path, then lock it before the accepted append.
        const primer = registerTool(f.root, async () => {
          throw new Error("prime");
        });
        await assert.rejects(primer.tool().execute("prime", {}, undefined, undefined, primer.context));
        await chmod(historyFile, 0o400);
        await assert.rejects(failing.tool().execute("seal-failure", {}, undefined, undefined, failing.context));
        // Unlock to read.
        await chmod(historyFile, 0o600);
        // Primer infrastructure params remain; the locked append must not add an accepted row.
        const rows = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
        assert.equal(rows.some((row) => row.kind === "accepted"), false);
        assert.ok(rows.some((row) => row.kind === "infrastructure"));
      },
      async () => {
        try { await chmod(historyFile, 0o600); } catch { /* already unlocked */ }
      },
    );
  });
});

test("unknown run read APIs return empty without ownership throw", async () => {
  await withLedgerFixture(async (f) => {
    const rows = await readRecordedSubmissionRows(f.root, "missing-run-id", { home: f.root });
    assert.deepEqual(rows, []);
    assert.deepEqual(await readRecordedSubmissions(f.root, "missing-run-id", { home: f.root }), []);
  });
});

test("court attempt tags record without hiding earlier payloads (#836)", async () => {
  await withLedgerFixture(async (f) => {
    // Same bare toolCallId across courts — reader must still keep both payloads (#881).
    const reusedCallId = "reused-id";
    await f.start(reusedCallId);
    await f.tool().execute(reusedCallId, { status: "continue" }, undefined, undefined, f.context);
    const reopened = registerTool(f.root);
    reopened.context.courtAttemptId = "court-turn-2";
    {
      await reopened.start(reusedCallId);
      await reopened.tool().execute(reusedCallId, { status: "converged" }, undefined, undefined, reopened.context);
      const rows = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
      assert.deepEqual(
        rows.map((row) => ({ kind: row.kind, toolCallId: row.toolCallId, accepted: row.accepted })),
        [
          { kind: "accepted", toolCallId: reusedCallId, accepted: { status: "continue" } },
          { kind: "accepted", toolCallId: reusedCallId, accepted: { status: "converged" } },
        ],
      );
      const recorded = await readRecordedSubmissions(f.root, "run-ledger", f.root);
      assert.equal(recorded.length, 2);
      assert.deepEqual(recorded, [
        { status: "continue" },
        { status: "converged" },
      ]);
      // attemptId is a recording tag, not a visibility gate.
      assert.deepEqual(
        await readRecordedSubmissions(f.root, "run-ledger", {
          home: f.root,
          attemptId: "court-turn-empty",
        }),
        recorded,
      );
    }
  });
});

test("history row carries the delivered prompt and schema; current.json latest omits them", async () => {
  await withLedgerFixture(async (f) => {
    const runDirectory = fixtureUnboundRunDirectory(f.root, JUDGE_RUN_LEAF);
    // The host records what it delivered in current.json `delivery` before the turn runs.
    const delivery = { systemPrompt: "soul text", outputSchema: { type: "object", additionalProperties: false } };
    seedCurrentSection(runDirectory, "delivery", delivery);
    await f.start("call-1");
    await f.tool().execute("call-1", { status: "first-accepted" }, undefined, undefined, f.context);
    await f.tool().execute("call-2", { status: "second-accepted" }, undefined, undefined, f.context);

    const rows = await historyRows(runDirectory);
    assert.deepEqual(rows.map((row) => row.attempt), [1, 2]);
    for (const row of rows) {
      assert.equal(row.systemPrompt, delivery.systemPrompt);
      assert.deepEqual(row.outputSchema, delivery.outputSchema);
      assert.equal("priorEventId" in row, false);
    }
    const current = readCurrentJson(runDirectory);
    const latest = (current.submission as { latest: Record<string, unknown> }).latest;
    assert.equal(latest.attempt, 2);
    assert.equal(latest.toolCallId, "call-2");
    assert.equal(latest.disposition, "accepted");
    assert.equal("systemPrompt" in latest, false);
    assert.equal("outputSchema" in latest, false);
  });
});
