/**
 * #1035 ledger and path seams: one run-leaf grammar, one ticket parser,
 * one outside-ledger page write. Assertions are structured facts.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { pathContainedIn } from "../../src/activation-ledger-topology.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  findBookRunDirectory,
  runRefFromBoundPath,
} from "../../src/book-topology-migration-placement.ts";
import { writeFactoryBoardPage } from "../../src/factory-board.ts";
import { readLedgerSessionJsonl } from "../../src/ledger-session-read.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { admitPublicRole } from "../../src/public-cli/invocation.ts";
import { findRunDirectoryById } from "../../src/public-cli/run-lifecycle.ts";
import {
  formatRunLeaf,
  parseRunLeaf,
  runsSegmentOf,
} from "../../src/role-run-placement.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";
import {
  parseTicketNumber,
  readRunTicketNumber,
  ticketNumberFromSitianSubject,
} from "../../src/run-ticket-number.ts";
import { appendSitianRecord } from "../../src/sitian-appender.ts";
import type { SitianSubject } from "../../src/sitian-contracts.ts";
import { readSitianRecords } from "../../src/sitian-reader.ts";
import { writeTicketTrajectoryPage } from "../../src/ticket-trajectory.ts";
import { seedGitProject, withTempHome } from "../helpers/failure-settlement-kit.ts";

test("run leaf grammar keeps the last @ and rejects an empty side", () => {
  assert.deepEqual(parseRunLeaf("a@b@c"), { runId: "a@b", role: "c" });
  assert.equal(formatRunLeaf("a@b", "c"), "a@b@c");
  assert.equal(parseRunLeaf("a@"), undefined);
  assert.equal(parseRunLeaf("@role"), undefined);
  assert.equal(parseRunLeaf("norole"), undefined);
  assert.equal(runIdFromRunDirectory("/books/unbound/runs/a@b@c"), "a@b");
  assert.deepEqual(runsSegmentOf("123/runs/id@role/session/runs/notes"), {
    index: 1,
    leaf: "id@role",
    sourceRelative: "123/runs/id@role",
  });
  assert.deepEqual(
    runRefFromBoundPath(
      "/tmp/book/123/runs/id@role/session/runs/notes",
      ["/tmp/book"],
    ),
    { leaf: "id@role", sourceRelative: "123/runs/id@role" },
  );
});

test("ticket parser accepts only a safe positive integer spelling", () => {
  assert.equal(parseTicketNumber(1035), 1035);
  assert.equal(parseTicketNumber("1035"), 1035);
  for (const value of [0, -1, 1.5, "", "01", "#1035", "9007199254740993", "1035 ", "x"]) {
    assert.equal(parseTicketNumber(value), undefined);
  }
  assert.equal(ticketNumberFromSitianSubject(1035), "1035");
  assert.equal(ticketNumberFromSitianSubject({ ticketNumber: "1035" }), "1035");
  assert.equal(ticketNumberFromSitianSubject({ ticketNumber: 0 }), undefined);
  assert.equal(ticketNumberFromSitianSubject("9007199254740993"), undefined);
});

test("admitted run, sitian record, and both page writers share the path seams", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);

    await assert.rejects(
      () => admitPublicRole("judge", {
        instruction: "review",
        attachmentPaths: [],
      }, {
        principalAuthority: piDurablePrincipalAuthority,
        home,
        cwd: project,
        createRunId: () => "id@extra",
      }, { assertedTicketNumber: 0 }),
      Error,
    );

    const admitted = await admitPublicRole("judge", {
      instruction: "review",
      attachmentPaths: [],
    }, {
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      createRunId: () => "id@extra",
    }, { assertedTicketNumber: 1035 });

    const leaf = "id@extra@judge";
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "1035", "runs", leaf),
    );
    assert.equal(await readRunTicketNumber(admitted.runDirectory), 1035);
    assert.equal(
      await findRunDirectoryById(home, "id@extra", bookKey, "judge"),
      admitted.runDirectory,
    );
    assert.equal(await findRunDirectoryById(home, "id", bookKey), undefined);

    const decoy = join(home, ".ak-roles", "books", bookKey, "unbound", "runs", "leaf@extra@judge");
    await mkdir(decoy, { recursive: true });
    assert.equal(await findRunDirectoryById(home, "leaf", bookKey), undefined);
    assert.equal(await findRunDirectoryById(home, "leaf@extra", bookKey, "judge"), decoy);

    const bookDir = join(home, ".ak-roles", "books", bookKey);
    assert.deepEqual(await findBookRunDirectory(bookDir, "id@extra", "judge"), {
      runDirectory: admitted.runDirectory,
      role: "judge",
    });

    const placed = piDurablePrincipalAuthority.decode(admitted.principal);
    assert.equal(placed.sessionFile, join(admitted.runDirectory, "session", "session.jsonl"));
    await writeFile(placed.sessionFile, `${JSON.stringify({ type: "session", id: "row-1" })}\n`, "utf8");
    const sessionRows = await readLedgerSessionJsonl(placed.sessionFile);
    assert.equal(sessionRows.length, 1);
    assert.equal(sessionRows[0]?.id, "row-1");

    const pointer = appendSitianRecord({
      level: "event",
      kind: "attempt-history",
      subject: { runId: "id@extra" },
      sessionParent: placed.sessionFile,
      home,
      cwd: project,
      identity: "rec-1",
    });
    assert.equal(
      pointer.recordFile,
      join(admitted.runDirectory, "session", "attempt-history", "records.jsonl"),
    );
    const sitian = await readSitianRecords(pointer.recordFile);
    assert.equal(sitian.records.length, 1);
    assert.equal(sitian.records[0]?.identity, "rec-1");

    const ticketPointer = appendSitianRecord({
      level: "event",
      kind: "ticket-provenance",
      subject: { runId: "id@extra", ticketNumber: "1035" } as SitianSubject,
      cwd: project,
      home,
      identity: "prov-1",
    });
    assert.equal(
      ticketPointer.recordFile,
      join(home, ".ak-roles", "books", bookKey, "1035", "records.jsonl"),
    );

    const numericSubject = appendSitianRecord({
      level: "event",
      kind: "ticket-provenance",
      subject: 1035 as unknown as SitianSubject,
      cwd: project,
      home,
      identity: "prov-2",
    });
    assert.equal(numericSubject.recordFile, ticketPointer.recordFile);

    const unsafeTicketDir = join(home, ".ak-roles", "books", bookKey, "9007199254740993");
    assert.throws(
      () => appendSitianRecord({
        level: "event",
        kind: "ticket-provenance",
        subject: "9007199254740993",
        cwd: project,
        home,
      }),
      Error,
    );
    await assert.rejects(() => lstat(unsafeTicketDir), { code: "ENOENT" });

    const ledgerDir = join(home, ".ak-roles");
    const outside = join(home, "out", "page.html");
    const trajectory = await writeTicketTrajectoryPage({
      ledgerDir,
      ticketSnapshot: { issueNumber: 1035 },
      now: new Date("2026-10-01T00:00:00.000Z"),
      outputPath: outside,
    });
    const outsideStat = await lstat(trajectory.outputPath);
    assert.equal(outsideStat.isFile(), true);
    assert.equal(pathContainedIn(ledgerDir, trajectory.outputPath), false);

    const board = await writeFactoryBoardPage({
      books: [{ bookKey, ledgerDir }],
      view: { ok: false, error: { kind: "binding", message: "unavailable" } },
      now: new Date("2026-10-01T00:00:00.000Z"),
      outputPath: join(home, "out", "board.html"),
    });
    assert.equal((await lstat(board.outputPath)).isFile(), true);
    assert.equal(pathContainedIn(ledgerDir, board.outputPath), false);

    const inside = join(ledgerDir, "inside.html");
    await assert.rejects(
      () => writeTicketTrajectoryPage({
        ledgerDir,
        ticketSnapshot: { issueNumber: 1035 },
        now: new Date("2026-10-01T00:00:00.000Z"),
        outputPath: inside,
      }),
      Error,
    );
    await assert.rejects(
      () => writeFactoryBoardPage({
        books: [{ bookKey, ledgerDir }],
        view: { ok: false, error: { kind: "binding", message: "unavailable" } },
        now: new Date("2026-10-01T00:00:00.000Z"),
        outputPath: inside,
      }),
      Error,
    );

    const injected = join(ledgerDir, "injected.html");
    await writeFile(injected, "BEFORE\n", "utf8");
    const link = join(home, "out", "escape-link.html");
    await symlink(injected, link);
    await assert.rejects(
      () => writeTicketTrajectoryPage({
        ledgerDir,
        ticketSnapshot: { issueNumber: 1035 },
        now: new Date("2026-10-01T00:00:00.000Z"),
        outputPath: link,
      }),
      Error,
    );
    await assert.rejects(
      () => writeFactoryBoardPage({
        books: [{ bookKey, ledgerDir }],
        view: { ok: false, error: { kind: "binding", message: "unavailable" } },
        now: new Date("2026-10-01T00:00:00.000Z"),
        outputPath: link,
      }),
      Error,
    );
    assert.equal(await readFile(injected, "utf8"), "BEFORE\n");

    await assert.rejects(
      () => writeTicketTrajectoryPage({
        ledgerDir,
        ticketSnapshot: { issueNumber: 0 },
        now: new Date("2026-10-01T00:00:00.000Z"),
        outputPath: join(home, "out", "zero.html"),
      }),
      Error,
    );
  });
});
