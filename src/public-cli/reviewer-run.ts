/**
 * Public Reviewer Role run: admit → explicit Internal
 * activate → settle Terminal result (#111).
 * Package-owned adapted code-review method is forced; users never submit
 * extra packets. Controlled-failure settlement reuses #107.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillMaterial,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import {
  runExplicitInternalActivation,
  type ExplicitInternalKnownFailure,
  type ExplicitInternalPiRunner,
  type ExplicitInternalPiResult,
} from "./explicit-internal.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitReviewerInvocation,
  buildReviewerTransportPrompt,
  type AdmittedReviewerInvocation,
} from "./invocation.ts";
import {
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
  isSessionPrincipalAvailable,
  isV1ResumableFailure,
  loadResumableReviewerRun,
  markRunAdmitted,
  markRunResumable,
  markRunRunning,
  markRunTerminal,
  readTypedHttp429Observation,
  renderResumeCommand,
  RESUME_TRANSPORT_ENVELOPE,
  RunWriterLeaseHeldError,
  type RunWriterLease,
} from "./run-lifecycle.ts";
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
  resolveAuditedRunnerKnownFailure,
  explicitInternalKnownFailureClassificationInput,
  settleFailureTerminalResult,
  trySettleReviewerTerminalResult,
  trySettleComplianceAuditIncompleteTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";

export type ReviewerRunEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  model?: SeatModelConfig;
  credentials?: CredentialProviders;
  createRunId?: () => string;
  extraPiArgs?: readonly string[];
  timeoutMs?: number;
};

function buildModelArgs(model: SeatModelConfig | undefined): string[] {
  if (model === undefined) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking,
  ];
}

/**
 * Build Internal activation extra-args for an admitted Reviewer run.
 * Package code-review Skill is forced via --skill; ambient home skills stay off.
 * Capabilities path is adapter-derived at admission — never a caller packet.
 */
export function buildReviewerActivationExtraArgs(
  admitted: AdmittedReviewerInvocation,
  options: {
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const prompt = buildReviewerTransportPrompt(admitted);
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "code-review",
  );
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "reviewer",
    "--ak-review-base",
    admitted.baseRevision,
    "--mode",
    "json",
    ...buildModelArgs(options.model),
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
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "code-review",
  );
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "reviewer",
    "--ak-review-base",
    admitted.baseRevision,
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    RESUME_TRANSPORT_ENVELOPE,
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
  },
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedReviewerInvocation;
  terminal: TerminalResult;
}> {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session =
    !hasThrown &&
    !failureInput.timedOut &&
    failureInput.knownFailure === undefined
      ? await inspectJudgeSession(admitted.sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...(session === undefined ? {} : { session }),
  });

  const hasLawfulTerminalResult = await hasLawfulReviewerTerminalResult(admitted);
  const typedHttp429 = await readTypedHttp429Observation(admitted.runDirectory);
  const sessionPrincipalAvailable = await isSessionPrincipalAvailable(
    admitted.sessionFile,
  );
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
}): Promise<{
  exitCode: number;
  admitted: AdmittedReviewerInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease, methodMaterial } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials,
    );
    if (missingCredential !== undefined) {
      return await presentControlledFailure(
        admitted,
        missingCredential,
        io,
      );
    }
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory,
    };
    if (env.correlationId !== undefined && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
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
      lawful = await trySettleReviewerTerminalResult(admitted, {
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

    const auditIncomplete = await trySettleComplianceAuditIncompleteTerminalResult(admitted);
    if (auditIncomplete !== undefined) {
      await markRunTerminal(admitted.runDirectory).catch(() => undefined);
      if (auditIncomplete.roleOutcome.kind === "failure") {
        presentFailureTerminal(auditIncomplete, io);
      } else {
        io.stdout(formatTerminalResult(auditIncomplete));
      }
      return {
        exitCode: exitCodeForTerminalOutcome(auditIncomplete.roleOutcome),
        admitted,
        terminal: auditIncomplete,
      };
    }

    const credentialFailure = postRunMissingCredentialFailure(
      result,
      env.model,
      env.credentials,
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result.knownFailure,
      sessionFile: admitted.sessionFile,
      credential: credentialFailure,
      runDirectory: admitted.runDirectory,
    });
    return await presentControlledFailure(
      admitted,
      {
        timedOut: result.timedOut,
        code: result.code,
        stderr: result.stderr,
        ...(knownFailure === undefined ? {} : { knownFailure }),
      },
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
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      baseRevision: parsed.baseRevision,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  await markRunAdmitted(admitted);

  let lease: RunWriterLease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
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
      io,
    );
  }

  const extraArgs = buildReviewerActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedReviewer({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial,
  });
}

/**
 * Resume a previously admitted Reviewer Role run after a typed HTTP 429.
 * Restores task/base/session identity; model override is temporary.
 */
export async function runPublicReviewerResume(
  argv: readonly string[],
  env: ReviewerRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedReviewerInvocation;
  terminal?: TerminalResult;
}> {
  const runId = argv[0];
  if (runId === undefined || runId.trim() === "" || runId.startsWith("-")) {
    presentStructuralRejection(
      new CliUsageError("usage: ak-role resume <runId>"),
      io,
    );
    return { exitCode: 2 };
  }
  if (argv.length > 1) {
    presentStructuralRejection(
      new CliUsageError("resume takes exactly one run id"),
      io,
    );
    return { exitCode: 2 };
  }

  let loaded;
  try {
    loaded = await loadResumableReviewerRun(env.home, runId);
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
    lease = await acquireRunWriterLease(admitted.runDirectory);
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
      io,
    );
  }

  const extraArgs = buildReviewerResumeActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedReviewer({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial,
  });
}

export type { ExplicitInternalKnownFailure, PackagedMethodSkillProvenance };
