/**
 * Medium #1091/#1032 tracer: adapters retain resume identity, host facts,
 * and independent package faults across the admitted filesystem boundary.
 * Seams: createAcpRoleTurnHost / createHeadlessRoleTurnHost executeTurn(resume).
 */
import assert from "node:assert/strict";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { runLogPayloads } from "../helpers/run-dossier-fixture.ts";

function packageNotes(runDirectory: string): Array<{ diagnostic?: unknown; failure?: { identity?: { code?: unknown } } }> {
  return runLogPayloads(runDirectory, "post-admission-diagnostic");
}

function baseRequest(runDirectory: string): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "resume", prompt: "continue" },
    cwd: runDirectory,
    home: runDirectory,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
}

test("#1091 ACP resume without bound session id reports missing; never session/new", async (t) => {
  const ledger = createTempPackageHomeLedger({ prefix: "ak-1032-acp-missing-", runName: "run@acp" });
  t.after(() => ledger.dispose());
  const runDirectory = ledger.runDirectory;
  const methods: string[] = [];
  const connection: AcpConnection = {
    async request(method) {
      methods.push(method);
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new") return { sessionId: "should-not-mint" };
      if (method === "session/load") return { sessionId: "should-not-load" };
      if (method === "session/close") return {};
      return {};
    },
    notify() {},
    async close() {},
  };
  const host = createAcpRoleTurnHost({
    hostName: "grok-build",
    modelPassing: "argv",
    sessionIdentity: {
      async load() {
        return undefined;
      },
      async bind() {
        throw new Error("resume must not bind a new session id");
      },
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    connect: async () => connection,
    prepare: async () => ({
      mcpServers: [{ name: "ak-probe", type: "stdio" }],
      systemPrompt: { body: "probe", materials: [] },
      prompt: "continue",
      jsonSchema: { type: "object" },
      terminatingToolName: "ak_judge_output",
      async ingestStructuredOutput() {},
      async closeRound() {
        return { accepted: true as const };
      },
      async dispose() {
        throw new Error("cleanup failed");
      },
    }),
  });
  const result = await host.executeTurn(baseRequest(runDirectory));
  assert.equal(result.knownFailure?.identity?.code, "session-id-missing");
  assert.equal(result.knownFailure?.identity?.name, "AcpSessionFailure");
  assert.equal(result.knownFailure?.details?.cleanupError, undefined);
  assert.equal(result.code, null);
  const notes = packageNotes(runDirectory);
  assert.equal(notes.length, 1);
  assert.equal(typeof notes[0]?.diagnostic, "string");
  assert.equal(methods.includes("session/new"), false);
  assert.equal(methods.includes("session/load"), false);
  assert.equal(methods.includes("session/prompt"), false);
});

test("ACP successful turn preserves host facts and carries required disposal failure", async (t) => {
  const ledger = createTempPackageHomeLedger({ prefix: "ak-1032-acp-cleanup-", runName: "run@acp" });
  t.after(() => ledger.dispose());
  const runDirectory = ledger.runDirectory;
  const host = createAcpRoleTurnHost({
    hostName: "hermes",
    modelPassing: "argv",
    sessionIdentity: {
      async load() { throw new Error("explicit resume must not load binding"); },
      async bind() {},
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    connect: async () => ({
      async request(method) {
        if (method === "session/load") return { sessionId: "bound-session" };
        if (method === "session/close") throw Object.assign(new Error("close failed"), { code: "ECLOSE" });
        return {};
      },
      stderr: () => "HOST STDERR\n",
      notify() { throw Object.assign(new Error("cancel failed"), { code: "ECANCEL" }); },
      async close() { throw Object.assign(new Error("connection close failed"), { code: "ECONNECTION" }); },
    }),
    prepare: async () => ({
      mcpServers: [{ name: "ak-probe", type: "stdio" }],
      systemPrompt: { body: "probe", materials: [] },
      prompt: "continue",
      jsonSchema: { type: "object" },
      terminatingToolName: "ak_judge_output",
      async ingestStructuredOutput() {},
      async closeRound() { return { accepted: true as const }; },
      async dispose() { throw Object.assign(new Error("ledger flush failed"), { code: "ELEDGER" }); },
    }),
  });
  const result = await host.executeTurn({
    ...baseRequest(runDirectory),
    continuation: { kind: "resume", prompt: "continue", hostSessionId: "bound-session" },
  });
  assert.deepEqual(result.knownFailure?.identity, { name: "Error", code: "ELEDGER" });
  assert.equal(result.knownFailure?.cause, undefined);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "HOST STDERR\n");
  const notes = packageNotes(runDirectory);
  assert.deepEqual(notes.map((note) => note.failure?.identity?.code).sort(),
    ["ECANCEL", "ECLOSE", "ECONNECTION", "ELEDGER"]);
});

test("#1091 headless resume without bound session id reports missing; never binds", async (t) => {
  const description = lookupHeadlessHostDescription("claude");
  assert.ok(description);
  const ledger = createTempPackageHomeLedger({ prefix: "ak-1032-headless-missing-", runName: "run@claude" });
  t.after(() => ledger.dispose());
  const runDirectory = ledger.runDirectory;
  let bindCalls = 0;
  const host = createHeadlessRoleTurnHost({
    description,
    hostName: "claude",
    binary: "/tmp/ak-1091-never-spawn",
    sessionIdentity: {
      async load() {
        return undefined;
      },
      async bind() {
        bindCalls += 1;
        throw new Error("resume must not bind a new session id");
      },
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    prepare: async () => ({
      mcpServers: [],
      systemPrompt: { body: "system", materials: [] },
      prompt: "continue",
      jsonSchema: { type: "object" },
      terminatingToolName: "ak_judge_output",
      async ingestStructuredOutput() {},
      async closeRound() {
        return { accepted: true as const };
      },
      async dispose() {
        throw new Error("cleanup failed");
      },
    }),
  });
  const result = await host.executeTurn(baseRequest(runDirectory));
  assert.equal(result.knownFailure?.identity?.code, "session-id-missing");
  assert.equal(result.knownFailure?.identity?.name, "HeadlessSessionFailure");
  assert.equal(result.knownFailure?.details?.cleanupError, undefined);
  const notes = packageNotes(runDirectory);
  assert.equal(notes.length, 1);
  assert.equal(typeof notes[0]?.diagnostic, "string");
  assert.equal(bindCalls, 0);
});