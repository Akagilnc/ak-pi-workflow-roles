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
  const fakeBin = join(root, "fake-codex");
  await writeFile(fakeBin, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
const resumeAt = args.indexOf("resume");
const resumed = resumeAt >= 0;
const thread = resumed ? args[resumeAt + 1] : "thread-fake-1";
const prompt = readFileSync(0, "utf8");
const events = [
  { type: "thread.started", thread_id: thread },
  { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "completed", report: resumed ? "resumed" : "initial" }) } },
  ...(prompt === "missing-terminal" ? [] : [{ type: "turn.completed" }]),
];
process.stdout.write(events.map(JSON.stringify).join("\\n") + "\\n");
`, "utf8");
  await chmod(fakeBin, 0o755);

  try {
    const description = lookupHeadlessHostDescription("codex");
    assert.ok(description);
    let bound: string | undefined;
    let receipt: unknown;
    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "codex",
      binary: fakeBin,
      sessionIdentity: {
        async load() { return bound; },
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
    const schema = JSON.parse(await readFile(join(root, "headless-output-schema.json"), "utf8")) as {
      additionalProperties: unknown;
      required: string[];
      properties: Record<string, unknown>;
      $defs?: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      [...schema.required].sort(),
      ["free", "kind", "label", "nested", "note", "report", "status", "tags"],
    );
    // Required fields keep non-null closed types.
    assert.equal(isNullUnion(schema.properties.status), false);
    assert.deepEqual(schema.properties.status, { type: "string" });
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
    const argv = (await readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(argv[1]!.slice(0, 4), ["exec", "--approve-for-me", "resume", "thread-fake-1"]);
    assert.ok(argv[1]!.includes("--output-schema"));
    assert.ok(argv[1]!.some((arg) => arg === "mcp_servers.ak-probe.required=true"));

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
