/**
 * #811 unit: ACP host-session write failure aborts pending prompt (deterministic race).
 * Cross-process headless live/failure cases live under test/integration/.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

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

test("ACP host-session write failure aborts pending prompt without waiting for it", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-811-acp-fail-",
    runName: "run@judge",
  });
  try {
    const sessionDir = join(ledger.runDirectory, "session");
    const sessionFile = join(sessionDir, "session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "{}\n", "utf8");
    // Freeze session dir so sitian cannot create host-session/ on first update.
    await chmod(sessionDir, 0o555);

    const notificationHandlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
    let resolvePrompt: ((value: Readonly<Record<string, unknown>>) => void) | undefined;
    // Deterministic hang signal: prompt never settles unless close unblocks it.
    const promptNever = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      resolvePrompt = resolve;
    });
    let promptStarted!: () => void;
    const promptStartedGate = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    let turnSettled = false;

    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "acp-sess" };
        if (method === "session/prompt") {
          promptStarted();
          // After executeTurn is blocked on prompt, fire a write-failing update.
          setTimeout(() => {
            for (const handler of notificationHandlers) {
              handler("session/update", {
                sessionId: "acp-sess",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
              });
            }
          }, 0);
          return promptNever;
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      onNotification(handler) {
        notificationHandlers.push(handler);
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
        async load() { return undefined; },
        async bind() {},
        resolveSessionFile: () => sessionFile,
      },
      connect: async () => connection,
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", type: "stdio" }],
        systemPrompt: { body: "p", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_judge_output",
        async ingestStructuredOutput() {},
        async closeRound() { return { accepted: true as const }; },
      }),
    });

    const turnPromise = host.executeTurn(request(ledger.runDirectory, ledger.home)).then((result) => {
      turnSettled = true;
      return result;
    });
    // Prompt is in-flight and must not have settled the turn yet.
    await promptStartedGate;
    assert.equal(turnSettled, false, "turn must still be awaiting prompt when update fires");

    const result = await turnPromise;
    // promptNever never resolved to end_turn — abort race won.
    assert.equal(turnSettled, true);
    assert.equal(result.knownFailure?.cause, "session", JSON.stringify(result));
    assert.equal(result.knownFailure?.identity?.code, "host-session-record-failed");
    assert.ok(
      typeof result.knownFailure?.diagnostic === "string"
        && result.knownFailure.diagnostic.length > 0,
    );
  } finally {
    try { await chmod(join(ledger.runDirectory, "session"), 0o755); } catch { /* dispose */ }
    ledger.dispose();
  }
});
