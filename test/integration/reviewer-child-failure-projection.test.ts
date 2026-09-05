import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AgentSession, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { engineDetourFailureDiagnostic } from "../../src/engine-detour.ts";
import { executeReviewerChild, projectSharedChildFailure } from "../../src/reviewer-child-executor.ts";
import { executeEvidenceChild } from "../../src/evidence-child-executor.ts";
import { withInstitutionalProviderFixture } from "../helpers/pi-test-harness.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";

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
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory, { recursive: true });
  try {
    const faux = fauxProvider({ provider: "sp1-aborted-unknown" });
    faux.setResponses([fauxAssistantMessage("stream cut", { stopReason: "aborted", errorMessage: "stream cut" })]);
    await writeInstitutionalSeatTable(runDirectory, {
      evidenceChild: seatSelection("sp1-aborted-unknown", "sp1-aborted-unknown"),
    });
    await assert.rejects(
      () => executeReviewerChild(
        cwd,
        { axis: "standards", prompt: "investigate" },
        evidenceChildContext(cwd, faux),
        { runDirectory },
      ),
      (error: unknown) => {
        const classified = error as Error & { evidenceChildFailure?: string; reviewerFailure?: string };
        assert.equal(classified.evidenceChildFailure, "unknown");
        assert.equal(classified.reviewerFailure, "unknown");
        return true;
      },
    );
  } finally {
  }
});

test("evidence-child cleanup runs handle.close even when unsubscribe throws and preserves every cause", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:1";
  const cwd = await mkdtemp(join(tmpdir(), "ak-sp1-cleanup-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory, { recursive: true });
  let subscribes = 0;
  let disposes = 0;
  const originalSubscribe = AgentSession.prototype.subscribe;
  const originalDispose = AgentSession.prototype.dispose;
  const unsubscribeBoom = new Error("unsubscribe failed");
  AgentSession.prototype.subscribe = function (...args) {
    subscribes += 1;
    const unsubscribe = originalSubscribe.apply(this, args);
    // Through the real provider entry the child session registers exactly one
    // AgentSession subscription (the handle's listeners Set is separate); make
    // that one's unsubscribe throw so handle.close's cleanup surfaces the
    // AggregateError.
    if (subscribes === 1) {
      return () => {
        unsubscribe();
        throw unsubscribeBoom;
      };
    }
    return unsubscribe;
  };
  AgentSession.prototype.dispose = function (...args) {
    disposes += 1;
    return originalDispose.apply(this, args);
  };
  try {
    const faux = fauxProvider({ provider: "openai" });
    // Through the real provider entry the evidence child resolves its seat from
    // the child-local ModelRuntime and would need a scripted response to produce
    // a report. The cleanup contract under test is exercised by letting the
    // provider stream fail (no response queued → transport failure) so
    // primaryFailure is set, then the throwing unsubscribe surfaces the
    // AggregateError from runChildCleanup.
    await writeInstitutionalSeatTable(runDirectory, {
      evidenceChild: seatSelection("openai", faux.getModel().id),
    });
    await assert.rejects(
      () => withInstitutionalProviderFixture(faux, () => executeEvidenceChild(
        cwd,
        "investigate",
        evidenceChildContext(cwd, faux),
        { runDirectory },
      )),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError, `expected AggregateError, got ${String(error)}`);
        assert.equal(disposes, 1, "handle.close must still run after unsubscribe throws");
        const aggregate = error as AggregateError;
        assert.equal(aggregate.errors.length, 2);
        assert.equal(aggregate.errors[1], unsubscribeBoom);
        assert.equal(aggregate.cause, aggregate.errors[0]);
        assert.notEqual(aggregate.cause, unsubscribeBoom);
        return true;
      },
    );
  } finally {
    AgentSession.prototype.subscribe = originalSubscribe;
    AgentSession.prototype.dispose = originalDispose;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
  }
});

test("nonzero engine diagnostic uses the last stdout row when stderr is empty", () => {
  const marker = "  terminal API Error: 529 Overloaded  ";
  const diagnostic = engineDetourFailureDiagnostic({
    code: 23,
    stderr: "",
    stdout: `earlier\n${marker}\n\n`,
  });
  assert.ok(diagnostic.includes(marker));
  assert.ok(diagnostic.includes("23"));
  assert.notEqual(diagnostic.trim(), marker.trim());
});
