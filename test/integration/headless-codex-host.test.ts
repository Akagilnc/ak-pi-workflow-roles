import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

function isNullUnion(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const anyOf = (schema as { anyOf?: unknown }).anyOf;
  if (!Array.isArray(anyOf)) return false;
  return anyOf.some((leaf) => typeof leaf === "object" && leaf !== null && (leaf as { type?: unknown }).type === "null");
}

function nonNullBranch(schema: unknown): unknown {
  if (!isNullUnion(schema)) return schema;
  const anyOf = (schema as { anyOf: unknown[] }).anyOf;
  return anyOf.find((leaf) => !(typeof leaf === "object" && leaf !== null && (leaf as { type?: unknown }).type === "null"));
}

/** Medium tracer: real process boundary, native new/resume protocol, and typed receipt. */
test("codex headless host binds and resumes a structured turn", async () => {
  const ledger = createTempPackageHomeLedger({ prefix: "ak-codex-host-", runName: "run@codex" });
  const root = ledger.runDirectory;
  const argvLog = join(root, "argv.log");
  const promptLog = join(root, "prompt.log");
  const fakeBin = join(root, "fake-codex");
  await writeFile(fakeBin, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
const resumeAt = args.indexOf("resume");
const resumed = resumeAt >= 0;
const thread = resumed ? args[resumeAt + 1] : "thread-fake-1";
const prompt = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(prompt) + "\\n");
const events = [
  { type: "thread.started", thread_id: thread },
  { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "completed", report: resumed ? "resumed" : "initial" }) } },
  ...(prompt.endsWith("missing-terminal") ? [] : [{ type: "turn.completed" }]),
];
process.stdout.write(events.map(JSON.stringify).join("\\n") + "\\n");
`, "utf8");
  await chmod(fakeBin, 0o755);

  try {
    const description = lookupHeadlessHostDescription("codex");
    assert.ok(description);
    let bound: string | undefined;
    let receipt: unknown;
    let rejectLoad = false;
    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "codex",
      binary: fakeBin,
      sessionIdentity: {
        async load() {
          if (rejectLoad) throw new Error("explicit resume must use the stored host session id");
          return bound;
        },
        async bind(_principal, id) { bound = id; },
        resolveSessionFile: () => join(root, "session", "session.jsonl"),
      },
      prepare: async (request) => ({
        mcpServers: [{ name: "ak-probe", command: "/usr/bin/node", args: ["relay.mjs"] }],
        systemPrompt: { body: "system", materials: [] },
        prompt: request.continuation.prompt,
        // Realistic open-schema shapes the production closer must preserve:
        // required stays non-null; optional becomes type|null; nested/array/const/unknown kept.
        jsonSchema: {
          type: "object",
          properties: {
            status: { type: "string" },
            routingStatus: { description: "completed | refused — shape guidance, not a schema gate" },
            // Composite nullable type: strip null in-leaf; required keeps non-null.
            label: { type: ["string", "null"] },
            report: { type: "string" },
            // Optional composite nullable → non-null leaf + unified null at the edge.
            note: { type: ["string", "null"] },
            nested: {
              type: "object",
              properties: {
                a: { type: "string" },
                b: { type: "string" },
              },
              required: ["a"],
              additionalProperties: true,
            },
            tags: { type: "array", items: { type: "string" } },
            kind: { const: "probe" },
            free: { description: "unknown free JSON leaf" },
          },
          required: ["status", "routingStatus", "label", "nested"],
          additionalProperties: true,
        },
        terminatingToolName: "ak_probe_output",
        async ingestStructuredOutput(value) { receipt = value; },
        async closeRound() { return { accepted: true as const }; },
      }),
    });
    const request: RoleTurnRequest = {
      principal: fixturePrincipal(join(root, "session")),
      activation: { role: "inspector" },
      methods: [
        { kind: "skill", path: "/package/resources/methods/diagnosing-bugs/SKILL.md" },
        { kind: "skill", path: "/package/resources/methods/tdd/SKILL.md" },
      ],
      continuation: { kind: "initial", prompt: "work" },
      model: { provider: "openai-codex", model: "gpt-test", thinking: "low" },
      cwd: root,
      home: root,
      agentDir: join(root, "agent"),
      runDirectory: root,
    };

    const first = await host.executeTurn(request);
    assert.equal(first.knownFailure, undefined, JSON.stringify(first));
    assert.equal(bound, "thread-fake-1");
    assert.deepEqual(receipt, { status: "completed", report: "initial" });
    const schema = JSON.parse(await readFile(join(root, "headless-output-schema.json"), "utf8")) as {
      additionalProperties: unknown;
      required: string[];
      properties: Record<string, unknown>;
      $defs?: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      [...schema.required].sort(),
      ["free", "kind", "label", "nested", "note", "report", "routingStatus", "status", "tags"],
    );
    // Required fields keep non-null closed types.
    assert.equal(isNullUnion(schema.properties.status), false);
    assert.deepEqual(schema.properties.status, { type: "string" });
    const routingDescription =
      (schema.properties.routingStatus as { description?: unknown }).description;
    assert.equal(typeof routingDescription, "string");
    assert.notEqual(routingDescription, "");
    // Required composite type|["string","null"] → non-null string (not {type:"null"}).
    assert.equal(isNullUnion(schema.properties.label), false);
    assert.deepEqual(schema.properties.label, { type: "string" });
    // Optional composite type|null → unified null at the property edge only.
    assert.equal(isNullUnion(schema.properties.note), true);
    assert.deepEqual(nonNullBranch(schema.properties.note), { type: "string" });
    const nestedClosed = schema.properties.nested as {
      type?: string;
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: unknown;
    };
    assert.equal(isNullUnion(nestedClosed), false);
    assert.equal(nestedClosed.type, "object");
    assert.equal(nestedClosed.additionalProperties, false);
    assert.deepEqual([...(nestedClosed.required ?? [])].sort(), ["a", "b"]);
    assert.equal(isNullUnion(nestedClosed.properties?.a), false);
    assert.deepEqual(nestedClosed.properties?.a, { type: "string" });
    assert.equal(isNullUnion(nestedClosed.properties?.b), true);
    assert.deepEqual(nonNullBranch(nestedClosed.properties?.b), { type: "string" });
    // Optional fields become type|null at the property edge.
    assert.equal(isNullUnion(schema.properties.report), true);
    assert.deepEqual(nonNullBranch(schema.properties.report), { type: "string" });
    assert.equal(isNullUnion(schema.properties.tags), true);
    assert.deepEqual(nonNullBranch(schema.properties.tags), { type: "array", items: { type: "string" } });
    assert.equal(isNullUnion(schema.properties.kind), true);
    assert.deepEqual(nonNullBranch(schema.properties.kind), { const: "probe", type: "string" });
    assert.equal(isNullUnion(schema.properties.free), true);
    assert.deepEqual(nonNullBranch(schema.properties.free), { $ref: "#/$defs/codexJsonValue" });
    assert.ok(schema.$defs?.codexJsonValue);

    receipt = undefined;
    const resumed = await host.executeTurn({
      ...request,
      continuation: { kind: "resume", prompt: "continue" },
    });
    assert.equal(resumed.knownFailure, undefined, JSON.stringify(resumed));
    assert.deepEqual(receipt, { status: "completed", report: "resumed" });
    const prompts = (await readFile(promptLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
    assert.deepEqual(prompts.slice(0, 2), [
      "$diagnosing-bugs $tdd work",
      "continue",
    ]);
    const argv = (await readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(argv[1]!.slice(0, 4), ["exec", "--approve-for-me", "resume", "thread-fake-1"]);
    rejectLoad = true;
    const explicit = await host.executeTurn({
      ...request,
      continuation: { kind: "resume", prompt: "from-package", hostSessionId: "thread-from-package" },
    });
    assert.equal(explicit.knownFailure, undefined, JSON.stringify(explicit));
    const explicitArgv = (await readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(explicitArgv.at(-1)!.slice(0, 4), ["exec", "--approve-for-me", "resume", "thread-from-package"]);
    rejectLoad = false;
    assert.ok(argv[1]!.includes("--output-schema"));
    assert.ok(argv[1]!.some((arg) => arg === "mcp_servers.ak-probe.required=true"));
    assert.ok(argv[1]!.includes("mcp_servers.ak-probe.tool_timeout_sec=3600"));
    assert.ok(explicitArgv.at(-1)!.includes("mcp_servers.ak-probe.tool_timeout_sec=3600"));

    const failed = await host.executeTurn({
      ...request,
      continuation: { kind: "initial", prompt: "missing-terminal" },
    });
    assert.equal(failed.knownFailure?.identity?.code, "codex-missing-terminal-event");

    // Git work tree recognized (.git present) but rev-parse fails → loud terminal, no spawn.
    // Point gitdir at a missing path so nested temp dirs inside a real worktree still fail.
    const brokenGitCwd = join(root, "broken-git-cwd");
    await mkdir(brokenGitCwd, { recursive: true });
    await writeFile(join(brokenGitCwd, ".git"), "gitdir: /nonexistent/ak-roles-missing-git\n", "utf8");
    const beforeGitFail = (await readFile(argvLog, "utf8")).trim().split("\n").filter(Boolean).length;
    const gitFailed = await host.executeTurn({
      ...request,
      cwd: brokenGitCwd,
      continuation: { kind: "initial", prompt: "git-fail" },
    });
    assert.equal(gitFailed.knownFailure?.identity?.code, "argv-failed");
    const afterGitFail = (await readFile(argvLog, "utf8")).trim().split("\n").filter(Boolean).length;
    assert.equal(afterGitFail, beforeGitFail, "codex must not spawn after git common-dir failure");
  } finally {
    ledger.dispose();
  }
});

test("#959 missing host binary stays activation spawn-failed with real path", async () => {
  const ledger = createTempPackageHomeLedger({ prefix: "ak-959-missing-bin-", runName: "run@codex" });
  try {
    const description = lookupHeadlessHostDescription("codex");
    assert.ok(description);
    // Temp path only — never the machine install. Real entry createHeadlessRoleTurnHost.
    const missingBin = join(ledger.runDirectory, "no-such-codex-binary");
    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "codex",
      binary: missingBin,
      sessionIdentity: {
        async load() { return undefined; },
        async bind() {},
        resolveSessionFile: () => join(ledger.runDirectory, "session", "session.jsonl"),
      },
      prepare: async () => ({
        mcpServers: [],
        systemPrompt: { body: "system", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_navigator_output",
        async ingestStructuredOutput() {},
        async closeRound() { return { accepted: true as const }; },
      }),
    });
    const result = await host.executeTurn({
      principal: fixturePrincipal(join(ledger.runDirectory, "session")),
      activation: { role: "navigator" },
      methods: [],
      continuation: { kind: "initial", prompt: "probe" },
      model: { provider: "openai-codex", model: "gpt-test", thinking: "low" },
      cwd: ledger.runDirectory,
      home: ledger.home,
      agentDir: join(ledger.runDirectory, "agent"),
      runDirectory: ledger.runDirectory,
    });
    assert.equal(result.knownFailure?.cause, "activation", JSON.stringify(result));
    assert.equal(result.knownFailure?.identity?.code, "spawn-failed");
    assert.equal(result.knownFailure?.identity?.name, "HeadlessSpawnFailure");
    const details = result.knownFailure?.details as { binary?: string } | undefined;
    assert.equal(details?.binary, missingBin);
    // Host-layer producer only — structured identity + binary path; no free-text
    // diagnostic matching. Full chain is navigator-attendance 怎么验#2.
    assert.notEqual(
      (result.knownFailure?.diagnostic ?? "").trim(),
      "",
      "missing-binary diagnostic must stay non-empty",
    );
  } finally {
    ledger.dispose();
  }
});

test("#987 codex host failure preserves its diagnostic and resumable thread", async () => {
  // Result 6 / 失败诚实: host failure wins with or without a thread id;
  // persistence remains best-effort and cannot replace that terminal.
  const ledger = createTempPackageHomeLedger({ prefix: "ak-987-codex-fail-", runName: "run@codex" });
  const fakeBin = join(ledger.runDirectory, "fake-codex-turn-failed");
  await writeFile(
    fakeBin,
    `#!/usr/bin/env node
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes("with-thread")) {
  process.stdout.write(JSON.stringify({
    type: "thread.started",
    thread_id: "thread-failed-1",
  }) + "\\n");
}
process.stdout.write(JSON.stringify({
  type: "turn.failed",
  error: { message: "thread-store conflict: session already has an active writer (code -32600)" },
}) + "\\n");
process.exit(1);
`,
    "utf8",
  );
  await chmod(fakeBin, 0o755);
  try {
    const description = lookupHeadlessHostDescription("codex");
    assert.ok(description);
    let bound: string | undefined;
    let rejectBind = false;
    let sessionParent = join(ledger.runDirectory, "session", "session.jsonl");
    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "codex",
      binary: fakeBin,
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind(_principal, id) {
          if (rejectBind) throw new Error("session identity store is read-only");
          bound = id;
        },
        resolveSessionFile: () => sessionParent,
      },
      prepare: async (request) => ({
        mcpServers: [],
        systemPrompt: { body: "system", materials: [] },
        prompt: request.continuation.prompt,
        jsonSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
        terminatingToolName: "ak_probe_output",
        async ingestStructuredOutput() {},
        async closeRound() {
          return { accepted: true as const };
        },
      }),
    });
    const execute = (prompt: string) => host.executeTurn({
      principal: fixturePrincipal(join(ledger.runDirectory, "session")),
      activation: { role: "inspector" },
      methods: [],
      continuation: { kind: "initial", prompt },
      model: { provider: "openai-codex", model: "gpt-test", thinking: "low" },
      cwd: ledger.runDirectory,
      home: ledger.runDirectory,
      agentDir: join(ledger.runDirectory, "agent"),
      runDirectory: ledger.runDirectory,
    });

    const noThread = await execute("no-thread");
    assert.equal(noThread.knownFailure?.identity?.code, "codex-turn-failed");
    assert.equal(
      noThread.knownFailure?.diagnostic,
      "thread-store conflict: session already has an active writer (code -32600)",
    );

    const persisted = await execute("with-thread");
    assert.equal(persisted.knownFailure?.identity?.code, "codex-turn-failed");
    assert.equal(bound, "thread-failed-1");

    bound = undefined;
    rejectBind = true;
    const bindFailed = await execute("with-thread");
    assert.equal(bindFailed.knownFailure?.identity?.name, "HeadlessCliError");
    assert.equal(bindFailed.knownFailure?.identity?.code, "codex-turn-failed");
    assert.equal(
      bindFailed.knownFailure?.diagnostic,
      "thread-store conflict: session already has an active writer (code -32600)",
    );
    assert.deepEqual(bindFailed.knownFailure?.details, {
      sessionId: "thread-failed-1",
      exitCode: 1,
      sessionBindingDiagnostic: "session identity store is read-only",
    });
    rejectBind = false;
    sessionParent = "/dev/null/session.jsonl";
    const recordFailed = await execute("no-thread");
    assert.equal(recordFailed.knownFailure?.identity?.code, "codex-turn-failed");
    assert.equal(
      recordFailed.knownFailure?.diagnostic,
      "thread-store conflict: session already has an active writer (code -32600)",
    );
  } finally {
    ledger.dispose();
  }
});

test("headless stdin delivery error cannot settle valid output as success", async () => {
  const ledger = createTempPackageHomeLedger({ prefix: "ak-headless-epipe-", runName: "run@codex" });
  const fakeBin = join(ledger.runDirectory, "fake-codex-epipe");
  await writeFile(fakeBin, `#!/usr/bin/env node
process.stdin.destroy();
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-epipe" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "completed" }) } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
process.exit(0);
`, "utf8");
  await chmod(fakeBin, 0o755);
  try {
    const description = lookupHeadlessHostDescription("codex");
    assert.ok(description);
    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "codex",
      binary: fakeBin,
      sessionIdentity: { async load() { return undefined; }, async bind() {}, resolveSessionFile: () => join(ledger.runDirectory, "session", "session.jsonl") },
      prepare: async () => ({
        mcpServers: [],
        systemPrompt: { body: "system", materials: [] },
        prompt: "x".repeat(8 * 1024 * 1024),
        jsonSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
        terminatingToolName: "ak_probe_output",
        async ingestStructuredOutput() {},
        async closeRound() { return { accepted: true as const }; },
      }),
    });
    const result = await host.executeTurn({
      principal: fixturePrincipal(join(ledger.runDirectory, "session")),
      activation: { role: "inspector" },
      methods: [],
      continuation: { kind: "initial", prompt: "ignored" },
      model: { provider: "openai-codex", model: "gpt-test", thinking: "low" },
      cwd: ledger.runDirectory,
      home: ledger.runDirectory,
      agentDir: join(ledger.runDirectory, "agent"),
      runDirectory: ledger.runDirectory,
    });
    assert.notEqual(result.code, 0);
    assert.notEqual(result.knownFailure, undefined);
  } finally {
    ledger.dispose();
  }
});
