/**
 * #811: headless stdout stream + ACP session/update → sitian host-session records live.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { HOST_SESSION_RECORD_KIND } from "../../src/host-session-record.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

function baseRequest(runDirectory: string, home: string): RoleTurnRequest {
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

const headlessDescription: HeadlessHostDescription = Object.freeze({
  binaryFromHome: Object.freeze(["bin", "fake-claude"]),
  sessionBindingFile: "claude-headless-session.json",
  fixedArgs: Object.freeze([
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
  ]),
  promptFlag: "-p",
  modelFlag: "--model",
  effortFlag: "--effort",
  systemPromptFlag: "--system-prompt-file",
  jsonSchemaFlag: "--json-schema",
  mcpConfigFlag: "--mcp-config",
  sessionIdFlag: "--session-id",
  resumeFlag: "--resume",
});

test("headless stream-json lines land as host-session records before turn ends", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-811-headless-live-",
    runName: "run@judge",
  });
  try {
    await mkdir(join(ledger.home, "bin"), { recursive: true });
    // Fake CLI: emit two stream events then a result with structured_output.
    const fakeBin = join(ledger.home, "bin", "fake-claude");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
const events = [
  { type: "system", subtype: "init", uuid: "h-init", session_id: "sid-live" },
  { type: "assistant", uuid: "h-asst", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  {
    type: "result",
    subtype: "success",
    uuid: "h-result",
    session_id: "sid-live",
    is_error: false,
    structured_output: { status: "completed", report: "ok" },
  },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const sessionFile = join(ledger.runDirectory, "session", "session.jsonl");
    await mkdir(join(ledger.runDirectory, "session"), { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "run@judge" })}\n`,
      "utf8",
    );

    let ingested: unknown;
    const host = createHeadlessRoleTurnHost({
      description: headlessDescription,
      hostName: "claude",
      binary: fakeBin,
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => sessionFile,
      },
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", command: process.execPath, args: ["-e", ""] }],
        systemPrompt: { body: "probe", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_judge_output",
        async ingestStructuredOutput(params) {
          ingested = params;
        },
        async closeRound() {
          return { accepted: true as const };
        },
      }),
    });

    const result = await host.executeTurn(baseRequest(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);
    assert.deepEqual(ingested, { status: "completed", report: "ok" });

    const recordFile = join(ledger.runDirectory, "session", HOST_SESSION_RECORD_KIND, "records.jsonl");
    const read = await readSitianRecords(recordFile);
    assert.ok(read.records.length >= 3, `expected ≥3 host-session rows, got ${read.records.length}`);
    const uuids = read.records.map((row) => row.identity);
    assert.ok(uuids.includes("h-init"), uuids.join(","));
    assert.ok(uuids.includes("h-asst"), uuids.join(","));
    assert.ok(uuids.includes("h-result"), uuids.join(","));
    assert.ok(read.records.every((row) => row.host === "claude"));
    // header-only session.jsonl
    const sessionBody = await readFile(sessionFile, "utf8");
    assert.equal(sessionBody.trim().split("\n").length, 1);
  } finally {
    ledger.dispose();
  }
});

test("ACP session/update notifications land as host-session records", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-811-acp-live-",
    runName: "run@countersign",
  });
  try {
    const sessionFile = join(ledger.runDirectory, "session", "session.jsonl");
    await mkdir(join(ledger.runDirectory, "session"), { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "run@countersign" })}\n`,
      "utf8",
    );

    const notificationHandlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") {
          return { protocolVersion: 1 };
        }
        if (method === "session/new") return { sessionId: "acp-sess" };
        if (method === "session/prompt") {
          for (const handler of notificationHandlers) {
            handler("session/update", {
              sessionId: "acp-sess",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "progress" },
              },
            });
            handler("session/update", {
              sessionId: "acp-sess",
              update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
            });
          }
          return { stopReason: "end_turn" };
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      onNotification(handler) {
        notificationHandlers.push(handler);
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
        resolveSessionFile: () => sessionFile,
      },
      connect: async () => connection,
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", type: "stdio" }],
        systemPrompt: { body: "probe", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_judge_output",
        async ingestStructuredOutput() {},
        async closeRound() {
          return { accepted: true as const };
        },
      }),
    });

    const result = await host.executeTurn(baseRequest(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    const recordFile = join(ledger.runDirectory, "session", HOST_SESSION_RECORD_KIND, "records.jsonl");
    const read = await readSitianRecords(recordFile);
    assert.ok(read.records.length >= 2, `expected ≥2 host-session rows, got ${read.records.length}`);
    assert.ok(read.records.every((row) => row.host === "grok-build"));
    assert.ok(
      read.records.some((row) => {
        const payload = row.payload as { method?: string; params?: { update?: { sessionUpdate?: string } } };
        return payload?.method === "session/update"
          && payload.params?.update?.sessionUpdate === "agent_message_chunk";
      }),
      JSON.stringify(read.records.map((r) => r.payload)),
    );
    const sessionBody = await readFile(sessionFile, "utf8");
    assert.equal(sessionBody.trim().split("\n").length, 1);
  } finally {
    ledger.dispose();
  }
});
