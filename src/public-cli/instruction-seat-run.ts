/**
 * Shared instruction-seat run (#639 / #675): gatekeeper, navigator, auditor,
 * and evidence-child share admit → turn-request → post-admission → settle.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitAuditorInvocation,
  admitEvidenceChildInvocation,
  admitGatekeeperInvocation,
  admitNavigatorInvocation,
  buildInstructionTransportPrompt,
  type AdmittedAuditorInvocation,
  type AdmittedEvidenceChildInvocation,
  type AdmittedGatekeeperInvocation,
  type AdmittedNavigatorInvocation,
  type ParseInstructionArgvResult,
} from "./invocation.ts";
import {
  runPostAdmissionOneShot,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import {
  loadResumableInstructionSeatRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  readEngineDetourInfrastructureFailure,
  trySettleAuditorTerminalResult,
  trySettleEvidenceChildTerminalResult,
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
  | "auditor"
  | "evidence-child";

export type AdmittedInstructionSeatInvocation =
  | AdmittedGatekeeperInvocation
  | AdmittedNavigatorInvocation
  | AdmittedAuditorInvocation
  | AdmittedEvidenceChildInvocation;

export type InstructionSeatRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
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

function instructionSeatAdapters() {
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
          return trySettleAuditorTerminalResult(admitted, authority);
        case "evidence-child":
          return trySettleEvidenceChildTerminalResult(admitted, authority);
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
    case "evidence-child":
      return admitEvidenceChildInvocation(options);
  }
}

export async function runPublicInstructionSeatResume(
  request: PublicResumeRequest,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<{ exitCode: number; terminal?: TerminalResult }> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) => loadResumableInstructionSeatRun(
      env.home,
      effective.runId,
      env.principalAuthority,
    ),
    buildTurnRequest: (admitted, effective) => buildInstructionSeatTurnRequest(
      admitted,
      resumeTurnRequestProjectionOptions(admitted, effective, env),
    ),
    adapters: instructionSeatAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
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
  let admitted: AdmittedInstructionSeatInvocation;
  let auditorSubject: "judge" | "doctor" | undefined;
  let auditorSourceRun: string | undefined;
  try {
    const parsed = parseArgv(argv);
    if (role === "auditor") {
      // Subject is the audited-object input (#675 owner) — publish for soul loader.
      if (parsed.subject !== "judge" && parsed.subject !== "doctor") {
        throw new CliUsageError("auditor --subject requires judge|doctor");
      }
      auditorSubject = parsed.subject;
      // Source-run is the same input surface for direct and nested summons (#675).
      const source = typeof parsed.sourceRun === "string" ? parsed.sourceRun.trim() : "";
      if (source === "") {
        throw new CliUsageError("auditor --source-run requires a run locator");
      }
      // Resolve locator → absolute run directory once here (shared with notary path).
      const { resolveNotarySourceRunLocator } = await import("../notary-source-run.ts");
      const projectRoot = parsed.project ?? env.cwd;
      try {
        const resolved = await resolveNotarySourceRunLocator({
          projectRoot,
          sourceRun: source,
          home: env.home,
        });
        auditorSourceRun = resolved.runDirectory;
      } catch (error) {
        throw new CliUsageError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
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

  // Scope subject + source-run env to this auditor turn (same face for direct/nested).
  const { AK_ROLE_AUDITOR_SUBJECT_ENV, AK_ROLE_AUDITOR_SOURCE_RUN_ENV } = await import("../auditor-soul.ts");
  const priorSubject = process.env[AK_ROLE_AUDITOR_SUBJECT_ENV];
  const priorSource = process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV];
  if (auditorSubject !== undefined) {
    process.env[AK_ROLE_AUDITOR_SUBJECT_ENV] = auditorSubject;
  }
  if (auditorSourceRun !== undefined) {
    process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV] = auditorSourceRun;
  }
  try {
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
      adapters: instructionSeatAdapters(),
      ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
    });
  } finally {
    if (auditorSubject !== undefined) {
      if (priorSubject === undefined) delete process.env[AK_ROLE_AUDITOR_SUBJECT_ENV];
      else process.env[AK_ROLE_AUDITOR_SUBJECT_ENV] = priorSubject;
    }
    if (auditorSourceRun !== undefined) {
      if (priorSource === undefined) delete process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV];
      else process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV] = priorSource;
    }
  }
}
