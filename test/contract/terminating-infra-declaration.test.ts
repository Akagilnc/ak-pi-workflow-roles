// #541 structural contract test: every primary packaged-role output tool's
// parameter schema must explicitly advertise the SAME shared non-empty
// infrastructure-failure declaration (a typed `infrastructureFailure.diagnostic`
// string with minLength >= 1). Untyped `additionalProperties:true` acceptance is
// NOT enough — the declaration must be a real, composed schema property.
// Prose (descriptions) is intentionally not asserted.
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

const EIGHT = [
  ["Judge", judgeVerdictSchema],
  ["Fixer", fixerOutputSchema],
  ["Coder", coderOutputSchema],
  ["Reviewer", reviewerOutputSchema],
  ["Collector", collectorOutputArgsSchema],
  ["Doctor", doctorSubmissionSchema],
  ["Merger", mergerOutputSchema],
  ["Notary", notaryOutputSchema],
] as const;

type Declared = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
};
type SchemaObj = { properties: Record<string, unknown> };

test("all eight output tool schemas advertise the same non-empty infrastructure-failure declaration", () => {
  const diagnostics: string[] = [];
  for (const [name, schema] of EIGHT) {
    const obj = schema as unknown as SchemaObj;
    const declaration = obj.properties?.[INFRASTRUCTURE_FAILURE_DECLARATION_KEY] as
      | Declared
      | undefined;
    assert.ok(
      declaration && typeof declaration === "object",
      `${name} must explicitly advertise an infrastructureFailure property`,
    );
    const diagnostic = declaration.properties?.[INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY] as
      | { type?: string; minLength?: number }
      | undefined;
    assert.ok(
      diagnostic && typeof diagnostic === "object",
      `${name} infrastructureFailure must carry a diagnostic property`,
    );
    assert.equal(diagnostic.type, "string", `${name} diagnostic must be a string`);
    assert.ok(
      typeof diagnostic.minLength === "number" && diagnostic.minLength >= 1,
      `${name} diagnostic must be non-empty (minLength >= 1)`,
    );
    diagnostics.push(
      JSON.stringify({
        type: diagnostic.type,
        minLength: diagnostic.minLength,
      }),
    );
  }
  // All eight must advertise the SAME declaration shape (no prose in comparison).
  const canonical = diagnostics[0];
  for (const d of diagnostics) {
    assert.equal(d, canonical, "all eight output tool schemas must share one declaration");
  }
});
