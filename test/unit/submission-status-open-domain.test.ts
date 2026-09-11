/**
 * #836 (2026-09-11 御批 / ADR 0003 Amendment) — class-wide regression.
 *
 * CodeRabbit found `countersignStatus` registered to the provider as a closed
 * enum: an unrecognized value fails TypeBox/JSON-Schema validation, so the
 * host rejects the tool call before `execute` ever runs and the submission
 * ledger never records a candidate row — defeating ADR 0003's "记录后不判，
 * 读不出三态 → resume 说话者本人" path. 大理寺 r20 flagged the same finding as
 * an authority conflict with r16's "keep Literal/Union domains"; the owner
 * ruled it is not a conflict — ADR 0003 already prescribes the disposal, it
 * just wasn't applied everywhere a role's own top-level status/verdict
 * discriminator was registered as a closed domain.
 *
 * Each assertion below exercises the exact schema object handed to
 * `registerTool({ parameters: ... })` — the real provider-facing contract —
 * with `Value.Check`, the same TypeBox runtime check the fixer already relies
 * on in fixer-contract.test.ts. A full real-entry test (driving the actual
 * pi-agent-core host's `validateToolArguments` before `execute`) is not
 * reachable from this package: that validator lives in the external
 * pi-agent-core dependency, and the existing
 * test/integration/countersign-notary-gate.test.ts already calls `execute`
 * directly, bypassing that same host gate (大理寺 r20 finding). Per
 * souls/quality-law.md this is disclosed rather than built as a parallel
 * fixture; the schema-level check is the correct and only in-repo seam for
 * the provider contract itself.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Value } from "typebox/value";

import { countersignVerdictSchema } from "../../src/countersign-role.ts";
import { judgeVerdictSchema } from "../../src/judge-role.ts";
import { coderOutputSchema } from "../../src/worker-role.ts";
import { fixerOutputSchema } from "../../src/package-contracts/fixer-output.ts";
import { doctorSubmissionSchema } from "../../src/doctor-contracts.ts";
import { mergerOutputSchema } from "../../src/merger-contracts.ts";
import { reviewerOutputSchema } from "../../src/reviewer-role.ts";

test("countersignStatus stays open to an unrecognized value at the provider seam", () => {
  assert.equal(
    Value.Check(countersignVerdictSchema, { countersignStatus: "not-a-status", note: "typo" }),
    true,
  );
});

test("judgeStatus stays open to an unrecognized value at the provider seam", () => {
  assert.equal(
    Value.Check(judgeVerdictSchema, { judgeStatus: "not-a-status", note: "typo" }),
    true,
  );
});

test("Coder output status stays open to an unrecognized value at the provider seam", () => {
  assert.equal(
    Value.Check(coderOutputSchema, { status: "not-a-status", report: "typo" }),
    true,
  );
});

test("Fixer output status stays open to an unrecognized value at the provider seam", () => {
  assert.equal(
    Value.Check(fixerOutputSchema, { status: "not-a-status", report: "typo" }),
    true,
  );
});

test("Doctor submission status stays open to an unrecognized value at the provider seam", () => {
  assert.equal(
    Value.Check(doctorSubmissionSchema, { status: "not-a-status", reason: "typo" }),
    true,
  );
});

test("Merger output status stays open to an unrecognized value at the provider seam", () => {
  assert.equal(
    Value.Check(mergerOutputSchema, { status: "not-a-status", attemptId: "a1", report: "typo" }),
    true,
  );
});

test("Reviewer output status stays open to an unrecognized value at the provider seam", () => {
  assert.equal(
    Value.Check(reviewerOutputSchema, { status: "not-a-status" }),
    true,
  );
});
