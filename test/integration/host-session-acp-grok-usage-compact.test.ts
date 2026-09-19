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

type Ledger = ReturnType<typeof createTempPackageHomeLedger>;

/** Field-fidelity samples — keep small; deep-equal proves host-native structure. */
const USAGE_ROUND_1 = Object.freeze({
  inputTokens: 219361,
  outputTokens: 343,
  totalTokens: 219704,
  modelUsage: Object.freeze({ "grok-4.6-build": Object.freeze({ inputTokens: 100, outputTokens: 10 }) }),
});
const USAGE_ROUND_2 = Object.freeze({
  inputTokens: 20600,
  outputTokens: 80,
  totalTokens: 20680,
});
const COMPACT_PARAMS = Object.freeze({
  sessionId: "acp-971-sess",
  update: Object.freeze({
    sessionUpdate: "auto_compact_completed",
    tokens_before: 90293,
    tokens_after: 9448,
    summary_preview: null,
  }),
  _meta: Object.freeze({ vendor: "x.ai" }),
});
const SESSION_UPDATE = Object.freeze({
  sessionId: "acp-971-sess",
  update: Object.freeze({
    sessionUpdate: "agent_message_chunk",
    content: Object.freeze({ type: "text", text: "ok" }),
  }),
});
const PROMPT_WITH_USAGE_1 = Object.freeze({
  stopReason: "end_turn",
  _meta: Object.freeze({ sessionId: "acp-971-sess", usage: USAGE_ROUND_1 }),
});
const PROMPT_WITH_USAGE_2 = Object.freeze({
  stopReason: "end_turn",
  _meta: Object.freeze({ sessionId: "acp-971-sess", usage: USAGE_ROUND_2 }),
});
const PROMPT_NO_USAGE = Object.freeze({
  stopReason: "end_turn",
  _meta: Object.freeze({ sessionId: "acp-971-sess", totalTokens: 12 }),
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

function payloadMethod(row: { payload?: unknown }): unknown {
  return (row.payload as { method?: unknown } | undefined)?.method;
}

function createHost(input: {
  readonly ledger: Ledger;
  readonly connection: AcpConnection;
  readonly hostName?: string;
  readonly acceptAfterRounds?: number;
}): ReturnType<typeof createAcpRoleTurnHost> {
  const acceptAfter = input.acceptAfterRounds ?? 1;
  return createAcpRoleTurnHost({
    hostName: input.hostName ?? "grok-build",
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
          if (rounds < acceptAfter) {
            return {
              accepted: false as const,
              retry: {
                code: "retry-for-next-usage-round",
                toolCallIds: [],
                message: "retry prompt",
              },
            };
          }
          return { accepted: true as const };
        },
      };
    },
  });
}

function scriptedConnection(input: {
  readonly promptResults: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly onPrompt?: (
    handlers: ReadonlyArray<(method: string, params: Readonly<Record<string, unknown>>) => void>,
    index: number,
  ) => void;
  readonly hangPrompt?: boolean;
}): { connection: AcpConnection; promptCount: () => number; promptStarted: Promise<void> } {
  const handlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
  let promptCount = 0;
  let resolvePrompt: ((value: Readonly<Record<string, unknown>>) => void) | undefined;
  const promptNever = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
    resolvePrompt = resolve;
  });
  let releaseStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  const connection: AcpConnection = {
    async request(method) {
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new") return { sessionId: "acp-971-sess" };
      if (method === "session/prompt") {
        const index = promptCount;
        promptCount += 1;
        if (input.hangPrompt) {
          releaseStarted();
          input.onPrompt?.(handlers, index);
          return promptNever;
        }
        input.onPrompt?.(handlers, index);
        return input.promptResults[index] ?? { stopReason: "end_turn" };
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
  return { connection, promptCount: () => promptCount, promptStarted };
}

async function withFrozenSessionDir<T>(ledger: Ledger, run: () => Promise<T>): Promise<T> {
  const sessionDir = join(ledger.runDirectory, "session");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(ledger.sessionFile, "{}\n", "utf8");
  await chmod(sessionDir, 0o555);
  try {
    return await run();
  } finally {
    try {
      await chmod(sessionDir, 0o755);
    } catch { /* dispose */ }
  }
}

test("ACP multi-round _meta.usage and auto_compact_completed land in host-session; other extensions stay out", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-971-acp-usage-",
    runName: "run@coder",
  });
  try {
    const promptResults = [PROMPT_WITH_USAGE_1, PROMPT_WITH_USAGE_2];
    const { connection, promptCount } = scriptedConnection({
      promptResults,
      onPrompt(handlers, index) {
        for (const handler of handlers) {
          handler("session/update", SESSION_UPDATE);
          handler("_x.ai/other_notification", { sessionId: "acp-971-sess", noise: true });
          if (index === 0) handler("_x.ai/session_notification", COMPACT_PARAMS);
        }
      },
    });
    const host = createHost({ ledger, connection, acceptAfterRounds: 2 });
    const result = await host.executeTurn(request(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);
    assert.equal(promptCount(), 2);

    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal(records.every((row) => row.kind === HOST_SESSION_RECORD_KIND), true);
    assert.equal(records.every((row) => row.host === "grok-build"), true);
    assert.equal(records.every((row) => row.source === "acp-host"), true);

    const usageRecords = records.filter((row) => payloadMethod(row) === "session/prompt");
    assert.equal(usageRecords.length, 2, JSON.stringify(usageRecords));
    assert.deepEqual((usageRecords[0]!.payload as { result: unknown }).result, promptResults[0]);
    assert.deepEqual((usageRecords[1]!.payload as { result: unknown }).result, promptResults[1]);
    assert.deepEqual(
      ((usageRecords[0]!.payload as { result: { _meta: { usage: unknown } } }).result)._meta.usage,
      USAGE_ROUND_1,
    );
    assert.deepEqual(
      ((usageRecords[1]!.payload as { result: { _meta: { usage: unknown } } }).result)._meta.usage,
      USAGE_ROUND_2,
    );

    const compactRecords = records.filter((row) => payloadMethod(row) === "_x.ai/session_notification");
    assert.equal(compactRecords.length, 1, JSON.stringify(compactRecords));
    assert.deepEqual((compactRecords[0]!.payload as { params: unknown }).params, COMPACT_PARAMS);

    const sessionUpdates = records.filter((row) => payloadMethod(row) === "session/update");
    assert.equal(sessionUpdates.length, 2, JSON.stringify(sessionUpdates));
    for (const row of sessionUpdates) {
      assert.deepEqual((row.payload as { params: unknown }).params, SESSION_UPDATE);
    }
    assert.equal(
      records.some((row) => payloadMethod(row) === "_x.ai/other_notification"),
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
    const { connection } = scriptedConnection({
      promptResults: [PROMPT_NO_USAGE],
      onPrompt(handlers) {
        for (const handler of handlers) {
          handler("session/update", {
            sessionId: "acp-971-sess",
            update: { sessionUpdate: "available_commands_update", availableCommands: [] },
          });
        }
      },
    });
    const host = createHost({ ledger, connection });
    const result = await host.executeTurn(request(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal(records.some((row) => payloadMethod(row) === "session/prompt"), false);
    assert.equal(records.some((row) => payloadMethod(row) === "_x.ai/session_notification"), false);
    assert.equal(records.length, 1);
    assert.equal(payloadMethod(records[0]!), "session/update");
  } finally {
    ledger.dispose();
  }
});

test("non-target ACP host (hermes) does not ledger #971 usage or auto_compact records", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-971-acp-hermes-",
    runName: "run@coder",
  });
  try {
    const { connection } = scriptedConnection({
      promptResults: [PROMPT_WITH_USAGE_1],
      onPrompt(handlers) {
        for (const handler of handlers) {
          handler("session/update", SESSION_UPDATE);
          handler("_x.ai/session_notification", COMPACT_PARAMS);
        }
      },
    });
    const host = createHost({ ledger, connection, hostName: "hermes" });
    const result = await host.executeTurn(request(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal(records.every((row) => row.host === "hermes"), true);
    assert.equal(records.some((row) => payloadMethod(row) === "session/prompt"), false);
    assert.equal(records.some((row) => payloadMethod(row) === "_x.ai/session_notification"), false);
    assert.equal(records.length, 1);
    assert.equal(payloadMethod(records[0]!), "session/update");
  } finally {
    ledger.dispose();
  }
});

async function assertHostSessionRecordFailure(input: {
  readonly prefix: string;
  readonly hangPrompt?: boolean;
  readonly promptResults?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly onPrompt?: (
    handlers: ReadonlyArray<(method: string, params: Readonly<Record<string, unknown>>) => void>,
    index: number,
  ) => void;
}): Promise<void> {
  const ledger = createTempPackageHomeLedger({
    prefix: input.prefix,
    runName: "run@coder",
  });
  try {
    await withFrozenSessionDir(ledger, async () => {
      const { connection, promptStarted } = scriptedConnection({
        promptResults: input.promptResults ?? [],
        ...(input.hangPrompt === undefined ? {} : { hangPrompt: input.hangPrompt }),
        ...(input.onPrompt === undefined ? {} : { onPrompt: input.onPrompt }),
      });
      const host = createHost({ ledger, connection });
      const turnPromise = host.executeTurn(request(ledger.runDirectory, ledger.home));
      if (input.hangPrompt) await promptStarted;
      const result = await turnPromise;
      assert.equal(result.knownFailure?.cause, "session", JSON.stringify(result));
      assert.equal(result.knownFailure?.identity?.code, "host-session-record-failed");
      assert.ok(
        typeof result.knownFailure?.diagnostic === "string"
          && result.knownFailure.diagnostic.length > 0,
      );
    });
  } finally {
    ledger.dispose();
  }
}

test("ACP _meta.usage write failure surfaces HostSessionRecordFailure", async () => {
  await assertHostSessionRecordFailure({
    prefix: "ak-971-acp-usage-fail-",
    promptResults: [PROMPT_WITH_USAGE_1],
  });
});

test("ACP auto_compact_completed write failure surfaces HostSessionRecordFailure", async () => {
  await assertHostSessionRecordFailure({
    prefix: "ak-971-acp-compact-fail-",
    hangPrompt: true,
    onPrompt(handlers) {
      setTimeout(() => {
        for (const handler of handlers) {
          handler("_x.ai/session_notification", COMPACT_PARAMS);
        }
      }, 0);
    },
  });
});
