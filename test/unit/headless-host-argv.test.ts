import assert from "node:assert/strict";
import { test } from "vitest";

import { parseHeadlessCliStdout } from "../../src/headless-host/role-turn-host.ts";

test("parseHeadlessCliStdout reads one json result envelope", () => {
  const doc = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "sid",
    structured_output: { status: "completed", report: "ok" },
  });
  const result = parseHeadlessCliStdout(doc);
  assert.equal(result?.session_id, "sid");
  assert.deepEqual(result?.structured_output, { status: "completed", report: "ok" });
});
