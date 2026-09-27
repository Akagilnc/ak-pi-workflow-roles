/**
 * ADR 0086: grok-build ACP host native dossier copying post-exit.
 * - Grok native session files (chat_history.jsonl, usage.json) are copied into
 *   <run>/session/grok-build-<model>-<n>/ after the ACP session ends.
 * - Hermes host is untouched (no native pointer, no dossier copy).
 * - Copy failure retries once and records native-session-warning without altering turn outcome.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { HOST_SESSION_RECORD_KIND } from "../../src/host-session-record.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

type Ledger = ReturnType<typeof createTempPackageHomeLedger>;

function request(runDirectory: string, home: string, model?: { provider?: string; model: string; thinking?: string }): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "probe" },
    cwd: home,
    home,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
    ...(model !== undefined
      ? {
          model: {
            provider: model.provider ?? "xai",
            model: model.model,
            ...(model.thinking !== undefined ? { thinking: model.thinking } : {}),
          },
        }
      : {}),
  };
}

function hostSessionRecordFile(runDirectory: string): string {
  return join(runDirectory, "session", HOST_SESSION_RECORD_KIND, "records.jsonl");
}

function createHost(input: {
  readonly ledger: Ledger;
  readonly connection: AcpConnection;
  readonly hostName?: string;
}): ReturnType<typeof createAcpRoleTurnHost> {
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
}

function mockConnection(sessionId = "acp-grok-sess"): AcpConnection {
  return {
    async request(method) {
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new") return { sessionId };
      if (method === "session/prompt") return { stopReason: "end_turn" };
      if (method === "session/close") return {};
      return {};
    },
    notify() {},
    onNotification() {},
    async close() {},
  };
}

test("grok-build ACP host copies chat_history.jsonl and usage.json to session directory post-exit (ADR 0086)", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-0086-grok-copy-",
    runName: "run@coder",
  });
  try {
    const sessionId = "acp-grok-sess";
    const grokNativeDir = join(
      ledger.home,
      ".grok",
      "sessions",
      encodeURIComponent(ledger.home),
      sessionId,
    );
    await mkdir(grokNativeDir, { recursive: true });

    const chatContent = '{"role":"assistant","content":"hello from grok"}\n';
    const usageContent = '{"inputTokens":120,"outputTokens":45}\n';
    await writeFile(join(grokNativeDir, "chat_history.jsonl"), chatContent, "utf8");
    await writeFile(join(grokNativeDir, "usage.json"), usageContent, "utf8");

    const host = createHost({ ledger, connection: mockConnection(sessionId) });
    const result = await host.executeTurn(
      request(ledger.runDirectory, ledger.home, { model: "xai/grok-4.7", thinking: "high" }),
    );
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    // 1. Verify copied dossier landing directory: model slashes replaced with '-', ordinal 1
    const landingDir = join(ledger.runDirectory, "session", "grok-build-xai-grok-4.7-1");
    const copiedChat = await readFile(join(landingDir, "chat_history.jsonl"), "utf8");
    assert.equal(copiedChat, chatContent);

    const copiedUsage = await readFile(join(landingDir, "usage.json"), "utf8");
    assert.equal(copiedUsage, usageContent);

    // 2. Verify Sitian records
    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal(records.length, 2);

    const pointerRec = records[0]!;
    assert.equal(pointerRec.level, "event");
    assert.equal(pointerRec.kind, HOST_SESSION_RECORD_KIND);
    assert.equal((pointerRec.payload as { type: string }).type, "native-session-pointer");
    assert.equal((pointerRec.payload as { nativePath: string }).nativePath, grokNativeDir);

    const copyRec = records[1]!;
    assert.equal(copyRec.level, "event");
    assert.equal(copyRec.kind, HOST_SESSION_RECORD_KIND);
    assert.equal((copyRec.payload as { type: string }).type, "native-session-copy");
    assert.equal((copyRec.payload as { landingPath: string }).landingPath, landingDir);
    assert.equal((copyRec.payload as { ordinal: number }).ordinal, 1);
  } finally {
    ledger.dispose();
  }
});

test("hermes ACP host is untouched (no pointer, no copy) (ADR 0086)", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-0086-hermes-untouched-",
    runName: "run@coder",
  });
  try {
    const host = createHost({ ledger, connection: mockConnection("hermes-sess"), hostName: "hermes" });
    const result = await host.executeTurn(request(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal(records.length, 0, "Hermes must not write host-session records");
  } finally {
    ledger.dispose();
  }
});

test("grok-build dossier copy failure retries once and appends native-session-warning without altering turn (ADR 0086)", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-0086-grok-warning-",
    runName: "run@coder",
  });
  try {
    // Native directory not created -> copy will fail and retry once, then append warning
    const host = createHost({ ledger, connection: mockConnection("missing-sess") });
    const result = await host.executeTurn(
      request(ledger.runDirectory, ledger.home, { model: "grok-4.7" }),
    );
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal(records.length, 2);

    const pointerRec = records[0]!;
    assert.equal((pointerRec.payload as { type: string }).type, "native-session-pointer");

    const warningRec = records[1]!;
    assert.equal((warningRec.payload as { type: string }).type, "native-session-warning");
    assert.equal((warningRec.payload as { ordinal: number }).ordinal, 1);
    assert.ok(
      typeof (warningRec.payload as { error: string }).error === "string"
        && (warningRec.payload as { error: string }).error.length > 0,
    );
  } finally {
    ledger.dispose();
  }
});
