import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  AUDITOR_DOSSIER_TOOL_NAME,
  createAuditorDossierTool,
} from "../../src/auditor-dossier-tool.ts";
import {
  runGatekeeper,
  INSPECTOR_OUTPUT_TOOL,
  NOTARY_OUTPUT_TOOL,
  MISSING_ARGUMENTS_SUBMISSION,
} from "../../src/gatekeeper-role.ts";
import { fauxGatekeeper as completion } from "../helpers/faux-gatekeeper.ts";
import { seedAgentDirModelsJsonFromFaux, withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
import { fauxProvider } from "@earendil-works/pi-ai";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";

async function withParent(run: (context: any, faux: ReturnType<typeof fauxProvider>) => Promise<void>) {
  await withActivationHome({ prefix: "ak-gatekeeper-real-entry-" }, async ({ agentDir, home }) => {
    const faux = fauxProvider({ api: "gatekeeper-parent", provider: "gatekeeper-parent", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("parent")]);
    const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
    try {
      await withInProcessPi({ cwd: home, home, agentDir, activationLedgerSession: true, faux, modelsPath: null, noExtensions: true, noTools: "builtin", mode: "print", systemPrompt: "BASE", flags: {} }, async ({ session, model }) => {
        await writeInstitutionalSeatTable(home, {
          gatekeeper: seatSelection("gatekeeper-parent", "gatekeeper-parent"),
          inspector: seatSelection("gatekeeper-parent", "gatekeeper-parent"),
          notary: seatSelection("gatekeeper-parent", "gatekeeper-parent"),
        });
        await run({
          cwd: home,
          model,
          modelRegistry: {
            getProvider() { return undefined; },
            find() { return model; },
            async getProviderAuth() { return { auth: {} }; },
            async getApiKeyAndHeaders() { return { ok: true }; },
          },
          thinkingLevel: "off",
          sessionManager: session.sessionManager,
          runDirectory: home,
        }, faux);
      });
    } finally {
      await seeded.close();
    }
  });
}

test("worker completion directly summons Inspector without a Gatekeeper child", async () => {
  await withParent(async (context, faux) => {
    const seen: string[] = [];
    let dossierPayload: unknown;
    let turn = 0;
    const respond = async (childContext: any) => {
      turn += 1;
      const names = (childContext.tools ?? []).map((tool: { name?: string }) => tool.name);
      assert.equal(names.includes(AUDITOR_DOSSIER_TOOL_NAME), true, "shared dossier tool present");
      assert.equal(names.includes("ak_gatekeeper_subject"), false, "subject body tool gone");
      if (turn === 1) {
        // First turn: pull the shared locator (same tool 审刑院 uses).
        return completion([{ tool: AUDITOR_DOSSIER_TOOL_NAME, args: {} }], seen)(childContext);
      }
      // Child HTTP path may strip toolName/details; content text still carries the locator JSON.
      const results = (childContext.messages ?? []).filter(
        (message: { role?: string }) => message.role === "toolResult",
      );
      assert.ok(results.length >= 1, "dossier tool must leave a toolResult");
      const latest = results[results.length - 1]! as {
        details?: unknown;
        content?: Array<{ type?: string; text?: string }>;
      };
      if (latest.details !== undefined) {
        dossierPayload = latest.details;
      } else {
        const text = (latest.content ?? [])
          .map((part) => (part?.type === "text" ? part.text ?? "" : ""))
          .join("");
        dossierPayload = JSON.parse(text);
      }
      const serialized = JSON.stringify(dossierPayload ?? "");
      assert.equal(/"status"\s*:\s*"pass"/.test(serialized), false);
      return completion([{ tool: INSPECTOR_OUTPUT_TOOL, args: { status: "pass", findings: [] } }], seen)(childContext);
    };
    // Headroom for dossier fetch + decision (and any idle retry).
    faux.setResponses(Array.from({ length: 4 }, () => respond));
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion" },
    });
    assert.deepEqual(result, { status: "pass", officer: "inspector", findings: [] });
    assert.equal(seen.length, 2, "dossier fetch then officer decision");
    const expected = await createAuditorDossierTool(context.runDirectory).execute("x", {});
    assert.deepEqual(dossierPayload, expected.details);
    assert.equal(typeof (dossierPayload as { runDirectory?: string }).runDirectory, "string");
  });
});

test("judge draft directly summons Notary and preserves bounce", async () => {
  await withParent(async (context, faux) => {
    const submission = { status: "bounce", findings: ["quote has no source"] };
    faux.setResponses([completion([{ tool: NOTARY_OUTPUT_TOOL, args: submission }], [])]);
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "judge_draft" },
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
  await withParent(async (context, faux) => {
    const escalateSubmission = { status: "escalate", reason: "disputed authority", findings: ["rule A vs rule B"] };
    faux.setResponses([completion([{ tool: INSPECTOR_OUTPUT_TOOL, args: escalateSubmission }], [])]);
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion" },
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
  await withParent(async (context, faux) => {
    faux.setResponses([completion([{ tool: NOTARY_OUTPUT_TOOL, args: { status: "pass", findings: [] } }], [])]);
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "countersign_verdict" },
    });
    assert.deepEqual(result, { status: "pass", officer: "notary", findings: [] });
  });
});

test("direct officer settlement without a receipt stays loud and typed", async () => {
  await withParent(async (context, faux) => {
    faux.setResponses(Array.from({ length: 5 }, () => completion([{ text: "not a receipt" }], [])));
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion" },
    });
    assert.equal(result.status, "no_receipt");
    if (result.status === "no_receipt") {
      assert.equal(result.stage, "inspector");
      assert.equal(result.facts.acceptedReceipt, false);
    }
  });
});

test("direct officer missing arguments is one-shot serializable transport failure", async () => {
  await withParent(async (context, faux) => {
    let turns = 0;
    faux.setResponses([
      (ctx: any) => {
        turns += 1;
        if (turns > 1) throw new Error("must not retry missing officer arguments");
        return completion([{ tool: INSPECTOR_OUTPUT_TOOL, args: undefined }], [])(ctx);
      },
    ]);
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion" },
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") {
      assert.equal(result.stage, "inspector");
      assert.deepEqual(result.submission, MISSING_ARGUMENTS_SUBMISSION);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(turns, 1);
  });
});

test("direct officer transport failure names the summoned seat", async () => {
  await withParent(async (context, faux) => {
    faux.setResponses([() => { throw new Error("provider disconnected"); }]);
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "judge_draft" },
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") assert.equal(result.stage, "notary");
  });
});
