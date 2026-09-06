// #541 / #676 C structural contract test: every primary packaged-role output tool's
// parameter schema must explicitly advertise the SAME shared nested
// infrastructure-failure declaration (`infrastructureFailure.diagnostic`).
// Untyped `additionalProperties:true` acceptance is NOT enough — the nested
// declaration must be a real, composed schema property. Declaration preservation
// only — no type/minLength/required host-gate assertions (ADR 0057 / 第 0 条).
// Prose (descriptions) is intentionally not asserted for equality.
import assert from "node:assert/strict";
import test from "node:test";

import {
  INFRASTRUCTURE_FAILURE_DECLARATION_KEY,
  INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY,
} from "../../src/package-contracts/terminating-infrastructure.ts";
import { judgeVerdictSchema } from "../../src/judge-role.ts";
import { fixerOutputSchema } from "../../src/package-contracts/fixer-output.ts";
import { coderOutputSchema } from "../../src/worker-role.ts";
import { reviewerOutputSchema } from "../../src/reviewer-role.ts";
import { collectorOutputArgsSchema } from "../../src/collector-tool-schemas.ts";
import { doctorSubmissionSchema } from "../../src/doctor-contracts.ts";
import { mergerOutputSchema } from "../../src/merger-contracts.ts";
import { notaryOutputSchema } from "../../src/notary-contracts.ts";
import { countersignVerdictSchema } from "../../src/countersign-role.ts";
import { gleanerLeftOutputSchema } from "../../src/gleaner-left-role.ts";
import { inspectorOutputSchema } from "../../src/inspector-role.ts";

const TERMINATING_ROLE_SCHEMAS = [
  ["Judge", judgeVerdictSchema],
  ["Fixer", fixerOutputSchema],
  ["Coder", coderOutputSchema],
  ["Reviewer", reviewerOutputSchema],
  ["Collector", collectorOutputArgsSchema],
  ["Doctor", doctorSubmissionSchema],
  ["Merger", mergerOutputSchema],
  ["Notary", notaryOutputSchema],
  ["Countersign", countersignVerdictSchema],
  ["Gleaner-Left", gleanerLeftOutputSchema],
  ["Inspector", inspectorOutputSchema],
] as const;

type Declared = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
};
type SchemaObj = { properties: Record<string, unknown> };

test("every terminating output tool schema advertises the same nested infrastructure-failure declaration", () => {
  const shapes: string[] = [];
  for (const [name, schema] of TERMINATING_ROLE_SCHEMAS) {
    const obj = schema as unknown as SchemaObj;
    const declaration = obj.properties?.[INFRASTRUCTURE_FAILURE_DECLARATION_KEY] as
      | Declared
      | undefined;
    assert.ok(
      declaration && typeof declaration === "object",
      `${name} must explicitly advertise an infrastructureFailure property`,
    );
    // Nested diagnostic declaration must survive composition (ADR 0057 preservation).
    // Do not lock type/minLength/required — those are host shape gates, not declaration.
    const diagnostic = declaration.properties?.[INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY];
    assert.ok(
      diagnostic !== undefined && diagnostic !== null && typeof diagnostic === "object",
      `${name} infrastructureFailure must carry a nested diagnostic property`,
    );
    shapes.push(
      JSON.stringify({
        hasInfrastructureFailure: true,
        hasNestedDiagnostic: true,
        additionalProperties: declaration.additionalProperties === true,
      }),
    );
  }
  // Every terminating role must advertise the SAME nested declaration shape.
  const canonical = shapes[0];
  for (const d of shapes) {
    assert.equal(d, canonical, "every terminating output tool schema must share one nested declaration");
  }
});
