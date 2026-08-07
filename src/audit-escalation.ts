import type { Usage } from "@earendil-works/pi-ai";

import type { ComplianceDecision } from "./compliance-transport.ts";

export const AUDIT_ESCALATION_KIND = "audit_escalation" as const;

export type AuditEscalationResult = {
  readonly kind: typeof AUDIT_ESCALATION_KIND;
  readonly conflicts: readonly unknown[];
  readonly decisionGate: {
    readonly question: string;
    readonly options: readonly unknown[];
  };
};

export type AuditEscalationToolResult = {
  content: [{ type: "text"; text: string }];
  details: AuditEscalationResult;
  terminate: true;
  usage?: Usage;
};

/**
 * Build the escalation delivery face.
 * When the role already delivered output, spread it under the escalation
 * discriminator so callers still receive the original fields (ADR 0055).
 * Escalation keys win on clash so kind/conflicts/decisionGate cannot be
 * laundered by role-output field names.
 */
export function buildAuditEscalationResult(
  decision: Extract<ComplianceDecision, { status: "escalate" }>,
  deliveredOutput?: unknown,
): AuditEscalationResult {
  const escalation = {
    kind: AUDIT_ESCALATION_KIND,
    conflicts: [...decision.conflicts],
    decisionGate: {
      question: decision.decisionGate.question,
      options: [...decision.decisionGate.options],
    },
  } as const;
  if (
    deliveredOutput !== undefined &&
    deliveredOutput !== null &&
    typeof deliveredOutput === "object" &&
    !Array.isArray(deliveredOutput)
  ) {
    return {
      ...(deliveredOutput as Record<string, unknown>),
      ...escalation,
    } as AuditEscalationResult;
  }
  return escalation;
}

function humanDecisionText(result: AuditEscalationResult): string {
  return [
    "Human decision required: compliance audit escalation.",
    "Conflicts:",
    ...result.conflicts.map((conflict) => `- ${conflict}`),
    `Question: ${result.decisionGate.question}`,
    "Options:",
    ...result.decisionGate.options.map((option) => `- ${option}`),
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
};

/** Dispose a parsed audit decision without repeating status handling in roles. */
export async function disposeComplianceDecision<T>(
  decision: ComplianceDecision,
  handlers: ComplianceDecisionHandlers<T>,
  /** Role output already delivered; preserved on the escalate face (ADR 0055). */
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
  }
}
