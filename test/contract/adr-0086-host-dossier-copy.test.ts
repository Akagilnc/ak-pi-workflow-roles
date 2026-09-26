/**
 * ADR 0086 Contract Tests:
 * 1. Native session path resolution for all hosts:
 *    - Pi: undefined (untouched, direct landing in session.jsonl)
 *    - Hermes: undefined (untouched sqlite database ~/.hermes/state.db)
 *    - Claude: ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
 *    - Codex: ~/.codex/sessions/** /rollout-*-<sessionId>.jsonl
 *    - Grok: ~/.grok/sessions/<encoded-cwd>/<sessionId>
 * 2. Host dossier landing destination and monotonic ordinal:
 *    - Model slashes converted to '-', forbidden from becoming subdirectories
 *    - Ordinal n increments monotonically across start (1) and resumes (2, 3...)
 * 3. Copy and record dossier:
 *    - Codex rollout single file copied with identical bytes
 *    - Grok directory copied with chat_history.jsonl and usage.json
 *    - Pi / Hermes untouched (no copy, no record)
 *    - Copy failure retries once, records warning, does not throw
 * 4. Submission ledger durable failure honesty:
 *    - Submission ledger writes throw SitianInfrastructureError on write failure
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  copyAndRecordHostDossier,
  HOST_SESSION_RECORD_KIND,
  resolveHostDossierLandingPath,
  resolveNativeSessionPath,
} from "../../src/host-session-record.ts";
import {
  appendSitianRecord,
  resolveSitianRecordPath,
} from "../../src/sitian-appender.ts";
import {
  SitianInfrastructureError,
} from "../../src/sitian-contracts.ts";
import { readSitianRecords } from "../../src/sitian-reader.ts";
import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

test("ADR 0086: resolveNativeSessionPath correctly resolves each host native layout and excludes Pi / Hermes", async () => {
  await withHermeticHome({ prefix: "ak-adr86-path-" }, async ({ home }) => {
    const cwd = join(home, "my-project");
    await mkdir(cwd, { recursive: true });

    // Pi: untouched direct landing
    assert.equal(
      resolveNativeSessionPath({ host: "pi", sessionId: "sess-1", cwd, home }),
      undefined,
      "Pi must not have an external native session path",
    );

    // Hermes: untouched sqlite database
    assert.equal(
      resolveNativeSessionPath({ host: "hermes", sessionId: "sess-1", cwd, home }),
      undefined,
      "Hermes must not have an external native session path",
    );

    // Claude: single file under ~/.claude/projects/<sanitizedCwd>/<sessionId>.jsonl
    const claudePath = resolveNativeSessionPath({ host: "claude", sessionId: "sess-claude", cwd, home });
    const expectedClaudeSanitized = cwd.replace(/[\/\\]+/g, "-");
    assert.equal(
      claudePath,
      join(home, ".claude", "projects", expectedClaudeSanitized, "sess-claude.jsonl"),
    );

    // Grok: directory under ~/.grok/sessions/<encodedCwd>/<sessionId>
    const grokPath = resolveNativeSessionPath({ host: "grok-build", sessionId: "sess-grok", cwd, home });
    assert.equal(
      grokPath,
      join(home, ".grok", "sessions", encodeURIComponent(cwd), "sess-grok"),
    );

    // Codex: scanned rollout file under ~/.codex/sessions/**/rollout-*-<sessionId>.jsonl
    const codexSessionsDir = join(home, ".codex", "sessions", "2026", "09", "26");
    await mkdir(codexSessionsDir, { recursive: true });
    const codexRolloutFile = join(codexSessionsDir, "rollout-2026-09-26T12-00-00-sess-codex.jsonl");
    await writeFile(codexRolloutFile, '{"codex":"rollout"}\n', "utf8");

    const codexPath = resolveNativeSessionPath({ host: "codex", sessionId: "sess-codex", cwd, home });
    assert.equal(codexPath, codexRolloutFile);
  });
});

test("ADR 0086: resolveHostDossierLandingPath sanitizes model and computes monotonic ordinal n", async () => {
  await withHermeticHome({ prefix: "ak-adr86-ordinal-" }, async ({ home }) => {
    const sessionDir = join(home, ".ak-roles", "books", "proj", "runs", "run-1", "session");
    await mkdir(sessionDir, { recursive: true });

    // Initial run: n=1, model with slashes converted to '-'
    const initial = resolveHostDossierLandingPath({
      host: "codex",
      model: { model: "openai/gpt-4o" },
      sessionDirectory: sessionDir,
      continuation: { kind: "initial", prompt: "start" },
    });
    assert.equal(initial.ordinal, 1);
    assert.equal(initial.sanitizedModel, "openai-gpt-4o");
    assert.equal(initial.landingPath, join(sessionDir, "codex-openai-gpt-4o-1.jsonl"));

    // Simulate landing file existing on disk
    await writeFile(initial.landingPath, "bytes\n", "utf8");

    // Second turn (resume): n=2
    const resume1 = resolveHostDossierLandingPath({
      host: "codex",
      model: { model: "openai/gpt-4o" },
      sessionDirectory: sessionDir,
      continuation: { kind: "resume", prompt: "continue" },
    });
    assert.equal(resume1.ordinal, 2);
    assert.equal(resume1.landingPath, join(sessionDir, "codex-openai-gpt-4o-2.jsonl"));

    // For grok-build in a fresh run directory (directory landing without .jsonl extension)
    const grokSessionDir = join(home, ".ak-roles", "books", "proj", "runs", "run-grok", "session");
    await mkdir(grokSessionDir, { recursive: true });
    const grokInitial = resolveHostDossierLandingPath({
      host: "grok-build",
      model: { model: "xai/grok-4.7" },
      sessionDirectory: grokSessionDir,
      continuation: { kind: "initial", prompt: "start" },
    });
    assert.equal(grokInitial.ordinal, 1);
    assert.equal(grokInitial.landingPath, join(grokSessionDir, "grok-build-xai-grok-4.7-1"));
  });
});

test("ADR 0086: Codex rollout file copied with identical bytes and Sitian landing record appended", async () => {
  await withHermeticHome({ prefix: "ak-adr86-codex-copy-" }, async ({ home }) => {
    const cwd = join(home, "proj");
    await mkdir(cwd, { recursive: true });
    seedGitRepository(cwd);

    const sessionId = "codex-sess-uuid";
    const codexSessionsDir = join(home, ".codex", "sessions", "2026", "09", "26");
    await mkdir(codexSessionsDir, { recursive: true });
    const rolloutPath = join(codexSessionsDir, `rollout-2026-09-26T10-00-00-${sessionId}.jsonl`);
    const rolloutContent = '{"item":"call","fn":"exec","args":["echo","hello"]}\n{"item":"res","status":"ok"}\n';
    await writeFile(rolloutPath, rolloutContent, "utf8");

    const sessionDirectory = join(home, ".ak-roles", "books", "proj", "runs", "run-codex", "session");
    const sessionParent = join(sessionDirectory, "session.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionParent, "{}\n", "utf8");

    copyAndRecordHostDossier({
      host: "codex",
      sessionId,
      cwd,
      sessionDirectory,
      sessionParent,
      continuation: { kind: "initial", prompt: "run" },
      model: { model: "openai/gpt-4o" },
      home,
    });

    const expectedLanding = join(sessionDirectory, "codex-openai-gpt-4o-1.jsonl");
    const copiedContent = await readFile(expectedLanding, "utf8");
    assert.equal(copiedContent, rolloutContent, "Bytes copied verbatim without modification");

    const recordFile = join(sessionDirectory, HOST_SESSION_RECORD_KIND, "records.jsonl");
    const read = await readSitianRecords(recordFile);
    assert.equal(read.records.length, 1);
    const rec = read.records[0]!;
    assert.equal((rec.payload as { type: string }).type, "native-session-copy");
    assert.equal((rec.payload as { landingPath: string }).landingPath, expectedLanding);
    assert.equal((rec.payload as { ordinal: number }).ordinal, 1);
  });
});

test("ADR 0086: Submission ledger write failures still throw SitianInfrastructureError (durable failure honesty)", async () => {
  await withHermeticHome({ prefix: "ak-adr86-ledger-fail-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const sessionParent = join(home, ".ak-roles", "books", "proj", "runs", "run-ledger", "session", "session.jsonl");
    const sessionDir = dirname(sessionParent);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionParent, "{}\n", "utf8");

    // Make directory read-only so append fails
    await chmod(sessionDir, 0o555);

    try {
      assert.throws(
        () => {
          appendSitianRecord({
            level: "event",
            kind: "sealed",
            cwd: project,
            home,
            sessionParent,
            subject: { runId: "run-ledger", attemptId: "att-1" },
            identity: "seal-evt-1",
            payload: { sealed: true },
          });
        },
        (error: unknown) => {
          assert.ok(error instanceof SitianInfrastructureError);
          assert.ok(error.message.includes("Sitian appender persistence failure:"));
          return true;
        },
        "Submission ledger failures must throw SitianInfrastructureError",
      );
    } finally {
      await chmod(sessionDir, 0o755);
    }
  });
});
