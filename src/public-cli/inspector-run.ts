/**
 * Public Inspector Role run: admit instruction/attachments → shared post-admission
 * coordinator → settle Terminal result (#568 / ADR 0074). Lawful releases:
 * pass/bounce/escalate. #633: manual resume continues the exact session. Dual path
 * with gate-province dispatch; this module is the direct command face.
 * #637: same-ticket re-summons resume the seat's previous run (no new run).
 */
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import { resolveInstructionTicket, resolveSeatTicketBinding } from "./seat-ticket-binding.ts";
import {
  admitInspectorInvocation,
  bindAdmittedTicketNumber,
  buildInspectorTransportPrompt,
  recordTrueUnboundTicketResolution,
  type AdmittedInspectorInvocation,
  type ParseInspectorArgvResult,
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
  loadResumableInspectorRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleInspectorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type InspectorRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildInspectorTurnRequest(
  admitted: AdmittedInspectorInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "inspector" as const,
      },
    },
    options,
  );
}

export async function runPublicInspector(
  argv: readonly string[],
  env: InspectorRunEnv,
  io: CliIo,
  parseInspectorArgv: (args: readonly string[]) => ParseInspectorArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedInspectorInvocation;
  terminal?: TerminalResult;
}> {
  let parsed: ParseInspectorArgvResult;
  try {
    parsed = parseInspectorArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  // #637: same ticket → resume prior inspector run before minting a new one.
  // Probe failures fall through; fresh path re-resolves so the failure face stays
  // on the admitted run (same as pre-#637 bind-before-mark).
  const projectRoot = parsed.project ?? env.cwd;
  let ticketResolution: Awaited<ReturnType<typeof resolveInstructionTicket>> | undefined;
  try {
    ticketResolution = await resolveInstructionTicket(
      parsed.instruction,
      projectRoot,
      env,
    );
    if (ticketResolution.kind === "ticket") {
      const previousRunId = await findLatestRunIdForSeatTicket({
        home: env.home,
        bookKey: resolveBookKeyFromGit(projectRoot),
        role: "inspector",
        ticketNumber: ticketResolution.ticketNumber,
      });
      if (previousRunId !== undefined) {
        return await runPublicInspectorResume({ runId: previousRunId }, env, io);
      }
    }
  } catch {
    ticketResolution = undefined;
  }

  let admitted: AdmittedInspectorInvocation;
  try {
    admitted = await admitInspectorInvocation({
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

  // #635: reuse successful probe; otherwise resolve before admitted mark.
  if (ticketResolution === undefined) {
    await resolveSeatTicketBinding(admitted, env);
  } else if (ticketResolution.kind === "ticket") {
    await bindAdmittedTicketNumber(admitted, ticketResolution.ticketNumber);
  } else {
    await recordTrueUnboundTicketResolution(admitted);
  }
  await markRunAdmitted(admitted, env.principalAuthority);

  const engineMaterial = engineSessionMaterialFromOptions({
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    packageRoot: env.packageRoot,
  });
  const turnRequest = buildInspectorTurnRequest(admitted, {
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
      prompt: buildInspectorTransportPrompt(admitted, engineMaterial),
    },
  });

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: inspectorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function inspectorAdapters(): PostAdmissionAdapters<AdmittedInspectorInvocation> {
  return {
    trySettle: (admitted, authority) => trySettleInspectorTerminalResult(admitted, authority),
    shouldPresentSettled: () => true,
  };
}

/**
 * Resume a previously admitted Inspector run (#633); the session principal reopens.
 */
export async function runPublicInspectorResume(
  request: PublicResumeRequest,
  env: InspectorRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedInspectorInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: () =>
      loadResumableInspectorRun(
      env.home,
      request.runId,
      env.principalAuthority,
    ),
    buildTurnRequest: (admitted) =>
      buildInspectorTurnRequest(
      admitted,
      resumeTurnRequestProjectionOptions(admitted, request, env),
    ),
    adapters: inspectorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
