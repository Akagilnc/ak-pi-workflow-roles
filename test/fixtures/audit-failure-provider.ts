import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

export default function auditFailureProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-audit-failure",
    provider: "ak-audit-failure",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        JUDGE_OUTPUT_TOOL_NAME,
        { judgeStatus: "converged" },
        { id: "fatal-judge" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("MALFORMED AUDITOR OUTPUT"),
    fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE"),
  ]);

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline audit failure fixture",
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
  pi.on("session_shutdown", () => {
    console.error(`AUDIT_FAILURE_PROVIDER_CALLS=${faux.state.callCount}`);
  });
}
