/**
 * Sole unit surface for ticket-resolver stdout parse.
 * Integration paths inject typed DiaristTicketResolver and never exercise
 * parseDiaristTicketResolverStdout; bad engine stdout is only reachable here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createGhTicketExistenceChecker,
  parseDiaristTicketResolverStdout,
  verifyDiaristTicketAssertion,
  DiaristTicketResolutionError,
} from "../../src/diarist-ticket-resolution.ts";

test("GitHub verification preserves unavailable/invalid dispositions instead of reporting missing", async () => {
  const cases = [
    {
      response: { status: 503, headers: {}, bodyText: "service unavailable" },
      reason: "ticket-unavailable",
    },
    {
      response: { status: 200, headers: {}, bodyText: "not-json" },
      reason: "ticket-invalid",
    },
  ] as const;
  for (const fixture of cases) {
    const checkExistence = createGhTicketExistenceChecker({
      runner: async () => fixture.response,
    });
    await assert.rejects(
      verifyDiaristTicketAssertion({
        assertion: { kind: "ticket", ticketNumber: 582 },
        instruction: "check #582",
        origin: { owner: "owner", repo: "repo" },
        checkExistence,
      }),
      (error: unknown) =>
        error instanceof DiaristTicketResolutionError
        && error.reason === fixture.reason,
    );
  }
});

test("confirmed GitHub 404 remains ticket-missing", async () => {
  const checkExistence = createGhTicketExistenceChecker({
    runner: async () => ({ status: 404, headers: {}, bodyText: "not found" }),
  });
  await assert.rejects(
    verifyDiaristTicketAssertion({
      assertion: { kind: "ticket", ticketNumber: 582 },
      instruction: "check #582",
      origin: { owner: "owner", repo: "repo" },
      checkExistence,
    }),
    (error: unknown) =>
      error instanceof DiaristTicketResolutionError
      && error.reason === "ticket-missing",
  );
});

test("parseDiaristTicketResolverStdout: sole ticket|true-unbound shapes", () => {
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
