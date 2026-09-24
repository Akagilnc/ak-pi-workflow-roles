/**
 * One public role run: admit → turn request → post-admission → settle.
 * Seat differences are composition-root fields. An omitted reviewer lens
 * starts two ordinary single-axis runs here. Countersign keeps deferred
 * identity on this entry; the court diarist station stays in countersign-run.
 */
import { resolve, sep } from "node:path";

import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { isSafePositiveTicketNumber, readBoardTicketNumber } from "../run-ticket-number.ts";
import { NotarySourceRunError, resolveNotarySourceRunLocator } from "../notary-source-run.ts";
import { engineSessionMaterialFromOptions, pickEngineAxis } from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  type PackagedMethodSkillMaterial,
} from "../package-resources/method-skill.ts";
import type { PackagedRole } from "../packaged-role-registry.ts";
import {
  packagedAdmitsCountersign,
  packagedBindsBoardTicket,
  packagedMethodLoadFailureCause,
  packagedRebindSourceOnResume,
  packagedRoleMetadata,
} from "../packaged-role-registry.ts";
import { isAuditorSoulRole } from "../auditor-soul.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitPublicRole,
  bindAdmittedTicketNumber,
  bindCourtTicketNumbersOnAdmitted,
  buildInstructionTransportPrompt,
  materializeCountersignInvocation,
  persistAdmittedSourceRunPath,
  recordAdmittedCorrelation,
  recordChildDiaristRun,
  relocateAdmittedRunToTicket,
  withPreparedAttachments,
  type AdmittedCountersignInvocation,
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
import {
  invokeCourtDiarist,
  runCountersignCourtDiaristStation,
  type CountersignRunEnv,
} from "./countersign-run.ts";

export type InstructionSeatRunEnv = PostAdmissionEnv & Pick<
  CountersignRunEnv,
  "reviewReask" | "gateReviewInstruction" | "parentRunPath" | "runCourtDiaristStation"
>;

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
  const record = roleRecord(admitted.role);
  const reask = env.reviewReask ?? env.gateReviewInstruction;
  if (reask !== undefined && "reaskPrompt" in record && record.reaskPrompt === true) {
    return reask;
  }
  return buildInstructionTransportPrompt(
    admitted,
    engineSessionMaterialFromOptions({
      ...pickEngineAxis(env),
      packageRoot: env.packageRoot,
    }),
  );
}

function infraFailure(role: PackagedRole) {
  const resolveRunnerKnownFailure = seatKnownFailureResolver(role);
  return resolveRunnerKnownFailure === undefined ? {} : { resolveRunnerKnownFailure };
}

function isBoardTicketSeat(
  seat: AdmittedRoleInvocation,
): seat is AdmittedRoleInvocation & { role: "diarist" } {
  return packagedBindsBoardTicket(seat.role);
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
    ...(packagedBindsBoardTicket(admitted.role)
      ? {
        beforeDispatch: async (seat: AdmittedRoleInvocation, lease?: RunWriterLease) => {
          if (!isBoardTicketSeat(seat)) return;
          if (env.correlationId !== undefined && env.correlationId.trim() !== "") {
            await recordAdmittedCorrelation(seat, env.correlationId);
          }
          await bindAndRelocateDiarist(seat, env.principalAuthority, lease);
        },
        afterDispatch: async (seat: AdmittedRoleInvocation, lease?: RunWriterLease) => {
          if (!isBoardTicketSeat(seat)) return;
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
      const knownCause = packagedMethodLoadFailureCause(admitted.role);
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
    if (auto) {
      return await runPostAdmissionResumable({
        admitted,
        env: activeEnv,
        io,
        buildInitialRequest: () => buildInstructionSeatTurnRequest(
          admitted,
          roleTurnOptions(activeEnv, admitted, { kind: "initial", prompt: initialPrompt(admitted, activeEnv) }),
        ),
        buildResumeRequest: () => buildInstructionSeatTurnRequest(
          admitted,
          roleTurnOptions(activeEnv, admitted, {
            kind: "resume",
            prompt: buildAutoResumeContinuationPrompt({
              packageRoot: activeEnv.packageRoot,
              ...pickEngineAxis(activeEnv),
            }),
          }),
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
        roleTurnOptions(activeEnv, admitted, { kind: "initial", prompt: initialPrompt(admitted, activeEnv) }),
      ),
      adapters,
      ...(activeEnv.engine === undefined ? {} : { effectiveEngine: activeEnv.engine }),
    });
  };
  return execute(env);
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

/**
 * Countersign on the shared entry: gate parent resume, deferred materialization,
 * 起居郎 identity, then the same one-shot settlement as every other seat.
 * Court refresh stays on runCountersignCourtDiaristStation.
 */
async function runCountersignBody(
  parsed: PublicSeatParse,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult> {
  const gateParentRunPath =
    typeof env.parentRunPath === "string" && env.parentRunPath.trim() !== ""
      ? env.parentRunPath
      : undefined;
  if (gateParentRunPath !== undefined) {
    const resumeInstruction = env.reviewReask ?? env.gateReviewInstruction ?? parsed.instruction ?? "";
    const resumed = await tryResumeSameTicketSeatRun({
      home: env.home,
      projectRoot: resolve(parsed.project ?? env.cwd),
      role: "countersign",
      parentRunPath: gateParentRunPath,
      ...(env.boundTicketNumber === undefined
        ? {}
        : { ticketNumber: env.boundTicketNumber }),
      freshSummons: env.freshSummons,
      summons: {
        sourceRunPath: gateParentRunPath,
        instruction: resumeInstruction,
        instructionEmpty: resumeInstruction.trim() === "",
      },
      resume: (runId, materials) => runPublicInstructionSeatResume(
        { runId, ...(materials === undefined ? {} : { summons: materials }) },
        env,
        io,
      ),
    });
    if (resumed != null) return resumed;
  }

  let admitted: AdmittedCountersignInvocation;
  try {
    admitted = await admitPublicRole("countersign", parsed, env, { deferPersistence: true });
  } catch (error) {
    const rejected = usageExit(error, io);
    if (rejected !== undefined) return rejected;
    throw error;
  }

  try {
    return await withPreparedAttachments(parsed.attachmentPaths ?? [], async (preparedAttachments) => {
      const materializeAdmission = async (ticketNumber?: number): Promise<void> => {
        await materializeCountersignInvocation(admitted, {
          home: env.home,
          principalAuthority: env.principalAuthority,
          preparedAttachments,
          ...(env.model === undefined ? {} : { model: env.model }),
          ...(ticketNumber === undefined ? {} : { ticketNumber }),
        });
      };

      let typedTicket: number | undefined;
      let typedCourtTicketNumbers: readonly number[] | undefined;
      let identityDiaristRan = false;
      let unboundDiaristRunId: string | undefined;

      if (env.runCourtDiaristStation === undefined) {
        let outcome: Awaited<ReturnType<typeof invokeCourtDiarist>>;
        try {
          outcome = await invokeCourtDiarist({
            instruction: parsed.instruction ?? "",
            projectRoot: admitted.projectRoot,
            failureLabel: "unbound summons",
            ...(env.boundTicketNumber === undefined ? {} : { boundTicketNumber: env.boundTicketNumber }),
          }, env, io);
        } catch (error) {
          await materializeAdmission(
            isSafePositiveTicketNumber(env.boundTicketNumber) ? env.boundTicketNumber : undefined,
          );
          await markRunAdmitted(admitted, env.principalAuthority);
          return await presentControlledFailure(admitted, {
            timedOut: false,
            code: null,
            stderr: "",
            thrown: error,
          }, seatAdapters(admitted, env), env.principalAuthority, io) as SeatRunResult;
        }
        identityDiaristRan = true;
        if (outcome.admitted?.runDirectory.includes(`${sep}unbound${sep}runs${sep}`)) {
          unboundDiaristRunId = outcome.admitted.runId;
        }
        if (outcome.identity.kind === "escalate" || outcome.failedWithoutEscalate !== undefined) {
          const diagnostic = outcome.identity.kind === "escalate"
            ? outcome.identity.diagnostic
            : outcome.failedWithoutEscalate?.diagnostic ?? "";
          await materializeAdmission(
            isSafePositiveTicketNumber(env.boundTicketNumber) ? env.boundTicketNumber : undefined,
          );
          if (unboundDiaristRunId !== undefined) await recordChildDiaristRun(admitted, unboundDiaristRunId);
          await markRunAdmitted(admitted, env.principalAuthority);
          return await presentControlledFailure(admitted, {
            timedOut: false,
            code: null,
            stderr: "",
            thrown: new Error(diagnostic),
          }, seatAdapters(admitted, env), env.principalAuthority, io) as SeatRunResult;
        }
        if (outcome.identity.kind === "ticket") {
          typedTicket = isSafePositiveTicketNumber(env.boundTicketNumber)
            ? env.boundTicketNumber
            : outcome.identity.ticketNumber;
          typedCourtTicketNumbers = outcome.identity.courtTicketNumbers;
        } else if (isSafePositiveTicketNumber(env.boundTicketNumber)) {
          typedTicket = env.boundTicketNumber;
        }
      }

      await materializeAdmission(typedTicket);
      await markRunAdmitted(admitted, env.principalAuthority);
      if (unboundDiaristRunId !== undefined) {
        await recordChildDiaristRun(admitted, unboundDiaristRunId);
      }
      if (gateParentRunPath !== undefined) {
        await persistAdmittedSourceRunPath(admitted, gateParentRunPath);
        admitted = { ...admitted, sourceRunPath: gateParentRunPath };
      }
      if (identityDiaristRan && typedTicket !== undefined) {
        try {
          await bindAdmittedTicketNumber(admitted, typedTicket);
          await relocateAdmittedRunToTicket(admitted, env.principalAuthority);
          await bindCourtTicketNumbersOnAdmitted(admitted, typedCourtTicketNumbers ?? [typedTicket]);
        } catch (error) {
          return await presentControlledFailure(admitted, {
            timedOut: false,
            code: null,
            stderr: "",
            thrown: error,
          }, seatAdapters(admitted, env), env.principalAuthority, io) as SeatRunResult;
        }
      }

      const turnProjection: RoleTurnRequestProjectionOptions = {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...pickEngineAxis(env),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(env.correlationId === undefined || env.correlationId.trim() === ""
          ? {}
          : { correlationId: env.correlationId }),
        continuation: {
          kind: "initial",
          prompt: (env.reviewReask ?? env.gateReviewInstruction)
            ?? buildInstructionTransportPrompt(
              admitted,
              engineSessionMaterialFromOptions({
                ...pickEngineAxis(env),
                packageRoot: env.packageRoot,
              }),
            ),
        },
      };
      const turnRequest = buildInstructionSeatTurnRequest(admitted, turnProjection);
      const result = await runPostAdmissionOneShot({
        admitted,
        env,
        io,
        request: turnRequest,
        adapters: {
          ...seatAdapters(admitted, env),
          beforeDispatch: async (admittedSeat, lease) => {
            if (!packagedAdmitsCountersign(admittedSeat.role)) return;
            if (!identityDiaristRan || typedTicket !== undefined) {
              await runCountersignCourtDiaristStation(admittedSeat, env, io);
            }
            await relocateAdmittedRunToTicket(admittedSeat, env.principalAuthority, lease);
            Object.assign(turnRequest, buildInstructionSeatTurnRequest(admittedSeat, turnProjection));
          },
        },
        ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
      });
      await relocateAdmittedRunToTicket(admitted, env.principalAuthority);
      return result;
    });
  } catch (error) {
    const rejected = usageExit(error, io);
    if (rejected !== undefined) return rejected;
    throw error;
  }
}

export async function runPublicInstructionSeat(
  argv: readonly string[],
  env: InstructionSeatRunEnv,
  io: CliIo,
  role: PackagedRole,
  parseArgv: (args: readonly string[]) => PublicSeatParse,
): Promise<SeatRunResult> {
  const record = roleRecord(role);
  let parsed: PublicSeatParse;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    const rejected = usageExit(error, io);
    if (rejected !== undefined) return rejected;
    throw error;
  }
  if (packagedAdmitsCountersign(role)) {
    return runCountersignBody(parsed, env, io);
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
  if (record.sameParent === "subject-source") {
    if (!isAuditorSoulRole(parsed.subject)) {
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
        ...(auditorTicket === undefined ? {} : { ticketNumber: auditorTicket }),
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

  if (record.sameParent === "gate-pointer") {
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
        ...(env.boundTicketNumber === undefined ? {} : { ticketNumber: env.boundTicketNumber }),
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

  if (record.sameParent === "source-locator") {
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
    const knownTicket = (await readBoardTicketNumber(source.runDirectory)) ?? env.boundTicketNumber;
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
      ...(knownTicket === undefined ? {} : { ticketNumber: knownTicket }),
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

  if (record.sameParent === "gate-pointer") {
    const parentRunPath = parentRunPathFromGatePointerInstruction(parsed.instruction ?? "");
    if (parentRunPath !== undefined) {
      await persistAdmittedSourceRunPath(admitted, parentRunPath);
      const sourcePatch = { sourceRunPath: parentRunPath };
      admitted = { ...admitted, ...sourcePatch };
    }
  }
  if (record.sameParent === "subject-source" && auditorSource !== undefined) {
    await persistAdmittedSourceRunPath(admitted, auditorSource);
  }

  const runAdmitted = async (): Promise<SeatRunResult> => {
    await markRunAdmitted(admitted, env.principalAuthority);
    return dispatchAdmitted(admitted, env, io);
  };

  if (record.sameParent === "subject-source") {
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
  return runPostAdmissionSeatResume<AdmittedRoleInvocation>({
    request,
    env,
    io,
    load: async (effective) => {
      const loaded = await loadResumablePublicRole(env.home, effective.runId, env.principalAuthority);
      if (
        packagedRebindSourceOnResume(loaded.admitted.role)
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
      const summonsPrepared = await prepareSummonsResumeMaterials(admitted.runDirectory, effective.summons);
      return buildInstructionSeatTurnRequest(
        admitted,
        {
          ...resumeTurnRequestProjectionOptions(admitted, effective, env, summonsPrepared),
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
      const knownCause = packagedMethodLoadFailureCause(admitted.role);
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
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
