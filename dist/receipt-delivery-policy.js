/** Shared accepted-receipt delivery budget for role, auditor, and Navigator sessions (#288). */
export const RECEIPT_DELIVERY_TURN_LIMIT = 2;
export const RECEIPT_DELIVERY_PROMPT = "本 session 尚无已接受的 typed 回执。请现在调用具名终局工具交卷；若先前被打回，请按拒因修正后重交。";
export const NO_RECEIPT_LIFECYCLE_ENTRY_TYPE = "ak-no-receipt-lifecycle";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Sole runtime parser for lifecycle bytes. Producers and consumers share this owner. */
export function parseNoReceiptLifecycleFacts(input) {
    const fields = ["acceptedReceipt", "attemptPointer", "deliveryTurns", "rejectedReceipts", "runPointer", "sessionCompletion", "terminalToolCalled"];
    if (!isRecord(input)
        || Object.keys(input).sort().join("\0") !== fields.join("\0")
        || typeof input.terminalToolCalled !== "boolean"
        || input.deliveryTurns !== RECEIPT_DELIVERY_TURN_LIMIT
        || input.sessionCompletion !== "settled-without-accepted-receipt"
        || input.acceptedReceipt !== false
        || typeof input.runPointer !== "string" || input.runPointer.trim() === ""
        || typeof input.attemptPointer !== "string" || input.attemptPointer.trim() === ""
        || !Array.isArray(input.rejectedReceipts)
        || !input.rejectedReceipts.every((item) => isRecord(item)
            && Object.keys(item).length === 1 && typeof item.reason === "string" && item.reason.trim() !== "")) {
        throw new TypeError("malformed no-receipt lifecycle facts");
    }
    return {
        terminalToolCalled: input.terminalToolCalled,
        rejectedReceipts: input.rejectedReceipts,
        deliveryTurns: RECEIPT_DELIVERY_TURN_LIMIT,
        sessionCompletion: "settled-without-accepted-receipt",
        runPointer: input.runPointer,
        attemptPointer: input.attemptPointer,
        acceptedReceipt: false,
    };
}
export function noReceiptLifecycleFacts(input) {
    return parseNoReceiptLifecycleFacts({ ...input, sessionCompletion: "settled-without-accepted-receipt", acceptedReceipt: false });
}
export function createReceiptDeliveryPolicy() {
    let accepted = false;
    let terminalToolCalled = false;
    let deliveryTurns = 0;
    const rejectedReceipts = [];
    return {
        recordAccepted() { accepted = true; terminalToolCalled = true; },
        /** Infrastructure owns terminality and must never trigger receipt催交. */
        stopForInfrastructure() { accepted = true; },
        recordRejected(reason) {
            terminalToolCalled = true;
            rejectedReceipts.push({ reason });
            deliveryTurns = Math.min(RECEIPT_DELIVERY_TURN_LIMIT, deliveryTurns + 1);
        },
        recordDeliveryRequest() {
            deliveryTurns = Math.min(RECEIPT_DELIVERY_TURN_LIMIT, deliveryTurns + 1);
        },
        nextAction() {
            if (accepted)
                return "accepted";
            return deliveryTurns < RECEIPT_DELIVERY_TURN_LIMIT ? "request-delivery" : "no-receipt";
        },
        facts(binding) {
            return noReceiptLifecycleFacts({ terminalToolCalled, rejectedReceipts: [...rejectedReceipts], deliveryTurns, ...binding });
        },
    };
}
