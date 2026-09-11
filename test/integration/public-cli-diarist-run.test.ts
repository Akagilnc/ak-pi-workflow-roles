/**
 * #708 / #779 public 起居郎 seat — `ak-role diarist` is a role like the other seats.
 * No frozen catalog; LLM submits whole blocks; mechanical layer appends only.
 * Owner testing ruling: only prove the 起居录 is generated and readable; content
 * quality is judged by 大理寺 and real use. No quote/note/entry-count locks.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { DIARIST_OUTPUT_TOOL_NAME } from "../../src/diarist-contracts.ts";
import type { HostContext, RoleHost } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { roleRunPlacement } from "../../src/role-run-placement.ts";
import {
  readTicketProvenance,
  resolveTicketProvenanceVolume,
} from "../../src/ticket-provenance.ts";
import { createDiaristRoleRuntime } from "../../src/role-runtime.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const TICKET = 708;
/** Structured source pointer the protocol payload and volume must share. */
const ENTRY_SESSION_FILE = "/probe/session.jsonl";
const ENTRY_ID = "probe-entry-1";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-diarist-", async (home) => scenario(home));
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
 * Faux pi process for this seat: drives the production diarist role envelope.
 * Sets AK_ROLE_RUN_DIR from the spawn env so accept can bind + commit (#779).
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
    const priorRunDir = process.env.AK_ROLE_RUN_DIR;
    const runDir = options.env.AK_ROLE_RUN_DIR;
    if (typeof runDir === "string" && runDir.trim() !== "") {
      process.env.AK_ROLE_RUN_DIR = runDir;
    }
    try {
      const runtime = createDiaristRoleRuntime(host, {
        loadSoul: async () => "起居郎职分（测试装载）",
      });
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
    } finally {
      if (priorRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = priorRunDir;
    }
  };
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
          piRunner: diaristEnvelopeRunner({
            status: "completed",
            ticketNumber: TICKET,
            entries: [
              {
                sourceKind: "cc-session",
                sourceRef: {
                  sessionFile: ENTRY_SESSION_FILE,
                  entryId: ENTRY_ID,
                },
                transcript: "owner decision block for diary commit probe",
                timestamp: "2026-09-08T00:00:00.000Z",
              },
              // Passes transport projection; write-seam rejects unknown sourceKind.
              {
                sourceKind: "not-a-source-kind",
                sourceRef: { sessionFile: "/probe/drop.jsonl" },
                transcript: "dropped at write seam only",
                timestamp: "2026-09-08T00:00:00.000Z",
              },
            ],
          }),
        }),
      },
    );

    assert.equal(result.exitCode, 0, stdout.join("") || "diarist run failed");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.roleOutcome.role, "diarist");

    const placement = roleRunPlacement(resolveActivationLedgerHome(home), {
      bookKey: resolveBookKeyFromGit(project),
      subject: { ticketNumber: TICKET },
      runId,
      role: "diarist",
    });
    const state = await readRoleRunState(
      placement.runDirectory,
      piDurablePrincipalAuthority,
    );
    assert.equal(state?.role, "diarist");
    assert.equal(state?.state, "terminal");

    const paths = resolveTicketProvenanceVolume(TICKET, project, home);
    const volume = await readTicketProvenance(TICKET, project, home);
    assert.equal(volume.recordFile, paths.recordFile);
    // Structured pointer identity only — no free-text / entry-count locks.
    const landed = volume.entries.find(
      (e) =>
        e.sourceKind === "cc-session" &&
        e.sourceRef.sessionFile === ENTRY_SESSION_FILE &&
        e.sourceRef.entryId === ENTRY_ID,
    );
    assert.ok(landed, "volume missing entry with submitted sourceRef");
    const humanView = await readFile(paths.humanViewFile, "utf8");
    assert.equal(humanView.length > 0, true, "人读面必须有内容");
    // Machine sitian facts stay beside the original payload, not injected into it (#836 B6.7).
  });
});

test("ak-role diarist true-unbound leaves no 起居录", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0diar00-0000-7000-8000-000000000002";
    const { io, stdout } = captureIo();
    const result = await runAkRole(
      ["diarist", "--project", project, "整理这份方案的依据"],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: diaristEnvelopeRunner({
            status: "completed",
            ticketNumber: null,
            entries: [],
          }),
        }),
      },
    );

    assert.equal(result.exitCode, 0, stdout.join("") || "true-unbound failed");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    const facts = (
      result.terminal?.roleOutcome as {
        decisiveFacts?: { ticketNumber?: unknown; sitian?: unknown };
      }
    ).decisiveFacts;
    assert.equal(facts?.ticketNumber ?? null, null);
    assert.equal(facts?.sitian, undefined);

    // 真无票→无录: production volume category (via resolveTicketProvenanceVolume) unminted.
    const sample = resolveTicketProvenanceVolume(1, project, home);
    const provenanceCategory = dirname(sample.volumeDir);
    assert.equal(existsSync(sample.recordFile), false);
    assert.equal(existsSync(sample.humanViewFile), false);
    assert.equal(
      existsSync(provenanceCategory),
      false,
      `true-unbound must not mint ticket-provenance under ${provenanceCategory}`,
    );
  });
});
