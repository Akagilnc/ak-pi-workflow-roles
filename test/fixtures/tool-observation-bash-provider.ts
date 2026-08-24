import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  GATEKEEPER_OUTPUT_TOOL,
  JUDGE_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NOTARY_OUTPUT_TOOL,
} from "../../src/role-runtime.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";

/**
 * Offline provider that drives one real bash tool call with non-empty child output,
 * terminates Judge, and serves Navigator prepare on the private attendance session.
 */
export default function fixture(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-tool-observation-bash",
    provider: "ak-tool-observation-bash",
    tokenSize: { min: 1000, max: 1000 },
  });
  let bashIssued = false;
  const response = async (context: Context) => {
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
          candidates: [{
            id: "obs-route",
            matches: { role: "judge", phase: null, kind: "accepted" },
            route: [{ role: "judge", phase: null }],
            next: { role: "judge", phase: null },
            reason: "observation fixture navigator",
            command: "Usage: pi --ak-role judge --help",
          }],
        }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(SOUL_AUDIT_TOOL_NAME)) {
      return fauxAssistantMessage(
        fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
        { stopReason: "toolUse" },
      );
    }
    if (!bashIssued) {
      bashIssued = true;
      return fauxAssistantMessage(
        fauxToolCall(
          "bash",
          {
            // Stream two chunks so bash.js schedules an output-driven onUpdate after its empty entry callback.
            command: "printf 'chunk-one\\n'; sleep 0.25; printf 'chunk-two\\n'",
          },
          { id: "obs-bash-1" },
        ),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
      return fauxAssistantMessage(
        fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "obs-judge-out" }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage("observation fixture idle");
  };
  // bash + judge + scripted province + auditor (+ navigator) need headroom.
  faux.setResponses(Array.from({ length: 10 }, () => response));
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "offline tool observation",
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
