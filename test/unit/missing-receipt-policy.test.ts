import test from "node:test";
import assert from "node:assert/strict";

import { parseNoReceiptLifecycleFacts } from "../../src/receipt-delivery-policy.ts";

// Parser tolerance matrix: producer/nested rejection extensions are ignored,
// and blank rejection reasons are retained as facts with a missing diagnostic.
test("persisted lifecycle readers ignore extensions and retain blank rejection facts", () => {
  // Row 1: unknown producer field + nested tracer extension are dropped.
  assert.deepEqual(parseNoReceiptLifecycleFacts({
    terminalToolCalled: true,
    rejectedReceipts: [{ reason: "未观察到 commit", tracer: "keep-compatible" }],
    deliveryTurns: 2,
    sessionCompletion: "settled-without-accepted-receipt",
    runPointer: "/run",
    attemptPointer: "attempt-1",
    acceptedReceipt: false,
    futureProducerField: { version: 2 },
  }), {
    terminalToolCalled: true,
    rejectedReceipts: [{ reason: "未观察到 commit", diagnosticAvailable: true }],
    deliveryTurns: 2,
    sessionCompletion: "settled-without-accepted-receipt",
    runPointer: "/run",
    attemptPointer: "attempt-1",
    acceptedReceipt: false,
  });

  // Row 2: blank reason survives verbatim, marked as missing diagnostic.
  const facts = parseNoReceiptLifecycleFacts({
    terminalToolCalled: true,
    rejectedReceipts: [{ reason: "  \t" }],
    deliveryTurns: 2,
    sessionCompletion: "settled-without-accepted-receipt",
    runPointer: "/run",
    attemptPointer: "attempt-1",
    acceptedReceipt: false,
  });
  assert.equal(facts.acceptedReceipt, false);
  assert.equal(facts.deliveryTurns, 2);
  assert.equal(facts.rejectedReceipts[0]?.diagnosticAvailable, false);
  assert.equal(facts.rejectedReceipts[0]?.reason, "  \t");
});
