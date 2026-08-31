/**
 * Sole unit surface for ticket-resolver stdout parse.
 * Integration paths inject typed DiaristTicketResolver and never exercise
 * parseDiaristTicketResolverStdout; bad engine stdout is only reachable here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDiaristTicketResolverStdout,
  DiaristTicketResolutionError,
} from "../../src/diarist-ticket-resolution.ts";

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
