/**
 * #582 / #635 — countersign argv parse. The --ticket rejection, notary
 * --source-run and analyst --ticket are carried by public runAkRole cases.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
test("parseCountersignArgv preserves attachment and instruction", () => {
  const parsed = parsePublicSeatArgv("countersign", [
    "--attach",
    "./t.md",
    "裁：开工？",
  ]);
  assert.deepEqual(parsed.attachmentPaths, ["./t.md"]);
  assert.equal(parsed.instruction, "裁：开工？");
});
