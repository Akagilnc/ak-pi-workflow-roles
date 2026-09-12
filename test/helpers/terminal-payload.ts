import type { TerminalRoleOutcome } from "../../src/public-cli/terminal.ts";

/** Host-owned failure/no_receipt facts, or the sole object payload when the sequence is length 1. */
export function payloadFacts(outcome: TerminalRoleOutcome): Record<string, unknown> {
  if (outcome.kind === "failure" || outcome.kind === "no_receipt") {
    return { ...outcome.decisiveFacts };
  }
  const records: Record<string, unknown>[] = [];
  for (const payload of outcome.payloads ?? []) {
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      records.push(payload as Record<string, unknown>);
    }
  }
  return records.length === 1 ? records[0]! : {};
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
