import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

export default function reviewerAuditFailureProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-reviewer-audit-failure",
    provider: "ak-reviewer-audit-failure",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, {
        status: "refused",
        report: "The review target cannot be established from the task.",
      }, { id: "fatal-reviewer-audit" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("MALFORMED REVIEWER AUDIT"),
    fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE"),
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Reviewer audit failure",
        async resolve() { return { auth: { apiKey: "offline" } }; },
      },
    },
    getModels() { return [model]; },
  };
  pi.registerProvider(provider);
  pi.on("session_shutdown", () => {
    console.error(`REVIEWER_AUDIT_FAILURE_CALLS=${faux.state.callCount}`);
  });
}
