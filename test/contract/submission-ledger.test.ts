import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import test from "node:test";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import type { HostContext, HostToolDefinition, HostToolResult, RoleHost } from "../../src/host-contracts.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { readSitianRecords } from "../../src/sitian-reader.ts";
import type { SitianRecord } from "../../src/sitian-contracts.ts";
import { buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import { GatekeeperDecisionError } from "../../src/gatekeeper-role.ts";
import { packagedRoleOutputTool } from "../../src/packaged-role-registry.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { WorkerUnfinishedReasonReminderError } from "../../src/worker-submission-gates.ts";
import { publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { Type } from "typebox";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import {
  createSubmissionLedgerHost,
  hasRecordedSubmission,
  readRecordedSubmissionRows,
  readRecordedSubmissions,
} from "../../src/submission-ledger.ts";

function registerTool(
  root: string,
  execute: (params?: unknown) => Promise<HostToolResult<unknown>> = async (params) => ({
    content: [],
    // Default: echo params as details so ledger params≡details unless a test overrides.
    details: params !== undefined && params !== null && typeof params === "object" && !Array.isArray(params) && Object.keys(params as object).length > 0
      ? params
      : { judgeStatus: "converged" },
    terminate: true,
  }),
  outputTool = JUDGE_OUTPUT_TOOL_NAME,
  role: TerminalRoleName = "judge",
) {
  let registered: HostToolDefinition | undefined;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const deliveredRejections: unknown[] = [];
  const closedSubmissions: unknown[] = [];
  let terminalRoundCalls: Array<{ toolCallId: string; toolName: string }> = [];
  const host = {
    deliverSubmissionRejection(rejection: unknown) { deliveredRejections.push(rejection); },
    registerTool(tool: HostToolDefinition) { registered = tool; },
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
  } as RoleHost;
  const pipeline = createSubmissionLedgerHost(host, new Map([[outputTool, role]]), undefined, async (projection) => {
    closedSubmissions.push(projection);
  }, { home: root });
  pipeline.registerTool({
    name: outputTool,
    label: "output",
    description: "",
    parameters: Type.Object({}),
    execute: async (_id, params, ...rest) => execute(params),
  });
  const context = {
    cwd: root,
    mode: "json",
    model: undefined,
    sessionManager: {
      getHeader: () => ({ type: "session", id: "run-ledger:attempt" }),
      getLeafEntry: () => undefined,
      getLeafId: () => null,
      getEntries: () => [],
      getSessionDir: () => "",
      getSessionFile: () => undefined,
    },
    abort() { throw new Error("ledger must not abort the host (#836)"); },
  } as unknown as HostContext;
  return {
    context,
    deliveredRejections,
    closedSubmissions,
    tool: () => registered!,
    start: async (id: string, name = JUDGE_OUTPUT_TOOL_NAME) => {
      terminalRoundCalls.push({ toolCallId: id, toolName: name });
    },
    close: async () => {
      const calls = terminalRoundCalls;
      terminalRoundCalls = [];
      await handlers.get("turn_end")!({ turnIndex: 0, calls }, context);
    },
  };
}

async function fixture() {
  const root = await mkdtemp(worktreeTempPrefix("ak-submission-ledger-"));
  execFileSync("git", ["init", "-q", root]);
  return { root, ...registerTool(root) };
}

async function ledgerRecords(root: string): Promise<SitianRecord[]> {
  const files = await readdir(`${root}/.ak-roles/books`, { recursive: true });
  const records: SitianRecord[] = [];
  for (const relative of files.filter((file) => file.endsWith(".jsonl"))) {
    records.push(...(await readSitianRecords(`${root}/.ak-roles/books/${relative}`)).records.filter((record) => ["roundContext", "candidate", "outcome", "sealed"].includes(record.kind)));
  }
  return records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

async function withLedgerFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorCourt = process.env.AK_ROLE_COURT_ATTEMPT;
  const f = await fixture();
  process.env.AK_ROLE_RUN_DIR = `${f.root}/runs/run-ledger@judge`;
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



test("audit escalation params enter submissions face even when result.details differ (#836 bounce)", async () => {
  await withLedgerFixture(async (f) => {
    const params = { judgeStatus: "escalate", report: "from-params" };
    const details = buildAuditEscalationResult(
      { status: "escalate", conflicts: ["c1"], decisionGate: { question: "q", options: ["a"] } },
      { judgeStatus: "escalate", rewritten: true },
    );
    const host = registerTool(
      f.root,
      async () => ({ content: [], details, terminate: true }),
    );
    await host.start("a1");
    await host.tool().execute("a1", params, undefined, undefined, host.context);
    const all = await readRecordedSubmissions(f.root, "run-ledger", f.root);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], params, "audit submissions must keep LLM params");
    assert.notDeepEqual(all[0], details);
  });
});


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
    const params = { judgeStatus: "converged", report: "from-llm-params" };
    const details = { judgeStatus: "converged", report: "from-tool-result", injected: true };
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
    const firstPayload = { judgeStatus: "converged" };
    const first = await f.tool().execute("first", firstPayload, undefined, undefined, f.context);
    assert.equal(first.terminate, true);
    assert.deepEqual(first.details, firstPayload);
    assert.deepEqual(await readRecordedSubmissionRows(f.root, "run-ledger", f.root), [
      { role: "judge", kind: "accepted", accepted: firstPayload, toolCallId: "first" },
    ]);

    // Second submission on the same attempt records again — no seal throw.
    const secondDetails = { judgeStatus: "continue", report: "more" };
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
    assert.deepEqual(all[0], { judgeStatus: "converged" });
    assert.deepEqual(all[1], secondDetails);
    assert.equal(f.deliveredRejections.length, 0);
    assert.equal(secondHost.deliveredRejections.length, 0);
  });
});

test("mixed tools in one turn still record every terminating submission (#836 no sole)", async () => {
  await withLedgerFixture(async (f) => {
    await f.start("a");
    await f.tool().execute("a", { judgeStatus: "converged" }, undefined, undefined, f.context);
    await f.start("b", "read");
    await f.close();
    assert.equal((await readRecordedSubmissions(f.root, "run-ledger", f.root)).length, 1);
    assert.equal(f.deliveredRejections.length, 0, "no non-sole rejection");
    const kinds = (await ledgerRecords(f.root)).map((r) => r.kind);
    assert.ok(kinds.includes("sealed"));
    assert.ok(kinds.includes("roundContext"));
    assert.ok(!kinds.includes("outcome") || (await ledgerRecords(f.root)).every((r) => r.kind !== "outcome" || (r.payload as { code?: string }).code !== "non-sole-round"));
  });
});

test("pipeline ledger records an unknown output failure as infrastructure", async () => {
  await withLedgerFixture(async (f) => {
    const params = { judgeStatus: "converged", report: "infra-params" };
    const failing = registerTool(f.root, async () => { throw new Error("typed seam unavailable"); });
    await assert.rejects(failing.tool().execute("failure", params, undefined, undefined, failing.context));
    const outcome = (await ledgerRecords(f.root)).at(-1);
    assert.equal(outcome?.kind, "outcome");
    assert.deepEqual(outcome?.payload, {
      type: "outcome",
      attemptId: "run-ledger:attempt",
      toolCallId: "failure",
      outcome: "infrastructure",
      diagnostic: "typed seam unavailable",
      role: "judge",
      accepted: params,
    });
    // #881: original params stay projectable even when outcome is not sealed.
    assert.equal(await hasRecordedSubmission(f.root, "run-ledger", f.root), true);
    assert.deepEqual(await readRecordedSubmissionRows(f.root, "run-ledger", f.root), [
      { role: "judge", kind: "infrastructure", accepted: params, toolCallId: "failure" },
    ]);
  });
});

test("pipeline ledger records typed bounce anchors as correctable-rejection", async () => {
  await withLedgerFixture(async (f) => {
    const anchors: Array<{ label: string; error: Error }> = [
      { label: "gatekeeper", error: new GatekeeperDecisionError({ status: "bounce", officer: "inspector", receipt: { status: "bounce", findings: ["x"] } }) },
      { label: "unfinished-reason", error: new WorkerUnfinishedReasonReminderError() },
    ];
    for (const anchor of anchors) {
      const params = { judgeStatus: "converged", report: anchor.label };
      const failing = registerTool(f.root, async () => { throw anchor.error; });
      await assert.rejects(
        failing.tool().execute(anchor.label, params, undefined, undefined, failing.context),
      );
      const outcome = (await ledgerRecords(f.root)).filter((record) => record.kind === "outcome").at(-1);
      assert.equal(outcome?.payload && (outcome.payload as { outcome?: string }).outcome, "correctable-rejection", anchor.label);
      assert.equal((outcome?.payload as { code?: string }).code, "typed-bounce", anchor.label);
      assert.equal((outcome?.payload as { role?: string }).role, "judge", anchor.label);
      // #881: correctable-rejection original params project once (candidate+outcome deduped).
      const rows = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
      const projected = rows.find(
        (row) => row.kind === "correctable-rejection" && row.toolCallId === anchor.label,
      );
      assert.ok(projected, anchor.label);
      assert.deepEqual(projected?.accepted, params, anchor.label);
    }
    assert.equal(await hasRecordedSubmission(f.root, "run-ledger", f.root), true);
  });
});

test("#881 reader projects non-sealed original params once per tool call (correctable + infrastructure)", async () => {
  await withLedgerFixture(async (f) => {
    const bounceParams = { judgeStatus: "converged", report: "bounce-1" };
    const bounce = registerTool(f.root, async () => {
      throw new GatekeeperDecisionError({
        status: "bounce",
        officer: "inspector",
        receipt: { status: "bounce", findings: ["x"] },
      });
    });
    await assert.rejects(bounce.tool().execute("call-bounce", bounceParams, undefined, undefined, bounce.context));

    const infraParams = { judgeStatus: "converged", report: "infra-2" };
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
    // candidate + outcome both carry params → one projected row per call.
    assert.equal((await readRecordedSubmissions(f.root, "run-ledger", f.root)).length, 2);
    const kinds = (await ledgerRecords(f.root)).map((record) => record.kind);
    assert.equal(kinds.filter((kind) => kind === "candidate").length, 2);
    assert.equal(kinds.filter((kind) => kind === "outcome").length, 2);
    assert.equal(kinds.includes("sealed"), false);
  });
});

test("pipeline ledger records audit-escalation with original details and no rewrite (#836)", async () => {
  await withLedgerFixture(async (f) => {
    const details = buildAuditEscalationResult(
      { status: "escalate", conflicts: ["c1"], decisionGate: { question: "q", options: ["a"] } },
      { judgeStatus: "escalate" },
    );
    const escalating = registerTool(f.root, async () => ({ content: [], details, terminate: true }));
    await escalating.start("esc");
    const result = await escalating.tool().execute("esc", details, undefined, undefined, escalating.context);
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, details, "original details reach the model");
    const rows = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.deepEqual(rows, [{ role: "judge", kind: "audit-escalation", accepted: details, toolCallId: "esc" }]);
    assert.deepEqual(escalating.closedSubmissions, [
      { role: "judge", kind: "audit_escalation", accepted: details },
    ]);
  });
});

test("officer escalate via gate is correctable bounce-to-parent with raw receipt (#753)", async () => {
  await withLedgerFixture(async (f) => {
    const receipt = { status: "escalate", reason: "need owner", findings: ["f"] };
    const bouncing = registerTool(
      f.root,
      async () => {
        throw new GatekeeperDecisionError({
          status: "escalate",
          officer: "notary",
          receipt,
        });
      },
      packagedRoleOutputTool("coder")!,
      "coder",
    );
    await bouncing.start("coder-officer-escalate", packagedRoleOutputTool("coder")!);
    await assert.rejects(
      bouncing.tool().execute("coder-officer-escalate", { status: "completed" }, undefined, undefined, bouncing.context),
      (error: unknown) => {
        assert.ok(error instanceof GatekeeperDecisionError);
        assert.equal(error.result.status, "escalate");
        assert.equal(error.message, JSON.stringify(receipt));
        return true;
      },
    );
    const outcome = (await ledgerRecords(f.root)).filter((record) => record.kind === "outcome").at(-1);
    assert.equal(outcome?.payload && (outcome.payload as { outcome?: string }).outcome, "correctable-rejection");
    // #881: original officer params remain projectable on correctable-rejection.
    assert.equal(await hasRecordedSubmission(f.root, "run-ledger", f.root), true);
    assert.deepEqual(await readRecordedSubmissions(f.root, "run-ledger", f.root), [{ status: "completed" }]);
  });
});

test("pipeline ledger refuses shared unbound run identity", async () => {
  await withLedgerFixture(async (f) => {
    delete process.env.AK_ROLE_RUN_DIR;
    const bare = registerTool(f.root);
    const context = {
      ...bare.context,
      sessionManager: {},
    } as unknown as HostContext;
    await assert.rejects(
      bare.tool().execute("no-id", {}, undefined, undefined, context),
      /提交账需要已受理的 run 身份/,
    );
  });
});

test("every packaged role records original payload through the production ledger host (#836)", async () => {
  const rows = [
    { role: "judge" as const, details: { judgeStatus: "converged" }, status: "converged" },
    { role: "coder" as const, details: { status: "completed", report: "done" }, status: "completed" },
    { role: "fixer" as const, details: { status: "completed", report: "done", classResults: [] }, status: "completed" },
    { role: "reviewer" as const, details: { status: "completed", version: 2, outcomes: {}, reports: {} }, status: "completed" },
    { role: "doctor" as const, details: { status: "refused", reason: "missing", missingEvidence: [] }, status: "refused" },
    { role: "merger" as const, details: { status: "escalate", attemptId: "a", diagnosis: "d", report: "r" }, status: "escalate" },
    { role: "notary" as const, details: { status: "pass", findings: [] }, status: "pass" },
    { role: "countersign" as const, details: { countersignStatus: "converged" }, status: "converged" },
    { role: "gleaner-left" as const, details: { status: "completed", findings: [] }, status: "completed" },
    { role: "inspector" as const, details: { status: "pass", findings: [] }, status: "pass" },
    // Collector has no status leaf — record empty status, original groups payload.
    { role: "collector" as const, details: { groups: [] }, status: "" },
  ];
  for (const row of rows) {
    await withLedgerFixture(async (f) => {
      process.env.AK_ROLE_RUN_DIR = `${f.root}/runs/run-${row.role}@${row.role}`;
      const outputTool = packagedRoleOutputTool(row.role)!;
      const alternateHost = registerTool(
        f.root,
        async () => ({ content: [], details: row.details, terminate: true }),
        outputTool,
        row.role,
      );
      await alternateHost.start(`${row.role}-output`, outputTool);
      const accepted = await alternateHost.tool().execute(`${row.role}-output`, row.details, undefined, undefined, alternateHost.context);
      assert.deepEqual(accepted.details, row.details, row.role);
      assert.equal(accepted.terminate, true, row.role);
      const rows = await readRecordedSubmissionRows(f.root, `run-${row.role}`, f.root);
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
    let recordFile: string | undefined;
    const failing = registerTool(f.root, async () => {
      // Force first candidate write, then lock the file before sealed append.
      return { content: [], details: { judgeStatus: "converged" }, terminate: true };
    });
    await withPrimaryAwareCleanup(
      async () => {
        // Pre-create by writing a candidate through a throw path, then lock.
        const primer = registerTool(f.root, async () => {
          throw new Error("prime");
        });
        await assert.rejects(primer.tool().execute("prime", {}, undefined, undefined, primer.context));
        recordFile = (await readdir(`${f.root}/.ak-roles/books`, { recursive: true })).find((file) => file.endsWith(".jsonl"));
        if (recordFile !== undefined) await chmod(`${f.root}/.ak-roles/books/${recordFile}`, 0o400);
        await assert.rejects(failing.tool().execute("seal-failure", {}, undefined, undefined, failing.context));
        // Unlock to read.
        if (recordFile !== undefined) await chmod(`${f.root}/.ak-roles/books/${recordFile}`, 0o600);
        // Primer infrastructure params remain; the locked seal must not add an accepted row.
        const rows = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
        assert.equal(rows.some((row) => row.kind === "accepted"), false);
        assert.ok(rows.some((row) => row.kind === "infrastructure"));
      },
      async () => {
        if (recordFile !== undefined) {
          try { await chmod(`${f.root}/.ak-roles/books/${recordFile}`, 0o600); } catch { /* already unlocked */ }
        }
      },
    );
  });
});

test("court attempt tags record without hiding earlier payloads (#836)", async () => {
  await withLedgerFixture(async (f) => {
    await f.start("t1");
    await f.tool().execute("t1", { judgeStatus: "continue" }, undefined, undefined, f.context);
    const priorCourt = process.env.AK_ROLE_COURT_ATTEMPT;
    process.env.AK_ROLE_COURT_ATTEMPT = "court-turn-2";
    try {
      const reopened = registerTool(f.root);
      await reopened.start("court-2");
      await reopened.tool().execute("court-2", { judgeStatus: "converged" }, undefined, undefined, reopened.context);
      const recorded = await readRecordedSubmissions(f.root, "run-ledger", f.root);
      assert.equal(recorded.length, 2);
      assert.deepEqual(recorded, [
        { judgeStatus: "continue" },
        { judgeStatus: "converged" },
      ]);
      // attemptId is a recording tag, not a visibility gate.
      assert.deepEqual(
        await readRecordedSubmissions(f.root, "run-ledger", {
          home: f.root,
          attemptId: "court-turn-empty",
        }),
        recorded,
      );
    } finally {
      if (priorCourt === undefined) delete process.env.AK_ROLE_COURT_ATTEMPT;
      else process.env.AK_ROLE_COURT_ATTEMPT = priorCourt;
    }
  });
});
