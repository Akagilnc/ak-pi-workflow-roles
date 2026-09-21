/**
 * One public role run: admit → turn request → post-admission → settle.
 * Seat differences are composition-root fields. An omitted reviewer lens
 * starts two ordinary single-axis runs here. Countersign deferred identity
 * stays on its own run module.
 */
import { resolve } from "node:path";

import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { readBoardTicketNumber } from "../run-ticket-number.ts";
import { NotarySourceRunError, resolveNotarySourceRunLocator } from "../notary-source-run.ts";
import { engineSessionMaterialFromOptions, pickEngineAxis } from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  type PackagedMethodSkillMaterial,
} from "../package-resources/method-skill.ts";
import type { PackagedRole } from "../packaged-role-registry.ts";
import { packagedRoleMetadata } from "../packaged-role-registry.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitPublicRole,
  bindAdmittedTicketNumber,
  buildGleanerLeftTransportPrompt,
  buildInstructionTransportPrompt,
  buildNotaryTransportPrompt,
  buildReviewerTransportPrompt,
  persistAdmittedSourceRunPath,
  recordAdmittedCorrelation,
  relocateAdmittedRunToTicket,
  type AdmittedRoleInvocation,
  type PublicSeatParse,
} from "./invocation.ts";
import {
  presentControlledFailure,
  prepareSummonsResumeMaterials,
  resolveResumeMethodMaterialAdapters,
  roleTurnOptions,
  runPostAdmissionOneShot,
  runPostAdmissionResumable,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import {
  buildAutoResumeContinuationPrompt,
  loadResumablePublicRole,
  markRunAdmitted,
  peekRoleRunRole,
  parentRunPathFromGatePointerInstruction,
  type PublicResumeRequest,
  type RunWriterLease,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import { tryResumeSameTicketSeatRun } from "./seat-ticket-binding.ts";
import {
  presentStructuralRejection,
  seatKnownFailureResolver,
  trySettlePublicSeat,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import {
  formatTerminalResult,
  isLawfulTypedTerminalOutcome,
  type TerminalResult,
} from "./terminal.ts";
import {
  admittedSeatTurnDetails,
  packagedSettleSkill,
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";
import { runPublicCountersign, runPublicCountersignResume } from "./countersign-run.ts";

export type InstructionSeatRunEnv = PostAdmissionEnv & {
  reviewReask?: string;
  gateReviewInstruction?: string;
};

type SeatRunResult = {
  exitCode: number;
  admitted?: AdmittedRoleInvocation;
  terminal?: TerminalResult;
};

function roleRecord(role: PackagedRole) {
  const record = packagedRoleMetadata(role);
  if (record === undefined) {
    throw new CliUsageError(`unknown role: ${role}`);
  }
  return record;
}

/** Project any admitted public role onto the host-neutral turn request. */
export function buildInstructionSeatTurnRequest(
  admitted: AdmittedRoleInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    admittedSeatTurnDetails(admitted, options.packageRoot),
    options,
  );
}

function initialPrompt(
  admitted: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
): string {
  const reask = env.reviewReask ?? env.gateReviewInstruction;
  if (
    reask !== undefined
    && (admitted.role === "auditor" || admitted.role === "inspector" || admitted.role === "notary")
  ) {
    return reask;
  }
  const material = engineSessionMaterialFromOptions({
    ...pickEngineAxis(env),
    packageRoot: env.packageRoot,
  });
  if (admitted.role === "notary") return buildNotaryTransportPrompt(admitted, material);
  if (admitted.role === "gleaner-left") return buildGleanerLeftTransportPrompt(admitted, material);
  if (admitted.role === "reviewer") return buildReviewerTransportPrompt(admitted, material);
  return buildInstructionTransportPrompt(admitted, material);
}

function hostTurnCwd(env: InstructionSeatRunEnv): { readonly cwd: string } | undefined {
  return env.executionCwd === undefined ? undefined : { cwd: env.executionCwd };
}

function wantsFreshExecutionCopy(role: PackagedRole): boolean {
  const record = roleRecord(role);
  return "freshExecutionCopy" in record && record.freshExecutionCopy === true;
}

function infraFailure(role: PackagedRole) {
  const resolveRunnerKnownFailure = seatKnownFailureResolver(role);
  return resolveRunnerKnownFailure === undefined ? {} : { resolveRunnerKnownFailure };
}

async function bindAndRelocateDiarist(
  admitted: AdmittedRoleInvocation & { role: "diarist" },
  authority: DurablePrincipalAuthority,
  lease?: RunWriterLease,
): Promise<void> {
  const boardTicket = await readBoardTicketNumber(admitted.runDirectory);
  if (boardTicket === undefined) return;
  if (admitted.ticketNumber === undefined) {
    await bindAdmittedTicketNumber(admitted, boardTicket);
  }
  await relocateAdmittedRunToTicket(admitted, authority, lease);
}

function seatAdapters(
  admitted: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
  material?: PackagedMethodSkillMaterial,
): PostAdmissionAdapters<AdmittedRoleInvocation> {
  const record = roleRecord(admitted.role);
  const present = "presentSettled" in record ? record.presentSettled : "default";
  return {
    trySettle: (seat, authority, scope) =>
      trySettlePublicSeat(seat, authority, scope, material, env.packageRoot),
    ...(present === "always" ? { shouldPresentSettled: () => true } : {}),
    ...(present === "typed"
      ? { shouldPresentSettled: (terminal: TerminalResult) => isLawfulTypedTerminalOutcome(terminal.roleOutcome) }
      : {}),
    ...infraFailure(admitted.role),
    ...(admitted.role === "diarist"
      ? {
        beforeDispatch: async (seat: AdmittedRoleInvocation, lease?: RunWriterLease) => {
          if (seat.role !== "diarist") return;
          if (env.correlationId !== undefined && env.correlationId.trim() !== "") {
            await recordAdmittedCorrelation(seat, env.correlationId);
          }
          await bindAndRelocateDiarist(seat, env.principalAuthority, lease);
        },
        afterDispatch: async (seat: AdmittedRoleInvocation, lease?: RunWriterLease) => {
          if (seat.role !== "diarist") return;
          await bindAndRelocateDiarist(seat, env.principalAuthority, lease);
        },
      }
      : {}),
  };
}

function usageExit(error: unknown, io: CliIo): SeatRunResult | undefined {
  if (error instanceof CliUsageError) {
    presentStructuralRejection(error, io);
    return { exitCode: 2 };
  }
  return undefined;
}

async function withAuditorSoulEnv<T>(options: {
  readonly subject?: "judge" | "doctor";
  readonly sourceRunDirectory?: string;
  readonly run: () => Promise<T>;
}): Promise<T> {
  if (options.subject === undefined && options.sourceRunDirectory === undefined) {
    return options.run();
  }
  const { AK_ROLE_AUDITOR_SUBJECT_ENV, AK_ROLE_AUDITOR_SOURCE_RUN_ENV } = await import("../auditor-soul.ts");
  const priorSubject = process.env[AK_ROLE_AUDITOR_SUBJECT_ENV];
  const priorSource = process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV];
  if (options.subject !== undefined) process.env[AK_ROLE_AUDITOR_SUBJECT_ENV] = options.subject;
  if (options.sourceRunDirectory !== undefined) {
    process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV] = options.sourceRunDirectory;
  }
  try {
    return await options.run();
  } finally {
    if (options.subject !== undefined) {
      if (priorSubject === undefined) delete process.env[AK_ROLE_AUDITOR_SUBJECT_ENV];
      else process.env[AK_ROLE_AUDITOR_SUBJECT_ENV] = priorSubject;
    }
    if (options.sourceRunDirectory !== undefined) {
      if (priorSource === undefined) delete process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV];
      else process.env[AK_ROLE_AUDITOR_SOURCE_RUN_ENV] = priorSource;
    }
  }
}

async function dispatchAdmitted(
  admitted: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult> {
  const record = roleRecord(admitted.role);
  let material: PackagedMethodSkillMaterial | undefined;
  const skill = packagedSettleSkill(admitted);
  if (skill !== undefined) {
    try {
      material = await loadPackagedMethodSkillMaterial(env.packageRoot, skill);
    } catch (error) {
      const knownCause = admitted.role === "coder" || admitted.role === "merger" ? "activation" as const : undefined;
      return await presentControlledFailure(admitted, {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
        ...(knownCause === undefined ? {} : { knownCause }),
      }, seatAdapters(admitted, env), env.principalAuthority, io) as SeatRunResult;
    }
  }
  const adapters = seatAdapters(admitted, env, material);
  const execute = async (activeEnv: InstructionSeatRunEnv): Promise<SeatRunResult> => {
    const auto = "inCallAutoResume" in record && record.inCallAutoResume === true;
    const cwd = hostTurnCwd(activeEnv);
    if (auto) {
      return await runPostAdmissionResumable({
        admitted,
        env: activeEnv,
        io,
        buildInitialRequest: () => buildInstructionSeatTurnRequest(
          admitted,
          roleTurnOptions(activeEnv, admitted, { kind: "initial", prompt: initialPrompt(admitted, activeEnv) }, cwd),
        ),
        buildResumeRequest: () => buildInstructionSeatTurnRequest(
          admitted,
          roleTurnOptions(activeEnv, admitted, {
            kind: "resume",
            prompt: buildAutoResumeContinuationPrompt({
              packageRoot: activeEnv.packageRoot,
              ...pickEngineAxis(activeEnv),
            }),
          }, cwd),
        ),
        adapters,
        ...(activeEnv.engine === undefined ? {} : { effectiveEngine: activeEnv.engine }),
      });
    }
    return await runPostAdmissionOneShot({
      admitted,
      env: activeEnv,
      io,
      request: buildInstructionSeatTurnRequest(
        admitted,
        roleTurnOptions(activeEnv, admitted, { kind: "initial", prompt: initialPrompt(admitted, activeEnv) }, cwd),
      ),
      adapters,
      ...(activeEnv.engine === undefined ? {} : { effectiveEngine: activeEnv.engine }),
    });
  };
  if (!wantsFreshExecutionCopy(admitted.role)) return execute(env);
  try {
    if (env.executionCwd !== undefined) return await execute(env);
    const { withEphemeralReviewerWorktree } = await import("../public-role-summons.ts");
    return await withEphemeralReviewerWorktree({
      projectRoot: admitted.projectRoot,
      onCleanupDiagnostic: (diagnostic) => {
        io.stderr(`${diagnostic}\n`);
      },
      run: (executionCwd) => execute({ ...env, executionCwd }),
    });
  } catch (error) {
    return await presentControlledFailure(admitted, {
      timedOut: false,
      code: null,
      stderr: "",
      thrown: error,
    }, adapters, env.principalAuthority, io) as SeatRunResult;
  }
}

/**
 * Omitted lens on a parallel-lens seat: two ordinary single-axis runs, no parent run.
 * Each leg reuses this call's argv and only adds `--lens`.
 */
async function runOmittedLensBatch(
  argv: readonly string[],
  parsed: PublicSeatParse,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult> {
  const { summonParallelReviewerLenses } = await import("../public-role-summons.ts");
  const children = await summonParallelReviewerLenses({
    argv,
    cwd: env.cwd,
    projectRoot: resolve(parsed.project ?? env.cwd),
    baseRevision: parsed.baseRevision ?? "",
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

export async function runPublicInstructionSeat(
  argv: readonly string[],
  env: InstructionSeatRunEnv,
  io: CliIo,
  role: PackagedRole,
  parseArgv: (args: readonly string[]) => PublicSeatParse,
): Promise<SeatRunResult> {
  const record = roleRecord(role);
  if (record.admission === "countersign") {
    return runPublicCountersign(argv, env, io, parseArgv);
  }

  let parsed: PublicSeatParse;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    const rejected = usageExit(error, io);
    if (rejected !== undefined) return rejected;
    throw error;
  }

  if ("parallelLenses" in record && record.parallelLenses === true) {
    if (parsed.baseRevision === undefined) {
      presentStructuralRejection(new CliUsageError("reviewer requires --base"), io);
      return { exitCode: 2 };
    }
    if (parsed.lens === undefined) {
      return runOmittedLensBatch(argv, parsed, env, io);
    }
  }

  const projectRoot = parsed.project ?? env.cwd;
  let auditorSubject: "judge" | "doctor" | undefined;
  let auditorSource: string | undefined;
  let auditorTicket: number | undefined;
  if (record.sameParent === "auditor") {
    if (parsed.subject !== "judge" && parsed.subject !== "doctor") {
      presentStructuralRejection(new CliUsageError("auditor --subject requires judge|doctor"), io);
      return { exitCode: 2 };
    }
    auditorSubject = parsed.subject;
    const source = typeof parsed.sourceRun === "string" ? parsed.sourceRun.trim() : "";
    if (source === "") {
      presentStructuralRejection(new CliUsageError("auditor --source-run requires a run locator"), io);
      return { exitCode: 2 };
    }
    try {
      const resolved = await resolveNotarySourceRunLocator({ projectRoot, sourceRun: source, home: env.home });
      auditorSource = resolved.runDirectory;
      auditorTicket = await readBoardTicketNumber(resolved.runDirectory);
    } catch (error) {
      presentStructuralRejection(new CliUsageError(error instanceof Error ? error.message : String(error)), io);
      return { exitCode: 2 };
    }
    if (auditorSource === undefined) return { exitCode: 2 };
    const sourceDirectory = auditorSource;
    const resumeInstruction = env.reviewReask ?? env.gateReviewInstruction;
    const summons: SameTicketSummonsMaterials = {
      ...(resumeInstruction === undefined
        ? { instruction: parsed.instruction ?? "", instructionEmpty: (parsed.instruction ?? "").trim() === "" }
        : { instruction: resumeInstruction, instructionEmpty: false }),
      attachmentPaths: parsed.attachmentPaths ?? [],
    };
    const resumed = await withAuditorSoulEnv({
      subject: auditorSubject,
      sourceRunDirectory: auditorSource,
      run: () => tryResumeSameTicketSeatRun({
        home: env.home,
        projectRoot,
        role,
        parentRunPath: sourceDirectory,
        freshSummons: env.freshSummons,
        summons,
        resume: (runId, materials) => runPublicInstructionSeatResume(
          { runId, ...(materials === undefined ? {} : { summons: materials }) },
          env,
          io,
        ),
      }),
    });
    if (resumed != null) return resumed;
  }

  if (record.sameParent === "inspector") {
    const parentRunPath = parentRunPathFromGatePointerInstruction(parsed.instruction ?? "");
    if (parentRunPath !== undefined) {
      const resumeInstruction = env.reviewReask ?? env.gateReviewInstruction;
      const summons: SameTicketSummonsMaterials = {
        sourceRunPath: parentRunPath,
        ...(resumeInstruction === undefined
          ? { instruction: parsed.instruction ?? "", instructionEmpty: (parsed.instruction ?? "").trim() === "" }
          : { instruction: resumeInstruction, instructionEmpty: false }),
        attachmentPaths: parsed.attachmentPaths ?? [],
      };
      const resumed = await tryResumeSameTicketSeatRun({
        home: env.home,
        projectRoot,
        role,
        parentRunPath,
        freshSummons: env.freshSummons,
        summons,
        resume: (runId, materials) => runPublicInstructionSeatResume(
          { runId, ...(materials === undefined ? {} : { summons: materials }) },
          env,
          io,
        ),
      });
      if (resumed != null) return resumed;
    }
  }

  if (record.sameParent === "notary") {
    let source;
    try {
      source = await resolveNotarySourceRunLocator({
        projectRoot,
        sourceRun: parsed.sourceRun ?? "",
        home: env.home,
      });
    } catch (error) {
      if (error instanceof NotarySourceRunError) {
        presentStructuralRejection(new CliUsageError(error.message, { cause: error }), io);
        return { exitCode: 2 };
      }
      throw error;
    }
    const resumeInstruction = env.reviewReask ?? env.gateReviewInstruction;
    const summons: SameTicketSummonsMaterials = {
      sourceRunPath: source.runDirectory,
      sourceRun: source,
      ...(resumeInstruction === undefined ? {} : { instruction: resumeInstruction, instructionEmpty: false }),
    };
    const resumed = await tryResumeSameTicketSeatRun({
      home: env.home,
      projectRoot,
      role,
      parentRunPath: source.runDirectory,
      freshSummons: env.freshSummons,
      summons,
      resume: (runId, materials) => runPublicInstructionSeatResume(
        { runId, ...(materials === undefined ? {} : { summons: materials }) },
        env,
        io,
      ),
    });
    if (resumed != null) return resumed;
  }

  let admitted: AdmittedRoleInvocation;
  try {
    admitted = await admitPublicRole(
      role,
      parsed,
      env,
      auditorTicket === undefined ? undefined : { assertedTicketNumber: auditorTicket },
    );
  } catch (error) {
    const rejected = usageExit(error, io);
    if (rejected !== undefined) return rejected;
    throw error;
  }

  if (record.sameParent === "inspector") {
    const parentRunPath = parentRunPathFromGatePointerInstruction(parsed.instruction ?? "");
    if (parentRunPath !== undefined && admitted.role === "inspector") {
      await persistAdmittedSourceRunPath(admitted, parentRunPath);
      admitted = { ...admitted, sourceRunPath: parentRunPath };
    }
  }
  if (record.sameParent === "auditor" && auditorSource !== undefined) {
    await persistAdmittedSourceRunPath(admitted, auditorSource);
  }

  const runAdmitted = async (): Promise<SeatRunResult> => {
    await markRunAdmitted(admitted, env.principalAuthority);
    if (record.sameParent === "secretariat") {
      const { invokeCourtDiarist } = await import("./countersign-run.ts");
      const outcome = await invokeCourtDiarist({
        instruction: parsed.instruction ?? "",
        projectRoot: admitted.projectRoot,
        failureLabel: "secretariat unbound summons",
        attachmentPaths: admitted.attachments.map((attachment) => attachment.frozenPath),
        correlationId: admitted.runId,
      }, {
        cwd: env.cwd,
        home: env.home,
        agentDir: env.agentDir,
        packageRoot: env.packageRoot,
        ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
        ...(env.signal === undefined ? {} : { signal: env.signal }),
        ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
      }, io);
      if (outcome.identity.kind === "escalate" || outcome.failedWithoutEscalate !== undefined) {
        const diagnostic = outcome.identity.kind === "escalate"
          ? outcome.identity.diagnostic
          : outcome.failedWithoutEscalate?.diagnostic ?? "";
        return await presentControlledFailure(admitted, {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: new Error(diagnostic),
        }, seatAdapters(admitted, env), env.principalAuthority, io) as SeatRunResult;
      }
      if (outcome.identity.kind === "ticket") {
        try {
          await bindAdmittedTicketNumber(admitted, outcome.identity.ticketNumber);
          await relocateAdmittedRunToTicket(admitted, env.principalAuthority);
        } catch (error) {
          return await presentControlledFailure(admitted, {
            timedOut: false,
            code: null,
            stderr: "",
            thrown: error,
          }, seatAdapters(admitted, env), env.principalAuthority, io) as SeatRunResult;
        }
      }
    }
    return dispatchAdmitted(admitted, env, io);
  };

  if (record.sameParent === "auditor") {
    return withAuditorSoulEnv({
      ...(auditorSubject === undefined ? {} : { subject: auditorSubject }),
      ...(auditorSource === undefined ? {} : { sourceRunDirectory: auditorSource }),
      run: runAdmitted,
    });
  }
  return runAdmitted();
}

export async function runPublicInstructionSeatResume(
  request: PublicResumeRequest,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult> {
  const role = await peekRoleRunRole(env.home, request.runId);
  if (role === "countersign") return runPublicCountersignResume(request, env, io);
  const execution: { cwd?: string } = {
    ...(env.executionCwd === undefined ? {} : { cwd: env.executionCwd }),
  };
  return runPostAdmissionSeatResume<AdmittedRoleInvocation>({
    request,
    env,
    io,
    load: async (effective) => {
      const loaded = await loadResumablePublicRole(env.home, effective.runId, env.principalAuthority);
      if (
        loaded.admitted.role === "notary"
        && effective.summons?.sourceRunPath !== undefined
        && effective.summons.sourceRun !== undefined
      ) {
        return {
          ...loaded,
          admitted: {
            ...loaded.admitted,
            sourceRunPath: effective.summons.sourceRunPath,
            sourceRun: effective.summons.sourceRun,
          },
        };
      }
      return loaded;
    },
    buildTurnRequest: async (admitted, effective) => {
      const activeEnv = execution.cwd === undefined ? env : { ...env, executionCwd: execution.cwd };
      const summonsPrepared = await prepareSummonsResumeMaterials(admitted.runDirectory, effective.summons);
      return buildInstructionSeatTurnRequest(
        admitted,
        {
          ...resumeTurnRequestProjectionOptions(admitted, effective, activeEnv, summonsPrepared),
          ...(execution.cwd === undefined ? {} : { cwd: execution.cwd }),
        },
      );
    },
    adapters: {
      trySettle: async () => undefined,
    },
    afterAdmittedLoad: (admitted) => {
      const skill = packagedSettleSkill(admitted);
      if (skill === undefined) {
        return Promise.resolve({ kind: "continue" as const, adapters: seatAdapters(admitted, env) });
      }
      const knownCause = admitted.role === "coder" || admitted.role === "merger" ? "activation" as const : undefined;
      return resolveResumeMethodMaterialAdapters({
        admitted,
        authority: env.principalAuthority,
        io,
        loadMaterial: () => loadPackagedMethodSkillMaterial(env.packageRoot, skill),
        adaptersWith: (material) => seatAdapters(admitted, env, material),
        emptyAdapters: seatAdapters(admitted, env),
        ...(knownCause === undefined ? {} : { knownCause }),
      });
    },
    afterAdmittedPrepare: async (admitted) => {
      if (!wantsFreshExecutionCopy(admitted.role)) return {};
      if (execution.cwd !== undefined) {
        return { env: { ...env, executionCwd: execution.cwd } };
      }
      const { openEphemeralReviewerWorktree } = await import("../public-role-summons.ts");
      const opened = await openEphemeralReviewerWorktree({
        projectRoot: admitted.projectRoot,
        onCleanupDiagnostic: (diagnostic) => {
          io.stderr(`${diagnostic}\n`);
        },
      });
      execution.cwd = opened.executionCwd;
      return {
        env: { ...env, executionCwd: opened.executionCwd },
        cleanup: opened.close,
      };
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
