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

import type { DiaristCommitFacts } from "../../src/diarist.ts";
import {
  DIARIST_OUTPUT_TOOL_NAME,
  DIARIST_SOURCES_FLAG,
} from "../../src/diarist-contracts.ts";
import type { HostContext, RoleHost } from "../../src/host-contracts.ts";
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
import { createDiaristRoleRuntime } from "../../src/role-runtime.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
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

type RegisteredTool = {
  readonly name: string;
  execute(
    toolCallId: string,
    parameters: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: HostContext,
  ): Promise<{ details?: unknown }>;
};

/**
 * Faux pi process for this seat: drives the production diarist role envelope
 * over the catalog the seat froze into this run's dossier, then hands the
 * envelope's own projection to the shared scripted-session writer. beforeAccept
 * is the real one — nothing about the commit band is re-expressed here.
 */
function diaristEnvelopeRunner(submitted: unknown): LegacyFauxPiRunner {
  return async (args, options) => {
    let registered: RegisteredTool | undefined;
    const host = {
      registerTool(tool: unknown) {
        registered = tool as RegisteredTool;
      },
      on() {},
      getAllTools: () => (registered === undefined ? [] : [{ name: registered.name }]),
    } as unknown as RoleHost;
    const runtime = createDiaristRoleRuntime(
      host,
      { loadSoul: async () => "起居郎职分（测试装载）" },
      () => argvFlagValue(args, `--${DIARIST_SOURCES_FLAG.name}`),
    );
    await runtime.activate();
    assert.ok(registered, "diarist envelope registered no output tool");
    const accepted = await registered.execute(
      "call_diarist_1",
      submitted,
      undefined,
      undefined,
      {} as HostContext,
    );
    return scriptedTerminatingToolSession({
      role: "diarist",
      toolName: DIARIST_OUTPUT_TOOL_NAME,
      details: accepted.details,
    })(args, options);
  };
}

test("ak-role diarist runs alone and leaves a readable 起居录", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Origin remote is load-bearing: the seat derives ticket identity from it.
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
      { cwd: project },
    );

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
          piRunner: diaristEnvelopeRunner({ status: "completed", selections: [] }),
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

    // 起居录 exists and is readable through the existing read entrypoints,
    // at the very paths this turn's receipt reported writing.
    const paths = resolveTicketProvenanceVolume(TICKET, project, home);
    const volume = await readTicketProvenance(TICKET, project, home);
    assert.equal(volume.recordFile, paths.recordFile);
    const humanView = await readFile(paths.humanViewFile, "utf8");
    assert.equal(humanView.length > 0, true, "人读面必须有内容");

    // 回执落账: the mechanical commit facts ride the accepted receipt.
    const facts = (
      result.terminal?.roleOutcome as { decisiveFacts?: { sitian?: DiaristCommitFacts } }
    ).decisiveFacts?.sitian;
    assert.ok(facts, "accepted 回执缺 sitian 机械事实");
    assert.equal(facts.ticketNumber, TICKET);
    assert.equal(facts.volumeRecordFile, paths.recordFile);
    assert.equal(facts.humanViewFile, paths.humanViewFile);
  });
});
