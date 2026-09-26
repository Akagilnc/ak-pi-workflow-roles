/**
 * ADR 0086: Headless host native session pointer and post-exit dossier copy.
 * Verifies:
 * - Native session pointer recorded on session ID acquisition.
 * - Native CLI session copied to <run>/session/claude-<model>-<n>.jsonl after child exit.
 * - Sitian log line write failure declared to stderr without aborting the turn.
 */
import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

function request(
  runDirectory: string,
  home: string,
  model?: { provider?: string; model: string; thinking?: string },
  cwd?: string,
): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "probe" },
    cwd: cwd ?? home,
    home,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
    ...(model !== undefined
      ? {
          model: {
            provider: model.provider ?? "anthropic",
            model: model.model,
            ...(model.thinking !== undefined ? { thinking: model.thinking } : {}),
          },
        }
      : {}),
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

test("headless host records pointer and copies native dossier post-exit (ADR 0086)", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-0086-headless-copy-",
    runName: "run@judge",
  });
  try {
    const workspaceDir = join(ledger.home, "workspace_with_underscore");
    await mkdir(workspaceDir, { recursive: true });

    await mkdir(join(ledger.home, "bin"), { recursive: true });
    const fakeBin = join(ledger.home, "bin", "fake-claude");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const sidIdx = process.argv.indexOf("--session-id");
const sid = sidIdx !== -1 ? process.argv[sidIdx + 1] : "default-sid";
const home = process.env.HOME;
const cwd = process.cwd();
const sanitizedCwd = cwd.replace(/[^a-zA-Z0-9]/g, "-");
const projectsDir = join(home, ".claude", "projects", sanitizedCwd);
mkdirSync(projectsDir, { recursive: true });
writeFileSync(join(projectsDir, \`\${sid}.jsonl\`), JSON.stringify({ native: "claude-session-data" }) + "\\n");

process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", uuid: "live-result",
  session_id: sid, is_error: false,
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
      env: { HOME: ledger.home },
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

    const result = await host.executeTurn(
      request(ledger.runDirectory, ledger.home, { model: "anthropic/claude-3-opus" }, workspaceDir),
    );
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    // 1. Verify copied dossier landing file: model slashes replaced with '-', ordinal 1
    const landingFile = join(ledger.runDirectory, "session", "claude-anthropic-claude-3-opus-1.jsonl");
    await access(landingFile);
    const content = await readFile(landingFile, "utf8");
    assert.equal(content, JSON.stringify({ native: "claude-session-data" }) + "\n");

    // 2. Verify Sitian records
    const recordFile = join(ledger.runDirectory, "session", HOST_SESSION_RECORD_KIND, "records.jsonl");
    const read = await readSitianRecords(recordFile);
    assert.equal(read.records.length, 2);

    const pointerRec = read.records[0]!;
    assert.equal(pointerRec.level, "event");
    assert.equal(pointerRec.kind, HOST_SESSION_RECORD_KIND);
    assert.equal((pointerRec.payload as { type: string }).type, "native-session-pointer");
    const pointerNativePath = (pointerRec.payload as { nativePath: string }).nativePath;
    assert.ok(typeof pointerNativePath === "string");
    assert.ok(
      pointerNativePath.includes("-workspace-with-underscore"),
      `nativePath should sanitize underscore cwd to hyphens, got: ${pointerNativePath}`,
    );

    const copyRec = read.records[1]!;
    assert.equal(copyRec.level, "event");
    assert.equal(copyRec.kind, HOST_SESSION_RECORD_KIND);
    assert.equal((copyRec.payload as { type: string }).type, "native-session-copy");
    assert.equal((copyRec.payload as { landingPath: string }).landingPath, landingFile);
    assert.equal((copyRec.payload as { ordinal: number }).ordinal, 1);
  } finally {
    ledger.dispose();
  }
});

test("headless sitian write failure writes to stderr without aborting the turn (ADR 0086)", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-0086-sitian-write-fail-",
    runName: "run@judge",
  });
  try {
    await mkdir(join(ledger.home, "bin"), { recursive: true });
    const fakeBin = join(ledger.home, "bin", "fake-claude");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
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
    // Make session directory read-only so sitian cannot create host-session directory
    await chmod(sessionDir, 0o555);

    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
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
      // Under ADR 0086, sitian write failure does NOT abort the turn!
      assert.equal(result.knownFailure, undefined, JSON.stringify(result));
      assert.equal(result.code, 0);

      // The failure is declared without constraining host-facing prose.
      assert.ok(stderrChunks.some((chunk) => chunk.length > 0));
    } finally {
      process.stderr.write = origStderrWrite;
    }
  } finally {
    try { await chmod(join(ledger.runDirectory, "session"), 0o755); } catch { /* dispose */ }
    ledger.dispose();
  }
});
