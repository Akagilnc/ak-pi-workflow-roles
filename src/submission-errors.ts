import type { SubmissionGateNonPassResult } from "./gatekeeper-role.ts";
import { readableGateItem } from "./readable-gate-item.ts";

/**
 * Tool-result text the parent model sees (#753 / #750 evidence).
 * continue | escalate → officer receipt verbatim (JSON when structured).
 * no_receipt → honest lifecycle fact. No findings rewrite, no「（无 findings）」.
 * #775: structured field content via readableGateItem (DRY with other gate seams).
 */
function serializeReceipt(receipt: unknown): string {
  return readableGateItem(receipt);
}

function gatekeeperNonPassMessage(result: SubmissionGateNonPassResult): string {
  if (result.status === "continue" || result.status === "escalate") {
    return serializeReceipt(result.receipt);
  }
  if (result.status === "transport_failure") {
    const head = `门下省 ${result.status}（${result.stage}）：${result.reason}`;
    return result.submission === undefined
      ? head
      : `${head}\n${serializeReceipt(result.submission)}`;
  }
  return `门下省 ${result.status}（${result.stage}）：${result.reason}`;
}

/** Structured non-pass; `.result` is session-projected via tool_result, message feeds the model. */
export class GatekeeperDecisionError extends Error {
  readonly result: SubmissionGateNonPassResult;
  constructor(result: SubmissionGateNonPassResult, message?: string) {
    super(message ?? gatekeeperNonPassMessage(result));
    this.name = "GatekeeperDecisionError";
    this.result = result;
  }
}

export class WorkerCommitReminderError extends Error {
  readonly code = "worker_commit_reminder" as const;
  constructor() {
    super("未观察到 commit");
    this.name = "WorkerCommitReminderError";
  }
}

export class WorkerPrefixReminderError extends Error {
  readonly code = "worker_prefix_reminder" as const;
  constructor() {
    super("观察到缺前缀 commit");
    this.name = "WorkerPrefixReminderError";
  }
}

export class WorkerUnfinishedReasonReminderError extends Error {
  readonly code = "worker_unfinished_reason_reminder" as const;
  constructor() {
    super("本次 unfinished 回执未含 reason；本接缝缺由至多打回两次。");
    this.name = "WorkerUnfinishedReasonReminderError";
  }
}

/**
 * Host constraint missed a routing discriminator (#1055).
 * Names live only in the submission schema. This notice carries the field and the received value.
 */
export function unreadableDiscriminatorNotice(field: string, received: unknown): string {
  if (received === undefined) return `读不出 ${field}`;
  return `读不出 ${field}：${readableGateItem(received)}`;
}

/** The received discriminator only — never the rest of the receipt. */
export function receivedDiscriminator(receipt: unknown, field: string): unknown {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
  if (!Object.hasOwn(receipt, field)) return undefined;
  return (receipt as Record<string, unknown>)[field];
}

/**
 * Parent seat status unreadable for queueing (#753).
 * Correctable back to the parent itself — not a gate officer bounce, no officer field.
 */
export class ParentQueueReaskError extends Error {
  readonly code = "parent_queue_reask" as const;
  constructor(message: string) {
    super(message);
    this.name = "ParentQueueReaskError";
  }
}
