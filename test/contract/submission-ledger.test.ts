import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HostContext, HostToolDefinition, RoleHost } from "../../src/host-contracts.ts";
import { readSitianRecords } from "../../src/sitian-reader.ts";
import type { SitianRecord } from "../../src/sitian-contracts.ts";
import { createSubmissionLedgerHost } from "../../src/submission-ledger.ts";
import { Type } from "typebox";

async function fixture() {
  const root = await mkdtemp(`${tmpdir()}/ak-submission-ledger-`);
  execFileSync("git", ["init", "-q", root]);
  let registered: HostToolDefinition | undefined;
  const host = { registerTool(tool: HostToolDefinition) { registered = tool; } } as RoleHost;
  const pipeline = createSubmissionLedgerHost(host, new Set(["ak_test_output"]));
  pipeline.registerTool({ name: "ak_test_output", label: "output", description: "", parameters: Type.Object({}), async execute() { return { content: [], details: { status: "completed" }, terminate: true }; } });
  const context = { cwd: root, mode: "json", model: undefined, sessionManager: {}, abort() {} } as HostContext;
  return { root, context, tool: () => registered! };
}

test("pipeline ledger rejects a sibling batch and chains a later sealed retry with priorEventId", async () => {
  const priorHome = process.env.HOME;
  const f = await fixture();
  process.env.HOME = f.root;
  process.env.AK_ROLE_RUN_DIR = `${f.root}/runs/run-ledger@judge`;
  try {
    await assert.rejects(f.tool().execute("first", {}, undefined, undefined, { ...f.context, terminationBatch: { batchClosed: true, calls: [{ id: "first", name: "ak_test_output" }, { id: "sibling", name: "read" }] } }));
    const accepted = await f.tool().execute("retry", {}, undefined, undefined, { ...f.context, terminationBatch: { batchClosed: true, calls: [{ id: "retry", name: "ak_test_output" }] } });
    assert.equal(accepted.terminate, true);
    const files = await readdir(`${f.root}/.ak-roles/books`, { recursive: true });
    const records: SitianRecord[] = [];
    for (const relative of files.filter((file) => file.endsWith(".jsonl"))) {
      records.push(...(await readSitianRecords(`${f.root}/.ak-roles/books/${relative}`)).records.filter((record) => record.kind.startsWith("submission-")));
    }
    records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    assert.deepEqual(records.map((record) => record.kind), ["submission-candidate", "submission-outcome", "submission-candidate", "submission-sealed"]);
    assert.equal(records[0]?.priorEventId, undefined);
    for (let i = 1; i < records.length; i += 1) assert.equal(records[i]?.priorEventId, records[i - 1]?.identity);
    assert.deepEqual(records.at(-1)?.subject, { runId: "run-ledger", attemptId: "run-ledger" });
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    delete process.env.AK_ROLE_RUN_DIR;
    await rm(f.root, { recursive: true, force: true });
  }
});
