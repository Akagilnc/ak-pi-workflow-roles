/**
 * Public Inspector Role run: admit instruction/attachments → shared post-admission
 * coordinator → settle Terminal result (#568 / ADR 0074). Lawful releases:
 * pass/bounce/escalate. #633: manual resume continues the exact session. Dual path
 * with gate-province dispatch; this module is the direct command face.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { rebindAdmittedToTicketSeatMemory } from "../ticket-seat-memory.ts";
import { CliUsageError } from "./cli-errors.ts";
import { resolveSeatTicketBinding } from "./seat-ticket-binding.ts";
import {
  admitInspectorInvocation,
  buildInspectorTransportPrompt,
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
  let admitted: AdmittedInspectorInvocation;
  try {
    const parsed = parseInspectorArgv(argv);
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

  // #635 seat self-ticket then #636 ticket+seat memory principal (before admitted mark).
  await resolveSeatTicketBinding(admitted, env);
  const memory = await rebindAdmittedToTicketSeatMemory({
    admitted,
    seat: "inspector",
    principalAuthority: env.principalAuthority,
  });
  await markRunAdmitted(admitted, env.principalAuthority);

  // Same ticket nest already present → native host resume (not a fresh initial).
  // Prompt stays the officer transport; only continuation kind flips (#636 / ADR 0079).
  const engineMaterial = engineSessionMaterialFromOptions({
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    packageRoot: env.packageRoot,
  });
  const continuation =
    memory?.resumed === true
      ? {
          kind: "resume" as const,
          prompt: buildInspectorTransportPrompt(admitted, engineMaterial),
        }
      : {
          kind: "initial" as const,
          prompt: buildInspectorTransportPrompt(admitted, engineMaterial),
        };

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
    continuation,
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
