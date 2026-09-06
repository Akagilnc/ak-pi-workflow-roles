/**
 * #708 public 起居郎 seat — `ak-role diarist` is a role like the other seats.
 * Owner testing ruling: only prove the 起居录 is generated and readable; content
 * quality is judged by 大理寺 and real use. No quote/note/entry-count locks.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { DIARIST_OUTPUT_TOOL_NAME } from "../../src/diarist-contracts.ts";
import {
  issuePiDurablePrincipalCoordinates,
  piDurablePrincipalAuthority,
} from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import {
  readTicketProvenance,
  resolveTicketProvenanceVolume,
} from "../../src/ticket-provenance.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { installGhFixture, installHermesFixture } from "../helpers/hermes-fixture.ts";
import {
  withPrimaryAwareCleanup,
  withTempRoot,
} from "../helpers/primary-aware-cleanup.ts";

const TICKET = 708;

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-diarist-", async (home) => {
    const binDir = join(home, "bin");
    // Hermetic ticket identity + issue face: no live GitHub, no live LLM.
    await installHermesFixture(binDir, {
      resolverResponse: { assertion: "ticket", ticketNumber: TICKET },
    });
    await installGhFixture(binDir, {
      issues: {
        [TICKET]: {
          body: "「起居郎建制为角色」\n本票要求起居郎与其他席位同形。",
        },
      },
    });
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    return withPrimaryAwareCleanup(
      () => scenario(home),
      async () => {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      },
    );
  });
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "diarist@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Diarist Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
    { cwd: root },
  );
}

test("ak-role diarist runs alone and leaves a readable 起居录", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0diar00-0000-7000-8000-000000000001";
    const { io, stdout } = captureIo();
    const result = await runAkRole(
      ["diarist", "--project", project, `整理 #${TICKET} 起居录`],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedTerminatingToolSession({
            role: "diarist",
            toolName: DIARIST_OUTPUT_TOOL_NAME,
            details: { status: "completed", selections: [] },
          }),
        }),
      },
    );

    assert.equal(result.exitCode, 0, stdout.join("") || "diarist run failed");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.roleOutcome.role, "diarist");

    // Run dossier is isomorphic with every other packaged seat.
    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId,
      role: "diarist",
      home,
    });
    const state = await readRoleRunState(
      coords.runDirectory,
      piDurablePrincipalAuthority,
    );
    assert.equal(state?.role, "diarist");
    assert.equal(state?.state, "terminal");

    // 起居录 exists and is readable through the existing read entrypoints.
    const volume = await readTicketProvenance(TICKET, project, home);
    assert.equal(volume.recordFile.length > 0, true);
    const humanView = resolveTicketProvenanceVolume(
      TICKET,
      project,
      home,
    ).humanViewFile;
    assert.equal(typeof (await readFile(humanView, "utf8")), "string");
  });
});
