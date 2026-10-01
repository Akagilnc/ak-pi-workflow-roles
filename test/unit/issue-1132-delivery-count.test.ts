import test from "node:test";
import assert from "node:assert/strict";

import {
  createReceiptDeliveryPolicy,
  deliveryLimitFromConfig,
  deliveryLimitFromEnv,
  noReceiptLifecycleFacts,
  RECEIPT_DELIVERY_LIMIT_ENV,
} from "../../src/receipt-delivery-policy.ts";
import { externalRoleTurnRoundLimit } from "../../src/external-host-turn-loop.ts";
import { AUTO_RESUME_LIMIT } from "../../src/public-cli/run-lifecycle.ts";

test("the effective ceiling follows the configured value; unconfigured keeps the one package default", () => {
  assert.equal(AUTO_RESUME_LIMIT, 2);
  assert.equal(deliveryLimitFromConfig(undefined), 2);
  assert.equal(deliveryLimitFromConfig(0), 0);
  assert.equal(deliveryLimitFromConfig(5), 5);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => deliveryLimitFromConfig(bad));
  }
  assert.throws(() => deliveryLimitFromConfig("2" as unknown as number));
});

test("the child env carries the same number; absent or non-integer falls back to the default", () => {
  assert.equal(deliveryLimitFromEnv({}), 2);
  assert.equal(deliveryLimitFromEnv({ [RECEIPT_DELIVERY_LIMIT_ENV]: "0" }), 0);
  assert.equal(deliveryLimitFromEnv({ [RECEIPT_DELIVERY_LIMIT_ENV]: "7" }), 7);
  assert.equal(deliveryLimitFromEnv({ [RECEIPT_DELIVERY_LIMIT_ENV]: "  " }), 2);
  assert.equal(deliveryLimitFromEnv({ [RECEIPT_DELIVERY_LIMIT_ENV]: "two" }), 2);
});

test("the closeRound re-ask loop spends the first round plus the configured count", () => {
  assert.equal(externalRoleTurnRoundLimit({}), 1 + 2);
  assert.equal(externalRoleTurnRoundLimit({ deliveryRequestLimit: 0 }), 1);
  assert.equal(externalRoleTurnRoundLimit({ deliveryRequestLimit: 4 }), 5);
});

test("a zero ceiling settles without a delivery request", () => {
  const policy = createReceiptDeliveryPolicy(0);
  assert.equal(policy.nextAction(), "no-receipt");
  assert.equal(policy.issuedDeliveryRequests(), 0);
  assert.equal(
    policy.facts({ runPointer: "/run", attemptPointer: "attempt-1" }).deliveryTurns,
    0,
  );
});

test("the delivery budget tracks the requests actually issued at any configured count", () => {
  for (const limit of [0, 1, 2, 5]) {
    const policy = createReceiptDeliveryPolicy(limit);
    for (let sent = 0; sent < limit; sent += 1) {
      assert.equal(policy.nextAction(), "request-delivery", `limit ${limit} after ${sent}`);
      policy.recordDeliveryRequest();
      assert.equal(policy.issuedDeliveryRequests(), sent + 1);
    }
    assert.equal(policy.nextAction(), "no-receipt", `limit ${limit} exhausted`);
    assert.equal(
      policy.facts({ runPointer: "/run", attemptPointer: "attempt-1" }).deliveryTurns,
      limit,
    );
  }
});

test("no_receipt facts record the issued count, including zero", () => {
  const base = { terminalToolCalled: false, runPointer: "/run", attemptPointer: "current:/run" };
  for (const issued of [0, 1, 2, 5]) {
    const facts = noReceiptLifecycleFacts({ ...base, rejectedReceipts: [], deliveryTurns: issued });
    assert.equal(facts.deliveryTurns, issued);
  }
  assert.throws(() => noReceiptLifecycleFacts({ ...base, rejectedReceipts: [], deliveryTurns: -1 }));
  assert.throws(() => noReceiptLifecycleFacts({ ...base, rejectedReceipts: [], deliveryTurns: 1.5 }));
});

test("a nested no-receipt adopts the count that session issued", () => {
  const policy = createReceiptDeliveryPolicy(5);
  policy.recordNestedNoReceipt(noReceiptLifecycleFacts({
    terminalToolCalled: false,
    rejectedReceipts: [],
    deliveryTurns: 0,
    runPointer: "/nested",
    attemptPointer: "nested",
  }));
  assert.equal(policy.nextAction(), "no-receipt");
  assert.equal(policy.issuedDeliveryRequests(), 0);
  assert.equal(policy.facts({ runPointer: "/run", attemptPointer: "attempt-1" }).deliveryTurns, 0);
});

test("a rejection spends a slot and does not count as a delivery request", () => {
  const policy = createReceiptDeliveryPolicy(2);
  policy.recordRejected("missing reason");
  assert.equal(policy.issuedDeliveryRequests(), 0);
  assert.equal(policy.nextAction(), "request-delivery");
  policy.recordRejected("missing reason again");
  assert.equal(policy.issuedDeliveryRequests(), 0);
  assert.equal(policy.nextAction(), "no-receipt");
});
