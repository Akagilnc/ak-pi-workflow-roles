import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AuditorSoulRole } from "./auditor-soul.ts";
import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import type { HostContext } from "./host-contracts.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";

export type ComplianceNoReceipt = NoReceiptLifecycleFacts & { status: "no-receipt"; usage?: Usage };
/**
 * #757 / #750: no unreadable/unusable judgment on auditor replies.
 * Known three-state (pass/bounce/escalate) is read for queueing only.
 * Unknown accepted shape rides as `received` with the raw reply — parent stands,
 * no forged pass, no shape-death label. Resume-speaker for three pairs is #753/#756.
 */
export type ComplianceReceived = {
  readonly status: "received";
  readonly reply: unknown;
  readonly usage?: Usage;
};
export type ComplianceDecision =
  | { status: "pass"; receipt?: unknown; usage?: Usage }
  | { status: "bounce"; violations: readonly unknown[]; receipt?: unknown; usage?: Usage }
  | { status: "escalate"; conflicts?: unknown; decisionGate?: unknown; receipt?: unknown; usage?: Usage }
  | ComplianceNoReceipt
  | ComplianceReceived;
/** Zero-projection kickoff — soul already carries dossier-fetch duty; no hand-delivered materials. */
export const AUDITOR_DOSSIER_PROMPT = "卷宗指针：" as const;

const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
export const complianceDecisionSchema = Type.Object({ status: Type.Unknown({ description: "pass | bounce | escalate — 形状指引，非 schema 闸" }), violations: Type.Array(nonblank, { description: "观察到的合规违规" }), conflicts: Type.Array(nonblank, { description: "未决权威或执行冲突" }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "升级问题与可选选项" }) }, { additionalProperties: true, required: [] });

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

/** Try to project a known three-state compliance decision; undefined when not pass/bounce/escalate. */
export function tryReadComplianceCandidate(arguments_: unknown, usage?: Usage): ComplianceDecision | undefined {
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
    return undefined;
  }
  const args = arguments_ as Record<string, unknown>;
  const status = args.status;
  if (status === "pass") return { status, receipt: arguments_, ...(usage === undefined ? {} : { usage }) };
  if (status === "bounce") return { status, violations: readListField(args.violations), receipt: arguments_, ...(usage === undefined ? {} : { usage }) };
  if (status === "escalate") {
    return {
      status,
      receipt: arguments_,
      ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}),
      ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  return undefined;
}

/**
 * Read a compliance candidate. Known three-state projects; anything else is
 * `received` with the raw reply — no unreadable/unusable judgment (#757).
 */
export function readComplianceCandidate(arguments_: unknown, usage?: Usage): ComplianceDecision {
  const projected = tryReadComplianceCandidate(arguments_, usage);
  if (projected !== undefined) return projected;
  return {
    status: "received",
    reply: arguments_,
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Public auditor summon for compliance (#675 / ADR 0062 / owner r11).
 * 审刑院 is the independent audit role; subject (who is audited) selects soul files.
 * Same public path whether nested or direct `ak-role auditor --subject … --source-run …`.
 */
export type AuditorSummon = (
  subject: AuditorSoulRole,
  sourceRunDirectory: string,
  /** Parent cancellation forwarded to the nested activation (#675). */
  signal?: AbortSignal,
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

/**
 * Project a public auditor terminal onto the parent compliance decision.
 * Known pass/bounce/escalate/no-receipt flow through for queueing.
 * Accepted-but-not-three-state → `received` with raw reply (#757) — no unreadable label,
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
    const rows = summoned.terminal?.submissions;
    const recorded = rows !== undefined && rows.length > 0 ? rows[rows.length - 1] : undefined;
    if (recorded !== undefined) {
      return readComplianceCandidate(recorded, usage);
    }
    throw new Error(outcome.diagnostic);
  }
  if (outcome.kind === "accepted") {
    const rows = summoned.terminal?.submissions;
    const recorded = rows !== undefined && rows.length > 0 ? rows[rows.length - 1] : undefined;
    const candidate = recorded ?? {
      status: outcome.status,
      ...outcome.decisiveFacts,
    };
    return readComplianceCandidate(candidate, usage);
  }
  // Unknown terminal kind: still not a shape judgment — surface as received reply.
  return {
    status: "received",
    reply: outcome,
    ...(usage === undefined ? {} : { usage }),
  };
}

export async function runComplianceAudit(options: RunComplianceAuditOptions): Promise<ComplianceDecision> {
  const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
  if (runDirectory === undefined) {
    throw new Error("Compliance audit requires a parent run directory pointer");
  }
  const subject = options.subject;
  const summon =
    options.summonAuditor
    ?? (async (
      auditSubject: AuditorSoulRole,
      sourceRunDirectory: string,
      auditSignal?: AbortSignal,
    ) => {
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
          `${AUDITOR_DOSSIER_PROMPT}${sourceRunDirectory}`,
        ],
        cwd: options.context.cwd ?? process.cwd(),
        home,
        ...(auditSignal === undefined ? {} : { signal: auditSignal }),
      });
    });
  const summoned = await summon(subject, runDirectory, options.signal);
  return await projectAuditorTerminal(summoned);
}
