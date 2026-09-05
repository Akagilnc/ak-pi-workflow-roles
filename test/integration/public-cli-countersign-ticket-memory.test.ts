/**
 * #637 — 给事中 ticket+seat memory principal via public entry.
 * Same ticket reopens the same nest; different tickets isolate; each call
 * keeps an independent run. Reuses #636 ticket-seat-memory seam (ADR 0079
 * ticket-seat-memory-countersign-principal). Native host reopen + cross-host
 * DK-4 true runs are #638 family evidence — this suite asserts typed wire only.
 *
 * Imperial #637 law: temp only under os.tmpdir; tests never delete directories;
 * never write the real home.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  readTicketSeatMemoryLastHost,
  ticketSeatMemorySessionDirectory,
} from "../../src/ticket-seat-memory.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  runPublicCountersign,
  runPublicCountersignResume,
} from "../../src/public-cli/countersign-run.ts";
import { parseCountersignArgv } from "../../src/public-cli/invocation.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import {
  assertIndependentTerminal,
  createNativeHomeTurnRecorder,
  createPrincipalTurnRecorder,
  installSeatTicketFixtures,
  silentCliIo,
  ticketSeatMemoryEnvBase,
  withTicketSeatMemoryHome,
} from "../helpers/ticket-seat-memory-cli-fixture.ts";

test("#637 public countersign CLI: same-ticket resume, different-ticket isolation, independent runs", async () => {
  await withTicketSeatMemoryHome("ak-public-countersign-mem-", async ({ home, project, binDir }) => {
    await installSeatTicketFixtures(binDir, 637);

    const memoryDir637 = ticketSeatMemorySessionDirectory({
      ticketNumber: 637,
      seat: "countersign",
      cwd: project,
      home,
    });
    const memoryDir700 = ticketSeatMemorySessionDirectory({
      ticketNumber: 700,
      seat: "countersign",
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

    const first = await runPublicCountersign(
      ["裁：本票 #637 是否足以开工。"],
      { ...envBase, createRunId: () => "countersign-mem-1" },
      io,
      parseCountersignArgv,
    );
    assert.equal(seen.length, 1, "first public countersign must dispatch one turn");
    assert.equal(seen[0]!.kind, "initial", "first nest open is initial");
    assert.ok(
      seen[0]!.sessionFile.startsWith(memoryDir637),
      `first principal must seal ticket-seat nest, got ${seen[0]!.sessionFile}`,
    );
    const firstRunDir = await assertIndependentTerminal({
      label: "first same-ticket call",
      result: first,
      expectedRunId: "countersign-mem-1",
    });

    const second = await runPublicCountersign(
      ["裁：本票 #637 是否足以开工（续）。"],
      { ...envBase, createRunId: () => "countersign-mem-2" },
      io,
      parseCountersignArgv,
    );
    assert.equal(seen.length, 2, "second public countersign must dispatch one turn");
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
    const secondRunDir = await assertIndependentTerminal({
      label: "second same-ticket call",
      result: second,
      expectedRunId: "countersign-mem-2",
    });
    assert.notEqual(
      secondRunDir,
      firstRunDir,
      "independent terminals must not share a run directory",
    );
    // First call's terminal remains settled after the second call completes.
    assert.equal(
      (await readRoleRunState(firstRunDir, piDurablePrincipalAuthority))?.state,
      "terminal",
    );

    // Different ticket → different nest (typed principal isolation).
    await installSeatTicketFixtures(binDir, 700);
    const third = await runPublicCountersign(
      ["裁：本票 #700 是否足以开工。"],
      { ...envBase, createRunId: () => "countersign-mem-700" },
      io,
      parseCountersignArgv,
    );
    assert.equal(seen.length, 3, "different-ticket countersign must dispatch one turn");
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
    await assertIndependentTerminal({
      label: "different-ticket call",
      result: third,
      expectedRunId: "countersign-mem-700",
    });
  });
});

test("#637 public countersign: Grok native home spans failure, same-run retry, return-to-Grok", async () => {
  await withTicketSeatMemoryHome("ak-public-countersign-nh-", async ({ home, project, binDir }) => {
    await installSeatTicketFixtures(binDir, 637);

    const memoryDir = ticketSeatMemorySessionDirectory({
      ticketNumber: 637,
      seat: "countersign",
      cwd: project,
      home,
    });

    const { seen, host } = createNativeHomeTurnRecorder();
    const io = silentCliIo();
    const envBase = ticketSeatMemoryEnvBase({ home, project, host });

    // 1) Failure path still records Grok native-home ownership on the nest.
    const first = await runPublicCountersign(
      ["裁：本票 #637 是否足以开工。"],
      { ...envBase, host: "grok-build", createRunId: () => "countersign-nh-1" },
      io,
      parseCountersignArgv,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.kind, "initial");
    assert.equal(seen[0]!.nativeHomeRunDirectory, undefined);
    const firstRunDir = await assertIndependentTerminal({
      label: "grok failure call",
      result: first,
      expectedRunId: "countersign-nh-1",
    });
    assert.equal(first.terminal!.roleOutcome.kind, "failure");
    const afterFailure = await readTicketSeatMemoryLastHost(memoryDir);
    assert.deepEqual(afterFailure, {
      host: "grok-build",
      runDirectory: seen[0]!.runDirectory,
    });

    // 2) New-run resume reopens the established Grok native home.
    const second = await runPublicCountersign(
      ["裁：本票 #637 是否足以开工（二）。"],
      { ...envBase, host: "grok-build", createRunId: () => "countersign-nh-2" },
      io,
      parseCountersignArgv,
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.kind, "resume");
    assert.equal(seen[1]!.nativeHomeRunDirectory, seen[0]!.runDirectory);
    assert.notEqual(seen[1]!.runDirectory, seen[0]!.runDirectory);
    const secondRunDir = await assertIndependentTerminal({
      label: "grok new-run resume",
      result: second,
      expectedRunId: "countersign-nh-2",
    });
    assert.notEqual(secondRunDir, firstRunDir);
    assert.equal(second.terminal!.roleOutcome.kind, "failure");
    // Prior run stays terminal after the next call settles its own failure.
    assert.equal(
      (await readRoleRunState(firstRunDir, piDurablePrincipalAuthority))?.state,
      "terminal",
    );

    // 3) Same-run retry (invocation already marked grok) still carries native home.
    const retry = await runPublicCountersignResume(
      { runId: "countersign-nh-2" },
      { ...envBase, host: "grok-build" },
      io,
    );
    assert.equal(seen.length, 3);
    assert.equal(seen[2]!.kind, "resume");
    assert.equal(seen[2]!.nativeHomeRunDirectory, seen[0]!.runDirectory);
    assert.equal(seen[2]!.runDirectory, seen[1]!.runDirectory);
    assert.ok(retry.admitted, "same-run retry must retain admitted run");
    assert.equal(retry.admitted!.runDirectory, secondRunDir);
    await assertIndependentTerminal({
      label: "same-run retry",
      result: retry,
      expectedRunId: "countersign-nh-2",
    });

    // 4) Leave Grok for Pi — last-host host flips, Grok native home pointer preserved.
    const piCall = await runPublicCountersign(
      ["裁：本票 #637 是否足以开工（三）。"],
      { ...envBase, host: "pi", createRunId: () => "countersign-nh-3" },
      io,
      parseCountersignArgv,
    );
    assert.equal(seen.length, 4);
    assert.equal(seen[3]!.kind, "resume");
    assert.equal(seen[3]!.previousHost, "grok-build");
    await assertIndependentTerminal({
      label: "cross-host pi call",
      result: piCall,
      expectedRunId: "countersign-nh-3",
    });
    const afterPi = await readTicketSeatMemoryLastHost(memoryDir);
    assert.deepEqual(afterPi, {
      host: "pi",
      runDirectory: seen[0]!.runDirectory,
    });

    // 5) Old Grok run retry after Pi intermediate — last-host (pi) owns host,
    // not the stale per-run invocation mark. Return-to-Grok reopens established home.
    const returnGrok = await runPublicCountersignResume(
      { runId: "countersign-nh-2" },
      { ...envBase, host: "grok-build" },
      io,
    );
    assert.equal(seen.length, 5);
    assert.equal(seen[4]!.kind, "resume");
    assert.equal(seen[4]!.previousHost, "pi");
    assert.equal(seen[4]!.nativeHomeRunDirectory, seen[0]!.runDirectory);
    assert.equal(seen[4]!.runDirectory, seen[1]!.runDirectory);
    assert.ok(returnGrok.admitted, "return-to-Grok must retain admitted run");
    assert.equal(returnGrok.admitted!.runDirectory, secondRunDir);
    await assertIndependentTerminal({
      label: "return-to-Grok resume",
      result: returnGrok,
      expectedRunId: "countersign-nh-2",
    });
    const afterReturn = await readTicketSeatMemoryLastHost(memoryDir);
    assert.deepEqual(afterReturn, {
      host: "grok-build",
      runDirectory: seen[0]!.runDirectory,
    });
  });
});
