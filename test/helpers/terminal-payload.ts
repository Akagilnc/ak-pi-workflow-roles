import type { TerminalRoleOutcome } from "../../src/public-cli/terminal.ts";

/** Object-root payloads in ledger order. Sequence, not a sole pick or merge. */
export function objectPayloads(
  outcome: TerminalRoleOutcome,
): readonly Record<string, unknown>[] {
  if (outcome.kind === "no_receipt") return [];
  const records: Record<string, unknown>[] = [];
  for (const payload of outcome.payloads ?? []) {
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      records.push(payload as Record<string, unknown>);
    }
  }
  return records;
}

/**
 * Host-owned failure/no_receipt decisiveFacts only.
 * Role payload fields live on outcome.payloads / objectPayloads — never sole-projected or merged.
 */
export function payloadFacts(outcome: TerminalRoleOutcome): Record<string, unknown> {
  if (outcome.kind === "failure" || outcome.kind === "no_receipt") {
    return { ...outcome.decisiveFacts };
  }
  return {};
}

/**
 * Status only from terminal kind fields (no_receipt / audit_escalation).
 * Accepted multi-row status lives on the payload sequence — use payloadStatusSequence.
 */
export function payloadStatus(outcome: TerminalRoleOutcome): string | undefined {
  if (outcome.kind === "no_receipt") return outcome.status;
  if (outcome.kind === "audit_escalation") return outcome.status;
  return undefined;
}

/** Per-payload status leaves in ledger order. Sequence, not a sole/unanimous merge. */
export function payloadStatusSequence(outcome: TerminalRoleOutcome): readonly string[] {
  if (outcome.kind === "no_receipt" || outcome.kind === "audit_escalation") {
    return typeof outcome.status === "string" ? [outcome.status] : [];
  }
  const statuses: string[] = [];
  for (const facts of objectPayloads(outcome)) {
    if (typeof facts.status === "string") statuses.push(facts.status);
    else if (typeof facts.judgeStatus === "string") statuses.push(facts.judgeStatus);
    else if (typeof facts.countersignStatus === "string") statuses.push(facts.countersignStatus);
  }
  return statuses;
}
