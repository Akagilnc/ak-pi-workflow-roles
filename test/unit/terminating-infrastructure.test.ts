// #541 contract test for the single shared infrastructure-failure declaration helper.
// Covers variant recognition, diagnostic extraction, and host error identity only.
// Free prose is intentionally not asserted (判定归座席语义能力，非本 helper).
import assert from "node:assert/strict";
import test from "node:test";

import {
  INFRASTRUCTURE_FAILURE_DECLARATION_KEY,
  failOnInfrastructureFailureDeclaration,
  infrastructureFailureDiagnostic,
  infrastructureFailureError,
  isInfrastructureFailureDeclaration,
} from "../../src/package-contracts/terminating-infrastructure.ts";

test("recognizes only the typed infrastructure-failure declaration", () => {
  assert.equal(
    isInfrastructureFailureDeclaration({
      [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]: { diagnostic: "boom" },
    }),
    true,
  );
  assert.equal(
    isInfrastructureFailureDeclaration({
      [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]: { diagnostic: "  padded  " },
    }),
    true,
  );
  for (const candidate of [
    undefined,
    null,
    1,
    "x",
    [],
    {},
    { infrastructureFailure: {} },
    { infrastructureFailure: { diagnostic: "" } },
    { infrastructureFailure: { diagnostic: "   " } },
    { infrastructureFailure: { other: "x" } },
    { infrastructureFailure: "not-an-object" },
    { judgeStatus: "converged" },
    { status: "completed" },
  ]) {
    assert.equal(isInfrastructureFailureDeclaration(candidate), false, String(candidate));
  }
});

test("extracts the non-empty diagnostic; absence yields undefined", () => {
  assert.equal(
    infrastructureFailureDiagnostic({ infrastructureFailure: { diagnostic: "engine body" } }),
    "engine body",
  );
  assert.equal(
    infrastructureFailureDiagnostic({ infrastructureFailure: { diagnostic: "  padded  " } }),
    "padded",
  );
  assert.equal(infrastructureFailureDiagnostic({ judgeStatus: "converged" }), undefined);
  assert.equal(infrastructureFailureDiagnostic({ infrastructureFailure: { diagnostic: "" } }), undefined);
});

test("infrastructureFailureError carries the diagnostic as the host error identity", () => {
  const error = infrastructureFailureError("诊断 body");
  assert.ok(error instanceof Error);
  assert.equal(error.message, "诊断 body");
  assert.equal(error.name, "InfrastructureFailure");
});

test("failOnInfrastructureFailureDeclaration calls the shared host fail with the diagnostic error identity", () => {
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
  assert.equal(receivedToolCallId, "call-1");
});

test("failOnInfrastructureFailureDeclaration is a no-op without the declaration", () => {
  let calls = 0;
  const hostActions = {
    failInfrastructure(_error: unknown, _ctx: unknown, _toolCallId?: string): never {
      calls += 1;
      throw new Error("must not run");
    },
  };
  failOnInfrastructureFailureDeclaration({ judgeStatus: "converged" }, hostActions, {}, "call-2");
  assert.equal(calls, 0);
});
