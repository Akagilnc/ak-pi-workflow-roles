/**
 * Drive the production submission ledger producer for settlement tests.
 * Same createSubmissionLedgerHost path as role-runtime — not a parallel sitian write.
 */
import { Type } from "typebox";
import { buildAuditEscalationResult, isAuditEscalationProjection } from "../../src/audit-escalation.ts";
import type { HostContext, HostToolDefinition, RoleHost } from "../../src/host-contracts.ts";
import { packagedRoleOutputTool } from "../../src/packaged-role-registry.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";
import {
  createSubmissionLedgerHost,
  readSealedSubmission,
} from "../../src/submission-ledger.ts";

function toolNameForRole(role: TerminalRoleName): string {
  const toolName = packagedRoleOutputTool(role);
  if (toolName === undefined) throw new Error(`no output tool for role ${role}`);
  return toolName;
}

/** Shared producer core — one pipeline, callers only supply details + options. */
async function driveLedgerProducer(input: {
  readonly cwd: string;
  readonly runId: string;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly home?: string;
  readonly toolCallId: string;
  readonly runDirectory?: string;
}): Promise<void> {
  const toolName = toolNameForRole(input.role);
  let registered: HostToolDefinition | undefined;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const host = {
    registerTool(tool: HostToolDefinition) {
      registered = tool;
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  } as RoleHost;
  createSubmissionLedgerHost(
    host,
    new Map([[toolName, input.role]]),
    undefined,
    undefined,
    input.home === undefined ? undefined : { home: input.home },
  ).registerTool({
    name: toolName,
    label: "output",
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: input.details, terminate: true }),
  });
  if (registered === undefined) throw new Error("submission ledger host did not register output tool");
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR =
    input.runDirectory ?? `${input.cwd}/runs/${input.runId}@${input.role}`;
  try {
    const context = {
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
        abort() {},
      } as HostContext;
    await handlers.get("tool_execution_start")!({ toolCallId: input.toolCallId, toolName }, context);
    await registered.execute(input.toolCallId, {}, undefined, undefined, context);
    await handlers.get("turn_end")!({
      turnIndex: 0,
      calls: [{ toolCallId: input.toolCallId, toolName }],
    }, context);
  } finally {
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = priorRun;
  }
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
  // Read under the same machine home the producer writes (not ambient process HOME).
  if (await readSealedSubmission(input.cwd, input.runId, input.home) !== undefined) return;
  await driveLedgerProducer({
    cwd: input.cwd,
    runId: input.runId,
    role: input.role,
    details: input.details,
    toolCallId: input.toolCallId ?? "seal-1",
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.runDirectory === undefined ? {} : { runDirectory: input.runDirectory }),
  });
}

/** Spawn-env convenience for public-cli faux runners that already own typed details. */
export async function sealAcceptedSubmissionForSpawn(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly toolCallId?: string;
}): Promise<void> {
  const runDirectory = input.env.AK_ROLE_RUN_DIR;
  if (typeof runDirectory !== "string" || runDirectory.length === 0) return;
  const runId = runIdFromRunDirectory(runDirectory);
  if (runId === undefined) {
    throw new Error("sealed submission requires admitted run identity from runDirectory");
  }
  // #604: package home is request.home (role-turn sets env.HOME to that value for
  // child process isolation), not process ambient HOME. Prefer explicit env.HOME
  // from the turn host; never invent a second home channel.
  const home =
    typeof input.env.HOME === "string" && input.env.HOME.length > 0
      ? input.env.HOME
      : undefined;
  await sealAcceptedSubmission({
    cwd: input.cwd,
    runId,
    runDirectory,
    role: input.role,
    details: input.details,
    ...(home === undefined ? {} : { home }),
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
  await driveLedgerProducer({
    cwd: input.cwd,
    runId: input.runId,
    role: input.role,
    details,
    toolCallId: input.toolCallId ?? "escalate-1",
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.runDirectory === undefined ? {} : { runDirectory: input.runDirectory }),
  });
}
