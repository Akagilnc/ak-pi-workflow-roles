/**
 * Public Notary Role run: admit source-run locator → shared post-admission coordinator
 * → settle Terminal result (#448 / #517). Zero caller prompt/attachment. Lifecycle is
 * the shared post-admission seam; this module keeps only Notary adapters.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitNotaryInvocation,
  buildNotaryTransportPrompt,
  type AdmittedNotaryInvocation,
  type ParseNotaryArgvResult
} from "./invocation.ts";
import {
  runPostAdmissionOneShot,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";
import {
  loadResumableNotaryRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleNotaryTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type NotaryRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildNotaryTurnRequest(
  admitted: AdmittedNotaryInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "notary" as const,
        sourceRun: admitted.sourceRunPath,
        // Admitted --ticket rides activation → flag → role read surface (ADR 0075).
        ...(admitted.ticketNumber === undefined
          ? {}
          : { ticketNumber: admitted.ticketNumber }),
      },
    },
    options,
  );
}

export async function runPublicNotary(
  argv: readonly string[],
  env: NotaryRunEnv,
  io: CliIo,
  parseNotaryArgv: (args: readonly string[]) => ParseNotaryArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedNotaryInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedNotaryInvocation;
  try {
    const parsed = parseNotaryArgv(argv);
    admitted = await admitNotaryInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      sourceRun: parsed.sourceRun,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.ticket === undefined ? {} : { ticket: parsed.ticket }),
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

  const turnRequest = buildNotaryTurnRequest(admitted, {
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
      prompt: buildNotaryTransportPrompt(admitted, engineSessionMaterialFromOptions({ ...(env.engine === undefined ? {} : { engine: env.engine }), packageRoot: env.packageRoot })),
    },
  });

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: notaryAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function notaryAdapters(): PostAdmissionAdapters<AdmittedNotaryInvocation> {
  return {
    trySettle: (admitted, authority) => trySettleNotaryTerminalResult(admitted, authority),
    // Accepted receipts and failure terminals both present via shared path.
    shouldPresentSettled: () => true,
  };
}

/**
 * Resume a previously admitted Notary run (#633). Source-run locator restores
 * from the durable admitted request (never re-resolved); the session principal reopens.
 */
export async function runPublicNotaryResume(
  request: PublicResumeRequest,
  env: NotaryRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedNotaryInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: () => {
      if (request.message !== undefined) {
        throw new CliUsageError(
          "notary rejects caller prompt/instruction; only zero caller-prompt continuation admitted",
        );
      }
      return loadResumableNotaryRun(
        env.home,
        request.runId,
        env.principalAuthority,
      );
    },
    buildTurnRequest: (admitted) => {
      const { message: _omitted, ...safeRequest } = request;
      return buildNotaryTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(
          admitted,
          safeRequest,
          env,
        ),
      );
    },
    adapters: notaryAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
