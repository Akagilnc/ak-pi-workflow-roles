/** Shared accepted-receipt delivery budget for role, auditor, and Navigator sessions (#288). */
export const RECEIPT_DELIVERY_TURN_LIMIT = 2 as const;
export const RECEIPT_DELIVERY_PROMPT = "本 session 尚无已接受的 typed 回执。请现在调用具名终局工具交卷；若先前被打回，请按拒因修正后重交。";

export const NO_RECEIPT_LIFECYCLE_ENTRY_TYPE = "ak-no-receipt-lifecycle" as const;
export const REJECTION_REASON_UNAVAILABLE = "terminal receipt rejected without diagnostic" as const;

function normalizeRejectionReason(reason: unknown): string {
  const rendered = typeof reason === "string" ? reason : String(reason);
  return rendered.trim() === "" ? REJECTION_REASON_UNAVAILABLE : rendered;
}

/** The sole schema shared by lifecycle owners and Terminal projections. */
export type NoReceiptLifecycleFacts = {
  terminalToolCalled: boolean;
  rejectedReceipts: readonly { reason: string }[];
  deliveryTurns: typeof RECEIPT_DELIVERY_TURN_LIMIT;
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
    || input.deliveryTurns !== RECEIPT_DELIVERY_TURN_LIMIT
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
    rejectedReceipts: input.rejectedReceipts.map((item) => ({ reason: normalizeRejectionReason(item.reason) })),
    deliveryTurns: RECEIPT_DELIVERY_TURN_LIMIT,
    sessionCompletion: "settled-without-accepted-receipt",
    runPointer: input.runPointer,
    attemptPointer: input.attemptPointer,
    acceptedReceipt: false,
  };
}

export function noReceiptLifecycleFacts(
  input: Omit<NoReceiptLifecycleFacts, "deliveryTurns" | "sessionCompletion" | "acceptedReceipt"> & { deliveryTurns: number },
): NoReceiptLifecycleFacts {
  if (input.deliveryTurns !== RECEIPT_DELIVERY_TURN_LIMIT) {
    throw new TypeError("no-receipt lifecycle requires an exhausted delivery budget");
  }
  return {
    terminalToolCalled: input.terminalToolCalled,
    rejectedReceipts: input.rejectedReceipts.map(({ reason }) => ({ reason: normalizeRejectionReason(reason) })),
    deliveryTurns: RECEIPT_DELIVERY_TURN_LIMIT,
    sessionCompletion: "settled-without-accepted-receipt",
    runPointer: input.runPointer,
    attemptPointer: input.attemptPointer,
    acceptedReceipt: false,
  };
}

export function createReceiptDeliveryPolicy() {
  let accepted = false;
  let terminalToolCalled = false;
  let deliveryTurns = 0;
  const rejectedReceipts: { reason: string }[] = [];
  return {
    recordAccepted() { accepted = true; terminalToolCalled = true; },
    /** Infrastructure owns terminality and must never trigger receipt催交. */
    stopForInfrastructure() { accepted = true; },
    recordRejected(reason: string) {
      terminalToolCalled = true;
      rejectedReceipts.push({ reason: normalizeRejectionReason(reason) });
      deliveryTurns = Math.min(RECEIPT_DELIVERY_TURN_LIMIT, deliveryTurns + 1);
    },
    recordDeliveryRequest() {
      deliveryTurns = Math.min(RECEIPT_DELIVERY_TURN_LIMIT, deliveryTurns + 1);
    },
    nextAction(): "accepted" | "request-delivery" | "no-receipt" {
      if (accepted) return "accepted";
      return deliveryTurns < RECEIPT_DELIVERY_TURN_LIMIT ? "request-delivery" : "no-receipt";
    },
    facts(binding: { runPointer: string; attemptPointer: string }): NoReceiptLifecycleFacts {
      return noReceiptLifecycleFacts({ terminalToolCalled, rejectedReceipts: [...rejectedReceipts], deliveryTurns, ...binding });
    },
  };
}
