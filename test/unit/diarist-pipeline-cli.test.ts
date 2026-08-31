/**
 * #582 / ADR 0075 — pure argv/ticket parse (no fs/git/public entry).
 * Medium public countersign/diarist station proofs live in
 * test/integration/public-cli-countersign-run.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCountersignArgv,
  parseNotaryArgv,
  parsePositiveTicketNumber,
} from "../../src/public-cli/invocation.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";

test("parsePositiveTicketNumber rejects non-positive and leading junk", () => {
  assert.equal(parsePositiveTicketNumber("582", "--ticket"), 582);
  assert.throws(() => parsePositiveTicketNumber("0", "--ticket"), CliUsageError);
  assert.throws(() => parsePositiveTicketNumber("08", "--ticket"), CliUsageError);
  assert.throws(() => parsePositiveTicketNumber("x", "--ticket"), CliUsageError);
});

test("parseCountersignArgv binds --ticket; judge path has no ticket option", () => {
  const parsed = parseCountersignArgv([
    "--ticket",
    "582",
    "--attach",
    "./t.md",
    "裁：开工？",
  ]);
  assert.equal(parsed.ticket, 582);
  assert.deepEqual(parsed.attachmentPaths, ["./t.md"]);
  assert.equal(parsed.instruction, "裁：开工？");
  assert.throws(
    () => parseCountersignArgv(["--ticket", "nope"]),
    CliUsageError,
  );
});

test("parseNotaryArgv binds optional --ticket alongside required --source-run", () => {
  const parsed = parseNotaryArgv([
    "--source-run",
    "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
    "--ticket",
    "582",
  ]);
  assert.equal(parsed.sourceRun, "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge");
  assert.equal(parsed.ticket, 582);
});
