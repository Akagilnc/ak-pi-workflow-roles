/**
 * #836 (ADR 0003 Amendment) — class-wide regression, table-driven.
 *
 * CodeRabbit found `countersignStatus` registered to the provider as a closed
 * enum: an unrecognized value fails schema validation, so the host rejects
 * the tool call before `execute` ever runs and the submission ledger never
 * records a candidate row — defeating ADR 0003's "记录后不判，读不出三态 →
 * resume 说话者本人" path. The same shape existed on every role's own
 * top-level status/verdict discriminator (see src/countersign-role.ts for
 * the full rationale and fix).
 *
 * Each row below exercises the exact schema object handed to
 * `registerTool({ parameters: ... })` with `Value.Check` — the same TypeBox
 * runtime check fixer-contract.test.ts already relies on for this package's
 * provider-facing contracts. A full real-entry test (driving the actual
 * pi-agent-core host's `validateToolArguments` before `execute`) is not
 * reachable from this package — that validator lives in the external
 * pi-agent-core dependency, and test/integration/countersign-notary-gate.test.ts
 * already calls `execute` directly, bypassing that same host gate. Per
 * souls/quality-law.md this is disclosed rather than built as a parallel
 * fixture; the schema-level check is the correct and only in-repo seam for
 * the provider contract itself.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { countersignVerdictSchema } from "../../src/countersign-role.ts";
import { judgeVerdictSchema } from "../../src/judge-role.ts";
import { coderOutputSchema } from "../../src/worker-role.ts";
import { fixerOutputSchema } from "../../src/package-contracts/fixer-output.ts";
import { doctorSubmissionSchema } from "../../src/doctor-contracts.ts";
import { mergerOutputSchema } from "../../src/merger-contracts.ts";
import { reviewerOutputSchema } from "../../src/reviewer-role.ts";

const rows: ReadonlyArray<{ readonly name: string; readonly schema: TSchema; readonly payload: Record<string, unknown> }> = [
  { name: "countersign", schema: countersignVerdictSchema, payload: { countersignStatus: "not-a-status", note: "typo" } },
  { name: "judge", schema: judgeVerdictSchema, payload: { judgeStatus: "not-a-status", note: "typo" } },
  { name: "coder", schema: coderOutputSchema, payload: { status: "not-a-status", report: "typo" } },
  { name: "fixer", schema: fixerOutputSchema, payload: { status: "not-a-status", report: "typo" } },
  { name: "doctor", schema: doctorSubmissionSchema, payload: { status: "not-a-status", reason: "typo" } },
  { name: "merger", schema: mergerOutputSchema, payload: { status: "not-a-status", attemptId: "a1", report: "typo" } },
  { name: "reviewer", schema: reviewerOutputSchema, payload: { status: "not-a-status" } },
];

test("every registered submission-tool status field stays open to an unrecognized value at the provider seam", () => {
  for (const row of rows) {
    assert.equal(Value.Check(row.schema, row.payload), true, `${row.name}: ${JSON.stringify(row.payload)}`);
  }
});
