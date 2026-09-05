/**
 * #636 — 察院/符宝郎 ticket+seat memory principal via public entry.
 * Same ticket reopens the same nest; different tickets isolate; public CLI
 * second call sends continuation.resume on the sealed principal. Native host
 * reopen + cross-host DK-4 true runs are #638 family evidence — this suite
 * does not treat mock handoff as DK-4 completion.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readTicketSeatMemoryLastHost,
  ticketSeatMemorySessionDirectory,
} from "../../src/ticket-seat-memory.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { runPublicInspector } from "../../src/public-cli/inspector-run.ts";
import { runPublicNotary, runPublicNotaryResume } from "../../src/public-cli/notary-run.ts";
import { parseInspectorArgv, parseNotaryArgv } from "../../src/public-cli/invocation.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import {
  installGhFixture,
  installHermesFixture,
} from "../helpers/hermes-fixture.ts";
import {
  CANONICAL_SOURCE_ROLE,
  CANONICAL_SOURCE_RUN_ID,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
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

test("#636 public notary CLI: same-ticket resume, different-ticket isolation, independent runs", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-public-notary-mem-"));
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
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
    const seen: Array<{
      sessionFile: string;
      kind: RoleTurnRequest["continuation"]["kind"];
      runDirectory: string;
    }> = [];
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        const sessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
        seen.push({
          sessionFile,
          kind: request.continuation.kind,
          runDirectory: request.runDirectory,
        });
        // No scripted session rewrite: contract under test is the turn request wire.
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
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("#636 public inspector CLI: ticket+seat nest seals and second call resumes", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-public-inspector-mem-"));
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // #635 seat self-ticket via hermes/gh fixtures — no CLI --ticket.
    await installGhFixture(join(home, "bin"), {
      issues: { 636: { body: "issue 636 body", comments: [] } },
    });
    await installHermesFixture(join(home, "bin"), {
      resolverResponse: { assertion: "ticket", ticketNumber: 636 },
    });
    const memoryDir = ticketSeatMemorySessionDirectory({
      ticketNumber: 636,
      seat: "inspector",
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
        const sessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
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

    // PATH must see hermes/gh fixtures for seat ticket bind.
    const prevPath = process.env.PATH;
    process.env.PATH = `${join(home, "bin")}${prevPath ? `:${prevPath}` : ""}`;
    try {
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
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("#636 public notary: Grok native home spans failure, same-run retry, return-to-Grok", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-public-notary-native-home-"));
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
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
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
