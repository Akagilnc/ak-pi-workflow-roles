/**
 * #502 real role chain: in-process Pi + shared envelope + faux LLM tool call.
 * Empty and nonempty 弹章 must survive execute → sealed ledger as typed fields.
 * Does not substitute a scripted session or mock host for the role runtime.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { GLEANER_LEFT_OUTPUT_TOOL_NAME } from "../../src/gleaner-left-contracts.ts";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import { readSealedSubmission } from "../../src/submission-ledger.ts";
import { withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";

const soul = "# Gleaner-Left\nPick up what others missed. Findings only.";

const EMPTY_RECEIPT = { status: "completed" as const, findings: [] as const };
const MEMORIAL_RECEIPT = {
  status: "completed" as const,
  findings: [
    {
      pointer: "src/packaged-role-registry.ts:22",
      statement: "公开角色表未收编左拾遗",
    },
  ],
};

async function runRealGleanerLeft(receipt: {
  readonly status: "completed";
  readonly findings: readonly { readonly pointer: string; readonly statement: string }[] | readonly [];
}) {
  return withActivationHome({ prefix: "ak-gleaner-left-real-entry-" }, async ({ agentDir, home }) => {
    const faux = fauxProvider({
      api: `gleaner-left-real-${receipt.findings.length}`,
      provider: `gleaner-left-real-${receipt.findings.length}`,
      tokenSize: { min: 1000, max: 1000 },
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(GLEANER_LEFT_OUTPUT_TOOL_NAME, receipt, { id: "gleaner-left-output" }),
        { stopReason: "toolUse" },
      ),
    ] as never);
    let toolDetails: unknown;
    let sealedFacts: Record<string, unknown> | undefined;
    await withInProcessPi(
      {
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        extensionFactories: [
          createPiRoleRuntimeExtension({
            loadJudgeSoul: async () => "judge",
            loadGleanerLeftSoul: async () => soul,
            auditSoulCompliance: async () => ({ status: "pass" }),
          }),
        ],
        noExtensions: true,
        systemPrompt: "BASE",
        mode: "print",
        noTools: "builtin",
        flags: {
          "ak-role": "gleaner-left",
          "ak-gleaner-left-base": "HEAD",
        },
      },
      async ({ session, sessionManager }) => {
        await session.prompt("start");
        const output = [...sessionManager.getEntries()].reverse().find(
          (entry: { type?: string; message?: { role?: string; toolName?: string; isError?: boolean } }) =>
            entry.type === "message" &&
            entry.message?.role === "toolResult" &&
            entry.message.toolName === GLEANER_LEFT_OUTPUT_TOOL_NAME &&
            entry.message.isError === false,
        ) as { message?: { details?: unknown } } | undefined;
        assert.ok(output, "real role must accept its sole-final output");
        assert.deepEqual(output.message?.details, {
          submissionDisposition: "pending-round-closure",
        });
        toolDetails = output.message?.details;
        const headerId = sessionManager.getHeader?.()?.id;
        assert.ok(headerId);
        const sealed = await readSealedSubmission(home, headerId);
        assert.ok(sealed, "typed turn_end must seal sole candidate");
        assert.equal(sealed.role, "gleaner-left");
        assert.equal(sealed.status, "completed");
        sealedFacts = sealed.decisiveFacts as Record<string, unknown>;
      },
    );
    return { toolDetails, sealedFacts };
  });
}

test("real gleaner-left chain seals an empty 弹章 as completed", async () => {
  const result = await runRealGleanerLeft(EMPTY_RECEIPT);
  assert.deepEqual(result.toolDetails, {
    submissionDisposition: "pending-round-closure",
  });
  assert.equal(result.sealedFacts?.status, "completed");
  assert.deepEqual(result.sealedFacts?.findings, []);
});

test("real gleaner-left chain seals pointer and statement as typed 弹章 fields", async () => {
  const result = await runRealGleanerLeft(MEMORIAL_RECEIPT);
  const findings = result.sealedFacts?.findings as readonly {
    pointer: string;
    statement: string;
  }[];
  assert.equal(findings[0]?.pointer, "src/packaged-role-registry.ts:22");
  assert.equal(findings[0]?.statement, "公开角色表未收编左拾遗");
});
