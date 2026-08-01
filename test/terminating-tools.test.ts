import assert from "node:assert/strict";
import test from "node:test";

import { AcceptedDetailsContractError, validateAcceptedDetails } from "../src/package-contracts/terminating-tools.ts";

test("accepted-details validation distinguishes contract rejection from unexpected validator failure", () => {
  assert.throws(
    () => validateAcceptedDetails("ak_coder_output", {}),
    AcceptedDetailsContractError,
  );

  const failure = new TypeError("validator implementation failed");
  const hostileDetails = new Proxy({}, {
    ownKeys() { throw failure; },
  });
  assert.throws(
    () => validateAcceptedDetails("ak_coder_output", hostileDetails),
    (error) => error === failure,
  );
});
