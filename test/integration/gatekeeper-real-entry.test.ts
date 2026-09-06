/**
 * Gate summons go through the public role path (#675). Offline tracers inject
 * summonOfficer; production calls summonGateOfficer → runAkRole.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { gateSubmissionCandidatePath } from "../../src/auditor-dossier-tool.ts";
import {
  runGatekeeper,
  MISSING_ARGUMENTS_SUBMISSION,
} from "../../src/gatekeeper-role.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import { stampShapeUnreadableDetails } from "../../src/shape-unreadable-failure.ts";
import { seedAgentDirModelsJsonFromFaux, withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
import { fauxProvider } from "@earendil-works/pi-ai";

function baseTerminal(
  roleOutcome: NonNullable<PublicSummonResult["terminal"]>["roleOutcome"],
): NonNullable<PublicSummonResult["terminal"]> {
  return {
    roleOutcome,
    navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
    artifacts: [],
    runId: "test-run",
  };
}

function acceptedTerminal(
  role: "inspector" | "notary",
  status: string,
  decisiveFacts: Record<string, unknown>,
): PublicSummonResult {
  return {
    exitCode: 0,
    terminal: baseTerminal({
      kind: "accepted",
      role,
      status,
      decisiveFacts: { status, ...decisiveFacts },
    }),
  };
}

function noReceiptTerminal(role: "inspector" | "notary"): PublicSummonResult {
  const facts = {
    terminalToolCalled: false,
    rejectedReceipts: [] as const,
    deliveryTurns: 2 as const,
    sessionCompletion: "settled-without-accepted-receipt" as const,
    runPointer: "test-run",
    attemptPointer: "test-attempt",
    acceptedReceipt: false as const,
  };
  return {
    exitCode: 0,
    terminal: baseTerminal({
      kind: "no_receipt",
      role,
      status: "no-accepted-receipt",
      ...facts,
      decisiveFacts: facts,
    }),
  };
}

function failureTerminal(
  role: "inspector" | "notary",
  diagnostic: string,
  decisiveFacts: Record<string, unknown> = {},
): PublicSummonResult {
  return {
    exitCode: 1,
    terminal: baseTerminal({
      kind: "failure",
      role,
      cause: "output",
      diagnostic,
      decisiveFacts,
    }),
  };
}

async function withParent(run: (context: any) => Promise<void>) {
  await withActivationHome({ prefix: "ak-gatekeeper-real-entry-" }, async ({ agentDir, home }) => {
    const faux = fauxProvider({ api: "gatekeeper-parent", provider: "gatekeeper-parent", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("parent")]);
    const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
    try {
      await withInProcessPi({ cwd: home, home, agentDir, activationLedgerSession: true, faux, modelsPath: null, noExtensions: true, noTools: "builtin", mode: "print", systemPrompt: "BASE", flags: {} }, async ({ session, model }) => {
        await run({
          cwd: home,
          model,
          thinkingLevel: "off",
          sessionManager: session.sessionManager,
          runDirectory: home,
        });
      });
    } finally {
      await seeded.close();
    }
  });
}

test("worker completion directly summons Inspector via public path", async () => {
  await withParent(async (context) => {
    const summons: Array<{ officer: string; sourceRun: string }> = [];
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion" },
      async summonOfficer(officer, sourceRunDirectory) {
        summons.push({ officer, sourceRun: sourceRunDirectory });
        return acceptedTerminal("inspector", "pass", { findings: [] });
      },
    });
    assert.deepEqual(result, { status: "pass", officer: "inspector", findings: [] });
    assert.deepEqual(summons, [{ officer: "inspector", sourceRun: context.runDirectory }]);
  });
});

test("parent gate receipt book failure is envelope failInfrastructure after lawful officer pass", async () => {
  await withParent(async (context) => {
    // Force pointer book mkdir to ENOTDIR: parent session path whose dirname is a plain file.
    // auditorRunDirectory still climbs to the real run dir; only the nest mkdir fails.
    // Book lives on requireGatekeeperPass (shared envelope); runGatekeeper is projection-only
    // (ADR 0018 / #675 r4). Envelope failInfrastructure owns the abort face once.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { requireGatekeeperPass } = await import("../../src/gatekeeper-pass-envelope.ts");
    const officerRun = join(context.runDirectory, "officer-run");
    await mkdir(join(officerRun, "session"), { recursive: true });
    await writeFile(join(officerRun, "session", "session.jsonl"), "{\"type\":\"session\"}\n", "utf8");
    const blocker = join(context.runDirectory, "session-not-dir");
    await writeFile(blocker, "not a directory\n", "utf8");
    const poisonedSession = join(blocker, "session.jsonl");
    const poisoned = {
      ...context,
      sessionManager: {
        getSessionFile: () => poisonedSession,
      },
    };
    let infraError: unknown;
    const never = () => {
      throw new Error("failInfrastructure must not return");
    };
    await assert.rejects(
      () => requireGatekeeperPass({
        context: poisoned,
        subject: { kind: "judge_draft" },
        toolCallId: "book-fail-1",
        hostActions: {
          failInfrastructure(error: unknown): never {
            infraError = error;
            throw error instanceof Error ? error : new Error(String(error));
          },
          bindSubmissionNonPass: never as never,
        },
        async summonOfficer() {
          return {
            ...acceptedTerminal("notary", "pass", { findings: [] }),
            runDirectory: officerRun,
          };
        },
      }),
      (error: unknown) => {
        assert.equal(error, infraError);
        assert.ok(error instanceof Error);
        // Raw archivist/FS error — envelope does not re-wrap into GatekeeperResult.
        assert.match(error.message, /ENOTDIR|not a directory|mkdir/i);
        return true;
      },
    );
  });
});

test("judge draft directly summons Notary and preserves bounce", async () => {
  await withParent(async (context) => {
    const submission = { status: "bounce", findings: ["quote has no source"] };
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "judge_draft" },
      async summonOfficer(officer) {
        assert.equal(officer, "notary");
        return acceptedTerminal("notary", "bounce", {
          findings: ["quote has no source"],
        });
      },
    });
    assert.deepEqual(result, {
      status: "bounce",
      officer: "notary",
      disposition: "rewrite",
      findings: ["quote has no source"],
      submission,
    });
  });
});

test("direct officer escalate projects typed escalate result with reason and findings", async () => {
  await withParent(async (context) => {
    const escalateSubmission = {
      status: "escalate",
      reason: "disputed authority",
      findings: ["rule A vs rule B"],
    };
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion" },
      async summonOfficer() {
        return acceptedTerminal("inspector", "escalate", {
          reason: "disputed authority",
          findings: ["rule A vs rule B"],
        });
      },
    });
    assert.equal(result.status, "escalate");
    if (result.status === "escalate") {
      assert.equal(result.officer, "inspector");
      assert.equal(result.reason, "disputed authority");
      assert.deepEqual(result.findings, ["rule A vs rule B"]);
      assert.deepEqual(result.submission, escalateSubmission);
    }
  });
});

test("countersign verdict directly summons Notary", async () => {
  await withParent(async (context) => {
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "countersign_verdict" },
      async summonOfficer(officer) {
        assert.equal(officer, "notary");
        return acceptedTerminal("notary", "pass", { findings: [] });
      },
    });
    assert.deepEqual(result, { status: "pass", officer: "notary", findings: [] });
  });
});

test("direct officer settlement without a receipt stays loud and typed", async () => {
  await withParent(async (context) => {
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion" },
      async summonOfficer() {
        return noReceiptTerminal("inspector");
      },
    });
    assert.equal(result.status, "no_receipt");
    if (result.status === "no_receipt") {
      assert.equal(result.stage, "inspector");
      assert.equal(result.facts.acceptedReceipt, false);
    }
  });
});

test("direct officer missing arguments is typed unreadable with serializable submission (shape, not transport or forged bounce)", async () => {
  await withParent(async (context) => {
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion" },
      async summonOfficer() {
        // Settlement stamps shapeUnreadable; consumer reads only that marker (#675).
        return failureTerminal(
          "inspector",
          "decision 无显式 pass/bounce/escalate",
          stampShapeUnreadableDetails(MISSING_ARGUMENTS_SUBMISSION),
        );
      },
    });
    // ADR 0055 / CLAUDE.md §0: shape-unreadable retains candidate as typed unreadable —
    // not transport abort, not forged bounce.
    assert.equal(result.status, "unreadable");
    if (result.status === "unreadable") {
      assert.equal(result.officer, "inspector");
      assert.equal(result.reason, "decision 无显式 pass/bounce/escalate");
      assert.deepEqual(result.submission, MISSING_ARGUMENTS_SUBMISSION);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });
});

test("direct officer transport failure names the summoned seat", async () => {
  await withParent(async (context) => {
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "judge_draft" },
      async summonOfficer() {
        throw new Error("provider disconnected");
      },
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") assert.equal(result.stage, "notary");
  });
});

test("runGatekeeper persists in-memory tool-call leaf before public summons", async () => {
  await withParent(async (context) => {
    const marker = "GATE-REAL-ENTRY-CANDIDATE-632";
    const leaf = {
      type: "message",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call-real-entry-1",
          name: "ak_fixer_output",
          arguments: { status: "completed", report: marker },
        }],
      },
    };
    const priorEntries = [...context.sessionManager.getEntries()];
    context.sessionManager.getEntries = () => [...priorEntries, leaf];

    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion" },
      async summonOfficer() {
        return acceptedTerminal("inspector", "pass", { findings: [] });
      },
    });
    assert.deepEqual(result, { status: "pass", officer: "inspector", findings: [] });

    const expectedPath = gateSubmissionCandidatePath(context.runDirectory);
    assert.equal(readFileSync(expectedPath, "utf8").includes(marker), true);
  });
});
