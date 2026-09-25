/** Historical audit-escalation discriminator retained for reading pre-#1057 run artifacts. */
export const AUDIT_ESCALATION_KIND = "audit_escalation" as const;

export function isAuditEscalationResult(value: unknown): value is { readonly kind: typeof AUDIT_ESCALATION_KIND } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === AUDIT_ESCALATION_KIND;
}
