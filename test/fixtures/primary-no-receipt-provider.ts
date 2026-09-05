import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  CODER_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
} from "../../src/role-runtime.ts";

export default function primaryNoReceiptProvider(pi: ExtensionAPI): void {
  const runDirectory = process.env.AK_ROLE_RUN_DIR ?? "";
  const mode = runDirectory.includes("primary-rejected")
    ? "rejected"
    : runDirectory.includes("primary-never-called")
      ? "never-called"
      : runDirectory.includes("primary-aborted")
        ? "aborted"
        : undefined;
  if (mode === undefined) throw new Error("primary no-receipt fixture requires a recognized run binding");

  const faux = fauxProvider({
    api: "ak-primary-no-receipt",
    provider: "ak-primary-no-receipt",
    tokenSize: { min: 1000, max: 1000 },
  });
  let roleCalls = 0;
  const respond = async (context: Context) => {
    const toolNames = context.tools?.map((tool) => tool.name) ?? [];
    if (toolNames.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
      return fauxAssistantMessage(
        fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, { candidates: [] }),
        { stopReason: "toolUse" },
      );
    }
    roleCalls += 1;
    if (mode === "aborted") {
      return fauxAssistantMessage("aborted role turn", { stopReason: "aborted" });
    }
    if (mode === "rejected" && roleCalls === 1) {
      return fauxAssistantMessage(
        fauxToolCall(CODER_OUTPUT_TOOL_NAME, {
          status: "completed",
          report: "TDD work exists, but this fixture intentionally has no new commit.",
        }, { id: "rejected-coder-output" }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(`abandoned role turn ${roleCalls}`);
  };
  faux.setResponses([respond, respond, respond, respond, respond, respond]);

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline primary no-receipt fixture",
        async resolve() { return { auth: { apiKey: "offline" } }; },
      },
    },
    getModels() { return [model]; },
  };
  pi.registerProvider(provider);
}
