/** Submission ledger failure remains durable under ADR 0086. */
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { appendSitianRecord } from "../../src/sitian-appender.ts";
import {
  SitianInfrastructureError,
} from "../../src/sitian-contracts.ts";
import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";


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
          assert.ok(error.cause instanceof Error);
          return true;
        },
        "Submission ledger failures must throw SitianInfrastructureError",
      );
    } finally {
      await chmod(sessionDir, 0o755);
    }
  });
});
