/**
 * One public role run: admit → turn request → post-admission → settle.
 * Seat differences are composition-root fields. An omitted reviewer lens
 * starts two ordinary single-axis runs here.
 */
import { basename, dirname, resolve } from "node:path";
import { isUnboundRunDirectory, sessionFileOf } from "../role-run-placement.ts";
import { createPiDoctorAuditor } from "../doctor-auditor.ts";

import type { DurablePrincipalAuthority, HostContext, RoleTurnRequest } from "../host-contracts.ts";
import { officerConclusionReask, gateOfficerForSubject, type GateOfficer } from "../gatekeeper-role.ts";
import { REVIEW_QUEUE_STATUSES } from "../review-submission.ts";
import { JUDGE_GATES, runJudgeGates } from "../judge-role.ts";
import { WORKER_DONE_STATUSES } from "../worker-submission-contracts.ts";
import { readableGateItem } from "../readable-gate-item.ts";
import { deliveryLimitFromConfig } from "../receipt-delivery-policy.ts";
import { runIdFromRunDirectory } from "../run-terminal-artifacts.ts";
import { createDefaultGateOfficerSummon, requireSubmissionGate } from "../submission-gate.ts";
import { readReceipt, readRecordedSubmissionRows } from "../submission-ledger.ts";
import { summonPublicRole, type PublicSummonResult } from "../public-role-summons.ts";
import {
  latestQueuePayload,
  latestQueueStatus,
} from "../submission-gate.ts";
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
import { readAuditorResumeBinding } from "../auditor-soul.ts";
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
  packageFaultNoteFor,
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
import { presentTerminal } from "./auto-resume.ts";
import {
  loadResumablePublicRole,
  markRunAdmitted,
  readCurrentCourt,
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
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import { warnMissingMethodSkills } from "./machine-method-skills.ts";
import {
  formatTerminalResult,
  isLawfulTypedTerminalOutcome,
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
  latestPayloadEscalated,
  type CountersignRunEnv,
} from "./countersign-run.ts";
import { readAuditedRound } from "../ticket-progress.ts";
import { errorText } from "../unknown-value.ts";

export type InstructionSeatRunEnv = PostAdmissionEnv & Pick<
  CountersignRunEnv,
  "reviewReask" | "gateReviewInstruction" | "parentRunPath" | "auditedReceipt"
>;

type SeatRunResult = {
  exitCode: number;
  admitted?: AdmittedRoleInvocation;
  terminal?: TerminalResult;
};

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
  judge: {
    statuses: REVIEW_QUEUE_STATUSES,
  },
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

function unreadablePostSubmissionStatus(
  admitted: AdmittedRoleInvocation,
  terminal: TerminalResult | undefined,
): string | undefined {
  if (terminal?.roleOutcome.kind !== "accepted") return undefined;
  const route = POST_SUBMISSION_ROUTING[admitted.role];
  if (route === undefined) return undefined;
  const payload = terminal.roleOutcome.payloads?.at(-1);
  const status = receiptStatus(payload);
  return typeof status === "string" && route.statuses.has(status)
    ? undefined
    : route.reask ?? officerConclusionReask(status);
}

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

/** Budget spent on an unreadable status. Distinct from "status is readable". */
const UNREADABLE_REASK_EXHAUSTED = { unreadableReaskExhausted: true as const };

function isUnreadableReaskExhausted(
  value: SeatRunResult | typeof UNREADABLE_REASK_EXHAUSTED | undefined,
): value is typeof UNREADABLE_REASK_EXHAUSTED {
  return value === UNREADABLE_REASK_EXHAUSTED;
}

async function presentOriginalVolume(
  held: readonly string[],
  terminal: TerminalResult | undefined,
  io: CliIo,
  runDirectory?: string,
): Promise<void> {
  if (terminal !== undefined && runDirectory !== undefined) {
    // Direction facts were attached after the held volume was formatted.
    await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, runDirectory,
      terminal.roleOutcome.decisiveFacts?.directionUnsettled === true ? undefined : held);
    return;
  }
  // No settled host report exists to preserve at this pre-result boundary.
  for (const value of held) io.stdout(value);
}

/**
 * Mark this leg's terminal that subsequent audit did not settle a queue word.
 * Other-seat receipts / run ids stay on those runs — not copied here (#1195).
 */
function withUnsettledDirection(parent: TerminalResult): TerminalResult {
  const outcome = parent.roleOutcome;
  if (outcome.kind !== "accepted" && outcome.kind !== "audit_escalation") return parent;
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

function heldUnreadableTerminal(terminal: TerminalResult | undefined): boolean {
  if (terminal?.roleOutcome.kind !== "accepted") return false;
  if (latestPayloadEscalated(terminal.roleOutcome)) return false;
  const status = latestQueueStatus(terminal);
  return typeof status !== "string" || !REVIEW_QUEUE_STATUSES.has(status);
}

/**
 * Present the actual audit seat's volume for an unreadable conclusion (ADR 0055).
 * Parent is not given a copy of the officer receipt (#1195).
 */
async function presentUnsettledOfficer(
  officer: TerminalResult,
  io: CliIo,
  runDirectory: string,
): Promise<TerminalResult> {
  const terminal = withUnsettledDirection(officer);
  await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, runDirectory);
  return terminal;
}

/**
 * #1214 F1: present the audited seat's already-filed original on the public call.
 * Presentation only — callers keep honest exit / officer identity (不伪作通过).
 */
async function presentAuditedOriginalVolume(
  turn: SeatRunResult,
  io: CliIo,
): Promise<void> {
  const admitted = turn.admitted;
  if (turn.terminal === undefined || admitted === undefined) return;
  await presentTerminal(
    turn.terminal,
    { ...io, omitFailureStderrDiagnostic: true },
    admitted.runDirectory,
  );
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
): Promise<SeatRunResult> {
  await presentAuditedOriginalVolume(turn, io);
  io.stderr(diagnostic);
  return { exitCode: 1, admitted };
}

/**
 * #1214 R2: a gate officer's non-pass volume (failure, unreadable, no_receipt) keeps
 * its audited seat's already-filed original on the public call (被审席已交原卷照常呈出).
 * The officer keeps its own identity and exit; the audited seat is not re-run and its
 * volume is read from its own run through the settlement seam (#1195: not copied into
 * the officer's book). `presentedRunId` skips the seat the caller already presented.
 */
async function presentAuditedOriginalOfOfficer(
  officer: AdmittedRoleInvocation,
  presentedRunId: string | undefined,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<void> {
  if (!GATE_CHILD_ROLES.has(officer.role)) return;
  const audited = officer.correlationId;
  if (audited === undefined || audited === presentedRunId) return;
  const auditedSource = admittedSourceRunPath(officer);
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
  await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, parent.admitted.runDirectory);
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
  await presentAuditedOriginalOfOfficer(result.admitted, undefined, env, io);
}

async function reaskUnreadablePostSubmissionStatus(
  admitted: AdmittedRoleInvocation,
  terminal: TerminalResult | undefined,
  env: InstructionSeatRunEnv,
  io: CliIo,
  message = unreadablePostSubmissionStatus(admitted, terminal),
): Promise<SeatRunResult | typeof UNREADABLE_REASK_EXHAUSTED | undefined> {
  if (message === undefined) return undefined;
  const next = withUnreadableReask(env);
  if (next === undefined) return UNREADABLE_REASK_EXHAUSTED;
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
  admittedRole: PackagedRole,
  env: InstructionSeatRunEnv,
  io: CliIo,
  held: readonly string[],
): Promise<SeatRunResult> {
  const live = result.admitted;
  if (live === undefined) {
    await presentOriginalVolume(held, result.terminal, io);
    return result;
  }
  const unreadableReask = await reaskUnreadablePostSubmissionStatus(
    live,
    result.terminal,
    env,
    io,
  );
  let continued = result;
  if (isUnreadableReaskExhausted(unreadableReask)) {
    const terminal = result.terminal === undefined
      ? undefined
      : withUnsettledDirection(result.terminal);
    continued = terminal === undefined
      ? { ...result, admitted: live }
      : { ...result, admitted: live, terminal };
  } else if (unreadableReask !== undefined) {
    return unreadableReask;
  }
  const continuedAdmitted = continued.admitted ?? live;
  if (AUDITED_ROLES.has(admittedRole) && continued.terminal?.roleOutcome.kind === "accepted") {
    return auditSubmittedRole(
      { ...continued, admitted: continuedAdmitted },
      env,
      io,
    );
  }
  await presentOriginalVolume(
    held,
    continued.terminal,
    io,
    continuedAdmitted.runDirectory,
  );
  return { ...continued, admitted: continuedAdmitted };
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
 * Direct review-seat call: reconnect ledger peer-body delivery (ADR 0085 / #1166).
 * Gate summons already ride gateReviewInstruction; direct --source-run falls
 * through the shared dialogue resolver (notary: fixed dispatch).
 */
async function loadLedgerPeerBody(
  sourceRunDirectory: string,
  projectRoot: string,
  home: string,
) {
  const runId = runIdFromRunDirectory(sourceRunDirectory);
  if (runId === undefined) return undefined;
  // Bind to the already-resolved source directory — never re-discover by runId
  // alone (another book may lawfully share the same id; #637 / #1166).
  const { rows, fault, discoveryFault, missingReference } = await readRecordedSubmissionRows(projectRoot, runId, {
    home,
    sessionParent: sessionFileOf(sourceRunDirectory),
  });
  // ADR 0085 / #1166 J10: ledger already keeps original words for every class —
  // present the latest row as-is. Never filter current manuscript by accepted /
  // terminal outcome kind (that resurrects a prior sealed draft).
  const missing = fault ?? discoveryFault ?? missingReference;
  if (missing) throw new Error(missing.diagnostic, { cause: missing.cause });
  const latest = rows.at(-1);
  if (latest === undefined) return undefined;
  try { return { instruction: readableGateItem(readReceipt(latest)), auditedReceipt: basename(latest.receipt) }; }
  catch (cause) { throw new Error(latest.path, { cause }); }
}

/** Owner-approved fixed Notary review dispatch (2026-10-09 #1208); never the parent verdict. */
export const NOTARY_FIXED_DISPATCH = "请审本轮受审对象，按符宝郎职掌交卷。";

/**
 * One delivery rule for review-seat dialogue on new turns and same-parent resume
 * (#1166 / ADR 0085 / ADR 0087 / #1208): notary review uses fixed dispatch;
 * named operational reasks ride reviewReask (first-mint / gate) or the resume
 * request message seam — never arbitrary non-empty caller/summons passthrough.
 * Other seats prefer format reask, then gate body, then caller dispatch, then
 * ledger peer. Identity stays in startup materials. Notary never takes
 * gate/parent verdict as dialogue (gateReviewInstruction stays unread for notary).
 */
export function resolveReviewSeatDialogueBody(input: {
  readonly role?: string;
  readonly reviewReask?: string;
  readonly gateReviewInstruction?: string;
  readonly callerInstruction?: string;
}): string | undefined {
  // #1208: fixed sentence is the review function only (owner 37bfe80d /
  // 393daf98). reviewReask is the named operational override; caller/summons
  // body is not a free passthrough (countersign rejected that prescription).
  if (input.role === "notary") {
    if (input.reviewReask !== undefined) return input.reviewReask;
    return NOTARY_FIXED_DISPATCH;
  }
  const preferred = input.reviewReask ?? input.gateReviewInstruction;
  if (preferred !== undefined && preferred.length > 0) return preferred;
  const caller = input.callerInstruction ?? "";
  return caller.length > 0 ? caller : undefined;
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
    const instruction = summons ? summons.instruction : resolveReviewSeatDialogueBody({
      ...env, role: admitted.role, callerInstruction: admitted.instruction ?? "",
    });
    // #1166 J11: merge existing file-flag delivery — never early-return body alone
    // when caller attach paths were admitted. Gate with no file flags stays body-only.
    if (instruction !== undefined && !summons?.instructionEmpty) {
      return appendCallerFileFlagPaths(instruction, admitted.attachments);
    }
  }
  return buildInstructionTransportPrompt(admitted);
}

/** Restore this leg's volume, including a read failure. The caller decides whose result to return. */
async function recoverSeatTerminal(admitted: AdmittedRoleInvocation, env: InstructionSeatRunEnv, io: CliIo,
  review?: Pick<SettlementCourtScope, "seal" | "previewOnly">): Promise<TerminalResult | undefined> {
  const binding = review?.seal ? review : await readCurrentCourt(admitted.runDirectory) ?? { seal: "latest" as const };
  const scope = { ...binding, ...review, notePackageFault: packageFaultNoteFor(admitted, env, io) };
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
  const held: string[] = [];
  const turnIo: CliIo = AUDITED_ROLES.has(admitted.role)
    || POST_SUBMISSION_ROUTING[admitted.role] !== undefined
    ? { stdout: (value) => held.push(value), stderr: io.stderr }
    : io;
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
        io: turnIo,
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
      io: turnIo,
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
  const result = await execute(env);
  // Prefer the live admitted object returned from the turn (may have relocated).
  const live = result.admitted ?? admitted;
  return continueAfterPostSubmissionGuards(
    { ...result, admitted: live },
    admitted.role,
    env,
    io,
    held,
  );
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
 * path when this admission is the one that records it. A row that cannot be
 * read keeps its cause on the officer run; the officer still runs and its rows
 * carry no `for`.
 */
async function pinAuditedLegAtAdmission(
  officer: AdmittedRoleInvocation,
  auditedRunDirectory: string,
  auditedReceipt: string | undefined,
  io: CliIo,
  source?: { readonly sourceRunPath: string; readonly auditorSubject?: "judge" | "doctor" | undefined },
): Promise<void> {
  const { for: auditedRound, fault } = readAuditedRound(auditedRunDirectory, auditedReceipt);
  persistAdmittedAuditedLeg(officer.runDirectory, { for: auditedRound, auditedReceipt, ...source });
  officer.auditedReceipt = auditedReceipt;
  officer.auditedRound = auditedRound;
  if (fault === undefined) return;
  await retainPackageFault({
    runDirectory: officer.runDirectory,
    diagnostic: fault,
    stderr: (text) => io.stderr(text),
  });
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
async function sameParentDialogue(
  env: Pick<InstructionSeatRunEnv, "home" | "gateReviewInstruction" | "reviewReask" | "auditedReceipt">,
  instruction: string | undefined,
  sourceRunPath: string | undefined,
  projectRoot: string,
  role: string,
) {
  const body = resolveReviewSeatDialogueBody({ ...env, role, callerInstruction: instruction ?? "" });
  const peer = body === undefined && sourceRunPath
    ? await loadLedgerPeerBody(sourceRunPath, projectRoot, env.home) : undefined;
  return { instruction: body ?? peer?.instruction ?? "", instructionEmpty: body === undefined && !peer,
    auditedReceipt: peer?.auditedReceipt ?? env.auditedReceipt };
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
    const { auditedReceipt, ...dialogue } = await sameParentDialogue(env, parsed.instruction, gateParentRunPath, projectRoot, "countersign");
    if (auditedReceipt) env = { ...env, auditedReceipt };
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
        await pinAuditedLegAtAdmission(admitted, gateParentRunPath, env.auditedReceipt, io, {
          sourceRunPath: gateParentRunPath,
        });
        admitted = { ...admitted, sourceRunPath: gateParentRunPath };
      }
      // #1208 C1 / #1166 J11: one shared initial-prompt seam (incl. file flags).
      const turnProjection = roleTurnOptions(env, admitted, {
        kind: "initial",
        prompt: resolveInitialTurnPrompt(admitted, env, summons),
      });
      const turnRequest = buildInstructionSeatTurnRequest(admitted, turnProjection);
      const result = await runPostAdmissionOneShot({
        admitted,
        env,
        io,
        request: turnRequest,
        adapters: {
          ...seatAdapters(admitted, env, io),
          beforeDispatch: async (admittedSeat, lease) => {
            if (!packagedAdmitsCountersign(admittedSeat.role)) return;
            await relocateAdmittedRunToTicket(admittedSeat, env.principalAuthority, lease);
            Object.assign(turnRequest, buildInstructionSeatTurnRequest(admittedSeat, turnProjection));
          },
        },
        ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
      });
      await relocateAdmittedRunToTicket(admitted, env.principalAuthority);
      return result;
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
    const held: string[] = [];
    const result = await runCountersignBody(parsed, env, {
      stdout: (value) => held.push(value), stderr: io.stderr,
    });
    // Apply the same post-submission guards and audit as every other seat.
    return continueAfterPostSubmissionGuards(result, "countersign", env, io, held);
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
  let auditorTicket: number | undefined;
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
      source = await resolveNotarySourceRunLocator({
        projectRoot,
        sourceRun: parsed.sourceRun ?? "",
        home: env.home,
      });
      if (auditorSubject) auditorTicket = await readBoardTicketNumber(source.runDirectory);
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
    const { auditedReceipt, ...dialogue } = await sameParentDialogue(env, parsed.instruction, parentRunPath, projectRoot, role);
    if (auditedReceipt) env = { ...env, auditedReceipt };
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
    const resolvedNotarySource = record.sameParent === "source-locator" ? source : undefined;
    const admissionOverride = {
      ...(auditorTicket === undefined ? {} : { assertedTicketNumber: auditorTicket }),
      ...(resolvedNotarySource === undefined ? {} : { resolvedSourceRun: resolvedNotarySource }),
    };
    admitted = await admitPublicRole(
      role,
      parsed,
      env,
      auditorTicket === undefined && resolvedNotarySource === undefined ? undefined : admissionOverride,
    );
  } catch (error) {
    const rejected = usageExit(error, io);
    if (rejected !== undefined) return rejected;
    throw error;
  }

  if (source) {
    const sourceRunPath = source.runDirectory;
    await pinAuditedLegAtAdmission(admitted, sourceRunPath, env.auditedReceipt, io,
      record.sameParent === "source-locator" ? undefined : { sourceRunPath, auditorSubject });
    admitted = { ...admitted, sourceRunPath } as AdmittedRoleInvocation;
  }
  // #1208 C2: same helper as resume — inherit the audited source's known ticket.
  admitted = await inheritKnownTicketFromSource(admitted, env.principalAuthority);

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
        await recordChildDiaristRun(admitted, outcome.admitted.runId);
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
        await presentTerminal(outcome.terminal, { ...io, omitFailureStderrDiagnostic: true }, outcome.admitted?.runDirectory ?? admitted.runDirectory);
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
): Promise<SeatRunResult> {
  let selectedRequest = request;
  const resume = async () => {
    const held: string[] = [];
    const turnIo: CliIo = {
      stdout: (value) => held.push(value),
      stderr: io.stderr,
    };
    const result = await runPostAdmissionSeatResume<AdmittedRoleInvocation>({

    request: selectedRequest,
    env,
    io: turnIo,
    load: async (effective) => {
      const loaded = await loadResumablePublicRole(
        env.home,
        effective.runId,
        env.principalAuthority,
        effective.runDirectory === undefined ? undefined : { runDirectory: effective.runDirectory },
      );
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
      return { ...loaded, admitted };
    },
    buildTurnRequest: async (admitted, effective) => {
      // #1200: the turn is built once this leg has taken the summons — inside
      // its writer lease wherever the resume holds one — and before the host
      // turn. A summons the lease refuses never gets here and pins nothing.
      if (resummonedFor !== undefined) {
        await pinAuditedLegAtAdmission(admitted, resummonedFor, env.auditedReceipt, io);
      }
      const summonsPrepared = await prepareSummonsResumeMaterials(admitted.runDirectory, effective.summons);
      const projection = resumeTurnRequestProjectionOptions(
        admitted, effective, env, summonsPrepared,
      );
      // #1208: internal summons only — shared resolver owns review dialogue.
      // Same-parent summons already carry the selected dialogue. Bare resume and
      // explicit messages likewise need no new selection (#1208 R1).
      if (resummonedFor !== undefined || effective.summons === undefined || effective.message !== undefined) {
        return buildInstructionSeatTurnRequest(admitted, { ...projection });
      }
      const sourceRunPath = admittedSourceRunPath(admitted);
      const { instruction: body, instructionEmpty, auditedReceipt } = await sameParentDialogue(
        { home: env.home }, summonsPrepared?.instruction, sourceRunPath, admitted.projectRoot, admitted.role,
      );
      if (auditedReceipt && sourceRunPath) await pinAuditedLegAtAdmission(admitted, sourceRunPath, auditedReceipt, io);
      if (instructionEmpty) {
        return buildInstructionSeatTurnRequest(admitted, { ...projection });
      }
      const fileFlags = summonsPrepared?.attachments ?? [];
      const prompt = fileFlags.length === 0
        ? body
        : appendCallerFileFlagPaths(body, fileFlags);
      return buildInstructionSeatTurnRequest(admitted, {
        ...projection,
        continuation: { kind: "resume", prompt },
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
    if (result.admitted === undefined) {
      await presentOriginalVolume(held, result.terminal, io);
      return result;
    }
    return continueAfterPostSubmissionGuards(
      result,
      result.admitted.role,
      env,
      io,
      held,
    );
  };
  let binding: Awaited<ReturnType<typeof readAuditorResumeBinding>>;
  try {
    const loaded = await loadResumablePublicRole(
      env.home,
      request.runId,
      env.principalAuthority,
      request.runDirectory === undefined ? undefined : { runDirectory: request.runDirectory },
    );
    selectedRequest = { ...request, runDirectory: loaded.admitted.runDirectory };
    binding = loaded.admitted.role === "auditor"
      ? await readAuditorResumeBinding(loaded.admitted)
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

const GATE_CHILD_ROLES = new Set(["notary", "auditor", "inspector", "countersign"]);

/**
 * A gate child's conclusion outside the three states goes back to that child.
 * The words are the existing officer re-ask. Each reask spends this loop's own
 * copy of the configured ceiling; exhaustion keeps the terminal already in hand.
 * A host failure stops here.
 * Countersign already spends that ceiling inside its own seat, or the summoning
 * gate does. This loop does not open a second one for the same conclusion.
 */
async function queueConclusionFromChild(
  child: AdmittedRoleInvocation,
  terminal: TerminalResult,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<
  | { readonly admitted: AdmittedRoleInvocation; readonly terminal: TerminalResult; readonly status: string }
  | { readonly stop: SeatRunResult }
  | undefined
> {
  if (!GATE_CHILD_ROLES.has(child.role)) return undefined;
  // #1208: review-queue gate children also have seat-local
  // POST_SUBMISSION_ROUTING. This parent-side loop remains the
  // gate/correlation budget; nestedIncomplete from an exhausted seat-local
  // chain surfaces without a second spend. The child resume keeps the
  // caller's env so delivery, failure recovery, and other reask loops
  // stay separate.
  let budgetEnv: InstructionSeatRunEnv = envForCourtContinue(env);
  for (;;) {
    const status = latestQueueStatus(terminal);
    if (typeof status === "string" && REVIEW_QUEUE_STATUSES.has(status)) return { admitted: child, terminal, status };
    if (child.role === "countersign") return { stop: { exitCode: 0, admitted: child, terminal } };
    const reasked = await reaskUnreadablePostSubmissionStatus(
      child, terminal, budgetEnv, io, officerConclusionReask(status),
    );
    if (reasked === undefined || isUnreadableReaskExhausted(reasked)) {
      return { stop: { exitCode: 0, admitted: child, terminal } };
    }
    budgetEnv = withUnreadableReask(budgetEnv)!;
    if (reasked.exitCode !== 0 || reasked.admitted === undefined || reasked.terminal === undefined
      || reasked.terminal.roleOutcome.kind === "no_receipt"
      || reasked.terminal.roleOutcome.decisiveFacts?.directionUnsettled === true) {
      return { stop: reasked };
    }
    child = reasked.admitted;
    terminal = reasked.terminal;
  }
}

/** Continue the parent once a child has submitted. The child words ride the existing resume. */
export async function continueParentAfterChild(
  parentRunId: string,
  child: AdmittedRoleInvocation,
  childTerminal: TerminalResult,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SeatRunResult> {
  const knownParentDirectory = admittedSourceRunPath(child);
  const loaded = await loadResumablePublicRole(
    env.home,
    parentRunId,
    env.principalAuthority,
    knownParentDirectory === undefined ? undefined : { runDirectory: knownParentDirectory },
  );
  if (loaded.run.state !== "admitted" && !AUDITED_ROLES.has(loaded.admitted.role)) {
    return runPublicInstructionSeatResume(
      {
        runId: parentRunId,
        runDirectory: loaded.admitted.runDirectory,
      },
      env,
      io,
    );
  }
  const admitted = loaded.admitted;
  const resolved = await queueConclusionFromChild(child, childTerminal, env, io);
  if (resolved !== undefined && "stop" in resolved) {
    const stopped = resolved.stop;
    // #1214 R2: the child's audited original stays visible when the child leaves the verdict unsettled.
    if (stopped.admitted !== undefined
      && (leavesAuditedVerdictUnsettled(stopped) || heldUnreadableTerminal(stopped.terminal))) {
      await presentAuditedOriginalOfOfficer(stopped.admitted, undefined, env, io);
    }
    // Unreadable child conclusion stays on that seat — resume 审核席本人 (ADR 0055 / #1195).
    if (
      stopped.exitCode === 0
      && heldUnreadableTerminal(stopped.terminal)
      && stopped.terminal !== undefined
      && stopped.admitted !== undefined
    ) {
      const terminal = await presentUnsettledOfficer(
        stopped.terminal,
        io,
        stopped.admitted.runDirectory,
      );
      return { exitCode: 0, admitted: stopped.admitted, terminal };
    }
    return stopped;
  }
  if (resolved !== undefined && resolved.status === "escalate") {
    return { exitCode: 0, admitted: resolved.admitted, terminal: resolved.terminal };
  }
  if (resolved !== undefined && (resolved.status === "continue" || resolved.status === "converged")) {
    if (AUDITED_ROLES.has(admitted.role) && resolved.status === "converged") {
      // Recover the parent's own seal, not the seal a possibly stale child reviewed.
      const terminal = await recoverSeatTerminal(admitted, env, io);
      if (terminal?.roleOutcome.kind === "failure") {
        await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, admitted.runDirectory);
        return { exitCode: 1, admitted, terminal };
      }
      if (terminal?.roleOutcome.kind !== "accepted") throw new Error("pending submission is not recorded");
      // Only the officer for this parent seal can discharge its gate.
      const parent = terminal.receipts?.at(-1);
      const passed = parent && latestQueuePayload(resolved.terminal) !== undefined
        && matchesAuditedSeal({ receipt: resolved.admitted.auditedReceipt }, parent);
      return auditSubmittedRole(
        { exitCode: 0, admitted, terminal },
        env,
        io,
        passed ? resolved.admitted : undefined,
      );
    }
    return runPublicInstructionSeatResume({
      runId: parentRunId,
      runDirectory: admitted.runDirectory,
      summons: { instruction: readableGateItem(latestQueuePayload(resolved.terminal)) },
    }, envForCourtContinue(env), io);
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
  env: InstructionSeatRunEnv,
  io: CliIo,
  resumedOfficer?: AdmittedRoleInvocation,
): Promise<SeatRunResult> {
  const admitted = turn.admitted;
  if (admitted === undefined || !AUDITED_ROLES.has(admitted.role)
    || turn.terminal?.roleOutcome.kind !== "accepted") return turn;
  const accepted = turn.terminal.roleOutcome.payloads?.at(-1);
  if (accepted === undefined) throw new Error("accepted submission has no payload");
  const status = receiptStatus(accepted);
  // A gate summon already owns this conclusion's reasks. The seat must not
  // start another budget on the same run (parentRunPath is that summon).
  const gateOwnsStatusReask = typeof env.parentRunPath === "string" && env.parentRunPath.trim() !== "";
  if (admitted.role === "secretariat" && status !== "converged" && status !== "escalate") {
    if (gateOwnsStatusReask) return turn;
    const next = withUnreadableReask(env);
    if (next === undefined) {
      const terminal = withUnsettledDirection(turn.terminal);
      await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, admitted.runDirectory);
      return { ...turn, terminal };
    }
    return runPublicInstructionSeatResume({
      runId: admitted.runId,
      runDirectory: admitted.runDirectory,
      message: SECRETARIAT_STATUS_REASK,
      summons: { instructionEmpty: true },
    }, next, io);
  }
  if (admitted.role === "countersign" && (typeof status !== "string" || !REVIEW_QUEUE_STATUSES.has(status))) {
    if (gateOwnsStatusReask) return turn;
    const next = withUnreadableReask(env);
    if (next === undefined) {
      const terminal = withUnsettledDirection(turn.terminal);
      await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, admitted.runDirectory);
      return { ...turn, terminal };
    }
    return runPublicInstructionSeatResume({
      runId: admitted.runId,
      runDirectory: admitted.runDirectory,
      message: officerConclusionReask(status),
      summons: { instructionEmpty: true },
    }, next, io);
  }
  // Self-escalation is a valid open routing state for these seats only.
  // Doctor's declared domain is completed|refused — an open "escalate" must
  // not skip its mandatory auditor (#1057 / PR #1075).
  const selfEscalationSkipsAudit = status === "escalate"
    && (admitted.role === "judge" || admitted.role === "secretariat"
      || admitted.role === "countersign");
  const skipAudit = selfEscalationSkipsAudit
    || ((admitted.role === "fixer" || admitted.role === "coder")
      && (typeof status !== "string" || !WORKER_DONE_STATUSES.has(status)));
  if (skipAudit) {
    await presentTerminal(turn.terminal, { ...io, omitFailureStderrDiagnostic: true }, admitted.runDirectory);
    return turn;
  }
  // #1171 F2-R8: bind audit to the sealed identity carried on this turn's
  // settlement terminal — never the whole-leg latest accepted row (another
  // lawful public call may have sealed and passed台院 meanwhile).
  const filed = turn.terminal.receipts?.at(-1);
  if (!filed) throw new Error("accepted submission has no sealed receipt reference");
  const receiptName = basename(filed.receipt);
  const sessionFile = env.principalAuthority.decode(admitted.principal).sessionFile;
  const entries = admitted.role === "doctor"
    ? await readBoundSessionEntries(sessionFile)
    : [];
  const context: HostContext = {
    cwd: admitted.projectRoot,
    mode: "print",
    model: undefined,
    runDirectory: admitted.runDirectory,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionDir: () => dirname(sessionFile),
      getEntries: () => entries as unknown as Iterable<{ type: string }>,
      getLeafEntry: () => undefined,
      getLeafId: () => admitted.runId,
      getHeader: () => ({ type: "session", id: admitted.runId }),
    },
    abort() {},
  };
  const gateSatisfied = (officer: GateOfficer, chainOrder?: readonly GateOfficer[]) =>
    officerSatisfiedByLiveChild(officer, resumedOfficer, chainOrder);
  if (admitted.role === "doctor") {
    if (!gateSatisfied("auditor")) {
      let lastSummon: PublicSummonResult | undefined;
      const decision = await createPiDoctorAuditor()({
        context, submission: accepted,
        ...(env.autoResumeLimit === undefined ? {} : { autoResumeLimit: env.autoResumeLimit }),
        ...(env.signal === undefined ? {} : { signal: env.signal }),
        summonAuditor: async (subject, sourceRunDirectory, signal, reask, submission) => {
          const summoned = await summonPublicRole({
            role: "auditor",
            argv: ["--subject", subject, "--source-run", sourceRunDirectory],
            cwd: admitted.projectRoot, home: env.home, packageRoot: env.packageRoot,
            principalAuthority: env.principalAuthority,
            correlationId: admitted.runId, auditedReceipt: receiptName,
            ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
            ...(env.hostAdapters === undefined ? { roleTurnHost: env.roleTurnHost } : { hostAdapters: env.hostAdapters }),
            ...(signal === undefined ? {} : { signal }),
            ...(reask === undefined ? {} : { reviewReask: reask }),
            ...(submission === undefined ? {} : { gateReviewInstruction: submission }),
          });
          lastSummon = summoned;
          return summoned;
        },
      });
      if (decision.status === "continue") {
        return runPublicInstructionSeatResume({
          runId: admitted.runId,
          runDirectory: admitted.runDirectory,
          summons: { instruction: readableGateItem(decision.receipt ?? decision.violations) },
        }, envForCourtContinue(env), io);
      }
      if (decision.status === "received") {
        if (lastSummon?.terminal !== undefined) {
          // #1214 F1: present audited original and officer scene separately.
          await presentAuditedOriginalVolume(turn, io);
          const officerAdmitted = lastSummon.admitted;
          const officerDir = officerAdmitted?.runDirectory ?? lastSummon.runDirectory ?? admitted.runDirectory;
          const terminal = await presentUnsettledOfficer(lastSummon.terminal, io, officerDir);
          return {
            exitCode: 0,
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
          await presentAuditedOriginalVolume(turn, io);
          await presentTerminal(lastSummon.terminal, { ...io, omitFailureStderrDiagnostic: true }, lastSummon.admitted?.runDirectory ?? admitted.runDirectory);
          return { exitCode: lastSummon.exitCode,
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
      auditedReceipt: receiptName,
      cwd: admitted.projectRoot,
      home: env.home,
      packageRoot: env.packageRoot,
      roleTurnHost: env.roleTurnHost,
      ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
    });
    let pass: Awaited<ReturnType<typeof runJudgeGates>>;
    const runGate = (subject: Parameters<typeof requireSubmissionGate>[0]["subject"]) =>
      requireSubmissionGate({
        context,
        subject,
        submission: accepted,
        summonOfficer,
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
        await presentAuditedOriginalVolume(turn, io);
        // The terminal and admission belong to the same call, even after a new summons.
        // #1214 R2: a nested audited seat's original (officer's own audited parent) stays visible.
        await presentAuditedOriginalOfOfficer(officer, admitted.runId, env, io);
        if (pass.status !== "transport_failure") {
          // Lawful incomplete (unreadable / no_receipt): exit 0, direction unsettled.
          const terminal = await presentUnsettledOfficer(
            officerTerminal,
            io,
            officer.runDirectory,
          );
          return { exitCode: 0, admitted: officer, terminal };
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
      );
    }
    if (pass?.status === "escalate") {
      if (officer === undefined) {
        return incompleteAuditWithoutOfficerVolume(
          turn,
          admitted,
          io,
          "escalated audit has no resumable run identity",
        );
      }
      // Prefer the officer terminal already returned. Re-settle only when absent.
      // Other-seat tables stay on the officer run — parent does not attach copies (#1195).
      const terminal = pass.terminal ?? await recoverSeatTerminal(officer, env, io);
      if (terminal === undefined) {
        return incompleteAuditWithoutOfficerVolume(
          turn,
          officer,
          io,
          "escalated audit has no terminal result",
        );
      }
      await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, officer.runDirectory);
      return { exitCode: terminal.roleOutcome.kind === "failure" ? 1 : 0, admitted: officer, terminal };
    }
    if (pass?.status === "continue") {
      return runPublicInstructionSeatResume({
        runId: admitted.runId,
        runDirectory: admitted.runDirectory,
        summons: { instruction: readableGateItem(pass.receipt) },
      }, envForCourtContinue(env), io);
    }
  }
  // The turn already settled this court. Gate does not project other-seat finals
  // onto the parent public terminal (#1195) — present this leg's own volume.
  if (turn.terminal === undefined) throw new Error(`audited ${admitted.role} submission did not settle`);
  await presentTerminal(turn.terminal, { ...io, omitFailureStderrDiagnostic: true }, admitted.runDirectory);
  return turn;
}
