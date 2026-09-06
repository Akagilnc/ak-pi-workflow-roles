import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AuditorSoulRole } from "./auditor-soul.ts";
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
/** Shape-unreadable audit leg — parent work stands with typed fact, never forged pass (ADR 0055). */
export type ComplianceUnreadable = {
  readonly status: "unreadable";
  readonly observation: ComplianceAuditObservation;
  readonly candidate: unknown;
  readonly usage?: Usage;
};
export type ComplianceDecision =
  | { status: "pass"; usage?: Usage }
  | { status: "revise"; violations: readonly unknown[]; usage?: Usage }
  | { status: "escalate"; conflicts?: unknown; decisionGate?: unknown; usage?: Usage }
  | ComplianceNoReceipt
  | ComplianceUnreadable;

/**
 * Unreadable compliance candidate observation carrier.
 * Shape-unreadable must not abort the parent run (CLAUDE.md §0 / ADR 0055).
 * Callers read observation+candidate; projection keeps typed unreadable — never forged pass.
 */
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
export const complianceDecisionSchema = Type.Object({ status: Type.Unknown({ description: "pass | revise | escalate — 形状指引，非 schema 闸" }), violations: Type.Array(nonblank, { description: "观察到的合规违规" }), conflicts: Type.Array(nonblank, { description: "未决权威或执行冲突" }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "升级问题与可选选项" }) }, { additionalProperties: true, required: [] });

export const COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response" as const;
export const AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE = "ak_auditor_parent_attempt_binding" as const;
export const AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE = "ak_auditor_compliance_failure" as const;

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

/** Try to project a lawful compliance decision; undefined when shape is not a known release. */
export function tryReadComplianceCandidate(arguments_: unknown, usage?: Usage): ComplianceDecision | undefined {
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
    return undefined;
  }
  const args = arguments_ as Record<string, unknown>;
  const status = args.status;
  if (status === "pass") return { status, ...(usage === undefined ? {} : { usage }) };
  if (status === "revise") return { status, violations: readListField(args.violations), ...(usage === undefined ? {} : { usage }) };
  if (status === "escalate") {
    return {
      status,
      ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}),
      ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  return undefined;
}

/**
 * Read a compliance candidate. Unreadable shape throws ComplianceCandidateUnreadableError
 * with observation+candidate retained — callers must not map that throw onto parent abort
 * (CLAUDE.md §0 / ADR 0055). Prefer tryReadComplianceCandidate at parent projection seams.
 */
export function readComplianceCandidate(arguments_: unknown, usage?: Usage): ComplianceDecision {
  const projected = tryReadComplianceCandidate(arguments_, usage);
  if (projected !== undefined) return projected;
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
    throw new ComplianceCandidateUnreadableError(
      { kind: "non-object-arguments", type: arguments_ === null ? "null" : Array.isArray(arguments_) ? "array" : typeof arguments_ as ComplianceArgumentRootType },
      arguments_,
      usage,
    );
  }
  const status = (arguments_ as Record<string, unknown>).status;
  throw new ComplianceCandidateUnreadableError(
    { kind: "object-status-unreadable", status: status === undefined ? "missing" : "unknown" },
    arguments_,
    usage,
  );
}

/**
 * Public auditor summon for compliance (#675 / ADR 0062 / owner r11).
 * 审刑院 is the independent audit role; subject (who is audited) selects soul files.
 * Same public path whether nested or direct `ak-role auditor --subject … --source-run …`.
 */
export type AuditorSummon = (
  subject: AuditorSoulRole,
  sourceRunDirectory: string,
) => Promise<PublicSummonResult>;

export type RunComplianceAuditOptions = {
  /** Who is being audited — selects judge-auditor.md / doctor-auditor.md. */
  readonly subject: AuditorSoulRole;
  context: HostContext;
  runDirectory?: string | undefined;
  signal?: AbortSignal;
  /** Test seam — production uses summonPublicRole({ role: "auditor", argv: ["--subject", subject, "--source-run", …] }). */
  summonAuditor?: AuditorSummon;
};

async function usageFromSummonedSession(summoned: PublicSummonResult): Promise<Usage | undefined> {
  const { usageFromPublicSummon } = await import("./session-assistant-usage.ts");
  return usageFromPublicSummon(summoned);
}

function extractFailureCandidate(outcome: {
  readonly decisiveFacts?: unknown;
}): unknown | undefined {
  const facts = outcome.decisiveFacts as Record<string, unknown> | undefined;
  const secondary =
    facts !== undefined
    && typeof facts.secondaryEvidence === "object"
    && facts.secondaryEvidence !== null
      ? (facts.secondaryEvidence as Record<string, unknown>)
      : undefined;
  if (facts !== undefined && Object.hasOwn(facts, "candidate")) return facts.candidate;
  if (secondary !== undefined && Object.hasOwn(secondary, "candidate")) return secondary.candidate;
  return undefined;
}

function observationFromUnreadableCandidate(candidate: unknown): ComplianceAuditObservation {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return {
      kind: "non-object-arguments",
      type: candidate === null ? "null" : Array.isArray(candidate) ? "array" : typeof candidate as ComplianceArgumentRootType,
    };
  }
  const status = (candidate as Record<string, unknown>).status;
  return {
    kind: "object-status-unreadable",
    status: status === undefined ? "missing" : "unknown",
  };
}

function unreadableDecision(
  candidate: unknown,
  usage: Usage | undefined,
): ComplianceUnreadable {
  return {
    status: "unreadable",
    observation: observationFromUnreadableCandidate(candidate),
    candidate,
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Project a public auditor terminal onto the parent compliance decision.
 * Lawful pass/revise/escalate/no-receipt flow through.
 * Shape-unreadable keeps original candidate + typed observation (ADR 0055 / §0) —
 * never forged pass, never parent abort. Real provider/engine/disk failures stay loud.
 * Accepted audits always carry real session usage when present (#675 metering).
 */
async function projectAuditorTerminal(summoned: PublicSummonResult): Promise<ComplianceDecision> {
  const outcome = summoned.terminal?.roleOutcome;
  if (outcome === undefined) {
    throw new Error(`Auditor public summon produced no terminal (exit ${summoned.exitCode})`);
  }
  const usage = await usageFromSummonedSession(summoned);
  if (outcome.kind === "no_receipt") {
    const { status: _ignored, kind: _kind, role: _role, decisiveFacts: _facts, ...facts } = outcome;
    return {
      status: "no-receipt",
      ...facts,
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (outcome.kind === "failure") {
    // Settlement marks shape-unreadable with cause=output + retained candidate.
    // Other causes (provider/engine/session/…) stay loud infrastructure failures.
    if (outcome.cause === "output") {
      const candidate = extractFailureCandidate(outcome) ?? outcome.decisiveFacts;
      return unreadableDecision(candidate, usage);
    }
    throw new Error(outcome.diagnostic);
  }
  if (outcome.kind === "accepted") {
    const candidate = {
      status: outcome.status,
      ...outcome.decisiveFacts,
    };
    const projected = tryReadComplianceCandidate(candidate, usage);
    if (projected !== undefined) return projected;
    // Accepted-once but not a lawful release: retain candidate as typed unreadable.
    return unreadableDecision(candidate, usage);
  }
  throw new Error("Auditor public summon returned unusable terminal kind");
}

export async function runComplianceAudit(options: RunComplianceAuditOptions): Promise<ComplianceDecision> {
  const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
  if (runDirectory === undefined) {
    throw new Error("Compliance audit requires a parent run directory pointer");
  }
  const subject = options.subject;
  const summon =
    options.summonAuditor
    ?? (async (auditSubject: AuditorSoulRole, sourceRunDirectory: string) => {
      // Dynamic import avoids compliance ↔ public-cli circular init (TDZ).
      const { summonPublicRole } = await import("./public-role-summons.ts");
      const { homeFromRunDirectory } = await import("./activation-ledger-topology.ts");
      const home = homeFromRunDirectory(sourceRunDirectory);
      // Same input surface as direct `ak-role auditor --subject … --source-run …`
      // (no ambient env binding for nested-only source).
      return await summonPublicRole({
        role: "auditor",
        argv: [
          "--subject",
          auditSubject,
          "--source-run",
          sourceRunDirectory,
          AUDITOR_DOSSIER_PROMPT,
        ],
        cwd: options.context.cwd ?? process.cwd(),
        home,
      });
    });
  const summoned = await summon(subject, runDirectory);
  return await projectAuditorTerminal(summoned);
}
