/**
 * ADR 0086: Headless host native session pointer and post-exit dossier copy.
 * Verifies:
 * - Native session pointer recorded on session ID acquisition.
 * - Native CLI session copied to <run>/session/claude.jsonl after child exit.
 * - Sitian log line write failure declared to stderr without aborting the turn.
 */
import { assertNoRetiredDossierFiles } from "../helpers/run-dossier-fixture.ts";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { HOST_SESSION_RECORD_KIND } from "../../src/host-session-record.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";

const description: HeadlessHostDescription = Object.freeze({
  protocol: "claude-print",
  binaryFromHome: Object.freeze(["bin", "fake-claude"]),
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
        principalAuthority: piDurablePrincipalAuthority,
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

    // 1. Verify copied dossier landing file: one unnumbered file per host
    const landingFile = join(ledger.runDirectory, "session", "claude.jsonl");
    await access(landingFile);
    const content = await readFile(landingFile, "utf8");
    assert.equal(content, JSON.stringify({ native: "claude-session-data" }) + "\n");

    // 2. Verify Sitian records
    const read = {
      records: (await readSitianRecords(join(ledger.runDirectory, "log.jsonl"))).records
        .filter((record) => record.kind === HOST_SESSION_RECORD_KIND),
    };
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
    assert.equal("ordinal" in (copyRec.payload as object), false);
    assertNoRetiredDossierFiles(ledger.runDirectory);
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
    // A directory where the run's log.jsonl belongs makes every Sitian append fail.
    await mkdir(join(ledger.runDirectory, "log.jsonl"));

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
          principalAuthority: piDurablePrincipalAuthority,
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

      // Allocated and host-reported IDs each produce a pointer; warning declares once.
      assert.equal(stderrChunks.length, 3);

      const native = join(ledger.home, ".claude", "projects", ledger.home.replace(/[^a-zA-Z0-9]/g, "-"), "sid.jsonl");
      await mkdir(dirname(native), { recursive: true });
      await writeFile(native, "native session", "utf8");
      const copied = await host.executeTurn(request(ledger.runDirectory, ledger.home));
      assert.equal(copied.knownFailure, undefined, JSON.stringify(copied));
      const dossiers = (await readdir(sessionDir)).filter((entry) => entry.startsWith("claude"));
      // Only the single unnumbered original; no failed-ordinal marker from the earlier failed copy.
      assert.deepEqual(dossiers, ["claude.jsonl"]);
      assert.equal(await readFile(join(sessionDir, dossiers[0]!), "utf8"), "native session");
      // The two pointers and successful-copy record each declare once.
      assert.equal(stderrChunks.length, 6);

      // A later exit overwrites that same single original with the new source bytes.
      await writeFile(native, "native session, second exit", "utf8");
      const again = await host.executeTurn(request(ledger.runDirectory, ledger.home));
      assert.equal(again.knownFailure, undefined, JSON.stringify(again));
      assert.deepEqual((await readdir(sessionDir)).filter((entry) => entry.startsWith("claude")), ["claude.jsonl"]);
      assert.equal(await readFile(join(sessionDir, "claude.jsonl"), "utf8"), "native session, second exit");

      // A failed copy keeps the previous good original.
      await rm(native);
      const failed = await host.executeTurn(request(ledger.runDirectory, ledger.home));
      assert.equal(failed.knownFailure, undefined, JSON.stringify(failed));
      assert.deepEqual((await readdir(sessionDir)).filter((entry) => entry.startsWith("claude")), ["claude.jsonl"]);
      assert.equal(await readFile(join(sessionDir, "claude.jsonl"), "utf8"), "native session, second exit");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  } finally {
    ledger.dispose();
  }
});
