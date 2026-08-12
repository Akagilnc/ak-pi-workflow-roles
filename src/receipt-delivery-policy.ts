/** Shared accepted-receipt delivery budget for role, auditor, and Navigator sessions (#288). */
export const RECEIPT_DELIVERY_TURN_LIMIT = 2 as const;
export const RECEIPT_DELIVERY_PROMPT = "本 session 尚无已接受的 typed 回执。请现在调用具名终局工具交卷；若先前被打回，请按拒因修正后重交。";

export type MissingReceiptLifecycleFacts = {
  terminalToolCalled: boolean;
  rejectedReceipts: readonly { reason: string }[];
  deliveryTurns: number;
  sessionCompletion: "settled-without-accepted-receipt";
  acceptedReceipt: false;
};

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
    facts(): MissingReceiptLifecycleFacts {
      return { terminalToolCalled, rejectedReceipts: [...rejectedReceipts], deliveryTurns, sessionCompletion: "settled-without-accepted-receipt", acceptedReceipt: false };
    },
  };
}
