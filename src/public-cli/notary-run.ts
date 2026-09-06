/**
 * Public Notary Role run: admit source-run locator → shared post-admission coordinator
 * → settle Terminal result (#448 / #517). Zero caller prompt/attachment. Lifecycle is
 * the shared post-admission seam; this module keeps only Notary adapters.
 * #637: same-ticket re-summons resume the seat's previous run (no new run).
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import {
  NotarySourceRunError,
  resolveNotarySourceRunLocator,
} from "../notary-source-run.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { readRunTicketNumber } from "../run-ticket-number.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitNotaryInvocation,
  buildNotaryTransportPrompt,
  type AdmittedNotaryInvocation,
  type ParseNotaryArgvResult,
} from "./invocation.ts";
import { tryResumeSameTicketSeatRun } from "./seat-ticket-binding.ts";
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
  type SameTicketSummonsMaterials,
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

  // #637: same ticket → resume prior notary run with this summons' source-run pointer.
  // Source-run structural failures stay usage rejections; lookup/resume failures surface
  // (no bare catch→fresh). Only true absence of a prior run mints new.
  const projectRoot = parsed.project ?? env.cwd;
  let source;
  try {
    source = await resolveNotarySourceRunLocator({
      projectRoot,
      sourceRun: parsed.sourceRun,
      home: env.home,
    });
  } catch (error) {
    if (error instanceof NotarySourceRunError) {
      presentStructuralRejection(new CliUsageError(error.message, { cause: error }), io);
      return { exitCode: 2 };
    }
    throw error;
  }
  const ticketNumber = await readRunTicketNumber(source.runDirectory);
  if (ticketNumber !== undefined) {
    const summons: SameTicketSummonsMaterials = {
      sourceRunPath: source.runDirectory,
      sourceRun: source,
    };
    const resumed = await tryResumeSameTicketSeatRun({
      home: env.home,
      projectRoot,
      role: "notary",
      ticketNumber,
      summons,
      resume: (runId, materials) =>
        runPublicNotaryResume(
          { runId, ...(materials === undefined ? {} : { summons: materials }) },
          env,
          io,
        ),
    });
    if (resumed !== undefined) return resumed;
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
 * Resume a previously admitted Notary run (#633 / #637). Manual resume restores
 * source-run from the durable admitted request. Same-ticket re-summons deliver
 * this turn's source-run activation pointer while reopening the same session.
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
    load: async () => {
      if (request.message !== undefined) {
        throw new CliUsageError(
          "notary rejects caller prompt/instruction; only zero caller-prompt continuation admitted",
        );
      }
      const loaded = await loadResumableNotaryRun(
        env.home,
        request.runId,
        env.principalAuthority,
      );
      const summons = request.summons;
      if (
        summons?.sourceRunPath !== undefined &&
        summons.sourceRun !== undefined
      ) {
        return {
          admitted: {
            ...loaded.admitted,
            sourceRunPath: summons.sourceRunPath,
            sourceRun: summons.sourceRun,
          },
        };
      }
      return loaded;
    },
    buildTurnRequest: (admitted) =>
      buildNotaryTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(admitted, request, env),
      ),
    adapters: notaryAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
