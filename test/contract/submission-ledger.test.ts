import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HostContext, HostToolDefinition, HostToolResult, RoleHost } from "../../src/host-contracts.ts";
import { readSitianRecords } from "../../src/sitian-reader.ts";
import type { SitianRecord } from "../../src/sitian-contracts.ts";
import { GatekeeperDecisionError } from "../../src/gatekeeper-role.ts";
import { AcceptedDetailsContractError } from "../../src/package-contracts/terminating-tools.ts";
import {
  createSubmissionLedgerHost,
  readAuditEscalationSubmission,
  readSealedSubmission,
} from "../../src/submission-ledger.ts";
import { WorkerUnfinishedReasonReminderError } from "../../src/worker-submission-gates.ts";
import { buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import { Type } from "typebox";

function registerTool(root: string, execute: () => Promise<HostToolResult<unknown>> = async () => ({ content: [], details: { status: "completed" }, terminate: true })) {
  let registered: HostToolDefinition | undefined;
  const host = { registerTool(tool: HostToolDefinition) { registered = tool; } } as RoleHost;
  const pipeline = createSubmissionLedgerHost(host, new Map([["ak_test_output", "judge"]]));
  pipeline.registerTool({ name: "ak_test_output", label: "output", description: "", parameters: Type.Object({}), execute });
  const context = {
    cwd: root,
    mode: "json",
    model: undefined,
    sessionManager: { getHeader: () => ({ type: "session", id: "run-ledger:attempt" }) },
    abort() {},
  } as HostContext;
  return { context, tool: () => registered! };
}

async function fixture() {
  const root = await mkdtemp(`${tmpdir()}/ak-submission-ledger-`);
  execFileSync("git", ["init", "-q", root]);
  return { root, ...registerTool(root) };
}

async function ledgerRecords(root: string): Promise<SitianRecord[]> {
  const files = await readdir(`${root}/.ak-roles/books`, { recursive: true });
  const records: SitianRecord[] = [];
  for (const relative of files.filter((file) => file.endsWith(".jsonl"))) {
    records.push(...(await readSitianRecords(`${root}/.ak-roles/books/${relative}`)).records.filter((record) => ["batchContext", "candidate", "outcome", "sealed", "post-seal-anomaly"].includes(record.kind)));
  }
  return records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

async function withLedgerFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const f = await fixture();
  process.env.HOME = f.root;
  process.env.AK_ROLE_RUN_DIR = `${f.root}/runs/run-ledger@judge`;
  try { await run(f); } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(f.root, { recursive: true, force: true });
  }
}

test("pipeline ledger restores its chain and sealed state in a new host", async () => {
  await withLedgerFixture(async (f) => {
    await assert.rejects(f.tool().execute("first", {}, undefined, undefined, { ...f.context, terminationBatch: { batchClosed: true, calls: [{ id: "first", name: "ak_test_output" }, { id: "sibling", name: "read" }] } }));
    const accepted = await f.tool().execute("retry", {}, undefined, undefined, { ...f.context, terminationBatch: { batchClosed: true, calls: [{ id: "retry", name: "ak_test_output" }] } });
    assert.equal(accepted.terminate, true);

    const resumed = registerTool(f.root);
    await assert.rejects(resumed.tool().execute("after-seal", {}, undefined, undefined, { ...resumed.context, terminationBatch: { batchClosed: true, calls: [{ id: "after-seal", name: "ak_test_output" }] } }));

    const records = await ledgerRecords(f.root);
    assert.deepEqual(records.map((record) => record.kind), ["batchContext", "candidate", "outcome", "batchContext", "candidate", "sealed", "post-seal-anomaly"]);
    for (let i = 1; i < records.length; i += 1) assert.equal(records[i]?.priorEventId, records[i - 1]?.identity);
    assert.deepEqual(records.at(-1)?.subject, { runId: "run-ledger", attemptId: "run-ledger:attempt" });
    assert.deepEqual(await readSealedSubmission(f.root, "run-ledger"), { kind: "accepted", role: "judge", status: "completed", decisiveFacts: { status: "completed" } });
  });
});

test("pipeline ledger records an unknown output failure as infrastructure", async () => {
  await withLedgerFixture(async (f) => {
    const failing = registerTool(f.root, async () => { throw new Error("typed seam unavailable"); });
    await assert.rejects(failing.tool().execute("failure", {}, undefined, undefined, { ...failing.context, terminationBatch: { batchClosed: true, calls: [{ id: "failure", name: "ak_test_output" }] } }));
    const outcome = (await ledgerRecords(f.root)).at(-1);
    assert.equal(outcome?.kind, "outcome");
    assert.deepEqual(outcome?.payload, { type: "outcome", attemptId: "run-ledger:attempt", toolCallId: "failure", outcome: "infrastructure", diagnostic: "typed seam unavailable" });
    assert.equal(await readSealedSubmission(f.root, "run-ledger"), undefined);
  });
});

test("pipeline ledger records typed bounce anchors as correctable-rejection", async () => {
  await withLedgerFixture(async (f) => {
    const anchors: Array<{ label: string; error: Error }> = [
      { label: "gatekeeper", error: new GatekeeperDecisionError({ status: "bounce", officer: "inspector", disposition: "rewrite", findings: [], submission: {} }) },
      { label: "unfinished-reason", error: new WorkerUnfinishedReasonReminderError() },
      { label: "shape", error: new AcceptedDetailsContractError("terminating receipt has no recognized execution discriminator") },
    ];
    for (const anchor of anchors) {
      const failing = registerTool(f.root, async () => { throw anchor.error; });
      await assert.rejects(
        failing.tool().execute(anchor.label, {}, undefined, undefined, {
          ...failing.context,
          terminationBatch: { batchClosed: true, calls: [{ id: anchor.label, name: "ak_test_output" }] },
        }),
      );
      const outcome = (await ledgerRecords(f.root)).filter((record) => record.kind === "outcome").at(-1);
      assert.equal(outcome?.payload && (outcome.payload as { outcome?: string }).outcome, "correctable-rejection", anchor.label);
      assert.equal(await readSealedSubmission(f.root, "run-ledger"), undefined, anchor.label);
    }
  });
});

test("pipeline ledger records audit-escalation projection without sealing", async () => {
  await withLedgerFixture(async (f) => {
    const details = buildAuditEscalationResult(
      { status: "escalate", conflicts: ["c1"], decisionGate: { question: "q", options: ["a"] } },
      { judgeStatus: "escalate" },
    );
    const escalating = registerTool(f.root, async () => ({ content: [], details, terminate: true }));
    const result = await escalating.tool().execute("esc", {}, undefined, undefined, {
      ...escalating.context,
      terminationBatch: { batchClosed: true, calls: [{ id: "esc", name: "ak_test_output" }] },
    });
    assert.equal(result.terminate, true);
    assert.equal(await readSealedSubmission(f.root, "run-ledger"), undefined);
    const projection = await readAuditEscalationSubmission(f.root, "run-ledger");
    assert.equal(projection?.kind, "audit_escalation");
    assert.equal(projection?.role, "judge");
    assert.equal(projection?.decisiveFacts.kind, "audit_escalation");
  });
});

test("pipeline ledger refuses shared unbound run identity", async () => {
  await withLedgerFixture(async (f) => {
    delete process.env.AK_ROLE_RUN_DIR;
    const bare = registerTool(f.root);
    const context = {
      ...bare.context,
      sessionManager: {},
      terminationBatch: { batchClosed: true, calls: [{ id: "no-id", name: "ak_test_output" }] },
    } as unknown as HostContext;
    await assert.rejects(
      bare.tool().execute("no-id", {}, undefined, undefined, context),
      /submission ledger requires admitted run identity/,
    );
  });
});

test("eight packaged roles seal through the production ledger host", async () => {
  const rows = [
    { role: "judge" as const, details: { judgeStatus: "converged" }, status: "converged" },
    { role: "coder" as const, details: { status: "completed", report: "done" }, status: "completed" },
    { role: "fixer" as const, details: { status: "completed", report: "done", classResults: [] }, status: "completed" },
    { role: "reviewer" as const, details: { status: "completed", version: 2, outcomes: {}, reports: {} }, status: "completed" },
    { role: "doctor" as const, details: { status: "refused", reason: "missing", missingEvidence: [] }, status: "refused" },
    { role: "merger" as const, details: { status: "escalate", attemptId: "a", diagnosis: "d", report: "r" }, status: "escalate" },
    { role: "notary" as const, details: { status: "pass", findings: [] }, status: "pass" },
    { role: "collector" as const, details: { groups: [] }, status: "accepted" },
  ];
  const { sealAcceptedSubmission } = await import("../helpers/submission-ledger-fixture.ts");
  const { packagedRoleOutputTool } = await import("../../src/packaged-role-registry.ts");
  for (const row of rows) {
    await withLedgerFixture(async (f) => {
      process.env.AK_ROLE_RUN_DIR = `${f.root}/runs/run-${row.role}@${row.role}`;
      await sealAcceptedSubmission({
        cwd: f.root,
        home: f.root,
        runId: `run-${row.role}`,
        role: row.role,
        details: row.details,
      });
      const sealed = await readSealedSubmission(f.root, `run-${row.role}`);
      assert.equal(sealed?.kind, "accepted", row.role);
      assert.equal(sealed?.role, row.role);
      assert.equal(sealed?.status, row.status, row.role);
      assert.ok(packagedRoleOutputTool(row.role), row.role);
    });
  }
});

test("a sealed append failure never returns accepted", async () => {
  await withLedgerFixture(async (f) => {
    let recordFile: string | undefined;
    const failing = registerTool(f.root, async () => {
      recordFile = (await ledgerRecords(f.root)).at(-1)?.identity === undefined ? undefined : (await readdir(`${f.root}/.ak-roles/books`, { recursive: true })).find((file) => file.endsWith(".jsonl"));
      if (recordFile !== undefined) await chmod(`${f.root}/.ak-roles/books/${recordFile}`, 0o400);
      return { content: [], details: { status: "completed" }, terminate: true };
    });
    try {
      await assert.rejects(failing.tool().execute("seal-failure", {}, undefined, undefined, { ...failing.context, terminationBatch: { batchClosed: true, calls: [{ id: "seal-failure", name: "ak_test_output" }] } }));
      assert.equal(await readSealedSubmission(f.root, "run-ledger"), undefined);
    } finally {
      if (recordFile !== undefined) await chmod(`${f.root}/.ak-roles/books/${recordFile}`, 0o600);
    }
  });
});
