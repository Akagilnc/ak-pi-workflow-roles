import assert from "node:assert/strict";
import test from "node:test";

import { projectSharedChildFailure } from "../../src/reviewer-child-executor.ts";
import { hasUpstreamErrorTestimony } from "../../src/upstream-error-testimony.ts";

test("shared evidence-child classifications project to reviewerFailure without inventing provider", () => {
  for (const classification of ["provider", "child", "unknown"] as const) {
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

test("#307 SP1: aborted without testimony projects as unknown, not child", () => {
  // Production executeEvidenceChild classifies assistant stopReason=aborted with the
  // shared testimony rule (no HTTP/SDK ⇒ unknown). child stays for local failures only.
  assert.equal(hasUpstreamErrorTestimony({}), false);
  const classified = Object.assign(new Error("stream cut"), {
    evidenceChildFailure: hasUpstreamErrorTestimony({}) ? "provider" : "unknown",
    cause: { stopReason: "aborted", errorMessage: "stream cut" },
  });
  const projected = projectSharedChildFailure(classified) as Error & {
    evidenceChildFailure: string;
    reviewerFailure: string;
  };
  assert.equal(projected.evidenceChildFailure, "unknown");
  assert.equal(projected.reviewerFailure, "unknown");

  // With direct HTTP testimony, aborted stays provider through the same adapter.
  const withTestimony = Object.assign(new Error("remote abort"), {
    evidenceChildFailure: hasUpstreamErrorTestimony({ httpStatus: 503 }) ? "provider" : "unknown",
  });
  const providerProjected = projectSharedChildFailure(withTestimony) as Error & {
    reviewerFailure: string;
  };
  assert.equal(providerProjected.reviewerFailure, "provider");
});
