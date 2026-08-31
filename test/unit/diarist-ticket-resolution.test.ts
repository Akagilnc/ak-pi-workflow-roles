/**
 * Unit: diarist pre-court ticket resolution parse + mechanical verification.
 * #582 / diarist-resolves-ticket-llm-layer.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createScriptedDiaristTicketResolver,
  instructionContainsTicketNumber,
  parseDiaristTicketResolverStdout,
  resolveDiaristTicketFromInstruction,
  verifyDiaristTicketAssertion,
  DiaristTicketResolutionError,
} from "../../src/diarist-ticket-resolution.ts";

test("parseDiaristTicketResolverStdout: ticket and true-unbound", () => {
  assert.deepEqual(
    parseDiaristTicketResolverStdout('{"assertion":"ticket","ticketNumber":582}'),
    { kind: "ticket", ticketNumber: 582 },
  );
  assert.deepEqual(
    parseDiaristTicketResolverStdout('{"assertion":"true-unbound"}'),
    { kind: "true-unbound" },
  );
  assert.deepEqual(
    parseDiaristTicketResolverStdout('{"assertion":"ticket","ticketNumber":"42"}'),
    { kind: "ticket", ticketNumber: 42 },
  );
});

test("parseDiaristTicketResolverStdout: uninterpretable fails typed (no wash)", () => {
  for (const bad of ["", "not-json", "[]", "{}", '{"assertion":"maybe"}', '{"assertion":"ticket"}', '{"assertion":"ticket","ticketNumber":0}']) {
    assert.throws(
      () => parseDiaristTicketResolverStdout(bad),
      (error: unknown) =>
        error instanceof DiaristTicketResolutionError &&
        error.code === "diarist-ticket-resolution",
    );
  }
});

test("instructionContainsTicketNumber: decimal digits verbatim", () => {
  assert.equal(instructionContainsTicketNumber("裁票 #582 是否开工", 582), true);
  assert.equal(instructionContainsTicketNumber("issue 582 please", 582), true);
  assert.equal(instructionContainsTicketNumber("no number here", 582), false);
  assert.equal(instructionContainsTicketNumber("only 58 partial", 582), false);
  assert.equal(instructionContainsTicketNumber("x", 0), false);
});

test("verifyDiaristTicketAssertion: true-unbound passes; N needs both checks", async () => {
  const unbound = await verifyDiaristTicketAssertion({
    assertion: { kind: "true-unbound" },
    instruction: "一般性问询，无票",
    origin: undefined,
    checkExistence: async () => {
      throw new Error("existence must not run for true-unbound");
    },
  });
  assert.equal(unbound.kind, "true-unbound");

  await assert.rejects(
    () =>
      verifyDiaristTicketAssertion({
        assertion: { kind: "ticket", ticketNumber: 582 },
        instruction: "无此号码",
        origin: { owner: "o", repo: "r" },
        checkExistence: async () => true,
      }),
    (error: unknown) =>
      error instanceof DiaristTicketResolutionError &&
      error.reason === "number-not-in-instruction",
  );

  await assert.rejects(
    () =>
      verifyDiaristTicketAssertion({
        assertion: { kind: "ticket", ticketNumber: 582 },
        instruction: "票 582",
        origin: undefined,
        checkExistence: async () => true,
      }),
    (error: unknown) =>
      error instanceof DiaristTicketResolutionError &&
      error.reason === "origin-unresolved",
  );

  await assert.rejects(
    () =>
      verifyDiaristTicketAssertion({
        assertion: { kind: "ticket", ticketNumber: 582 },
        instruction: "票 582",
        origin: { owner: "o", repo: "r" },
        checkExistence: async () => false,
      }),
    (error: unknown) =>
      error instanceof DiaristTicketResolutionError &&
      error.reason === "ticket-missing",
  );

  const ok = await verifyDiaristTicketAssertion({
    assertion: { kind: "ticket", ticketNumber: 582 },
    instruction: "票 582",
    origin: { owner: "o", repo: "r" },
    checkExistence: async () => true,
  });
  assert.deepEqual(ok, { kind: "ticket", ticketNumber: 582 });
});

test("resolveDiaristTicketFromInstruction: verification failure never becomes unbound", async () => {
  const resolver = createScriptedDiaristTicketResolver({
    kind: "ticket",
    ticketNumber: 999,
  });
  await assert.rejects(
    () =>
      resolveDiaristTicketFromInstruction({
        instruction: "mentions 999 but missing live",
        origin: { owner: "o", repo: "r" },
        resolver,
        checkExistence: async () => false,
      }),
    (error: unknown) =>
      error instanceof DiaristTicketResolutionError &&
      error.reason === "ticket-missing",
  );
});
