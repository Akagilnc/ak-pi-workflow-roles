/**
 * One public role run: admit → turn request → post-admission → settle.
 * Seat differences are composition-root fields. An omitted reviewer lens
 * starts two ordinary single-axis runs here.
 */
import { basename, dirname, resolve } from "node:path";
import { auditedRunIdentityFromDirectory } from "../audited-run-identity.ts";
import { isUnboundRunDirectory, sessionFileOf } from "../role-run-placement.ts";
import { createPiDoctorAuditor } from "../doctor-auditor.ts";
import type { ComplianceDecision } from "../compliance-transport.ts";
import { serializeThrownValue } from "../serialize-thrown-value.ts";

import type { DurablePrincipalAuthority, HostContext, RoleTurnRequest } from "../host-contracts.ts";
import { officerConclusionReask, gateOfficerForSubject, type GateOfficer } from "../gatekeeper-role.ts";
import { REVIEW_QUEUE_STATUSES } from "../review-submission.ts";
import { JUDGE_GATES, runJudgeGates } from "../judge-role.ts";
import { WORKER_DONE_STATUSES } from "../worker-submission-contracts.ts";
import { readableGateItem } from "../readable-gate-item.ts";
import { deliveryLimitFromConfig } from "../receipt-delivery-policy.ts";
import { roleFromRunDirectory, runIdFromRunDirectory } from "../run-terminal-artifacts.ts";
import { createDefaultGateOfficerSummon, requireSubmissionGate } from "../submission-gate.ts";
import { readRecordedSubmissionRows } from "../submission-ledger.ts";
import { summonPublicRole, type PublicSummonResult } from "../public-role-summons.ts";
import {
  isSafePositiveTicketNumber,
  readBoardTicketNumber,
} from "../run-ticket-number.ts";
import type { NotarySourceRunLocator } from "../notary-contracts.ts";
import { NotarySourceRunError, resolveNotarySourceRunLocator } from "../notary-source-run.ts";
import type { PackagedRole } from "../packaged-role-registry.ts";
import {
  packagedAdmitsCountersign,
  isNavigatorSeat,
  packagedBindsBoardTicket,
  packagedRebindSourceOnResume,
  packagedRoleMetadata,
  receiptStatus,
} from "../packaged-role-registry.ts";
import { auditorResumeBinding } from "../auditor-soul.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitPublicRole,
  admittedSourceRunPath,
  bindAdmittedTicketNumber,
  appendCallerFileFlagPaths,
  buildInstructionTransportPrompt,
  materializeCountersignInvocation,
  persistAdmittedAuditedLeg,
  recordAdmittedCorrelation,
  recordChildDiaristRun,
  relocateAdmittedRunToTicket,
  type AdmittedCountersignInvocation,
  type AdmittedRoleInvocation,
  type PublicSeatParse,
} from "./invocation.ts";
import {
  bindDiaristBoardTicket,
  presentControlledFailure,
  trySettlePublicSeat,
  prepareSummonsResumeMaterials,
  roleTurnOptions,
  runPostAdmissionOneShot,
  runPostAdmissionResumable,
  runPostAdmissionSeatResume,
  showResumeErrorPointer,
  resumeTurnRequestProjectionOptions,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import { presentSeatVolume, presentTerminal } from "./auto-resume.ts";
import {
  loadResumablePublicRole,
  markRunAdmitted,
  type LoadedResumablePublicRole,
  type PublicResumeRequest,
  type RunWriterLease,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import { tryResumeSameTicketSeatRun } from "./seat-ticket-binding.ts";
import {
  presentStructuralRejection,
  readBoundSessionEntries,
  retainPackageFault,
  preparePublicSeat,
  matchesAuditedSeal,
  type SettlementCourtScope,
  besideConclusion,
  packageFaultNoteFor,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import { warnMissingMethodSkills } from "./machine-method-skills.ts";
import {
  currentReplyRows,
  formatTerminalResult,
  isLawfulTypedTerminalOutcome,
  type TerminalReceiptRef,
  type TerminalResult,
} from "./terminal.ts";
import {
  admittedSeatTurnDetails,
  projectRoleTurnRequest,
  requiredMethodSkills,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";
import {
  invokeCourtDiarist,
  type CountersignRunEnv,
} from "./countersign-run.ts";
import { readAuditedRound } from "../ticket-progress.ts";
import { errorText } from "../unknown-value.ts";

export type InstructionSeatRunEnv = PostAdmissionEnv & Pick<
  CountersignRunEnv,
  "reviewReask" | "parentRunPath" | "auditedReceipt"
>;

type SeatRunResult = Pick<PublicSummonResult, "exitCode" | "admitted" | "terminal" | "receivedStatus" | "alongside">;

const AUDITED_ROLES = new Set<PackagedRole>(["judge", "fixer", "coder", "secretariat", "countersign", "doctor"]);
const SECRETARIAT_STATUS_REASK = "status 不是 converged、escalate 之一。请重新交卷，status 写明其一。";
const WORKER_ROUTING_STATUSES: ReadonlySet<string> = new Set([
  "planned", "completed", "refused", "partially_completed", "unfinished",
]);
const WORKER_STATUS_REASK =
  "status 不是 planned、completed、refused、partially_completed、unfinished 之一。请重新交卷，status 写明其一。";
const DOCTOR_ROUTING_STATUSES: ReadonlySet<string> = new Set(["completed", "refused"]);
const DOCTOR_STATUS_REASK =
  "status 不是 completed、refused 之一。请重新交卷，status 写明其一。";
const POST_SUBMISSION_ROUTING: Partial<Record<PackagedRole, {
  readonly statuses: ReadonlySet<string>;
  readonly reask?: string;
}>> = {
  judge: { statuses: REVIEW_QUEUE_STATUSES },
  countersign: { statuses: REVIEW_QUEUE_STATUSES },
  secretariat: { statuses: new Set(["converged", "escalate"]), reask: SECRETARIAT_STATUS_REASK },
  // #1208 C1 / ADR 0055: every review-queue seat uses the shared
  // unreadable-status seam (officerConclusionReask). Independent public
  // entry for notary/auditor/inspector was the same miss — route here, do
  // not invent a parallel loop. Gate summons still own the outer budget
  // via nestedIncomplete when this seat exhausts unsettled.
  notary: {
    statuses: REVIEW_QUEUE_STATUSES,
  },
  auditor: {
    statuses: REVIEW_QUEUE_STATUSES,
  },
  inspector: {
    statuses: REVIEW_QUEUE_STATUSES,
  },
  coder: {
    statuses: WORKER_ROUTING_STATUSES,
    reask: WORKER_STATUS_REASK,
  },
  fixer: {
    statuses: WORKER_ROUTING_STATUSES,
    reask: WORKER_STATUS_REASK,
  },
  diarist: {
    statuses: new Set(["completed", "escalate"]),
    reask: "status 不是 completed、escalate 之一。请重新交卷，status 写明其一。",
  },
  // Doctor contract domain is completed|refused; open-domain escalate is accepted
  // by the tool then routed back here before mandatory auditor (#1057).
  doctor: {
    statuses: DOCTOR_ROUTING_STATUSES,
    reask: DOCTOR_STATUS_REASK,
  },
} as const;

/**
 * One more unreadable-status reask. This loop has its own counter and reads
 * the same autoResumeLimit as the other loops. Exhaustion is not a readable
 * status: the caller presents the volumes already in hand and does not advance
 * review. ADR 0007 audit continues are not this shape.
 */
function withUnreadableReask(env: InstructionSeatRunEnv): InstructionSeatRunEnv | undefined {
  const spent = env.unreadableReasksSpent ?? 0;
  if (spent >= deliveryLimitFromConfig(env.autoResumeLimit)) return undefined;
  return { ...env, unreadableReasksSpent: spent + 1 };
}

/**
 * Mark this leg's terminal that subsequent audit did not settle a queue word.
 * Other-seat receipts / run ids stay on those runs — not copied here (#1195).
 */
function withUnsettledDirection(parent: TerminalResult): TerminalResult {
  const outcome = parent.roleOutcome;
  if (outcome.kind !== "accepted" && outcome.kind !== "audit_escalation") return parent;
  if (outcome.decisiveFacts?.directionUnsettled === true && outcome.decisiveFacts.subsequentAudit === "incomplete") return parent;
  return {
    ...parent,
    roleOutcome: {
      ...outcome,
      decisiveFacts: {
        ...(outcome.decisiveFacts ?? {}),
        directionUnsettled: true,
        subsequentAudit: "incomplete",
      },
    },
  };
}

/**
 * Present the seat's own volume when its direction remains unreadable (ADR 0055).
 */
async function presentUnsettledVolume(
  volume: TerminalResult,
  io: CliIo,
  runDirectory: string,
): Promise<TerminalResult> {
  const terminal = withUnsettledDirection(volume);
  await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, runDirectory);
  return terminal;
}

/**
 * #1214 A5/A12/F1: audit incomplete and no officer volume is presentable.
 * Present parent original; surface diagnostic; do not forge accepted success.
 */
async function incompleteAuditWithoutOfficerVolume(
  turn: SeatRunResult,
  admitted: AdmittedRoleInvocation,
  io: CliIo,
  diagnostic: string,
  carried?: SeatRunResult["alongside"],
): Promise<SeatRunResult> {
  const alongside = await presentAlongside(turn, carried, io);
  io.stderr(diagnostic);
  return { exitCode: 1, admitted, alongside };
}

/**
 * This leg's volume beside its officer's, then the ones a nested officer call
 * already chose and carried up (#1214 R2); all are handed on, so a quiet nested
 * call's choice reaches the public presenter without reading those legs again.
 */
async function presentAlongside(turn: SeatRunResult, carried: SeatRunResult["alongside"], io: CliIo) {
  const alongside = [turn, ...(carried ?? [])];
  for (const volume of alongside) await presentSeatVolume(volume, io, "alongside");
  return alongside;
}

/**
 * #1214 R2: a gate officer's non-pass volume (failure, unreadable, no_receipt) keeps
 * its audited seat's already-filed original on the public call (被审席已交原卷照常呈出).
 * The officer keeps its own identity and exit; the audited seat is not re-run and its
 * volume is read from its own run through the settlement seam (#1195: not copied into
 * the officer's book). Only an officer resumed on its own reads it here; within one
 * call the nested volume is carried up instead (presentAlongside).
 * The officer's own conclusion is in hand: a failed read of the audited seat is
 * noted beside it (ADR 0080) and never loses it.
 */
async function presentAuditedOriginalOfOfficer(
  officer: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<void> {
  if (!GATE_CHILD_ROLES.has(officer.role)) return;
  const audited = officer.correlationId;
  if (audited === undefined) return;
  const auditedSource = admittedSourceRunPath(officer);
  await besideConclusion(packageFaultNoteFor(officer, env, io), "audited original presentation", async () => {
    const parent = await loadResumablePublicRole(
      env.home,
      audited,
      env.principalAuthority,
      auditedSource === undefined ? undefined : { runDirectory: auditedSource },
    );
    if (!AUDITED_ROLES.has(parent.admitted.role)) return;
    // Preview the court named by the officer, never the parent's latest court.
    const terminal = await recoverSeatTerminal(parent.admitted, env, io, {
      seal: { receipt: officer.auditedReceipt },
      previewOnly: true,
    });
    if (!terminal) return;
    await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, parent.admitted.runDirectory, "alongside");
  });
}

/**
 * Officer result that leaves the audited verdict unsettled: non-zero exit, no receipt,
 * or undecidable / unreadable-exhausted (direction unsettled). Escalation is not unsettled.
 */
function leavesAuditedVerdictUnsettled(result: SeatRunResult): boolean {
  const outcome = result.terminal?.roleOutcome;
  return result.exitCode !== 0
    || outcome?.kind === "no_receipt"
    || outcome?.decisiveFacts?.directionUnsettled === true;
}

/**
 * #1214 R2: a resumed gate officer that leaves the audited verdict unsettled keeps the
 * audited seat's already-filed original on the public call. Officer identity and exit stay.
 */
export async function presentAuditedOriginalOfUnsettledOfficer(
  result: SeatRunResult,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<void> {
  if (result.admitted === undefined || !leavesAuditedVerdictUnsettled(result)) return;
  await presentAuditedOriginalOfOfficer(result.admitted, env, io);
}

function reaskUnreadablePostSubmissionStatus(
  admitted: AdmittedRoleInvocation,
  message: string,
  next: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult> {
  // Named status-reask: summons opens a new court; message carries the diagnostic
  // (not arbitrary summons.instruction passthrough through the review resolver).
  return runPublicInstructionSeatResume(
    {
      runId: admitted.runId,
      runDirectory: admitted.runDirectory,
      message,
      summons: { instructionEmpty: true },
    },
    next,
    io,
  );
}

/** Court continue resets the unreadable-status budget. */
function envForCourtContinue(env: InstructionSeatRunEnv): InstructionSeatRunEnv {
  return { ...env, unreadableReasksSpent: 0 };
}

/** Post-submission status reask, then audit. */
async function continueAfterPostSubmissionGuards(
  result: SeatRunResult,
  env: InstructionSeatRunEnv,
  io: CliIo,
  resumedOfficer?: AdmittedRoleInvocation,
): Promise<SeatRunResult> {
  const live = result.admitted;
  if (live === undefined || result.terminal?.roleOutcome.kind !== "accepted") return result;
  const route = POST_SUBMISSION_ROUTING[live.role];
  if (route) {
    const status = receiptStatus(result.terminal.roleOutcome.payloads?.at(-1));
    const directed = { ...result, receivedStatus: status };
    if (typeof status === "string" && route.statuses.has(status)) {
      if (AUDITED_ROLES.has(live.role)) return auditSubmittedRole(directed, status, env, io, resumedOfficer);
      result = directed;
    } else {
      // A gate summon of these seats owns the unreadable reply and its budget.
      if ((live.role === "countersign" || live.role === "secretariat") && env.parentRunPath?.trim()) return directed;
      const next = withUnreadableReask(env);
      if (!next) return { ...directed, terminal: await presentUnsettledVolume(result.terminal, io, live.runDirectory) };
      await presentSeatVolume(result, io, "discarded");
      return reaskUnreadablePostSubmissionStatus(live, route.reask ?? officerConclusionReask(status), next, io);
    }
  }
  await presentSeatVolume(result, io, "returned");
  return result;
}

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
    admittedSeatTurnDetails(admitted, options.home, options.host),
    options,
  );
}

/**
 * Without a gate's sealed receipt, the latest arrived draft of the source leg is
 * the one under review (ADR 0085). The officer reads it itself. A ledger fault is
 * reported on its own; it does not discard a draft the leg's files still locate.
 */
async function latestAuditedReceipt(
  sourceRunDirectory: string,
  projectRoot: string,
  home: string,
  faults: string[],
) {
  const runId = runIdFromRunDirectory(sourceRunDirectory);
  if (runId === undefined) return undefined;
  // Bind to the already-resolved source directory — never re-discover by runId
  // alone (another book may lawfully share the same id; #637 / #1166).
  const { rows, fault, discoveryFault, missingReference } = await readRecordedSubmissionRows(projectRoot, runId, {
    home,
    sessionParent: sessionFileOf(sourceRunDirectory),
  });
  for (const issue of [fault, discoveryFault, missingReference]) if (issue) faults.push(issue.diagnostic);
  // #1166 J10: the latest arrived draft is the current manuscript. Never filter by
  // accepted / terminal outcome kind (that resurrects a prior sealed draft).
  return rows.at(-1);
}

/**
 * The address of the receipt under review (owner d634a8d9 a1119106 / 61cda71b):
 * a review seat's first sentence when no reask or caller dispatch takes its place,
 * gate and direct calls alike. It rides the dialogue, not startup material, so a
 * re-summoned officer's resumed session still receives this round's receipt.
 */
function reviewAddress(officer: AdmittedRoleInvocation): string | undefined {
  const source = admittedSourceRunPath(officer);
  const identity = source === undefined ? undefined : auditedRunIdentityFromDirectory(source);
  if (identity === undefined || officer.auditedReceipt === undefined) return undefined;
  return `请审 ${identity} 的第 ${basename(officer.auditedReceipt, ".json")} 份回执。`;
}

/**
 * One delivery rule for review-seat dialogue on new turns and same-parent resume
 * (#1166 / ADR 0085 / ADR 0087 / #1208): named operational reasks ride
 * reviewReask (first-mint / gate) or the resume request message seam. Notary
 * takes no caller review prompt; other seats keep caller dispatch as-is. Otherwise
 * the dialogue is the address of the receipt under review, once it is pinned.
 */
export function resolveReviewSeatDialogueBody(input: {
  readonly role?: string;
  readonly reviewReask?: string;
  readonly callerInstruction?: string;
  readonly address?: string | undefined;
}): string | undefined {
  if (input.role === "notary") return input.reviewReask ?? input.address;
  if (input.reviewReask !== undefined && input.reviewReask.length > 0) return input.reviewReask;
  const caller = input.callerInstruction ?? "";
  return caller.length > 0 ? caller : input.address;
}

/**
 * Initial host prompt for this turn (#1199: progress instruction = these bytes).
 */
function resolveInitialTurnPrompt(
  admitted: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
  summons?: SameTicketSummonsMaterials,
): string {
  const record = roleRecord(admitted.role);
  if ("reaskPrompt" in record && record.reaskPrompt === true) {
    const instruction = summons && !summons.instructionEmpty ? summons.instruction : resolveReviewSeatDialogueBody({
      ...env, role: admitted.role, callerInstruction: summons ? "" : admitted.instruction ?? "", address: reviewAddress(admitted),
    });
    // #1166 J11: merge existing file-flag delivery — never early-return body alone
    // when caller attach paths were admitted. Gate with no file flags stays body-only.
    if (instruction !== undefined) {
      return appendCallerFileFlagPaths(instruction, admitted.attachments);
    }
  }
  return buildInstructionTransportPrompt(admitted);
}

/** Restore this leg's volume, including a read failure. The caller decides whose result to return. */
async function recoverSeatTerminal(admitted: AdmittedRoleInvocation, env: InstructionSeatRunEnv, io: CliIo,
  binding: Pick<SettlementCourtScope, "courtAttemptId" | "seal" | "previewOnly"> | undefined): Promise<TerminalResult | undefined> {
  const scope = { ...(binding ?? { seal: "latest" as const }), notePackageFault: packageFaultNoteFor(admitted, env, io) };
  return trySettlePublicSeat(admitted, env.principalAuthority, scope, io);
}

function seatAdapters(
  admitted: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
  io: CliIo,
): PostAdmissionAdapters<AdmittedRoleInvocation> {
  const record = roleRecord(admitted.role);
  const present = "presentSettled" in record ? record.presentSettled : "default";
  return {
    trySettle: preparePublicSeat,
    ...(present === "always" ? { shouldPresentSettled: () => true } : {}),
    ...(present === "typed"
      ? { shouldPresentSettled: (terminal: TerminalResult) => isLawfulTypedTerminalOutcome(terminal.roleOutcome) }
      : {}),
    ...(packagedBindsBoardTicket(admitted.role)
      ? {
        beforeDispatch: async (seat: AdmittedRoleInvocation, lease?: RunWriterLease) => {
          if (env.correlationId !== undefined && env.correlationId.trim() !== "") {
            await recordAdmittedCorrelation(seat, env.correlationId);
          }
          await bindDiaristBoardTicket(seat, undefined, packageFaultNoteFor(seat, env, io));
          await relocateAdmittedRunToTicket(seat, env.principalAuthority, lease);
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
  summons?: SameTicketSummonsMaterials,
): Promise<SeatRunResult> {
  const record = roleRecord(admitted.role);
  await warnMissingMethodSkills(env.home, env.host, admitted.role, requiredMethodSkills(admitted), io.stdout);
  const adapters = seatAdapters(admitted, env, io);
  const execute = async (activeEnv: InstructionSeatRunEnv): Promise<SeatRunResult> => {
    if (activeEnv.correlationId !== undefined && activeEnv.correlationId.trim() !== "") {
      await recordAdmittedCorrelation(admitted, activeEnv.correlationId);
    }
    const initialPrompt = resolveInitialTurnPrompt(admitted, activeEnv, summons);
    const auto = "inCallAutoResume" in record && record.inCallAutoResume === true;
    if (auto) {
      // #1208: auto-resume resends this turn's actual content, never a filler phrase.
      return await runPostAdmissionResumable({
        admitted,
        env: activeEnv,
        io,
        buildInitialRequest: () => buildInstructionSeatTurnRequest(
          admitted,
          roleTurnOptions(activeEnv, admitted, {
            kind: "initial",
            prompt: initialPrompt,
          }),
        ),
        buildResumeRequest: () => buildInstructionSeatTurnRequest(
          admitted,
          roleTurnOptions(activeEnv, admitted, {
            kind: "resume",
            prompt: initialPrompt,
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
        roleTurnOptions(activeEnv, admitted, {
          kind: "initial",
          prompt: initialPrompt,
        }),
      ),
      adapters,
      ...(activeEnv.engine === undefined ? {} : { effectiveEngine: activeEnv.engine }),
    });
  };
  return continueAfterPostSubmissionGuards(await execute(env), env, io);
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
    ...(env.hostAdapters === undefined ? { roleTurnHost: env.roleTurnHost } : {}),
    ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
    principalAuthority: env.principalAuthority,
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    io: { callerDiagnostic: io.callerDiagnostic ?? io.stderr },
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
  const childRunDirectory = children.completeness.admitted?.runDirectory ?? children.correctness.admitted?.runDirectory;
  if (childRunDirectory !== undefined) await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, childRunDirectory);
  else io.stdout(formatTerminalResult(terminal));
  return { exitCode: failed ? 1 : 0, terminal };
}

/**
 * #1200: every officer admission that names an audited leg — gate summons and
 * a caller's own `--source-run`, first mint and re-summons alike — pins
 *「审 谁#轮」before the officer runs, in the same page write as the source
 * path when this admission is the one that records it. A receipt or row that
 * cannot be read keeps its cause on the officer run; the officer still runs.
 * A located arrival keeps only its own round; when none can be located at all,
 * the leg's latest progress row names the round.
 */
async function pinAuditedLegAtAdmission(
  officer: AdmittedRoleInvocation,
  auditedRunDirectory: string,
  gateFiled: TerminalReceiptRef | undefined,
  io: CliIo,
  home: string,
  source?: { readonly sourceRunPath: string; readonly auditorSubject?: "judge" | "doctor" | undefined },
): Promise<void> {
  const faults: string[] = [];
  const filed = gateFiled ?? await latestAuditedReceipt(auditedRunDirectory, officer.projectRoot, home, faults)
    .catch((error: unknown) => { faults.push(`audited receipt unavailable for ${auditedRunDirectory}: ${errorText(error)}`); return undefined; });
  const auditedReceipt = filed && basename(filed.receipt);
  const round = filed?.round;
  const seat = round && roleFromRunDirectory(auditedRunDirectory);
  const { for: auditedRound, fault } = seat
    ? { for: `${seat}#${round}`, fault: undefined }
    : readAuditedRound(auditedRunDirectory, auditedReceipt);
  if (fault !== undefined) faults.push(fault);
  persistAdmittedAuditedLeg(officer.runDirectory, { for: auditedRound, auditedReceipt, ...source });
  officer.auditedReceipt = auditedReceipt;
  officer.auditedRound = auditedRound;
  for (const diagnostic of faults) {
    await retainPackageFault({ runDirectory: officer.runDirectory, diagnostic, io });
  }
}

/**
 * One same-parent lookup. Seat branches still build their own summons.
 * A found child resumes that child. No prior run, explicit new, or a typed
 * session-id-missing resume (失败照记，记完再起新) returns undefined so the caller mints.
 */
function resumeSameParentInstructionSeat(input: {
  readonly env: InstructionSeatRunEnv;
  readonly io: CliIo;
  readonly projectRoot: string;
  readonly role: PackagedRole;
  readonly parentRunPath: string;
  readonly summons: SameTicketSummonsMaterials;
  readonly ticketNumber?: number;
}): Promise<SeatRunResult | undefined> {
  return tryResumeSameTicketSeatRun({
    home: input.env.home,
    io: input.io,
    projectRoot: input.projectRoot,
    role: input.role,
    parentRunPath: input.parentRunPath,
    ...(input.ticketNumber === undefined ? {} : { ticketNumber: input.ticketNumber }),
    freshSummons: input.env.freshSummons,
    summons: input.summons,
    resume: (runId, materials, runDirectory) => {
      // Named operational reask on this summon: explicit message seam.
      // Review dialogue stays on summons → shared resolver (notary: fixed).
      // Do not stuff reask into summons.instruction for later passthrough.
      const reask = input.env.reviewReask;
      return runPublicInstructionSeatResume(
        {
          runId,
          runDirectory,
          ...(reask === undefined ? {} : { message: reask }),
          ...(materials === undefined ? {} : { summons: materials }),
        },
        input.env,
        input.io,
        input.parentRunPath,
      );
    },
  });
}

/**
 * Same delivery rule as resolveInitialTurnPrompt for same-parent resume summons.
 * Shared resolver owns the input choice — callers only pass env fields.
 */
function sameParentDialogue(
  env: Pick<InstructionSeatRunEnv, "reviewReask">,
  instruction: string | undefined,
  role: string,
) {
  const body = resolveReviewSeatDialogueBody({ ...env, role, callerInstruction: instruction ?? "" });
  return { instruction: body ?? "", instructionEmpty: body === undefined };
}

/**
 * Countersign on the shared entry: gate parent resume, deferred materialization,
 * then the same one-shot settlement as every other seat.
 */
async function runCountersignBody(
  parsed: PublicSeatParse,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult> {
  const projectRoot = resolve(parsed.project ?? env.cwd);
  const gateParentRunPath =
    typeof env.parentRunPath === "string" && env.parentRunPath.trim() !== ""
      ? env.parentRunPath
      : undefined;
  let summons: SameTicketSummonsMaterials | undefined;
  if (gateParentRunPath !== undefined) {
    // #1208 C1: same shared dialogue resolver as every other same-parent seat.
    const dialogue = sameParentDialogue(env, parsed.instruction, "countersign");
    summons = {
      sourceRunPath: gateParentRunPath,
      ...dialogue,
      attachmentPaths: parsed.attachmentPaths ?? [],
    };
    const resumed = await resumeSameParentInstructionSeat({
      env,
      io,
      projectRoot,
      role: "countersign",
      parentRunPath: gateParentRunPath,
      ...(isSafePositiveTicketNumber(env.boundTicketNumber)
        ? { ticketNumber: env.boundTicketNumber }
        : {}),
      summons,
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
    {
      const materializeAdmission = async (ticketNumber?: number): Promise<void> => {
        await materializeCountersignInvocation(admitted, {
          home: env.home,
          principalAuthority: env.principalAuthority,
          attachmentPaths: parsed.attachmentPaths ?? [],
          ...(env.model === undefined ? {} : { model: env.model }),
          ...(ticketNumber === undefined ? {} : { ticketNumber }),
        });
      };

      await materializeAdmission(
        isSafePositiveTicketNumber(env.boundTicketNumber) ? env.boundTicketNumber : undefined,
      );
      await markRunAdmitted(admitted, env.principalAuthority);
      if (gateParentRunPath !== undefined) {
        await pinAuditedLegAtAdmission(admitted, gateParentRunPath, env.auditedReceipt, io, env.home, {
          sourceRunPath: gateParentRunPath,
        });
        admitted = { ...admitted, sourceRunPath: gateParentRunPath };
      }
      // #1208 C1 / #1166 J11: one shared initial-prompt seam (incl. file flags).
      const turnProjection = roleTurnOptions(env, admitted, {
        kind: "initial",
        prompt: resolveInitialTurnPrompt(admitted, env, summons),
      });
      const result = await runPostAdmissionOneShot({
        admitted,
        env,
        io,
        request: buildInstructionSeatTurnRequest(admitted, turnProjection),
        adapters: {
          ...seatAdapters(admitted, env, io),
          beforeDispatch: async (admittedSeat, lease) => {
            await relocateAdmittedRunToTicket(admittedSeat, env.principalAuthority, lease);
          },
        },
        ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
      });
      return continueAfterPostSubmissionGuards(result, env, io);
    }
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
  let source: NotarySourceRunLocator | undefined;
  let summons: SameTicketSummonsMaterials | undefined;
  if (record.sameParent === "subject-source") {
    if (parsed.subject === undefined) {
      presentStructuralRejection(new CliUsageError("auditor --subject requires judge|doctor"), io);
      return { exitCode: 2 };
    }
    auditorSubject = parsed.subject;
    if (parsed.sourceRun === undefined) {
      presentStructuralRejection(new CliUsageError("auditor --source-run requires a run locator"), io);
      return { exitCode: 2 };
    }
  }
  if (auditorSubject || record.sameParent === "source-locator" || (record.sameParent === "source-run" && parsed.sourceRun !== undefined)) {
    try {
      const { filed, ...located } = await resolveNotarySourceRunLocator({
        projectRoot,
        sourceRun: parsed.sourceRun ?? "",
        home: env.home,
      });
      source = located;
      // A round the caller named pins that receipt; a gate's own seal stays first.
      if (filed && env.auditedReceipt === undefined) env = { ...env, auditedReceipt: filed };
    } catch (error) {
      if (auditorSubject) {
        presentStructuralRejection(new CliUsageError(errorText(error)), io);
        return { exitCode: 2 };
      }
      if (error instanceof NotarySourceRunError) {
        presentStructuralRejection(new CliUsageError(error.message, { cause: error }), io);
        return { exitCode: 2 };
      }
      throw error;
    }
    const parentRunPath = source.runDirectory;
    const dialogue = sameParentDialogue(env, parsed.instruction, role);
    const materials = {
      ...dialogue,
      ...(auditorSubject ? {} : { sourceRunPath: parentRunPath }),
      ...(record.sameParent === "source-locator" ? { sourceRun: source } : { attachmentPaths: parsed.attachmentPaths ?? [] }),
    };
    summons = materials;
    const resumed = await withAuditorSoulEnv({
      ...(auditorSubject && { subject: auditorSubject, sourceRunDirectory: parentRunPath }),
      run: () => resumeSameParentInstructionSeat({ env, io, projectRoot, role, parentRunPath, summons: materials }),
    });
    if (resumed != null) return resumed;
  }

  let admitted: AdmittedRoleInvocation;
  try {
    // Only a new auditor needs the source ticket for initial placement.
    let auditorTicket: number | undefined;
    if (auditorSubject && source) {
      try { auditorTicket = await readBoardTicketNumber(source.runDirectory); }
      catch (cause) { throw new CliUsageError(errorText(cause)); }
    }
    admitted = await admitPublicRole(role, parsed, env, {
      ...(auditorTicket !== undefined && { assertedTicketNumber: auditorTicket }),
      ...(record.sameParent === "source-locator" && source && { resolvedSourceRun: source }),
    });
  } catch (error) {
    const rejected = usageExit(error, io);
    if (rejected !== undefined) return rejected;
    throw error;
  }

  if (source) {
    const sourceRunPath = source.runDirectory;
    await pinAuditedLegAtAdmission(admitted, sourceRunPath, env.auditedReceipt, io, env.home,
      record.sameParent === "source-locator" ? undefined : { sourceRunPath, auditorSubject });
    admitted = { ...admitted, sourceRunPath } as AdmittedRoleInvocation;
    // Source-run admission gains its source here. The locator and subject seats
    // already placed their new leg using that source, including an unbound one.
    if (record.sameParent === "source-run") admitted = await inheritKnownTicketFromSource(admitted, env.principalAuthority);
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
          attachmentPaths: admitted.attachments.map((attachment) => attachment.path),
          correlationId: admitted.runId,
        }, env, io);
      } catch (error) {
        return await presentControlledFailure(admitted, {
          timedOut: false, code: null, stderr: "", thrown: error,
        }, seatAdapters(admitted, env, io), env.principalAuthority, io, true,
          packageFaultNoteFor(admitted, env, io)) as SeatRunResult;
      }
      if (outcome.admitted !== undefined && isUnboundRunDirectory(outcome.admitted.runDirectory)) {
        const diaristRunId = outcome.admitted.runId;
        await besideConclusion(packageFaultNoteFor(admitted, env, io), "diarist run record", () => recordChildDiaristRun(admitted, diaristRunId));
      }
      if (outcome.failedWithoutEscalate !== undefined) {
        return await presentControlledFailure(admitted, {
          timedOut: false, code: null, stderr: "",
          thrown: new Error(outcome.failedWithoutEscalate.diagnostic),
        }, seatAdapters(admitted, env, io), env.principalAuthority, io, true,
          packageFaultNoteFor(admitted, env, io)) as SeatRunResult;
      }
      // The diarist's escalation pauses only the diarist's own run; call order
      // belongs to the caller, so the Secretariat still takes its own turn.
      if (outcome.identity.kind === "escalate" && outcome.terminal !== undefined) {
        await presentTerminal(outcome.terminal, { ...io, omitFailureStderrDiagnostic: true }, outcome.admitted?.runDirectory ?? admitted.runDirectory, "alongside");
      }
    }
    return dispatchAdmitted(admitted, env, io, summons);
  };

  if (record.sameParent === "subject-source") {
    return withAuditorSoulEnv({
      ...(auditorSubject === undefined ? {} : { subject: auditorSubject }),
      ...(source && { sourceRunDirectory: source.runDirectory }),
      run: runAdmitted,
    });
  }
  return runAdmitted();
}

/**
 * #1208 C2: same as new source-locator admission — when this leg is still
 * unbound, inherit the board ticket already on the audited source and relocate.
 * True no-ticket sources stay unbound so #1171 still asks once.
 */
async function inheritKnownTicketFromSource(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
): Promise<AdmittedRoleInvocation> {
  if (admitted.ticketNumber !== undefined) return admitted;
  const sourcePath = admittedSourceRunPath(admitted);
  if (sourcePath === undefined) return admitted;
  const sourceTicket = await readBoardTicketNumber(sourcePath);
  if (sourceTicket === undefined) return admitted;
  await bindAdmittedTicketNumber(admitted, sourceTicket);
  await relocateAdmittedRunToTicket(admitted, authority);
  return admitted;
}

export async function runPublicInstructionSeatResume(
  request: PublicResumeRequest,
  env: InstructionSeatRunEnv,
  io: CliIo,
  /** #1200: the audited leg a same-parent re-summons names; absent on every other resume. */
  resummonedFor?: string,
  restored?: LoadedResumablePublicRole,
): Promise<SeatRunResult> {
  const restoration = restored ?? loadResumablePublicRole(env.home, request.runId, env.principalAuthority, request);
  const resume = async () => {
    const result = await runPostAdmissionSeatResume<AdmittedRoleInvocation>({

    request,
    env,
    io,
    load: async (effective) => {
      const loaded = await restoration;
      let admitted = loaded.admitted;
      if (
        packagedRebindSourceOnResume(admitted.role)
        && effective.summons?.sourceRunPath !== undefined
        && effective.summons.sourceRun !== undefined
      ) {
        // source-locator seats only (notary); sourceRun is on that admission face.
        admitted = {
          ...admitted,
          sourceRunPath: effective.summons.sourceRunPath,
          sourceRun: effective.summons.sourceRun,
        } as AdmittedRoleInvocation;
      }
      admitted = await inheritKnownTicketFromSource(admitted, env.principalAuthority);
      return { admitted };
    },
    buildTurnRequest: async (admitted, effective) => {
      // #1200: the turn is built once this leg has taken the summons — inside
      // its writer lease wherever the resume holds one — and before the host
      // turn. A summons the lease refuses never gets here and pins nothing.
      if (resummonedFor !== undefined) {
        await pinAuditedLegAtAdmission(admitted, resummonedFor, env.auditedReceipt, io, env.home);
      }
      const summonsPrepared = await prepareSummonsResumeMaterials(admitted.runDirectory, effective.summons);
      const projection = resumeTurnRequestProjectionOptions(
        admitted, effective, env, summonsPrepared,
      );
      // #1208: internal summons only — shared resolver owns review dialogue.
      // Bare resume and explicit messages need no selection (#1208 R1).
      if (effective.summons === undefined || effective.message !== undefined) {
        return buildInstructionSeatTurnRequest(admitted, { ...projection });
      }
      const sourceRunPath = admittedSourceRunPath(admitted);
      const { instruction: body, instructionEmpty } = sameParentDialogue({}, summonsPrepared?.instruction, admitted.role);
      // An empty dialogue is the address of the receipt under review, pinned for this court.
      if (instructionEmpty && resummonedFor === undefined && sourceRunPath) {
        await pinAuditedLegAtAdmission(admitted, sourceRunPath, undefined, io, env.home);
      }
      const dialogue = instructionEmpty ? reviewAddress(admitted) : body;
      if (dialogue === undefined) return buildInstructionSeatTurnRequest(admitted, { ...projection });
      const fileFlags = summonsPrepared?.attachments ?? [];
      return buildInstructionSeatTurnRequest(admitted, {
        ...projection,
        continuation: { kind: "resume", prompt: fileFlags.length === 0 ? dialogue : appendCallerFileFlagPaths(dialogue, fileFlags) },
      });
    },
    adapters: {
      trySettle: async () => undefined,
    },
    afterAdmittedLoad: async (admitted) => {
      await warnMissingMethodSkills(env.home, env.host, admitted.role, requiredMethodSkills(admitted), io.stdout);
      return { kind: "continue" as const, adapters: seatAdapters(admitted, env, io) };
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
    });
    return continueAfterPostSubmissionGuards(result, env, io);
  };
  let loaded: LoadedResumablePublicRole;
  try {
    loaded = await restoration;
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    // The seat loader delivers this rejection through its existing resume-failure path.
    return resume();
  }
  const binding = loaded.admitted.role === "auditor"
    ? auditorResumeBinding(loaded.auditorSubject, admittedSourceRunPath(loaded.admitted))
    : undefined;
  return withAuditorSoulEnv({ ...binding, run: resume });
}

const GATE_CHILD_ROLES = new Set(["notary", "auditor", "inspector", "countersign"]);

/** Continue the parent once a child has submitted. The child words ride the existing resume. */
export async function continueParentAfterChild(
  loaded: LoadedResumablePublicRole,
  child: AdmittedRoleInvocation,
  childTerminal: TerminalResult,
  status: unknown,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult> {
  const admitted = loaded.admitted;
  if (loaded.run.state !== "admitted" && !AUDITED_ROLES.has(loaded.admitted.role)) {
    return runPublicInstructionSeatResume(
      {
        runId: admitted.runId,
        runDirectory: admitted.runDirectory,
      },
      env, io, undefined, loaded,
    );
  }
  if (GATE_CHILD_ROLES.has(child.role) && (status === "continue" || status === "converged")) {
    const payload = currentReplyRows(childTerminal).at(-1);
    if (AUDITED_ROLES.has(admitted.role) && status === "converged") {
      // Recover the parent's own seal, not the seal a possibly stale child reviewed.
      const terminal = await recoverSeatTerminal(admitted, env, io, loaded.currentCourt);
      if (terminal?.roleOutcome.kind === "failure") {
        await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, admitted.runDirectory);
        return { exitCode: 1, admitted, terminal };
      }
      if (terminal?.roleOutcome.kind !== "accepted") throw new Error("pending submission is not recorded");
      // Only the officer for this parent seal can discharge its gate.
      const parent = terminal.receipts?.at(-1);
      const passed = parent && payload !== undefined && matchesAuditedSeal({ receipt: child.auditedReceipt }, parent);
      return continueAfterPostSubmissionGuards(
        { exitCode: 0, admitted, terminal },
        env,
        io,
        passed ? child : undefined,
      );
    }
    return runPublicInstructionSeatResume({
      runId: admitted.runId,
      runDirectory: admitted.runDirectory,
      summons: { instruction: readableGateItem(payload) },
    }, envForCourtContinue(env), io, undefined, loaded);
  }
  const result = await dispatchAdmitted(admitted, env, { ...io, omitFailureStderrDiagnostic: true });
  showResumeErrorPointer(io, result.exitCode, result.terminal);
  return result;
}

/**
 * Gate already satisfied for this routing turn when continueParentAfterChild
 * handed a live converged child that belongs to this parent seal, or — for a
 * multi-gate chain on that same seal — an earlier gate before that child
 * (ADR 0003 remaining gates). Parent-side officer pointers are not consulted (#1195).
 */
function officerSatisfiedByLiveChild(
  officer: GateOfficer,
  resumedOfficer: AdmittedRoleInvocation | undefined,
  /** Ordered officers of this parent's gate chain; earlier than live child = done. */
  chainOrder?: readonly GateOfficer[],
): boolean {
  if (resumedOfficer === undefined) return false;
  if (resumedOfficer.role === officer) return true;
  if (chainOrder === undefined) return false;
  const childIndex = chainOrder.indexOf(resumedOfficer.role as GateOfficer);
  const officerIndex = chainOrder.indexOf(officer);
  return childIndex >= 0 && officerIndex >= 0 && officerIndex < childIndex;
}

/** Finished submissions enter the existing audit gate after their tool call has returned. */
async function auditSubmittedRole(
  turn: SeatRunResult,
  status: string,
  env: InstructionSeatRunEnv,
  io: CliIo,
  resumedOfficer?: AdmittedRoleInvocation,
): Promise<SeatRunResult> {
  const admitted = turn.admitted;
  if (admitted === undefined || turn.terminal?.roleOutcome.kind !== "accepted") return turn;
  const accepted = turn.terminal.roleOutcome.payloads?.at(-1);
  if (accepted === undefined) throw new Error("accepted submission has no payload");
  // Self-escalation is a valid open routing state for these seats only.
  // Doctor's declared domain is completed|refused — an open "escalate" must
  // not skip its mandatory auditor (#1057 / PR #1075).
  const selfEscalationSkipsAudit = status === "escalate"
    && (admitted.role === "judge" || admitted.role === "secretariat"
      || admitted.role === "countersign");
  const skipAudit = selfEscalationSkipsAudit
    || ((admitted.role === "fixer" || admitted.role === "coder")
      && !WORKER_DONE_STATUSES.has(status));
  if (skipAudit) {
    await presentTerminal(turn.terminal, { ...io, omitFailureStderrDiagnostic: true }, admitted.runDirectory);
    return turn;
  }
  // #1171 F2-R8: bind audit to the sealed identity carried on this turn's
  // settlement terminal — never the whole-leg latest accepted row (another
  // lawful public call may have sealed and passed台院 meanwhile).
  const filed = turn.terminal.receipts?.at(-1);
  if (!filed) throw new Error("accepted submission has no sealed receipt reference");
  const gateSatisfied = (officer: GateOfficer, chainOrder?: readonly GateOfficer[]) =>
    officerSatisfiedByLiveChild(officer, resumedOfficer, chainOrder);
  if (admitted.role === "doctor") {
    if (!gateSatisfied("auditor")) {
      let lastSummon: PublicSummonResult | undefined;
      let decision: ComplianceDecision;
      try {
        const sessionFile = env.principalAuthority.decode(admitted.principal).sessionFile;
        const entries = await readBoundSessionEntries(sessionFile);
        const context: HostContext = {
          cwd: admitted.projectRoot, mode: "print", model: undefined, runDirectory: admitted.runDirectory,
          sessionManager: {
            getSessionFile: () => sessionFile, getSessionDir: () => dirname(sessionFile),
            getEntries: () => entries as unknown as Iterable<{ type: string }>,
            getLeafEntry: () => undefined, getLeafId: () => admitted.runId,
            getHeader: () => ({ type: "session", id: admitted.runId }),
          },
          abort() {},
        };
        decision = await createPiDoctorAuditor()({
          context,
          ...(env.autoResumeLimit === undefined ? {} : { autoResumeLimit: env.autoResumeLimit }),
          ...(env.signal === undefined ? {} : { signal: env.signal }),
          summonAuditor: async (subject, sourceRunDirectory, signal, reask) => {
            await presentSeatVolume(lastSummon, io, "discarded");
            const summoned = await summonPublicRole({
              role: "auditor",
              io: { callerDiagnostic: io.callerDiagnostic ?? io.stderr },
              argv: ["--subject", subject, "--source-run", sourceRunDirectory],
              cwd: admitted.projectRoot, home: env.home, packageRoot: env.packageRoot,
              principalAuthority: env.principalAuthority,
              correlationId: admitted.runId, auditedReceipt: filed,
              ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
              ...(env.hostAdapters === undefined ? { roleTurnHost: env.roleTurnHost } : { hostAdapters: env.hostAdapters }),
              ...(signal === undefined ? {} : { signal }),
              ...(reask === undefined ? {} : { reviewReask: reask }),
            });
            lastSummon = summoned;
            return summoned;
          },
        });
      } catch (error) {
        // The doctor's submission is in hand. An audit that throws is a transport
        // failure, as on every other gate (gatekeeper-role summon).
        lastSummon = undefined;
        decision = { status: "transport_failure", diagnostic: serializeThrownValue(error) };
      }
      if (decision.status === "continue" || decision.status === "converged") await presentSeatVolume(lastSummon, io, "discarded");
      if (decision.status === "continue") {
        await presentSeatVolume(turn, io, "discarded");
        return runPublicInstructionSeatResume({
          runId: admitted.runId,
          runDirectory: admitted.runDirectory,
          summons: { instruction: readableGateItem(decision.receipt ?? decision.violations) },
        }, envForCourtContinue(env), io);
      }
      if (decision.status === "received") {
        if (lastSummon?.terminal !== undefined) {
          // #1214 F1: present audited original and officer scene separately.
          await presentSeatVolume(turn, io, "alongside");
          const officerAdmitted = lastSummon.admitted;
          const officerDir = officerAdmitted?.runDirectory ?? lastSummon.runDirectory ?? admitted.runDirectory;
          const terminal = await presentUnsettledVolume(lastSummon.terminal, io, officerDir);
          return {
            exitCode: 0,
            receivedStatus: decision.receivedStatus,
            ...(officerAdmitted === undefined ? { admitted } : { admitted: officerAdmitted }),
            terminal,
          };
        }
        // #1214 A12/F1: present parent original; do not forge success.
        return incompleteAuditWithoutOfficerVolume(
          turn,
          admitted,
          io,
          "doctor audit kept an unreadable reply with no terminal",
        );
      }
      if (decision.status !== "converged") {
        // #1214 A5/A12/F1: present parent original and officer scene; keep honest identity.
        if (lastSummon?.terminal !== undefined) {
          await presentSeatVolume(turn, io, "alongside");
          await presentTerminal(lastSummon.terminal, { ...io, omitFailureStderrDiagnostic: true }, lastSummon.admitted?.runDirectory ?? admitted.runDirectory);
          return { ...lastSummon,
            ...(lastSummon.admitted === undefined ? {} : { admitted: lastSummon.admitted }),
            terminal: lastSummon.terminal };
        }
        const diagnostic = decision.status === "transport_failure"
          && "diagnostic" in decision
          && typeof decision.diagnostic === "string"
          ? decision.diagnostic
          : `doctor audit did not converge: ${decision.status}`;
        return incompleteAuditWithoutOfficerVolume(turn, admitted, io, diagnostic);
      }
    }
  } else {
    const summonOfficer = createDefaultGateOfficerSummon({
      io: { callerDiagnostic: io.callerDiagnostic ?? io.stderr },
      auditedReceipt: filed,
      cwd: admitted.projectRoot,
      home: env.home,
      packageRoot: env.packageRoot,
      roleTurnHost: env.roleTurnHost,
      ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
    });
    let pass: Awaited<ReturnType<typeof runJudgeGates>>;
    const runGate = (subject: Parameters<typeof requireSubmissionGate>[0]["subject"]) =>
      requireSubmissionGate({
        context: { cwd: admitted.projectRoot }, runDirectory: admitted.runDirectory,
        subject,
        submission: accepted,
        summonOfficer,
        onDiscard: (seat) => presentSeatVolume(seat, io, "discarded"),
        ...(env.autoResumeLimit === undefined ? {} : { autoResumeLimit: env.autoResumeLimit }),
        ...(env.signal === undefined ? {} : { signal: env.signal }),
      });
    if (admitted.role === "judge") {
      // Same order as runJudgeGates — sole source JUDGE_GATES + gateOfficerForSubject.
      const judgeGateOrder = JUDGE_GATES.map(gateOfficerForSubject);
      pass = await runJudgeGates({
        gateAlreadyConverged: (subject) =>
          gateSatisfied(gateOfficerForSubject(subject), judgeGateOrder),
        runGate,
      });
    } else {
      const subject = admitted.role === "fixer" || admitted.role === "coder"
        ? { kind: "worker_completion" as const }
        : admitted.role === "secretariat"
          ? { kind: "secretariat_verdict" as const }
          : { kind: "countersign_verdict" as const };
      if (!gateSatisfied(gateOfficerForSubject(subject))) pass = await runGate(subject);
    }
    const officer = pass?.admitted;
    if (
      pass?.status === "needs_reask"
      || pass?.status === "transport_failure"
      || pass?.status === "no_receipt"
    ) {
      const officerTerminal = pass.terminal;
      if (officerTerminal !== undefined && officer !== undefined) {
        // #1214 F1: present audited original and officer scene separately.
        // The terminal and admission belong to the same call, even after a new summons.
        const alongside = await presentAlongside(turn, pass.alongside, io);
        if (pass.status !== "transport_failure") {
          // Lawful incomplete (unreadable / no_receipt): exit 0, direction unsettled.
          const terminal = await presentUnsettledVolume(
            officerTerminal,
            io,
            officer.runDirectory,
          );
          return { exitCode: 0, admitted: officer, terminal, alongside,
            ...("receivedStatus" in pass && { receivedStatus: pass.receivedStatus }) };
        }
        // #1214 A5: officer failure volume after parent original; honest non-pass identity.
        await presentTerminal(
          officerTerminal,
          { ...io, omitFailureStderrDiagnostic: true },
          officer.runDirectory,
        );
        return {
          exitCode: officerTerminal.roleOutcome.kind === "failure" ? 1 : 0,
          admitted: officer,
          terminal: officerTerminal,
          alongside,
        };
      }
      // No officer volume. Present parent original; diagnostic; do not forge success.
      return incompleteAuditWithoutOfficerVolume(
        turn,
        admitted,
        io,
        pass.reason
          ?? (pass.status === "transport_failure"
            ? "audit officer transport failure with no presentable volume"
            : pass.status === "no_receipt"
              ? "audit officer no_receipt with no presentable volume"
              : "unreadable audit has no terminal result"),
        pass.alongside,
      );
    }
    if (pass?.status === "escalate") {
      // An escalation always carries the officer's own terminal (gatekeeper-role); it is presented as returned.
      // Other-seat tables stay on the officer run — parent does not attach copies (#1195).
      const terminal = pass.terminal;
      if (officer === undefined || terminal === undefined) {
        return incompleteAuditWithoutOfficerVolume(
          turn,
          admitted,
          io,
          "escalated audit has no resumable run identity",
        );
      }
      await presentSeatVolume(turn, io, "discarded");
      await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, officer.runDirectory);
      return { exitCode: terminal.roleOutcome.kind === "failure" ? 1 : 0, admitted: officer, terminal, receivedStatus: pass.status };
    }
    if (pass?.status === "continue") {
      await presentSeatVolume(turn, io, "discarded");
      return runPublicInstructionSeatResume({
        runId: admitted.runId,
        runDirectory: admitted.runDirectory,
        summons: { instruction: readableGateItem(pass.receipt) },
      }, envForCourtContinue(env), io);
    }
  }
  // The turn already settled this court. Gate does not project other-seat finals
  // onto the parent public terminal (#1195) — present this leg's own volume.
  await presentSeatVolume(turn, io, "returned");
  return turn;
}
