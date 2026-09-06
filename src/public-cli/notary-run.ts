/**
 * Public Notary Role run: admit source-run locator → shared post-admission coordinator
 * → settle Terminal result (#448 / #517). Zero caller prompt/attachment. Lifecycle is
 * the shared post-admission seam; this module keeps only Notary adapters.
 * #637: same-ticket re-summons resume the seat's previous run (no new run).
 */
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import {
  NotarySourceRunError,
  resolveNotarySourceRunLocator,
} from "../notary-source-run.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitNotaryInvocation,
  buildNotaryTransportPrompt,
  readTicketNumberFromSourceRun,
  type AdmittedNotaryInvocation,
  type ParseNotaryArgvResult,
} from "./invocation.ts";
import {
  runPostAdmissionOneShot,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";
import {
  findLatestRunIdForSeatTicket,
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
        // Ticket from source-run admitted form rides activation → flag → role read surface (#635).
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
  let parsed: ParseNotaryArgvResult;
  try {
    parsed = parseNotaryArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  // #637: same ticket → resume prior notary run before minting a new one.
  const projectRoot = parsed.project ?? env.cwd;
  try {
    const source = await resolveNotarySourceRunLocator({
      projectRoot,
      sourceRun: parsed.sourceRun,
      home: env.home,
    });
    const ticketNumber = await readTicketNumberFromSourceRun(source.runDirectory);
    if (ticketNumber !== undefined) {
      const previousRunId = await findLatestRunIdForSeatTicket({
        home: env.home,
        bookKey: resolveBookKeyFromGit(projectRoot),
        role: "notary",
        ticketNumber,
      });
      if (previousRunId !== undefined) {
        return await runPublicNotaryResume({ runId: previousRunId }, env, io);
      }
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    if (error instanceof NotarySourceRunError) {
      presentStructuralRejection(new CliUsageError(error.message, { cause: error }), io);
      return { exitCode: 2 };
    }
    throw error;
  }

  let admitted: AdmittedNotaryInvocation;
  try {
    admitted = await admitNotaryInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      sourceRun: parsed.sourceRun,
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

  const engineMaterial = engineSessionMaterialFromOptions({
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    packageRoot: env.packageRoot,
  });
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
      prompt: buildNotaryTransportPrompt(admitted, engineMaterial),
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
    buildTurnRequest: (admitted) => buildNotaryTurnRequest(
      admitted,
      resumeTurnRequestProjectionOptions(admitted, request, env),
    ),
    adapters: notaryAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
