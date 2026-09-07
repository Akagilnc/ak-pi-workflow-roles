import type { GatekeeperNonPassResult } from "./gatekeeper-role.ts";

/**
 * Tool-result text the parent model sees (#753 / #750 evidence).
 * bounce | escalate → officer receipt verbatim (JSON when structured).
 * no_receipt → honest lifecycle fact. No findings rewrite, no「（无 findings）」.
 */
function serializeReceipt(receipt: unknown): string {
  if (typeof receipt === "string") return receipt;
  try {
    return JSON.stringify(receipt);
  } catch {
    return String(receipt);
  }
}

function gatekeeperNonPassMessage(result: GatekeeperNonPassResult): string {
  if (result.status === "bounce" || result.status === "escalate") {
    return serializeReceipt(result.receipt);
  }
  // no_receipt
  return `门下省 ${result.status}（${result.stage}）：${result.reason}`;
}

/** Structured non-pass; `.result` is session-projected via tool_result, message feeds the model. */
export class GatekeeperDecisionError extends Error {
  readonly result: GatekeeperNonPassResult;
  constructor(result: GatekeeperNonPassResult, message?: string) {
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
