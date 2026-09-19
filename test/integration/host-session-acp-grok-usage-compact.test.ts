/**
 * #971: grok-build ACP ledgers session/prompt `_meta.usage` and
 * `_x.ai/session_notification` / auto_compact_completed via the sole sitian
 * host-session entry. Real entry = createAcpRoleTurnHost → records.jsonl.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { HOST_SESSION_RECORD_KIND } from "../../src/host-session-record.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

const USAGE_ROUND_1 = Object.freeze({
  inputTokens: 219361,
  outputTokens: 343,
  totalTokens: 219704,
  cachedReadTokens: 128896,
  cacheCreationTokens: 0,
  reasoningTokens: 204,
  modelCalls: 4,
  apiDurationMs: 25284,
  costUsdTicks: 841282400,
  modelUsage: Object.freeze({ "grok-4.6-build": Object.freeze({ inputTokens: 100, outputTokens: 10 }) }),
  numTurns: 4,
});

const USAGE_ROUND_2 = Object.freeze({
  inputTokens: 20600,
  outputTokens: 80,
  totalTokens: 20680,
  cachedReadTokens: 9000,
  cacheCreationTokens: 0,
  reasoningTokens: 12,
  modelCalls: 2,
  apiDurationMs: 1100,
  costUsdTicks: 12000,
  modelUsage: Object.freeze({ "grok-4.6-build": Object.freeze({ inputTokens: 50, outputTokens: 5 }) }),
  numTurns: 5,
});

const COMPACT_PARAMS = Object.freeze({
  sessionId: "acp-971-sess",
  update: Object.freeze({
    sessionUpdate: "auto_compact_completed",
    tokens_before: 90293,
    tokens_after: 9448,
    summary_preview: null,
  }),
  _meta: Object.freeze({ vendor: "x.ai", note: "host-native" }),
});

function request(runDirectory: string, home: string): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "probe" },
    cwd: home,
    home,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
}

function hostSessionRecordFile(runDirectory: string): string {
  return join(runDirectory, "session", HOST_SESSION_RECORD_KIND, "records.jsonl");
}

async function prepareAcceptedHost(input: {
  readonly ledger: ReturnType<typeof createTempPackageHomeLedger>;
  readonly connection: AcpConnection;
}): Promise<ReturnType<typeof createAcpRoleTurnHost>> {
  return createAcpRoleTurnHost({
    hostName: "grok-build",
    modelPassing: "argv",
    boundResume: "session/new",
    sessionIdentity: {
      async load() {
        return undefined;
      },
      async bind() {},
      resolveSessionFile: () => input.ledger.sessionFile,
    },
    connect: async () => input.connection,
    prepare: async () => {
      let rounds = 0;
      return {
        mcpServers: [{ name: "ak-probe", type: "stdio" }],
        systemPrompt: { body: "p", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_coder_output",
        async ingestStructuredOutput() {},
        async closeRound() {
          rounds += 1;
          if (rounds < 2) {
            return {
              accepted: false as const,
              retry: {
                code: "retry-for-second-usage-round",
                toolCallIds: [],
                message: "retry prompt for second usage sample",
              },
            };
          }
          return { accepted: true as const };
        },
      };
    },
  });
}

test("ACP multi-round _meta.usage and auto_compact_completed land in host-session; other extensions stay out", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-971-acp-usage-",
    runName: "run@coder",
  });
  try {
    const handlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
    let promptCount = 0;
    const promptResults = [
      {
        stopReason: "end_turn",
        _meta: {
          sessionId: "acp-971-sess",
          totalTokens: 90293,
          modelId: "grok-4.6",
          inputTokens: 90153,
          outputTokens: 133,
          cachedReadTokens: 66560,
          reasoningTokens: 74,
          usage: USAGE_ROUND_1,
        },
      },
      {
        stopReason: "end_turn",
        _meta: {
          sessionId: "acp-971-sess",
          totalTokens: 9330,
          modelId: "grok-4.6",
          usage: USAGE_ROUND_2,
        },
      },
    ] as const;
    const sessionUpdateParams = {
      sessionId: "acp-971-sess",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      },
    };

    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "acp-971-sess" };
        if (method === "session/prompt") {
          const index = promptCount;
          promptCount += 1;
          for (const handler of handlers) {
            handler("session/update", sessionUpdateParams);
            handler("_x.ai/other_notification", { sessionId: "acp-971-sess", noise: true });
            if (index === 0) handler("_x.ai/session_notification", COMPACT_PARAMS);
          }
          return promptResults[index]!;
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      onNotification(handler) {
        handlers.push(handler);
      },
      async close() {},
    };

    const host = await prepareAcceptedHost({ ledger, connection });
    const result = await host.executeTurn(request(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);
    assert.equal(promptCount, 2);

    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal(records.every((row) => row.kind === HOST_SESSION_RECORD_KIND), true);
    assert.equal(records.every((row) => row.host === "grok-build"), true);
    assert.equal(records.every((row) => row.source === "acp-host"), true);

    const usageRecords = records.filter((row) => {
      const payload = row.payload as { method?: unknown };
      return payload.method === "session/prompt";
    });
    assert.equal(usageRecords.length, 2, JSON.stringify(usageRecords));
    assert.deepEqual(
      (usageRecords[0]!.payload as { result: unknown }).result,
      promptResults[0],
    );
    assert.deepEqual(
      (usageRecords[1]!.payload as { result: unknown }).result,
      promptResults[1],
    );
    assert.deepEqual(
      ((usageRecords[0]!.payload as { result: { _meta: { usage: unknown } } }).result)._meta.usage,
      USAGE_ROUND_1,
    );
    assert.deepEqual(
      ((usageRecords[1]!.payload as { result: { _meta: { usage: unknown } } }).result)._meta.usage,
      USAGE_ROUND_2,
    );

    const compactRecords = records.filter((row) => {
      const payload = row.payload as { method?: unknown };
      return payload.method === "_x.ai/session_notification";
    });
    assert.equal(compactRecords.length, 1, JSON.stringify(compactRecords));
    assert.deepEqual(
      (compactRecords[0]!.payload as { params: unknown }).params,
      COMPACT_PARAMS,
    );

    const sessionUpdates = records.filter((row) => {
      const payload = row.payload as { method?: unknown };
      return payload.method === "session/update";
    });
    assert.equal(sessionUpdates.length, 2, JSON.stringify(sessionUpdates));
    for (const row of sessionUpdates) {
      assert.deepEqual((row.payload as { params: unknown }).params, sessionUpdateParams);
    }

    assert.equal(
      records.some((row) => {
        const payload = row.payload as { method?: unknown };
        return payload.method === "_x.ai/other_notification";
      }),
      false,
      "non-target vendor notifications must not be ledgered",
    );

    const sessionChildren = await readdir(join(ledger.runDirectory, "session"));
    assert.ok(sessionChildren.includes(HOST_SESSION_RECORD_KIND));
  } finally {
    ledger.dispose();
  }
});

test("ACP prompt without _meta.usage and without compact does not invent those records", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-971-acp-no-usage-",
    runName: "run@coder",
  });
  try {
    const handlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "acp-971-sess" };
        if (method === "session/prompt") {
          for (const handler of handlers) {
            handler("session/update", {
              sessionId: "acp-971-sess",
              update: { sessionUpdate: "available_commands_update", availableCommands: [] },
            });
          }
          return { stopReason: "end_turn", _meta: { sessionId: "acp-971-sess", totalTokens: 12 } };
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      onNotification(handler) {
        handlers.push(handler);
      },
      async close() {},
    };

    const host = createAcpRoleTurnHost({
      hostName: "grok-build",
      modelPassing: "argv",
      boundResume: "session/new",
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => ledger.sessionFile,
      },
      connect: async () => connection,
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", type: "stdio" }],
        systemPrompt: { body: "p", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_coder_output",
        async ingestStructuredOutput() {},
        async closeRound() {
          return { accepted: true as const };
        },
      }),
    });

    const result = await host.executeTurn(request(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal(
      records.some((row) => (row.payload as { method?: unknown }).method === "session/prompt"),
      false,
    );
    assert.equal(
      records.some((row) => (row.payload as { method?: unknown }).method === "_x.ai/session_notification"),
      false,
    );
    assert.equal(records.length, 1);
    assert.equal((records[0]!.payload as { method?: unknown }).method, "session/update");
  } finally {
    ledger.dispose();
  }
});

test("ACP _meta.usage write failure surfaces HostSessionRecordFailure", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-971-acp-usage-fail-",
    runName: "run@coder",
  });
  try {
    const sessionDir = join(ledger.runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(ledger.sessionFile, "{}\n", "utf8");
    await chmod(sessionDir, 0o555);

    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "acp-971-sess" };
        if (method === "session/prompt") {
          return {
            stopReason: "end_turn",
            _meta: { sessionId: "acp-971-sess", usage: USAGE_ROUND_1 },
          };
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      onNotification() {},
      async close() {},
    };

    const host = createAcpRoleTurnHost({
      hostName: "grok-build",
      modelPassing: "argv",
      boundResume: "session/new",
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => ledger.sessionFile,
      },
      connect: async () => connection,
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", type: "stdio" }],
        systemPrompt: { body: "p", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_coder_output",
        async ingestStructuredOutput() {},
        async closeRound() {
          return { accepted: true as const };
        },
      }),
    });

    const result = await host.executeTurn(request(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure?.cause, "session", JSON.stringify(result));
    assert.equal(result.knownFailure?.identity?.code, "host-session-record-failed");
    assert.ok(
      typeof result.knownFailure?.diagnostic === "string"
        && result.knownFailure.diagnostic.length > 0,
    );
  } finally {
    try {
      await chmod(join(ledger.runDirectory, "session"), 0o755);
    } catch { /* dispose */ }
    ledger.dispose();
  }
});

test("ACP auto_compact_completed write failure surfaces HostSessionRecordFailure", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-971-acp-compact-fail-",
    runName: "run@coder",
  });
  try {
    const sessionDir = join(ledger.runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(ledger.sessionFile, "{}\n", "utf8");
    await chmod(sessionDir, 0o555);

    const handlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
    let resolvePrompt: ((value: Readonly<Record<string, unknown>>) => void) | undefined;
    const promptNever = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      resolvePrompt = resolve;
    });
    let promptStarted!: () => void;
    const promptStartedGate = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });

    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "acp-971-sess" };
        if (method === "session/prompt") {
          promptStarted();
          setTimeout(() => {
            for (const handler of handlers) {
              handler("_x.ai/session_notification", COMPACT_PARAMS);
            }
          }, 0);
          return promptNever;
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      onNotification(handler) {
        handlers.push(handler);
      },
      async close() {
        resolvePrompt?.({ stopReason: "cancelled" });
      },
    };

    const host = createAcpRoleTurnHost({
      hostName: "grok-build",
      modelPassing: "argv",
      boundResume: "session/new",
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => ledger.sessionFile,
      },
      connect: async () => connection,
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", type: "stdio" }],
        systemPrompt: { body: "p", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_coder_output",
        async ingestStructuredOutput() {},
        async closeRound() {
          return { accepted: true as const };
        },
      }),
    });

    const turnPromise = host.executeTurn(request(ledger.runDirectory, ledger.home));
    await promptStartedGate;
    const result = await turnPromise;
    assert.equal(result.knownFailure?.cause, "session", JSON.stringify(result));
    assert.equal(result.knownFailure?.identity?.code, "host-session-record-failed");
  } finally {
    try {
      await chmod(join(ledger.runDirectory, "session"), 0o755);
    } catch { /* dispose */ }
    ledger.dispose();
  }
});
