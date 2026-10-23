/**
 * ADR 0086: ACP host-session write failure writes to stderr without aborting the turn.
 * A file blocking the record directory proves pointer or dossier sitian write failures
 * declare to stderr once and do not alter the turn outcome.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";

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

test("ACP host-session write failure writes to stderr without aborting the turn (ADR 0086)", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-0086-acp-write-fail-",
    runName: "run@judge",
  });
  try {
    const sessionDir = join(ledger.runDirectory, "session");
    const sessionFile = join(sessionDir, "session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "{}\n", "utf8");
    const logPath = join(ledger.runDirectory, "log.jsonl");

    let phase: "pointer" | "warning" = "pointer";
    let warningDeclared = false;
    const origStderrWrite = process.stderr.write;
    process.stderr.write = (() => {
      if (phase === "warning") warningDeclared = true;
      return true;
    }) as typeof process.stderr.write;

    try {
      const connection: AcpConnection = {
        async request(method) {
          if (method === "initialize") return { protocolVersion: 1 };
          if (method === "session/new") return { sessionId: "acp-sess" };
          if (method === "session/prompt") {
            const text = await readFile(logPath, "utf8");
            const sawPointer = text.split("\n").some((line) => {
              if (line.length === 0) return false;
              const row = JSON.parse(line) as { payload?: { type?: unknown } };
              return row.payload?.type === "native-session-pointer";
            });
            assert.equal(sawPointer, true);
            assert.equal(warningDeclared, false);
            phase = "warning";
            await rm(logPath);
            await mkdir(logPath);
            return { stopReason: "end_turn" };
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
        sessionIdentity: {
          async load() { return undefined; },
          async bind() {},
          resolveSessionFile: () => sessionFile,
          principalAuthority: piDurablePrincipalAuthority,
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

      const result = await host.executeTurn(request(ledger.runDirectory, ledger.home));
      // Under ADR 0086, sitian write failure does not abort the turn!
      assert.equal(result.knownFailure, undefined, JSON.stringify(result));
      assert.equal(result.code, 0);
      assert.equal(warningDeclared, true);
    } finally {
      process.stderr.write = origStderrWrite;
    }
  } finally {
    ledger.dispose();
  }
});
