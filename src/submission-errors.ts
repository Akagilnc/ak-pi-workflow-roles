import type { GatekeeperNonPassResult } from "./gatekeeper-role.ts";

function gatekeeperNonPassMessage(result: GatekeeperNonPassResult): string {
  if (result.status === "bounce") {
    const findings = result.findings.length === 0 ? "（无 findings）" : result.findings.join("; ");
    return `门下省打回重写，findings：${findings}`;
  }
  if (result.status === "unreadable") {
    return `门下省官回执形状不可读（${result.officer}）：${result.reason}`;
  }
  return `门下省 ${result.status}（${result.stage}）：${result.reason}`;
}

/** Structured non-pass; `.result` is session-projected via tool_result, message feeds the model. */
export class GatekeeperDecisionError extends Error {
  readonly result: GatekeeperNonPassResult;
  constructor(result: GatekeeperNonPassResult) {
    super(gatekeeperNonPassMessage(result));
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
