import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { executeReviewerChild, projectSharedChildFailure } from "../../src/reviewer-child-executor.ts";

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

function evidenceChildContext(
  cwd: string,
  faux: ReturnType<typeof fauxProvider>,
): ExtensionContext {
  return {
    cwd,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRegistry: {
      getProvider() { return faux.provider; },
      async getProviderAuth() { return { auth: { apiKey: "test-secret" } }; },
      async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test-secret" }; },
    },
    sessionManager: SessionManager.inMemory(cwd),
  } as unknown as ExtensionContext;
}

test("#307 SP1: aborted without testimony projects as unknown, not child", async () => {
  // Real executeEvidenceChild entry via Reviewer adapter: assistant stopReason=aborted
  // with the shared testimony rule (no HTTP/SDK ⇒ unknown; direct HTTP ⇒ provider).
  // child stays for local failures only. Object.assign fixtures cannot prove this branch.
  const cwd = await mkdtemp(join(tmpdir(), "ak-sp1-aborted-"));
  try {
    const noTestimony = fauxProvider({ provider: "sp1-aborted-unknown" });
    noTestimony.setResponses([
      fauxAssistantMessage("stream cut", {
        stopReason: "aborted",
        errorMessage: "stream cut",
      }),
    ]);
    await assert.rejects(
      () => executeReviewerChild(
        cwd,
        { axis: "standards", prompt: "investigate standards axis" },
        evidenceChildContext(cwd, noTestimony),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const classified = error as Error & {
          evidenceChildFailure?: string;
          reviewerFailure?: string;
        };
        assert.equal(classified.evidenceChildFailure, "unknown");
        assert.equal(classified.reviewerFailure, "unknown");
        return true;
      },
    );

    const withTestimony = fauxProvider({ provider: "sp1-aborted-provider" });
    withTestimony.setResponses([
      Object.assign(
        fauxAssistantMessage("remote abort", {
          stopReason: "aborted",
          errorMessage: "remote abort",
        }),
        { statusCode: 503, status: 503 },
      ),
    ]);
    await assert.rejects(
      () => executeReviewerChild(
        cwd,
        { axis: "spec", prompt: "investigate spec axis" },
        evidenceChildContext(cwd, withTestimony),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const classified = error as Error & {
          evidenceChildFailure?: string;
          reviewerFailure?: string;
        };
        assert.equal(classified.evidenceChildFailure, "provider");
        assert.equal(classified.reviewerFailure, "provider");
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
