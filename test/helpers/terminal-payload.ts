import { lastRolePayloadRecord, type TerminalRoleOutcome } from "../../src/public-cli/terminal.ts";

/** Original last payload record; fixture-only decisiveFacts is fallback. */
export function payloadFacts(outcome: TerminalRoleOutcome): Record<string, unknown> {
  if (outcome.kind === "failure" || outcome.kind === "no_receipt") {
    return { ...outcome.decisiveFacts };
  }
  return lastRolePayloadRecord(outcome.payloads ?? [])
    ?? (outcome.decisiveFacts !== undefined ? { ...outcome.decisiveFacts } : {});
}

/** Status leaf the role wrote (status / judgeStatus / countersignStatus). */
export function payloadStatus(outcome: TerminalRoleOutcome): string | undefined {
  if (outcome.kind === "no_receipt") return outcome.status;
  if (outcome.kind === "audit_escalation") return outcome.status;
  const facts = payloadFacts(outcome);
  if (typeof facts.status === "string") return facts.status;
  if (typeof facts.judgeStatus === "string") return facts.judgeStatus;
  if (typeof facts.countersignStatus === "string") return facts.countersignStatus;
  return outcome.kind === "accepted" ? outcome.status : undefined;
}
