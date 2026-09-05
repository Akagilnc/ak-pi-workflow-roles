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

/** Offline options-bag mirror for deep activation paths that cannot thread summonAuditor. */
let offlineAuditorSummon: AuditorSummon | undefined;

export function setTestAuditorSummon(summon: AuditorSummon | undefined): () => void {
  const previous = offlineAuditorSummon;
  offlineAuditorSummon = summon;
  return () => {
    offlineAuditorSummon = previous;
  };
}

export type RunComplianceAuditOptions = {
  /** @deprecated Fixer-lane hand-delivery only (#242 retires). Prefer omitting for zero-projection auditors. */
  serializedInput?: string;
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

/** Sum nested public auditor session usage onto the parent no-receipt face (#675). */
async function usageFromSummonedAuditorSession(summoned: PublicSummonResult): Promise<Usage | undefined> {
  const { usageFromPublicSummon } = await import("./session-assistant-usage.ts");
  return usageFromPublicSummon(summoned);
}

async function projectAuditorTerminal(summoned: PublicSummonResult): Promise<ComplianceDecision> {
  const outcome = summoned.terminal?.roleOutcome;
  if (outcome === undefined) {
    throw new Error(`Auditor public summon produced no terminal (exit ${summoned.exitCode})`);
  }
  if (outcome.kind === "no_receipt") {
    const { status: _ignored, kind: _kind, role: _role, decisiveFacts: _facts, ...facts } = outcome;
    const usage = await usageFromSummonedAuditorSession(summoned);
    return {
      status: "no-receipt",
      ...facts,
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (outcome.kind === "failure") {
    // Preserve sealed candidate on the failure channel (#475 / #675): parent Judge
    // secondaryEvidence needs observation+candidate, not a bare diagnostic string.
    const facts = outcome.decisiveFacts as Record<string, unknown> | undefined;
    const secondary =
      facts !== undefined
      && typeof facts.secondaryEvidence === "object"
      && facts.secondaryEvidence !== null
        ? (facts.secondaryEvidence as Record<string, unknown>)
        : undefined;
    const candidate =
      facts !== undefined && Object.hasOwn(facts, "candidate")
        ? facts.candidate
        : secondary !== undefined && Object.hasOwn(secondary, "candidate")
          ? secondary.candidate
          : undefined;
    if (candidate !== undefined) {
      const status =
        typeof candidate === "object"
        && candidate !== null
        && !Array.isArray(candidate)
        && Object.hasOwn(candidate as object, "status")
          ? (candidate as { status: unknown }).status
          : undefined;
      throw new ComplianceCandidateUnreadableError(
        {
          kind: "object-status-unreadable",
          status: status === undefined ? "missing" : "unknown",
        },
        candidate,
      );
    }
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
  const prompt = options.serializedInput ?? AUDITOR_DOSSIER_PROMPT;
  const summon =
    options.summonAuditor
    ?? offlineAuditorSummon
    ?? (async (sourceRunDirectory: string) => {
      // Dynamic import avoids compliance ↔ public-cli circular init (TDZ).
      const { summonPublicRole } = await import("./public-role-summons.ts");
      const { homeFromRunDirectory } = await import("./activation-ledger-topology.ts");
      // Hard path resolve: fail loud — no packageMachineHome fallback (#604 / #675).
      const home = homeFromRunDirectory(sourceRunDirectory);
      // Publish source-run for public auditor dossier tool registration (#675).
      // Scoped to this summon only — never leave a cross-run env residue.
      const priorSource = process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
      process.env.AK_ROLE_AUDITOR_SOURCE_RUN = sourceRunDirectory;
      try {
        return await summonPublicRole({
          role: "auditor",
          argv: [`卷宗指针：${sourceRunDirectory}\n${prompt}`],
          cwd: options.context.cwd ?? process.cwd(),
          home,
        });
      } finally {
        if (priorSource === undefined) delete process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
        else process.env.AK_ROLE_AUDITOR_SOURCE_RUN = priorSource;
      }
    });
  const summoned = await summon(runDirectory);
  return await projectAuditorTerminal(summoned);
}
