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

type ReviewerRunResult = {
  exitCode: number;
  admitted?: AdmittedReviewerInvocation;
  terminal?: TerminalResult;
};

function reviewerMethods(packageRoot: string): readonly MethodBinding[] {
  return [{ kind: "skill", path: resolvePackagedMethodSkillPath(packageRoot, "ak-cross-m-review") }];
}

/**
 * All Reviewer turns (explicit --lens, dual-lens child, resume) execute in a
 * fresh worktree of the source tree's current HEAD (#946 统一新副本). Dual-lens
 * summon already injects executionCwd; only mint when absent. Cleanup failure
 * is diagnostic only and does not flip the exit code. Mint failure propagates
 * so the caller can settle a controlled failure against the admitted run.
 */
async function runReviewerTurnInFreshCopy(
  env: ReviewerRunEnv,
  projectRoot: string,
  io: CliIo,
  body: (sandboxedEnv: ReviewerRunEnv) => Promise<ReviewerRunResult>,
): Promise<ReviewerRunResult> {
  if (env.executionCwd !== undefined) {
    return body(env);
  }
  const { withEphemeralReviewerWorktree } = await import("../public-role-summons.ts");
  return await withEphemeralReviewerWorktree({
    projectRoot,
    onCleanupDiagnostic: (diagnostic) => {
      io.stderr(`${diagnostic}\n`);
    },
    run: (executionCwd) => body({ ...env, executionCwd }),
  });
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
      // Replay argv under the same cwd the single-axis entry would see (10a).
      // Do not substitute the resolved project path — relative --project must
      // not be re-resolved against a shifted cwd.
      cwd: env.cwd,
      projectRoot: resolve(parsed.project ?? env.cwd),
      // Typed base from the public parse — precheck only; child argv stays verbatim.
      baseRevision: parsed.baseRevision,
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
      // Batch has no parent run and no own attendance; no-advice is affirmative
      // only (navigator-attendance.ts). Children carry their own navigator facts.
      navigator: {
        disposition: "unavailable",
        source: "unknown",
        reason: "Reviewer batch has no parent-run Navigator attendance",
      },
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

  // Fresh copy for this call (explicit --lens or dual-lens child with pre-set cwd).
  // Durable projectRoot stays the caller project; only the host turn uses the sandbox.
  try {
    return await runReviewerTurnInFreshCopy(env, admitted.projectRoot, io, async (sandboxedEnv) =>
      await runPostAdmissionResumable({
        admitted,
        env: sandboxedEnv,
        io,
        buildInitialRequest: () =>
          buildReviewerTurnRequest(admitted, {
            packageRoot: sandboxedEnv.packageRoot,
            home: sandboxedEnv.home,
            agentDir: sandboxedEnv.agentDir,
            ...(sandboxedEnv.model === undefined ? {} : { model: sandboxedEnv.model }),
            ...pickEngineAxis(sandboxedEnv),
            ...(sandboxedEnv.timeoutMs === undefined ? {} : { timeoutMs: sandboxedEnv.timeoutMs }),
            ...(admitted.correlationId === undefined && sandboxedEnv.correlationId === undefined
              ? {}
              : { correlationId: admitted.correlationId ?? sandboxedEnv.correlationId }),
            // Ephemeral worktree cwd; durable projectRoot stays on admitted caller project.
            ...(sandboxedEnv.executionCwd === undefined ? {} : { cwd: sandboxedEnv.executionCwd }),
            continuation: {
              kind: "initial",
              prompt: buildReviewerTransportPrompt(
                admitted,
                engineSessionMaterialFromOptions({
                  ...pickEngineAxis(sandboxedEnv),
                  packageRoot: sandboxedEnv.packageRoot,
                }),
              ),
            },
          }),
        buildResumeRequest: () =>
          buildReviewerTurnRequest(admitted, {
            packageRoot: sandboxedEnv.packageRoot,
            home: sandboxedEnv.home,
            agentDir: sandboxedEnv.agentDir,
            ...(sandboxedEnv.model === undefined ? {} : { model: sandboxedEnv.model }),
            ...pickEngineAxis(sandboxedEnv),
            ...(sandboxedEnv.timeoutMs === undefined ? {} : { timeoutMs: sandboxedEnv.timeoutMs }),
            ...(admitted.correlationId === undefined && sandboxedEnv.correlationId === undefined
              ? {}
              : { correlationId: admitted.correlationId ?? sandboxedEnv.correlationId }),
            // In-batch auto-resume keeps the same call's sandbox (dual-lens or single).
            ...(sandboxedEnv.executionCwd === undefined ? {} : { cwd: sandboxedEnv.executionCwd }),
            continuation: {
              kind: "resume",
              prompt: reviewerResumePrompt(sandboxedEnv),
            },
          }),
        adapters: reviewerAdapters(sandboxedEnv.packageRoot, methodMaterial),
        ...(sandboxedEnv.engine === undefined ? {} : { effectiveEngine: sandboxedEnv.engine }),
      }));
  } catch (error) {
    return (await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
      },
      reviewerAdapters(env.packageRoot, methodMaterial),
      env.principalAuthority,
      io,
    )) as ReviewerRunResult;
  }
}

/**
 * Resume a previously admitted Reviewer Role run after a typed HTTP 429.
 * Restores task/base/session identity; model override is temporary.
 * Execution always uses a fresh worktree of the source tree at resume time
 * (#946 统一新副本 / 10a) — no old worktree, no ownership record.
 * Fresh-copy mint reuses the coordinator's single pre-lease load via
 * afterAdmittedPrepare; does not pre-load outside the coordinator.
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
  // Call-local cell: afterAdmittedPrepare writes executionCwd; buildTurnRequest reads it.
  // Keeps the single-load coordinator contract — no preliminary load outside.
  const sandbox: { executionCwd?: string } = {
    ...(env.executionCwd === undefined ? {} : { executionCwd: env.executionCwd }),
  };
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) =>
      loadResumableReviewerRun(env.home, effective.runId, env.principalAuthority),
    buildTurnRequest: (admitted, effective) => {
      const activeEnv: ReviewerRunEnv = sandbox.executionCwd === undefined
        ? env
        : { ...env, executionCwd: sandbox.executionCwd };
      const base = resumeTurnRequestProjectionOptions(admitted, effective, activeEnv);
      return buildReviewerTurnRequest(admitted, {
        ...base,
        // Fresh copy at resume time; durable projectRoot unchanged.
        ...(sandbox.executionCwd === undefined ? {} : { cwd: sandbox.executionCwd }),
        continuation: {
          kind: "resume",
          prompt: effective.message ?? "",
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
    afterAdmittedPrepare: async (admitted) => {
      // Already sandboxed (in-batch auto-resume path) — nothing to mint.
      if (sandbox.executionCwd !== undefined) {
        return { env: { ...env, executionCwd: sandbox.executionCwd } };
      }
      const { openEphemeralReviewerWorktree } = await import("../public-role-summons.ts");
      const opened = await openEphemeralReviewerWorktree({
        projectRoot: admitted.projectRoot,
        onCleanupDiagnostic: (diagnostic) => {
          io.stderr(`${diagnostic}\n`);
        },
      });
      sandbox.executionCwd = opened.executionCwd;
      return {
        env: { ...env, executionCwd: opened.executionCwd },
        cleanup: opened.close,
      };
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

export type { RoleTurnKnownFailure, PackagedMethodSkillProvenance };
