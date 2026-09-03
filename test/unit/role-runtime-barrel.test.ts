// #641 P2: the package-facing barrel re-exports COLLECTOR_READ_TOOL beside the
// other Collector constants. ESM import of the binding already fails the load
// if the export is missing; assert it directly against the single true source
// so consumers can name the required tool from the canonical entrypoint.
import assert from "node:assert/strict";
import test from "node:test";

import { COLLECTOR_READ_TOOL } from "../../src/role-runtime.ts";
import { COLLECTOR_READ_TOOL as CANONICAL_READ_TOOL } from "../../src/collector-role.ts";

test("role-runtime barrel re-exports the Collector read tool from its canonical source", () => {
  assert.equal(COLLECTOR_READ_TOOL, CANONICAL_READ_TOOL);
  assert.equal(COLLECTOR_READ_TOOL, "ak_collector_read");
});