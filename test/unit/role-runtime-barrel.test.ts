// #641 P2: the package-facing barrel must name every Collector required tool,
// so consumers building tool allowlists from the canonical entrypoint can
// reference COLLECTOR_READ_TOOL without importing an internal module.
import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
} from "../../src/role-runtime.ts";
import { COLLECTOR_REQUIRED_TOOLS } from "../../src/collector-role.ts";

test("role-runtime barrel re-exports the Collector read tool beside its siblings", () => {
  assert.equal(COLLECTOR_READ_TOOL, "ak_collector_read");
  assert.equal(COLLECTOR_OBSERVE_TOOL, "ak_collector_observe");
  assert.equal(COLLECTOR_REQUEST_TOOL, "ak_collector_request");
  assert.equal(COLLECTOR_WAIT_TOOL, "ak_collector_wait");
  assert.equal(COLLECTOR_OUTPUT_TOOL, "ak_collector_output");
  // The barrel covers the full required surface (boundary: 必需工具面在规范入口可命名).
  for (const name of COLLECTOR_REQUIRED_TOOLS as readonly string[]) {
    assert.ok(
      [COLLECTOR_OBSERVE_TOOL, COLLECTOR_READ_TOOL, COLLECTOR_REQUEST_TOOL, COLLECTOR_WAIT_TOOL, COLLECTOR_OUTPUT_TOOL].includes(name),
      `required tool ${name} must be nameable from the barrel`,
    );
  }
});