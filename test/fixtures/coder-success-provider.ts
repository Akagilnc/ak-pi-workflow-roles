/**
 * Offline faux provider for cold-installed Public Coder production-chain proofs.
 * Emits one lawful completed ak_coder_output after Pi expands package-owned TDD.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CODER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

export default function coderSuccessProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-coder-offline",
    provider: "ak-coder-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(
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
    ),
  ]);

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
