// #541 behavioral contract test for the single shared infrastructure-failure
// declaration helper: a declaration routes its diagnostic Error identity to the
// shared host fail seam before any business work; a non-declaration is a no-op.
// Internal recognition / extraction / Error construction are private and not
// tested directly (implementation-coupled, per gate judgment).
import assert from "node:assert/strict";
import test from "node:test";

import { failOnInfrastructureFailureDeclaration } from "../../src/package-contracts/terminating-infrastructure.ts";

test("declaration routes its Error identity to the host; non-declaration is a no-op", () => {
  // Declaration → the SAME diagnostic Error identity reaches the host seam.
  let received: unknown;
  let receivedToolCallId: string | undefined;
  const hostActions = {
    failInfrastructure(error: unknown, _ctx: unknown, toolCallId?: string): never {
      received = error;
      receivedToolCallId = toolCallId;
      throw new Error("host fail invoked");
    },
  };
  assert.throws(
    () =>
      failOnInfrastructureFailureDeclaration(
        { infrastructureFailure: { diagnostic: "host boom" } },
        hostActions,
        { cwd: "/x" },
        "call-1",
      ),
    /host fail invoked/,
  );
  assert.ok(received instanceof Error);
  assert.equal((received as Error).message, "host boom");
  assert.equal((received as Error).name, "InfrastructureFailure");
  assert.equal(receivedToolCallId, "call-1");

  // Non-declaration → no host call (same helper, same test).
  let calls = 0;
  const noopHost = {
    failInfrastructure(_error: unknown, _ctx: unknown, _toolCallId?: string): never {
      calls += 1;
      throw new Error("must not run");
    },
  };
  failOnInfrastructureFailureDeclaration(
    { judgeStatus: "converged" },
    noopHost,
    {},
    "call-2",
  );
  assert.equal(calls, 0);
});
