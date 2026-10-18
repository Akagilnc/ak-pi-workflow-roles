import assert from "node:assert/strict";
import test from "node:test";

import { NAVIGATOR_ADVICE_MAX_CHARS, NAVIGATOR_ROUTE_TABLE } from "../../src/navigator-route-table.ts";

test("every table row is one short non-empty line", () => {
  for (const [role, rows] of Object.entries(NAVIGATOR_ROUTE_TABLE)) {
    for (const [status, advice] of Object.entries(rows)) {
      assert.ok(
        advice.trim() !== "" && Array.from(advice).length <= NAVIGATOR_ADVICE_MAX_CHARS,
        `${role}/${status}`,
      );
    }
  }
});
