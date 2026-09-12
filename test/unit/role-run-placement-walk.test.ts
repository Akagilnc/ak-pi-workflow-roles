import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { scanAnalystIssueRuns } from "../../src/analyst-ledger.ts";
import { listBookRunDirectories } from "../../src/role-run-placement.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const SESSION_JSONL = [
  JSON.stringify({
    type: "session",
    version: 3,
    id: "s-walk",
    timestamp: "2026-08-21T00:00:00.000Z",
    cwd: "/analyst-fixture/walk",
  }),
  JSON.stringify({
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-08-21T00:00:00.000Z",
    message: { role: "assistant", timestamp: "2026-08-21T00:00:00.000Z", content: [] },
  }),
  JSON.stringify({
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: "2026-08-21T00:00:10.000Z",
    message: { role: "assistant", timestamp: "2026-08-21T00:00:10.000Z", content: [] },
  }),
].join("\n") + "\n";

test("listBookRunDirectories skips ENOTDIR flat runs slot and still walks subject-tree", async () => {
  await withTempRoot("ak-rrp-walk-", async (root) => {
    const bookDir = join(root, "book");
    await mkdir(bookDir, { recursive: true });
    // Flat legacy `runs` is a plain file → readdir yields ENOTDIR, not absence.
    await writeFile(join(bookDir, "runs"), "not-a-directory\n", "utf8");
    const subjectRun = join(bookDir, "582", "runs", "01jsub@judge");
    await mkdir(subjectRun, { recursive: true });
    const dirs = await listBookRunDirectories(bookDir);
    assert.deepEqual(dirs, [subjectRun]);
  });
});

test("scanAnalystIssueRuns admits subject-tree ticket runs (not only flat legacy)", async () => {
  await withTempRoot("ak-rrp-analyst-", async (root) => {
    const home = root;
    const bookKey = "walk-book";
    const bookDir = join(home, ".ak-roles", "books", bookKey);
    const ticket = 582;
    const runId = "019ff000-8591-7000-8000-000000008591";
    const role = "judge";
    const projectRoot = join(root, "proj");
    await mkdir(projectRoot, { recursive: true });

    const subjectRunDir = join(bookDir, String(ticket), "runs", `${runId}@${role}`);
    await mkdir(join(subjectRunDir, "session"), { recursive: true });
    await mkdir(join(subjectRunDir, "artifacts"), { recursive: true });
    await writeFile(
      join(subjectRunDir, "invocation.json"),
      `${JSON.stringify({
        role,
        runId,
        bookKey,
        projectRoot,
        ticketNumber: ticket,
      }, null, 2)}\n`,
    );
    await writeFile(join(subjectRunDir, "session", "session.jsonl"), SESSION_JSONL);
    await writeFile(
      join(subjectRunDir, "artifacts", "report.json"),
      `${JSON.stringify({
        role,
        runId,
        phase: "apply",
        outcome: {
          kind: "accepted",
          role,
          status: "completed",
          decisiveFacts: {},
        },
      }, null, 2)}\n`,
    );

    // Sibling book with only flat runs for a different ticket must not leak in.
    const otherBook = join(home, ".ak-roles", "books", "other-book");
    const otherRun = join(otherBook, "runs", `019ff000-8592-7000-8000-000000008592@fixer`);
    await mkdir(join(otherRun, "session"), { recursive: true });
    await mkdir(join(otherRun, "artifacts"), { recursive: true });
    await writeFile(
      join(otherRun, "invocation.json"),
      `${JSON.stringify({
        role: "fixer",
        runId: "019ff000-8592-7000-8000-000000008592",
        bookKey: "other-book",
        projectRoot,
        ticketNumber: 999,
      }, null, 2)}\n`,
    );
    await writeFile(join(otherRun, "session", "session.jsonl"), SESSION_JSONL);
    await writeFile(
      join(otherRun, "artifacts", "report.json"),
      `${JSON.stringify({
        role: "fixer",
        runId: "019ff000-8592-7000-8000-000000008592",
        phase: "apply",
        outcome: {
          kind: "accepted",
          role: "fixer",
          status: "completed",
          decisiveFacts: {},
        },
      }, null, 2)}\n`,
    );

    const scan = await scanAnalystIssueRuns({
      bookKey,
      ticketNumber: ticket,
      home,
    });
    assert.equal(scan.runs.length, 1);
    assert.equal(scan.runs[0]?.runId, runId);
    assert.equal(scan.runs[0]?.role, role);
    assert.equal(scan.runs[0]?.book, bookKey);
    assert.equal(
      scan.runs.some((run) => run.runId.includes("8592")),
      false,
    );
  });
});
