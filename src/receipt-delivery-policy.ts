/**
 * Shared accepted-receipt delivery budget for role, auditor, and Navigator sessions (#288).
 *
 * #1132: the ceiling is the one configured auto-resume value (public-cli.json
 * top-level `autoResumeLimit`). This module owns no number of its own — the one
 * package default stays with AUTO_RESUME_LIMIT (#422), and `deliveryTurns`
 * records the delivery requests actually issued, never the budget
 * (零次即记零，不把额度或其他续跑次数冒充催交次数).
 */
import { AUTO_RESUME_LIMIT } from "./public-cli/run-lifecycle.ts";
import { parseAutoResumeLimit } from "./public-cli/config.ts";

export const NO_RECEIPT_LIFECYCLE_ENTRY_TYPE = "ak-no-receipt-lifecycle" as const;

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
    /** A rejection consumes one budget slot. It is not a delivery request. */
    recordRejected(reason: string) {
      terminalToolCalled = true;
      rejectedReceipts.push({ reason, diagnosticAvailable: reason.trim() !== "" });
      spend();
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
  };
}
