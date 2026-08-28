/**
 * Offline faux provider for cold-installed Public Coder production-chain proofs.
 * Emits one lawful completed ak_coder_output after Pi expands package-owned TDD.
 * Supports injected typed 429 provider stop via AK_TEST_PROVIDER_STOP=1.
 */
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
  INSPECTOR_OUTPUT_TOOL,
  GATEKEEPER_OUTPUT_TOOL,
  NAVIGATOR_PREPARE_TOOL_NAME,
} from "../../src/role-runtime.ts";
import { recordTypedProviderHttpStatus } from "../../src/typed-provider-http.ts";

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
    if (process.env.AK_TEST_PROVIDER_STOP === "1") {
      const runDir = process.env.AK_ROLE_RUN_DIR;
      if (runDir) {
        await recordTypedProviderHttpStatus(runDir, {
          httpStatus: 429,
          provider: "openai-codex",
        });
      }
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Rate limit reached (429)",
      });
    }
    if (toolNames.includes(GATEKEEPER_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "inspector" }),
        { stopReason: "toolUse" },
      );
    }
    if (toolNames.includes(INSPECTOR_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(INSPECTOR_OUTPUT_TOOL, { status: "pass", findings: [] }),
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
  // Public process: Navigator prepare + Coder completed. Gate ① may bounce the first
  // completed (zero new commit) once; same payload resubmit is the confirm path, then
  // scripted Gatekeeper → Inspector pass (officer choice is fixture, not oracle).
  faux.setResponses([respond, respond, respond, respond, respond]);

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
