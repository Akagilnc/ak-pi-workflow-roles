/**
 * ADR 0086: ACP host-session write failure writes to stderr without aborting the turn.
 * A blocked log proves pointer, copy, and warning write failures are declared
 * independently without altering the turn outcome.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/environment-fixtures.ts";
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

    await mkdir(logPath);
    let declared = false;
    let pointerDeclared = false;
    const origStderrWrite = process.stderr.write;
    process.stderr.write = (() => {
      declared = true;
      return true;
    }) as typeof process.stderr.write;

    try {
      const connection: AcpConnection = {
        async request(method) {
          if (method === "initialize") return { protocolVersion: 1 };
          if (method === "session/new") return { sessionId: "acp-sess" };
          if (method === "session/prompt") {
            // The pointer is written before prompting; the dossier is recorded after exit.
            pointerDeclared = declared;
            declared = false;
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
      assert.equal(result.knownFailure, undefined, JSON.stringify(result));
      assert.equal(result.code, 0);
      assert.equal(pointerDeclared, true, "pointer");
      assert.equal(declared, true, "warning");

      const native = join(ledger.home, ".grok", "sessions", encodeURIComponent(ledger.home), "acp-sess");
      await mkdir(native, { recursive: true });
      await writeFile(join(native, "chat_history.jsonl"), "native chat\n");
      await writeFile(join(native, "usage.json"), "{}\n");
      declared = false;
      pointerDeclared = false;
      const copied = await host.executeTurn(request(ledger.runDirectory, ledger.home));
      assert.equal(copied.knownFailure, undefined, JSON.stringify(copied));
      assert.equal(copied.code, 0);
      assert.equal(pointerDeclared, true, "pointer");
      assert.equal(declared, true, "copy");
      const landing = join(sessionDir, "grok-build");
      assert.equal(await readFile(join(landing, "chat_history.jsonl"), "utf8"), "native chat\n");
      assert.equal(await readFile(join(landing, "usage.json"), "utf8"), "{}\n");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  } finally {
    ledger.dispose();
  }
});
