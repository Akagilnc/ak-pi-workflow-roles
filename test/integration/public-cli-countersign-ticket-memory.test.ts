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
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readTicketSeatMemoryLastHost,
  ticketSeatMemorySessionDirectory,
} from "../../src/ticket-seat-memory.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import {
  runPublicCountersign,
  runPublicCountersignResume,
} from "../../src/public-cli/countersign-run.ts";
import { parseCountersignArgv } from "../../src/public-cli/invocation.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import {
  installGhFixture,
  installHermesFixture,
} from "../helpers/hermes-fixture.ts";
import {
  packageRoot,
  seedGitRepository,
} from "../helpers/pi-test-harness.ts";

function seedGitProject(root: string): void {
  seedGitRepository(root);
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
    { cwd: root },
  );
}

async function withTempCountersignHome(
  run: (ctx: { home: string; project: string; binDir: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-countersign-mem-"));
  const project = join(home, "project");
  const binDir = join(home, "bin");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}${prevPath ? `:${prevPath}` : ""}`;
  try {
    await run({ home, project, binDir });
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    // Imperial law: tests must not delete any directory.
  }
}

async function installTicketFixtures(
  binDir: string,
  ticketNumber: number,
): Promise<void> {
  await installHermesFixture(binDir, {
    resolverResponse: { assertion: "ticket", ticketNumber },
    collectorResponse: { selections: [] },
  });
  await installGhFixture(binDir, {
    issues: {
      [ticketNumber]: {
        body: `issue ${ticketNumber} body`,
        comments: [],
      },
    },
  });
}

test("#637 public countersign CLI: same-ticket resume, different-ticket isolation, independent runs", async () => {
  await withTempCountersignHome(async ({ home, project, binDir }) => {
    await installTicketFixtures(binDir, 637);

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

    const seen: Array<{
      sessionFile: string;
      kind: RoleTurnRequest["continuation"]["kind"];
      runDirectory: string;
    }> = [];
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        const sessionFile = piDurablePrincipalAuthority.decode(
          request.principal,
        ).sessionFile;
        seen.push({
          sessionFile,
          kind: request.continuation.kind,
          runDirectory: request.runDirectory,
        });
        return { code: 0, stderr: "", timedOut: false };
      },
    };

    const io = {
      stdout: (_t: string) => {},
      stderr: (_t: string) => {},
    };
    const envBase = {
      packageRoot,
      home,
      agentDir: join(home, "agent"),
      cwd: project,
      principalAuthority: piDurablePrincipalAuthority,
      roleTurnHost: host,
      sessionAppender: appendPiSessionCustomEntry,
      host: "pi" as const,
    };

    await runPublicCountersign(
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

    await runPublicCountersign(
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

    // Different ticket → different nest (typed principal isolation).
    await installTicketFixtures(binDir, 700);
    await runPublicCountersign(
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
  });
});

test("#637 public countersign: Grok native home spans failure, same-run retry, return-to-Grok", async () => {
  await withTempCountersignHome(async ({ home, project, binDir }) => {
    await installTicketFixtures(binDir, 637);

    const memoryDir = ticketSeatMemorySessionDirectory({
      ticketNumber: 637,
      seat: "countersign",
      cwd: project,
      home,
    });

    const seen: Array<{
      kind: RoleTurnRequest["continuation"]["kind"];
      runDirectory: string;
      nativeHomeRunDirectory?: string;
      previousHost?: string;
    }> = [];
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        seen.push({
          kind: request.continuation.kind,
          runDirectory: request.runDirectory,
          ...(request.nativeHomeRunDirectory === undefined
            ? {}
            : { nativeHomeRunDirectory: request.nativeHomeRunDirectory }),
          ...(request.hostTransition === undefined
            ? {}
            : { previousHost: request.hostTransition.previousHost }),
        });
        return { code: 1, stderr: "controlled-stop\n", timedOut: false };
      },
    };

    const io = {
      stdout: (_t: string) => {},
      stderr: (_t: string) => {},
    };
    const envBase = {
      packageRoot,
      home,
      agentDir: join(home, "agent"),
      cwd: project,
      principalAuthority: piDurablePrincipalAuthority,
      roleTurnHost: host,
      sessionAppender: appendPiSessionCustomEntry,
    };

    // 1) Failure path still records Grok native-home ownership on the nest.
    await runPublicCountersign(
      ["裁：本票 #637 是否足以开工。"],
      { ...envBase, host: "grok-build", createRunId: () => "countersign-nh-1" },
      io,
      parseCountersignArgv,
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
    await runPublicCountersign(
      ["裁：本票 #637 是否足以开工（二）。"],
      { ...envBase, host: "grok-build", createRunId: () => "countersign-nh-2" },
      io,
      parseCountersignArgv,
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.kind, "resume");
    assert.equal(seen[1]!.nativeHomeRunDirectory, seen[0]!.runDirectory);
    assert.notEqual(seen[1]!.runDirectory, seen[0]!.runDirectory);

    // Independent terminals: each run leaves its own admitted page under its run dir.
    const admitted1 = JSON.parse(
      await readFile(join(seen[0]!.runDirectory, "admitted-request.json"), "utf8"),
    ) as { runId?: string; sessionFile?: string };
    const admitted2 = JSON.parse(
      await readFile(join(seen[1]!.runDirectory, "admitted-request.json"), "utf8"),
    ) as { runId?: string; sessionFile?: string };
    assert.equal(admitted1.runId, "countersign-nh-1");
    assert.equal(admitted2.runId, "countersign-nh-2");
    assert.equal(admitted1.sessionFile, admitted2.sessionFile);

    // 3) Same-run retry (invocation already marked grok) still carries native home.
    await runPublicCountersignResume(
      { runId: "countersign-nh-2" },
      { ...envBase, host: "grok-build" },
      io,
    );
    assert.equal(seen.length, 3);
    assert.equal(seen[2]!.kind, "resume");
    assert.equal(seen[2]!.nativeHomeRunDirectory, seen[0]!.runDirectory);
    assert.equal(seen[2]!.runDirectory, seen[1]!.runDirectory);

    // 4) Leave Grok for Pi — last-host host flips, Grok native home pointer preserved.
    await runPublicCountersign(
      ["裁：本票 #637 是否足以开工（三）。"],
      { ...envBase, host: "pi", createRunId: () => "countersign-nh-3" },
      io,
      parseCountersignArgv,
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
    // not the stale per-run invocation mark. Return-to-Grok reopens established home.
    await runPublicCountersignResume(
      { runId: "countersign-nh-2" },
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
