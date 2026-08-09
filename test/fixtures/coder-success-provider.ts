/**
 * Offline faux provider for cold-installed Public Coder production-chain proofs.
 * Emits one lawful completed ak_coder_output after Pi expands package-owned TDD.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CODER_OUTPUT_TOOL_NAME, NAVIGATOR_PREPARE_TOOL_NAME } from "../../src/role-runtime.ts";

export default function coderSuccessProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-coder-offline",
    provider: "ak-coder-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  const respond = async (context: Context) => {
    const toolNames = context.tools?.map((tool) => tool.name) ?? [];
    if (toolNames.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
      const contextText = JSON.stringify(context.messages);
      const hasInstalledRoutebook = contextText.includes("COLD_INSTALLED_ROUTEBOOK_MARKER");
      const unavailable = process.env.AK_TEST_NAVIGATOR_UNAVAILABLE === "1";
      const expectedUnreadable = process.env.AK_TEST_ROUTEBOOK_UNREADABLE === "1";
      return fauxAssistantMessage(
        fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
          candidates: unavailable || (!hasInstalledRoutebook && !expectedUnreadable) ? [] : [{
            id: "cold-installed-advice",
            matches: { role: "coder", phase: "apply", kind: "accepted" },
            next: { role: "reviewer", phase: null },
            reason: "fixture advice",
          }],
        }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(
      fauxToolCall(
        CODER_OUTPUT_TOOL_NAME,
        {
          status: "completed",
          report:
            "TDD red/green evidence; same-pattern, introduced-regression, and behavior-fact checks complete.",
        },
        { id: "coder-success-completed" },
      ),
      { stopReason: "toolUse" },
    );
  };
  // The public process uses this provider once for Coder and once for Navigator.
  faux.setResponses([respond, respond]);

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Coder success fixture",
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
    console.error(`CODER_SUCCESS_PROVIDER_CALLS=${faux.state.callCount}`);
  });
}
