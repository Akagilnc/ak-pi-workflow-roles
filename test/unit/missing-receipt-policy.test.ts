import test from "node:test";
import assert from "node:assert/strict";

import { createReceiptDeliveryPolicy } from "../../src/receipt-delivery-policy.ts";

test("shared receipt delivery policy accepts after zero, one, or two delivery turns and never asks a third", () => {
  for (const acceptedAt of [0, 1, 2]) {
    const policy = createReceiptDeliveryPolicy();
    for (let turn = 0; turn < acceptedAt; turn += 1) {
      assert.equal(policy.nextAction(), "request-delivery");
      policy.recordRejected(`rejected-${turn + 1}`);
    }
    policy.recordAccepted();
    assert.equal(policy.nextAction(), "accepted");
    assert.equal(policy.facts().deliveryTurns, acceptedAt);
  }
  const exhausted = createReceiptDeliveryPolicy();
  exhausted.recordRejected("未观察到 commit");
  assert.equal(exhausted.nextAction(), "request-delivery");
  exhausted.recordDeliveryRequest();
  assert.equal(exhausted.nextAction(), "no-receipt");
  assert.equal(exhausted.facts().deliveryTurns, 2);
});

test("a session that never calls its terminal tool gets the same typed no-receipt facts", () => {
  const policy = createReceiptDeliveryPolicy();
  assert.equal(policy.nextAction(), "request-delivery");
  policy.recordDeliveryRequest();
  assert.equal(policy.nextAction(), "request-delivery");
  policy.recordDeliveryRequest();
  assert.deepEqual(policy.facts(), {
    terminalToolCalled: false,
    rejectedReceipts: [],
    deliveryTurns: 2,
    sessionCompletion: "settled-without-accepted-receipt",
    acceptedReceipt: false,
  });
});
