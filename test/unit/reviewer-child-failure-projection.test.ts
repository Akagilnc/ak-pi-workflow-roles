import assert from "node:assert/strict";
import test from "node:test";

import { projectSharedChildFailure } from "../../src/reviewer-child-executor.ts";

test("shared evidence-child provider/child classifications project to reviewerFailure", () => {
  for (const classification of ["provider", "child"] as const) {
    const error = Object.assign(new Error(`${classification} boom`), {
      evidenceChildFailure: classification,
    });
    const projected = projectSharedChildFailure(error) as Error & {
      evidenceChildFailure: string;
      reviewerFailure: string;
    };
    assert.equal(projected, error);
    assert.equal(projected.evidenceChildFailure, classification);
    assert.equal(projected.reviewerFailure, classification);
  }
});

test("unrelated failures are not relabeled at the Reviewer adapter", () => {
  const plain = new Error("plain");
  assert.equal(projectSharedChildFailure(plain), plain);
  assert.equal("reviewerFailure" in plain, false);

  const foreign = Object.assign(new Error("foreign"), { evidenceChildFailure: "workspace" });
  projectSharedChildFailure(foreign);
  assert.equal("reviewerFailure" in foreign, false);
});
