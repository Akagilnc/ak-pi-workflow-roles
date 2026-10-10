/**
 * Drive the production submission ledger producer for settlement tests.
 * Same createSubmissionLedgerHost path as role-runtime — not a parallel sitian write.
 */
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { HostContext, HostToolDefinition, RoleHost } from "../../src/host-contracts.ts";
import { resolveLiveRunDirectoryPath } from "../../src/external-host-turn-loop.ts";
import { packagedRoleOutputTool } from "../../src/packaged-role-registry.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";
import { createSubmissionLedgerHost } from "../../src/submission-ledger.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";

/**
 * #1183: ledger-mouth place may move the leaf while the faux in-process spawn
 * env copy still names the unbound path. Prefer the live leaf and write it back
 * onto env so later ForSpawn calls do not recreate a hollow unbound twin.
 */
async function spawnRunDirectoryFromEnv(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const recorded = env.AK_ROLE_RUN_DIR;
  if (typeof recorded !== "string" || recorded.length === 0) return undefined;
  const home =
    typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : undefined;
  if (home === undefined) return recorded;
  const live = await resolveLiveRunDirectoryPath(recorded, home);
  if (live !== undefined && live !== recorded) {
    env.AK_ROLE_RUN_DIR = live;
    return live;
  }
  return recorded;
}

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
  readonly outputDetails?: unknown;
  readonly home?: string;
  readonly toolCallId: string;
  readonly runDirectory?: string;
  readonly courtAttemptId?: string;
  /** #1199 this-turn summons / 催交 from the input seam (HostContext field). */
  readonly summonsInstruction?: string;
  /** #1199: issued session coordinate from the live --session / principal face. */
  readonly sessionFile?: string;
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
      return { content: [], details: input.outputDetails ?? input.details, terminate: true };
    },
  });
  if (registered === undefined) throw new Error("submission ledger host did not register output tool");
  let runDirectory = input.runDirectory ?? `${input.cwd}/runs/${input.runId}@${input.role}`;
  let sessionDirectory = input.sessionFile !== undefined
    ? dirname(input.sessionFile)
    : join(runDirectory, "session");
  let sessionFile = input.sessionFile ?? join(sessionDirectory, "session.jsonl");
  const context = {
        cwd: input.cwd,
        mode: "json",
        model: undefined,
        get runDirectory() { return runDirectory; },
        set runDirectory(next: string) { runDirectory = next; },
        ...(input.courtAttemptId === undefined ? {} : { courtAttemptId: input.courtAttemptId }),
        ...(input.summonsInstruction === undefined
          ? {}
          : { summonsInstruction: input.summonsInstruction }),
        sessionManager: {
          getHeader: () => ({ type: "session", id: `${input.runId}:attempt` }),
          getLeafId: () => null,
          getLeafEntry: () => undefined,
          getEntries: () => [],
          getSessionDir: () => sessionDirectory,
          getSessionFile: () => sessionFile,
          // #1199: mid-turn relocate projects the live handle (same as production).
          setSessionFile(path: string) {
            sessionFile = path;
            sessionDirectory = dirname(path);
          },
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
  readonly outputDetails?: unknown;
  readonly home?: string;
  readonly toolCallId?: string;
  readonly runDirectory?: string;
  /** Same-ticket re-summons court turn (#637); omit for first/manual seal. */
  readonly courtAttemptId?: string;
  /** #1199 this-turn summons / 催交 for seal-time progress. */
  readonly summonsInstruction?: string;
  /** #1199 issued session coordinate from the live host face. */
  readonly sessionFile?: string;
}): Promise<void> {
  await driveLedgerProducer({
    cwd: input.cwd,
    runId: input.runId,
    role: input.role,
    details: input.details,
    ...(input.outputDetails === undefined ? {} : { outputDetails: input.outputDetails }),
    toolCallId: input.toolCallId ?? "seal-1",
    ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.runDirectory === undefined ? {} : { runDirectory: input.runDirectory }),
    ...(input.courtAttemptId === undefined ? {} : { courtAttemptId: input.courtAttemptId }),
    ...(input.summonsInstruction === undefined
      ? {}
      : { summonsInstruction: input.summonsInstruction }),
  });
}

/** Spawn-env convenience for public-cli faux runners that already own typed details. */
export async function sealAcceptedSubmissionForSpawn(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** #1199: same stdin dialogue the live Pi child input seam records. */
  readonly stdin?: string;
  /** #1199: issued --session coordinate from the live host face. */
  readonly sessionFile?: string;
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly outputDetails?: unknown;
  readonly toolCallId?: string;
}): Promise<void> {
  const runDirectory = await spawnRunDirectoryFromEnv(input.env);
  if (runDirectory === undefined) return;
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
  // #1199: faux spawn mirrors the live input seam — progress instruction is
  // the model-facing body (what the seat actually receives).
  const summonsInstruction =
    typeof input.stdin === "string"
      ? readUserDialogueStdin(input.stdin)
      : undefined;
  await sealAcceptedSubmission({
    cwd: input.cwd,
    runId,
    runDirectory,
    role: input.role,
    details: input.details,
    ...(input.outputDetails === undefined ? {} : { outputDetails: input.outputDetails }),
    ...(home === undefined ? {} : { home }),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(courtAttemptId === undefined ? {} : { courtAttemptId }),
    ...(summonsInstruction === undefined ? {} : { summonsInstruction }),
    ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
  });
  // Place may have moved during ledger execute — keep the spawn env on the live leaf.
  await spawnRunDirectoryFromEnv(input.env);
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
  const runDirectory = await spawnRunDirectoryFromEnv(input.env);
  if (runDirectory === undefined) return;
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
  // Place may have moved during ledger execute — keep the spawn env on the live leaf.
  await spawnRunDirectoryFromEnv(input.env);
}
