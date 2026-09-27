/**
 * #1091: host adapters report missing resume identity; never mint a new session.
 * Seams: createAcpRoleTurnHost / createHeadlessRoleTurnHost executeTurn(resume).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

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

test("#1091 ACP resume without bound session id reports missing; never session/new", async () => {
  const runDirectory = "/tmp/ak-1091-acp-missing-id";
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
    }),
  });
  const result = await host.executeTurn(baseRequest(runDirectory));
  assert.equal(result.knownFailure?.identity?.code, "session-id-missing");
  assert.equal(result.knownFailure?.identity?.name, "AcpSessionFailure");
  assert.equal(result.knownFailure?.diagnostic, "resume requires a bound session id");
  assert.equal(methods.includes("session/new"), false);
  assert.equal(methods.includes("session/load"), false);
  assert.equal(methods.includes("session/prompt"), false);
});

test("#1091 headless resume without bound session id reports missing; never binds", async () => {
  const description = lookupHeadlessHostDescription("claude");
  assert.ok(description);
  const runDirectory = "/tmp/ak-1091-headless-missing-id";
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
    }),
  });
  const result = await host.executeTurn(baseRequest(runDirectory));
  assert.equal(result.knownFailure?.identity?.code, "session-id-missing");
  assert.equal(result.knownFailure?.identity?.name, "HeadlessSessionFailure");
  assert.equal(result.knownFailure?.diagnostic, "resume requires a bound session id");
  assert.equal(bindCalls, 0);
});