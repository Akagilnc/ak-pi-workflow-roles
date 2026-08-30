/**
 * Public Coder Role run: admit → post-admission coordinator → settle Terminal result (#109 / #517).
 * #109: package-owned TDD method, default apply / explicit plan, shared #106 success interface.
 * #526: execution via RoleTurnHost; argv is Pi adapter internal.
 */
import type {
  DurablePrincipalAuthority,
  MethodBinding,
  RoleTurnKnownFailure,
  RoleTurnRequest,
} from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCoderInvocation,
  buildCoderTransportPrompt,
  type AdmittedCoderInvocation,
} from "./invocation.ts";
import {
  loadResumableCoderRun,
  markRunAdmitted,
  selectResumeContinuationPrompt,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  hasLawfulCoderTerminalResult,
  presentStructuralRejection,
  trySettleCoderTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";
import {
  presentControlledFailure,
  runPostAdmissionManualResume,
  runPostAdmissionResumable,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "./post-admission.ts";

export type CoderRunEnv = PostAdmissionEnv & {
  createRunId?: () => string;
};

function coderMethods(
  phase: string,
  packageRoot: string,
): readonly MethodBinding[] {
  return phase === "apply"
    ? [{ kind: "skill", path: resolvePackagedMethodSkillPath(packageRoot, "tdd") }]
    : [];
}

/** Project admitted Coder invocation onto the host-neutral turn request. */
export function buildCoderTurnRequest(
  admitted: AdmittedCoderInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "coder",
        phase: admitted.phase,
        taskPath: admitted.taskPath,
      },
      methods: coderMethods(admitted.phase, options.packageRoot),
    },
    options,
  );
}

function coderAdapters(
  methodProvenance?: PackagedMethodSkillProvenance,
): PostAdmissionAdapters<AdmittedCoderInvocation> {
  return {
    trySettle: (admitted, authority) =>
      trySettleCoderTerminalResult(admitted, authority, {
        ...(methodProvenance === undefined ? {} : { methodProvenance }),
      }),
    hasLawfulTerminalResult: (admitted, authority) => hasLawfulCoderTerminalResult(admitted, authority),
    isResumableRole: true,
  };
}

export async function runPublicCoder(
  argv: readonly string[],
  env: CoderRunEnv,
  io: CliIo,
  parseCoderArgv: (args: readonly string[]) => {
    phase: "plan" | "apply";
    instruction: string;
    attachmentPaths: string[];
    project?: string;
  },
): Promise<{
  exitCode: number;
  admitted?: AdmittedCoderInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedCoderInvocation;
  try {
    const parsed = parseCoderArgv(argv);
    admitted = await admitCoderInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      phase: parsed.phase,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
      ...(env.model === undefined ? {} : { model: env.model }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  await markRunAdmitted(admitted, env.principalAuthority);

  let methodProvenance: PackagedMethodSkillProvenance | undefined;
  if (admitted.phase === "apply") {
    try {
      const material = await loadPackagedMethodSkillMaterial(
        env.packageRoot,
        "tdd",
      );
      methodProvenance = material.provenance;
    } catch (error) {
      return (await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation",
        },
        coderAdapters(),
        env.principalAuthority,
        io,
      )) as { exitCode: number; admitted: AdmittedCoderInvocation; terminal: TerminalResult };
    }
  }

  return await runPostAdmissionResumable({
    admitted,
    env,
    io,
    buildInitialRequest: () =>
      buildCoderTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        continuation: {
          kind: "initial",
          prompt: buildCoderTransportPrompt(
            admitted,
            engineSessionMaterialFromOptions({
              ...(env.engine === undefined ? {} : { engine: env.engine }),
              packageRoot: env.packageRoot,
            }),
          ),
        },
      }),
    buildResumeRequest: () =>
      buildCoderTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        continuation: {
          kind: "resume",
          prompt: selectResumeContinuationPrompt(),
        },
      }),
    adapters: coderAdapters(methodProvenance),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

/**
 * Resume a previously admitted Coder Role run after a typed HTTP 429.
 * Restores role/phase/task/session identity; model override is temporary.
 */
export async function runPublicCoderResume(
  request: PublicResumeRequest,
  env: CoderRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCoderInvocation;
  terminal?: TerminalResult;
}> {
  let loaded;
  try {
    loaded = await loadResumableCoderRun(env.home, request.runId, env.principalAuthority);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  const { admitted } = loaded;

  let methodProvenance: PackagedMethodSkillProvenance | undefined;
  if (admitted.phase === "apply") {
    try {
      const material = await loadPackagedMethodSkillMaterial(
        env.packageRoot,
        "tdd",
      );
      methodProvenance = material.provenance;
    } catch (error) {
      return (await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation",
        },
        coderAdapters(),
        env.principalAuthority,
        io,
      )) as { exitCode: number; admitted: AdmittedCoderInvocation; terminal: TerminalResult };
    }
  }

  const turnRequest = buildCoderTurnRequest(admitted, {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(admitted.correlationId === undefined && env.correlationId === undefined
      ? {}
      : { correlationId: admitted.correlationId ?? env.correlationId }),
    continuation: {
      kind: "resume",
      prompt: selectResumeContinuationPrompt(request.message),
    },
  });

  return await runPostAdmissionManualResume({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: coderAdapters(methodProvenance),
  });
}

// Re-export for tests that assert typed credential failure channel shape.
export type { RoleTurnKnownFailure, PackagedMethodSkillProvenance };
