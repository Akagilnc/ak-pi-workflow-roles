/**
 * One public role run: admit → turn request → post-admission → settle.
 * Seat differences are composition-root fields. Reviewer parallel axes and
 * countersign deferred identity stay the two lawful specials of this entry.
 */
import type { DurablePrincipalAuthority, RoleTurnActivation, RoleTurnRequest } from "../host-contracts.ts";
import { readBoardTicketNumber } from "../run-ticket-number.ts";
import { NotarySourceRunError, resolveNotarySourceRunLocator } from "../notary-source-run.ts";
import { engineSessionMaterialFromOptions, pickEngineAxis } from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillMaterial,
  type PackagedMethodSkillName,
} from "../package-resources/method-skill.ts";
import type { PackagedRole } from "../packaged-role-registry.ts";
import {
  packagedRoleAcceptedOutputTool,
  packagedRoleActivationFlags,
  packagedRoleMetadata,
} from "../packaged-role-registry.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitPublicRole,
  bindAdmittedTicketNumber,
  buildGleanerLeftTransportPrompt,
  buildInstructionTransportPrompt,
  buildNotaryTransportPrompt,
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
  readCollectorInfrastructureFailure,
  readEngineDetourInfrastructureFailure,
  trySettleAcceptedSeatTerminalResult,
  trySettleCoderTerminalResult,
  trySettleCollectorTerminalResult,
  trySettleDoctorTerminalResult,
  trySettleFixerTerminalResult,
  trySettleJudgeTerminalResult,
  trySettleMergerTerminalResult,
  trySettleSecretariatTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import { isLawfulTypedTerminalOutcome, type TerminalResult } from "./terminal.ts";
import { projectRoleTurnRequest, type RoleTurnRequestProjectionOptions } from "./turn-request.ts";
import { runPublicCountersign, runPublicCountersignResume } from "./countersign-run.ts";
import { runPublicReviewer, runPublicReviewerResume } from "./reviewer-run.ts";

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

function settleSkill(admitted: AdmittedRoleInvocation): PackagedMethodSkillName | undefined {
  const record = packagedRoleMetadata(admitted.role);
  if (record === undefined) return undefined;
  if ("applyMethod" in record && record.applyMethod !== undefined) {
    return "phase" in admitted && admitted.phase === "apply" ? record.applyMethod : undefined;
  }
  if ("settleMethod" in record && record.settleMethod !== undefined) return record.settleMethod;
  return undefined;
}

function methodBindings(admitted: AdmittedRoleInvocation, packageRoot: string) {
  const record = packagedRoleMetadata(admitted.role);
  const names: PackagedMethodSkillName[] = [];
  if (record !== undefined && "methodSkills" in record && record.methodSkills !== undefined) {
    names.push(...record.methodSkills);
  }
  const apply = settleSkill(admitted);
  if (apply !== undefined && !names.includes(apply)) names.push(apply);
  return names.map((name) => ({
    kind: "skill" as const,
    path: resolvePackagedMethodSkillPath(packageRoot, name),
  }));
}

function readAdmittedPath(admitted: AdmittedRoleInvocation, path: string): unknown {
  let current: unknown = admitted;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Activation object for one admitted run. Field copies come from the composition-root record. */
function activationForAdmitted(admitted: AdmittedRoleInvocation): RoleTurnActivation {
  if (packagedRoleMetadata(admitted.role) === undefined) {
    throw new Error(`no turn projection for ${admitted.role}`);
  }
  const activation: Record<string, unknown> = { role: admitted.role };
  for (const spec of packagedRoleActivationFlags(admitted.role)) {
    let value = readAdmittedPath(admitted, spec.from ?? spec.field);
    if (spec.fallback === "gate-pointer") {
      const trimmed = typeof value === "string" ? value.trim() : "";
      value = trimmed !== ""
        ? trimmed
        : parentRunPathFromGatePointerInstruction(admitted.instruction);
      if (typeof value !== "string" || value === "") continue;
    }
    if (value === undefined) continue;
    if (spec.text === true) {
      if (typeof value !== "number") continue;
      value = String(value);
    }
    activation[spec.field] = value;
  }
  return activation as RoleTurnActivation;
}

/** Project any admitted public role onto the host-neutral turn request. */
export function buildInstructionSeatTurnRequest(
  admitted: AdmittedRoleInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(admitted, {
    activation: activationForAdmitted(admitted),
    methods: methodBindings(admitted, options.packageRoot),
  }, options);
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
  return buildInstructionTransportPrompt(admitted, material);
}

async function settleSeat(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope: { readonly courtAttemptId?: string } | undefined,
  material: PackagedMethodSkillMaterial | undefined,
  packageRoot: string,
): Promise<TerminalResult | undefined> {
  switch (admitted.role) {
    case "judge":
      return trySettleJudgeTerminalResult(admitted, authority, scope);
    case "coder":
      return trySettleCoderTerminalResult(
        admitted,
        authority,
        material === undefined ? {} : { methodProvenance: material.provenance },
        scope,
      );
    case "fixer":
      return material === undefined
        ? undefined
        : trySettleFixerTerminalResult(admitted, authority, {
          methodProvenance: material.provenance,
          methodSkillPath: material.skillPath,
          methodSkillConfiguredPath: resolvePackagedMethodSkillPath(packageRoot, "diagnosing-bugs"),
        }, scope);
    case "merger":
      return material === undefined
        ? undefined
        : trySettleMergerTerminalResult(admitted, authority, {
          methodProvenance: material.provenance,
          methodSkillPath: material.skillPath,
          methodSkillConfiguredPath: resolvePackagedMethodSkillPath(packageRoot, "resolving-merge-conflicts"),
        }, scope);
    case "collector":
      return trySettleCollectorTerminalResult(admitted, authority, scope);
    case "doctor":
      return trySettleDoctorTerminalResult(admitted, authority, scope);
    case "secretariat":
      return trySettleSecretariatTerminalResult(admitted, authority, scope);
    case "reviewer":
      return undefined;
    default:
      if (packagedRoleAcceptedOutputTool(admitted.role) === undefined) {
        throw new Error(`no settlement for ${admitted.role}`);
      }
      return trySettleAcceptedSeatTerminalResult(admitted, authority, scope);
  }
}

function infraFailure(role: PackagedRole) {
  if (role === "judge") {
    return {
      resolveRunnerKnownFailure: async ({
        result,
        sessionFile,
      }: {
        result: { knownFailure?: import("../host-contracts.ts").RoleTurnKnownFailure };
        sessionFile: string;
      }) => {
        const infrastructureFailure = await readEngineDetourInfrastructureFailure(sessionFile);
        return result.knownFailure ?? (infrastructureFailure === undefined
          ? undefined
          : {
            ...(infrastructureFailure.cause === undefined ? {} : { cause: infrastructureFailure.cause }),
            diagnostic: infrastructureFailure.diagnostic,
            ...(infrastructureFailure.identity === undefined ? {} : { identity: infrastructureFailure.identity }),
          });
      },
    };
  }
  if (role === "gatekeeper" || role === "navigator" || role === "auditor") {
    return {
      resolveRunnerKnownFailure: async ({
        result,
        sessionFile,
      }: {
        result: { knownFailure?: import("../host-contracts.ts").RoleTurnKnownFailure };
        sessionFile: string;
      }) => {
        const infrastructureFailure = await readEngineDetourInfrastructureFailure(sessionFile);
        return infrastructureFailure === undefined
          ? result.knownFailure
          : {
            ...(infrastructureFailure.cause === undefined ? {} : { cause: infrastructureFailure.cause }),
            diagnostic: infrastructureFailure.diagnostic,
            ...(infrastructureFailure.identity === undefined ? {} : { identity: infrastructureFailure.identity }),
          };
      },
    };
  }
  if (role === "collector") {
    return {
      resolveRunnerKnownFailure: async ({
        result,
        sessionFile,
      }: {
        result: { knownFailure?: import("../host-contracts.ts").RoleTurnKnownFailure };
        sessionFile: string;
      }) => {
        const infrastructureFailure = await readCollectorInfrastructureFailure(sessionFile);
        return result.knownFailure ?? (infrastructureFailure === undefined
          ? undefined
          : {
            ...(infrastructureFailure.cause === undefined ? {} : { cause: infrastructureFailure.cause }),
            diagnostic: infrastructureFailure.diagnostic,
            ...(infrastructureFailure.identity === undefined ? {} : { identity: infrastructureFailure.identity }),
          });
      },
    };
  }
  return {};
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
      settleSeat(seat, authority, scope, material, env.packageRoot),
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
  const skill = settleSkill(admitted);
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
  const auto = "inCallAutoResume" in record && record.inCallAutoResume === true;
  if (auto) {
    return await runPostAdmissionResumable({
      admitted,
      env,
      io,
      buildInitialRequest: () => buildInstructionSeatTurnRequest(
        admitted,
        roleTurnOptions(env, admitted, { kind: "initial", prompt: initialPrompt(admitted, env) }),
      ),
      buildResumeRequest: () => buildInstructionSeatTurnRequest(
        admitted,
        roleTurnOptions(env, admitted, {
          kind: "resume",
          prompt: buildAutoResumeContinuationPrompt({
            packageRoot: env.packageRoot,
            ...pickEngineAxis(env),
          }),
        }),
      ),
      adapters,
      ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
    });
  }
  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: buildInstructionSeatTurnRequest(
      admitted,
      roleTurnOptions(env, admitted, { kind: "initial", prompt: initialPrompt(admitted, env) }),
    ),
    adapters,
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

export async function runPublicInstructionSeat(
  argv: readonly string[],
  env: InstructionSeatRunEnv,
  io: CliIo,
  role: PackagedRole,
  parseArgv: (args: readonly string[]) => PublicSeatParse,
): Promise<SeatRunResult> {
  const record = roleRecord(role);
  if (record.admission === "reviewer") {
    return runPublicReviewer(argv, env, io, parseArgv);
  }
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

  if (record.sameParent === "diarist") {
    const handoff = env.boundTicketNumber;
    if (typeof handoff === "number" && Number.isSafeInteger(handoff) && handoff >= 1) {
      const summons: SameTicketSummonsMaterials = {
        instruction: parsed.instruction ?? "",
        instructionEmpty: (parsed.instruction ?? "").trim() === "",
        attachmentPaths: parsed.attachmentPaths ?? [],
      };
      const resumed = await tryResumeSameTicketSeatRun({
        home: env.home,
        projectRoot,
        role,
        ticketNumber: handoff,
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
  if (role === "reviewer") return runPublicReviewerResume(request, env, io);
  if (role === "countersign") return runPublicCountersignResume(request, env, io);
  return runPostAdmissionSeatResume<AdmittedRoleInvocation>({
    request,
    env,
    io,
    load: async (effective) => {
      const loaded = await loadResumablePublicRole(env.home, effective.runId, env.principalAuthority);
      if (loaded.admitted.role === "notary" && effective.message !== undefined) {
        throw new CliUsageError(
          "notary rejects caller prompt/instruction; only zero caller-prompt continuation admitted",
        );
      }
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
      const summonsPrepared = await prepareSummonsResumeMaterials(admitted.runDirectory, effective.summons);
      return buildInstructionSeatTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(admitted, effective, env, summonsPrepared),
      );
    },
    adapters: {
      trySettle: async () => undefined,
    },
    afterAdmittedLoad: (admitted) => {
      const skill = settleSkill(admitted);
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
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
