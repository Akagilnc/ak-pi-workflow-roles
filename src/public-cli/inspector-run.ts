/**
 * Public Inspector Role run: admit instruction/attachments → shared post-admission
 * coordinator → settle Terminal result (#568 / ADR 0074). Lawful releases:
 * pass/bounce/escalate. #633: manual resume continues the exact session. Dual path
 * with gate-province dispatch; this module is the direct command face.
 * #637: same-ticket re-summons resume the seat's previous run (no new run).
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  bindReusedTicketNumber,
  resolveKnownTicketNumber,
  tryResumeSameTicketSeatRun,
} from "./seat-ticket-binding.ts";
import {
  admitInspectorInvocation,
  buildInspectorTransportPrompt,
  type AdmittedInspectorInvocation,
  type ParseInspectorArgvResult,
} from "./invocation.ts";
import {
  prepareSummonsResumeMaterials,
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
  type SameTicketSummonsMaterials,
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

  // #637: same ticket → resume prior inspector run with this summons' materials.
  // #709: identity is reused from records this book already holds — no seat model call.
  // No bare catch→fresh: lookup/resume failures surface; only true absence mints new.
  const projectRoot = parsed.project ?? env.cwd;
  const reusedTicketNumber = await resolveKnownTicketNumber({
    instruction: parsed.instruction,
    projectRoot,
    home: env.home,
  });
  if (reusedTicketNumber !== undefined) {
    const summons: SameTicketSummonsMaterials = {
      instruction: parsed.instruction,
      instructionEmpty: parsed.instruction.trim() === "",
      attachmentPaths: parsed.attachmentPaths,
    };
    const resumed = await tryResumeSameTicketSeatRun({
      home: env.home,
      projectRoot,
      role: "inspector",
      ticketNumber: reusedTicketNumber,
      freshSummons: env.freshSummons,
      summons,
      resume: (runId, materials) =>
        runPublicInspectorResume(
          { runId, ...(materials === undefined ? {} : { summons: materials }) },
          env,
          io,
        ),
    });
    if (resumed !== undefined) return resumed;
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
    adapters: inspectorAdapters({
      beforeDispatch: async (admittedSeat) => {
        // #635/#709: bind the reused identity inside the controlled-failure boundary.
        await bindReusedTicketNumber(admittedSeat, reusedTicketNumber);
      },
    }),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function inspectorAdapters(options?: {
  beforeDispatch?: (
    admitted: AdmittedInspectorInvocation,
  ) => void | Promise<void>;
}): PostAdmissionAdapters<AdmittedInspectorInvocation> {
  return {
    trySettle: (admitted, authority, scope) => trySettleInspectorTerminalResult(admitted, authority, scope),
    shouldPresentSettled: () => true,
    ...(options?.beforeDispatch === undefined
      ? {}
      : { beforeDispatch: options.beforeDispatch }),
  };
}

/**
 * Resume a previously admitted Inspector run (#633 / #637); the session principal reopens.
 * Same-ticket summons deliver this turn's instruction + frozen attachments; manual
 * resume keeps package-envelope / caller-message semantics and birth attachments.
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
    load: (effective) =>
      loadResumableInspectorRun(
        env.home,
        effective.runId,
        env.principalAuthority,
      ),
    buildTurnRequest: async (admitted, effective) => {
      const summonsPrepared = await prepareSummonsResumeMaterials(
        admitted.runDirectory,
        effective.summons,
      );
      return buildInspectorTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(
          admitted,
          effective,
          env,
          summonsPrepared,
        ),
      );
    },
    adapters: inspectorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
