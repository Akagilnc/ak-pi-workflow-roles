/**
 * Public Reviewer Role run: admit → post-admission coordinator → settle Terminal result (#917 / #517).
 * Package-owned ak-cross-m-review method is forced; users never submit
 * extra packets. Controlled-failure settlement reuses #107.
 * #526: execution via RoleTurnHost; argv is Pi adapter internal.
 */
import { resolve } from "node:path";

import type {
  DurablePrincipalAuthority,
  MethodBinding,
  RoleTurnKnownFailure,
  RoleTurnRequest,
} from "../host-contracts.ts";
import {
  appendEngineSessionMaterial,
  engineSessionMaterialFromOptions,
  pickEngineAxis,
} from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillMaterial,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitReviewerInvocation,
  buildReviewerTransportPrompt,
  type AdmittedReviewerInvocation,
  type ReviewerLens,
} from "./invocation.ts";
import {
  loadResumableReviewerRun,
  markRunAdmitted,
  RESUME_TRANSPORT_ENVELOPE,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  readEngineDetourInfrastructureFailure,
  trySettleReviewerTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import {
  formatTerminalResult,
  isLawfulTypedTerminalOutcome,
  type TerminalResult,
} from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";
import {
  presentControlledFailure,
  resolveResumeMethodMaterialAdapters,
  runPostAdmissionResumable,
  runPostAdmissionSeatResume,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";

export type ReviewerRunEnv = PostAdmissionEnv & {
  createRunId?: () => string;
};

function reviewerMethods(packageRoot: string): readonly MethodBinding[] {
  return [{ kind: "skill", path: resolvePackagedMethodSkillPath(packageRoot, "ak-cross-m-review") }];
}

/** Project admitted Reviewer invocation onto the host-neutral turn request. */
export function buildReviewerTurnRequest(
  admitted: AdmittedReviewerInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "reviewer",
        baseRevision: admitted.baseRevision,
        lens: admitted.lens,
        authorityRefs: admitted.authorityRefs,
        ...(admitted.ticketNumber === undefined ? {} : { ticketNumber: admitted.ticketNumber }),
      },
      methods: reviewerMethods(options.packageRoot),
    },
    options,
  );
}

function reviewerAdapters(
  packageRoot: string,
  methodMaterial?: PackagedMethodSkillMaterial,
): PostAdmissionAdapters<AdmittedReviewerInvocation> {
  return {
    trySettle: (admitted, authority, scope) =>
      methodMaterial === undefined
        ? Promise.resolve(undefined)
        : trySettleReviewerTerminalResult(
            admitted,
            authority,
            {
              methodProvenance: methodMaterial.provenance,
              methodSkillPath: methodMaterial.skillPath,
              methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
                packageRoot,
                "ak-cross-m-review",
              ),
            },
            scope,
          ),
    resolveRunnerKnownFailure: async ({ result, sessionFile }) => {
      const infrastructureFailure = await readEngineDetourInfrastructureFailure(sessionFile);
      return infrastructureFailure === undefined
        ? result.knownFailure
        : {
            ...(infrastructureFailure.cause === undefined
              ? {}
              : { cause: infrastructureFailure.cause }),
            diagnostic: infrastructureFailure.diagnostic,
            ...(infrastructureFailure.identity === undefined
              ? {}
              : { identity: infrastructureFailure.identity }),
          };
    },
  };
}

async function loadReviewerMethodMaterial(
  packageRoot: string,
): Promise<PackagedMethodSkillMaterial> {
  return await loadPackagedMethodSkillMaterial(packageRoot, "ak-cross-m-review");
}

/** Continue the existing method turn; frozen axes remain on typed activation fields. */
function reviewerResumePrompt(env: ReviewerRunEnv, message?: string): string {
  const lines: string[] = [RESUME_TRANSPORT_ENVELOPE];
  if (message !== undefined) lines.push("", message);
  return appendEngineSessionMaterial(
    lines,
    engineSessionMaterialFromOptions({
      ...pickEngineAxis(env),
      packageRoot: env.packageRoot,
    }),
  ).join("\n");
}

export async function runPublicReviewer(
  argv: readonly string[],
  env: ReviewerRunEnv,
  io: CliIo,
  parseReviewerArgv: (args: readonly string[]) => {
    instruction: string;
    attachmentPaths: string[];
    baseRevision: string;
    lens?: ReviewerLens;
    authorityRefs: string[];
    project?: string;
  },
): Promise<{
  exitCode: number;
  admitted?: AdmittedReviewerInvocation;
  terminal?: TerminalResult;
}> {
  let parsed: ReturnType<typeof parseReviewerArgv>;
  try {
    parsed = parseReviewerArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  // Omitted public lens is the parallel two-axis branch mark; never admitted as a parent run.
  // Each leg reuses this call's public argv and only adds --lens (#946 / 10a).
  if (parsed.lens === undefined) {
    const { summonParallelReviewerLenses } = await import("../public-role-summons.ts");
    const children = await summonParallelReviewerLenses({
      argv,
      projectRoot: resolve(parsed.project ?? env.cwd),
      home: env.home,
      agentDir: env.agentDir,
      ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
      ...(env.model === undefined ? {} : { model: env.model }),
      ...(env.host === undefined ? {} : { host: env.host }),
      ...(env.engine === undefined ? {} : { engine: env.engine }),
      ...(env.engineModel === undefined ? {} : { engineModel: env.engineModel }),
      packageRoot: env.packageRoot,
      ...(env.signal === undefined ? {} : { signal: env.signal }),
      ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
      roleTurnHost: env.roleTurnHost,
      ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
      principalAuthority: env.principalAuthority,
      ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    });
    const childResults = [children.completeness, children.correctness] as const;
    const terminals = childResults
      .map((child) => child.terminal)
      .filter((terminal): terminal is TerminalResult => terminal !== undefined);
    // ADR 0052 / terminal.ts: lawful typed child terminals (accepted / no_receipt /
    // audit_escalation) are not batch failures. Child exitCode remains the live
    // surface for seal/infrastructure overlays that keep the original Terminal.
    // failedChildren counts only non-lawful/missing child Terminals; seal overlays
    // that flip exitCode while keeping lawful Terminals are a separate identity.
    const failedChildren = childResults.filter((child) =>
      child.terminal === undefined
      || !isLawfulTypedTerminalOutcome(child.terminal.roleOutcome)).length;
    const overlayExit = childResults.some((child) => child.exitCode !== 0);
    const failed = failedChildren > 0 || overlayExit;
    const overlayDiagnostics = [...new Set(
      childResults
        .map((child) => child.stderr)
        .filter((text): text is string => typeof text === "string" && text !== ""),
    )];
    const terminal: TerminalResult = {
      batch: "reviewer",
      roleOutcome: failed
        ? {
            kind: "failure",
            role: "reviewer",
            diagnostic: failedChildren > 0
              ? "Reviewer batch child failure"
              : (overlayDiagnostics[0] ?? "Reviewer batch infrastructure failure"),
            decisiveFacts: { failedChildren },
            payloads: terminals,
          }
        : { kind: "accepted", role: "reviewer", payloads: terminals },
      reviewerChildren: {
        ...(children.completeness.terminal === undefined ? {} : { completeness: children.completeness.terminal }),
        ...(children.correctness.terminal === undefined ? {} : { correctness: children.correctness.terminal }),
      },
      reviewerChildOutcomes: {
        completeness: { exitCode: children.completeness.exitCode, ...(children.completeness.stderr === undefined ? {} : { stderr: children.completeness.stderr }) },
        correctness: { exitCode: children.correctness.exitCode, ...(children.correctness.stderr === undefined ? {} : { stderr: children.correctness.stderr }) },
      },
      navigator: { disposition: "no-advice" },
      artifacts: terminals.flatMap((item) => item.artifacts),
    };
    io.stdout(formatTerminalResult(terminal));
    return { exitCode: failed ? 1 : 0, terminal };
  }

  let admitted: AdmittedReviewerInvocation;
  try {
    admitted = await admitReviewerInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      baseRevision: parsed.baseRevision,
      lens: parsed.lens,
      authorityRefs: parsed.authorityRefs,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
      ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
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
    methodMaterial = await loadReviewerMethodMaterial(env.packageRoot);
  } catch (error) {
    return (await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
      },
      reviewerAdapters(env.packageRoot),
      env.principalAuthority,
      io,
    )) as { exitCode: number; admitted: AdmittedReviewerInvocation; terminal: TerminalResult };
  }

  return await runPostAdmissionResumable({
    admitted,
    env,
    io,
    buildInitialRequest: () =>
      buildReviewerTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...pickEngineAxis(env),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        // Dual-lens sandbox only: turn runs in the ephemeral worktree while durable
        // projectRoot stays the caller project. Present only inside the dual-lens summon.
        ...(env.executionCwd === undefined ? {} : { cwd: env.executionCwd }),
        continuation: {
          kind: "initial",
          prompt: buildReviewerTransportPrompt(
            admitted,
            engineSessionMaterialFromOptions({
              ...pickEngineAxis(env),
              packageRoot: env.packageRoot,
            }),
          ),
        },
      }),
    buildResumeRequest: () =>
      buildReviewerTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...pickEngineAxis(env),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        // Same dual-lens summon still owns the sandbox for in-batch auto-resume.
        // Manual `ak-role resume` after the batch never sets executionCwd.
        ...(env.executionCwd === undefined ? {} : { cwd: env.executionCwd }),
        continuation: {
          kind: "resume",
          prompt: reviewerResumePrompt(env),
        },
      }),
    adapters: reviewerAdapters(env.packageRoot, methodMaterial),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

/**
 * Resume a previously admitted Reviewer Role run after a typed HTTP 429.
 * Restores task/base/session identity; model override is temporary.
 */
export async function runPublicReviewerResume(
  request: PublicResumeRequest,
  env: ReviewerRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedReviewerInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) =>
      loadResumableReviewerRun(env.home, effective.runId, env.principalAuthority),
    buildTurnRequest: (admitted, effective) => {
      const base = resumeTurnRequestProjectionOptions(admitted, effective, env);
      return buildReviewerTurnRequest(admitted, {
        ...base,
        continuation: {
          kind: "resume",
          prompt: reviewerResumePrompt(env, effective.message),
        },
      });
    },
    adapters: reviewerAdapters(env.packageRoot),
    afterAdmittedLoad: async (admitted) => {
      return resolveResumeMethodMaterialAdapters({
        admitted,
        authority: env.principalAuthority,
        io,
        loadMaterial: () => loadReviewerMethodMaterial(env.packageRoot),
        adaptersWith: (material) => reviewerAdapters(env.packageRoot, material),
        emptyAdapters: reviewerAdapters(env.packageRoot),
      });
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

export type { RoleTurnKnownFailure, PackagedMethodSkillProvenance };
