/**
 * One public role run: admit → turn request → post-admission → settle.
 * Seat differences are composition-root fields. An omitted reviewer lens
 * starts two ordinary single-axis runs here. Countersign keeps deferred
 * identity on this entry; the court diarist station stays in countersign-run.
 */
import { dirname, join, resolve, sep } from "node:path";

import { listDirectOfficerRunPointers } from "../archivist-record-entry.ts";
import type { DurablePrincipalAuthority, HostContext, RoleTurnRequest } from "../host-contracts.ts";
import { gateOfficerForSubject, OFFICER_CONCLUSION_REASK } from "../gatekeeper-role.ts";
import { runJudgeGates } from "../judge-role.ts";
import { joinReadableGateItems, readableGateItem } from "../readable-gate-item.ts";
import { runIdFromRunDirectory } from "../run-terminal-artifacts.ts";
import { OfficerEscalationParkError } from "../submission-errors.ts";
import {
  createDefaultGateOfficerSummon,
  latestQueuePayload,
  latestQueueStatus,
  requireSubmissionGate,
} from "../submission-gate.ts";
import { readRecordedSubmissionRows, sealAcceptedSubmission } from "../submission-ledger.ts";
import { persistReturnedRunState } from "./auto-resume.ts";
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
import { isAuditorSoulRole, readAuditorResumeBinding } from "../auditor-soul.ts";
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
  type TerminalRoleName,
} from "./terminal.ts";
import {
  admittedSeatTurnDetails,
  packagedSettleSkill,
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";
import {
  invokeCourtDiarist,
  latestPayloadEscalated,
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
    if (activeEnv.correlationId !== undefined && activeEnv.correlationId.trim() !== "") {
      await recordAdmittedCorrelation(admitted, activeEnv.correlationId);
    }
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
      ...(isSafePositiveTicketNumber(env.boundTicketNumber) ? { ticketNumber: env.boundTicketNumber } : {}),
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
      let childDiaristRunId: string | undefined;
      let pausedDiaristTerminal: TerminalResult | undefined;

      if (gateParentRunPath === undefined && env.runCourtDiaristStation === undefined) {
        let outcome: Awaited<ReturnType<typeof invokeCourtDiarist>>;
        try {
          outcome = await invokeCourtDiarist({
            instruction: parsed.instruction ?? "",
            projectRoot: admitted.projectRoot,
            failureLabel: "unbound summons",
            correlationId: admitted.runId,
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
        if (outcome.identity.kind === "escalate") pausedDiaristTerminal = outcome.terminal;
        if (outcome.admitted?.runDirectory.includes(`${sep}unbound${sep}runs${sep}`)) {
          childDiaristRunId = outcome.admitted.runId;
        }
        if (outcome.failedWithoutEscalate !== undefined) {
          const diagnostic = outcome.failedWithoutEscalate.diagnostic;
          await materializeAdmission(
            isSafePositiveTicketNumber(env.boundTicketNumber) ? env.boundTicketNumber : undefined,
          );
          if (childDiaristRunId !== undefined) await recordChildDiaristRun(admitted, childDiaristRunId);
          await markRunAdmitted(admitted, env.principalAuthority);
          return await presentControlledFailure(admitted, {
            timedOut: false,
            code: null,
            stderr: "",
            thrown: new Error(diagnostic),
          }, seatAdapters(admitted, env), env.principalAuthority, io) as SeatRunResult;
        }
        if (outcome.identity.kind === "ticket") {
          typedTicket = outcome.identity.ticketNumber;
          typedCourtTicketNumbers = outcome.identity.courtTicketNumbers;
        }
      }

      await materializeAdmission(typedTicket);
      await markRunAdmitted(admitted, env.principalAuthority);
      if (childDiaristRunId !== undefined) {
        await recordChildDiaristRun(admitted, childDiaristRunId);
      }
      if (pausedDiaristTerminal !== undefined) {
        // The child already submitted its own pause; no parent turn exists yet.
        io.stdout(formatTerminalResult(pausedDiaristTerminal));
        return { exitCode: 0, admitted, terminal: pausedDiaristTerminal };
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
              const refresh = await runCountersignCourtDiaristStation(admittedSeat, env, io);
              if (refresh !== undefined) {
                io.stdout(formatTerminalResult(refresh.terminal));
                return refresh.terminal;
              }
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

  if (record.sameParent === "gate-pointer") {
    const parentRunPath = parentRunPathFromGatePointerInstruction(parsed.instruction ?? "");
    if (parentRunPath !== undefined) {
      await persistAdmittedSourceRunPath(admitted, parentRunPath);
      const sourcePatch = { sourceRunPath: parentRunPath };
      admitted = { ...admitted, ...sourcePatch };
    }
  }
  if (record.sameParent === "subject-source" && auditorSource !== undefined) {
    await persistAdmittedSourceRunPath(admitted, auditorSource, auditorSubject);
  }

  const runAdmitted = async (): Promise<SeatRunResult> => {
    await markRunAdmitted(admitted, env.principalAuthority);
    if (role === "secretariat") {
      let outcome: Awaited<ReturnType<typeof invokeCourtDiarist>>;
      try {
        outcome = await invokeCourtDiarist({
          instruction: parsed.instruction ?? "",
          projectRoot: admitted.projectRoot,
          failureLabel: "secretariat unbound summons",
          attachmentPaths: admitted.attachments.map((attachment) => attachment.frozenPath),
          correlationId: admitted.runId,
        }, env, io);
      } catch (error) {
        return await presentControlledFailure(admitted, {
          timedOut: false, code: null, stderr: "", thrown: error,
        }, seatAdapters(admitted, env), env.principalAuthority, io) as SeatRunResult;
      }
      if (outcome.admitted?.runDirectory.includes(`${sep}unbound${sep}runs${sep}`)) {
        await recordChildDiaristRun(admitted, outcome.admitted.runId);
      }
      if (outcome.failedWithoutEscalate !== undefined) {
        return await presentControlledFailure(admitted, {
          timedOut: false, code: null, stderr: "",
          thrown: new Error(outcome.failedWithoutEscalate.diagnostic),
        }, seatAdapters(admitted, env), env.principalAuthority, io) as SeatRunResult;
      }
      if (outcome.identity.kind === "escalate" && outcome.terminal !== undefined) {
        io.stdout(formatTerminalResult(outcome.terminal));
        return { exitCode: 0, admitted, terminal: outcome.terminal };
      }
    }
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
  const resume = () => runPostAdmissionSeatResume<AdmittedRoleInvocation>({

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
  let binding: Awaited<ReturnType<typeof readAuditorResumeBinding>>;
  try {
    const loaded = await loadResumablePublicRole(env.home, request.runId, env.principalAuthority, true);
    binding = loaded.admitted.role === "auditor"
      ? await readAuditorResumeBinding(loaded.admitted.runDirectory)
      : undefined;
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
  }
  if (binding !== undefined) {
    return withAuditorSoulEnv({
      subject: binding.subject,
      sourceRunDirectory: binding.sourceRunDirectory,
      run: resume,
    });
  }
  return resume();
}

const QUEUE_CONCLUSIONS = new Set(["converged", "continue", "escalate"]);
const GATE_CHILD_ROLES = new Set(["notary", "auditor", "inspector", "countersign"]);

/**
 * A gate child's conclusion outside the three states goes back to that child.
 * The words are the existing officer re-ask. A host failure stops here.
 */
async function queueConclusionFromChild(
  child: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<
  | { readonly admitted: AdmittedRoleInvocation; readonly terminal: TerminalResult; readonly status: string }
  | { readonly stop: SeatRunResult }
  | undefined
> {
  if (!GATE_CHILD_ROLES.has(child.role)) return undefined;
  let current = child;
  for (;;) {
    const terminal = await trySettlePublicSeat(
      current,
      env.principalAuthority,
      undefined,
      undefined,
      env.packageRoot,
    );
    const status = latestQueueStatus(terminal);
    if (terminal !== undefined && status !== undefined && QUEUE_CONCLUSIONS.has(status)) {
      return { admitted: current, terminal, status };
    }
    const reasked = await runPublicInstructionSeatResume({
      runId: current.runId,
      message: OFFICER_CONCLUSION_REASK,
    }, env, io);
    if (reasked.exitCode !== 0 || reasked.admitted === undefined || reasked.terminal === undefined) {
      return { stop: reasked };
    }
    const reaskedStatus = latestQueueStatus(reasked.terminal);
    if (reaskedStatus !== undefined && QUEUE_CONCLUSIONS.has(reaskedStatus)) {
      return { admitted: reasked.admitted, terminal: reasked.terminal, status: reaskedStatus };
    }
    if (latestPayloadEscalated(reasked.terminal.roleOutcome)) return { stop: reasked };
    current = reasked.admitted;
  }
}

/** Continue the parent once a child has submitted. The child words ride the existing resume. */
export async function continueParentAfterChild(
  parentRunId: string,
  child: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult> {
  const loaded = await loadResumablePublicRole(env.home, parentRunId, env.principalAuthority, true);
  if (loaded.run.state !== "admitted") {
    return runPublicInstructionSeatResume({ runId: parentRunId }, env, io);
  }
  const admitted = loaded.admitted;
  if (admitted.role === "countersign" && admitted.ticketNumber !== undefined) {
    const refresh = await runCountersignCourtDiaristStation(admitted, env, io, child.ticketNumber);
    if (refresh !== undefined) {
      io.stdout(formatTerminalResult(refresh.terminal));
      return { exitCode: 0, admitted, terminal: refresh.terminal };
    }
  }
  const resolved = await queueConclusionFromChild(child, env, io);
  if (resolved !== undefined && "stop" in resolved) return resolved.stop;
  if (resolved !== undefined && resolved.status === "escalate") {
    return { exitCode: 0, admitted: resolved.admitted, terminal: resolved.terminal };
  }
  if (resolved !== undefined && (resolved.status === "continue" || resolved.status === "converged")) {
    if (admitted.role === "judge") {
      const finished = await finishOpenJudgeVerdict(loaded, resolved, env, io);
      if (finished !== undefined) return finished;
    }
    return runPublicInstructionSeatResume({
      runId: parentRunId,
      message: readableGateItem(latestQueuePayload(resolved.terminal)),
    }, { ...env, autoResumeLimit: 0 }, io);
  }
  return dispatchAdmitted(admitted, env, io);
}

function parentHostContext(
  admitted: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
): HostContext {
  const sessionFile = join(admitted.runDirectory, "session", "session.jsonl");
  return {
    cwd: admitted.projectRoot,
    mode: "print",
    model: undefined,
    runDirectory: admitted.runDirectory,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionDir: () => dirname(sessionFile),
      getEntries: () => [],
      getLeafEntry: () => undefined,
      getLeafId: () => admitted.runId,
      getHeader: () => ({ type: "session", id: admitted.runId }),
      appendCustomEntry: (customType, data) => env.sessionAppender(
        env.principalAuthority,
        admitted.principal,
        customType,
        data,
      ),
    },
    abort() {},
  };
}

function bufferIo(): { readonly io: CliIo; replay(target: CliIo): void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    replay(target) {
      for (const text of stdout) target.stdout(text);
      for (const text of stderr) target.stderr(text);
    },
  };
}

async function officerGateConverged(
  sessionFile: string,
  officer: string,
  env: InstructionSeatRunEnv,
): Promise<boolean> {
  for (const item of listDirectOfficerRunPointers(sessionFile)) {
    if (item.pointer.officer !== officer) continue;
    const runDirectory = item.pointer.runDirectory ?? dirname(dirname(item.pointer.sessionFile));
    const runId = runIdFromRunDirectory(runDirectory);
    if (runId === undefined) return false;
    const officerRun = await loadResumablePublicRole(env.home, runId, env.principalAuthority, true);
    const terminal = await trySettlePublicSeat(
      officerRun.admitted,
      env.principalAuthority,
      undefined,
      undefined,
      env.packageRoot,
    );
    return latestQueueStatus(terminal) === "converged";
  }
  return false;
}

async function escalatedOfficerResult(
  error: OfficerEscalationParkError,
  env: InstructionSeatRunEnv,
): Promise<SeatRunResult> {
  const fromResult = error.result.status === "escalate" ? error.result.runId : undefined;
  const runId = fromResult ?? (
    error.officerRunDirectory === undefined
      ? undefined
      : runIdFromRunDirectory(error.officerRunDirectory)
  );
  if (runId === undefined) throw error;
  const officer = await loadResumablePublicRole(env.home, runId, env.principalAuthority, true);
  const terminal = await trySettlePublicSeat(
    officer.admitted,
    env.principalAuthority,
    undefined,
    undefined,
    env.packageRoot,
  );
  if (terminal === undefined || latestQueueStatus(terminal) !== "escalate") throw error;
  return { exitCode: 0, admitted: officer.admitted, terminal };
}

/**
 * Finish the judge seat's own remaining gates for the unsealed candidate.
 * A pass with no newer verdict seals that candidate. A newer verdict stands.
 */
async function finishOpenJudgeVerdict(
  loaded: Awaited<ReturnType<typeof loadResumablePublicRole>>,
  resolved: { readonly terminal: TerminalResult },
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult | undefined> {
  const admitted = loaded.admitted;
  const rows = await readRecordedSubmissionRows(admitted.projectRoot, admitted.runId, env.home);
  const open = [...rows].reverse().find((row) => row.kind === "candidate" && row.toolCallId !== undefined);
  if (open?.toolCallId === undefined) return undefined;
  const sessionFile = env.principalAuthority.decode(admitted.principal).sessionFile;
  const context = parentHostContext(admitted, env);
  let chain: Awaited<ReturnType<typeof runJudgeGates>>;
  try {
    chain = await runJudgeGates({
      gateAlreadyConverged: (subject) => officerGateConverged(
        sessionFile,
        gateOfficerForSubject(subject),
        env,
      ),
      runGate: (subject) => requireSubmissionGate({
        context,
        subject,
        toolCallId: open.toolCallId!,
        submission: open.accepted,
        ...(env.signal === undefined ? {} : { signal: env.signal }),
        summonOfficer: createDefaultGateOfficerSummon({
          cwd: admitted.projectRoot,
          home: env.home,
          packageRoot: env.packageRoot,
          io,
          ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
        }),
        hostActions: {
          bindSubmissionNonPass() {},
          failInfrastructure(error): never {
            throw error instanceof Error ? error : new Error(String(error));
          },
        },
      }),
    });
  } catch (error) {
    if (error instanceof OfficerEscalationParkError) return escalatedOfficerResult(error, env);
    throw error;
  }
  const words = [
    latestQueuePayload(resolved.terminal),
    ...chain.passes.map((pass) => pass.receipt),
  ].filter((item) => item !== undefined);
  const message = joinReadableGateItems(words);
  if (chain.status === "continue") {
    return runPublicInstructionSeatResume({
      runId: admitted.runId,
      message,
    }, { ...env, autoResumeLimit: 0 }, io);
  }
  const buffered = bufferIo();
  const turn = await runPublicInstructionSeatResume({
    runId: admitted.runId,
    message,
  }, { ...env, autoResumeLimit: 0 }, buffered.io);
  if (turn.exitCode !== 0) {
    buffered.replay(io);
    return turn;
  }
  const beforeIds = new Set(rows.flatMap((row) => row.toolCallId === undefined ? [] : [row.toolCallId]));
  const after = await readRecordedSubmissionRows(admitted.projectRoot, admitted.runId, env.home);
  const newerVerdict = after.some((row) => row.toolCallId !== undefined && !beforeIds.has(row.toolCallId));
  const turnedToOfficer = turn.terminal?.roleOutcome.role !== undefined
    && turn.terminal.roleOutcome.role !== admitted.role;
  if (newerVerdict || turnedToOfficer) {
    buffered.replay(io);
    return turn;
  }
  await sealAcceptedSubmission({
    context,
    role: admitted.role as TerminalRoleName,
    accepted: open.accepted,
    toolCallId: open.toolCallId,
    home: env.home,
  });
  const settled = await trySettlePublicSeat(
    admitted,
    env.principalAuthority,
    undefined,
    undefined,
    env.packageRoot,
  );
  if (settled?.roleOutcome.kind !== "accepted") {
    throw new Error("open judge verdict produced no accepted terminal");
  }
  await persistReturnedRunState(admitted, env.principalAuthority, { lawful: true });
  io.stdout(formatTerminalResult(settled));
  return { exitCode: 0, admitted, terminal: settled };
}
