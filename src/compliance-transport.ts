import type { Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import type { DossierObservation } from "./dossier-resolution.ts";
import type { HostContext } from "./host-contracts.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";

export type ComplianceArgumentRootType = "null" | "array" | "undefined" | "string" | "number" | "boolean" | "bigint" | "symbol" | "function";
export type ComplianceAuditObservation =
  | { kind: "non-object-arguments"; type: ComplianceArgumentRootType }
  | { kind: "object-status-unreadable"; status: "missing" | "unknown" }
  | DossierObservation;
export type ComplianceNoReceipt = NoReceiptLifecycleFacts & { status: "no-receipt"; usage?: Usage };
export type ComplianceDecision = { status: "pass"; usage?: Usage } | { status: "revise"; violations: readonly unknown[]; usage?: Usage } | { status: "escalate"; conflicts?: unknown; decisionGate?: unknown; usage?: Usage } | ComplianceNoReceipt;

/** Unreadable compliance candidate — infrastructure failure, not a judgment status (#475). */
export class ComplianceCandidateUnreadableError extends Error {
  readonly observation: ComplianceAuditObservation;
  readonly candidate: unknown;
  readonly usage?: Usage;
  constructor(observation: ComplianceAuditObservation, candidate: unknown, usage?: Usage) {
    const detail =
      observation.kind === "non-object-arguments"
        ? `${observation.kind}:${observation.type}`
        : observation.kind === "object-status-unreadable"
          ? `${observation.kind}:${observation.status}`
          : observation.kind === "missing-subject"
            ? `${observation.kind}:${observation.subject}`
            : observation.kind;
    super(`Compliance candidate unreadable: ${detail}`);
    this.name = "ComplianceCandidateUnreadableError";
    this.observation = observation;
    this.candidate = candidate;
    if (usage !== undefined) this.usage = usage;
  }
}
/** Zero-projection kickoff — soul already carries dossier-fetch duty; no hand-delivered materials. */
export const AUDITOR_DOSSIER_PROMPT = "本 run 卷宗已就绪。" as const;

const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
// Transport retains malformed candidates on ComplianceCandidateUnreadableError so
// the existing failure channel can publish observation + candidate (#475).
// Status values are guidance, not a schema gate.
export const complianceDecisionSchema = Type.Object({ status: Type.Unknown({ description: "pass | revise | escalate — 形状指引，非 schema 闸" }), violations: Type.Array(nonblank, { description: "观察到的合规违规" }), conflicts: Type.Array(nonblank, { description: "未决权威或执行冲突" }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "升级问题与可选选项" }) }, { additionalProperties: true, required: [] });

export function createComplianceDecisionTool(name: string, description: string) {
  return { name, description, parameters: complianceDecisionSchema, async execute(_id: string, params: unknown): Promise<AgentToolResult<unknown>> { return { content: [{ type: "text", text: "审计决议已收" }], details: params, terminate: true }; } };
}

export const COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response" as const;
export const AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE = "ak_auditor_parent_attempt_binding" as const;
export const AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE = "ak_auditor_compliance_failure" as const;

/** Retention failure on the parent books — infrastructure, not a judgment status. */
export class ComplianceResponseRetentionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComplianceResponseRetentionError";
  }
}

export type AuditorParentAttemptBinding = {
  readonly version: 1;
  readonly parent: {
    readonly sessionId?: string;
    readonly sessionFile?: string;
    readonly attemptEntryId?: string;
  };
};

function readListField(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
export function readComplianceCandidate(arguments_: unknown, usage?: Usage): ComplianceDecision {
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
    throw new ComplianceCandidateUnreadableError(
      { kind: "non-object-arguments", type: arguments_ === null ? "null" : Array.isArray(arguments_) ? "array" : typeof arguments_ as ComplianceArgumentRootType },
      arguments_,
      usage,
    );
  }
  const args = arguments_ as Record<string, unknown>; const status = args.status;
  if (status === "pass") return { status, ...(usage === undefined ? {} : { usage }) };
  if (status === "revise") return { status, violations: readListField(args.violations), ...(usage === undefined ? {} : { usage }) };
  if (status === "escalate") return { status, ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}), ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}), ...(usage === undefined ? {} : { usage }) };
  throw new ComplianceCandidateUnreadableError(
    { kind: "object-status-unreadable", status: status === undefined ? "missing" : "unknown" },
    arguments_,
    usage,
  );
}

export type AuditorSummon = (sourceRunDirectory: string) => Promise<PublicSummonResult>;

/** Offline-test hook for public auditor summons; production leaves this undefined. */
let testAuditorSummon: AuditorSummon | undefined;

/** Install or clear the offline auditor summon hook (tests only). */
export function setTestAuditorSummon(summon: AuditorSummon | undefined): void {
  testAuditorSummon = summon;
}

export type RunComplianceAuditOptions = {
  /** @deprecated retained for call-site compatibility; public auditor owns its tool. */
  tool?: ReturnType<typeof createComplianceDecisionTool>;
  /** @deprecated retained for call-site compatibility; public auditor owns its soul. */
  systemPrompt?: string;
  /** @deprecated Fixer-lane hand-delivery only (#242 retires). Prefer omitting for zero-projection auditors. */
  serializedInput?: string;
  roleLabel?: string;
  invalidDecisionLabel?: string;
  context: HostContext;
  /** Exact machine-owned run binding; never sourced from AK_ROLE_RUN_DIR. */
  runDirectory?: string | undefined;
  signal?: AbortSignal;
  /**
   * Test seam for public-role summons. Production calls the shared public
   * activation path (#675).
   */
  summonAuditor?: AuditorSummon;
};

function projectAuditorTerminal(summoned: PublicSummonResult): ComplianceDecision {
  const outcome = summoned.terminal?.roleOutcome;
  if (outcome === undefined) {
    throw new Error(`Auditor public summon produced no terminal (exit ${summoned.exitCode})`);
  }
  if (outcome.kind === "no_receipt") {
    const { status: _ignored, kind: _kind, role: _role, decisiveFacts: _facts, ...facts } = outcome;
    return {
      status: "no-receipt",
      ...facts,
    };
  }
  if (outcome.kind === "failure") {
    throw new Error(outcome.diagnostic);
  }
  if (outcome.kind === "accepted") {
    return readComplianceCandidate({
      status: outcome.status,
      ...outcome.decisiveFacts,
    });
  }
  throw new Error("Auditor public summon returned unusable terminal kind");
}

export async function runComplianceAudit(options: RunComplianceAuditOptions): Promise<ComplianceDecision> {
  const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
  if (runDirectory === undefined) {
    throw new Error("Compliance audit requires a parent run directory pointer");
  }
  // Offline tracers may force a typed audit decision without nested public spawn.
  if (options.summonAuditor === undefined && testAuditorSummon === undefined) {
    if (process.env.AK_ROLE_TEST_AUDIT_ESCALATE === "1") {
      return {
        status: "escalate",
        conflicts: ["Soul authority conflicts with controlling authority"],
        decisionGate: {
          question: "Which authority governs this verdict?",
          options: ["Soul", "Controlling authority"],
        },
      };
    }
    if (process.env.AK_ROLE_TEST_AUDIT_PASS === "1") {
      return { status: "pass" };
    }
  }
  const prompt = options.serializedInput ?? AUDITOR_DOSSIER_PROMPT;
  const summon =
    options.summonAuditor
    ?? testAuditorSummon
    ?? (async (sourceRunDirectory: string) => {
      // Dynamic import avoids compliance ↔ public-cli circular init (TDZ).
      const { summonPublicRole } = await import("./public-role-summons.ts");
      return summonPublicRole({
        role: "auditor",
        argv: [`卷宗指针：${sourceRunDirectory}\n${prompt}`],
        cwd: options.context.cwd ?? process.cwd(),
      });
    });
  const summoned = await summon(runDirectory);
  return projectAuditorTerminal(summoned);
}
