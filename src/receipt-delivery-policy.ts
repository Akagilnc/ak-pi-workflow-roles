/** Shared accepted-receipt delivery budget for role, auditor, and Navigator sessions (#288). */
export const RECEIPT_DELIVERY_TURN_LIMIT = 2 as const;
export const RECEIPT_DELIVERY_PROMPT = "本 session 尚无已接受的 typed 回执。请现在调用具名终局工具交卷；若先前被打回，请按拒因修正后重交。";

export const NO_RECEIPT_LIFECYCLE_ENTRY_TYPE = "ak-no-receipt-lifecycle" as const;

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

export function noReceiptLifecycleFacts(
  input: Omit<NoReceiptLifecycleFacts, "deliveryTurns" | "sessionCompletion" | "acceptedReceipt"> & { deliveryTurns: number },
): NoReceiptLifecycleFacts {
  if (input.deliveryTurns !== RECEIPT_DELIVERY_TURN_LIMIT) throw new Error("receipt delivery budget is not exhausted");
  if (input.runPointer.trim() === "" || input.attemptPointer.trim() === "") throw new Error("no-receipt lifecycle binding is missing");
  return { ...input, deliveryTurns: RECEIPT_DELIVERY_TURN_LIMIT, sessionCompletion: "settled-without-accepted-receipt", acceptedReceipt: false };
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
      rejectedReceipts.push({ reason });
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
