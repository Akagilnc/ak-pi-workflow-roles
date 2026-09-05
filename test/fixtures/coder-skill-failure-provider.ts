import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CODER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

export default function coderSkillFailureProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-coder-skill-failure",
    provider: "ak-coder-skill-failure",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        CODER_OUTPUT_TOOL_NAME,
        { status: "completed", report: "FORBIDDEN CODER RECEIPT" },
        { id: "forbidden-coder-output" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE"),
  ]);

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Coder Skill failure fixture",
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
    console.error(`CODER_SKILL_FAILURE_PROVIDER_CALLS=${faux.state.callCount}`);
  });
}
