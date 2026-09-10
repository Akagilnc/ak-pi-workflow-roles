import { lastRolePayloadRecord, type TerminalRoleOutcome } from "../../src/public-cli/terminal.ts";

/** Original last payload record. Host-owned failure/no_receipt facts stay on decisiveFacts. */
export function payloadFacts(outcome: TerminalRoleOutcome): Record<string, unknown> {
  if (outcome.kind === "failure" || outcome.kind === "no_receipt") {
    return { ...outcome.decisiveFacts };
  }
  return lastRolePayloadRecord(outcome.payloads ?? []) ?? {};
}

/** Status leaf the role wrote (status / judgeStatus / countersignStatus). Never invents "". */
export function payloadStatus(outcome: TerminalRoleOutcome): string | undefined {
  if (outcome.kind === "no_receipt") return outcome.status;
  if (outcome.kind === "audit_escalation") return outcome.status;
  const facts = payloadFacts(outcome);
  if (typeof facts.status === "string") return facts.status;
  if (typeof facts.judgeStatus === "string") return facts.judgeStatus;
  if (typeof facts.countersignStatus === "string") return facts.countersignStatus;
  return undefined;
}
