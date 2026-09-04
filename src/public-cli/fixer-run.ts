/**
 * Public Fixer Role run: admit → post-admission coordinator → settle Terminal result (#110 / #517).
 * #110/#177: package-owned diagnosing-bugs and tdd methods (available, not forced),
 * common Invocation + structural prerequisites, default apply / explicit plan,
 * shared #106 success interface. Controlled-failure settlement reuses #107.
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
  type PackagedMethodSkillMaterial,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitFixerInvocation,
  buildFixerTransportPrompt,
  type AdmittedFixerInvocation,
} from "./invocation.ts";
import {
  buildResumeContinuationPrompt,
  loadResumableFixerRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  hasLawfulFixerTerminalResult,
  presentStructuralRejection,
  trySettleFixerTerminalResult,
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
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";

export type FixerRunEnv = PostAdmissionEnv & {
  createRunId?: () => string;
};

function fixerMethods(packageRoot: string): readonly MethodBinding[] {
  return [
    { kind: "skill", path: resolvePackagedMethodSkillPath(packageRoot, "diagnosing-bugs") },
    { kind: "skill", path: resolvePackagedMethodSkillPath(packageRoot, "tdd") },
  ];
}

/** Project admitted Fixer invocation onto the host-neutral turn request. */
export function buildFixerTurnRequest(
  admitted: AdmittedFixerInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "fixer",
        phase: admitted.phase,
        packetPath: admitted.packetPath,
        ...(admitted.prerequisitesPath === undefined
          ? {}
          : { prerequisitesPath: admitted.prerequisitesPath }),
      },
      methods: fixerMethods(options.packageRoot),
    },
    options,
  );
}

function fixerAdapters(
  packageRoot: string,
  methodMaterial?: PackagedMethodSkillMaterial,
): PostAdmissionAdapters<AdmittedFixerInvocation> {
  return {
    trySettle: (admitted, authority) =>
      methodMaterial === undefined
        ? Promise.resolve(undefined)
        : trySettleFixerTerminalResult(admitted, authority, {
            methodProvenance: methodMaterial.provenance,
            methodSkillPath: methodMaterial.skillPath,
            methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
              packageRoot,
              "diagnosing-bugs",
            ),
          }),
    hasLawfulTerminalResult: (admitted, authority) => hasLawfulFixerTerminalResult(admitted, authority),
    isResumableRole: true,
  };
}

async function loadFixerMethodMaterial(
  packageRoot: string,
): Promise<PackagedMethodSkillMaterial> {
  return await loadPackagedMethodSkillMaterial(packageRoot, "diagnosing-bugs");
}

export async function runPublicFixer(
  argv: readonly string[],
  env: FixerRunEnv,
  io: CliIo,
  parseFixerArgv: (args: readonly string[]) => {
    phase: "plan" | "apply";
    instruction: string;
    attachmentPaths: string[];
    prerequisitesPath?: string;
    project?: string;
  },
): Promise<{
  exitCode: number;
  admitted?: AdmittedFixerInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedFixerInvocation;
  try {
    const parsed = parseFixerArgv(argv);
    admitted = await admitFixerInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      phase: parsed.phase,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.prerequisitesPath === undefined
        ? {}
        : { prerequisitesPath: parsed.prerequisitesPath }),
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

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadFixerMethodMaterial(env.packageRoot);
  } catch (error) {
    return (await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
      },
      fixerAdapters(env.packageRoot),
      env.principalAuthority,
      io,
    )) as { exitCode: number; admitted: AdmittedFixerInvocation; terminal: TerminalResult };
  }

  return await runPostAdmissionResumable({
    admitted,
    env,
    io,
    buildInitialRequest: () =>
      buildFixerTurnRequest(admitted, {
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
          prompt: buildFixerTransportPrompt(
            admitted,
            engineSessionMaterialFromOptions({
              ...(env.engine === undefined ? {} : { engine: env.engine }),
              packageRoot: env.packageRoot,
            }),
          ),
        },
      }),
    buildResumeRequest: () =>
      buildFixerTurnRequest(admitted, {
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
          prompt: buildResumeContinuationPrompt({
            packageRoot: env.packageRoot,
            ...(env.engine === undefined ? {} : { engine: env.engine }),
          }),
        },
      }),
    adapters: fixerAdapters(env.packageRoot, methodMaterial),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

/**
 * Resume a previously admitted Fixer Role run after a typed HTTP 429.
 * Restores role/phase/packet/prerequisites/session identity; model override is temporary.
 */
export async function runPublicFixerResume(
  request: PublicResumeRequest,
  env: FixerRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedFixerInvocation;
  terminal?: TerminalResult;
}> {
  let loaded;
  try {
    loaded = await loadResumableFixerRun(env.home, request.runId, env.principalAuthority);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  const { admitted } = loaded;

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadFixerMethodMaterial(env.packageRoot);
  } catch (error) {
    return (await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
      },
      fixerAdapters(env.packageRoot),
      env.principalAuthority,
      io,
    )) as { exitCode: number; admitted: AdmittedFixerInvocation; terminal: TerminalResult };
  }

  const turnRequest = buildFixerTurnRequest(
    admitted,
    resumeTurnRequestProjectionOptions(admitted, request, env),
  );

  return await runPostAdmissionManualResume({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: fixerAdapters(env.packageRoot, methodMaterial),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

export type { RoleTurnKnownFailure, PackagedMethodSkillProvenance };
