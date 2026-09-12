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
import { createSubmissionLedgerHost } from "../../src/submission-ledger.ts";

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
  readonly courtAttemptId?: string;
  /** When set, execute throws after the candidate row is written (non-sealed paths). */
  readonly executeError?: unknown;
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
    execute: async () => {
      if (Object.hasOwn(input, "executeError")) throw input.executeError;
      return { content: [], details: input.details, terminate: true };
    },
  });
  if (registered === undefined) throw new Error("submission ledger host did not register output tool");
  const context = {
        cwd: input.cwd,
        mode: "json",
        model: undefined,
        runDirectory: input.runDirectory ?? `${input.cwd}/runs/${input.runId}@${input.role}`,
        ...(input.courtAttemptId === undefined ? {} : { courtAttemptId: input.courtAttemptId }),
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
    // #836: recording happens on execute from LLM params; turn_end only books roundContext.
    // Fixture details stand in for the model tool-call arguments.
    try {
      await registered.execute(input.toolCallId, input.details, undefined, undefined, context);
    } catch (error) {
      if (!Object.hasOwn(input, "executeError")) throw error;
      // Non-sealed path: candidate + outcome already on the ledger; swallow for fixtures.
    }
    const turnEnd = handlers.get("turn_end");
    if (turnEnd !== undefined) {
      await turnEnd({
        turnIndex: 0,
        calls: [{ toolCallId: input.toolCallId, toolName }],
      }, context);
    }
}

/**
 * Seal an accepted projection through the production ledger host.
 * #836: the submission tool records every call — callers decide whether a
 * given turn provides `sealedAcceptance` at all; this producer never
 * second-guesses that by skipping a call because something was already
 * recorded (调几次记几次, no dedup gate here).
 */
export async function sealAcceptedSubmission(input: {
  readonly cwd: string;
  readonly runId: string;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly home?: string;
  readonly toolCallId?: string;
  readonly runDirectory?: string;
  /** Same-ticket re-summons court turn (#637); omit for first/manual seal. */
  readonly courtAttemptId?: string;
}): Promise<void> {
  await driveLedgerProducer({
    cwd: input.cwd,
    runId: input.runId,
    role: input.role,
    details: input.details,
    toolCallId: input.toolCallId ?? "seal-1",
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.runDirectory === undefined ? {} : { runDirectory: input.runDirectory }),
    ...(input.courtAttemptId === undefined ? {} : { courtAttemptId: input.courtAttemptId }),
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
  const courtAttemptId =
    typeof input.env.AK_ROLE_COURT_ATTEMPT === "string" &&
    input.env.AK_ROLE_COURT_ATTEMPT.length > 0
      ? input.env.AK_ROLE_COURT_ATTEMPT
      : undefined;
  await sealAcceptedSubmission({
    cwd: input.cwd,
    runId,
    runDirectory,
    role: input.role,
    details: input.details,
    ...(home === undefined ? {} : { home }),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(courtAttemptId === undefined ? {} : { courtAttemptId }),
  });
}

/**
 * Record a non-sealed output-tool call through the production ledger host (#881).
 * `executeError` selects correctable-rejection vs infrastructure the same way the
 * live host does — no parallel sitian write.
 */
export async function recordNonSealedSubmission(input: {
  readonly cwd: string;
  readonly runId: string;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly executeError: unknown;
  readonly home?: string;
  readonly toolCallId?: string;
  readonly runDirectory?: string;
  readonly courtAttemptId?: string;
}): Promise<void> {
  await driveLedgerProducer({
    cwd: input.cwd,
    runId: input.runId,
    role: input.role,
    details: input.details,
    executeError: input.executeError,
    toolCallId: input.toolCallId ?? "non-sealed-1",
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.runDirectory === undefined ? {} : { runDirectory: input.runDirectory }),
    ...(input.courtAttemptId === undefined ? {} : { courtAttemptId: input.courtAttemptId }),
  });
}

/** Spawn-env convenience for public-cli faux runners recording non-sealed paths. */
export async function recordNonSealedSubmissionForSpawn(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly executeError: unknown;
  readonly toolCallId?: string;
}): Promise<void> {
  const runDirectory = input.env.AK_ROLE_RUN_DIR;
  if (typeof runDirectory !== "string" || runDirectory.length === 0) return;
  const runId = runIdFromRunDirectory(runDirectory);
  if (runId === undefined) {
    throw new Error("non-sealed submission requires admitted run identity from runDirectory");
  }
  const home =
    typeof input.env.HOME === "string" && input.env.HOME.length > 0
      ? input.env.HOME
      : undefined;
  const courtAttemptId =
    typeof input.env.AK_ROLE_COURT_ATTEMPT === "string" &&
    input.env.AK_ROLE_COURT_ATTEMPT.length > 0
      ? input.env.AK_ROLE_COURT_ATTEMPT
      : undefined;
  await recordNonSealedSubmission({
    cwd: input.cwd,
    runId,
    runDirectory,
    role: input.role,
    details: input.details,
    executeError: input.executeError,
    ...(home === undefined ? {} : { home }),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(courtAttemptId === undefined ? {} : { courtAttemptId }),
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
