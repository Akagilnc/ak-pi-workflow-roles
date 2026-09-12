/**
 * Public Diarist (起居郎) Role run — #708 / ADR 0075 `diarist-is-role` / #779.
 * Same admit → post-admission → settle shape as the other instruction seats.
 * Semantic collection is the role's own turn: LLM finds materials itself
 * (no frozen candidate catalog, no path/attachment burden on the caller).
 * Who calls it and in what order is the caller's business (ADR 0010 `no-call-rule`).
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions, pickEngineAxis } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitDiaristInvocation,
  bindAdmittedTicketNumber,
  buildInstructionTransportPrompt,
  type AdmittedDiaristInvocation,
  type ParseDiaristArgvResult,
} from "./invocation.ts";
import {
  prepareSummonsResumeMaterials,
  runPostAdmissionOneShot,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import {
  loadResumableDiaristRun,
  markRunAdmitted,
  type PublicResumeRequest,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import { tryResumeSameTicketSeatRun } from "./seat-ticket-binding.ts";
import {
  presentStructuralRejection,
  trySettleDiaristTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";
import { readRunTicketNumber } from "../run-ticket-number.ts";

export type DiaristRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
  /**
   * Typed handoff from a caller that already holds a verified ticket key
   * (countersign refresh / post-assert). Never derived from summons prose.
   * When set: same-ticket resume under that key, else bind before the turn
   * so identity is already on the run pages (ADR 0075 / 0081).
   */
  boundTicketNumber?: number;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildDiaristTurnRequest(
  admitted: AdmittedDiaristInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    { activation: { role: "diarist" as const } },
    options,
  );
}

function diaristAdapters(): PostAdmissionAdapters<AdmittedDiaristInvocation> {
  return {
    trySettle: (admitted, authority, scope) =>
      trySettleDiaristTerminalResult(admitted, authority, scope),
    shouldPresentSettled: () => true,
  };
}

export async function runPublicDiarist(
  argv: readonly string[],
  env: DiaristRunEnv,
  io: CliIo,
  parseDiaristArgv: (args: readonly string[]) => ParseDiaristArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedDiaristInvocation;
  terminal?: TerminalResult;
}> {
  let parsed: ParseDiaristArgvResult;
  try {
    parsed = parseDiaristArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  // #637 / #771 / ADR 0075 / #779: ticket identity is the LLM's typed assertion
  // on this turn, OR a typed handoff key already held by the caller (countersign
  // refresh). Code never pre-judges the summons text and never freezes a
  // candidate catalog. First summons without handoff stays unbound until assert.

  const projectRoot = parsed.project ?? env.cwd;
  const handoffTicket = env.boundTicketNumber;
  if (
    typeof handoffTicket === "number" &&
    Number.isSafeInteger(handoffTicket) &&
    handoffTicket >= 1
  ) {
    const summons: SameTicketSummonsMaterials = {
      instruction: parsed.instruction,
      instructionEmpty: parsed.instruction.trim() === "",
      attachmentPaths: parsed.attachmentPaths,
    };
    const resumed = await tryResumeSameTicketSeatRun({
      home: env.home,
      projectRoot,
      role: "diarist",
      ticketNumber: handoffTicket,
      freshSummons: env.freshSummons,
      summons,
      resume: (runId, materials) =>
        runPublicDiaristResume(
          { runId, ...(materials === undefined ? {} : { summons: materials }) },
          env,
          io,
        ),
    });
    if (resumed !== undefined) return resumed;
  }

  let admitted: AdmittedDiaristInvocation;
  try {
    admitted = await admitDiaristInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
      ...(env.model === undefined ? {} : { model: env.model }),
      ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  await markRunAdmitted(admitted, env.principalAuthority);

  // Typed handoff: bind before the turn so identity is on durable pages.
  if (
    typeof handoffTicket === "number" &&
    Number.isSafeInteger(handoffTicket) &&
    handoffTicket >= 1
  ) {
    await bindAdmittedTicketNumber(admitted, handoffTicket);
  }

  const turnProjection: RoleTurnRequestProjectionOptions = {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...pickEngineAxis(env),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(env.correlationId === undefined || env.correlationId.trim() === ""
      ? {}
      : { correlationId: env.correlationId }),
    continuation: {
      kind: "initial",
      prompt: buildInstructionTransportPrompt(
        admitted,
        engineSessionMaterialFromOptions({
          ...pickEngineAxis(env),
          packageRoot: env.packageRoot,
        }),
      ),
    },
  };
  const turnRequest = buildDiaristTurnRequest(admitted, turnProjection);

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: diaristAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  }).then(async (result) => {
    // Accept hook binds ticket onto durable pages (#771). Mirror that page fact
    // onto the caller-visible admitted object — never pick a ticketNumber out of
    // the payload sequence (#881 sole-collapse ban on ticket/escalate).
    if (admitted.ticketNumber === undefined && result.admitted !== undefined) {
      const fromPages = await readRunTicketNumber(admitted.runDirectory);
      if (fromPages !== undefined) {
        await bindAdmittedTicketNumber(admitted, fromPages);
        if (result.admitted.ticketNumber === undefined) {
          (result.admitted as { ticketNumber?: number }).ticketNumber = fromPages;
        }
      }
    }
    return result;
  });
}

/**
 * Resume a previously admitted Diarist run (#708 / ADR 0079 同票传召 = resume).
 * LLM re-finds materials; entry identity keeps the volume idempotent.
 */
export async function runPublicDiaristResume(
  request: PublicResumeRequest,
  env: DiaristRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedDiaristInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) =>
      loadResumableDiaristRun(env.home, effective.runId, env.principalAuthority),
    buildTurnRequest: async (admitted, effective) => {
      const summonsPrepared = await prepareSummonsResumeMaterials(
        admitted.runDirectory,
        effective.summons,
      );
      return buildDiaristTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(
          admitted,
          effective,
          env,
          summonsPrepared,
        ),
      );
    },
    adapters: diaristAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
