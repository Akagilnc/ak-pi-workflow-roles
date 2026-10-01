/**
 * Shared accepted-receipt delivery budget for role, auditor, and Navigator sessions (#288).
 *
 * #1132: the ceiling is the one configured auto-resume value (public-cli.json
 * top-level `autoResumeLimit`). This module owns no number of its own — the one
 * package default stays with AUTO_RESUME_LIMIT (#422), and `deliveryTurns`
 * records the delivery requests actually issued, never the budget
 * (零次即记零，不把额度或其他续跑次数冒充催交次数).
 */
import { packagedRoleOutputRejectionReason } from "./navigator-invocation-identity.ts";
import { AUTO_RESUME_LIMIT } from "./public-cli/run-lifecycle.ts";
import { parseAutoResumeLimit } from "./public-cli/config.ts";

export const NO_RECEIPT_LIFECYCLE_ENTRY_TYPE = "ak-no-receipt-lifecycle" as const;

/** One in-process催交 send, tagged with the public call that issued it. */
export const RECEIPT_DELIVERY_REQUEST_ENTRY = "ak-receipt-delivery-request" as const;

/**
 * Facts of one public call. A call with an invocation scope does not share
 * `current:<runDirectory>` with the previous call on the same run.
 */
export function receiptAttemptPointer(runPointer: string, invocationScopeId?: string): string {
  const scope = invocationScopeId?.trim() ?? "";
  if (scope.length > 0) return `invocation:${scope}`;
  return `current:${runPointer}`;
}

/** Child-process transport for the effective ceiling (#1132). */
export const RECEIPT_DELIVERY_LIMIT_ENV = "AK_ROLE_RECEIPT_DELIVERY_LIMIT" as const;

/**
 * The effective receipt-delivery ceiling: the caller's already-resolved
 * configured value, else the single package default. Domain-validated at this
 * one seam (#422) so NaN/negative/fractional/Infinity never silently disable
 * or bypass the comparison downstream.
 */
export function deliveryLimitFromConfig(value: number | undefined): number {
  return parseAutoResumeLimit(value ?? AUTO_RESUME_LIMIT);
}

/** Effective ceiling for an in-child role runtime reading its own env (#1132). */
export function deliveryLimitFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[RECEIPT_DELIVERY_LIMIT_ENV];
  if (raw === undefined || raw.trim() === "") return deliveryLimitFromConfig(undefined);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return deliveryLimitFromConfig(undefined);
  return deliveryLimitFromConfig(parsed);
}

function deliveryTurnsFact(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("deliveryTurns must be a non-negative integer");
  }
  return value;
}

/** The sole schema shared by lifecycle owners and Terminal projections. */
export type NoReceiptLifecycleFacts = {
  terminalToolCalled: boolean;
  rejectedReceipts: readonly { reason: string; diagnosticAvailable: boolean }[];
  /** Delivery requests actually issued on this run (#1132 — not a budget). */
  deliveryTurns: number;
  sessionCompletion: "settled-without-accepted-receipt";
  runPointer: string;
  attemptPointer: string;
  acceptedReceipt: false;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the facts required by Terminal consumers; persisted extensions are ignored. */
export function parseNoReceiptLifecycleFacts(input: unknown): NoReceiptLifecycleFacts {
  if (!isRecord(input)
    || typeof input.terminalToolCalled !== "boolean"
    || input.sessionCompletion !== "settled-without-accepted-receipt"
    || input.acceptedReceipt !== false
    || typeof input.runPointer !== "string" || input.runPointer.trim() === ""
    || typeof input.attemptPointer !== "string" || input.attemptPointer.trim() === ""
    || !Array.isArray(input.rejectedReceipts)
    || !input.rejectedReceipts.every((item) => isRecord(item)
      && typeof item.reason === "string")) {
    throw new TypeError("malformed no-receipt lifecycle facts");
  }
  return {
    terminalToolCalled: input.terminalToolCalled,
    rejectedReceipts: input.rejectedReceipts.map((item) => ({
      reason: item.reason as string,
      diagnosticAvailable: (item.reason as string).trim() !== "",
    })),
    deliveryTurns: deliveryTurnsFact(input.deliveryTurns),
    sessionCompletion: "settled-without-accepted-receipt",
    runPointer: input.runPointer,
    attemptPointer: input.attemptPointer,
    acceptedReceipt: false,
  };
}

/**
 * #1132: exhaustion is the caller's decision — the receipt-delivery loop only
 * settles after its budget is actually spent — so this records the issued
 * count verbatim instead of demanding it equal a package constant.
 */
export function noReceiptLifecycleFacts(
  input: Omit<NoReceiptLifecycleFacts, "rejectedReceipts" | "deliveryTurns" | "sessionCompletion" | "acceptedReceipt"> & {
    rejectedReceipts: readonly { reason: string }[];
    deliveryTurns: number;
  },
): NoReceiptLifecycleFacts {
  return {
    terminalToolCalled: input.terminalToolCalled,
    rejectedReceipts: input.rejectedReceipts.map(({ reason }) => ({
      reason,
      diagnosticAvailable: reason.trim() !== "",
    })),
    deliveryTurns: deliveryTurnsFact(input.deliveryTurns),
    sessionCompletion: "settled-without-accepted-receipt",
    runPointer: input.runPointer,
    attemptPointer: input.attemptPointer,
    acceptedReceipt: false,
  };
}

export function createReceiptDeliveryPolicy(limit?: number) {
  const deliveryLimit = deliveryLimitFromConfig(limit);
  let accepted = false;
  let closed = false;
  let terminalToolCalled = false;
  /** Requests actually sent. Rejections and a nested close do not invent sends. */
  let deliveryTurns = 0;
  /** Stop counter. Separate from the issued-count fact (#1132). */
  let budgetSpent = 0;
  const rejectedReceipts: { reason: string; diagnosticAvailable: boolean }[] = [];
  const spend = (): void => {
    if (budgetSpent < deliveryLimit) budgetSpent += 1;
  };
  return {
    /** The effective ceiling this budget spends (#1132 — never re-read). */
    limit: deliveryLimit,
    recordAccepted() {
      accepted = true;
      terminalToolCalled = true;
    },
    /** Infrastructure owns terminality and must never trigger receipt催交. */
    stopForInfrastructure() { accepted = true; },
    /**
     * Record the rejection this turn already produced.
     * The fact does not spend a budget. The seam that sends the next prompt
     * owns that count.
     */
    recordRejected(reason: string) {
      terminalToolCalled = true;
      rejectedReceipts.push({ reason, diagnosticAvailable: reason.trim() !== "" });
    },
    recordDeliveryRequest() {
      deliveryTurns += 1;
      spend();
    },
    /**
     * Stop asking. The issued count stays whatever was actually sent (#1132 —
     * do not fill the remainder up to the ceiling).
     */
    closeBudget() { closed = true; },
    /**
     * A nested session settled without an accepted receipt. Close so this layer
     * does not open another prompt on that session. The issued count stays the
     * larger of the two seams: a nested zero must not wipe prompts this layer
     * already sent, and adding the two counts would bill one send twice.
     */
    recordNestedNoReceipt(facts: NoReceiptLifecycleFacts) {
      terminalToolCalled = terminalToolCalled || facts.terminalToolCalled;
      rejectedReceipts.push(...facts.rejectedReceipts);
      deliveryTurns = Math.max(deliveryTurns, facts.deliveryTurns);
      closed = true;
    },
    nextAction(): "accepted" | "request-delivery" | "no-receipt" {
      if (accepted) return "accepted";
      if (closed) return "no-receipt";
      return budgetSpent < deliveryLimit ? "request-delivery" : "no-receipt";
    },
    /** Delivery requests actually issued so far (#1132). */
    issuedDeliveryRequests(): number {
      return deliveryTurns;
    },
    /** Current typed delivery facts. No prose. */
    deliveryState() {
      return {
        terminalToolCalled,
        rejectedReceipts: rejectedReceipts.map((item) => ({ ...item })),
        deliveryTurns,
        acceptedReceipt: false as const,
      };
    },
    facts(binding: { runPointer: string; attemptPointer: string }): NoReceiptLifecycleFacts {
      return noReceiptLifecycleFacts({ terminalToolCalled, rejectedReceipts: [...rejectedReceipts], deliveryTurns, ...binding });
    },
    /**
     * Continue a public call after the in-memory policy was rebuilt.
     * Sends already issued spend the same budget; copied rejections keep
     * the fact and do not spend again.
     */
    continueIssued(prior: {
      readonly deliveryTurns: number;
      readonly rejectedReceipts: readonly { reason: string }[];
      readonly terminalToolCalled?: boolean;
    }) {
      for (const receipt of prior.rejectedReceipts) {
        this.recordRejected(receipt.reason);
      }
      if (prior.terminalToolCalled === true) terminalToolCalled = true;
      for (let index = 0; index < prior.deliveryTurns; index += 1) {
        this.recordDeliveryRequest();
      }
    },
  };
}

function entryRecord(entry: unknown): Record<string, unknown> | undefined {
  return isRecord(entry) ? entry : undefined;
}

const RECEIPT_DELIVERY_PROMPT = "ak-receipt-delivery-prompt";

/** Sends, observed rejections, and the latest lifecycle fact for this public call. */
export type ReceiptContinuation = {
  readonly deliveryTurns: number;
  readonly rejectedReceipts: readonly { reason: string }[];
  readonly terminalToolCalled: boolean;
};

function customTypeOf(record: Record<string, unknown>, message: Record<string, unknown> | undefined): unknown {
  return record.customType ?? message?.customType;
}

function dataOf(record: Record<string, unknown>, message: Record<string, unknown> | undefined): unknown {
  return record.data ?? message?.details;
}

/** Scope id carried by a delivery request or an invocation-scoped lifecycle fact. */
function scopeTag(record: Record<string, unknown>): string | undefined {
  const message = isRecord(record.message) ? record.message : undefined;
  const customType = customTypeOf(record, message);
  const data = dataOf(record, message);
  if (
    customType === RECEIPT_DELIVERY_REQUEST_ENTRY
    && isRecord(data)
    && typeof data.invocationScopeId === "string"
    && data.invocationScopeId.trim() !== ""
  ) {
    return data.invocationScopeId;
  }
  if (customType !== NO_RECEIPT_LIFECYCLE_ENTRY_TYPE) return undefined;
  try {
    const facts = parseNoReceiptLifecycleFacts(data);
    const prefix = "invocation:";
    if (!facts.attemptPointer.startsWith(prefix)) return undefined;
    const scope = facts.attemptPointer.slice(prefix.length);
    return scope.trim() === "" ? undefined : scope;
  } catch {
    return undefined;
  }
}

/**
 * A later manual call starts with its own user message and has no scope tag yet.
 * 催交 follow-up text stays inside the call that already tagged itself.
 */
function plainUserBoundary(record: Record<string, unknown>): boolean {
  const message = isRecord(record.message) ? record.message : undefined;
  if (message?.role !== "user") return false;
  return customTypeOf(record, message) !== RECEIPT_DELIVERY_PROMPT;
}

function unionRejectionReasons(
  observed: readonly string[],
  snapshot: readonly { reason: string }[],
): { reason: string }[] {
  const remaining = new Map<string, number>();
  for (const reason of observed) remaining.set(reason, (remaining.get(reason) ?? 0) + 1);
  const merged = observed.map((reason) => ({ reason }));
  for (const item of snapshot) {
    const left = remaining.get(item.reason) ?? 0;
    if (left > 0) remaining.set(item.reason, left - 1);
    else merged.push({ reason: item.reason });
  }
  return merged;
}

/**
 * Sends and rejections already stored for this public call.
 * A rejection toolResult has no scope of its own: it belongs to the next
 * scope tag of this call. A later untagged rejection, after a plain user
 * message and before that call writes a new tag, stays with the new call.
 * An empty lifecycle snapshot does not erase toolResults already observed.
 */
export function priorReceiptContinuation(
  entries: Iterable<unknown>,
  invocationScopeId: string,
): ReceiptContinuation {
  const pointer = receiptAttemptPointer("", invocationScopeId);
  let entryTurns = 0;
  let factTurns = 0;
  let snapshotReceipts: readonly { reason: string }[] = [];
  let snapshotTerminal = false;
  const observed: string[] = [];
  let pending: string[] = [];
  let lastTag: string | undefined;
  let plainUserAfterLastTag = false;
  for (const entry of entries) {
    const record = entryRecord(entry);
    if (record === undefined) continue;
    const tagged = scopeTag(record);
    if (tagged !== undefined) {
      if (tagged === invocationScopeId) observed.push(...pending);
      pending = [];
      lastTag = tagged;
      plainUserAfterLastTag = false;
      const message = isRecord(record.message) ? record.message : undefined;
      const customType = customTypeOf(record, message);
      if (tagged !== invocationScopeId) continue;
      if (customType === RECEIPT_DELIVERY_REQUEST_ENTRY) entryTurns += 1;
      if (customType !== NO_RECEIPT_LIFECYCLE_ENTRY_TYPE) continue;
      try {
        const facts = parseNoReceiptLifecycleFacts(dataOf(record, message));
        if (facts.attemptPointer !== pointer) continue;
        if (facts.deliveryTurns >= factTurns) {
          factTurns = facts.deliveryTurns;
          snapshotReceipts = facts.rejectedReceipts;
          snapshotTerminal = facts.terminalToolCalled;
        }
      } catch {
        // A malformed historical entry is not this call's count.
      }
      continue;
    }
    if (plainUserBoundary(record)) {
      pending = [];
      plainUserAfterLastTag = true;
      continue;
    }
    const message = isRecord(record.message) ? record.message : undefined;
    if (message?.role !== "toolResult") continue;
    const reason = packagedRoleOutputRejectionReason(message);
    if (reason === undefined) continue;
    pending.push(reason);
  }
  if (!plainUserAfterLastTag && lastTag === invocationScopeId) observed.push(...pending);
  const rejectedReceipts = unionRejectionReasons(observed, snapshotReceipts);
  return {
    deliveryTurns: Math.max(entryTurns, factTurns),
    rejectedReceipts,
    terminalToolCalled: snapshotTerminal || rejectedReceipts.length > 0,
  };
}
