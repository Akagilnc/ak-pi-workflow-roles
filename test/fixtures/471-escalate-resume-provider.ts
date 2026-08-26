/**
 * #471 shortest live-chain provider: first Judge turn escalates; after owner
 * resume message is present in session context, Judge converges.
 * Real Pi entry only — not a permanent regression owner.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import {
  GATEKEEPER_OUTPUT_TOOL,
  JUDGE_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NOTARY_OUTPUT_TOOL,
} from "../../src/role-runtime.ts";

const OWNER_RULING = process.env.AK_471_OWNER_RULING ?? "Owner rules: accept the plan and converge.";

function contextText(context: Context): string {
  return JSON.stringify(context.messages ?? []);
}

export default function fixture(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-471-chain",
    provider: "ak-471-chain",
    tokenSize: { min: 1000, max: 1000 },
  });

  const response = (context: Context) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    if (names.includes(GATEKEEPER_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "notary" }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(NOTARY_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
      return fauxAssistantMessage(
        fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
          candidates: [
            {
              id: "471-chain-route",
              matches: { role: "judge", phase: null, kind: "accepted" },
              route: [{ role: "judge", phase: null }],
              next: { role: "judge", phase: null },
              reason: "471 escalate-resume chain",
              command: "Usage: pi --ak-role judge --help",
            },
          ],
        }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(SOUL_AUDIT_TOOL_NAME)) {
      return fauxAssistantMessage(
        fauxToolCall(SOUL_AUDIT_TOOL_NAME, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
      const seen = contextText(context);
      if (seen.includes(OWNER_RULING)) {
        return fauxAssistantMessage(
          fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, {
            judgeStatus: "converged",
            note: "owner ruling applied on same session",
          }),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage(
        fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, {
          judgeStatus: "escalate",
          decisionGate: {
            question: "Accept plan?",
            options: ["accept", "reject"],
          },
        }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage("471 chain provider: unexpected tool surface");
  };

  faux.setResponses(Array.from({ length: 16 }, () => response));
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline 471 chain fixture",
        async resolve() {
          return { auth: { apiKey: "offline" } };
        },
      },
    },
    getModels() {
      return [model];
    },
  };
  pi.registerProvider(provider);
}
