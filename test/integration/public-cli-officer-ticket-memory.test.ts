/**
 * #636 — 察院/符宝郎 ticket+seat memory principal via public entry.
 * Same ticket reopens the same nest; different tickets isolate; public CLI
 * second call sends continuation.resume on the sealed principal. Native host
 * reopen + cross-host DK-4 true runs are #638 family evidence — this suite
 * does not treat mock handoff as DK-4 completion.
 *
 * Shares ticket-seat memory CLI fixtures with #637 (tmpdir only; no directory
 * deletion; never write the real home).
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  readTicketSeatMemoryLastHost,
  ticketSeatMemorySessionDirectory,
} from "../../src/ticket-seat-memory.ts";
import { runPublicInspector } from "../../src/public-cli/inspector-run.ts";
import { runPublicNotary, runPublicNotaryResume } from "../../src/public-cli/notary-run.ts";
import { parseInspectorArgv, parseNotaryArgv } from "../../src/public-cli/invocation.ts";
import {
  CANONICAL_SOURCE_ROLE,
  CANONICAL_SOURCE_RUN_ID,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import {
  createNativeHomeTurnRecorder,
  createPrincipalTurnRecorder,
  installSeatTicketFixtures,
  silentCliIo,
  ticketSeatMemoryEnvBase,
  withTicketSeatMemoryHome,
} from "../helpers/ticket-seat-memory-cli-fixture.ts";

test("#636 public notary CLI: same-ticket resume, different-ticket isolation, independent runs", async () => {
  await withTicketSeatMemoryHome("ak-public-notary-mem-", async ({ home, project }) => {
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const admittedPath = join(sourceRunPath, "admitted-request.json");
    const admittedRaw = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      admittedPath,
      `${JSON.stringify({ ...admittedRaw, ticketNumber: 636 }, null, 2)}\n`,
      "utf8",
    );

    const memoryDir636 = ticketSeatMemorySessionDirectory({
      ticketNumber: 636,
      seat: "notary",
      cwd: project,
      home,
    });
    const memoryDir700 = ticketSeatMemorySessionDirectory({
      ticketNumber: 700,
      seat: "notary",
      cwd: project,
      home,
    });

    // Observing typed continuation + principal path only — not a DK-4 mock-handoff proof.
    const { seen, host } = createPrincipalTurnRecorder();
    const io = silentCliIo();
    const envBase = ticketSeatMemoryEnvBase({
      home,
      project,
      host,
      liveHost: "pi",
    });

    await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, createRunId: () => "notary-mem-1" },
      io,
      parseNotaryArgv,
    );
    assert.equal(seen.length, 1, "first public notary must dispatch one turn");
    assert.equal(seen[0]!.kind, "initial", "first nest open is initial");
    assert.ok(
      seen[0]!.sessionFile.startsWith(memoryDir636),
      `first principal must seal ticket-seat nest, got ${seen[0]!.sessionFile}`,
    );

    await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, createRunId: () => "notary-mem-2" },
      io,
      parseNotaryArgv,
    );
    assert.equal(seen.length, 2, "second public notary must dispatch one turn");
    assert.equal(seen[1]!.kind, "resume", "existing nest must send continuation.resume");
    assert.equal(
      seen[1]!.sessionFile,
      seen[0]!.sessionFile,
      "same ticket must reopen the same native session file path",
    );
    assert.notEqual(
      seen[1]!.runDirectory,
      seen[0]!.runDirectory,
      "each call keeps its own run directory",
    );

    // Different ticket → different nest (typed principal isolation).
    await writeFile(
      admittedPath,
      `${JSON.stringify({ ...admittedRaw, ticketNumber: 700 }, null, 2)}\n`,
      "utf8",
    );
    await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, createRunId: () => "notary-mem-700" },
      io,
      parseNotaryArgv,
    );
    assert.equal(seen.length, 3, "different-ticket notary must dispatch one turn");
    assert.equal(seen[2]!.kind, "initial", "new ticket opens a fresh nest");
    assert.ok(
      seen[2]!.sessionFile.startsWith(memoryDir700),
      `ticket 700 must seal its own nest, got ${seen[2]!.sessionFile}`,
    );
    assert.notEqual(
      seen[2]!.sessionFile,
      seen[0]!.sessionFile,
      "distinct tickets must not share the native volume",
    );
  });
});

test("#636 public inspector CLI: ticket+seat nest seals and second call resumes", async () => {
  await withTicketSeatMemoryHome("ak-public-inspector-mem-", async ({ home, project, binDir }) => {
    // #635 seat self-ticket via hermes/gh fixtures — no CLI --ticket.
    await installSeatTicketFixtures(binDir, 636);
    const memoryDir = ticketSeatMemorySessionDirectory({
      ticketNumber: 636,
      seat: "inspector",
      cwd: project,
      home,
    });

    const { seen, host } = createPrincipalTurnRecorder();
    const io = silentCliIo();
    const envBase = ticketSeatMemoryEnvBase({
      home,
      project,
      host,
      liveHost: "pi",
    });

    await runPublicInspector(
      ["inspect once for ticket #636"],
      { ...envBase, createRunId: () => "inspector-mem-1" },
      io,
      parseInspectorArgv,
    );
    assert.equal(seen.length, 1, "first public inspector must dispatch one turn");
    assert.equal(seen[0]!.kind, "initial", "first inspector nest open is initial");
    assert.ok(
      seen[0]!.sessionFile.startsWith(memoryDir),
      `inspector principal must seal ticket-seat nest, got ${seen[0]!.sessionFile}`,
    );

    await runPublicInspector(
      ["inspect again for ticket #636"],
      { ...envBase, createRunId: () => "inspector-mem-2" },
      io,
      parseInspectorArgv,
    );
    assert.equal(seen.length, 2, "second public inspector must dispatch one turn");
    assert.equal(seen[1]!.kind, "resume", "existing inspector nest must send continuation.resume");
    assert.equal(
      seen[1]!.sessionFile,
      seen[0]!.sessionFile,
      "same ticket inspector must reopen the same native session file path",
    );
    assert.notEqual(
      seen[1]!.runDirectory,
      seen[0]!.runDirectory,
      "each inspector call keeps its own run directory",
    );
  });
});

test("#636 public notary: Grok native home spans failure, same-run retry, return-to-Grok", async () => {
  await withTicketSeatMemoryHome("ak-public-notary-native-home-", async ({ home, project }) => {
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const admittedPath = join(sourceRunPath, "admitted-request.json");
    const admittedRaw = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      admittedPath,
      `${JSON.stringify({ ...admittedRaw, ticketNumber: 636 }, null, 2)}\n`,
      "utf8",
    );

    const memoryDir = ticketSeatMemorySessionDirectory({
      ticketNumber: 636,
      seat: "notary",
      cwd: project,
      home,
    });

    // Typed request + last-host ownership only — not a native ACP true-run (#638).
    const { seen, host } = createNativeHomeTurnRecorder();
    const io = silentCliIo();
    const envBase = ticketSeatMemoryEnvBase({ home, project, host });

    // 1) Failure path still records Grok native-home ownership on the nest.
    await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, host: "grok-build", createRunId: () => "notary-nh-1" },
      io,
      parseNotaryArgv,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.kind, "initial");
    assert.equal(seen[0]!.nativeHomeRunDirectory, undefined);
    const afterFailure = await readTicketSeatMemoryLastHost(memoryDir);
    assert.deepEqual(afterFailure, {
      host: "grok-build",
      runDirectory: seen[0]!.runDirectory,
    });

    // 2) New-run resume reopens the established Grok native home.
    await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, host: "grok-build", createRunId: () => "notary-nh-2" },
      io,
      parseNotaryArgv,
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.kind, "resume");
    assert.equal(seen[1]!.nativeHomeRunDirectory, seen[0]!.runDirectory);
    assert.notEqual(seen[1]!.runDirectory, seen[0]!.runDirectory);

    // 3) Same-run retry (invocation already marked grok) still carries native home.
    await runPublicNotaryResume(
      { runId: "notary-nh-2" },
      { ...envBase, host: "grok-build" },
      io,
    );
    assert.equal(seen.length, 3);
    assert.equal(seen[2]!.kind, "resume");
    assert.equal(seen[2]!.nativeHomeRunDirectory, seen[0]!.runDirectory);
    assert.equal(seen[2]!.runDirectory, seen[1]!.runDirectory);

    // 4) Leave Grok for Pi — last-host host flips, Grok native home pointer preserved.
    await runPublicNotary(
      ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      { ...envBase, host: "pi", createRunId: () => "notary-nh-3" },
      io,
      parseNotaryArgv,
    );
    assert.equal(seen.length, 4);
    assert.equal(seen[3]!.kind, "resume");
    assert.equal(seen[3]!.previousHost, "grok-build");
    const afterPi = await readTicketSeatMemoryLastHost(memoryDir);
    assert.deepEqual(afterPi, {
      host: "pi",
      runDirectory: seen[0]!.runDirectory,
    });

    // 5) Old Grok run retry after Pi intermediate — last-host (pi) owns host,
    // not the stale per-run invocation mark still recorded as grok-build.
    // Also the return-to-Grok path: reopen the established native home, not the Pi run.
    await runPublicNotaryResume(
      { runId: "notary-nh-2" },
      { ...envBase, host: "grok-build" },
      io,
    );
    assert.equal(seen.length, 5);
    assert.equal(seen[4]!.kind, "resume");
    assert.equal(seen[4]!.previousHost, "pi");
    assert.equal(seen[4]!.nativeHomeRunDirectory, seen[0]!.runDirectory);
    assert.equal(seen[4]!.runDirectory, seen[1]!.runDirectory);
    const afterReturn = await readTicketSeatMemoryLastHost(memoryDir);
    assert.deepEqual(afterReturn, {
      host: "grok-build",
      runDirectory: seen[0]!.runDirectory,
    });
  });
});
