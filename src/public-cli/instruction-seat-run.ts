/**
 * Shared instruction-seat run (#639 / #675 / #637): gatekeeper, navigator, auditor
 * share admit → turn-request → post-admission → settle.
 * Auditor same-parent (--source-run) re-summons resume via tryResumeSameTicketSeatRun
 * (#747); other instruction seats keep ticket-number principal — no independent
 * run/rebind/nest path. (#744: evidence-child public seat deleted.)
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { readRunTicketNumber } from "../run-ticket-number.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitAuditorInvocation,
  admitGatekeeperInvocation,
  admitNavigatorInvocation,
  bindAdmittedTicketNumber,
  buildInstructionTransportPrompt,
  persistAdmittedSourceRunPath,
  type AdmittedAuditorInvocation,
  type AdmittedGatekeeperInvocation,
  type AdmittedNavigatorInvocation,
  type ParseInstructionArgvResult,
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
  loadResumableInstructionSeatRun,
  markRunAdmitted,
  type PublicResumeRequest,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import { tryResumeSameTicketSeatRun } from "./seat-ticket-binding.ts";
import {
  presentStructuralRejection,
  readEngineDetourInfrastructureFailure,
  trySettleAuditorTerminalResult,
  trySettleGatekeeperTerminalResult,
  trySettleNavigatorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type InstructionSeatRole =
  | "gatekeeper"
  | "navigator"
  | "auditor";

export type AdmittedInstructionSeatInvocation =
  | AdmittedGatekeeperInvocation
  | AdmittedNavigatorInvocation
  | AdmittedAuditorInvocation;

export type InstructionSeatRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
  /**
   * #756 nested gate re-ask for auditor: plain-language instruction on same-ticket resume.
   * Only set by summonPublicRole when the prior officer reply was not three-state.
   * Never a public CLI argv — must not pollute the --source-run parent lookup key (#747).
   */
  reviewReask?: string;
};

/** Project an admitted instruction-seat invocation onto the host-neutral turn request. */
export function buildInstructionSeatTurnRequest(
  admitted: AdmittedInstructionSeatInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: admitted.role,
      },
    },
    options,
  );
}

function instructionSeatAdapters(options?: {
  beforeDispatch?: (
    admitted: AdmittedInstructionSeatInvocation,
  ) => void | Promise<void>;
}): PostAdmissionAdapters<AdmittedInstructionSeatInvocation> {
  return {
    trySettle: (
      admitted: AdmittedInstructionSeatInvocation,
      authority: DurablePrincipalAuthority,
      scope?: { readonly courtAttemptId?: string },
    ) => {
      switch (admitted.role) {
        case "gatekeeper":
          return trySettleGatekeeperTerminalResult(admitted, authority, scope);
        case "navigator":
          return trySettleNavigatorTerminalResult(admitted, authority, scope);
        case "auditor":
          return trySettleAuditorTerminalResult(admitted, authority, scope);
      }
    },
    // Accepted receipts and failure terminals both present via shared path.
    shouldPresentSettled: () => true,
    // #675 / #357 T2: failInfrastructure abort after engine-detour tool failure must not
    // wash the durable toolResult diagnostic (same seam as reviewer-run / judge-run).
    resolveRunnerKnownFailure: async ({
      result,
      sessionFile,
    }: {
      result: { knownFailure?: import("../host-contracts.ts").RoleTurnKnownFailure };
      sessionFile: string;
    }) => {
      const infrastructureFailure = await readEngineDetourInfrastructureFailure(sessionFile);
      return infrastructureFailure === undefined
        ? result.knownFailure
        : {
            cause: infrastructureFailure.cause,
            diagnostic: infrastructureFailure.diagnostic,
            ...(infrastructureFailure.identity === undefined
              ? {}
              : { identity: infrastructureFailure.identity }),
          };
    },
    ...(options?.beforeDispatch === undefined
      ? {}
      : { beforeDispatch: options.beforeDispatch }),
  };
}

async function admitInstructionSeat(
  role: InstructionSeatRole,
  options: Parameters<typeof admitGatekeeperInvocation>[0],
): Promise<AdmittedInstructionSeatInvocation> {
  switch (role) {
    case "gatekeeper":
      return admitGatekeeperInvocation(options);
    case "navigator":
      return admitNavigatorInvocation(options);
    case "auditor":
      return admitAuditorInvocation(options);
  }
}

export async function runPublicInstructionSeatResume(
  request: PublicResumeRequest,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedInstructionSeatInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) => loadResumableInstructionSeatRun(
      env.home,
      effective.runId,
      env.principalAuthority,
    ),
    buildTurnRequest: async (admitted, effective) => {
      const summonsPrepared = await prepareSummonsResumeMaterials(
        admitted.runDirectory,
        effective.summons,
      );
      return buildInstructionSeatTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(
          admitted,
          effective,
          env,
          summonsPrepared,
        ),
      );
    },
    adapters: instructionSeatAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

/** Scope auditor subject/source-run env for the duration of one seat turn. */
async function withAuditorSoulEnv<
  T,
>(options: {
  readonly subject?: "judge" | "doctor";
  readonly sourceRunDirectory?: string;
  readonly run: () => Promise<T>;
}): Promise<T> {
  if (options.subject === undefined && options.sourceRunDirectory === undefined) {
    return options.run();
  }
  const { AK_ROLE_AUDITOR_SUBJECT_ENV, AK_ROLE_AUDITOR_SOURCE_RUN_ENV } = await import(
    "../auditor-soul.ts"
  );
  const priorSubject = process.env[AK_ROLE_AUDITOR_SUBJECT_ENV];
  const priorSource = process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV];
  if (options.subject !== undefined) {
    process.env[AK_ROLE_AUDITOR_SUBJECT_ENV] = options.subject;
  }
  if (options.sourceRunDirectory !== undefined) {
    process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV] = options.sourceRunDirectory;
  }
  try {
    return await options.run();
  } finally {
    if (options.subject !== undefined) {
      if (priorSubject === undefined) delete process.env[AK_ROLE_AUDITOR_SUBJECT_ENV];
      else process.env[AK_ROLE_AUDITOR_SUBJECT_ENV] = priorSubject;
    }
    if (options.sourceRunDirectory !== undefined) {
      if (priorSource === undefined) delete process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV];
      else process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV] = priorSource;
    }
  }
}

export async function runPublicInstructionSeat(
  argv: readonly string[],
  env: InstructionSeatRunEnv,
  io: CliIo,
  role: InstructionSeatRole,
  parseArgv: (args: readonly string[]) => ParseInstructionArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedInstructionSeatInvocation;
  terminal?: TerminalResult;
}> {
  let parsed: ParseInstructionArgvResult;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  let auditorSubject: "judge" | "doctor" | undefined;
  let auditorSourceRun: string | undefined;
  let auditorSourceTicket: number | undefined;

  // #637 / #747 / #771: resume prior seat run with this summons' materials.
  // Auditor (#747): parent --source-run path is the lookup key (typed inherit).
  // Other instruction seats: no mechanical ticket match against instruction text.
  // No bare catch→fresh.
  const projectRoot = parsed.project ?? env.cwd;
  if (role === "auditor") {
    if (parsed.subject !== "judge" && parsed.subject !== "doctor") {
      presentStructuralRejection(
        new CliUsageError("auditor --subject requires judge|doctor"),
        io,
      );
      return { exitCode: 2 };
    }
    auditorSubject = parsed.subject;
    const source = typeof parsed.sourceRun === "string" ? parsed.sourceRun.trim() : "";
    if (source === "") {
      presentStructuralRejection(
        new CliUsageError("auditor --source-run requires a run locator"),
        io,
      );
      return { exitCode: 2 };
    }
    try {
      const { resolveNotarySourceRunLocator } = await import("../notary-source-run.ts");
      const resolved = await resolveNotarySourceRunLocator({
        projectRoot,
        sourceRun: source,
        home: env.home,
      });
      auditorSourceRun = resolved.runDirectory;
      auditorSourceTicket = await readRunTicketNumber(resolved.runDirectory);
    } catch (error) {
      presentStructuralRejection(
        new CliUsageError(error instanceof Error ? error.message : String(error)),
        io,
      );
      return { exitCode: 2 };
    }
  }

  // #756/#786: auditor reask / verbatim submission body ride summons.instruction on resume.
  const resumeInstruction = env.reviewReask;
  const summons: SameTicketSummonsMaterials = {
    ...(resumeInstruction === undefined
      ? {
          instruction: parsed.instruction,
          instructionEmpty: parsed.instruction.trim() === "",
        }
      : { instruction: resumeInstruction, instructionEmpty: false }),
    attachmentPaths: parsed.attachmentPaths,
  };
  if (role === "auditor" && auditorSourceRun !== undefined) {
    const resumed = await withAuditorSoulEnv({
      ...(auditorSubject === undefined ? {} : { subject: auditorSubject }),
      sourceRunDirectory: auditorSourceRun,
      run: () =>
        tryResumeSameTicketSeatRun({
          home: env.home,
          projectRoot,
          role,
          parentRunPath: auditorSourceRun,
          freshSummons: env.freshSummons,
          summons,
          resume: (runId, materials) =>
            runPublicInstructionSeatResume(
              { runId, ...(materials === undefined ? {} : { summons: materials }) },
              env,
              io,
            ),
        }),
    });
    if (resumed !== undefined) return resumed;
    // Reask without a prior same-parent run cannot deliver the plain-language ask
    // on a fresh mint without inventing a second prompt path — fail loud (#753 / #756).
    if (env.reviewReask !== undefined) {
      presentStructuralRejection(
        new CliUsageError(
          "auditor review reask requires a prior same-parent run to resume",
        ),
        io,
      );
      return { exitCode: 2 };
    }
  }

  let admitted: AdmittedInstructionSeatInvocation;
  try {
    admitted = await admitInstructionSeat(role, {
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

  if (role === "auditor" && auditorSourceRun !== undefined) {
    await persistAdmittedSourceRunPath(admitted, auditorSourceRun);
  }

  return await withAuditorSoulEnv({
    ...(auditorSubject === undefined ? {} : { subject: auditorSubject }),
    ...(auditorSourceRun === undefined
      ? {}
      : { sourceRunDirectory: auditorSourceRun }),
    run: async () => {
      await markRunAdmitted(admitted, env.principalAuthority);

      const turnRequest = buildInstructionSeatTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(env.correlationId === undefined || env.correlationId.trim() === ""
          ? {}
          : { correlationId: env.correlationId }),
        continuation: {
          kind: "initial",
          prompt: buildInstructionTransportPrompt(
            admitted,
            engineSessionMaterialFromOptions({
              ...(env.engine === undefined ? {} : { engine: env.engine }),
              packageRoot: env.packageRoot,
            }),
          ),
        },
      });

      return await runPostAdmissionOneShot({
        admitted,
        env,
        io,
        request: turnRequest,
        adapters: instructionSeatAdapters({
          beforeDispatch: async (admittedSeat) => {
            // Auditor inherits source-run ticket (notary face) — typed, not prose match.
            if (auditorSourceTicket !== undefined) {
              await bindAdmittedTicketNumber(admittedSeat, auditorSourceTicket);
            }
          },
        }),
        ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
      });
    },
  });
}
