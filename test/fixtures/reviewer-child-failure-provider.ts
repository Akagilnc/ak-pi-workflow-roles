import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

export default function reviewerChildFailureProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-reviewer-child-failure",
    provider: "ak-reviewer-child-failure",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(AGENT_TOOL_NAME, {
        subagent_type: "general-purpose",
        description: "Standards",
        prompt: "Inspect the pinned target.",
      }, { id: "fatal-agent" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("   "),
    fauxAssistantMessage(
      fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, {
        status: "refused",
        report: "FORBIDDEN INFRASTRUCTURE REFUSAL",
      }),
      { stopReason: "toolUse" },
    ),
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Reviewer child failure",
        async resolve() { return { auth: { apiKey: "offline" } }; },
      },
    },
    getModels() { return [model]; },
  };
  pi.registerProvider(provider);
  pi.on("session_shutdown", () => {
    console.error(`REVIEWER_CHILD_FAILURE_CALLS=${faux.state.callCount}`);
  });
}
