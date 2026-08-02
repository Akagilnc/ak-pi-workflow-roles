import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistedInvocationTransportV1 } from "../src/assisted-invocation-transport.ts";
import type { AssistedCallConfigV1 } from "../src/assisted-contracts.ts";

const runId = "018f22a0-7b4c-7abc-8def-0123456789ab";
const callId = "018f22a0-7b4c-7abc-8def-0123456789ac";
const invocationId = "018f22a0-7b4c-7000-8000-000000000001";
const resultDetails = { judgeStatus: "converged", note: "result" };
const callDetails = { judgeStatus: "converged", note: "called" };

type Scenario = "exact" | "orphan" | "empty-id" | "identity-mismatch" | "name-mismatch" | "details-mismatch" | "reversed" | "duplicate-call" | "duplicate-result";

async function fixture(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "assisted-native-lifecycle-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, ".gitignore"), ".ak/work/\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const config: AssistedCallConfigV1 = { version: 1, runId, callId, subject: { repositoryRoot: root, github: { owner: "o", name: "r" }, parentIssue: 28, children: [] }, acquisition: { workspaces: [{ id: "main", root, relation: "repository" }], evidence: [], labelPolicy: [] }, execution: { workspaceId: "main", cwd: root, role: "judge", phase: null, environment: { inherit: true, overrides: {}, unset: [] }, stdin: "inherit" } };
  const call = (id = "call-out", name = "ak_judge_output", details: unknown = resultDetails) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: details }] } });
  const result = (id = "call-out") => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "ak_judge_output", isError: false, details: resultDetails } });
  const rows = scenario === "orphan" ? [result()]
    : scenario === "empty-id" ? [call(""), result("")]
    : scenario === "identity-mismatch" ? [call("call-a"), result("call-b")]
    : scenario === "name-mismatch" ? [call("call-out", "ak_fixer_output", { status: "planned", report: "plan" }), result()]
    : scenario === "details-mismatch" ? [call("call-out", "ak_judge_output", callDetails), result()]
    : scenario === "reversed" ? [result(), call()]
    : scenario === "duplicate-call" ? [call(), call(), result()]
    : scenario === "duplicate-result" ? [call(), result(), result()]
    : [call(), result()];
  const child = join(root, "fake-pi.mjs");
  await writeFile(child, `#!/usr/bin/env node\nimport{mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';const a=process.argv,d=a[a.indexOf('--session-dir')+1],id=a[a.indexOf('--session-id')+1],rows=${JSON.stringify(rows)};mkdirSync(d,{recursive:true});writeFileSync(join(d,'native_'+id+'.jsonl'),rows.map(JSON.stringify).join('\\n')+'\\n');`);
  await chmod(child, 0o755);
  return { config, head, child };
}

test("private native session rejects invalid accepted tool lifecycles", async t => {
  for (const scenario of ["orphan", "empty-id", "identity-mismatch", "name-mismatch", "details-mismatch", "reversed", "duplicate-call", "duplicate-result"] as const) {
    await t.test(scenario, async () => {
      const f = await fixture(scenario);
      await assert.rejects(createAssistedInvocationTransportV1().invokeRole({ config: f.config, invocationId, piArgv: [f.child], beforeTarget: f.head }));
    });
  }
});

test("one exact ordered call/result lifecycle is accepted and recoverable", async () => {
  const f = await fixture("exact"), transport = createAssistedInvocationTransportV1();
  const live = await transport.invokeRole({ config: f.config, invocationId, piArgv: [f.child], beforeTarget: f.head });
  assert.equal(live.terminalClass, "accepted_receipt");
  assert.deepEqual(await transport.readCompleted!({ config: f.config, invocationId, kind: "role", beforeTarget: f.head }), live);
});
