/**
 * #582 / #635 — pure argv/ticket parse (no fs/git/public entry).
 * Countersign and notary no longer accept --ticket; analyst --ticket remains.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAnalystArgv,
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";
test("parseCountersignArgv preserves attachment and instruction", () => {
  const parsed = parsePublicSeatArgv("countersign", [
    "--attach",
    "./t.md",
    "裁：开工？",
  ]);
  assert.equal("ticket" in parsed, false);
  assert.deepEqual(parsed.attachmentPaths, ["./t.md"]);
  assert.equal(parsed.instruction, "裁：开工？");
});

test("parseNotaryArgv keeps required --source-run", () => {
  const parsed = parsePublicSeatArgv("notary", [
    "--source-run",
    "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
  ]);
  assert.equal(parsed.sourceRun, "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge");
  assert.equal("ticket" in parsed, false);
});

test("parseAnalystArgv still binds --ticket (query scope, not seat binding)", () => {
  const parsed = parseAnalystArgv(["--ticket", "125"]);
  assert.equal(parsed.query, "issue");
  assert.equal(parsed.ticket, 125);
});
