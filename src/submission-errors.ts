import { readableGateItem } from "./readable-gate-item.ts";
import { isRecord } from "./unknown-value.ts";

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

/**
 * ADR 0066/0070 one-shot commit and prefix reminders.
 * They stay a correction the same session may make, and they do not occupy
 * the configured re-ask or 催交 budget (#1132).
 */
export function isOneShotWorkerReminderCode(code: unknown): boolean {
  return code === "worker_commit_reminder" || code === "worker_prefix_reminder";
}

export class WorkerUnfinishedReasonReminderError extends Error {
  readonly code = "worker_unfinished_reason_reminder" as const;
  constructor() {
    // The ceiling is the configured unfinished-reason limit. This text reaches
    // the model and does not restate a count.
    super("本次 unfinished 回执未含 reason；请补上 reason 后再交。");
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
  if (!isRecord(receipt)) return undefined;
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
