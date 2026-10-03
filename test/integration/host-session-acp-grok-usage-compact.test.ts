/**
 * ADR 0086: grok-build ACP host native dossier copying post-exit.
 * - Grok native session files (chat_history.jsonl, usage.json) are copied into
 *   <run>/session/grok-build/ after the ACP session ends; every exit overwrites
 *   that one directory, and a failed copy keeps the previous good original.
 * - Hermes host is untouched (no native pointer, no dossier copy).
 * - Copy failure retries once and records native-session-warning without altering turn outcome.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

    // 1. Verify copied dossier landing directory: one unnumbered directory per host
    const landingDir = join(ledger.runDirectory, "session", "grok-build");
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
    assert.equal("ordinal" in (copyRec.payload as object), false);

    // 3. A second exit overwrites the same single original with the new source bytes.
    const chatContent2 = '{"role":"assistant","content":"second exit"}\n';
    await writeFile(join(grokNativeDir, "chat_history.jsonl"), chatContent2, "utf8");
    const second = await host.executeTurn(
      request(ledger.runDirectory, ledger.home, { model: "xai/grok-4.7", thinking: "high" }),
    );
    assert.equal(second.code, 0);
    assert.equal(await readFile(join(landingDir, "chat_history.jsonl"), "utf8"), chatContent2);
    assert.equal(await readFile(join(landingDir, "usage.json"), "utf8"), usageContent);
    const originals = (await readdir(join(ledger.runDirectory, "session"))).filter((name) => name.startsWith("grok-build"));
    assert.deepEqual(originals, ["grok-build"]);

    // 4. A failed third copy leaves the previous good original intact.
    await rm(join(grokNativeDir, "usage.json"));
    await writeFile(join(grokNativeDir, "chat_history.jsonl"), "third exit, copy will fail\n", "utf8");
    const third = await host.executeTurn(
      request(ledger.runDirectory, ledger.home, { model: "xai/grok-4.7", thinking: "high" }),
    );
    assert.equal(third.code, 0);
    assert.equal(await readFile(join(landingDir, "chat_history.jsonl"), "utf8"), chatContent2);
    assert.equal(await readFile(join(landingDir, "usage.json"), "utf8"), usageContent);
    assert.deepEqual(
      (await readdir(join(ledger.runDirectory, "session"))).filter((name) => name.startsWith("grok-build")),
      ["grok-build"],
    );
    const afterThird = (await readSitianRecords(hostSessionRecordFile(ledger.runDirectory))).records;
    assert.equal((afterThird.at(-1)?.payload as { type?: string })?.type, "native-session-warning");
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

test("grok-build dossier copy failure appends warning without altering turn (ADR 0086)", async () => {
  const ledger = createTempPackageHomeLedger({ prefix: "ak-0086-grok-warning-", runName: "run@coder" });
  try {
    const result = await createHost({ ledger, connection: mockConnection("missing-sess") }).executeTurn(
      request(ledger.runDirectory, ledger.home, { model: "grok-4.7" }),
    );
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);
    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal((records[0]?.payload as { type?: string })?.type, "native-session-pointer");
    assert.equal((records[1]?.payload as { type?: string })?.type, "native-session-warning");
    assert.ok((records[1]?.payload as { error?: string })?.error);
  } finally {
    ledger.dispose();
  }
});

test("grok-build dossier copy retries once after missing usage and completes before turn returns (ADR 0086)", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-0086-grok-warning-",
    runName: "run@coder",
  });
  try {
    const sessionId = "retry-sess";
    const nativeDir = join(ledger.home, ".grok", "sessions", encodeURIComponent(ledger.home), sessionId);
    await mkdir(nativeDir, { recursive: true });
    await writeFile(join(nativeDir, "chat_history.jsonl"), "native chat\n");
    // The host's cp command makes usage available only on its second chat copy.
    // First pass fails after chat; the second must actually reach usage.
    const bin = join(ledger.home, "bin");
    await mkdir(bin);
    const attempts = join(ledger.home, "copy-attempts");
    const cp = join(bin, "cp");
    await writeFile(cp, `#!/bin/sh
if [ "$2" = "${join(nativeDir, "chat_history.jsonl")}" ]; then
  printf 'attempt\\n' >> '${attempts}'
  if [ "$(wc -l < '${attempts}')" -eq 2 ]; then
    printf 'native usage\\n' > '${join(nativeDir, "usage.json")}'
  fi
fi
/bin/cp "$2" "$3"
`);
    await chmod(cp, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
    const host = createHost({ ledger, connection: mockConnection(sessionId) });
    const result = await host.executeTurn(
      request(ledger.runDirectory, ledger.home, { model: "grok-4.7" }),
    );
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    const { records } = await readSitianRecords(hostSessionRecordFile(ledger.runDirectory));
    assert.equal(records.length, 2);

    const pointerRec = records[0]!;
    assert.equal((pointerRec.payload as { type: string }).type, "native-session-pointer");

    const copyRec = records[1]!;
    assert.equal((copyRec.payload as { type: string }).type, "native-session-copy");
    assert.equal((await readFile(attempts, "utf8")).split("\n").filter(Boolean).length, 2);
    assert.equal(await readFile(join(ledger.runDirectory, "session", "grok-build", "usage.json"), "utf8"), "native usage\n");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  } finally {
    ledger.dispose();
  }
});
