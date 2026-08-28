import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { engineDetourFailureDiagnostic } from "../../src/engine-detour.ts";
import { executeReviewerChild, projectSharedChildFailure } from "../../src/reviewer-child-executor.ts";
import { executeEvidenceChild } from "../../src/evidence-child-executor.ts";
import type { OpenPiInstitutionalSessionResult } from "../../src/pi/in-process-session.ts";
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
    await rm(cwd, { recursive: true, force: true });
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

test("evidence-child cleanup runs handle.close even when unsubscribe throws and preserves every cause", async () => {
  // Behavior-level regression at the real evidence-child consumer seam: inject
  // the session opener (not the private runChildCleanup helper) with a session
  // whose subscribe returns a throwing unsubscribe and a handle whose close is
  // observed, and a primary prompt failure — proving close still runs and the
  // surfaced AggregateError keeps primary + cleanup causes.
  const cwd = await mkdtemp(join(tmpdir(), "ak-sp1-cleanup-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory, { recursive: true });
  try {
    await writeInstitutionalSeatTable(runDirectory, {
      evidenceChild: seatSelection("cleanup-seam", "cleanup-seam"),
    });
    let closes = 0;
    const primary = new Error("primary provider failure");
    const unsubscribeBoom = new Error("unsubscribe failed");
    const fake: OpenPiInstitutionalSessionResult = {
      streamFailure: undefined,
      session: {
        subscribe: () => () => { throw unsubscribeBoom; },
        abort: () => {},
        async prompt() { throw primary; },
        messages: [],
        getLastAssistantText: () => "",
      } as unknown as OpenPiInstitutionalSessionResult["session"],
      handle: {
        async close() { closes += 1; },
        subscribe: () => () => {},
        abort: () => {},
        async prompt() { throw new Error("unused"); },
      } as unknown as OpenPiInstitutionalSessionResult["handle"],
    };
    const faux = fauxProvider({ provider: "cleanup-seam" });
    await assert.rejects(
      () => executeEvidenceChild(
        cwd,
        "investigate",
        evidenceChildContext(cwd, faux),
        { runDirectory, open: async () => fake },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError, `expected AggregateError, got ${String(error)}`);
        assert.equal(closes, 1, "handle.close must still run after unsubscribe throws");
        const errors = (error as AggregateError).errors;
        assert.equal(errors.length, 2);
        assert.match(String(errors[0]), /primary provider failure/);
        assert.match(String(errors[1]), /unsubscribe failed/);
        assert.ok((error as AggregateError).cause instanceof Error);
        assert.match(String((error as AggregateError).cause), /primary provider failure/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
