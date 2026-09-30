import test from "node:test";
import assert from "node:assert/strict";

import {
  createReceiptDeliveryPolicy,
  deliveryLimitFromConfig,
  deliveryLimitFromEnv,
  noReceiptLifecycleFacts,
  parseNoReceiptLifecycleFacts,
  RECEIPT_DELIVERY_LIMIT_ENV,
} from "../../src/receipt-delivery-policy.ts";
import { externalRoleTurnRoundLimit } from "../../src/external-host-turn-loop.ts";
import { AUTO_RESUME_LIMIT } from "../../src/public-cli/run-lifecycle.ts";

// #1132: the three counts read one configured value, and the package default
// stays in exactly one place (AUTO_RESUME_LIMIT).
test("the effective ceiling follows the configured value; unconfigured keeps the one package default", () => {
  assert.equal(AUTO_RESUME_LIMIT, 2);
  assert.equal(deliveryLimitFromConfig(undefined), 2);
  assert.equal(deliveryLimitFromConfig(0), 0);
  assert.equal(deliveryLimitFromConfig(5), 5);
  // Out-of-domain values are rejected loudly, never silently coerced (#422).
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => deliveryLimitFromConfig(bad), /non-negative integer/);
  }
  assert.throws(() => deliveryLimitFromConfig("2" as unknown as number), /non-negative integer/);
});

test("the child env carries the same number; absent or non-integer falls back to the default", () => {
  assert.equal(deliveryLimitFromEnv({}), 2);
  assert.equal(deliveryLimitFromEnv({ [RECEIPT_DELIVERY_LIMIT_ENV]: "0" }), 0);
  assert.equal(deliveryLimitFromEnv({ [RECEIPT_DELIVERY_LIMIT_ENV]: "7" }), 7);
  assert.equal(deliveryLimitFromEnv({ [RECEIPT_DELIVERY_LIMIT_ENV]: "  " }), 2);
  assert.equal(deliveryLimitFromEnv({ [RECEIPT_DELIVERY_LIMIT_ENV]: "two" }), 2);
});

// 首轮不计重交: the closeRound loop spends the initial round plus N re-asks.
test("the closeRound re-ask loop spends the first round plus the configured count", () => {
  assert.equal(externalRoleTurnRoundLimit({}), 1 + 2);
  assert.equal(externalRoleTurnRoundLimit({ deliveryRequestLimit: 0 }), 1);
  assert.equal(externalRoleTurnRoundLimit({ deliveryRequestLimit: 4 }), 5);
});

// 0 disables automatic re-request/续跑 for the delivery budget.
test("a zero ceiling never asks for a delivery request", () => {
  const policy = createReceiptDeliveryPolicy(0);
  // 0 = 不自动重交: the budget is already spent, so settlement is immediate.
  assert.equal(policy.nextAction(), "no-receipt");
  policy.recordDeliveryRequest();
  // The cap holds: the budget cannot be exceeded even by an over-eager caller.
  assert.equal(policy.issuedDeliveryRequests(), 0);
  assert.equal(policy.nextAction(), "no-receipt");
  // 零次即记零 — a zero budget that spent nothing records zero, not the budget.
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

// 零次即记零: the settlement seam records what went out, not the budget.
test("no_receipt facts record the issued count, including zero", () => {
  const base = { terminalToolCalled: false, runPointer: "/run", attemptPointer: "current:/run" };
  for (const issued of [0, 1, 2, 5]) {
    const facts = noReceiptLifecycleFacts({ ...base, rejectedReceipts: [], deliveryTurns: issued });
    assert.equal(facts.deliveryTurns, issued);
    // The reader accepts the recorded count verbatim.
    assert.equal(parseNoReceiptLifecycleFacts({ ...facts }).deliveryTurns, issued);
  }
  // A budget of 2 that was never spent stays 0 — not back-filled to 2.
  assert.equal(parseNoReceiptLifecycleFacts(noReceiptLifecycleFacts({ ...base, rejectedReceipts: [], deliveryTurns: 0 })).deliveryTurns, 0);
  assert.throws(() => noReceiptLifecycleFacts({ ...base, rejectedReceipts: [], deliveryTurns: -1 }), /non-negative integer/);
  assert.throws(() => noReceiptLifecycleFacts({ ...base, rejectedReceipts: [], deliveryTurns: 1.5 }), /non-negative integer/);
  assert.throws(() => parseNoReceiptLifecycleFacts({ ...base, deliveryTurns: "2" }), /malformed|non-negative/);
});

// A nested session that already settled on its own budget closes this one.
test("a nested no-receipt closes this budget at the configured count", () => {
  const policy = createReceiptDeliveryPolicy(3);
  policy.recordNestedNoReceipt(noReceiptLifecycleFacts({
    terminalToolCalled: false,
    rejectedReceipts: [],
    deliveryTurns: 3,
    runPointer: "/nested",
    attemptPointer: "nested",
  }));
  assert.equal(policy.nextAction(), "no-receipt");
  assert.equal(policy.issuedDeliveryRequests(), 3);
});
