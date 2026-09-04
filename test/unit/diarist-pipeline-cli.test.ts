/**
 * #582 / #635 — pure argv/ticket parse (no fs/git/public entry).
 * Countersign and notary no longer accept --ticket; analyst --ticket remains.
 * Medium public countersign/diarist station proofs live in
 * test/integration/public-cli-countersign-run.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCountersignArgv,
  parseNotaryArgv,
  parsePositiveTicketNumber,
  parseAnalystArgv,
} from "../../src/public-cli/invocation.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";

test("parsePositiveTicketNumber rejects non-positive and leading junk", () => {
  assert.equal(parsePositiveTicketNumber("582", "--ticket"), 582);
  assert.throws(() => parsePositiveTicketNumber("0", "--ticket"), CliUsageError);
  assert.throws(() => parsePositiveTicketNumber("08", "--ticket"), CliUsageError);
  assert.throws(() => parsePositiveTicketNumber("x", "--ticket"), CliUsageError);
});

test("parseCountersignArgv rejects --ticket as unknown option", () => {
  assert.throws(
    () => parseCountersignArgv(["--ticket", "582", "--attach", "./t.md", "裁：开工？"]),
    (err: unknown) =>
      err instanceof CliUsageError && /unknown countersign option: --ticket/.test(err.message),
  );
  const parsed = parseCountersignArgv([
    "--attach",
    "./t.md",
    "裁：开工？",
  ]);
  assert.equal("ticket" in parsed, false);
  assert.deepEqual(parsed.attachmentPaths, ["./t.md"]);
  assert.equal(parsed.instruction, "裁：开工？");
});

test("parseNotaryArgv rejects --ticket; keeps required --source-run", () => {
  assert.throws(
    () =>
      parseNotaryArgv([
        "--source-run",
        "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
        "--ticket",
        "582",
      ]),
    (err: unknown) =>
      err instanceof CliUsageError && /unknown notary option: --ticket/.test(err.message),
  );
  const parsed = parseNotaryArgv([
    "--source-run",
    "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
  ]);
  assert.equal(parsed.sourceRun, "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge");
  assert.equal("ticket" in parsed, false);
});

test("parseAnalystArgv still binds --ticket (query scope, not seat binding)", () => {
  const parsed = parseAnalystArgv(["--ticket", "125"]);
  assert.equal(parsed.query, "issue");
  assert.ok(parsed.query === "issue");
  assert.equal(parsed.ticket, 125);
});
