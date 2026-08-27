import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { engineDetourFailureDiagnostic } from "../../src/engine-detour.ts";
import { executeReviewerChild, projectSharedChildFailure } from "../../src/reviewer-child-executor.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("shared child classifications project without relabeling unrelated errors", () => {
  for (const classification of ["provider", "child", "unknown"] as const) {
    const error = Object.assign(new Error(classification), { evidenceChildFailure: classification });
    assert.equal(projectSharedChildFailure(error), error);
    assert.equal((error as Error & { reviewerFailure?: string }).reviewerFailure, classification);
  }
  for (const error of [new Error("plain"), Object.assign(new Error("foreign"), { evidenceChildFailure: "workspace" })]) {
    assert.equal(projectSharedChildFailure(error), error);
    assert.equal("reviewerFailure" in error, false);
  }
});

function evidenceChildContext(cwd: string, faux: ReturnType<typeof fauxProvider>): ExtensionContext {
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

test("aborted evidence without remote testimony projects unknown, not child", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-sp1-aborted-"));
  try {
    const faux = fauxProvider({ provider: "sp1-aborted-unknown" });
    faux.setResponses([fauxAssistantMessage("stream cut", { stopReason: "aborted", errorMessage: "stream cut" })]);
    await assert.rejects(
      () => executeReviewerChild(cwd, { axis: "standards", prompt: "investigate" }, evidenceChildContext(cwd, faux)),
      (error: unknown) => {
        const classified = error as Error & { evidenceChildFailure?: string; reviewerFailure?: string };
        assert.equal(classified.evidenceChildFailure, "unknown");
        assert.equal(classified.reviewerFailure, "unknown");
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("evidence-child system prompt carries souls/quality-law.md material path", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-evidence-quality-law-"));
  try {
    const qualityLaw = await readFile(join(packageRoot, "souls/quality-law.md"), "utf8");
    let seenSystemPrompt: string | undefined;
    const faux = fauxProvider({ provider: "evidence-quality-law" });
    faux.setResponses([
      (context: Context) => {
        seenSystemPrompt = context.systemPrompt;
        return fauxAssistantMessage("Standards finding count: 0.");
      },
    ]);
    await executeReviewerChild(
      cwd,
      { axis: "standards", prompt: "investigate" },
      evidenceChildContext(cwd, faux),
    );
    assert.equal(
      seenSystemPrompt?.includes(qualityLaw),
      true,
      "evidence-child system prompt must load souls/quality-law.md bytes",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("nonzero engine diagnostic uses the last stdout row when stderr is empty", () => {
  const marker = "  terminal API Error: 529 Overloaded  ";
  assert.equal(
    engineDetourFailureDiagnostic({ code: 23, stderr: "", stdout: `earlier\n${marker}\n\n` }),
    `engine detour exited with code 23: ${marker}`,
  );
});
