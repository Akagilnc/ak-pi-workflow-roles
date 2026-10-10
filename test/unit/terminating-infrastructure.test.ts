// #1214 A2: infrastructureFailure is a receipt field, not a host-kill command.
import assert from "node:assert/strict";
import test from "node:test";

import { infrastructureFailureDiagnostic } from "../../src/package-contracts/terminating-infrastructure.ts";

test("#1214 A2: diagnostic helper reads declaration; absence is undefined", () => {
  assert.equal(
    infrastructureFailureDiagnostic({ infrastructureFailure: { diagnostic: "host boom" } }),
    "host boom",
  );
  assert.equal(
    infrastructureFailureDiagnostic({ judgeStatus: "converged" }),
    undefined,
  );
  assert.equal(
    infrastructureFailureDiagnostic({ infrastructureFailure: { diagnostic: "  " } }),
    undefined,
  );
});
