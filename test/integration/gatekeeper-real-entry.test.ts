import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  runGatekeeper,
  INSPECTOR_OUTPUT_TOOL,
  NOTARY_OUTPUT_TOOL,
} from "../../src/gatekeeper-role.ts";
import { fauxGatekeeper as completion } from "../helpers/faux-gatekeeper.ts";
import { packageRoot, seedAgentDirModelsJsonFromFaux, withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
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
  const constitution = await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8");
  const auditLaw = await readFile(resolve(packageRoot, "souls/audit-law.md"), "utf8");
  const qualityLaw = await readFile(resolve(packageRoot, "souls/quality-law.md"), "utf8");
  const gateGuide = await readFile(resolve(packageRoot, "souls/gate-output-guide.md"), "utf8");
  const inspectorSoul = await readFile(resolve(packageRoot, "souls/inspector.md"), "utf8");
  await withParent(async (context, faux) => {
    const seen: string[] = [];
    faux.setResponses([completion([{ tool: INSPECTOR_OUTPUT_TOOL, args: { status: "pass", findings: [] } }], seen)]);
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "worker_completion", material: "implementation and test evidence" },
    });
    assert.deepEqual(result, { status: "pass", officer: "inspector", findings: [] });
    assert.deepEqual(seen, [
      `${[constitution, inspectorSoul, auditLaw, qualityLaw, gateGuide].join("\n\n")}\nCurrent working directory: ${context.runDirectory}`,
    ]);
  });
});

test("judge draft directly summons Notary and preserves bounce", async () => {
  await withParent(async (context, faux) => {
    const submission = { status: "bounce", findings: ["quote has no source"] };
    faux.setResponses([completion([{ tool: NOTARY_OUTPUT_TOOL, args: submission }], [])]);
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "judge_draft", material: "ticket and proposed judgment" },
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

test("countersign verdict directly summons Notary", async () => {
  await withParent(async (context, faux) => {
    faux.setResponses([completion([{ tool: NOTARY_OUTPUT_TOOL, args: { status: "pass", findings: [] } }], [])]);
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "countersign_verdict", material: "signed verdict" },
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
      subject: { kind: "worker_completion", material: "completion" },
    });
    assert.equal(result.status, "no_receipt");
    if (result.status === "no_receipt") {
      assert.equal(result.stage, "inspector");
      assert.equal(result.facts.acceptedReceipt, false);
    }
  });
});

test("direct officer transport failure names the summoned seat", async () => {
  await withParent(async (context, faux) => {
    faux.setResponses([() => { throw new Error("provider disconnected"); }]);
    const result = await runGatekeeper({
      context,
      runDirectory: context.runDirectory,
      subject: { kind: "judge_draft", material: "draft" },
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") assert.equal(result.stage, "notary");
  });
});
