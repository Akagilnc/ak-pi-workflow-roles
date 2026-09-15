/**
 * Public Secretariat (中书省) Role run: admit → 起居郎 typed identity → bind/relocate
 * → shared post-admission (dossier delivery) → settle (#924).
 * Instruction-seat face like Judge; nested countersign is role-tool driven.
 * Ticket identity reuses the court diarist seam (no prose regex; no second lifecycle).
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions, pickEngineAxis } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitSecretariatInvocation,
  bindAdmittedTicketNumber,
  buildSecretariatTransportPrompt,
  relocateAdmittedRunToTicket,
  type AdmittedSecretariatInvocation,
  type ParseSecretariatArgvResult,
} from "./invocation.ts";
import {
  invokeCourtDiarist,
  type CourtDiaristSummonEnv,
} from "./countersign-run.ts";
import {
  presentControlledFailure,
  runPostAdmissionOneShot,
  type PostAdmissionEnv,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";
import {
  loadResumableSecretariatRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleSecretariatTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type SecretariatRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildSecretariatTurnRequest(
  admitted: AdmittedSecretariatInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "secretariat" as const,
        ...(admitted.ticketNumber === undefined
          ? {}
          : { ticketNumber: admitted.ticketNumber }),
      },
    },
    options,
  );
}

function diaristEnv(env: SecretariatRunEnv): CourtDiaristSummonEnv {
  return {
    cwd: env.cwd,
    home: env.home,
    agentDir: env.agentDir,
    packageRoot: env.packageRoot,
    ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
    ...(env.signal === undefined ? {} : { signal: env.signal }),
    ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
  };
}

export async function runPublicSecretariat(
  argv: readonly string[],
  env: SecretariatRunEnv,
  io: CliIo,
  parseSecretariatArgv: (args: readonly string[]) => ParseSecretariatArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedSecretariatInvocation;
  terminal?: TerminalResult;
}> {
  let parsed: ParseSecretariatArgvResult;
  try {
    parsed = parseSecretariatArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  let admitted: AdmittedSecretariatInvocation;
  try {
    admitted = await admitSecretariatInvocation({
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

  // #924 G3 / ADR 0075 / 0081: ticket identity is 起居郎 typed assertion — never
  // prose regex. escalate / real station failure → controlled failure; lawful
  // true-unbound continues unbound (ADR 0075 真无票→无录; 第 0 条不拒收);
  // ticket → bind + relocate so post-admission can deliver 起居录.
  const outcome = await invokeCourtDiarist(
    {
      instruction: parsed.instruction,
      projectRoot: admitted.projectRoot,
      failureLabel: "secretariat unbound summons",
    },
    diaristEnv(env),
    io,
  );

  if (outcome.identity.kind === "escalate") {
    return await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: new Error(
          "court diarist station escalated (cannot identify court target)",
        ),
      },
      secretariatAdapters(),
      env.principalAuthority,
      io,
    );
  }

  if (outcome.failedWithoutEscalate !== undefined) {
    return await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: new Error(outcome.failedWithoutEscalate.diagnostic),
      },
      secretariatAdapters(),
      env.principalAuthority,
      io,
    );
  }

  if (outcome.identity.kind === "ticket") {
    try {
      await bindAdmittedTicketNumber(admitted, outcome.identity.ticketNumber);
      await relocateAdmittedRunToTicket(admitted, env.principalAuthority);
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
        },
        secretariatAdapters(),
        env.principalAuthority,
        io,
      );
    }
  }

  const turnRequest = buildSecretariatTurnRequest(admitted, {
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
      prompt: buildSecretariatTransportPrompt(
        admitted,
        engineSessionMaterialFromOptions({
          ...pickEngineAxis(env),
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
    adapters: secretariatAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function secretariatAdapters() {
  return {
    trySettle: (
      admitted: AdmittedSecretariatInvocation,
      authority: DurablePrincipalAuthority,
      scope?: { readonly courtAttemptId?: string },
    ) => trySettleSecretariatTerminalResult(admitted, authority, scope),
    shouldPresentSettled: () => true,
  };
}

/**
 * Resume a previously admitted Secretariat run (#599).
 */
export async function runPublicSecretariatResume(
  request: PublicResumeRequest,
  env: SecretariatRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedSecretariatInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) =>
      loadResumableSecretariatRun(
        env.home,
        effective.runId,
        env.principalAuthority,
      ),
    buildTurnRequest: (admitted, effective) =>
      buildSecretariatTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(admitted, effective, env),
      ),
    adapters: secretariatAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
