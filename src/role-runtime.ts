import { writeSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { activationTraceRecordSchema, namedActivationCause, type ActivationTraceRecord, type ActivationTraceWriter } from "./activation-trace.ts";
import {
  appendAcceptedActivationToBook,
  buildAcceptedActivationFact,
  correlationIdentityFromEnv,
  durableSessionPointer,
  resolveActivationLedgerHome,
  resolveBookKeyFromGit,
  type AcceptedActivationFact,
  type ActivationCorrelationIdentity,
  type ActivationSessionPointer,
} from "./activation-ledger.ts";
import { writeStderrJsonlRecord } from "./stderr-jsonl.ts";
import {
  createToolExecutionObservationFace,
  systemToolExecutionObservationMonoNow,
  writeToolExecutionObservationRecord,
  type ToolExecutionObservationWriter,
} from "./tool-execution-observation.ts";
import { ENGINE_DETOUR_TOOL_NAME } from "./engine-detour.ts";
import { registerEngineDetourTool } from "./engine-detour-tool.ts";
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT } from "./receipt-delivery-policy.ts";
import { createOAuthKeepalive, type OAuthKeepaliveOptions } from "./oauth-keepalive.ts";

import type { AnyCanonicalSkillBinding } from "./canonical-skill-binding.ts";
import type { CollectorClock } from "./collector-evidence.ts";
import type { CollectorGitHubTransport } from "./collector-github.ts";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  createCollectorRoleRuntime,
} from "./collector-role.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";
import { createDoctorRoleRuntime } from "./doctor-role.ts";
import { createNotaryRoleRuntime } from "./notary-role.ts";
import { decorateSettlementWithNavigation, formatNavigatorReport, NAVIGATOR_EVENT_TYPE, navigatorSubjectKey, navigatorUnavailableError, subjectPath, type NavigatorAttendance, type NavigatorEvent, type NavigatorPhase, type NavigatorReport, type NavigatorSettlement, type NavigatorSubjectProvenance, type NavigatorWorkContext } from "./navigator-attendance.ts";
import {
  buildNavigatorInfrastructureFailureFact,
  classifyPackagedRoleTerminalResult,
  NAVIGATOR_INFRASTRUCTURE_FAILURE_EVIDENCE_KEYS,
  NAVIGATOR_INVOCATION_ENTRY,
  resolveLifecycleInvocationPrincipal,
} from "./navigator-invocation-identity.ts";
import { recordTypedProviderHttpStatus } from "./typed-provider-http.ts";
import {
  ExplicitInternalActivationError,
  recordReviewerDispatchRejectionSync,
} from "./public-cli/explicit-internal.ts";
import { NAVIGATOR_POST_ROLE_GRACE_MS, raceNavigatorGrace } from "./public-cli/settlement.ts";
import { PACKAGED_ROLE_REGISTRY, packagedRoleMetadata, packagedRoleOutputTool, packagedRolePhaseFlag, type PackagedRole } from "./packaged-role-registry.ts";
import { isAuditEscalationProjection } from "./audit-escalation.ts";
import {
  createJudgeRoleRuntime,
  type SoulAuditResult,
} from "./judge-role.ts";
import {
  createReviewerRoleRuntime,
  type ReviewerActivation,
  type ReviewerAdmittedInputs,
} from "./reviewer-role.ts";
import type { AcceptedReviewerExecution, ReviewerIssueFetcher, ReviewerPinnedGitReader } from "./reviewer-dispatch.ts";
import type { ReviewerDispatchRunResult } from "./reviewer-agent.ts";
import {
  type ReviewerSpecDisposition,
} from "./reviewer-construction.ts";
import type { GatekeeperNonPassResult } from "./gatekeeper-role.ts";

/**
 * Private transport flag names/definitions for Reviewer admitted inputs.
 * Shared activation envelope owns registration and decoding (ADR 0018).
 */
const REVIEWER_TRANSPORT_FLAGS = Object.freeze([
  Object.freeze({
    name: "ak-review-base",
    definition: Object.freeze({
      description: "Fixed base revision for the pinned review target",
      type: "string" as const,
    }),
  }),
  Object.freeze({
    name: "ak-review-scope-keys",
    definition: Object.freeze({
      description: "Optional comma-separated exact class keys limiting Reviewer scope",
      type: "string" as const,
    }),
  }),
  Object.freeze({
    name: "ak-review-authority-refs",
    definition: Object.freeze({
      description: "JSON array of durable authority references for Spec evidence-child material only",
      type: "string" as const,
    }),
  }),
  Object.freeze({
    name: "ak-review-ticket-number",
    definition: Object.freeze({
      description: "Typed ticketNumber for Spec self-fetch primary path",
      type: "string" as const,
    }),
  }),
] as const);

/**
 * Decode private transport flags into frozen admitted inputs.
 * Envelope-owned; necessary JSON decode only (public --authority-ref owns grammar).
 */
function decodeReviewerAdmittedInputs(getFlag: (name: string) => unknown): ReviewerAdmittedInputs {
  let reviewScopeKeys: readonly string[] | undefined;
  const rawScopeKeys = getFlag("ak-review-scope-keys");
  if (rawScopeKeys !== undefined) {
    if (typeof rawScopeKeys !== "string" || rawScopeKeys.length === 0) {
      throw new Error("Reviewer scope keys must be a nonempty comma-separated string");
    }
    const parsed = rawScopeKeys.split(",");
    if (parsed.some((key) => key.trim().length === 0) || new Set(parsed).size !== parsed.length) {
      throw new Error("Reviewer scope keys contain a blank or exact duplicate key");
    }
    reviewScopeKeys = Object.freeze(parsed);
  }

  let authorityRefs: readonly string[] | undefined;
  const rawAuthorityRefs = getFlag("ak-review-authority-refs");
  if (rawAuthorityRefs !== undefined) {
    if (typeof rawAuthorityRefs !== "string") {
      throw new Error("Reviewer authority refs transport error: flag value must be a string");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawAuthorityRefs);
    } catch (error) {
      throw new Error(
        `Reviewer authority refs transport error: JSON decode failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(parsed) || parsed.some((ref) => typeof ref !== "string")) {
      throw new Error("Reviewer authority refs transport error: expected a JSON array of strings");
    }
    authorityRefs = Object.freeze(parsed as string[]);
  }

  let ticketNumber: number | undefined;
  const rawTicketNumber = getFlag("ak-review-ticket-number");
  // Shape-invalid flag values do not abort: omit typed candidate; branch→commit→degrade continues.
  if (typeof rawTicketNumber === "string" && /^[1-9]\d*$/.test(rawTicketNumber)) {
    ticketNumber = Number(rawTicketNumber);
  }

  const baseRevision = getFlag("ak-review-base");
  if (typeof baseRevision !== "string" || !baseRevision.trim()) {
    throw new Error("Reviewer role requires --ak-review-base");
  }
  return Object.freeze({
    baseRevision,
    ...(reviewScopeKeys === undefined ? {} : { reviewScopeKeys }),
    ...(authorityRefs === undefined ? {} : { authorityRefs }),
    ...(ticketNumber === undefined ? {} : { ticketNumber }),
  });
}

/**
 * Parent system-prompt assembly for the shared activation envelope.
 * Verification cadence lives in soul/quality-law only (ADR 0073: no machine copy).
 */
function assembleReviewerParentSystemPrompt(input: {
  baseSystemPrompt: string;
  soul: string;
  specDisposition?: ReviewerSpecDisposition;
}): string {
  const specDispositionNote =
    input.specDisposition === "skipped-missing"
      ? [
          "",
          "<reviewer_spec_disposition>",
          "权威 Spec 不存在；未启动 Spec 取证腿。",
          "</reviewer_spec_disposition>",
        ]
      : [];
  return [
    input.baseSystemPrompt,
    "",
    "<reviewer_soul>",
    input.soul,
    "</reviewer_soul>",
    ...specDispositionNote,
  ].join("\n");
}
import {
  CODER_OUTPUT_TOOL_NAME,
  createCoderRoleRuntime,
  createFixerRoleRuntime,
  FIXER_FLAG_DEFINITIONS,
  FIXER_OUTPUT_TOOL_NAME,
  FIXER_PHASES,
} from "./worker-role.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "./merger-contracts.ts";
import { createMergerRoleRuntime, type MergerRoleDependencies } from "./merger-role.ts";

export {
  buildNavigatorInfrastructureFailureFact,
  classifyPackagedRoleTerminalResult,
  hasNavigatorInfrastructureFailureBase,
  isAcceptedPackagedRoleTerminalResult,
  isDurablePackagedRoleTerminalResult,
  isNavigatorInfrastructureFailureFact,
  NAVIGATOR_INFRASTRUCTURE_FAILURE_EVIDENCE_KEYS,
  NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND,
  type NavigatorInfrastructureFailureFact,
  type PackagedRoleTerminalClassification,
} from "./navigator-invocation-identity.ts";
export { activationTraceRecordSchema, namedActivationCause } from "./activation-trace.ts";
export type { ActivationTraceRecord, ActivationTraceWriter } from "./activation-trace.ts";
export {
  ACCEPTED_ACTIVATION_EVENT,
  ACCEPTED_ACTIVATION_FACT_KEYS,
  ActivationGitRepositoryRequiredError,
  ActivationLedgerError,
  ActivationSessionFileMissingError,
  activationBookDirectory,
  activationWaitingLedgerPath,
  appendAcceptedActivationFact,
  appendAcceptedActivationToBook,
  buildAcceptedActivationFact,
  correlationIdentityFromEnv,
  durableSessionPointer,
  resolveActivationLedgerHome,
  resolveBookKeyFromGit,
  serializeAcceptedActivationFact,
} from "./activation-ledger.ts";
export type {
  AcceptedActivationFact,
  AcceptedActivationFactInput,
  AcceptedActivationFactKey,
  ActivationCorrelationIdentity,
  ActivationSessionManager,
  ActivationSessionPointer,
} from "./activation-ledger.ts";
export {
  DISPATCH_STUB_EVENT,
  buildDispatchStubFact,
  reconcileInvocation,
} from "./activation-reconciliation.ts";
export type {
  DispatchPointer,
  DispatchStubFact,
  DispatchStubFactInput,
  ProcessLivenessFact,
  ReconciliationOutcome,
  ReconciliationSubject,
} from "./activation-reconciliation.ts";
export {
  TOOL_EXECUTION_UPDATE_HEARTBEAT,
  TOOL_EXECUTION_UPDATE_THROTTLE_MS,
  createToolExecutionObservationFace,
  isProducingToolUpdate,
  systemToolExecutionObservationMonoNow,
  toolExecutionObservationRecordSchema,
  validateToolExecutionObservationRecord,
  writeToolExecutionObservationRecord,
} from "./tool-execution-observation.ts";
export type { ToolExecutionObservationRecord, ToolExecutionObservationWriter } from "./tool-execution-observation.ts";
export { executeAuditorChild } from "./evidence-child-executor.ts";
export type { AuditorCompletion, AuditorDecisionTool } from "./evidence-child-executor.ts";
export {
  NOTARY_OUTPUT_TOOL,
  INSPECTOR_OUTPUT_TOOL,
  GATEKEEPER_OUTPUT_TOOL,
  GatekeeperDecisionError,
  createGatekeeperOutputTool,
  createOfficerDecisionTool,
  runGatekeeper,
} from "./gatekeeper-role.ts";
export type { GatekeeperResult, GatekeeperSubject, GatekeeperNonPassResult, RunGatekeeperOptions } from "./gatekeeper-role.ts";

export {
  DOCTOR_EVIDENCE_TOOL_NAME,
  DOCTOR_OUTPUT_TOOL_NAME,
} from "./doctor-role.ts";
export type { DoctorCase, DoctorCaseCost, DoctorSubmission, DoctorOutput, DoctorFinding } from "./doctor-contracts.ts";
export { validateDoctorSubmissionShape, validateDoctorOutput, DoctorEvidenceStore } from "./doctor-contracts.ts";
export { loadDoctorCase } from "./doctor-evidence.ts";
export {
  JUDGE_OUTPUT_TOOL_NAME,
  type JudgeVerdict,
  type SoulAuditResult,
} from "./judge-role.ts";
export { ENGINE_DETOUR_TOOL_NAME, AK_ROLE_ENGINE_ENV } from "./engine-detour.ts";
export {
  AGENT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  type ReviewerIntent,
} from "./reviewer-role.ts";
export {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_FLAG_DEFINITIONS,
  FIXER_OUTPUT_TOOL_NAME,
  FIXER_PHASES,
  type CoderOutput,
  type FixerOutput,
  type WorkerOutput,
} from "./worker-role.ts";
export { fixerOutputSchema, validateFixerOutput, validateFixerOutputForPacket } from "./package-contracts/fixer-output.ts";
export type { FixerBlocker, FixerClassResult, FixerPhase, FixerTestEvidence } from "./package-contracts/fixer-output.ts";
export { fixerPrerequisiteSchema, fixerPrerequisitesSchema, parseFixerPrerequisites, validateFixerPrerequisites } from "./package-contracts/fixer-packet.ts";
export type { FixerInvocationInput, FixerPrerequisite } from "./package-contracts/fixer-packet.ts";
export { AUDIT_ESCALATION_KIND, buildAuditEscalationResult, disposeComplianceDecision, isAuditEscalationResult, projectAuditEscalation } from "./audit-escalation.ts";
export type { AuditEscalationResult, AuditEscalationToolResult, ComplianceDecisionHandlers } from "./audit-escalation.ts";
export { AUDITOR_SOUL_ROLES, loadAuditorSoul } from "./auditor-soul.ts";
export type { AuditorSoulRole } from "./auditor-soul.ts";
export { JUDGE_AUDIT_TOOL_NAME, SOUL_AUDIT_TOOL_NAME, createPiJudgeAuditor } from "./judge-auditor.ts";
export { DOCTOR_AUDIT_TOOL_NAME, createPiDoctorAuditor } from "./doctor-auditor.ts";
export type { ComplianceDecision } from "./compliance-transport.ts";
export {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
} from "./collector-role.ts";
export type {
  ReviewerExecutionRecord,
  ReviewerTargetSnapshot,
  ReviewerUsage,
  ReviewerWorkspaceDisposition,
} from "./reviewer-execution-ledger.ts";
export type { AcceptedReviewerDispatch, AcceptedReviewerExecution, ReviewerPinnedGitReader } from "./reviewer-dispatch.ts";
export type { ReviewerDispatchRunResult } from "./reviewer-agent.ts";
export type { CollectorReceipt } from "./collector-receipt.ts";
export type { CollectorGitHubTransport } from "./collector-github.ts";
export type { CollectorClock } from "./collector-evidence.ts";
export * from "./navigator-attendance.ts";
export { MERGER_INPUT_FLAG, MERGER_ACTIVE_TOOLS, createMergerRoleRuntime } from "./merger-role.ts";
export { MERGER_OUTPUT_TOOL_NAME, mergerInputSchema, mergerOutputSchema, validateMergerInput, validateMergerOutput } from "./merger-contracts.ts";
export type { MergerInput, MergerMaterial, MergerOutput } from "./merger-contracts.ts";
export { createProductionMergerGitState } from "./merger-git-state.ts";
export type { MergerGitState, ActiveMergerGitState, CompletedMergerGitState } from "./merger-git-state.ts";
export type { MergerRoleDependencies } from "./merger-role.ts";

type WorkerArmable = {
  activate(context?: ExtensionContext): Promise<void>;
  armSubmissionGate(cwd: string, parent?: { getSessionFile(): string | undefined }): void;
};

type ActivationRuntime = {
  event: { reason: string };
  context: ExtensionContext;
  judge: { activate(): Promise<void> };
  fixer: WorkerArmable;
  coder: WorkerArmable;
  reviewer: {
    activate(
      context: ExtensionContext,
      admitted: ReviewerAdmittedInputs,
    ): Promise<ReviewerActivation>;
  };
  /** Envelope decodes Reviewer transport flags inside the activation stage. */
  decodeReviewerAdmitted(): ReviewerAdmittedInputs;
  /** Envelope stores live parent activation for agent_start prompt assembly. */
  bindReviewerParent(activation: ReviewerActivation): void;
  collector: { activate(context: ExtensionContext, event: { reason: string }): Promise<void> };
  doctor: { activate(): Promise<void> };
  notary: { activate(): Promise<void> };
  merger(): Promise<void>;
};

function activationStage(role: PackagedRole, runtime: ActivationRuntime): { id: string; run(): Promise<void> } {
  switch (role) {
    case "judge": return { id: "load-and-install", run: async () => runtime.judge.activate() };
    case "fixer": return { id: "load-and-install", run: async () => runtime.fixer.activate() };
    case "coder": return { id: "load-and-install", run: async () => runtime.coder.activate(runtime.context) };
    case "reviewer": return { id: "load-install-and-dispatch", run: async () => {
      // Envelope owns flag decode inside the activation stage (trace + fail-closed path).
      const admitted = runtime.decodeReviewerAdmitted();
      const activation = await runtime.reviewer.activate(runtime.context, admitted);
      runtime.bindReviewerParent(activation);
      const result = await activation.dispatcher.dispatch(activation.fixedBaseRevision, { context: runtime.context });
      if (result.status !== "accepted") {
        const rejection = new ExplicitInternalActivationError(
          `Fixed Reviewer dispatch was not accepted: ${result.status}: ${result.diagnostic}`,
          {
            knownCause: "activation",
            name: "ReviewerDispatchRejectionError",
          },
        );
        // Pi stderr cannot carry the structured violations. Do not mask a durable
        // write failure: its infrastructure cause is truer than the unwritten page.
        const runDir = process.env.AK_ROLE_RUN_DIR;
        if (typeof runDir === "string" && runDir.trim() !== "") {
          recordReviewerDispatchRejectionSync(runDir, {
            diagnostic: rejection.message,
            violations: result.violations,
          });
        }
        throw rejection;
      }
    } };
    case "collector": return { id: "load-and-install", run: async () => runtime.collector.activate(runtime.context, runtime.event) };
    case "doctor": return { id: "load-and-install", run: async () => runtime.doctor.activate() };
    case "notary": return { id: "load-and-install", run: async () => runtime.notary.activate() };
    case "merger": return { id: "prepare-git-and-install", run: async () => runtime.merger() };
  }
}

function validateActivationTraceRecord(record: unknown): ActivationTraceRecord {
  if (!Value.Check(activationTraceRecordSchema, record)) {
    throw new TypeError("Activation trace record does not match its closed contract");
  }
  return record as ActivationTraceRecord;
}

async function emitActivationTrace(
  writeTrace: (record: ActivationTraceRecord) => void | Promise<void>,
  record: unknown,
): Promise<void> {
  await writeTrace(validateActivationTraceRecord(record));
}

async function executeActivationStage(
  role: string,
  stage: { id: string; run(): Promise<void> },
  infrastructure: { clock(): string; writeTrace(record: ActivationTraceRecord): void | Promise<void> },
): Promise<void> {
  try {
    await stage.run();
  } catch (activationError) {
    try {
      await emitActivationTrace(infrastructure.writeTrace, {
        role,
        stageId: stage.id,
        status: "failed",
        timestamp: infrastructure.clock(),
        cause: namedActivationCause(activationError),
      });
    } catch (traceError) {
      throw new AggregateError([activationError, traceError], `Activation stage ${stage.id} failed and its failure trace could not be emitted`);
    }
    throw activationError;
  }
}

export function writeActivationTraceRecord(
  record: ActivationTraceRecord,
  write: typeof writeSync = writeSync,
): void {
  writeStderrJsonlRecord(record, write);
}

export class ActivationBarrierError extends Error {
  readonly code = "AK_ACTIVATION_NOT_ADMITTED";
  constructor(role: unknown) {
    super(`Workflow role ${String(role)} activation did not complete`);
    this.name = "ActivationBarrierError";
  }
}

export const WORKFLOW_ROLES = PACKAGED_ROLE_REGISTRY.map(({ role }) => role) as Array<(typeof PACKAGED_ROLE_REGISTRY)[number]["role"]>;
export const ROLE_FLAG = {
  name: "ak-role",
  definition: {
    description: `Activate a packaged workflow role: ${WORKFLOW_ROLES.slice(0, -1).join(", ")}, or ${WORKFLOW_ROLES.at(-1)}`,
    type: "string" as const,
  },
} as const;

type NavigatorAttendanceDependency = Omit<NavigatorAttendance, "knownRoutePlaybookReadFailure"> &
  Partial<Pick<NavigatorAttendance, "knownRoutePlaybookReadFailure">>;

export type RoleRuntimeDependencies = {
  loadJudgeSoul(): Promise<string>;
  loadFixerSoul?(): Promise<string>;
  loadFixPacket?(path: string): Promise<string>;
  loadCoderSoul?(): Promise<string>;
  loadCoderTask?(path: string): Promise<string>;
  loadReviewerSoul?(): Promise<string>;
  createReviewerPinnedGitReader?(): Promise<ReviewerPinnedGitReader>;
  /** Shared-seam issue-fetch capability for Reviewer Spec self-fetch (#343). */
  createReviewerIssueFetcher?(): ReviewerIssueFetcher;
  loadCollectorSoul?(): Promise<string>;
  createCollectorTransport?(): CollectorGitHubTransport;
  loadDoctorSoul?(): Promise<string>;
  loadNotarySoul?(): Promise<string>;
  loadNotarySourceRun?(path: string): Promise<import("./notary-contracts.ts").NotarySourceRunLocator>;
  loadDoctorCase?(path: string): Promise<import("./doctor-contracts.ts").DoctorCase>;
  loadMergerSoul?(): Promise<string>;
  loadMergerInput?(path: string): Promise<unknown>;
  mergerGitState?: MergerRoleDependencies["gitState"];
  createMergerGitState?(repositoryRoot: string): MergerRoleDependencies["gitState"];
  auditDoctorCompliance?(options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision>;
  createCollectorClock?(): CollectorClock;
  collectorPackageExtensionPath?: string;
  createNavigatorAttendance?(options: { context: ExtensionContext; role: string; phase: NavigatorPhase; subjectKey: string; subject: string; authority: string; contextError?: unknown; invocationId: string; onEvent: (event: import("./navigator-attendance.ts").NavigatorEvent, report: import("./navigator-attendance.ts").NavigatorReport) => void | Promise<void> }): NavigatorAttendanceDependency | Promise<NavigatorAttendanceDependency>;
  loadNavigatorWorkContext?(options: { context: ExtensionContext; role: string; phase: NavigatorPhase }): Promise<NavigatorWorkContext>;
  loadCanonicalSkillBinding?(
    name: "tdd" | "code-review",
  ): Promise<AnyCanonicalSkillBinding>;
  runReviewerDispatch?(
    dispatch: AcceptedReviewerExecution,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<ReviewerDispatchRunResult>;
  shutdownReviewerAgent?(): Promise<void>;
  transcriptFromContext(ctx: ExtensionContext): string;
  auditSoulCompliance(
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<SoulAuditResult>;
  activationClock?(): string;
  activationTraceWriter?: (record: ActivationTraceRecord) => void | Promise<void>;
  /** Wall-clock ISO timestamps for tool-execution observation records; defaults to activationClock/Date. */
  toolExecutionObservationClock?(): string;
  /** Monotonic ms clock for update throttling; defaults to performance.now (not Date.now). */
  toolExecutionObservationMonoNow?(): number;
  toolExecutionObservationWriter?: ToolExecutionObservationWriter;
  /**
   * #351 OAuth keepalive: providers/interval/scheduler.
   * Production extension root reads oauth-keepalive.json and passes providers here
   * (default ["kimi-coding"] when the setting file is absent). Tests may inject.
   */
  oauthKeepalive?: OAuthKeepaliveOptions;
};

function abortContext(ctx: ExtensionContext): void {
  const abort = (ctx as ExtensionContext & { abort?: () => void }).abort;
  if (typeof abort === "function") abort.call(ctx);
}

function failInfrastructure(error: unknown, ctx: ExtensionContext): never {
  abortContext(ctx);
  if (ctx.mode === "print" || ctx.mode === "json") process.exitCode = 1;
  throw error;
}

/**
 * Envelope-owned pending infrastructure failure: closed fact + original Error evidence.
 * tool_result projects once from this record; settlement consumes durable details as-is.
 */
type PendingInfrastructureFailure = {
  readonly details: Record<string, unknown>;
};

function extractInfrastructureFailureEvidence(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  const evidence: Record<string, unknown> = {};
  for (const key of NAVIGATOR_INFRASTRUCTURE_FAILURE_EVIDENCE_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    // undefined → null so JSON durable details retain the empty-candidate key.
    evidence[key] = record[key] === undefined ? null : record[key];
  }
  return evidence;
}

function buildPendingInfrastructureFailure(error: unknown): PendingInfrastructureFailure {
  return {
    details: {
      ...buildNavigatorInfrastructureFailureFact(),
      ...extractInfrastructureFailureEvidence(error),
    },
  };
}

function navigatorPhase(pi: ExtensionAPI, role: string): NavigatorPhase {
  const metadata = packagedRoleMetadata(role);
  if (metadata === undefined || metadata.phases[0] === null) return null;
  const phaseFlag = packagedRolePhaseFlag(role);
  const requested = phaseFlag === undefined ? undefined : pi.getFlag(phaseFlag);
  return requested === "apply" ? "apply" : "plan";
}

function navigatorOutputTool(role: string): string | undefined {
  return packagedRoleOutputTool(role);
}

export function publicNavigatorSettlement(role: string, phase: NavigatorPhase, event: { toolName: string; isError?: unknown; details: unknown }): NavigatorSettlement | undefined {
  // One shared classifier owns terminal discriminant (lifecycle + settlement + extractors).
  if (event.toolName !== navigatorOutputTool(role)) return undefined;
  const classification = classifyPackagedRoleTerminalResult(event);
  if (classification.kind === "nonterminal") return undefined;
  if (classification.kind === "infrastructure") {
    return { kind: "role_infrastructure_failure", role, phase };
  }
  // accepted/human — project role/phase status; classifier already rejected infra/contradiction.
  const details = typeof event.details === "object" && event.details !== null && !Array.isArray(event.details)
    ? event.details as Record<string, unknown>
    : {};
  // Live Navigator consumes only the audit-owned projection; persisted/replayed
  // records are re-authenticated by settlement against retained audit evidence.
  if (isAuditEscalationProjection(event.details)) {
    return { kind: "human_decision", role, phase, status: "audit_escalation" };
  }
  const status = typeof details.status === "string"
    ? details.status
    : typeof details.judgeStatus === "string" ? details.judgeStatus : undefined;
  if (status !== undefined && status === "escalate") {
    return { kind: "human_decision", role, phase, status };
  }
  return { kind: "accepted", role, phase, ...(status === undefined ? {} : { status }) };
}

export function createRoleRuntimeExtension(
  dependencies: RoleRuntimeDependencies,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerFlag(ROLE_FLAG.name, ROLE_FLAG.definition);
    // Reviewer transport flags: shared envelope owns registration (ADR 0018).
    for (const flag of REVIEWER_TRANSPORT_FLAGS) {
      pi.registerFlag(flag.name, flag.definition);
    }

    let admitted = false;
    let selectedRole: string | undefined;
    /** Live Reviewer parent activation for envelope agent_start prompt assembly. */
    let activeReviewerParent: ReviewerActivation | undefined;
    /** Envelope-owned Reviewer Skill expansion state (ADR 0018 — not a role-module facade). */
    let reviewerOriginalRequest: string | undefined;
    let reviewerExpansionCaptured = false;
    let navigatorAttendance: NavigatorAttendanceDependency | undefined;
    // #351: session-lifecycle owner for periodic OAuth refresh (orthogonal to role admission).
    const oauthKeepalive = createOAuthKeepalive(dependencies.oauthKeepalive);
    let pendingNavigatorPresentation: { event: import("./navigator-attendance.ts").NavigatorEvent; report: import("./navigator-attendance.ts").NavigatorReport } | undefined;
    let pendingNavigatorSettlement: Promise<void> | undefined;
    let navigatorWorkContext: NavigatorWorkContext | undefined;
    /** toolCallId → fact+evidence; one-shot projected onto durable tool_result (#475). */
    const pendingInfrastructureFailures = new Map<string, PendingInfrastructureFailure>();
    // Envelope-owned execute→tool_result bridge for Gatekeeper non-pass (ADR 0018).
    const pendingGatekeeperNonPassByToolCallId = new Map<string, GatekeeperNonPassResult>();
    let engineDetourRegistered = false;
    // #288 primary-session thin adapter. The policy is the sole budget owner;
    // terminating-tool rejections and mechanical delivery requests share two turns.
    let receiptDelivery = createReceiptDeliveryPolicy();
    let noReceiptRecorded = false;
    pi.on("input", (event) => {
      const role = pi.getFlag(ROLE_FLAG.name);
      if (role !== undefined && !admitted) return { action: "handled" as const };
      // Envelope exclusively owns Reviewer Skill invocation transform + original-request capture.
      if (
        role === "reviewer"
        && admitted
        && activeReviewerParent !== undefined
        && reviewerOriginalRequest === undefined
      ) {
        reviewerOriginalRequest = event.text;
        return {
          action: "transform" as const,
          text: activeReviewerParent.skillBinding.invocation(event.text),
          ...(event.images === undefined ? {} : { images: event.images }),
        };
      }
      return { action: "continue" as const };
    });
    pi.on("before_agent_start", (event, ctx) => {
      const role = pi.getFlag(ROLE_FLAG.name);
      if (role === undefined) return;
      if (!admitted || selectedRole !== role) {
        failInfrastructure(new ActivationBarrierError(role), ctx);
      }
      if (navigatorAttendance !== undefined && navigatorWorkContext !== undefined && navigatorWorkContext.contextError === undefined) {
        // Flagged roles already have a concrete packet/task/case/review input.
        // A bare Judge (and other bare packaged entrypoint) gets its concrete
        // user task at this seam; do not copy the assembled system prompt.
        // Replacement is keyed by typed subject provenance, never prose prefixes.
        // Soft session_start placeholders (no materials yet) recover here; hard
        // contextError from true loader failures stays poisoned and honest.
        if (navigatorWorkContext.subjectProvenance === "placeholder") {
          const subject = event.prompt.trim();
          if (subject !== "") {
            const root = subjectPath(ctx.sessionManager.getSessionDir(), ctx.cwd);
            const subjectProvenance = "user_prompt" satisfies NavigatorSubjectProvenance;
            const priorAuthority = navigatorWorkContext.authority;
            const authority = typeof priorAuthority === "string" && priorAuthority.trim() !== ""
              ? priorAuthority
              : subject;
            navigatorWorkContext = {
              subjectKey: navigatorSubjectKey(root, subject, subjectProvenance),
              subject,
              authority,
              subjectProvenance,
            };
            navigatorAttendance.setWorkContext(navigatorWorkContext);
          }
        }
      }
      navigatorAttendance?.prepare();
      // Envelope-owned Reviewer expansion capture + parent prompt assembly (no role-module callback).
      if (role === "reviewer" && activeReviewerParent !== undefined) {
        if (!reviewerExpansionCaptured) {
          if (
            reviewerOriginalRequest === undefined
            || activeReviewerParent.skillBinding.captureExpansion(event.prompt, reviewerOriginalRequest) === undefined
          ) {
            failInfrastructure(
              new Error("Canonical code-review Skill expansion did not match the captured request"),
              ctx,
            );
          }
          reviewerExpansionCaptured = true;
        }
        const specDisposition = activeReviewerParent.getSpecDisposition();
        return {
          systemPrompt: assembleReviewerParentSystemPrompt({
            baseSystemPrompt: event.systemPrompt,
            soul: activeReviewerParent.soul,
            ...(specDisposition === undefined ? {} : { specDisposition }),
          }),
        };
      }
    });
    pi.on("tool_result", async (event) => {
      const role = selectedRole;
      if (role === undefined) return;
      const pendingInfra = pendingInfrastructureFailures.get(event.toolCallId);
      const isRoleInfrastructureFailure = pendingInfra !== undefined;
      if (pendingInfra !== undefined) pendingInfrastructureFailures.delete(event.toolCallId);
      // One-shot project fact + typed evidence so live settlement and durable session agree.
      const infrastructureDetails = pendingInfra?.details;
      const classified = infrastructureDetails === undefined
        ? event
        : { ...event, details: infrastructureDetails };
      const isOutputTool = event.toolName === navigatorOutputTool(role);
      const outputClassification = isOutputTool ? classifyPackagedRoleTerminalResult(classified) : undefined;
      if (isRoleInfrastructureFailure || outputClassification?.kind === "infrastructure") {
        receiptDelivery.stopForInfrastructure();
      } else if (outputClassification?.kind === "accepted") {
        receiptDelivery.recordAccepted();
      } else if (isOutputTool && outputClassification?.kind === "nonterminal" && event.isError) {
        const reason = (event.content ?? [])
          .map((part) => part.type === "text" ? part.text : "")
          .join("")
          .trim() || "terminating tool rejected";
        receiptDelivery.recordRejected(reason);
      }
      const settlement = publicNavigatorSettlement(
        role,
        navigatorPhase(pi, role),
        classified,
      );
      if (settlement !== undefined) {
        const attendance = navigatorAttendance;
        if (attendance !== undefined) {
          const workContext = navigatorWorkContext;
          const pending = (async () => {
          // Accepted role terminal starts the post-role Navigator grace (#101/#106).
          if (settlement.kind !== "accepted") {
            await attendance.settle(settlement);
            // Emission stays on agent_settled (normal completion) or session_shutdown
            // flush (abort/infrastructure teardown that skips agent_settled).
            return;
          }
          const settlePromise = attendance.settle(settlement);
          const raced = await raceNavigatorGrace(settlePromise, NAVIGATOR_POST_ROLE_GRACE_MS);
          if (raced.status === "timeout") {
            if (pendingNavigatorPresentation === undefined) {
              const routePlaybookReadFailure = attendance.knownRoutePlaybookReadFailure?.();
              const report: NavigatorReport = {
                disposition: "unavailable",
                unavailableReason: "Navigator exceeded post-role delivery grace",
                unavailableSource: "unknown",
                unavailableCause: "unknown",
                ...(routePlaybookReadFailure === undefined ? {} : { routePlaybookReadFailure }),
              };
              const navigatorEvent: NavigatorEvent = {
                version: 1,
                disposition: "unavailable",
                invocationId: "post-role-grace-timeout",
                role,
                phase: navigatorPhase(pi, role),
                subjectKey: workContext?.subjectKey ?? "",
                unavailableReason: "Navigator exceeded post-role delivery grace",
                unavailableSource: "unknown",
                unavailableCause: "unknown",
                ...(routePlaybookReadFailure === undefined ? {} : { routePlaybookReadFailure }),
              };
              pendingNavigatorPresentation = { event: navigatorEvent, report };
            }
            attendance.dispose();
            void settlePromise.catch(() => undefined);
          }
        })();
          pendingNavigatorSettlement = pending;
          await pending;
        }
      }
      // Persist typed infrastructure-failure fact onto the role session toolResult so
      // exact-session restart shares the same durable completion classification.
      if (infrastructureDetails !== undefined) {
        return { details: infrastructureDetails, isError: true };
      }
      // Gatekeeper non-pass: throw kept message text for the model; project the
      // envelope-bound structured result onto session details at this tool_result seam.
      const gatekeeperNonPass = pendingGatekeeperNonPassByToolCallId.get(event.toolCallId);
      if (gatekeeperNonPass !== undefined) {
        pendingGatekeeperNonPassByToolCallId.delete(event.toolCallId);
        return { details: gatekeeperNonPass, isError: true };
      }
      // Recommendation rides the accepted settlement record's content so the one
      // mandatory last-ak_*_output extraction surfaces route/next/reason without
      // a second file, grep, or nesting step. Receipt details stay contract-pure;
      // unavailable/no-advice leave the settlement untouched.
      if (event.isError) return;
      const decorated = decorateSettlementWithNavigation(event, pendingNavigatorPresentation);
      if (decorated === undefined) return;
      return {
        content: decorated.content as typeof event.content,
      };
    });
    // Queue receipt delivery before `agent_settled`: that event means Pi has
    // already decided no queued continuation will run, so a triggerTurn there is
    // too late for print/json sessions. `agent_end` is the last production seam
    // whose queued next turn is consumed before settlement.
    pi.on("agent_end", (event) => {
      const lastMessage = event.messages.at(-1);
      if (lastMessage?.role === "assistant"
        && (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted")) {
        // Provider failure/abort has no tool_result event; classify it here so the
        // receipt policy cannot turn infrastructure death into an exit-0 lifecycle.
        receiptDelivery.stopForInfrastructure();
        return;
      }
      if (receiptDelivery.nextAction() === "request-delivery") {
        receiptDelivery.recordDeliveryRequest();
        // Keep the package-owned continuation off the public input lifecycle:
        // one-shot roles must not mistake this delivery request for later caller input.
        pi.appendEntry("ak-receipt-delivery-request");
        pi.sendMessage({
          customType: "ak-receipt-delivery-prompt",
          content: RECEIPT_DELIVERY_PROMPT,
          display: false,
        }, { triggerTurn: true, deliverAs: "followUp" });
      } else if (receiptDelivery.nextAction() === "no-receipt" && !noReceiptRecorded) {
        const runPointer = process.env.AK_ROLE_RUN_DIR;
        if (runPointer !== undefined) {
          noReceiptRecorded = true;
          pi.appendEntry(
            NO_RECEIPT_LIFECYCLE_ENTRY_TYPE,
            receiptDelivery.facts({ runPointer, attemptPointer: `current:${runPointer}` }),
          );
        }
      }
    });
    pi.on("agent_settled", async () => {
      if (pendingNavigatorSettlement !== undefined) {
        await pendingNavigatorSettlement;
      }
      // Do not auto-drain Navigator on ordinary mid-turn agent_settled.
      // Multi-turn roles (#162 coder) fire agent_settled after every tool turn;
      // discarding a healthy/in-flight prepare there forces a cold prepare on the
      // final accepted terminal and races the post-role grace. Keep preparation
      // until an accepted/human/infrastructure tool_result settlement (or dispose).
      // Provider death without any role tool_result leaves preparation held; the
      // next explicit settlement or session end owns it — not mid-turn churn.
      pendingNavigatorSettlement = undefined;
      const presentation = pendingNavigatorPresentation;
      pendingNavigatorPresentation = undefined;
      if (presentation === undefined) return;
      await pi.sendMessage({
        customType: NAVIGATOR_EVENT_TYPE,
        content: formatNavigatorReport(presentation.report),
        display: true,
        details: presentation.event,
      }, { triggerTurn: false });
    });
    pi.on("session_shutdown", async () => {
      // #351: stop OAuth keepalive first so shutdown yields zero further ticks.
      oauthKeepalive.stop();
      // Flush any still-pending affirmative attendance before teardown. Accepted
      // grace-timeout paths normally emit on agent_settled; abort can skip that hook.
      const presentation = pendingNavigatorPresentation;
      pendingNavigatorPresentation = undefined;
      if (presentation !== undefined) {
        try {
          await pi.sendMessage({
            customType: NAVIGATOR_EVENT_TYPE,
            content: formatNavigatorReport(presentation.report),
            display: true,
            details: presentation.event,
          }, { triggerTurn: false });
        } catch {
          // Teardown must not mask the original role failure cause.
        }
      }
      navigatorAttendance?.dispose();
      navigatorAttendance = undefined;
      pendingNavigatorSettlement = undefined;
      pendingInfrastructureFailures.clear();
      pendingGatekeeperNonPassByToolCallId.clear();
      observationFace.reset();
    });

    const hostActions = {
      failInfrastructure(error: unknown, ctx: ExtensionContext, toolCallId?: string): never {
        if (toolCallId !== undefined) {
          pendingInfrastructureFailures.set(toolCallId, buildPendingInfrastructureFailure(error));
        }
        failInfrastructure(error, ctx);
      },
      bindGatekeeperNonPass(toolCallId: string, result: GatekeeperNonPassResult): void {
        pendingGatekeeperNonPassByToolCallId.set(toolCallId, result);
      },
    };
    const judge = createJudgeRoleRuntime(
      pi,
      {
        loadSoul: dependencies.loadJudgeSoul,
        auditSoulCompliance: dependencies.auditSoulCompliance,
      },
      hostActions,
    );
    const fixer = createFixerRoleRuntime(
      pi,
      {
        async loadSoul() {
          if (dependencies.loadFixerSoul === undefined) {
            throw new Error("fixer soul loader is not configured");
          }
          return dependencies.loadFixerSoul();
        },
        async loadPacket(path) {
          if (dependencies.loadFixPacket === undefined) {
            throw new Error("Fixer packet loader is not configured");
          }
          return dependencies.loadFixPacket(path);
        },
      },
      hostActions,
    );
    const coder = createCoderRoleRuntime(
      pi,
      {
        async loadSoul() {
          if (dependencies.loadCoderSoul === undefined) {
            throw new Error("coder soul loader is not configured");
          }
          return dependencies.loadCoderSoul();
        },
        async loadTask(path) {
          if (dependencies.loadCoderTask === undefined) {
            throw new Error("Coder task loader is not configured");
          }
          return dependencies.loadCoderTask(path);
        },
        ...(dependencies.loadCanonicalSkillBinding === undefined
          ? {}
          : {
              loadCanonicalSkillBinding: (name: "tdd") =>
                dependencies.loadCanonicalSkillBinding!(name),
            }),
      },
      hostActions,
    );
    const reviewer = createReviewerRoleRuntime(
      pi,
      {
        async loadSoul() {
          if (dependencies.loadReviewerSoul === undefined) {
            throw new Error("reviewer soul loader is not configured");
          }
          return dependencies.loadReviewerSoul();
        },
        async createPinnedGitReader() {
          if (dependencies.createReviewerPinnedGitReader === undefined) throw new Error("Reviewer runtime dependencies are not configured");
          return dependencies.createReviewerPinnedGitReader();
        },
        async loadCanonicalSkillBinding(name) {
          if (dependencies.loadCanonicalSkillBinding === undefined) {
            throw new Error("Reviewer runtime dependencies are not configured");
          }
          return dependencies.loadCanonicalSkillBinding(name);
        },
        ...(dependencies.createReviewerIssueFetcher === undefined
          ? {}
          : { fetchIssue: dependencies.createReviewerIssueFetcher() }),
        async runDispatch(dispatch, options) {
          if (dependencies.runReviewerDispatch === undefined) throw new Error("Reviewer runtime dependencies are not configured");
          return dependencies.runReviewerDispatch(dispatch, options);
        },
        ...(dependencies.shutdownReviewerAgent === undefined
          ? {}
          : { shutdownAgent: dependencies.shutdownReviewerAgent }),
      },
      hostActions,
    );
    const doctor = createDoctorRoleRuntime(pi, {
      async loadSoul() { if (!dependencies.loadDoctorSoul) throw new Error("Doctor runtime dependencies are not configured"); return dependencies.loadDoctorSoul(); },
      async loadCase(path) { if (!dependencies.loadDoctorCase) throw new Error("Doctor runtime dependencies are not configured"); return dependencies.loadDoctorCase(path); },
      async auditCompliance(options) { if (!dependencies.auditDoctorCompliance) throw new Error("Doctor runtime dependencies are not configured"); return dependencies.auditDoctorCompliance(options); },
    }, hostActions);
    const notary = createNotaryRoleRuntime(pi, {
      async loadSoul() {
        if (!dependencies.loadNotarySoul) throw new Error("Notary runtime dependencies are not configured");
        return dependencies.loadNotarySoul();
      },
      async loadSourceRunLocator(path) {
        if (!dependencies.loadNotarySourceRun) throw new Error("Notary runtime dependencies are not configured");
        return dependencies.loadNotarySourceRun(path);
      },
    }, hostActions);
    let sessionMergerGitState = dependencies.mergerGitState;
    const merger = createMergerRoleRuntime(pi, {
      async loadSoul() { if (!dependencies.loadMergerSoul) throw new Error("Merger runtime dependencies are not configured"); return dependencies.loadMergerSoul(); },
      async loadInput(path) { if (!dependencies.loadMergerInput) throw new Error("Merger runtime dependencies are not configured"); return dependencies.loadMergerInput(path); },
      gitState: {
        activeMerge() { if (!sessionMergerGitState) throw new Error("Merger runtime dependencies are not configured"); return sessionMergerGitState.activeMerge(); },
        completedMerge(mergeCommitId, automaticMergeTreeId) { if (!sessionMergerGitState) throw new Error("Merger runtime dependencies are not configured"); return sessionMergerGitState.completedMerge(mergeCommitId, automaticMergeTreeId); },
      },
    }, hostActions);
    const collector = createCollectorRoleRuntime(
      pi,
      {
        async loadSoul() {
          if (dependencies.loadCollectorSoul === undefined) {
            throw new Error("collector soul loader is not configured");
          }
          return dependencies.loadCollectorSoul();
        },
        createTransport() {
          if (dependencies.createCollectorTransport === undefined) {
            throw new Error("Collector GitHub transport is not configured");
          }
          return dependencies.createCollectorTransport();
        },
        ...(dependencies.createCollectorClock === undefined
          ? {}
          : { createClock: dependencies.createCollectorClock }),
        ...(dependencies.collectorPackageExtensionPath === undefined
          ? {}
          : {
            packageExtensionPath: dependencies.collectorPackageExtensionPath,
          }),
      },
      hostActions,
    );

    const clock = dependencies.activationClock ?? (() => new Date().toISOString());
    const writeTrace = dependencies.activationTraceWriter ?? writeActivationTraceRecord;
    const observationFace = createToolExecutionObservationFace({
      role: () => selectedRole,
      admitted: () => admitted,
      clock: dependencies.toolExecutionObservationClock ?? clock,
      monoNow: dependencies.toolExecutionObservationMonoNow ?? systemToolExecutionObservationMonoNow,
      write: dependencies.toolExecutionObservationWriter ?? writeToolExecutionObservationRecord,
    });
    // ExtensionRunner.emit catches ordinary handler throws, emits extension error, and continues.
    // Observation plane failures must still hit the shared infrastructure termination path
    // (abort + nonzero print/json exit) with the original cause before that swallow.
    const observe = async (
      run: () => void | Promise<void>,
      ctx: ExtensionContext,
    ): Promise<void> => {
      try {
        await run();
      } catch (error) {
        failInfrastructure(error, ctx);
      }
    };
    pi.on("tool_execution_start", async (event, ctx) => {
      await observe(() => observationFace.onStart(event), ctx);
    });
    pi.on("tool_execution_update", async (event, ctx) => {
      await observe(() => observationFace.onUpdate(event), ctx);
    });
    pi.on("tool_execution_end", async (event, ctx) => {
      await observe(() => observationFace.onEnd(event), ctx);
    });

    // Public Role run: record typed non-success HTTP for error evidence + v1 resume.
    // 2xx clears prior observation (see recordTypedProviderHttpStatus). Non-success
    // write failure must surface — never silently drop authorized error evidence.
    pi.on("after_provider_response", async (event, ctx) => {
      const runDir = process.env.AK_ROLE_RUN_DIR;
      if (typeof runDir !== "string" || runDir.trim() === "") return;
      const provider = ctx.model?.provider;
      if (typeof provider !== "string" || provider.trim() === "") return;
      const status = event.status;
      if (typeof status !== "number") return;
      try {
        await recordTypedProviderHttpStatus(runDir, {
          httpStatus: status,
          provider,
        });
      } catch (error) {
        if (
          status >= 200 &&
          status < 300 &&
          error instanceof Error &&
          "code" in error &&
          (error as { code?: unknown }).code === "ENOENT"
        ) {
          return;
        }
        failInfrastructure(error, ctx);
      }
    });

    pi.on("session_start", async (event, ctx) => {
      admitted = false;
      selectedRole = undefined;
      activeReviewerParent = undefined;
      reviewerOriginalRequest = undefined;
      reviewerExpansionCaptured = false;
      receiptDelivery = createReceiptDeliveryPolicy();
      noReceiptRecorded = false;
      observationFace.reset();
      pendingNavigatorPresentation = undefined;
      pendingNavigatorSettlement = undefined;
      pendingInfrastructureFailures.clear();
      pendingGatekeeperNonPassByToolCallId.clear();
      navigatorWorkContext = undefined;
      // #351: OAuth keepalive is orthogonal to --ak-role; start before role early-return
      // so role-less sessions (and reload after shutdown stop) still keep tokens alive.
      oauthKeepalive.start(ctx);
      const rawRole = pi.getFlag(ROLE_FLAG.name);
      if (rawRole === undefined) return;
      const entry = PACKAGED_ROLE_REGISTRY.find(({ role }) => role === rawRole);
      if (entry === undefined) {
        failInfrastructure(new Error(`Unsupported workflow role: ${String(rawRole)}`), ctx);
      }
      selectedRole = entry.role;
      navigatorAttendance?.dispose();
      navigatorAttendance = undefined;
      const runtime: ActivationRuntime = {
        event,
        context: ctx,
        judge,
        fixer,
        coder,
        reviewer,
        decodeReviewerAdmitted() {
          return decodeReviewerAdmittedInputs((name) => pi.getFlag(name));
        },
        bindReviewerParent(activation) {
          activeReviewerParent = activation;
        },
        collector,
        doctor,
        notary,
        merger: async () => {
          if (dependencies.mergerGitState === undefined) {
            sessionMergerGitState = dependencies.createMergerGitState?.(ctx.cwd);
          }
          if (sessionMergerGitState === undefined) throw new Error("Merger runtime dependencies are not configured");
          await merger.activate();
        },
      };
      try {
        // Production topology only (ADR 0048/0049): no test-only ledger hooks.
        // Admit durable session file first so lifecycle getEntries/appendEntry are truthful:
        // deferred SM materialization must not wipe an in-memory principal marker.
        const bookKey = resolveBookKeyFromGit(ctx.cwd);
        const correlation = correlationIdentityFromEnv();
        const ledgerHome = resolveActivationLedgerHome();
        const session = durableSessionPointer(ctx.sessionManager);

        if (dependencies.createNavigatorAttendance !== undefined) {
          let work: NavigatorWorkContext;
          let contextError: unknown;
          if (dependencies.loadNavigatorWorkContext === undefined) {
            const fallbackSubjectKey = subjectPath(ctx.sessionManager.getSessionDir(), ctx.cwd);
            contextError = new Error("Navigator work context loader is not configured");
            work = { subjectKey: fallbackSubjectKey, subject: `work subject: ${fallbackSubjectKey}`, authority: "", subjectProvenance: "placeholder" };
          } else {
            try {
              work = await dependencies.loadNavigatorWorkContext({ context: ctx, role: entry.role, phase: navigatorPhase(pi, entry.role) });
              contextError = work.contextError;
            } catch (error) {
              // Contract: README.md#Navigator-attendance — a failed context load continues with a typed placeholder work context; the original cause is retained in contextError for the typed unavailable report.
              contextError = navigatorUnavailableError("context", error);
              const fallbackSubjectKey = subjectPath(ctx.sessionManager.getSessionDir(), ctx.cwd);
              work = { subjectKey: fallbackSubjectKey, subject: `work subject: ${fallbackSubjectKey}`, authority: "", subjectProvenance: "placeholder" };
            }
          }
          navigatorWorkContext = { ...work, ...(contextError === undefined ? {} : { contextError }) };
          // Shared envelope owns exact invocation principal from admitted session lifecycle.
          // session_start is process activation: resume unfinished principal only when marker
          // role/phase/subjectKey still match; mint for contradictory marker, malformed nearest,
          // missing marker, or terminal already completed.
          const sessionEntries = ctx.sessionManager.getEntries();
          const invocationPhase = navigatorPhase(pi, entry.role);
          const lifecyclePrincipal = resolveLifecycleInvocationPrincipal(sessionEntries, {
            role: entry.role,
            phase: invocationPhase,
            subjectKey: work.subjectKey,
          });
          const invocationId = lifecyclePrincipal.invocationId;
          if (!lifecyclePrincipal.resume) {
            pi.appendEntry(NAVIGATOR_INVOCATION_ENTRY, {
              invocationId,
              role: entry.role,
              phase: invocationPhase,
              subjectKey: work.subjectKey,
            });
          }
          navigatorAttendance = await dependencies.createNavigatorAttendance({
            context: ctx,
            role: entry.role,
            phase: invocationPhase,
            subjectKey: work.subjectKey,
            subject: work.subject,
            authority: work.authority,
            invocationId,
            ...(contextError === undefined ? {} : { contextError }),
            onEvent: (navigatorEvent, report) => {
              pendingNavigatorPresentation = { event: navigatorEvent, report };
            },
          });
          // Warm live help during activation so prepare is not help-bound under load.
          // Concrete work context also starts full preparation so session create
          // overlaps the role run. Placeholder subjects wait for before_agent_start
          // (user prompt may replace the subject key) but still inherit warm help.
          navigatorAttendance.warmHelp?.();
          if (
            navigatorWorkContext.contextError === undefined &&
            navigatorWorkContext.subjectProvenance !== "placeholder"
          ) {
            navigatorAttendance.prepare();
          }
        }

        await executeActivationStage(entry.role, activationStage(entry.role, runtime), { clock, writeTrace });
        // #357 T2 / #378 / #380 / #391: any role+engine activation registers the package detour tool once.
        // Gate is env presence only — no per-engine execute branch; no role-module spawn.
        if (!engineDetourRegistered) {
          engineDetourRegistered = registerEngineDetourTool(pi, hostActions);
        }
        // Worker gates ①②: arm records baseline and runs private one-shot hook uninstall (ADR 0070).
        // Parent session feeds #216 createRecordSession so baseline/bounce survive resume.
        if (entry.role === "coder" || entry.role === "fixer") {
          if (entry.role === "coder") coder.armSubmissionGate(ctx.cwd, ctx.sessionManager);
          else fixer.armSubmissionGate(ctx.cwd, ctx.sessionManager);
        }
        appendAcceptedActivationToBook({
          ledgerHome,
          fact: buildAcceptedActivationFact({
            role: entry.role,
            observedAt: clock(),
            bookKey,
            session,
            correlation,
          }),
        });
        admitted = true;
      } catch (error) {
        failInfrastructure(error, ctx);
      }
    });
  };
}
