import type { Usage } from "@earendil-works/pi-ai";

import type {
  ComplianceAuditIncomplete,
  ComplianceDecision,
} from "./compliance-transport.ts";

export const AUDIT_ESCALATION_KIND = "audit_escalation" as const;

export type AuditEscalationResult = {
  readonly kind: typeof AUDIT_ESCALATION_KIND;
  readonly conflicts: readonly string[];
  readonly decisionGate: {
    readonly question: string;
    readonly options: readonly string[];
  };
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

export function buildAuditEscalationResult(
  decision: Extract<ComplianceDecision, { status: "escalate" }>,
): AuditEscalationResult {
  return {
    kind: AUDIT_ESCALATION_KIND,
    conflicts: [...decision.conflicts],
    decisionGate: {
      question: decision.decisionGate.question,
      options: [...decision.decisionGate.options],
    },
  };
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
): AuditEscalationToolResult {
  const details = buildAuditEscalationResult(decision);
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

export function isAuditEscalationResult(
  value: unknown,
): value is AuditEscalationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  const gate = result.decisionGate;
  if (
    result.kind !== AUDIT_ESCALATION_KIND ||
    !Array.isArray(result.conflicts) ||
    result.conflicts.length === 0 ||
    !result.conflicts.every(
      (conflict) => typeof conflict === "string" && conflict.trim().length > 0,
    ) ||
    typeof gate !== "object" ||
    gate === null ||
    Array.isArray(gate)
  ) {
    return false;
  }
  const gateRecord = gate as Record<string, unknown>;
  return (
    typeof gateRecord.question === "string" &&
    gateRecord.question.trim().length > 0 &&
    Array.isArray(gateRecord.options) &&
    gateRecord.options.length > 0 &&
    gateRecord.options.every(
      (option: unknown) =>
        typeof option === "string" && option.trim().length > 0,
    )
  );
}

export type ComplianceDecisionHandlers<T> = {
  pass: (usage: Usage | undefined) => T | PromiseLike<T>;
  revise: (violations: readonly string[]) => T | PromiseLike<T>;
  escalate: (result: AuditEscalationToolResult) => T | PromiseLike<T>;
  auditIncomplete: (result: AuditIncompleteToolResult) => T | PromiseLike<T>;
};

/** Dispose a parsed audit decision without repeating status handling in roles. */
export async function disposeComplianceDecision<T>(
  decision: ComplianceDecision,
  handlers: ComplianceDecisionHandlers<T>,
): Promise<Awaited<T>> {
  switch (decision.status) {
    case "pass":
      return await handlers.pass(decision.usage);
    case "revise":
      return await handlers.revise(decision.violations);
    case "escalate":
      return await handlers.escalate(projectAuditEscalation(decision));
    case "audit-incomplete":
      return await handlers.auditIncomplete(projectAuditIncomplete(decision));
  }
}
