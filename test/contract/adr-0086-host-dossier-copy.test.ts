/** ADR 0086: native Codex copy and submission ledger failure contract. */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  copyAndRecordHostDossier,
  HOST_SESSION_RECORD_KIND,
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
