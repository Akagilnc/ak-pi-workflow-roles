import type { Usage } from "@earendil-works/pi-ai";

import type {
  ComplianceDecision,
} from "./compliance-transport.ts";

export const AUDIT_ESCALATION_KIND = "audit_escalation" as const;

// Live Navigator settlement may consume only the projection produced by this
// owner. Its private WeakSet cannot be authored by role output; persisted/
// replayed records are re-authenticated by the retained audit evidence binder.
const AUDIT_ESCALATION_LIVE_REGISTRY = new WeakSet<object>();

/**
 * Escalation delivery face.
 * `kind` / `conflicts` / `auditDecisionGate` are audit-owned fields.
 * Role-delivered fields ride beside them as open content (ADR 0055) — including
 * a role `decisionGate` when present. The index signature tells that truth so
 * callers never need a cast to retain role output.
 */
export type AuditEscalationResult = {
  readonly kind: typeof AUDIT_ESCALATION_KIND;
  /** Raw audit-owned conflicts field, when the auditor supplied one. */
  readonly conflicts?: unknown;
  /** Raw audit-owned gate field, when the auditor supplied one. */
  readonly auditDecisionGate?: unknown;
  readonly [key: string]: unknown;
};

export type AuditEscalationToolResult = {
  content: [{ type: "text"; text: string }];
  details: AuditEscalationResult;
  terminate: true;
  usage?: Usage;
};

export type OfficerAuditEscalationDecision = {
  readonly status: "escalate";
  readonly officer?: "inspector" | "notary";
  readonly reason?: string;
  readonly findings?: readonly string[];
  readonly conflicts?: unknown;
  readonly decisionGate?: unknown;
  readonly usage?: Usage;
};

export type AuditEscalationDecision =
  | Extract<ComplianceDecision, { status: "escalate" }>
  | OfficerAuditEscalationDecision;

/**
 * Build the escalation delivery face.
 * Role-delivered fields ride under the escalation discriminator (ADR 0055).
 * `kind` always wins so the discriminator cannot be laundered.
 * `conflicts` and `auditDecisionGate`, when present, always come from the
 * audit (why we escalated and its gate). Raw ancillary values are not repaired.
 * A role `decisionGate`, when present, stays at its own key via spread and is
 * never overwritten (not folded, not dropped, not swapped into the audit home).
 */
export function buildAuditEscalationResult(
  decision: AuditEscalationDecision,
  deliveredOutput?: unknown,
): AuditEscalationResult {
  const auditOwned: Record<string, unknown> = {
    kind: AUDIT_ESCALATION_KIND,
  };
  if (Object.hasOwn(decision, "conflicts")) {
    auditOwned.conflicts = (decision as { conflicts?: unknown }).conflicts;
  }
  if (Object.hasOwn(decision, "decisionGate")) {
    auditOwned.auditDecisionGate = (decision as { decisionGate?: unknown }).decisionGate;
  }
  if (Object.hasOwn(decision, "reason") && (decision as { reason?: unknown }).reason !== undefined) {
    auditOwned.reason = (decision as { reason?: unknown }).reason;
  }
  if (Object.hasOwn(decision, "officer") && (decision as { officer?: unknown }).officer !== undefined) {
    auditOwned.officer = (decision as { officer?: unknown }).officer;
  }
  if (Object.hasOwn(decision, "findings") && (decision as { findings?: unknown }).findings !== undefined) {
    auditOwned.findings = (decision as { findings?: unknown }).findings;
  }
  const deliveredFields =
    deliveredOutput !== undefined &&
    deliveredOutput !== null &&
    typeof deliveredOutput === "object" &&
    !Array.isArray(deliveredOutput)
      ? { ...(deliveredOutput as Record<string, unknown>) }
      : {};
  // Role output cannot fill an absent audit-owned field.
  delete deliveredFields.conflicts;
  delete deliveredFields.auditDecisionGate;
  const result = {
    ...deliveredFields,
    ...auditOwned,
  } as AuditEscalationResult;
  AUDIT_ESCALATION_LIVE_REGISTRY.add(result);
  return result;
}

/** True only for the audit-owned live projection, never for role-shaped data. */
export function isAuditEscalationProjection(
  value: unknown,
): value is AuditEscalationResult {
  if (!isAuditEscalationResult(value)) return false;
  return AUDIT_ESCALATION_LIVE_REGISTRY.has(value);
}

function humanDecisionText(result: AuditEscalationResult): string {
  const lines = [
    typeof result.officer === "string"
      ? `Human decision required: ${result.officer} escalation.`
      : "Human decision required: compliance audit escalation.",
  ];
  if (typeof result.reason === "string") {
    lines.push(`Reason: ${result.reason}`);
  }
  if (Array.isArray(result.conflicts)) {
    lines.push("Conflicts:", ...result.conflicts.map((conflict) => `- ${conflict}`));
  }
  if (Array.isArray(result.findings) && result.findings.length > 0) {
    lines.push("Findings:", ...result.findings.map((finding) => `- ${finding}`));
  }
  const gate = result.auditDecisionGate;
  if (gate !== null && typeof gate === "object" && !Array.isArray(gate)) {
    const record = gate as Record<string, unknown>;
    if (typeof record.question === "string") lines.push(`Question: ${record.question}`);
    if (Array.isArray(record.options)) {
      lines.push("Options:", ...record.options.map((option) => `- ${option}`));
    }
  }
  return lines.join("\n");
}

export function projectAuditEscalation(
  decision: AuditEscalationDecision,
  deliveredOutput?: unknown,
): AuditEscalationToolResult {
  const details = buildAuditEscalationResult(decision, deliveredOutput);
  return {
    content: [{ type: "text", text: humanDecisionText(details) }],
    details,
    terminate: true,
    ...(decision.usage === undefined ? {} : { usage: decision.usage }),
  };
}

/**
 * Discriminator-only recognition (ADR 0040). Shape of conflicts/options/gate
 * is not a reject gate — element types and cardinality are delivery content.
 */
export function isAuditEscalationResult(
  value: unknown,
): value is AuditEscalationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (value as Record<string, unknown>).kind === AUDIT_ESCALATION_KIND;
}

export type ComplianceDecisionHandlers<T> = {
  pass: (usage: Usage | undefined) => T | PromiseLike<T>;
  /** Project the accepted parent candidate beside the typed audit-leg facts. */
  noReceipt?: (
    facts: Extract<ComplianceDecision, { status: "no-receipt" }>,
    usageProjection: { usage?: Usage },
  ) => T | PromiseLike<T>;
  revise: (violations: readonly unknown[]) => T | PromiseLike<T>;
  escalate: (result: AuditEscalationToolResult) => T | PromiseLike<T>;
};

/**
 * Dispose a parsed audit decision without repeating status handling in roles.
 * Role output already delivered is preserved on the escalate face (ADR 0055).
 */
export async function disposeComplianceDecision<T>(
  decision: ComplianceDecision,
  handlers: ComplianceDecisionHandlers<T>,
  deliveredOutput?: unknown,
): Promise<Awaited<T>> {
  switch (decision.status) {
    case "pass":
      return await handlers.pass(decision.usage);
    case "no-receipt":
      // The parent candidate remains accepted, but its parallel audit leg is a
      // public typed fact and must not be collapsed into an ordinary pass.
      if (handlers.noReceipt === undefined) {
        throw new Error("Compliance no-receipt projection handler is unavailable");
      }
      return await handlers.noReceipt(
        decision,
        decision.usage === undefined ? {} : { usage: decision.usage },
      );
    case "revise":
      return await handlers.revise(decision.violations);
    case "escalate":
      return await handlers.escalate(
        projectAuditEscalation(decision, deliveredOutput),
      );
  }
}
