import type { Usage } from "@earendil-works/pi-ai";

import type {
  ComplianceAuditIncomplete,
  ComplianceDecision,
} from "./compliance-transport.ts";

export const AUDIT_ESCALATION_KIND = "audit_escalation" as const;

/**
 * Escalation delivery face.
 * `kind` / `conflicts` / `auditDecisionGate` are audit-owned and fixed-shape.
 * Role-delivered fields ride beside them as open content (ADR 0055) — including
 * a role `decisionGate` when present. The index signature tells that truth so
 * callers never need a cast to retain role output.
 */
export type AuditEscalationResult = {
  readonly kind: typeof AUDIT_ESCALATION_KIND;
  readonly conflicts: readonly unknown[];
  /** Audit-owned gate — single fixed home, never the role's gate. */
  readonly auditDecisionGate: {
    readonly question: string;
    readonly options: readonly unknown[];
  };
  readonly [key: string]: unknown;
};

export type AuditEscalationToolResult = {
  content: [{ type: "text"; text: string }];
  details: AuditEscalationResult;
  terminate: true;
  usage?: Usage;
};

export type AuditIncompleteToolResult = {
  content: [{ type: "text"; text: string }];
  details: ComplianceAuditIncomplete;
  terminate: true;
  usage?: Usage;
};

/**
 * Build the escalation delivery face.
 * Role-delivered fields ride under the escalation discriminator (ADR 0055).
 * `kind` always wins so the discriminator cannot be laundered.
 * `conflicts` always come from the audit (why we escalated).
 * `auditDecisionGate` is always the audit's own gate — one fixed home.
 * A role `decisionGate`, when present, stays at its own key via spread and is
 * never overwritten (not folded, not dropped, not swapped into the audit home).
 */
export function buildAuditEscalationResult(
  decision: Extract<ComplianceDecision, { status: "escalate" }>,
  deliveredOutput?: unknown,
): AuditEscalationResult {
  const auditOwned = {
    kind: AUDIT_ESCALATION_KIND,
    conflicts: [...decision.conflicts],
    auditDecisionGate: {
      question: decision.decisionGate.question,
      options: [...decision.decisionGate.options],
    },
  };
  if (
    deliveredOutput !== undefined &&
    deliveredOutput !== null &&
    typeof deliveredOutput === "object" &&
    !Array.isArray(deliveredOutput)
  ) {
    return {
      ...(deliveredOutput as Record<string, unknown>),
      ...auditOwned,
    };
  }
  return auditOwned;
}

function humanDecisionText(result: AuditEscalationResult): string {
  // Read only the audit-owned, fixed-shape gate. Role payload is not assumed
  // to be a {question, options} object — that assumption is what threw.
  return [
    "Human decision required: compliance audit escalation.",
    "Conflicts:",
    ...result.conflicts.map((conflict) => `- ${conflict}`),
    `Question: ${result.auditDecisionGate.question}`,
    "Options:",
    ...result.auditDecisionGate.options.map((option) => `- ${option}`),
  ].join("\n");
}

export function projectAuditEscalation(
  decision: Extract<ComplianceDecision, { status: "escalate" }>,
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

export function projectAuditIncomplete(
  decision: ComplianceAuditIncomplete,
): AuditIncompleteToolResult {
  return {
    content: [{ type: "text", text: "Compliance audit incomplete; no role receipt was formed." }],
    details: decision,
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
  revise: (violations: readonly unknown[]) => T | PromiseLike<T>;
  escalate: (result: AuditEscalationToolResult) => T | PromiseLike<T>;
  auditIncomplete?: (result: AuditIncompleteToolResult) => T | PromiseLike<T>;
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
    case "revise":
      return await handlers.revise(decision.violations);
    case "escalate":
      return await handlers.escalate(
        projectAuditEscalation(decision, deliveredOutput),
      );
    case "audit-incomplete":
      if (handlers.auditIncomplete === undefined) {
        throw new Error("Compliance audit-incomplete handler is unavailable");
      }
      return await handlers.auditIncomplete(projectAuditIncomplete(decision));
  }
}
