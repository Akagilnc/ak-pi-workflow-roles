import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { HOST_SESSION_RECORD_KIND } from "../../src/host-session-record.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

/** Medium tracer: real process boundary, native new/resume protocol, and typed receipt. */
test("codex headless host binds and resumes a structured turn", { timeout: 10000 }, async () => {
  const ledger = createTempPackageHomeLedger({ prefix: "ak-codex-host-", runName: "run@codex" });
  const root = ledger.runDirectory;
  const argvLog = join(root, "argv.log");
  const promptLog = join(root, "prompt.log");
  const fakeBin = join(root, "fake-codex");
  const nativeRollout = join(root, ".codex", "sessions", "rollout-thread-fake-1.jsonl");
  await writeFile(fakeBin, `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
const resumeAt = args.indexOf("resume");
const resumed = resumeAt >= 0;
const thread = resumed ? args[resumeAt + 1] : "thread-fake-1";
const prompt = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(prompt) + "\\n");
if (prompt.endsWith("signal-silent")) {
  process.kill(process.pid, "SIGTERM");
}
mkdirSync(dirname(${JSON.stringify(nativeRollout)}), { recursive: true });
const events = [
  { type: "thread.started", thread_id: thread },
  { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "completed", report: resumed ? "resumed" : "initial" }) } },
  ...(prompt.endsWith("missing-terminal") ? [] : [{ type: "turn.completed" }]),
];
process.stdout.write(JSON.stringify(events[0]) + "\\n");
const pointerFile = ${JSON.stringify(join(root, "session", HOST_SESSION_RECORD_KIND, "records.jsonl"))};
const hasPointer = () => existsSync(pointerFile) && readFileSync(pointerFile, "utf8")
  .split("\\n").filter(Boolean).some(line => {
    try { return JSON.parse(line).payload?.type === "native-session-pointer"; }
    catch { return false; }
  });
let checks = 0;
const waitForPointer = setInterval(() => {
  if (hasPointer()) {
    clearInterval(waitForPointer);
    writeFileSync(${JSON.stringify(nativeRollout)}, 'native codex transcript\\n');
    const body = events.slice(1).map(JSON.stringify).join("\\n") + "\\n";
    process.stdout.write(body, () => {
      if (prompt.endsWith("exit-17")) {
        process.stderr.write("HOST STDERR\\n");
        process.exit(17);
      }
      if (prompt.endsWith("signal-after-reply")) {
        process.kill(process.pid, "SIGTERM");
      }
    });
  } else if (++checks >= 500) {
    clearInterval(waitForPointer);
    process.stderr.write("Codex pointer was not recorded before rollout\\n");
    process.exitCode = 1;
  }
}, 10);
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
      env: { CODEX_HOME: join(root, ".codex") },
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
      methods: [],
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
    assert.equal(await readFile(join(root, "session", "codex-gpt-test-1.jsonl"), "utf8"), await readFile(nativeRollout, "utf8"));
    const sitianFile = join(root, "session", HOST_SESSION_RECORD_KIND, "records.jsonl");
    const firstRecords = (await readSitianRecords(sitianFile)).records;
    assert.equal((firstRecords[0]?.payload as { type?: string })?.type, "native-session-pointer");
    assert.equal((firstRecords[0]?.payload as { nativePath?: string })?.nativePath, join(root, ".codex", "sessions"));
    assert.equal((firstRecords[0]?.payload as { sessionId?: string })?.sessionId, "thread-fake-1");
    assert.equal((firstRecords[1]?.payload as { type?: string })?.type, "native-session-copy");
    assert.equal((firstRecords[1]?.payload as { nativePath?: string })?.nativePath, nativeRollout);
    await assert.rejects(readFile(join(root, "headless-output-schema.json"), "utf8"));
    const gapNames = (await readdir(join(root, "artifacts"))).filter((name) => name.startsWith("post-admission-diagnostic-"));
    assert.ok(gapNames.length >= 1);
    const gap = JSON.parse(await readFile(join(root, "artifacts", gapNames[0]!), "utf8")) as { diagnostic?: unknown };
    assert.equal(typeof gap.diagnostic, "string");
    assert.equal(String(gap.diagnostic).includes("--output-schema"), true);

    receipt = undefined;
    const resumed = await host.executeTurn({
      ...request,
      continuation: { kind: "resume", prompt: "continue" },
    });
    assert.equal(resumed.knownFailure, undefined, JSON.stringify(resumed));
    assert.deepEqual(receipt, { status: "completed", report: "resumed" });
    assert.equal(await readFile(join(root, "session", "codex-gpt-test-2.jsonl"), "utf8"), await readFile(nativeRollout, "utf8"));
    const prompts = (await readFile(promptLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
    assert.deepEqual(prompts.slice(0, 2), ["work", "continue"]);
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
    assert.equal(argv[1]!.includes("--output-schema"), false);
    const exited = await host.executeTurn({
      ...request,
      continuation: { kind: "initial", prompt: "exit-17" },
    });
    assert.equal(exited.code, 17);
    assert.equal(exited.signal, undefined);
    assert.equal(exited.knownFailure, undefined);
    assert.equal(exited.stderr.includes("HOST STDERR"), true);
    assert.deepEqual(receipt, { status: "completed", report: "initial" });
    const signaled = await host.executeTurn({
      ...request,
      continuation: { kind: "initial", prompt: "signal-after-reply" },
    });
    assert.equal(signaled.code, null);
    assert.equal(signaled.signal, "SIGTERM");
    assert.equal(signaled.knownFailure, undefined);
    const silent = await host.executeTurn({
      ...request,
      continuation: { kind: "initial", prompt: "signal-silent" },
    });
    assert.equal(silent.code, null);
    assert.equal(silent.signal, "SIGTERM");
    assert.equal(silent.knownFailure, undefined);
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
    });
    const bindNotes = (await readdir(join(ledger.runDirectory, "artifacts")))
      .filter((name) => name.startsWith("post-admission-diagnostic-"));
    const bindBodies = await Promise.all(bindNotes.map(async (name) =>
      JSON.parse(await readFile(join(ledger.runDirectory, "artifacts", name), "utf8")) as { diagnostic?: unknown }));
    assert.equal(bindBodies.some((note) => String(note.diagnostic).includes("read-only")), true);
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
  const rollout = join(ledger.runDirectory, ".codex", "sessions", "rollout-thread-epipe.jsonl");
  await writeFile(fakeBin, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
process.stdin.destroy();
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-epipe" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "completed" }) } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
mkdirSync(dirname(${JSON.stringify(rollout)}), { recursive: true });
writeFileSync(${JSON.stringify(rollout)}, 'native after close\\n');
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
      env: { CODEX_HOME: join(ledger.runDirectory, ".codex") },
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
    assert.equal(await readFile(join(ledger.runDirectory, "session", "codex-gpt-test-1.jsonl"), "utf8"), "native after close\n");
  } finally {
    ledger.dispose();
  }
});
