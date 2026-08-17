import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AK_ROLE_ENGINE_ENV, ENGINE_DETOUR_TOOL_NAME } from "../../src/engine-detour.ts";
import {
  clearActivationEngineLaborFallbackLatch,
  createEngineLaborFallbackLatch,
  installActivationEngineLaborFallbackLatch,
  readActivationEngineLaborFallbackField,
} from "../../src/engine-labor-fallback.ts";
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

test("#380: launched-leg detour failure → seat labor report + engineLaborFallback declaration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-detour-fallback-"));
  const binDir = await mkdtemp(join(tmpdir(), "ak-detour-fallback-bin-"));
  const previousEngine = process.env[AK_ROLE_ENGINE_ENV];
  const previousPath = process.env.PATH;
  const failMarker = "DETOUR_FAIL_UNIQUE_380_SEAT";
  const latch = createEngineLaborFallbackLatch();
  installActivationEngineLaborFallbackLatch(latch);
  try {
    process.env[AK_ROLE_ENGINE_ENV] = "kimi";
    process.env.PATH = `${binDir}${previousPath ? `:${previousPath}` : ""}`;
    const enginePath = join(binDir, "kimi");
    await writeFile(
      enginePath,
      `#!/bin/sh\nprintf '%s\\n' '${failMarker}' >&2\nexit 1\n`,
      "utf8",
    );
    await chmod(enginePath, 0o755);

    let detourIssued = false;
    const faux = fauxProvider({ provider: "detour-fallback-380" });
    const response = (context: Context) => {
      const names = context.tools?.map((tool) => tool.name) ?? [];
      if (names.includes(ENGINE_DETOUR_TOOL_NAME) && !detourIssued) {
        detourIssued = true;
        return fauxAssistantMessage(
          fauxToolCall(
            ENGINE_DETOUR_TOOL_NAME,
            { argv: ["kimi", "--fixture-fallback"] },
            { id: "engine-detour-fallback" },
          ),
          { stopReason: "toolUse" },
        );
      }
      // Seat main road: non-blank report after soft detour failure is accepted (#380).
      return fauxAssistantMessage(
        "Standards finding count: 0. seat labor after failed engine detour.",
      );
    };
    faux.setResponses([
      response,
      response,
      response,
      response,
      response,
      response,
    ]);

    const result = await executeReviewerChild(
      cwd,
      { axis: "standards", prompt: "investigate standards axis with engine labor" },
      evidenceChildContext(cwd, faux),
    );
    assert.equal(detourIssued, true, "detour tool must have been called");
    assert.match(result.report, /seat labor after failed engine detour/);
    const field = readActivationEngineLaborFallbackField();
    assert.ok(field, "activation latch must hold engineLaborFallback");
    assert.equal(field.engineLaborFallback.engine, "kimi");
    assert.equal(field.engineLaborFallback.laborBy, "seat");
    assert.equal(
      field.engineLaborFallback.failure.includes(failMarker),
      true,
      `failure must carry engine stderr: ${field.engineLaborFallback.failure}`,
    );
  } finally {
    clearActivationEngineLaborFallbackLatch();
    if (previousEngine === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previousEngine;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(cwd, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});
