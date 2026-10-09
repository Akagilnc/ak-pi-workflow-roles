/**
 * One public role run: admit → turn request → post-admission → settle.
 * Seat differences are composition-root fields. An omitted reviewer lens
 * starts two ordinary single-axis runs here.
 */
import { dirname, resolve } from "node:path";
import { MISSING_TICKET_REASK_MATERIAL } from "../report-ticket-tool.ts";
import { isUnboundRunDirectory, sessionFileOf } from "../role-run-placement.ts";
import { rewriteRunDirectoryPathValue } from "../role-run-relocation.ts";
import { readPackageMaterial } from "../session-opening-materials.ts";
import { createPiDoctorAuditor } from "../doctor-auditor.ts";

import type { DurablePrincipalAuthority, HostContext, RoleTurnRequest } from "../host-contracts.ts";
import { officerConclusionReask, gateOfficerForSubject, type GateOfficer } from "../gatekeeper-role.ts";
import { receivedDiscriminator } from "../submission-errors.ts";
import { REVIEW_QUEUE_STATUSES } from "../review-submission.ts";
import { JUDGE_GATES, runJudgeGates } from "../judge-role.ts";
import { WORKER_DONE_STATUSES } from "../worker-submission-contracts.ts";
import { readableGateItem } from "../readable-gate-item.ts";
import { deliveryLimitFromConfig } from "../receipt-delivery-policy.ts";
import { runIdFromRunDirectory } from "../run-terminal-artifacts.ts";
import { createDefaultGateOfficerSummon, requireSubmissionGate } from "../submission-gate.ts";
import { readRecordedSubmissionRows } from "../submission-ledger.ts";
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
  packagedBindsBoardTicket,
  packagedRebindSourceOnResume,
  packagedRoleMetadata,
} from "../packaged-role-registry.ts";
import { readAuditorResumeBinding } from "../auditor-soul.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitPublicRole,
  bindAdmittedTicketNumber,
  appendCallerFileFlagPaths,
  buildInstructionTransportPrompt,
  materializeCountersignInvocation,
  persistAdmittedAuditedSubmissionToolCallId,
  persistAdmittedSourceRunPath,
  readAdmittedAuditedSubmissionToolCallId,
  recordAdmittedCorrelation,
  recordChildDiaristRun,
  relocateAdmittedRunToTicket,
  type AdmittedCountersignInvocation,
  type AdmittedRoleInvocation,
  type PublicSeatParse,
  type RunDirectoryRelocation,
} from "./invocation.ts";
import {
  bindDiaristAssertedTicketNumber,
  presentControlledFailure,
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
  buildAutoResumeContinuationPrompt,
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
  trySettlePublicSeat,
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
import { isRecord, errorText } from "../unknown-value.ts";

export type InstructionSeatRunEnv = PostAdmissionEnv & Pick<
  CountersignRunEnv,
  "reviewReask" | "gateReviewInstruction" | "parentRunPath"
>;

type SeatRunResult = {
  exitCode: number;
  admitted?: AdmittedRoleInvocation;
  terminal?: TerminalResult;
};

const AUDITED_ROLES = new Set<PackagedRole>(["judge", "fixer", "coder", "secretariat", "countersign", "doctor"]);
const SECRETARIAT_STATUS_REASK = "secretariatStatus 不是 converged、escalate 之一。请重新交卷，secretariatStatus 写明其一。";
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
  const status = receivedDiscriminator(payload, "status");
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
/**
 * Drop turn-scoped soft-reask identity; keep cross-turn budgets and ownership cell.
 * #1171 F2-R5 / F2-R9: ordinary status reask and court continue must not inherit
 * softTicketReaskTurn (that flag only governs the soft-reask turn's own settle).
 */
function withoutSoftTicketReaskTurn(env: InstructionSeatRunEnv): InstructionSeatRunEnv {
  const { softTicketReaskTurn: _softTicketReaskTurn, ...rest } = env;
  return rest;
}

function withUnreadableReask(env: InstructionSeatRunEnv): InstructionSeatRunEnv | undefined {
  const spent = env.unreadableReasksSpent ?? 0;
  if (spent >= deliveryLimitFromConfig(env.autoResumeLimit)) return undefined;
  // Ordinary status reask: strip soft-reask turn identity; keep spent budget (#1171 F2-R9).
  return { ...withoutSoftTicketReaskTurn(env), unreadableReasksSpent: spent + 1 };
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
  return runPublicInstructionSeatResume(
    {
      runId: admitted.runId,
      runDirectory: admitted.runDirectory,
      summons: { instruction: message },
    },
    next,
    io,
  );
}

/**
 * Soft-reask call outcome at the missing-ticket seam (#1171 F2-R6 / F2-R7).
 * Ownership is decided here once from this nested chain's settlement evidence
 * (soft-reask turn sealed → ownership cell; or returned terminal still carries volume);
 * callers must not re-judge the same criterion.
 */
type SoftTicketReaskOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "nested_owns"; readonly result: SeatRunResult }
  | { readonly kind: "no_substitute"; readonly result: SeatRunResult };

/**
 * #1171: sealed submission still leaves the leg unbound → soft reask once.
 * Does not reject the sealed receipt; exhaustion leaves unbound as filed.
 * Reask copy lives in package resources (ADR 0073).
 * #1171 F2-R7: ownership comes from this nested resume's settlement seam
 * (softTicketReaskOwnership.sealedSubstitute set when the soft-reask turn itself seals),
 * not full-leg sealed count / time-window deltas that can absorb another court's seal.
 */
async function reaskMissingTicketOnce(
  admitted: AdmittedRoleInvocation,
  terminal: TerminalResult | undefined,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<SoftTicketReaskOutcome> {
  if ((env.ticketReasksSpent ?? 0) >= 1) return { kind: "none" };
  if (admitted.ticketNumber !== undefined) return { kind: "none" };
  if (!isUnboundRunDirectory(admitted.runDirectory)) return { kind: "none" };
  if (terminal?.roleOutcome.kind !== "accepted" && terminal?.roleOutcome.kind !== "audit_escalation") {
    return { kind: "none" };
  }
  const payloads = terminal.roleOutcome.payloads ?? [];
  if (payloads.length === 0) return { kind: "none" };
  // Sealed-with-ticket skips via admitted.ticketNumber after bindSealedTicketNumber
  // (post-admission). Do not re-parse payload.ticketNumber here — that would
  // duplicate the existing ticket seam (#1171 notary: no rule copy).
  const instruction = (await readPackageMaterial(MISSING_TICKET_REASK_MATERIAL)).trim();
  // Spend budget and mark this turn as the soft reask (settlement identity).
  // Ownership cell is set at that turn's settlement; env spreads keep the same
  // ref through audit continue — see envForCourtContinue (#1171 F2-R5 / F2-R7).
  const softTicketReaskOwnership = { sealedSubstitute: false };
  const softReaskEnv: InstructionSeatRunEnv = {
    ...env,
    ticketReasksSpent: 1,
    softTicketReaskTurn: true,
    softTicketReaskOwnership,
  };
  const result = await runPublicInstructionSeatResume(
    {
      runId: admitted.runId,
      runDirectory: admitted.runDirectory,
      summons: { instruction },
    },
    softReaskEnv,
    io,
  );
  if (
    softTicketReaskOwnership.sealedSubstitute
    || terminalCarriesSealedSubmission(result.terminal)
  ) {
    return { kind: "nested_owns", result };
  }
  return { kind: "no_substitute", result };
}

/** Court continue: keep cross-turn budgets + ownership cell; drop turn-scoped soft-reask identity. */
function envForCourtContinue(env: InstructionSeatRunEnv): InstructionSeatRunEnv {
  return { ...withoutSoftTicketReaskTurn(env), unreadableReasksSpent: 0 };
}

/** True when a terminal still carries a sealed accepted / audit_escalation volume. */
function terminalCarriesSealedSubmission(terminal: TerminalResult | undefined): boolean {
  const kind = terminal?.roleOutcome.kind;
  if (kind !== "accepted" && kind !== "audit_escalation") return false;
  return (terminal?.roleOutcome.payloads ?? []).length > 0;
}

/**
 * #1171 F2-R2: kept original terminal may still name pre-relocate artifact
 * paths after a report-only reask moved the leg. Project onto live admitted
 * via the same rewrite seam post-admission uses after relocate.
 */
function projectKeptOriginalArtifactsOntoLiveAdmitted(
  original: SeatRunResult,
  kept: SeatRunResult,
): void {
  const oldRunDirectory = original.admitted?.runDirectory;
  const newRunDirectory = kept.admitted?.runDirectory;
  if (
    oldRunDirectory === undefined
    || newRunDirectory === undefined
    || oldRunDirectory === newRunDirectory
    || kept.terminal === undefined
  ) {
    return;
  }
  for (const artifact of kept.terminal.artifacts) {
    artifact.path = rewriteRunDirectoryPathValue(
      artifact.path,
      oldRunDirectory,
      newRunDirectory,
    ) as string;
  }
}

/**
 * #1171 F2: missing-ticket reask did not seal a substitute — keep original
 * terminal; take live placement from the reask when it relocated.
 * #1171 F2-R1: silence / report-only stays on the original chain; a real host
 * failure (nonzero exit) must be delivered honestly — do not wash it into the
 * original accepted result. Sealed original volume remains on disk either way.
 * #1171 F2-R2: after keep, project report artifact paths onto the live
 * admitted directory so public result, durable face, and artifact refs agree.
 * Substitute ownership is decided once at the soft-reask call seam (F2-R6);
 * this helper only finishes the keep path.
 */
function mergeMissingTicketReaskKeepOriginal(
  original: SeatRunResult,
  ticketReask: SeatRunResult,
): SeatRunResult {
  if (ticketReask.exitCode !== 0) return ticketReask;
  const admitted = ticketReask.admitted ?? original.admitted;
  if (admitted === undefined) return { ...original };
  const kept = { ...original, admitted };
  projectKeptOriginalArtifactsOntoLiveAdmitted(original, kept);
  return kept;
}

/**
 * Post-submission status reask, then missing-ticket soft reask, then audit.
 * #1171 F3: status exhaustion must not skip the one missing-ticket reask.
 * #1171 F2: ticket reask without a substitute seal continues the original chain.
 */
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
  let afterStatus = result;
  if (isUnreadableReaskExhausted(unreadableReask)) {
    const terminal = result.terminal === undefined
      ? undefined
      : withUnsettledDirection(result.terminal);
    afterStatus = terminal === undefined
      ? { ...result, admitted: live }
      : { ...result, admitted: live, terminal };
    // Fall through: missing-ticket reask still owed on the original sealed volume.
  } else if (unreadableReask !== undefined) {
    return unreadableReask;
  }
  const forTicket = afterStatus.admitted ?? live;
  // Ownership is decided once inside reaskMissingTicketOnce (#1171 F2-R6).
  const softReask = await reaskMissingTicketOnce(
    forTicket,
    afterStatus.terminal ?? result.terminal,
    env,
    io,
  );
  if (softReask.kind === "nested_owns") {
    // Nested resume already finished guards + audit/present for the substitute.
    // Do not run a second outer settlement of the same public call (#1171 F2-R4b).
    return softReask.result;
  }
  const continued = softReask.kind === "none"
    ? afterStatus
    : mergeMissingTicketReaskKeepOriginal(afterStatus, softReask.result);
  const continuedAdmitted = continued.admitted ?? live;
  // Spent budget rides the outer audit/continue chain (#1171 F2-R4a). Soft-reask
  // settlement identity does not — ordinary continue turns publish no_receipt (#1171 F2-R5).
  const continuedEnv = softReask.kind !== "none"
    ? { ...env, ticketReasksSpent: 1 }
    : env;
  if (AUDITED_ROLES.has(admittedRole) && continued.terminal?.roleOutcome.kind === "accepted") {
    return auditSubmittedRole(
      { ...continued, admitted: continuedAdmitted },
      continuedEnv,
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
 * Gate summons already ride gateReviewInstruction; direct --source-run must not
 * leave a blank fixed-kickoff.
 */
async function loadLedgerPeerBody(
  sourceRunDirectory: string,
  projectRoot: string,
  home: string,
): Promise<string | undefined> {
  const runId = runIdFromRunDirectory(sourceRunDirectory);
  if (runId === undefined) return undefined;
  // Bind to the already-resolved source directory — never re-discover by runId
  // alone (another book may lawfully share the same id; #637 / #1166).
  const rows = await readRecordedSubmissionRows(projectRoot, runId, {
    home,
    sessionParent: sessionFileOf(sourceRunDirectory),
  });
  // ADR 0085 / #1166 J10: ledger already keeps original words for every class —
  // present the latest row as-is. Never filter current manuscript by accepted /
  // terminal outcome kind (that resurrects a prior sealed draft).
  const latest = rows.at(-1);
  if (latest === undefined) return undefined;
  return readableGateItem(latest.accepted);
}

/**
 * One delivery rule for review-seat dialogue on new turns and same-parent resume
 * (#1166 / ADR 0085 / ADR 0087): explicit reask → non-empty caller dispatch →
 * source-only ledger peer body. Identity stays in startup materials.
 * #1195: ticket-court notary skips peer-body preload (countersign source only).
 */
async function resolveReviewSeatDialogueBody(input: {
  readonly role?: string;
  readonly reask?: string;
  readonly callerInstruction?: string;
  readonly sourceRunPath?: string;
  readonly projectRoot: string;
  readonly home: string;
}): Promise<string | undefined> {
  const reask = input.reask;
  if (reask !== undefined && reask.length > 0) return reask;
  const caller = input.callerInstruction ?? "";
  if (caller.length > 0) return caller;
  const sourceRunPath = input.sourceRunPath?.trim() ?? "";
  if (sourceRunPath === "") return undefined;
  if (input.role === "notary") {
    const { isTicketCourtCountersignSource } = await import("../run-terminal-artifacts.ts");
    if (isTicketCourtCountersignSource(sourceRunPath)) return undefined;
  }
  return await loadLedgerPeerBody(sourceRunPath, input.projectRoot, input.home);
}

function admittedSourceRunPath(admitted: AdmittedRoleInvocation): string {
  return "sourceRunPath" in admitted
    && typeof (admitted as { sourceRunPath?: unknown }).sourceRunPath === "string"
    ? (admitted as { sourceRunPath: string }).sourceRunPath.trim()
    : "";
}

async function resolveInitialPrompt(
  admitted: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
): Promise<string> {
  const record = roleRecord(admitted.role);
  if ("reaskPrompt" in record && record.reaskPrompt === true) {
    const sourceRunPath = admittedSourceRunPath(admitted);
    const reask = env.reviewReask ?? env.gateReviewInstruction;
    const body = await resolveReviewSeatDialogueBody({
      role: admitted.role,
      ...(reask === undefined ? {} : { reask }),
      callerInstruction: admitted.instruction,
      ...(sourceRunPath === "" ? {} : { sourceRunPath }),
      projectRoot: admitted.projectRoot,
      home: env.home,
    });
    // #1166 J11: merge existing file-flag delivery — never early-return body alone
    // when caller attach paths were admitted. Gate with no file flags stays body-only.
    if (body !== undefined) {
      return appendCallerFileFlagPaths(body, admitted.attachments);
    }
  }
  return buildInstructionTransportPrompt(admitted);
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
): Promise<RunDirectoryRelocation | undefined> {
  // The diarist's asserted ticketNumber binds here, in the public call's process.
  await bindDiaristAssertedTicketNumber(admitted);
  const boardTicket = await readBoardTicketNumber(admitted.runDirectory);
  if (boardTicket === undefined) return undefined;
  if (admitted.ticketNumber === undefined) {
    await bindAdmittedTicketNumber(admitted, boardTicket);
  }
  return await relocateAdmittedRunToTicket(admitted, authority, lease);
}

function packageFaultScope(
  admitted: Pick<AdmittedRoleInvocation, "runDirectory" | "principal">,
  env: InstructionSeatRunEnv,
  io: CliIo,
): SettlementCourtScope {
  return { notePackageFault: packageFaultNoteFor(admitted, env, io) };
}

function seatAdapters(
  admitted: AdmittedRoleInvocation,
  env: InstructionSeatRunEnv,
): PostAdmissionAdapters<AdmittedRoleInvocation> {
  const record = roleRecord(admitted.role);
  const present = "presentSettled" in record ? record.presentSettled : "default";
  return {
    trySettle: (seat, authority, scope) =>
      trySettlePublicSeat(seat, authority, scope),
    ...(present === "always" ? { shouldPresentSettled: () => true } : {}),
    ...(present === "typed"
      ? { shouldPresentSettled: (terminal: TerminalResult) => isLawfulTypedTerminalOutcome(terminal.roleOutcome) }
      : {}),
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
          if (!isBoardTicketSeat(seat)) return undefined;
          return await bindAndRelocateDiarist(seat, env.principalAuthority, lease);
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
  await warnMissingMethodSkills(env.home, env.host, admitted.role, requiredMethodSkills(admitted), io.stdout);
  const adapters = seatAdapters(admitted, env);
  const held: string[] = [];
  const turnIo: CliIo = AUDITED_ROLES.has(admitted.role)
    || POST_SUBMISSION_ROUTING[admitted.role] !== undefined
    ? { stdout: (value) => held.push(value), stderr: io.stderr }
    : io;
  const execute = async (activeEnv: InstructionSeatRunEnv): Promise<SeatRunResult> => {
    if (activeEnv.correlationId !== undefined && activeEnv.correlationId.trim() !== "") {
      await recordAdmittedCorrelation(admitted, activeEnv.correlationId);
    }
    const initialPromptText = await resolveInitialPrompt(admitted, activeEnv);
    const auto = "inCallAutoResume" in record && record.inCallAutoResume === true;
    if (auto) {
      return await runPostAdmissionResumable({
        admitted,
        env: activeEnv,
        io: turnIo,
        buildInitialRequest: () => buildInstructionSeatTurnRequest(
          admitted,
          roleTurnOptions(activeEnv, admitted, {
            kind: "initial",
            prompt: initialPromptText,
          }),
        ),
        buildResumeRequest: () => buildInstructionSeatTurnRequest(
          admitted,
          roleTurnOptions(activeEnv, admitted, {
            kind: "resume",
            prompt: buildAutoResumeContinuationPrompt(),
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
          prompt: initialPromptText,
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
 * One same-parent lookup. Seat branches still build their own summons.
 * A found child resumes that child; no prior run returns undefined so the caller mints.
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
    resume: (runId, materials, runDirectory) => runPublicInstructionSeatResume(
      {
        runId,
        runDirectory,
        ...(materials === undefined ? {} : { summons: materials }),
      },
      input.env,
      input.io,
    ),
  });
}

/**
 * Same delivery rule as resolveInitialPrompt for same-parent resume summons.
 * Reask / explicit caller text / source-only ledger peer — one authority.
 */
async function sameParentDialogue(
  env: InstructionSeatRunEnv,
  fallback: { readonly instruction: string; readonly instructionEmpty: boolean },
  sourceRunPath: string,
  projectRoot: string,
  role: string,
): Promise<{ readonly instruction: string; readonly instructionEmpty: boolean }> {
  const reask = env.reviewReask ?? env.gateReviewInstruction;
  const body = await resolveReviewSeatDialogueBody({
    role,
    ...(reask === undefined ? {} : { reask }),
    callerInstruction: fallback.instruction,
    sourceRunPath,
    projectRoot,
    home: env.home,
  });
  if (body !== undefined) {
    return { instruction: body, instructionEmpty: false };
  }
  return fallback;
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
  const gateParentRunPath =
    typeof env.parentRunPath === "string" && env.parentRunPath.trim() !== ""
      ? env.parentRunPath
      : undefined;
  if (gateParentRunPath !== undefined) {
    const resumeInstruction = env.reviewReask ?? env.gateReviewInstruction ?? parsed.instruction ?? "";
    const resumed = await resumeSameParentInstructionSeat({
      env,
      io,
      projectRoot: resolve(parsed.project ?? env.cwd),
      role: "countersign",
      parentRunPath: gateParentRunPath,
      ...(isSafePositiveTicketNumber(env.boundTicketNumber)
        ? { ticketNumber: env.boundTicketNumber }
        : {}),
      summons: {
        sourceRunPath: gateParentRunPath,
        instruction: resumeInstruction,
        instructionEmpty: resumeInstruction.length === 0,
        // #1166 J11: same-parent resume delivers this call's file-flag paths
        // through the shared summons → appendCallerFileFlagPaths rule.
        attachmentPaths: parsed.attachmentPaths ?? [],
      },
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
        await persistAdmittedSourceRunPath(admitted, gateParentRunPath);
        admitted = { ...admitted, sourceRunPath: gateParentRunPath };
      }
      // #1166 J11: review-body branch must merge the same file-flag delivery as
      // resolveInitialPrompt / resumeTurnRequestProjectionOptions — never body alone.
      const reviewBody = env.reviewReask ?? env.gateReviewInstruction;
      const turnProjection = roleTurnOptions(env, admitted, {
        kind: "initial",
        prompt: reviewBody !== undefined
          ? appendCallerFileFlagPaths(reviewBody, admitted.attachments)
          : buildInstructionTransportPrompt(admitted),
      });
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
    // Same post-submission guards as every other seat (#1171 F8): missing-ticket
    // soft reask once, then audit — no early return that skips the reask.
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
  let auditorSource: string | undefined;
  let auditorTicket: number | undefined;
  let resolvedNotarySource: NotarySourceRunLocator | undefined;
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
    const source = parsed.sourceRun;
    try {
      const resolved = await resolveNotarySourceRunLocator({ projectRoot, sourceRun: source, home: env.home });
      auditorSource = resolved.runDirectory;
      auditorTicket = await readBoardTicketNumber(resolved.runDirectory);
    } catch (error) {
      presentStructuralRejection(new CliUsageError(errorText(error)), io);
      return { exitCode: 2 };
    }
    if (auditorSource === undefined) return { exitCode: 2 };
    const sourceDirectory = auditorSource;
    const summons: SameTicketSummonsMaterials = {
      ...(await sameParentDialogue(
        env,
        {
          instruction: parsed.instruction ?? "",
          instructionEmpty: (parsed.instruction ?? "").length === 0,
        },
        sourceDirectory,
        projectRoot,
        role,
      )),
      attachmentPaths: parsed.attachmentPaths ?? [],
    };
    const resumed = await withAuditorSoulEnv({
      subject: auditorSubject,
      sourceRunDirectory: auditorSource,
      run: () => resumeSameParentInstructionSeat({
        env,
        io,
        projectRoot,
        role,
        parentRunPath: sourceDirectory,
        summons,
      }),
    });
    if (resumed != null) return resumed;
  }

  if (record.sameParent === "source-run") {
    // #1166: structured --source-run only. Instruction bytes stay opaque caller/peer text.
    if (parsed.sourceRun !== undefined) {
      let parentRunPath: string;
      try {
        parentRunPath = (await resolveNotarySourceRunLocator({
          projectRoot,
          sourceRun: parsed.sourceRun,
          home: env.home,
        })).runDirectory;
      } catch (error) {
        if (error instanceof NotarySourceRunError) {
          presentStructuralRejection(new CliUsageError(error.message, { cause: error }), io);
          return { exitCode: 2 };
        }
        throw error;
      }
      const summons: SameTicketSummonsMaterials = {
        sourceRunPath: parentRunPath,
        ...(await sameParentDialogue(
          env,
          {
            instruction: parsed.instruction ?? "",
            instructionEmpty: (parsed.instruction ?? "").length === 0,
          },
          parentRunPath,
          projectRoot,
          role,
        )),
        attachmentPaths: parsed.attachmentPaths ?? [],
      };
      const resumed = await resumeSameParentInstructionSeat({
        env,
        io,
        projectRoot,
        role,
        parentRunPath,
        summons,
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
    const summons: SameTicketSummonsMaterials = {
      sourceRunPath: source.runDirectory,
      sourceRun: source,
      ...(await sameParentDialogue(
        env,
        { instruction: "", instructionEmpty: true },
        source.runDirectory,
        projectRoot,
        role,
      )),
    };
    resolvedNotarySource = source;
    const resumed = await resumeSameParentInstructionSeat({
      env,
      io,
      projectRoot,
      role,
      parentRunPath: source.runDirectory,
      summons,
    });
    if (resumed != null) return resumed;
  }

  let admitted: AdmittedRoleInvocation;
  try {
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

  if (record.sameParent === "source-run" && parsed.sourceRun !== undefined) {
    const parentRunPath = (await resolveNotarySourceRunLocator({
      projectRoot,
      sourceRun: parsed.sourceRun,
      home: env.home,
    })).runDirectory;
    await persistAdmittedSourceRunPath(admitted, parentRunPath);
    admitted = { ...admitted, sourceRunPath: parentRunPath } as AdmittedRoleInvocation;
  }
  if (record.sameParent === "subject-source" && auditorSource !== undefined) {
    await persistAdmittedSourceRunPath(admitted, auditorSource, auditorSubject);
    admitted = { ...admitted, sourceRunPath: auditorSource } as AdmittedRoleInvocation;
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
        }, seatAdapters(admitted, env), env.principalAuthority, io, true,
          packageFaultNoteFor(admitted, env, io)) as SeatRunResult;
      }
      if (outcome.admitted !== undefined && isUnboundRunDirectory(outcome.admitted.runDirectory)) {
        await recordChildDiaristRun(admitted, outcome.admitted.runId);
      }
      if (outcome.failedWithoutEscalate !== undefined) {
        return await presentControlledFailure(admitted, {
          timedOut: false, code: null, stderr: "",
          thrown: new Error(outcome.failedWithoutEscalate.diagnostic),
        }, seatAdapters(admitted, env), env.principalAuthority, io, true,
          packageFaultNoteFor(admitted, env, io)) as SeatRunResult;
      }
      // The diarist's escalation pauses only the diarist's own run; call order
      // belongs to the caller, so the Secretariat still takes its own turn.
      if (outcome.identity.kind === "escalate" && outcome.terminal !== undefined) {
        await presentTerminal(outcome.terminal, { ...io, omitFailureStderrDiagnostic: true }, outcome.admitted?.runDirectory ?? admitted.runDirectory);
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
  const resume = async () => {
    const held: string[] = [];
    const turnIo: CliIo = {
      stdout: (value) => held.push(value),
      stderr: io.stderr,
    };
    const result = await runPostAdmissionSeatResume<AdmittedRoleInvocation>({

    request,
    env,
    io: turnIo,
    load: async (effective) => {
      const loaded = await loadResumablePublicRole(
        env.home,
        effective.runId,
        env.principalAuthority,
        effective.runDirectory === undefined ? undefined : { runDirectory: effective.runDirectory },
      );
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
    afterAdmittedLoad: async (admitted) => {
      await warnMissingMethodSkills(env.home, env.host, admitted.role, requiredMethodSkills(admitted), io.stdout);
      return { kind: "continue" as const, adapters: seatAdapters(admitted, env) };
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
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<
  | { readonly admitted: AdmittedRoleInvocation; readonly terminal: TerminalResult; readonly status: string }
  | { readonly stop: SeatRunResult }
  | undefined
> {
  if (!GATE_CHILD_ROLES.has(child.role)) return undefined;
  if (child.role === "countersign") {
    const terminal = await trySettlePublicSeat(
      child, env.principalAuthority, { ...await readCurrentCourt(child.runDirectory), ...packageFaultScope(child, env, io) },
    );
    const status = latestQueueStatus(terminal);
    if (terminal !== undefined && typeof status === "string" && REVIEW_QUEUE_STATUSES.has(status)) {
      return { admitted: child, terminal, status };
    }
    return { stop: { exitCode: 0, ...(terminal === undefined ? {} : { terminal }) } };
  }
  let current: AdmittedRoleInvocation = child;
  // Notary, auditor, and inspector have no seat-local status reask. This loop
  // is their one budget. The child resume keeps the caller's env so delivery,
  // failure recovery, and other reask loops stay separate.
  let budgetEnv: InstructionSeatRunEnv = envForCourtContinue(env);
  for (;;) {
    const terminal = await trySettlePublicSeat(
      current,
      env.principalAuthority,
      { ...await readCurrentCourt(current.runDirectory), ...packageFaultScope(current, env, io) },
    );
    const status = latestQueueStatus(terminal);
    if (terminal !== undefined && typeof status === "string" && REVIEW_QUEUE_STATUSES.has(status)) {
      return { admitted: current, terminal, status };
    }
    const reasked = await reaskUnreadablePostSubmissionStatus(
      current, terminal, budgetEnv, io, officerConclusionReask(status),
    );
    if (reasked === undefined || isUnreadableReaskExhausted(reasked)) {
      return { stop: { exitCode: 0, ...(terminal === undefined ? {} : { terminal }) } };
    }
    budgetEnv = withUnreadableReask(budgetEnv)!;
    if (reasked.exitCode !== 0 || reasked.admitted === undefined || reasked.terminal === undefined
      || reasked.terminal.roleOutcome.kind === "no_receipt"
      || reasked.terminal.roleOutcome.decisiveFacts?.directionUnsettled === true) {
      return { stop: reasked };
    }
    const reaskedStatus = latestQueueStatus(reasked.terminal);
    if (typeof reaskedStatus === "string" && REVIEW_QUEUE_STATUSES.has(reaskedStatus)) {
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
  // Sole parent-directory authority on this chain: child admitted sourceRunPath (#1195).
  const knownParentDirectory =
    "sourceRunPath" in child
    && typeof (child as { sourceRunPath?: unknown }).sourceRunPath === "string"
    && (child as { sourceRunPath: string }).sourceRunPath.trim() !== ""
      ? (child as { sourceRunPath: string }).sourceRunPath
      : undefined;
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
        ...(knownParentDirectory === undefined ? {} : { runDirectory: knownParentDirectory }),
      },
      env,
      io,
    );
  }
  const admitted = loaded.admitted;
  const resolved = await queueConclusionFromChild(child, env, io);
  if (resolved !== undefined && "stop" in resolved) {
    const stopped = resolved.stop;
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
      const terminal = await trySettlePublicSeat(
        admitted,
        env.principalAuthority,
        { ...await readCurrentCourt(admitted.runDirectory), ...packageFaultScope(admitted, env, io) },
      );
      if (terminal?.roleOutcome.kind !== "accepted") throw new Error("pending submission is not recorded");
      // Live child only when admitted-request.auditedSubmissionToolCallId matches
      // the parent seal under audit (#1195 option 1 / owner 00644146).
      const live = liveChildForCurrentParentSeal(
        terminal,
        resolved.admitted,
        latestQueuePayload(resolved.terminal),
      );
      return auditSubmittedRole(
        { exitCode: 0, admitted, terminal },
        env,
        io,
        live?.officer,
        live?.receipt,
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
 * Hand continueParentAfterChild's live child to audit only when the child's own
 * admitted-request records this parent seal's toolCallId (#1195 option 1).
 * Read failures propagate — never wash into "no match".
 */
function liveChildForCurrentParentSeal(
  parentTerminal: TerminalResult,
  child: AdmittedRoleInvocation,
  receipt: unknown,
): { readonly officer: AdmittedRoleInvocation; readonly receipt: unknown } | undefined {
  if (receipt === undefined) return undefined;
  const parentSealId = parentTerminal.submissionToolCallId?.trim() ?? "";
  if (parentSealId === "") return undefined;
  const childSealId = readAdmittedAuditedSubmissionToolCallId(child.runDirectory);
  if (childSealId !== parentSealId) return undefined;
  return { officer: child, receipt };
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
  passedReceipt: unknown,
  /** Ordered officers of this parent's gate chain; earlier than live child = done. */
  chainOrder?: readonly GateOfficer[],
): boolean {
  if (resumedOfficer === undefined || passedReceipt === undefined) return false;
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
  passedReceipt?: unknown,
): Promise<SeatRunResult> {
  // Ordinary audit chain: drop soft-reask turn identity; keep budgets/ownership (#1171 F2-R9).
  env = withoutSoftTicketReaskTurn(env);
  const admitted = turn.admitted;
  if (admitted === undefined || !AUDITED_ROLES.has(admitted.role)
    || turn.terminal?.roleOutcome.kind !== "accepted") return turn;
  const accepted = turn.terminal.roleOutcome.payloads?.at(-1);
  if (accepted === undefined) throw new Error("accepted submission has no payload");
  const record = isRecord(accepted)
    ? accepted as Record<string, unknown> : undefined;
  const status = admitted.role === "secretariat" ? record?.secretariatStatus : record?.status;
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
      summons: { instruction: SECRETARIAT_STATUS_REASK },
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
      summons: { instruction: officerConclusionReask(status) },
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
  const toolCallId = turn.terminal.submissionToolCallId;
  if (toolCallId === undefined || toolCallId.length === 0) {
    throw new Error("accepted submission has no tool call identity");
  }
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
    officerSatisfiedByLiveChild(officer, resumedOfficer, passedReceipt, chainOrder);
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
            correlationId: admitted.runId,
            ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
            ...(env.hostAdapters === undefined ? { roleTurnHost: env.roleTurnHost } : { hostAdapters: env.hostAdapters }),
            ...(signal === undefined ? {} : { signal }),
            ...(reask === undefined ? {} : { reviewReask: reask }),
            ...(submission === undefined ? {} : { gateReviewInstruction: submission }),
          });
          lastSummon = summoned;
          const officerDir = summoned.runDirectory ?? summoned.admitted?.runDirectory;
          if (officerDir !== undefined && toolCallId.length > 0) {
            persistAdmittedAuditedSubmissionToolCallId(officerDir, toolCallId);
          }
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
        if (lastSummon?.terminal === undefined) {
          throw new Error("doctor audit kept an unreadable reply with no terminal");
        }
        const officerAdmitted = lastSummon.admitted;
        const officerDir = officerAdmitted?.runDirectory ?? lastSummon.runDirectory ?? admitted.runDirectory;
        const terminal = await presentUnsettledOfficer(lastSummon.terminal, io, officerDir);
        return {
          exitCode: 0,
          ...(officerAdmitted === undefined ? { admitted } : { admitted: officerAdmitted }),
          terminal,
        };
      }
      if (decision.status !== "converged") {
        if (lastSummon?.terminal !== undefined) {
          await presentTerminal(lastSummon.terminal, { ...io, omitFailureStderrDiagnostic: true }, lastSummon.admitted?.runDirectory ?? admitted.runDirectory);
          return { exitCode: lastSummon.exitCode,
            ...(lastSummon.admitted === undefined ? {} : { admitted: lastSummon.admitted }),
            terminal: lastSummon.terminal };
        }
        throw new Error(`doctor audit did not converge: ${decision.status}`);
      }
    }
  } else {
    const summonOfficer = createDefaultGateOfficerSummon({
      cwd: admitted.projectRoot,
      home: env.home,
      packageRoot: env.packageRoot,
      roleTurnHost: env.roleTurnHost,
      ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
    });
    let chain: Awaited<ReturnType<typeof runJudgeGates>>;
    const runGate = (subject: Parameters<typeof requireSubmissionGate>[0]["subject"]) =>
      requireSubmissionGate({
        context,
        subject,
        toolCallId,
        submission: accepted,
        summonOfficer,
        ...(env.autoResumeLimit === undefined ? {} : { autoResumeLimit: env.autoResumeLimit }),
        ...(env.signal === undefined ? {} : { signal: env.signal }),
        hostActions: {
          failInfrastructure(error): never { throw error; },
          bindSubmissionNonPass() {},
        },
      });
    if (admitted.role === "judge") {
      // Same order as runJudgeGates — sole source JUDGE_GATES + gateOfficerForSubject.
      const judgeGateOrder = JUDGE_GATES.map(gateOfficerForSubject);
      chain = await runJudgeGates({
        gateAlreadyConverged: async (subject) =>
          gateSatisfied(gateOfficerForSubject(subject), judgeGateOrder),
        runGate,
      });
    } else {
      const subject = admitted.role === "fixer" || admitted.role === "coder"
        ? { kind: "worker_completion" as const }
        : admitted.role === "secretariat"
          ? { kind: "secretariat_verdict" as const }
          : { kind: "countersign_verdict" as const };
      const officer = gateOfficerForSubject(subject);
      if (gateSatisfied(officer)) {
        chain = { status: "converged", passes: [] };
      } else {
        const pass = await runGate(subject);
        if (pass === undefined) throw new Error("audit gate returned no conclusion");
        chain = {
          status: pass.status,
          passes: [{
            subject,
            status: pass.status,
            receipt: pass.receipt,
            ...(pass.runId === undefined ? {} : { runId: pass.runId }),
            ...(pass.runDirectory === undefined ? {} : { runDirectory: pass.runDirectory }),
            ...(pass.terminal === undefined ? {} : { terminal: pass.terminal }),
          }],
        };
      }
    }
    if (chain.status === "needs_reask") {
      const pass = chain.passes.at(-1);
      const officerTerminal = pass?.terminal;
      if (officerTerminal === undefined) throw new Error("unreadable audit has no terminal result");
      const officerRunDirectory = pass?.runDirectory;
      const officerRunId = pass?.runId
        ?? (officerRunDirectory === undefined ? undefined : runIdFromRunDirectory(officerRunDirectory));
      if (officerRunId === undefined) throw new Error("unreadable audit has no resumable run identity");
      const officer = await loadResumablePublicRole(
        env.home,
        officerRunId,
        env.principalAuthority,
        officerRunDirectory === undefined ? undefined : { runDirectory: officerRunDirectory },
      );
      const terminal = await presentUnsettledOfficer(
        officerTerminal,
        io,
        officer.admitted.runDirectory,
      );
      return { exitCode: 0, admitted: officer.admitted, terminal };
    }
    if (chain.status === "escalate") {
      const escalation = chain.passes.at(-1);
      const escalatedRunDirectory = escalation?.runDirectory;
      const escalatedRunId = escalation?.runId
        ?? (escalatedRunDirectory === undefined
          ? undefined : runIdFromRunDirectory(escalatedRunDirectory));
      if (escalatedRunId === undefined) throw new Error("escalated audit has no resumable run identity");
      const officer = await loadResumablePublicRole(
        env.home,
        escalatedRunId,
        env.principalAuthority,
        escalatedRunDirectory === undefined ? undefined : { runDirectory: escalatedRunDirectory },
      );
      // Prefer the officer terminal already returned. Re-settle only when absent.
      // Other-seat tables stay on the officer run — parent does not attach copies (#1195).
      let terminal = escalation?.terminal;
      if (terminal === undefined) {
        terminal = await trySettlePublicSeat(
          officer.admitted,
          env.principalAuthority,
          { ...await readCurrentCourt(officer.admitted.runDirectory), ...packageFaultScope(officer.admitted, env, io) },
        );
      }
      if (terminal === undefined) throw new Error("escalated audit has no terminal result");
      await presentTerminal(terminal, { ...io, omitFailureStderrDiagnostic: true }, officer.admitted.runDirectory);
      return { exitCode: 0, admitted: officer.admitted, terminal };
    }
    if (chain.status === "continue") {
      return runPublicInstructionSeatResume({
        runId: admitted.runId,
        runDirectory: admitted.runDirectory,
        summons: { instruction: readableGateItem(chain.passes.at(-1)?.receipt) },
      }, envForCourtContinue(env), io);
    }
  }
  // The turn already settled this court. Gate does not project other-seat finals
  // onto the parent public terminal (#1195) — present this leg's own volume.
  if (turn.terminal === undefined) throw new Error(`audited ${admitted.role} submission did not settle`);
  await presentTerminal(turn.terminal, { ...io, omitFailureStderrDiagnostic: true }, admitted.runDirectory);
  return turn;
}
