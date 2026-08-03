import { writeSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { activationTraceRecordSchema, namedActivationCause, type ActivationTraceRecord, type ActivationTraceWriter } from "./activation-trace.ts";

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
import { createDoctorRoleRuntime, type DoctorAuditInput } from "./doctor-role.ts";
import { formatNavigatorReport, type NavigatorAttendance, type NavigatorPhase, type NavigatorSettlement } from "./navigator-attendance.ts";
import {
  createJudgeRoleRuntime,
  type JudgeAdjudicativeVerdict,
  type SoulAuditInput,
  type SoulAuditResult,
} from "./judge-role.ts";
import {
  createReviewerRoleRuntime,
  type ReviewerAuditInput,
} from "./reviewer-role.ts";
import type { AcceptedReviewerExecution, ReviewerPinnedGitReader } from "./reviewer-dispatch.ts";
import type { ReviewerDispatchRunResult } from "./reviewer-agent.ts";
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

export { activationTraceRecordSchema, namedActivationCause } from "./activation-trace.ts";
export type { ActivationTraceRecord, ActivationTraceWriter } from "./activation-trace.ts";

export {
  DOCTOR_EVIDENCE_TOOL_NAME,
  DOCTOR_OUTPUT_TOOL_NAME,
  type DoctorAuditInput,
} from "./doctor-role.ts";
export type { DoctorCase, DoctorCaseCost, DoctorSubmission, DoctorOutput, DoctorFinding } from "./doctor-contracts.ts";
export { validateDoctorSubmissionShape, validateDoctorOutput, DoctorEvidenceStore } from "./doctor-contracts.ts";
export { loadDoctorCase } from "./doctor-evidence.ts";
export {
  JUDGE_OUTPUT_TOOL_NAME,
  type JudgeAdjudicativeVerdict,
  type JudgeVerdict,
  type SoulAuditInput,
  type SoulAuditResult,
} from "./judge-role.ts";
export {
  AGENT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  type ReviewerAuditInput,
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
export type { FixerBlocker, FixerClassResult, FixerPhase } from "./package-contracts/fixer-output.ts";
export { fixerPrerequisiteSchema, fixerPrerequisitesSchema, parseFixerPrerequisites, validateFixerPrerequisites } from "./package-contracts/fixer-packet.ts";
export type { FixerInvocationInput, FixerPrerequisite } from "./package-contracts/fixer-packet.ts";
export { FIXER_AUDIT_TOOL_NAME, createPiFixerAuditor } from "./fixer-auditor.ts";
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
export type { AcceptedReviewerDispatch, AcceptedReviewerExecution, ReviewerPinnedGitReader, ReviewerProposalV1 } from "./reviewer-dispatch.ts";
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

type ActivationRuntime = {
  event: { reason: string };
  context: ExtensionContext;
  judge: { activate(): Promise<void> };
  fixer: { activate(): Promise<void> };
  coder: { activate(context: ExtensionContext): Promise<void> };
  reviewer: { activate(context: ExtensionContext): Promise<void> };
  collector: { activate(context: ExtensionContext, event: { reason: string }): Promise<void> };
  doctor: { activate(): Promise<void> };
  merger(): Promise<void>;
};

export type ActivationStage = {
  readonly id: string;
  run(): Promise<void>;
};

type ActivationStageDeclaration = {
  readonly id: string;
  run(runtime: ActivationRuntime): Promise<void>;
};

export const ROLE_REGISTRY = [
  { role: "judge", stages: [{ id: "load-and-install", run: async (runtime: ActivationRuntime) => runtime.judge.activate() }] },
  { role: "fixer", stages: [{ id: "load-and-install", run: async (runtime: ActivationRuntime) => runtime.fixer.activate() }] },
  { role: "coder", stages: [{ id: "load-and-install", run: async (runtime: ActivationRuntime) => runtime.coder.activate(runtime.context) }] },
  { role: "reviewer", stages: [{ id: "load-and-install", run: async (runtime: ActivationRuntime) => runtime.reviewer.activate(runtime.context) }] },
  { role: "collector", stages: [{ id: "load-and-install", run: async (runtime: ActivationRuntime) => runtime.collector.activate(runtime.context, runtime.event) }] },
  { role: "doctor", stages: [{ id: "load-and-install", run: async (runtime: ActivationRuntime) => runtime.doctor.activate() }] },
  { role: "merger", stages: [{ id: "prepare-git-and-install", run: async (runtime: ActivationRuntime) => runtime.merger() }] },
] as const satisfies readonly { role: string; stages: readonly ActivationStageDeclaration[] }[];

for (const entry of ROLE_REGISTRY) {
  const seen = new Set<string>();
  for (const stage of entry.stages) {
    if (!/^[a-z][a-z0-9-]*$/.test(stage.id) || seen.has(stage.id)) throw new Error(`Invalid activation stage id for ${entry.role}: ${stage.id}`);
    seen.add(stage.id);
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

export async function executeActivationStages(
  role: string,
  stages: readonly ActivationStage[],
  infrastructure: { clock(): string; writeTrace(record: ActivationTraceRecord): void | Promise<void> },
): Promise<void> {
  for (const stage of stages) {
    await emitActivationTrace(infrastructure.writeTrace, { role, stageId: stage.id, status: "started", timestamp: infrastructure.clock() });
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
    await emitActivationTrace(infrastructure.writeTrace, { role, stageId: stage.id, status: "completed", timestamp: infrastructure.clock() });
  }
}

const TRACE_WRITE_RETRY_LIMIT = 100;

export function writeActivationTraceRecord(
  record: ActivationTraceRecord,
  write: typeof writeSync = writeSync,
): void {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  let offset = 0;
  let retries = 0;
  while (offset < bytes.length) {
    try {
      const written = write(2, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Activation trace write made no progress");
      offset += written;
      retries = 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EAGAIN" || code === "EINTR") && retries++ < TRACE_WRITE_RETRY_LIMIT) continue;
      throw error;
    }
  }
}

export class ActivationBarrierError extends Error {
  readonly code = "AK_ACTIVATION_NOT_ADMITTED";
  constructor(role: unknown) {
    super(`Workflow role ${String(role)} activation did not complete`);
    this.name = "ActivationBarrierError";
  }
}

export const WORKFLOW_ROLES = ROLE_REGISTRY.map(({ role }) => role) as Array<(typeof ROLE_REGISTRY)[number]["role"]>;
export const ROLE_FLAG = {
  name: "ak-role",
  definition: {
    description: `Activate a packaged workflow role: ${WORKFLOW_ROLES.slice(0, -1).join(", ")}, or ${WORKFLOW_ROLES.at(-1)}`,
    type: "string" as const,
  },
} as const;

export type RoleRuntimeDependencies = {
  loadJudgeSoul(): Promise<string>;
  loadFixerSoul?(): Promise<string>;
  loadFixPacket?(path: string): Promise<string>;
  loadCoderSoul?(): Promise<string>;
  loadCoderTask?(path: string): Promise<string>;
  loadReviewerSoul?(): Promise<string>;
  loadReviewerTask?(path: string): Promise<Uint8Array>;
  loadReviewerCapabilities?(path: string): Promise<Uint8Array>;
  createReviewerPinnedGitReader?(): Promise<ReviewerPinnedGitReader>;
  reviewerHostTools?: readonly string[];
  loadCollectorSoul?(): Promise<string>;
  createCollectorTransport?(): CollectorGitHubTransport;
  loadDoctorSoul?(): Promise<string>;
  loadDoctorCase?(path: string): Promise<import("./doctor-contracts.ts").DoctorCase>;
  loadMergerSoul?(): Promise<string>;
  loadMergerInput?(path: string): Promise<unknown>;
  mergerGitState?: MergerRoleDependencies["gitState"];
  createMergerGitState?(repositoryRoot: string): MergerRoleDependencies["gitState"];
  auditDoctorCompliance?(input: DoctorAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision>;
  createCollectorClock?(): CollectorClock;
  collectorPackageExtensionPath?: string;
  createNavigatorAttendance?(options: { context: ExtensionContext; role: string; phase: NavigatorPhase; subjectKey: string; subject: string; authority: string; contextError?: unknown; sessionDirectory?: (subjectKey: string) => string; onEvent: (event: import("./navigator-attendance.ts").NavigatorEvent, report: import("./navigator-attendance.ts").NavigatorReport) => void | Promise<void> }): NavigatorAttendance | Promise<NavigatorAttendance>;
  loadNavigatorWorkContext?(options: { context: ExtensionContext; role: string; phase: NavigatorPhase }): Promise<{ subjectKey: string; subject: string; authority: string }>;
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
    input: SoulAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<SoulAuditResult>;
  auditFixerCompliance?(
    input: import("./worker-role.ts").FixerAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<ComplianceDecision>;
  auditReviewerCompliance?(
    input: ReviewerAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<ComplianceDecision>;
  activationClock?(): string;
  activationTraceWriter?: (record: ActivationTraceRecord) => void | Promise<void>;
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

function navigatorPhase(pi: ExtensionAPI, role: string): NavigatorPhase {
  if (role === "coder") return pi.getFlag("ak-coder-phase") as NavigatorPhase;
  if (role === "fixer") return pi.getFlag(FIXER_FLAG_DEFINITIONS.phase.name) as NavigatorPhase;
  return null;
}

function navigatorOutputTool(role: string): string | undefined {
  return ({
    judge: JUDGE_OUTPUT_TOOL_NAME,
    fixer: FIXER_OUTPUT_TOOL_NAME,
    coder: CODER_OUTPUT_TOOL_NAME,
    reviewer: REVIEWER_OUTPUT_TOOL_NAME,
    collector: COLLECTOR_OUTPUT_TOOL,
    doctor: DOCTOR_OUTPUT_TOOL_NAME,
    merger: MERGER_OUTPUT_TOOL_NAME,
  } as Record<string, string>)[role];
}

export function publicNavigatorSettlement(role: string, phase: NavigatorPhase, event: { toolName: string; isError: boolean; details: unknown }): NavigatorSettlement | undefined {
  if (event.toolName !== navigatorOutputTool(role)) return undefined;
  if (event.isError) {
    const details = typeof event.details === "object" && event.details !== null && !Array.isArray(event.details)
      ? event.details as Record<string, unknown>
      : {};
    return details.terminal === "infrastructure_failure"
      ? { kind: "role_infrastructure_failure", role, phase }
      : undefined;
  }
  const details = typeof event.details === "object" && event.details !== null && !Array.isArray(event.details)
    ? event.details as Record<string, unknown>
    : {};
  const status = typeof details.status === "string"
    ? details.status
    : typeof details.judgeStatus === "string" ? details.judgeStatus : undefined;
  if ((role === "judge" && status === "escalate") || (role === "merger" && status === "escalate")) {
    return { kind: "human_decision", role, phase, status };
  }
  return { kind: "accepted", role, phase, ...(status === undefined ? {} : { status }) };
}

export function createRoleRuntimeExtension(
  dependencies: RoleRuntimeDependencies,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerFlag(ROLE_FLAG.name, ROLE_FLAG.definition);

    let admitted = false;
    let selectedRole: string | undefined;
    let navigatorAttendance: NavigatorAttendance | undefined;
    let pendingNavigatorPresentation: { event: import("./navigator-attendance.ts").NavigatorEvent; report: import("./navigator-attendance.ts").NavigatorReport } | undefined;
    let navigatorPresentationMode: ExtensionContext["mode"] = "tui";
    let navigatorWorkContext: { subjectKey: string; subject: string; authority: string; contextError?: unknown } | undefined;
    let navigatorSubjectBase: string | undefined;
    let lastUserInput: string | undefined;
    pi.on("input", (event) => {
      const role = pi.getFlag(ROLE_FLAG.name);
      if (role !== undefined) lastUserInput = event.text;
      if (role !== undefined && !admitted) return { action: "handled" as const };
      return { action: "continue" as const };
    });
    pi.on("before_agent_start", (_event, ctx) => {
      const role = pi.getFlag(ROLE_FLAG.name);
      if (role === undefined) return;
      if (!admitted || selectedRole !== role) {
        failInfrastructure(new ActivationBarrierError(role), ctx);
      }
      if (navigatorAttendance !== undefined && navigatorWorkContext !== undefined && navigatorSubjectBase !== undefined && lastUserInput !== undefined) {
        navigatorWorkContext = { ...navigatorWorkContext, subjectKey: `${navigatorSubjectBase}#${lastUserInput}`, subject: lastUserInput };
        navigatorAttendance.setWorkContext(navigatorWorkContext);
      }
      navigatorAttendance?.prepare();
    });
    pi.on("tool_result", async (event) => {
      const role = selectedRole;
      if (role === undefined || navigatorAttendance === undefined) return;
      const settlement = publicNavigatorSettlement(role, navigatorPhase(pi, role), event);
      if (settlement !== undefined) await navigatorAttendance.settle(settlement);
    });
    pi.on("agent_settled", async () => {
      const presentation = pendingNavigatorPresentation;
      pendingNavigatorPresentation = undefined;
      if (presentation === undefined) return;
      const content = navigatorPresentationMode === "json" ? "" : formatNavigatorReport(presentation.report);
      pi.sendMessage({
        customType: "ak-navigator-attendance",
        content,
        display: true,
        details: presentation.event,
      }, { triggerTurn: false });
    });
    pi.on("session_shutdown", () => {
      navigatorAttendance?.dispose();
      navigatorAttendance = undefined;
      pendingNavigatorPresentation = undefined;
    });

    const hostActions = { failInfrastructure };
    const judge = createJudgeRoleRuntime(
      pi,
      {
        loadSoul: dependencies.loadJudgeSoul,
        transcriptFromContext: dependencies.transcriptFromContext,
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
        transcriptFromContext: dependencies.transcriptFromContext,
        async auditCompliance(input, options) {
          if (dependencies.auditFixerCompliance === undefined) throw new Error("Fixer compliance auditor is not configured");
          return dependencies.auditFixerCompliance(input, options);
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
        async loadTask(path) {
          if (dependencies.loadReviewerTask === undefined) throw new Error("Reviewer runtime dependencies are not configured");
          return dependencies.loadReviewerTask(path);
        },
        async loadCapabilities(path) {
          if (dependencies.loadReviewerCapabilities === undefined) throw new Error("Reviewer runtime dependencies are not configured");
          return dependencies.loadReviewerCapabilities(path);
        },
        async createPinnedGitReader() {
          if (dependencies.createReviewerPinnedGitReader === undefined) throw new Error("Reviewer runtime dependencies are not configured");
          return dependencies.createReviewerPinnedGitReader();
        },
        hostTools() { return dependencies.reviewerHostTools ?? ["read", "grep", "find", "ls", "bash", "write", "edit"]; },
        async loadCanonicalSkillBinding(name) {
          if (dependencies.loadCanonicalSkillBinding === undefined) {
            throw new Error("Reviewer runtime dependencies are not configured");
          }
          return dependencies.loadCanonicalSkillBinding(name);
        },
        async runDispatch(dispatch, options) {
          if (dependencies.runReviewerDispatch === undefined) throw new Error("Reviewer runtime dependencies are not configured");
          return dependencies.runReviewerDispatch(dispatch, options);
        },
        ...(dependencies.shutdownReviewerAgent === undefined
          ? {}
          : { shutdownAgent: dependencies.shutdownReviewerAgent }),
        async auditCompliance(input, options) {
          if (dependencies.auditReviewerCompliance === undefined) {
            throw new Error("Reviewer runtime dependencies are not configured");
          }
          return dependencies.auditReviewerCompliance(input, options);
        },
      },
      hostActions,
    );
    const doctor = createDoctorRoleRuntime(pi, {
      async loadSoul() { if (!dependencies.loadDoctorSoul) throw new Error("Doctor runtime dependencies are not configured"); return dependencies.loadDoctorSoul(); },
      async loadCase(path) { if (!dependencies.loadDoctorCase) throw new Error("Doctor runtime dependencies are not configured"); return dependencies.loadDoctorCase(path); },
      async auditCompliance(input, options) { if (!dependencies.auditDoctorCompliance) throw new Error("Doctor runtime dependencies are not configured"); return dependencies.auditDoctorCompliance(input, options); },
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

    pi.on("session_start", async (event, ctx) => {
      admitted = false;
      selectedRole = undefined;
      pendingNavigatorPresentation = undefined;
      navigatorWorkContext = undefined;
      navigatorSubjectBase = undefined;
      lastUserInput = undefined;
      const rawRole = pi.getFlag(ROLE_FLAG.name);
      if (rawRole === undefined) return;
      const entry = ROLE_REGISTRY.find(({ role }) => role === rawRole);
      if (entry === undefined) {
        failInfrastructure(new Error(`Unsupported workflow role: ${String(rawRole)}`), ctx);
      }
      selectedRole = entry.role;
      navigatorPresentationMode = ctx.mode;
      navigatorAttendance?.dispose();
      navigatorAttendance = undefined;
      if (dependencies.createNavigatorAttendance !== undefined) {
        let work: { subjectKey: string; subject: string; authority: string };
        let contextError: unknown;
        if (dependencies.loadNavigatorWorkContext === undefined) {
          const fallbackSubjectKey = ctx.sessionManager.getSessionDir() || "workspace";
          work = { subjectKey: fallbackSubjectKey, subject: `workspace subject: ${fallbackSubjectKey}`, authority: "controlling authority supplied by caller" };
        } else {
          try {
            work = await dependencies.loadNavigatorWorkContext({ context: ctx, role: entry.role, phase: navigatorPhase(pi, entry.role) });
          } catch (error) {
            contextError = error;
            const fallbackSubjectKey = ctx.sessionManager.getSessionDir() || "workspace";
            work = { subjectKey: fallbackSubjectKey, subject: `work subject unavailable for ${entry.role}`, authority: "controlling authority unavailable" };
          }
        }
        navigatorWorkContext = { ...work, ...(contextError === undefined ? {} : { contextError }) };
        navigatorSubjectBase = work.subject.startsWith("work subject:") ? work.subjectKey : undefined;
        navigatorAttendance = await dependencies.createNavigatorAttendance({
          context: ctx,
          role: entry.role,
          phase: navigatorPhase(pi, entry.role),
          subjectKey: work.subjectKey,
          subject: work.subject,
          authority: work.authority,
          ...(contextError === undefined ? {} : { contextError }),
          onEvent: async (navigatorEvent, report) => {
            pendingNavigatorPresentation = { event: navigatorEvent, report };
          },
        });
      }
      const runtime: ActivationRuntime = {
        event,
        context: ctx,
        judge,
        fixer,
        coder,
        reviewer,
        collector,
        doctor,
        merger: async () => {
          if (dependencies.mergerGitState === undefined) {
            sessionMergerGitState = dependencies.createMergerGitState?.(ctx.cwd);
          }
          if (sessionMergerGitState === undefined) throw new Error("Merger runtime dependencies are not configured");
          await merger.activate();
        },
      };
      try {
        await executeActivationStages(
          entry.role,
          entry.stages.map((stage) => ({ id: stage.id, run: () => stage.run(runtime) })),
          { clock, writeTrace },
        );
        admitted = true;
      } catch (error) {
        failInfrastructure(error, ctx);
      }
    });
  };
}
