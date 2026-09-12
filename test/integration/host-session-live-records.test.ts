/**
 * #811 medium: headless cross-process live host-session records.
 * Child process + books mid-flight read; not unit.
 */
import assert from "node:assert/strict";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { HOST_SESSION_RECORD_KIND } from "../../src/host-session-record.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

const description: HeadlessHostDescription = Object.freeze({
  protocol: "claude-print",
  binaryFromHome: Object.freeze(["bin", "fake-claude"]),
  sessionBindingFile: "claude-headless-session.json",
  fixedArgs: Object.freeze(["--output-format", "stream-json", "--verbose"]),
  promptFlag: "-p",
  modelFlag: "--model",
  effortFlag: "--effort",
  systemPromptFlag: "--system-prompt-file",
  jsonSchemaFlag: "--json-schema",
  mcpConfigFlag: "--mcp-config",
  sessionIdFlag: "--session-id",
  resumeFlag: "--resume",
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

async function waitFor(path: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

test("headless host-session event is readable in books before the child exits", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-811-live-",
    runName: "run@judge",
  });
  try {
    await mkdir(join(ledger.home, "bin"), { recursive: true });
    const gate = join(ledger.runDirectory, "release-gate");
    const marker = join(ledger.runDirectory, "emitted-marker");
    const fakeBin = join(ledger.home, "bin", "fake-claude");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
import { writeFileSync, existsSync } from "node:fs";
const gate = process.env.AK_811_GATE;
const marker = process.env.AK_811_MARKER;
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", uuid: "live-1" }) + "\\n");
writeFileSync(marker, "1");
const start = Date.now();
while (!existsSync(gate)) {
  if (Date.now() - start > 8000) process.exit(2);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", uuid: "live-result",
  session_id: "sid", is_error: false,
  structured_output: { status: "completed", report: "ok" },
}) + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const sessionFile = join(ledger.runDirectory, "session", "session.jsonl");
    await mkdir(join(ledger.runDirectory, "session"), { recursive: true });
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "run@judge" })}\n`, "utf8");

    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "claude",
      binary: fakeBin,
      env: { AK_811_GATE: gate, AK_811_MARKER: marker },
      sessionIdentity: {
        async load() { return undefined; },
        async bind() {},
        resolveSessionFile: () => sessionFile,
      },
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", command: process.execPath, args: ["-e", ""] }],
        systemPrompt: { body: "p", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_judge_output",
        async ingestStructuredOutput() {},
        async closeRound() { return { accepted: true as const }; },
      }),
    });

    const turn = host.executeTurn(request(ledger.runDirectory, ledger.home));
    await waitFor(marker);
    const recordFile = join(ledger.runDirectory, "session", HOST_SESSION_RECORD_KIND, "records.jsonl");
    await waitFor(recordFile);
    const midFlight = await readSitianRecords(recordFile);
    assert.ok(
      midFlight.records.some((r) => r.identity === "live-1" && r.host === "claude"),
      `mid-flight records missing live-1: ${JSON.stringify(midFlight.records)}`,
    );

    await writeFile(gate, "go", "utf8");
    const result = await turn;
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);
  } finally {
    ledger.dispose();
  }
});

test("headless sitian write failure ends the turn as session infrastructure failure", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-811-fail-",
    runName: "run@judge",
  });
  try {
    await mkdir(join(ledger.home, "bin"), { recursive: true });
    const fakeBin = join(ledger.home, "bin", "fake-claude");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", uuid: "fail-1" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", uuid: "fail-result",
  session_id: "sid", is_error: false,
  structured_output: { status: "completed", report: "ok" },
}) + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const sessionDir = join(ledger.runDirectory, "session");
    const sessionFile = join(sessionDir, "session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "{}\n", "utf8");
    await chmod(sessionDir, 0o555);

    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "claude",
      binary: fakeBin,
      sessionIdentity: {
        async load() { return undefined; },
        async bind() {},
        resolveSessionFile: () => sessionFile,
      },
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", command: process.execPath, args: ["-e", ""] }],
        systemPrompt: { body: "p", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: "ak_judge_output",
        async ingestStructuredOutput() {},
        async closeRound() { return { accepted: true as const }; },
      }),
    });

    const result = await host.executeTurn(request(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure?.cause, "session", JSON.stringify(result));
    assert.equal(result.knownFailure?.identity?.code, "host-session-record-failed");
    assert.ok(
      typeof result.knownFailure?.diagnostic === "string"
        && result.knownFailure.diagnostic.length > 0,
      "diagnostic must carry the real write failure",
    );
  } finally {
    try { await chmod(join(ledger.runDirectory, "session"), 0o755); } catch { /* dispose */ }
    ledger.dispose();
  }
});
