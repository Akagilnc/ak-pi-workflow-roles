import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { HOST_SESSION_RECORD_KIND } from "../../src/host-session-record.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { createSessionIdentityAuthority } from "../../src/session-identity.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { isRecord } from "../../src/unknown-value.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";
import { assertNoRetiredDossierFiles, historyPayloads, readHistoryRows, runLogPayloads } from "../helpers/run-dossier-fixture.ts";

function isNullUnion(schema: unknown): boolean {
  if (!isRecord(schema) || !Array.isArray(schema.anyOf)) return false;
  return schema.anyOf.some((leaf) => isRecord(leaf) && leaf.type === "null");
}

function nonNullBranch(schema: unknown): unknown {
  if (!isNullUnion(schema)) return schema;
  const anyOf = (schema as { anyOf: unknown[] }).anyOf;
  return anyOf.find((leaf) => !(isRecord(leaf) && leaf.type === "null"));
}

/**
 * Declared contract objects close with additionalProperties:false + full required.
 * Only the empirically verified free-JSON map leaf may keep additionalProperties
 * as a lone recursive $ref (native probe); declared properties still require cover.
 */
function assertStrictObjectNodes(node: unknown, path: string): void {
  if (!isRecord(node)) return;
  const objectLike =
    node.type === "object"
    || (Array.isArray(node.type) && node.type.includes("object"))
    || isRecord(node.properties)
    || node.additionalProperties !== undefined;
  if (objectLike) {
    const additional = node.additionalProperties;
    const freeJsonMapRef =
      isRecord(additional)
      && typeof additional.$ref === "string"
      && Object.keys(additional).length === 1;
    if (!freeJsonMapRef) {
      assert.equal(additional, false, `${path} additionalProperties`);
    }
    if (isRecord(node.properties)) {
      assert.ok(Array.isArray(node.required), `${path} required`);
      assert.deepEqual(
        [...(node.required as string[])].sort(),
        Object.keys(node.properties).sort(),
        `${path} required covers properties`,
      );
    }
  }
  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((branch, index) => assertStrictObjectNodes(branch, `${path}.anyOf[${index}]`));
  }
  if (node.items !== undefined) assertStrictObjectNodes(node.items, `${path}.items`);
  if (isRecord(node.properties)) {
    for (const [name, prop] of Object.entries(node.properties)) {
      assertStrictObjectNodes(prop, `${path}.properties.${name}`);
    }
  }
  if (isRecord(node.$defs)) {
    for (const [name, def] of Object.entries(node.$defs)) {
      assertStrictObjectNodes(def, `${path}.$defs.${name}`);
    }
  }
}

/** The independent package-fault notes the run's log.jsonl carries. */
function packageFaultNotes(runDirectory: string): unknown[] {
  return runLogPayloads(runDirectory, "post-admission-diagnostic");
}

/** Medium tracer: real process boundary, native new/resume protocol, and typed receipt. */
test("codex headless host binds and resumes a structured turn", { timeout: 10000 }, async () => {
  const ledger = createTempPackageHomeLedger({ prefix: "ak-codex-host-", runName: "run@codex" });
  const root = ledger.runDirectory;
  const argvLog = join(root, "argv.log");
  const deliveredLog = join(root, "delivered.jsonl");
  const promptLog = join(root, "prompt.log");
  const fakeBin = join(root, "fake-codex");
  const nativeRollout = join(root, ".codex", "sessions", "rollout-thread-fake-1.jsonl");
  await writeFile(fakeBin, `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
// What this CLI was handed at start-up: the system prompt file and the closed output schema.
// The host removes both input files after the turn, so read them while running.
const instructions = args.find((arg) => arg.startsWith("model_instructions_file="));
const schemaAt = args.indexOf("--output-schema");
if (instructions !== undefined && schemaAt >= 0) {
  appendFileSync(${JSON.stringify(deliveredLog)}, JSON.stringify({
    systemPrompt: readFileSync(JSON.parse(instructions.slice("model_instructions_file=".length)), "utf8"),
    outputSchema: JSON.parse(readFileSync(args[schemaAt + 1], "utf8")),
  }) + "\\n");
}
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
const pointerFile = ${JSON.stringify(join(root, "log.jsonl"))};
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
        // Shapes drawn from shared declarations (review status union + Unknown leaves):
        // required nullable keeps null; optional becomes type|null; anyOf description kept.
        jsonSchema: {
          type: "object",
          properties: {
            status: {
              anyOf: [
                { type: "string", const: "completed" },
                { type: "string", const: "continue" },
                { type: "string", const: "escalate" },
              ],
              description: "审核席本轮裁决的判别状态。",
            },
            // Required declared nullable (TypeBox Union[String, Null]) must keep null.
            label: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "required nullable label",
            },
            report: { type: "string" },
            // Optional composite nullable → non-null leaf + unified null at the edge.
            note: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "optional nullable note",
            },
            nested: {
              type: "object",
              properties: {
                a: { type: "string", description: "required a" },
                b: { type: "string", description: "optional b" },
              },
              required: ["a"],
              additionalProperties: true,
            },
            // Declared nullable array items must keep null after projection.
            tags: {
              type: "array",
              items: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            kind: { const: "probe" },
            free: { description: "unknown free JSON leaf" },
          },
          required: ["status", "label", "nested"],
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
    assert.equal(await readFile(join(root, "session", "codex.jsonl"), "utf8"), await readFile(nativeRollout, "utf8"));
    const firstRecords = (await readSitianRecords(join(root, "log.jsonl"))).records
      .filter((record) => record.kind === HOST_SESSION_RECORD_KIND);
    assert.equal((firstRecords[0]?.payload as { type?: string })?.type, "native-session-pointer");
    assert.equal((firstRecords[0]?.payload as { nativePath?: string })?.nativePath, join(root, ".codex", "sessions"));
    assert.equal((firstRecords[0]?.payload as { sessionId?: string })?.sessionId, "thread-fake-1");
    assert.equal((firstRecords[1]?.payload as { type?: string })?.type, "native-session-copy");
    assert.equal((firstRecords[1]?.payload as { nativePath?: string })?.nativePath, nativeRollout);
    const delivered = (await readFile(deliveredLog, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { systemPrompt: string; outputSchema: unknown });
    // Starting the turn left one turn-delivery row on history.jsonl carrying exactly
    // the system prompt and closed schema the CLI was started with.
    const history = readHistoryRows(root);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.kind, "turn-delivery");
    const startedWith = history[0]!.payload as { systemPrompt: string; outputSchema: unknown };
    assert.equal(startedWith.systemPrompt, delivered[0]!.systemPrompt);
    assert.ok(delivered[0]!.systemPrompt.length > 0);
    assert.deepEqual(startedWith.outputSchema, delivered[0]!.outputSchema);
    // The CLI start-up input files are not dossier; nothing retired survives at rest.
    assertNoRetiredDossierFiles(root);
    const schema = delivered[0]!.outputSchema as {
      additionalProperties: unknown;
      required: string[];
      properties: Record<string, unknown>;
      $defs?: Record<string, unknown>;
    };
    assertStrictObjectNodes(schema, "schema");
    assert.deepEqual(
      [...schema.required].sort(),
      ["free", "kind", "label", "nested", "note", "report", "status", "tags"],
    );
    // Required union keeps non-null branches and its declared description.
    assert.equal(isNullUnion(schema.properties.status), false);
    assert.deepEqual(schema.properties.status, {
      anyOf: [
        { type: "string", const: "completed" },
        { type: "string", const: "continue" },
        { type: "string", const: "escalate" },
      ],
      description: "审核席本轮裁决的判别状态。",
    });
    // Required declared nullable keeps null + description (not stripped to bare string).
    assert.equal(isNullUnion(schema.properties.label), true);
    assert.deepEqual(nonNullBranch(schema.properties.label), { type: "string" });
    assert.equal(
      (schema.properties.label as { description?: unknown }).description,
      "required nullable label",
    );
    // Optional composite type|null → unified null at the property edge only.
    assert.equal(isNullUnion(schema.properties.note), true);
    assert.deepEqual(nonNullBranch(schema.properties.note), { type: "string" });
    assert.equal(
      (schema.properties.note as { description?: unknown }).description,
      "optional nullable note",
    );
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
    assert.deepEqual(nestedClosed.properties?.a, { type: "string", description: "required a" });
    assert.equal(isNullUnion(nestedClosed.properties?.b), true);
    assert.deepEqual(nonNullBranch(nestedClosed.properties?.b), { type: "string", description: "optional b" });
    // Optional fields become type|null at the property edge.
    assert.equal(isNullUnion(schema.properties.report), true);
    assert.deepEqual(nonNullBranch(schema.properties.report), { type: "string" });
    assert.equal(isNullUnion(schema.properties.tags), true);
    assert.deepEqual(nonNullBranch(schema.properties.tags), {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "null" }] },
    });
    assert.equal(isNullUnion(schema.properties.kind), true);
    assert.deepEqual(nonNullBranch(schema.properties.kind), { const: "probe", type: "string" });
    assert.equal(isNullUnion(schema.properties.free), true);
    assert.deepEqual(nonNullBranch(schema.properties.free), { $ref: "#/$defs/codexJsonValue" });
    assert.equal(
      (schema.properties.free as { description?: unknown }).description,
      "unknown free JSON leaf",
    );
    const freeJsonObject = (schema.$defs?.codexJsonValue as { anyOf?: unknown[] } | undefined)
      ?.anyOf
      ?.find((leaf) => isRecord(leaf) && leaf.type === "object");
    assert.deepEqual(freeJsonObject, {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: { $ref: "#/$defs/codexJsonValue" },
    });
    // Normal call: structured absence of package-fault notes (not free-text diagnostic matching).
    assert.deepEqual(packageFaultNotes(root), []);

    receipt = undefined;
    const resumed = await host.executeTurn({
      ...request,
      continuation: { kind: "resume", prompt: "continue" },
    });
    assert.equal(resumed.knownFailure, undefined, JSON.stringify(resumed));
    assert.deepEqual(receipt, { status: "completed", report: "resumed" });
    // The resume overwrites the single original; no second numbered copy appears.
    assert.equal(await readFile(join(root, "session", "codex.jsonl"), "utf8"), await readFile(nativeRollout, "utf8"));
    assert.deepEqual((await readdir(join(root, "session"))).filter((entry) => entry.startsWith("codex")), ["codex.jsonl"]);
    // Resume uses the same strict transport schema as the first call.
    const resumedSchema = (JSON.parse((await readFile(deliveredLog, "utf8")).trim().split("\n")[1]!) as { outputSchema: any }).outputSchema;
    assertStrictObjectNodes(resumedSchema, "resumedSchema");
    assert.deepEqual(
      [...resumedSchema.required].sort(),
      ["free", "kind", "label", "nested", "note", "report", "status", "tags"],
    );
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
    assert.equal(argv[1]!.includes("--output-schema"), true);
    const exited = await host.executeTurn({
      ...request,
      continuation: { kind: "initial", prompt: "exit-17" },
    });
    assert.equal(exited.code, 17);
    assert.equal(exited.signal, undefined);
    assert.equal(exited.knownFailure, undefined);
    assert.equal(exited.stderr, "HOST STDERR\n");
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
    assert.equal(failed.code, 0);
    assert.equal(failed.knownFailure, undefined);

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
  error: { code: -32600, message: "thread-store conflict: session already has an active writer (code -32600)" },
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
          if (rejectBind) throw Object.assign(new Error("session identity store is read-only"), { code: "EBIND" });
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
    assert.equal(noThread.knownFailure?.cause, undefined);
    assert.equal((noThread.knownFailure?.details?.error as { code?: number })?.code, -32600);
    assert.equal(
      noThread.knownFailure?.diagnostic,
      "thread-store conflict: session already has an active writer (code -32600)",
    );

    const persisted = await execute("with-thread");
    assert.equal((persisted.knownFailure?.details?.error as { code?: number })?.code, -32600);
    assert.equal(bound, "thread-failed-1");

    bound = undefined;
    rejectBind = true;
    const bindFailed = await execute("with-thread");
    assert.equal(bindFailed.knownFailure?.identity, undefined);
    assert.equal(bindFailed.knownFailure?.cause, undefined);
    assert.equal(
      bindFailed.knownFailure?.diagnostic,
      "thread-store conflict: session already has an active writer (code -32600)",
    );
    assert.deepEqual(bindFailed.knownFailure, persisted.knownFailure);
    assert.equal(bindFailed.code, 1);
    const bindBodies = packageFaultNotes(ledger.runDirectory) as Array<{ failure?: { identity?: { code?: unknown } } }>;
    assert.equal(bindBodies.some((note) => note.failure?.identity?.code === "EBIND"), true);
    rejectBind = false;
    sessionParent = "/dev/null/session.jsonl";
    const recordFailed = await execute("no-thread");
    assert.equal((recordFailed.knownFailure?.details?.error as { code?: number })?.code, -32600);
    assert.equal(
      recordFailed.knownFailure?.diagnostic,
      "thread-store conflict: session already has an active writer (code -32600)",
    );
  } finally {
    ledger.dispose();
  }
});

test("headless stdin delivery error stays independent of the child exit", async () => {
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
    assert.equal(result.code, 0);
    assert.equal(result.knownFailure, undefined);
    const bodies = packageFaultNotes(ledger.runDirectory) as Array<{ failure?: { identity?: { code?: unknown } } }>;
    assert.ok(bodies.some((note) => note.failure?.identity?.code === "EPIPE"));
    assert.equal(await readFile(join(ledger.runDirectory, "session", "codex.jsonl"), "utf8"), "native after close\n");
  } finally {
    ledger.dispose();
  }
});

/**
 * Each run-owned file keeps the failure behaviour of the file it replaced, through the production
 * host with the production session-identity authority (no stub): a log.jsonl that cannot be
 * written changes neither the bound thread nor the delivered receipt; a history.jsonl that cannot
 * be written does not stop the CLI from starting (it is noted); every CLI start leaves its own
 * turn-delivery row, a re-asked round included.
 */
for (const scenario of ["log-unwritable", "history-unwritable", "re-asked-round"] as const) {
  test(`headless host, production session identity: ${scenario}`, { timeout: 20000 }, async () => {
    const ledger = createTempPackageHomeLedger({ prefix: "ak-run-files-", runName: "run@codex" });
    const root = ledger.runDirectory;
    const startsFile = join(root, "starts.log");
    const fakeBin = join(root, "fake-codex");
    await writeFile(fakeBin, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(startsFile)}, "start\\n");
// What this start was handed: the system prompt file and the closed schema (removed after the turn).
const args = process.argv.slice(2);
const instructions = args.find((arg) => arg.startsWith("model_instructions_file="));
const schemaAt = args.indexOf("--output-schema");
appendFileSync(${JSON.stringify(join(root, "handed.jsonl"))}, JSON.stringify({
  systemPrompt: readFileSync(JSON.parse(instructions.slice("model_instructions_file=".length)), "utf8"),
  outputSchema: JSON.parse(readFileSync(args[schemaAt + 1], "utf8")),
}) + "\\n");
readFileSync(0, "utf8");
const events = [
  { type: "thread.started", thread_id: "thread-1" },
  { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "completed", report: "r" }) } },
  { type: "turn.completed" },
];
process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
`, "utf8");
    await chmod(fakeBin, 0o755);
    const readOnly = scenario === "log-unwritable" ? "log.jsonl" : scenario === "history-unwritable" ? "history.jsonl" : undefined;
    try {
      if (readOnly !== undefined) {
        await writeFile(join(root, readOnly), "", { flag: "a" });
        await chmod(join(root, readOnly), 0o400);
      }
      const principal = fixturePrincipal(join(root, "session"));
      const sessionIdentity = createSessionIdentityAuthority(piDurablePrincipalAuthority, "codex");
      let ingested = 0;
      let closes = 0;
      const description = lookupHeadlessHostDescription("codex");
      assert.ok(description);
      const host = createHeadlessRoleTurnHost({
        description,
        hostName: "codex",
        binary: fakeBin,
        env: { CODEX_HOME: join(root, ".codex") },
        sessionIdentity,
        prepare: async (request) => ({
          mcpServers: [],
          systemPrompt: { body: "system", materials: [] },
          prompt: request.continuation.prompt,
          jsonSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: true },
          terminatingToolName: "ak_probe_output",
          async ingestStructuredOutput() { ingested += 1; },
          async closeRound() {
            closes += 1;
            return scenario === "re-asked-round" && closes === 1
              ? { accepted: false as const, retry: { code: "again", toolCallIds: [], message: "again" } }
              : { accepted: true as const };
          },
        }),
      });
      const result = await host.executeTurn({
        principal,
        activation: { role: "inspector" },
        methods: [],
        continuation: { kind: "initial", prompt: "work" },
        model: { provider: "openai-codex", model: "gpt-test", thinking: "low" },
        cwd: root,
        home: root,
        agentDir: join(root, "agent"),
        runDirectory: root,
      });
      const starts = (await readFile(startsFile, "utf8")).split("\n").filter(Boolean).length;
      assert.equal(result.knownFailure, undefined);
      assert.equal(result.code, 0);
      assert.equal(await sessionIdentity.load(principal), "thread-1");
      assert.equal(ingested, scenario === "re-asked-round" ? 2 : 1);
      const delivered = readHistoryRows(root).filter((row) => row.kind === "turn-delivery").length;
      if (scenario === "history-unwritable") {
        assert.equal(starts, 1);
        assert.equal(delivered, 0);
        assert.equal(packageFaultNotes(root).length > 0, true, "the lost turn-delivery row is noted");
      } else {
        assert.equal(delivered, starts, "one turn-delivery row per CLI start");
        const handed = (await readFile(join(root, "handed.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
        assert.deepEqual(historyPayloads(root, "turn-delivery"), handed, "each row is what that start was handed");
        assert.equal(starts, scenario === "re-asked-round" ? 2 : 1);
      }
    } finally {
      ledger.dispose();
    }
  });
}
