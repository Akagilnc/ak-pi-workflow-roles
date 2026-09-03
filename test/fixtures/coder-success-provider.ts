/**
 * Offline faux provider for cold-installed Public Coder production-chain proofs.
 * Emits one lawful completed ak_coder_output after Pi expands package-owned TDD.
 * Supports injected typed 429 provider stop via AK_TEST_PROVIDER_STOP=1.
 */
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  CODER_OUTPUT_TOOL_NAME,
  INSPECTOR_OUTPUT_TOOL,
  NAVIGATOR_PREPARE_TOOL_NAME,
} from "../../src/role-runtime.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME as GATEKEEPER_OUTPUT_TOOL } from "../../src/package-contracts/gatekeeper-output.ts";

export default async function coderSuccessProvider(pi: ExtensionAPI): Promise<void> {
  const faux = fauxProvider({
    api: "openai-completions",
    provider: "openai-codex",
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
  faux.setResponses(Array.from({ length: 20 }, () => respond));

  const model = faux.getModel();
  const providerConfig = {
    name: "Offline Coder success fixture",
    baseUrl: "http://127.0.0.1:9999",
    apiKey: "offline",
    api: "openai-completions" as const,
    models: [
      {
        id: model.id,
        name: model.name,
        reasoning: false,
        input: ["text", "image"] as Array<"image" | "text">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
    streamSimple(
      requestModel: Model<Api>,
      streamContext: Context,
      options?: SimpleStreamOptions,
    ) {
      const toolNames = streamContext.tools?.map((tool) => tool.name) ?? [];
      if (
        process.env.AK_TEST_PROVIDER_STOP === "1" &&
        !toolNames.includes(NAVIGATOR_PREPARE_TOOL_NAME)
      ) {
        const stream = createAssistantMessageEventStream();
        const human = fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "Rate limit reached (429)",
        });
        queueMicrotask(() => {
          void (async () => {
            await options?.onResponse?.({ status: 429, headers: {} }, requestModel);
            stream.push({ type: "error", reason: "error", error: human });
            stream.end(human);
          })();
        });
        return stream;
      }
      return faux.provider.streamSimple(requestModel as never, streamContext as never, options as never);
    },
  };

  pi.registerProvider("openai-codex", providerConfig);
  pi.registerProvider("ak-coder-offline", providerConfig);

  // Institutional children resolve openai-codex via models.json (#518 S3).
  const { seedAgentDirModelsJsonFromFaux } = await import("../helpers/pi-test-harness.ts");
  const seeded = await seedAgentDirModelsJsonFromFaux(faux, process.env.PI_CODING_AGENT_DIR, {
    providerId: "openai-codex",
  });

  pi.on("session_shutdown", () => {
    console.error(`CODER_SUCCESS_PROVIDER_CALLS=${faux.state.callCount}`);
    void seeded.close();
  });
}
