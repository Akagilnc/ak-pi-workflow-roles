/**
 * Unit: diarist pre-court ticket resolution — parse contract + mechanical verify.
 * Integration owns the four public countersign paths; this file only covers
 * helpers that the public entry cannot reach cheaply.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  instructionContainsTicketNumber,
  parseDiaristTicketResolverStdout,
  verifyDiaristTicketAssertion,
  DiaristTicketResolutionError,
} from "../../src/diarist-ticket-resolution.ts";

test("parseDiaristTicketResolverStdout accepts ticket|true-unbound; rejects other shapes", () => {
  assert.deepEqual(
    parseDiaristTicketResolverStdout('{"assertion":"ticket","ticketNumber":582}'),
    { kind: "ticket", ticketNumber: 582 },
  );
  assert.deepEqual(
    parseDiaristTicketResolverStdout('{"assertion":"true-unbound"}'),
    { kind: "true-unbound" },
  );
  for (const bad of ["", "[]", "{}", '{"assertion":"ticket"}', '{"assertion":"ticket","ticketNumber":"582"}']) {
    assert.throws(
      () => parseDiaristTicketResolverStdout(bad),
      (e: unknown) => e instanceof DiaristTicketResolutionError,
    );
  }
});

test("mechanical verify: true-unbound passes; ticket needs digits-in-instruction and live existence", async () => {
  assert.equal(instructionContainsTicketNumber("票 #582", 582), true);
  assert.equal(instructionContainsTicketNumber("only 58", 582), false);

  assert.equal(
    (await verifyDiaristTicketAssertion({
      assertion: { kind: "true-unbound" },
      instruction: "无票",
      origin: undefined,
      checkExistence: async () => {
        throw new Error("must not run");
      },
    })).kind,
    "true-unbound",
  );

  await assert.rejects(
    () =>
      verifyDiaristTicketAssertion({
        assertion: { kind: "ticket", ticketNumber: 582 },
        instruction: "无号码",
        origin: { owner: "o", repo: "r" },
        checkExistence: async () => true,
      }),
    (e: unknown) =>
      e instanceof DiaristTicketResolutionError && e.reason === "number-not-in-instruction",
  );
  await assert.rejects(
    () =>
      verifyDiaristTicketAssertion({
        assertion: { kind: "ticket", ticketNumber: 582 },
        instruction: "票 582",
        origin: { owner: "o", repo: "r" },
        checkExistence: async () => false,
      }),
    (e: unknown) =>
      e instanceof DiaristTicketResolutionError && e.reason === "ticket-missing",
  );
  assert.deepEqual(
    await verifyDiaristTicketAssertion({
      assertion: { kind: "ticket", ticketNumber: 582 },
      instruction: "票 582",
      origin: { owner: "o", repo: "r" },
      checkExistence: async () => true,
    }),
    { kind: "ticket", ticketNumber: 582 },
  );
});
