import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { test } from "vitest";
import { withPrimaryAwareCleanup, worktreeTempPrefix } from "../helpers/environment-fixtures.ts";
import type { HostContext, HostToolDefinition, HostToolResult, RoleHost } from "../../src/host-contracts.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { readSitianRecords } from "../../src/sitian-reader.ts";
import type { SitianRecord } from "../../src/sitian-contracts.ts";
import { packagedRoleOutputTool } from "../../src/packaged-role-registry.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { WorkerUnfinishedReasonReminderError } from "../../src/worker-submission-gates.ts";
import { publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { reportTicketFromHostContext } from "../../src/report-ticket-tool.ts";
import { seedStatePage, stagedProgressLines } from "../helpers/run-dossier-fixture.ts";
import { Type } from "typebox";
import {
  createSubmissionLedgerHost,
  readRecordedSubmissionRows,
  readReceipt,
} from "../../src/submission-ledger.ts";
import { join } from "node:path";

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
    on(_event: string, _handler: (...args: any[]) => unknown) {},
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

async function ledgerRecords(root: string): Promise<SitianRecord[]> {
  const files = await readdir(`${root}/.ak-roles/books`, { recursive: true });
  const records: SitianRecord[] = [];
  for (const relative of files.filter((file) => file.endsWith(".jsonl"))) {
    records.push(...(await readSitianRecords(`${root}/.ak-roles/books/${relative}`)).records.filter((record) => ["candidate", "outcome", "sealed"].includes(record.kind)));
  }
  return records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
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
    await host.tool().execute("raw", "plain-string-submission", undefined, undefined, host.context);
    assert.deepEqual((await readRecordedSubmissionRows(f.root, "run-ledger", f.root)).rows.map(readReceipt), ["plain-string-submission"]);
  });
});

test.each(["unbound", "bound", "inline"] as const)("ledger records raw params and returns ticket-dependent termination (%s)", async (placement) => {
  await withLedgerFixture(async (f) => {
    const params = { status: "converged", report: "from-llm-params", ...(placement === "inline" ? { ticketNumber: 1268 } : {}) };
    const details = { status: "converged", report: "from-tool-result", injected: true };
    const host = registerTool(
      f.root,
      async () => ({ content: [], details, terminate: true }),
    );
    for (const kind of ["invocation", "admitted-request"] as const) {
      seedStatePage(host.context.runDirectory!, kind, {
        role: "judge", runId: "run-ledger", bookKey: "fixture", projectRoot: f.root,
        instruction: "Review the submission.",
      });
    }
    if (placement === "bound") await reportTicketFromHostContext(host.context, 1268);
    const result = await host.tool().execute("p1", params, undefined, undefined, host.context);
    assert.equal(result.terminate, placement !== "unbound");
    assert.deepEqual(result.details, details);
    const { rows } = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.deepEqual(rows.map(readReceipt), [params]);
  });
});

test("one turn two submissions → two ledger rows; original payload returned; no abort (#836)", async () => {
  await withLedgerFixture(async (f) => {
    f.context.summonsInstruction = "first summons for two-seal progress";
    const firstPayload = {
      status: "converged",
      summary: "first sealed summary text here ok",
      unknownKept: "literal-extra-field",
    };
    const first = await f.tool().execute("first", firstPayload, undefined, undefined, f.context);
    assert.deepEqual(first.details, firstPayload);
    // #1199: each seal lands progress immediately — no post-turn history pick.
    const unbound = join(f.root, ".ak-roles", "books", "fixture", "unbound");
    const runDirectory = f.context.runDirectory;
    assert.ok(runDirectory, "ledger fixture must admit a run directory");
    const staged = () => stagedProgressLines(runDirectory);
    assert.equal(staged().length, 1);

    // Second submission on the same attempt records again — no seal throw.
    const secondDetails = { status: "continue", report: "more", summary: "second sealed summary text here ok" };
    const secondHost = registerTool(
      f.root,
      async () => ({ content: [], details: secondDetails, terminate: true }),
    );
    secondHost.context.summonsInstruction = "second summons for two-seal progress";
    const accepted2 = await secondHost.tool().execute("second", secondDetails, undefined, undefined, secondHost.context);
    assert.deepEqual(accepted2.details, secondDetails);

    const all = (await readRecordedSubmissionRows(f.root, "run-ledger", f.root)).rows.map(readReceipt);
    assert.equal(all.length, 2);
    assert.deepEqual(all[0], firstPayload);
    assert.deepEqual(all[1], secondDetails);
    assert.equal(f.deliveredRejections.length, 0);
    assert.equal(secondHost.deliveredRejections.length, 0);

    const lines = staged().filter((line) => line.seat === "judge");
    assert.equal(lines.length, 2);
    // Unbound staging: round empty until whole-leg bind publishes into ticket current.
    assert.equal(lines[0]!.round, "");
    assert.equal(lines[1]!.round, "");
    assert.equal(lines[0]!.instruction, "first summons for two-seal progress");
    assert.equal(lines[1]!.instruction, "second summons for two-seal progress");
    assert.equal(existsSync(join(unbound, lines[0]!.receipt)), true);
    assert.equal(existsSync(join(unbound, lines[1]!.receipt)), true);
    assert.ok(lines[0]!.receipt.endsWith("/receipts/1.json"), lines[0]!.receipt);
    assert.ok(lines[1]!.receipt.endsWith("/receipts/2.json"), lines[1]!.receipt);
    // Whole sealed JSON retained — unknown fields survive (票面原样回执).
    assert.deepEqual(
      JSON.parse(await readFile(join(unbound, lines[0]!.receipt), "utf8")),
      firstPayload,
    );
  });
});

test("continuing gate records candidate without sealing acceptance", async () => {
  await withLedgerFixture(async (f) => {
    const continuing = registerTool(f.root, async (params) => ({ content: [], details: params, terminate: false }));
    const candidate = { status: "continue" };
    const result = await continuing.tool().execute("continue", candidate, undefined, undefined, continuing.context);
    assert.equal(result.terminate, false);
    const { rows } = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.deepEqual(rows.map(row => [row.kind, readReceipt(row)]), [["candidate", candidate]]);
    assert.deepEqual(continuing.closedSubmissions, []);
  });
});

test("mixed tools in one turn still record every terminating submission (#836 no sole)", async () => {
  await withLedgerFixture(async (f) => {
    await f.tool().execute("a", { status: "converged" }, undefined, undefined, f.context);
    assert.equal((await readRecordedSubmissionRows(f.root, "run-ledger", f.root)).rows.length, 1);
    assert.equal(f.deliveredRejections.length, 0, "no non-sole rejection");
    const kinds = (await ledgerRecords(f.root)).map((r) => r.kind);
    assert.ok(kinds.includes("sealed"));
  });
});

test("#1214 A2: infrastructureFailure declaration is recorded; declaration itself does not host-fail", async () => {
  await withLedgerFixture(async (f) => {
    let ran = 0;
    const params = { status: "escalate", infrastructureFailure: { diagnostic: "disk full" } };
    const host = registerTool(f.root, async (submitted) => {
      ran += 1;
      return { content: [], details: submitted, terminate: true };
    });
    const result = await host.tool().execute("review-escalate", params, undefined, undefined, host.context);
    assert.equal(ran, 1);
    assert.deepEqual(result.details, params);
    const { rows } = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.deepEqual(rows.map(row => [row.kind, readReceipt(row)]), [["accepted", params]]);
    assert.deepEqual(publicNavigatorSettlement("judge", null, {
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: params,
    }), { kind: "human_decision", role: "judge", phase: null, status: "escalate" });
  });

  await withLedgerFixture(async (f) => {
    let ran = 0;
    const params = { status: "completed", infrastructureFailure: { diagnostic: "disk full" } };
    const coderTool = packagedRoleOutputTool("coder");
    assert.equal(typeof coderTool, "string");
    const host = registerTool(f.root, async (submitted) => {
      ran += 1;
      return { content: [], details: submitted, terminate: true };
    }, coderTool, "coder");
    const result = await host.tool().execute("coder-infra", params, undefined, undefined, host.context);
    assert.equal(ran, 1, "declaration must not abort before execute");
    assert.deepEqual(result.details, params);
    assert.deepEqual(host.closedSubmissions.at(-1), {
      role: "coder",
      kind: "accepted",
      accepted: params,
    });
    const sealed = (await ledgerRecords(f.root)).filter((record) => record.kind === "sealed");
    assert.ok(sealed.some((record) => {
      const payload = record.payload as { role?: string; receipt?: string; toolCallId?: string };
      return payload.role === "coder" && payload.toolCallId === "coder-infra"
        && payload.receipt === "runs/run-ledger@coder/receipts/1.json";
    }), "coder original payload with infrastructureFailure must seal");
    const outcomes = (await ledgerRecords(f.root)).filter((record) => record.kind === "outcome");
    assert.equal(outcomes.length, 0, "declaration alone is not an infrastructure outcome");
  });
});

test("pipeline ledger records an unknown output failure as infrastructure", async () => {
  await withLedgerFixture(async (f) => {
    const params = { status: "converged", report: "infra-params" };
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
      receipt: "runs/run-ledger@judge/receipts/1.json",
    });
    // #881: original params stay projectable even when outcome is not sealed.
    const { rows } = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.deepEqual(rows.map(readReceipt), [params]);
  });
});

test("pipeline ledger records typed bounce anchors as correctable-rejection", async () => {
  await withLedgerFixture(async (f) => {
    const label = "unfinished-reason";
    const params = { status: "converged", report: label };
    const failing = registerTool(f.root, async () => { throw new WorkerUnfinishedReasonReminderError(); });
    await assert.rejects(
      failing.tool().execute(label, params, undefined, undefined, failing.context),
    );
    const outcome = (await ledgerRecords(f.root)).filter((record) => record.kind === "outcome").at(-1);
    assert.equal(outcome?.payload && (outcome.payload as { outcome?: string }).outcome, "correctable-rejection", label);
    assert.equal((outcome?.payload as { code?: string }).code, "typed-bounce", label);
    assert.equal((outcome?.payload as { role?: string }).role, "judge", label);
    // #881: correctable-rejection original params project once (candidate+outcome deduped).
    const { rows } = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    const projected = rows.find(
      (row) => row.kind === "correctable-rejection" && row.toolCallId === label,
    );
    assert.deepEqual(readReceipt(projected!), params, label);
  });
});

test("#881 reader projects non-sealed original params once per tool call (correctable + infrastructure)", async () => {
  await withLedgerFixture(async (f) => {
    const bounceParams = { status: "converged", report: "bounce-1" };
    const bounce = registerTool(f.root, async () => {
      throw new WorkerUnfinishedReasonReminderError();
    });
    await assert.rejects(bounce.tool().execute("call-bounce", bounceParams, undefined, undefined, bounce.context));

    const infraParams = { status: "converged", report: "infra-2" };
    const infra = registerTool(f.root, async () => {
      throw new Error("host aborted after candidate");
    });
    await assert.rejects(infra.tool().execute("call-infra", infraParams, undefined, undefined, infra.context));

    const { rows } = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.deepEqual(
      rows.map((row) => ({ kind: row.kind, toolCallId: row.toolCallId, accepted: readReceipt(row) })),
      [
        { kind: "correctable-rejection", toolCallId: "call-bounce", accepted: bounceParams },
        { kind: "infrastructure", toolCallId: "call-infra", accepted: infraParams },
      ],
    );
    const kinds = (await ledgerRecords(f.root)).map((record) => record.kind);
    assert.equal(kinds.filter((kind) => kind === "candidate").length, 2);
    assert.equal(kinds.filter((kind) => kind === "outcome").length, 2);
    assert.equal(kinds.includes("sealed"), false);
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

test("an unreadable ledger prevents acceptance but not saving the arriving draft", async () => {
  await withLedgerFixture(async (f) => {
    const primer = registerTool(f.root, async () => { throw new Error("prime"); });
    await assert.rejects(primer.tool().execute("prime", {}, undefined, undefined, primer.context));
    const history = join(f.context.runDirectory!, "state.jsonl");
    await rename(history, `${history}.saved`);
    await mkdir(history);
    const draft = { status: "converged", findings: [] };
    await assert.rejects(f.tool().execute("seal-failure", draft, undefined, undefined, f.context));
    assert.deepEqual(JSON.parse(await readFile(join(f.context.runDirectory!, "receipts/2.json"), "utf8")), draft);
    await rm(history, { recursive: true });
    await rename(`${history}.saved`, history);
    const { rows } = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
    assert.equal(rows.some((row) => row.kind === "accepted"), false);
    assert.ok(rows.some((row) => row.kind === "infrastructure"));
    // The ledger breaks while the tool turns the draft back: recording that fails,
    // and the failure still carries the tool's own reason (bounce or fault alike).
    for (const toolError of [new WorkerUnfinishedReasonReminderError(), new Error("typed seam unavailable")]) {
      const breaking = registerTool(f.root, async () => {
        await rename(history, `${history}.saved`);
        await mkdir(history);
        throw toolError;
      });
      const rejected = await breaking.tool().execute("bounce-unrecorded", draft, undefined, undefined, breaking.context)
        .then(() => undefined, (error: unknown) => error);
      await rm(history, { recursive: true });
      await rename(`${history}.saved`, history);
      assert.ok(rejected instanceof AggregateError);
      assert.equal(rejected.errors[1], toolError);
      assert.equal((rejected.cause as NodeJS.ErrnoException).code, "EISDIR");
    }
  });
});

test("unknown run read APIs return empty without ownership throw", async () => {
  await withLedgerFixture(async (f) => {
    const { rows } = await readRecordedSubmissionRows(f.root, "missing-run-id", { home: f.root });
    assert.deepEqual(rows, []);
  });
});

test("court attempt tags record without hiding earlier payloads (#836)", async () => {
  await withLedgerFixture(async (f) => {
    // Same bare toolCallId across courts — reader must still keep both payloads (#881).
    const reusedCallId = "reused-id";
    await f.tool().execute(reusedCallId, { status: "continue" }, undefined, undefined, f.context);
    const reopened = registerTool(f.root);
    reopened.context.courtAttemptId = "court-turn-2";
    {
      await reopened.tool().execute(reusedCallId, { status: "converged" }, undefined, undefined, reopened.context);
      const { rows } = await readRecordedSubmissionRows(f.root, "run-ledger", f.root);
      assert.deepEqual(
        rows.map((row) => ({ kind: row.kind, toolCallId: row.toolCallId, accepted: readReceipt(row) })),
        [
          { kind: "accepted", toolCallId: reusedCallId, accepted: { status: "continue" } },
          { kind: "accepted", toolCallId: reusedCallId, accepted: { status: "converged" } },
        ],
      );
    }
  });
});
