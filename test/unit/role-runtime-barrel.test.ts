// #641 P2: the package-facing barrel re-exports COLLECTOR_READ_TOOL beside the
// other Collector constants. ESM import of the binding already fails the load
// if the export is missing; assert the contract value once from the canonical
// entrypoint so consumers can name the required tool.
import assert from "node:assert/strict";
import test from "node:test";

import { COLLECTOR_READ_TOOL } from "../../src/role-runtime.ts";

test("role-runtime barrel re-exports the Collector read tool constant", () => {
  assert.equal(COLLECTOR_READ_TOOL, "ak_collector_read");
});