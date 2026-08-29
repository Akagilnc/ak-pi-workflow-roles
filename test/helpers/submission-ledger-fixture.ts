/**
 * Drive the production submission ledger producer for settlement tests.
 * Same createSubmissionLedgerHost path as role-runtime — not a parallel sitian write.
 */
import { basename } from "node:path";
import { Type } from "typebox";
import type { HostContext, HostToolDefinition, RoleHost } from "../../src/host-contracts.ts";
import { packagedRoleOutputTool } from "../../src/packaged-role-registry.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import {
  createSubmissionLedgerHost,
  readSealedSubmission,
} from "../../src/submission-ledger.ts";

function toolNameForRole(role: TerminalRoleName): string {
  const toolName = packagedRoleOutputTool(role);
  if (toolName === undefined) throw new Error(`no output tool for role ${role}`);
  return toolName;
}

/** Seal an accepted projection through the production ledger host. */
export async function sealAcceptedSubmission(input: {
  readonly cwd: string;
  readonly runId: string;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly home?: string;
  readonly toolCallId?: string;
  readonly runDirectory?: string;
}): Promise<void> {
  if (await readSealedSubmission(input.cwd, input.runId) !== undefined) return;
  const toolName = toolNameForRole(input.role);
  const toolCallId = input.toolCallId ?? "seal-1";
  let registered: HostToolDefinition | undefined;
  const host = {
    registerTool(tool: HostToolDefinition) {
      registered = tool;
    },
  } as RoleHost;
  createSubmissionLedgerHost(host, new Map([[toolName, input.role]])).registerTool({
    name: toolName,
    label: "output",
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: input.details, terminate: true }),
  });
  if (registered === undefined) throw new Error("submission ledger host did not register output tool");
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  if (input.home !== undefined) process.env.HOME = input.home;
  process.env.AK_ROLE_RUN_DIR =
    input.runDirectory ?? `${input.cwd}/runs/${input.runId}@${input.role}`;
  try {
    await registered.execute(
      toolCallId,
      {},
      undefined,
      undefined,
      {
        cwd: input.cwd,
        mode: "json",
        model: undefined,
        sessionManager: {
          getHeader: () => ({ type: "session", id: `${input.runId}:attempt` }),
          getLeafId: () => null,
          getLeafEntry: () => undefined,
          getEntries: () => [],
          getSessionDir: () => "",
          getSessionFile: () => undefined,
        },
        terminationBatch: {
          batchClosed: true,
          calls: [{ id: toolCallId, name: toolName }],
        },
        abort() {},
      } as HostContext,
    );
  } finally {
    if (input.home !== undefined) {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = priorRun;
  }
}

/** @deprecated name kept for call-site migration — routes through production ledger host. */
export async function writeSealedSubmissionFixture(input: {
  readonly cwd: string;
  readonly runDirectory: string;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly home?: string;
  readonly toolCallId?: string;
}): Promise<void> {
  const runId = basename(input.runDirectory).split("@")[0];
  if (runId === undefined || runId.length === 0) {
    throw new Error("sealed submission requires admitted run identity from runDirectory");
  }
  await sealAcceptedSubmission({
    cwd: input.cwd,
    runId,
    role: input.role,
    details: input.details,
    runDirectory: input.runDirectory,
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
  });
}

/** Spawn-env convenience for public-cli faux runners that already own typed details. */
export async function writeSealedSubmissionFixtureForSpawn(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly toolCallId?: string;
}): Promise<void> {
  const runDirectory = input.env.AK_ROLE_RUN_DIR;
  if (typeof runDirectory !== "string" || runDirectory.length === 0) return;
  await writeSealedSubmissionFixture({
    cwd: input.cwd,
    runDirectory,
    role: input.role,
    details: input.details,
    ...(typeof input.env.HOME === "string" ? { home: input.env.HOME } : {}),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
  });
}

/** Record a live audit-escalation outcome through the production ledger host. */
export async function recordAuditEscalationSubmission(input: {
  readonly cwd: string;
  readonly runId: string;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly home?: string;
  readonly toolCallId?: string;
  readonly runDirectory?: string;
}): Promise<void> {
  const { isAuditEscalationProjection, buildAuditEscalationResult } = await import(
    "../../src/audit-escalation.ts"
  );
  // Ensure details are live-registry projections so the ledger recognises them.
  let details = input.details;
  if (!isAuditEscalationProjection(details)) {
    const record = details as { conflicts?: unknown; decisionGate?: unknown; auditDecisionGate?: unknown };
    details = buildAuditEscalationResult(
      {
        status: "escalate",
        ...(Object.hasOwn(record, "conflicts") ? { conflicts: record.conflicts } : {}),
        ...(Object.hasOwn(record, "decisionGate")
          ? { decisionGate: record.decisionGate }
          : Object.hasOwn(record, "auditDecisionGate")
            ? { decisionGate: record.auditDecisionGate }
            : {}),
      },
      details,
    );
  }
  const toolName = toolNameForRole(input.role);
  const toolCallId = input.toolCallId ?? "escalate-1";
  let registered: HostToolDefinition | undefined;
  const host = {
    registerTool(tool: HostToolDefinition) {
      registered = tool;
    },
  } as RoleHost;
  createSubmissionLedgerHost(host, new Map([[toolName, input.role]])).registerTool({
    name: toolName,
    label: "output",
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details, terminate: true }),
  });
  if (registered === undefined) throw new Error("submission ledger host did not register output tool");
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  if (input.home !== undefined) process.env.HOME = input.home;
  process.env.AK_ROLE_RUN_DIR =
    input.runDirectory ?? `${input.cwd}/runs/${input.runId}@${input.role}`;
  try {
    await registered.execute(
      toolCallId,
      {},
      undefined,
      undefined,
      {
        cwd: input.cwd,
        mode: "json",
        model: undefined,
        sessionManager: {
          getHeader: () => ({ type: "session", id: `${input.runId}:attempt` }),
          getLeafId: () => null,
          getLeafEntry: () => undefined,
          getEntries: () => [],
          getSessionDir: () => "",
          getSessionFile: () => undefined,
        },
        terminationBatch: {
          batchClosed: true,
          calls: [{ id: toolCallId, name: toolName }],
        },
        abort() {},
      } as HostContext,
    );
  } finally {
    if (input.home !== undefined) {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = priorRun;
  }
}
