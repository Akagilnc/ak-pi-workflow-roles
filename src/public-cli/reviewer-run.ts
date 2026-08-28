/**
 * Public Reviewer Role run: admit → explicit Internal
 * activate → settle Terminal result (#111).
 * Package-owned adapted code-review method is forced; users never submit
 * extra packets. Controlled-failure settlement reuses #107.
 */
import type { DurablePrincipalAuthority } from "../host-contracts.ts";
import { decodePiDurablePrincipal } from "../pi/durable-principal.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyEngineChildEnv } from "../engine-detour.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillMaterial,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import {
  clearReviewerDispatchRejection,
  runExplicitInternalActivation,
  type ExplicitInternalKnownFailure,
  type ExplicitInternalPiRunner,
  type ExplicitInternalPiResult,
} from "./explicit-internal.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitReviewerInvocation,
  buildReviewerTransportPrompt,
  type AdmittedReviewerInvocation
} from "./invocation.ts";
import {
  buildSeatModelCliArgs,
  type CredentialProviders,
  type SeatModelConfig,
} from "./config.ts";
import {
  missingCredentialPreDispatchFailure,
  postRunMissingCredentialFailure,
} from "./public-run-credentials.ts";
import {
  acquireRunWriterLease,
  clearTypedProviderHttpObservation,
  isV1ResumableFailure,
  loadResumableReviewerRun,
  markRunAdmitted,
  markRunResumable,
  markRunRunning,
  markRunTerminal,
  renderResumeCommand,
  type PublicResumeRequest,
  selectResumeContinuationPrompt,
  RunWriterLeaseHeldError,
  type RunWriterLease,
  type TypedProviderHttpObservation,
} from "./run-lifecycle.ts";
import { runWithAutoResumeLoop } from "./auto-resume.ts";
import {
  classifyPostAdmissionFailure,
  exitCodeForTerminalOutcome,
  formatCliDiagnostic,
  formatTerminalResult,
  hasLawfulReviewerTerminalResult,
  inspectJudgeSession,
  isLawfulTypedTerminalOutcome,
  presentFailureTerminal,
  presentStructuralRejection,
  resolveAuditedRunnerFailureResolution,
  resolveControlledFailureResumeObservation,
  controlledFailureInputFromResolution,
  explicitInternalKnownFailureClassificationInput,
  readEngineDetourInfrastructureFailure,
  settleFailureTerminalResult,
  trySettleReviewerTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";

export type ReviewerRunEnv = {
  home: string;
  principalAuthority: DurablePrincipalAuthority;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  model?: SeatModelConfig;
  /** Optional labor engine name (config→activation; session material + leg channel). */
  engine?: string;
  credentials?: CredentialProviders;
  createRunId?: () => string;
  /** #422: effective single-call auto-resume ceiling; undefined = package default (AUTO_RESUME_LIMIT). */
  autoResumeLimit?: number;
  extraPiArgs?: readonly string[];
  timeoutMs?: number;
};

/** Encode admitted ticketNumber as CLI argv for activation/resume (no defaults). */
function buildReviewerTicketNumberArgs(
  ticketNumber: number | undefined,
): string[] {
  return ticketNumber === undefined
    ? []
    : ["--ak-review-ticket-number", String(ticketNumber)];
}

/**
 * Build Internal activation extra-args for an admitted Reviewer run.
 * Package code-review Skill is forced via --skill; ambient home skills stay off.
 * Capabilities path is adapter-derived at admission — never a caller packet.
 */
export function buildReviewerActivationExtraArgs(
  admitted: AdmittedReviewerInvocation,
  options: {
    principalAuthority: DurablePrincipalAuthority;
    packageRoot: string;
    model?: SeatModelConfig;
    engine?: string;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const { sessionFile, sessionDirectory } = decodePiDurablePrincipal(options.principalAuthority, admitted.principal!);
  const prompt = buildReviewerTransportPrompt(
    admitted,
    engineSessionMaterialFromOptions(options),
  );
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "code-review",
  );
  const authorityRefArgs =
    admitted.authorityRefs.length === 0
      ? []
      : ["--ak-review-authority-refs", JSON.stringify([...admitted.authorityRefs])];
  const ticketNumberArgs = buildReviewerTicketNumberArgs(admitted.ticketNumber);
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    sessionFile,
    "--session-dir",
    sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "reviewer",
    "--ak-review-base",
    admitted.baseRevision,
    ...authorityRefArgs,
    ...ticketNumberArgs,
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
    prompt,
  ];
}

/**
 * Reopen the exact Reviewer Pi session for resume. Preserves fixed Reviewer base
 * and package code-review binding; never resubmits caller instruction as control.
 */
export function buildReviewerResumeActivationExtraArgs(
  admitted: AdmittedReviewerInvocation,
  options: {
    principalAuthority: DurablePrincipalAuthority;
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
    message?: string;
  },
): string[] {
  const { sessionFile, sessionDirectory } = decodePiDurablePrincipal(options.principalAuthority, admitted.principal!);
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "code-review",
  );
  const authorityRefArgs =
    admitted.authorityRefs.length === 0
      ? []
      : ["--ak-review-authority-refs", JSON.stringify([...admitted.authorityRefs])];
  const ticketNumberArgs = buildReviewerTicketNumberArgs(admitted.ticketNumber);
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    sessionFile,
    "--session-dir",
    sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "reviewer",
    "--ak-review-base",
    admitted.baseRevision,
    ...authorityRefArgs,
    ...ticketNumberArgs,
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
    selectResumeContinuationPrompt(options.message),
  ];
}

async function presentControlledFailure(
  admitted: AdmittedReviewerInvocation,
  failureInput: {
    timedOut: boolean;
    code: number | null;
    stderr: string;
    thrown?: unknown;
    knownFailure?: ExplicitInternalKnownFailure;
    typedHttpObservationSettled?: true;
    typedHttpObservation?: TypedProviderHttpObservation;
  },
  authority: DurablePrincipalAuthority,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedReviewerInvocation;
  terminal: TerminalResult;
}> {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const resumeObservation = await resolveControlledFailureResumeObservation({
    runDirectory: admitted.runDirectory,
    ...(failureInput.typedHttpObservationSettled === true
      ? {
        typedHttpObservationSettled: true as const,
        ...(failureInput.typedHttpObservation === undefined
          ? {}
          : { typedHttpObservation: failureInput.typedHttpObservation }),
      }
      : {}),
  });
  const knownFailure =
    failureInput.knownFailure ?? resumeObservation.observationReadFailure;
  const session =
    !hasThrown &&
    !failureInput.timedOut &&
    knownFailure === undefined
      ? await inspectJudgeSession(decodePiDurablePrincipal(authority, admitted.principal).sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...explicitInternalKnownFailureClassificationInput(knownFailure),
    ...(session === undefined ? {} : { session }),
  });

  const hasLawfulTerminalResult = await hasLawfulReviewerTerminalResult(admitted, authority);
  const typedHttp429 = resumeObservation.typedHttp429;
  const sessionPrincipalAvailable = await authority.isAvailable(admitted.principal!);
  const resumable =
    sessionPrincipalAvailable &&
    isV1ResumableFailure({
      hasLawfulTerminalResult,
      ...(typedHttp429 === undefined ? {} : { typedHttp429 }),
    });
  if (resumable && typedHttp429 !== undefined) {
    await markRunResumable(admitted.runDirectory, typedHttp429);
  } else {
    await markRunTerminal(admitted.runDirectory).catch(() => undefined);
  }

  const terminal = await settleFailureTerminalResult(
    admitted,
    failure,
    authority,
    resumable
      ? { resume: { command: renderResumeCommand(admitted.runId) } }
      : {},
  );
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal,
  };
}

async function dispatchAdmittedReviewer(input: {
  admitted: AdmittedReviewerInvocation;
  env: ReviewerRunEnv;
  io: CliIo;
  extraArgs: string[];
  lease: RunWriterLease;
  methodMaterial: PackagedMethodSkillMaterial;
  /**
   * Mechanical engine provenance for initial Reviewer dispatch only.
   * Explicit — never read from env.engine here, so resume cannot rewrite it.
   */
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted: AdmittedReviewerInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease, methodMaterial, effectiveEngine } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials,
    );
    if (missingCredential !== undefined) {
      return await presentControlledFailure(
        admitted,
        missingCredential,
        env.principalAuthority,
        io,
      );
    }
    await markRunRunning(admitted.runDirectory, env.model, effectiveEngine);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    await clearReviewerDispatchRejection(admitted.runDirectory);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory,
    };
    applyEngineChildEnv(childEnv, env.engine);
    const correlationId = admitted.correlationId ?? env.correlationId;
    if (correlationId !== undefined && correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = correlationId;
    }

    let result: ExplicitInternalPiResult;
    try {
      result = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs,
        cwd: admitted.projectRoot,
        home: env.home,
        agentDir: env.agentDir,
        env: childEnv,
        timeoutMs: env.timeoutMs,
        ...(env.piRunner === undefined ? {} : { runner: env.piRunner }),
      });
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
        },
        env.principalAuthority,
        io,
      );
    }

    try {
      await writeFile(
        join(admitted.runDirectory, "stderr.log"),
        result.stderr,
        "utf8",
      );
    } catch {
      // continue to lawful / controlled-failure settlement
    }

    let lawful: TerminalResult | undefined;
    try {
      lawful = await trySettleReviewerTerminalResult(admitted, env.principalAuthority, {
        methodProvenance: methodMaterial.provenance,
        methodSkillPath: methodMaterial.skillPath,
        methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
          env.packageRoot,
          "code-review",
        ),
      });
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: result.code,
          stderr: result.stderr,
          thrown: error,
        },
        env.principalAuthority,
        io,
      );
    }
    if (lawful !== undefined && isLawfulTypedTerminalOutcome(lawful.roleOutcome)) {
      await markRunTerminal(admitted.runDirectory).catch(() => undefined);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful,
      };
    }

    // Prefer engine-detour infrastructure failure already on the session principal
    // over a later secondary knownFailure / provider-stop after abort (#357 T2 / #378).
    const infrastructureFailure = await readEngineDetourInfrastructureFailure(
      decodePiDurablePrincipal(env.principalAuthority, admitted.principal).sessionFile,
    );
    const credentialFailure = postRunMissingCredentialFailure(
      result,
      env.model,
      env.credentials,
    );
    const resolution = await resolveAuditedRunnerFailureResolution({
      runner:
        infrastructureFailure === undefined
          ? result.knownFailure
          : {
              cause: infrastructureFailure.cause,
              diagnostic: infrastructureFailure.diagnostic,
              ...(infrastructureFailure.identity === undefined
                ? {}
                : { identity: infrastructureFailure.identity }),
            },
      sessionFile: decodePiDurablePrincipal(env.principalAuthority, admitted.principal).sessionFile,
      credential: credentialFailure,
      runDirectory: admitted.runDirectory,
    });
    return await presentControlledFailure(
      admitted,
      {
        timedOut: result.timedOut,
        code: result.code,
        stderr: result.stderr,
        ...controlledFailureInputFromResolution(resolution),
      },
      env.principalAuthority,
      io,
    );
  } finally {
    await lease.release();
  }
}

async function loadReviewerMethodMaterial(
  packageRoot: string,
): Promise<PackagedMethodSkillMaterial> {
  return await loadPackagedMethodSkillMaterial(packageRoot, "code-review");
}

export async function runPublicReviewer(
  argv: readonly string[],
  env: ReviewerRunEnv,
  io: CliIo,
  parseReviewerArgv: (args: readonly string[]) => {
    instruction: string;
    attachmentPaths: string[];
    baseRevision: string;
    authorityRefs: string[];
    project?: string;
  },
): Promise<{
  exitCode: number;
  admitted?: AdmittedReviewerInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedReviewerInvocation;
  try {
    const parsed = parseReviewerArgv(argv);
    admitted = await admitReviewerInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      baseRevision: parsed.baseRevision,
      authorityRefs: parsed.authorityRefs,
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
    methodMaterial = await loadReviewerMethodMaterial(env.packageRoot);
  } catch (error) {
    return await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
      },
      env.principalAuthority,
      io,
    );
  }

  return runWithAutoResumeLoop({
    admitted,
    principalAuthority: env.principalAuthority,
    io,
    // #422: pass-through only; the loop entry resolves the default and validates the domain once.
    autoResumeLimit: env.autoResumeLimit,
    buildInitialArgs: () =>
      buildReviewerActivationExtraArgs(admitted, {
        principalAuthority: env.principalAuthority,
        packageRoot: env.packageRoot,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
      }),
    buildResumeArgs: () =>
      buildReviewerResumeActivationExtraArgs(admitted, {
        principalAuthority: env.principalAuthority,
        packageRoot: env.packageRoot,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
      }),
    dispatch: (extraArgs, lease, isFirst, attemptIo) =>
      dispatchAdmittedReviewer({
        admitted,
        env: {
          ...env,
          ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
        },
        io: attemptIo,
        extraArgs,
        lease,
        methodMaterial,
        ...(isFirst && env.engine !== undefined ? { effectiveEngine: env.engine } : {}),
      }),
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
  let loaded;
  try {
    loaded = await loadResumableReviewerRun(env.home, request.runId, env.principalAuthority);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  const { admitted } = loaded;

  let lease: RunWriterLease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory, (diagnostic) => io.stderr(diagnostic));
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadReviewerMethodMaterial(env.packageRoot);
  } catch (error) {
    await lease.release();
    return await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
      },
      env.principalAuthority,
      io,
    );
  }

  const extraArgs = buildReviewerResumeActivationExtraArgs(admitted, {
        principalAuthority: env.principalAuthority,
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
    ...(request.message === undefined ? {} : { message: request.message }),
  });

  const result = await dispatchAdmittedReviewer({
    admitted,
    env: {
      ...env,
      ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
    },
    io,
    extraArgs,
    lease,
    methodMaterial,
  });
  if (result.terminal !== undefined) (result.terminal as { autoResumeCount?: number }).autoResumeCount = 0;
  return result;
}

export type { ExplicitInternalKnownFailure, PackagedMethodSkillProvenance };
