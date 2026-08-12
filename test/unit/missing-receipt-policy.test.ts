import test from "node:test";
import assert from "node:assert/strict";

import { createReceiptDeliveryPolicy, parseNoReceiptLifecycleFacts } from "../../src/receipt-delivery-policy.ts";

test("shared receipt delivery policy accepts after zero, one, or two delivery turns and never asks a third", () => {
  for (const acceptedAt of [0, 1, 2]) {
    const policy = createReceiptDeliveryPolicy();
    for (let turn = 0; turn < acceptedAt; turn += 1) {
      assert.equal(policy.nextAction(), "request-delivery");
      policy.recordRejected(`rejected-${turn + 1}`);
    }
    policy.recordAccepted();
    assert.equal(policy.nextAction(), "accepted");
  }
  const exhausted = createReceiptDeliveryPolicy();
  exhausted.recordRejected("未观察到 commit");
  assert.equal(exhausted.nextAction(), "request-delivery");
  exhausted.recordDeliveryRequest();
  assert.equal(exhausted.nextAction(), "no-receipt");
  assert.equal(exhausted.facts({ runPointer: "/run", attemptPointer: "attempt-1" }).deliveryTurns, 2);

  const batched = createReceiptDeliveryPolicy();
  batched.recordDeliveryRequest();
  const firstReserved = batched.reserveTerminalExecution();
  const secondReserved = batched.reserveTerminalExecution();
  assert.equal(firstReserved, true);
  assert.equal(secondReserved, false, "the consumed delivery turn leaves one execution slot");
  if (firstReserved) batched.recordRejected("first executed rejection");
  const batchedFacts = batched.facts({ runPointer: "/run", attemptPointer: "attempt-1" });
  assert.equal(batchedFacts.deliveryTurns, 2);
  assert.deepEqual(batchedFacts.rejectedReceipts, [
    { reason: "first executed rejection", diagnosticAvailable: true },
  ]);
});

test("persisted lifecycle readers ignore producer and nested rejection extensions", () => {
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
});

test("persisted lifecycle readers retain blank rejection facts and mark the missing diagnostic", () => {
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

test("a session that never calls its terminal tool gets the same typed no-receipt facts", () => {
  const policy = createReceiptDeliveryPolicy();
  assert.equal(policy.nextAction(), "request-delivery");
  policy.recordDeliveryRequest();
  assert.equal(policy.nextAction(), "request-delivery");
  policy.recordDeliveryRequest();
  assert.deepEqual(policy.facts({ runPointer: "/run", attemptPointer: "attempt-1" }), {
    terminalToolCalled: false,
    rejectedReceipts: [],
    deliveryTurns: 2,
    sessionCompletion: "settled-without-accepted-receipt",
    runPointer: "/run",
    attemptPointer: "attempt-1",
    acceptedReceipt: false,
  });
});
